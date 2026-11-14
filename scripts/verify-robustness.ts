import "./isolate-data.js";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { levelFor, MemoryMonitor } from "../src/hub/memory.js";
import { SharedResourceManager } from "../src/hub/resources.js";
import { AgentHubServer } from "../src/hub/server.js";

// Regression for what keeps the hub alive and long tasks moving: memory back-off, idle
// sub-sessions, workflow gates / resume / templates, lead handoff, per-agent resource
// switches and the crash supervisor. Uses scripts/mock-agent.mjs only, no real agent CLIs.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK = path.join(ROOT, "scripts", "mock-agent.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failed += 1;
}
async function until(cond: () => boolean | Promise<boolean>, ms = 20000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(150);
  }
  return false;
}

type Json = Record<string, any>;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-verify-robust-"));
  const cwd = path.join(tmp, "proj");
  const stateDir = path.join(tmp, "mock-state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  console.log("=== 1. Memory levels ===");
  check("levels", levelFor(9000) === "ok" && levelFor(3000) === "low" && levelFor(1500) === "critical" && levelFor(undefined) === "ok");
  const seen: string[] = [];
  let fake = 9000;
  const mon = new MemoryMonitor((s) => seen.push(s.level), 1_000_000, async () => ({ availableMB: fake, totalMB: 57000 }));
  for (const v of [9000, 3000, 3000, 1000, 9000]) {
    fake = v;
    await mon.sample();
  }
  check("each change of level is reported once", seen.join() === "ok,low,critical,ok", seen.join());

  const hub = new AgentHubServer({ baseCwd: cwd, port: 0, writeRuntimeFile: false, defaultLead: "mock-a" });
  const url = await hub.start(0);
  const post = (p: string, body: unknown): Promise<Json> =>
    fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
  const get = (p: string): Promise<Json> => fetch(url + p).then((r) => r.json() as Promise<Json>);
  const sessions = (): Json[] => (hub as unknown as { listVisibleSessions(): Json[] }).listVisibleSessions();

  try {
    for (const [id, env] of [
      ["mock-a", {}],
      ["mock-b", { MOCK_REVIEW_FAILS: "1" }],
    ] as const) {
      const res = await post("/api/agents/save", {
        id, label: id.toUpperCase(), description: "mock", enabled: true,
        command: process.execPath, args: [MOCK], env: { MOCK_STATE_DIR: stateDir, ...env },
      });
      check(`mock agent ${id} registered`, res.ok === true, res.error);
    }
    const g = (await post("/api/groups", { title: "robust", leadAgent: "mock-a", cwd })).group;

    console.log("=== 2. Idle sub-session sleeps and wakes with its history ===");
    const task = hub.dispatchPeerTask({
      targetAgent: "mock-a", groupId: g.groupId, session: "helper", callerAgent: "mock-a",
      callerSession: `mock-a:${g.groupId}__lead`, depth: 0, isolateWorktree: false,
      prompt: "Remember OSPREY-58 for later.",
    });
    const key = task.targetSessionKey;
    check("sub-session finished", await until(() => sessions().find((s) => s.sessionKey === key)?.status === "idle"));
    const pid = sessions().find((s) => s.sessionKey === key)?.pid as number;
    check("kept while recently used", hub.sweepIdleSubSessions().length === 0);
    check("released after the idle time", hub.sweepIdleSubSessions(Date.now() + 16 * 60_000).join() === key);
    check("shown as asleep", await until(() => {
      const s = sessions().find((x) => x.sessionKey === key);
      return s?.status === "closed" && s?.closedReason === "idle";
    }));
    check("its process is gone", await until(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 8000));
    const woke = await hub.runSubSessionChat({ sessionKey: key, prompt: "CODEWORD?" });
    check("woken session is given what was said before", /OSPREY-58/.test(woke.outputText), woke.outputText.slice(0, 60));

    console.log("=== 3. Workflow: acceptance gate, parallel limit, resume, templates ===");
    await post("/api/settings", { workflowParallel: 1 });
    let res = await post("/api/workflows/save", {
      groupId: g.groupId,
      steps: [
        { id: "build", name: "build", agent: "mock-a", prompt: "Build the thing.", review: { agent: "mock-b", maxRounds: 3, criteria: "It works." } },
        { id: "docs", name: "docs", agent: "mock-a", prompt: "SLOW Write docs." },
        { id: "ship", name: "ship", agent: "mock-a", prompt: "Ship it.", dependsOn: ["build", "docs"] },
      ],
    });
    check("gated workflow saved", res.ok === true && res.workflow.steps[0].review?.agent === "mock-b", res.error);
    res = await post("/api/workflows/run", { groupId: g.groupId });
    check("only one step starts with the limit at 1", res.workflow.steps.filter((s: Json) => s.status === "running").length === 1);
    const wf = async (): Promise<Json> => (await get(`/api/workflows?groupId=${g.groupId}`)).workflow;
    check("workflow completes", await until(async () => (await wf()).status !== "running", 30000), (await wf()).status);
    const done = await wf();
    const build = done.steps.find((s: Json) => s.id === "build");
    check("rejected once, reworked, then accepted", done.status === "completed" && build.round === 2 && /VERDICT: PASS/.test(build.reviewNotes ?? ""), `round ${build.round}`);
    check("accepted output is the reworked one", /reworked/.test(build.output ?? ""), build.output);

    res = await post("/api/workflows/templates/save", { groupId: g.groupId, name: "build-docs-ship" });
    check("template saved", res.ok === true && res.templates[0]?.stepCount === 3, res.error);
    const g2 = (await post("/api/groups", { title: "second", leadAgent: "mock-a", cwd })).group;
    res = await post("/api/workflows/templates/apply", { groupId: g2.groupId, name: "build-docs-ship" });
    check("template loads into another task as a draft", res.ok === true && res.workflow.status === "draft" && res.workflow.steps.length === 3 && res.workflow.steps[0].review?.maxRounds === 3, res.error);
    res = await post("/api/workflows/templates/delete", { name: "build-docs-ship" });
    check("template deleted", res.ok === true && res.templates.length === 0);

    // A reviewer that never passes: the step fails after maxRounds, and resume keeps the rest.
    fs.rmSync(path.join(stateDir, "review.count"), { force: true });
    fs.writeFileSync(path.join(stateDir, "review-fails"), "99", "utf8");
    await post("/api/workflows/save", {
      groupId: g2.groupId,
      steps: [
        { id: "a", agent: "mock-a", prompt: "Do A." },
        { id: "b", agent: "mock-a", prompt: "Do B.", review: { agent: "mock-b", maxRounds: 2 } },
      ],
    });
    await post("/api/workflows/run", { groupId: g2.groupId });
    const wf2 = async (): Promise<Json> => (await get(`/api/workflows?groupId=${g2.groupId}`)).workflow;
    check("workflow with a failing gate ends", await until(async () => (await wf2()).status !== "running", 30000));
    const failedWf = await wf2();
    const b = failedWf.steps.find((s: Json) => s.id === "b");
    check("gate fails the step after its last round", failedWf.status === "failed" && b.status === "failed" && b.round === 2, `${b.status} round ${b.round}: ${b.error}`);
    fs.rmSync(path.join(stateDir, "review.count"), { force: true });
    fs.writeFileSync(path.join(stateDir, "review-fails"), "0", "utf8");
    const aTask = failedWf.steps.find((s: Json) => s.id === "a").taskId;
    res = await post("/api/workflows/resume", { groupId: g2.groupId });
    check("resume keeps the finished step", res.ok === true && res.workflow.steps.find((s: Json) => s.id === "a").taskId === aTask, res.error);
    check("resumed workflow completes", await until(async () => (await wf2()).status === "completed", 30000), (await wf2()).status);

    console.log("=== 4. Lead: handoff rules and the /lead escape hatch ===");
    res = await post("/api/lead/handoff", { groupId: g.groupId, from: "mock-a", to: "mock-b", brief: "x", depth: 1 });
    check("a sub-session cannot hand the lead over", res.ok === false);
    res = await post("/api/lead/handoff", { groupId: g.groupId, from: "mock-a", to: "nobody", brief: "x" });
    check("unknown target refused", res.ok === false && /mock-b/.test(res.error ?? ""), res.error);
    res = await post("/api/lead/handoff", { groupId: g.groupId, from: "mock-a", to: "MOCK-B", brief: "Goal: ship. Code word OSPREY-58." });
    check("handoff accepted by display name", res.ok === true && res.to === "mock-b", res.error);
    await post("/api/chat", { groupId: g.groupId, prompt: "please hand over" });
    check("lead switches after the turn and the successor answers", await until(async () => {
      const group = (await get("/api/groups")).groups.find((x: Json) => x.groupId === g.groupId);
      const msgs = hub.getMessages({ streamKey: `lead:${g.groupId}` });
      const last = msgs[msgs.length - 1];
      return group.leadAgent === "mock-b" && last?.role === "assistant" && last.agent === "mock-b" && last.status === "done";
    }));
    check("the brief is shown as coming from the previous lead", hub.getMessages({ streamKey: `lead:${g.groupId}` }).some((m) => m.role === "caller" && /OSPREY-58/.test(m.text)));
    res = await post("/api/chat", { groupId: g.groupId, prompt: "/lead mock-a" });
    check("/lead switches directly without a turn", res.ok === true && res.leadAgent === "mock-a" && res.outputText === "", res.error);
    res = await post("/api/chat", { groupId: g.groupId, prompt: "/lead nobody" });
    check("/lead with an unknown agent is refused", res.ok === false);

    console.log("=== 5. Per-agent resource switches ===");
    const skillDir = path.join(cwd, ".claude", "skills", "demo-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: A demo skill.\n---\nBody.\n", "utf8");
    const mgr = new SharedResourceManager(cwd);
    const item = mgr.discover(cwd).find((i) => i.name === "demo-skill");
    check("demo skill discovered", Boolean(item));
    if (item) {
      const other = item.bridgedAgents[0] ?? "codex";
      const before = mgr.buildInjectionForAgent(other, cwd).promptPrefix.includes("`demo-skill`");
      mgr.setResourceEnabled(item.id, false, cwd, other);
      const after = mgr.buildInjectionForAgent(other, cwd).promptPrefix.includes("- `demo-skill` [");
      const third = item.bridgedAgents.find((a) => a !== other);
      const stillOn = third ? mgr.buildInjectionForAgent(third, cwd).promptPrefix.includes("`demo-skill`") : true;
      check("switched off for one agent only", before && !after && stillOn, `${other}: ${before}->${after}, ${third}: ${stillOn}`);
      if (item.nativeAgents[0]) {
        mgr.setResourceEnabled(item.id, false, cwd, item.nativeAgents[0]);
        check("its native agent is told it is off", /Turned Off In This Workbench[\s\S]*demo-skill/.test(mgr.buildInjectionForAgent(item.nativeAgents[0], cwd).promptPrefix));
      }
      mgr.setResourceEnabled(item.id, true, cwd, other);
      check("switched back on", mgr.buildInjectionForAgent(other, cwd).promptPrefix.includes("`demo-skill`"));
    }
  } finally {
    await hub.stop();
  }

  console.log("=== 6. Supervisor restarts a killed hub and keeps its logs ===");
  const dataDir = process.env.RTM_DATA_DIR!;
  const port = 44000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const sup = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "index.ts"), "desktop", "--no-open", "--port", String(port), "--cwd", cwd],
    { cwd: ROOT, env: { ...process.env }, stdio: "ignore", windowsHide: true },
  );
  const up = async (): Promise<boolean> => {
    try {
      return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  };
  const hubPid = (): number => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")).pid as number;
    } catch {
      return 0;
    }
  };
  const killTree = (pid: number): void => {
    if (!pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  };
  try {
    check("hub starts under the supervisor", await until(up, 45000));
    const pid1 = hubPid();
    check("the hub writes its own log", fs.existsSync(path.join(dataDir, "desktop.stdout.log")) && /listening/.test(fs.readFileSync(path.join(dataDir, "desktop.stdout.log"), "utf8")));
    killTree(pid1);
    check("hub comes back by itself", await until(async () => (await up()) && hubPid() !== pid1 && hubPid() > 0, 45000), `${pid1} -> ${hubPid()}`);
    const log = fs.existsSync(path.join(dataDir, "crash.log")) ? fs.readFileSync(path.join(dataDir, "crash.log"), "utf8") : "";
    check("the crash is recorded", /exited unexpectedly/.test(log) && /restarting hub/.test(log));
  } finally {
    killTree(sup.pid ?? 0);
    killTree(hubPid());
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nRobustness verification passed completely.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

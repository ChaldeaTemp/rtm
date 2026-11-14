import "./isolate-data.js";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServerManager, parseCodexMcpServers, parseJsonMcpServers } from "../src/hub/mcp-servers.js";
import { levelFor, MemoryMonitor } from "../src/hub/memory.js";
import { SharedResourceManager } from "../src/hub/resources.js";
import { parseStepOutcome } from "../src/hub/workflow.js";
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
    console.log("=== 5b. Reports to the lead, and steps that say they failed ===");
    check(
      "status line is read",
      parseStepOutcome("done\nSTATUS: DONE").ok &&
        parseStepOutcome("no status line at all").ok &&
        parseStepOutcome("x\nSTATUS: FAILED - no access").reason === "FAILED: no access" &&
        parseStepOutcome("x\n**STATUS: BLOCKED** - need the API key").reason === "BLOCKED: need the API key" &&
        parseStepOutcome("STATUS: FAILED - first try\nretried\nSTATUS: DONE").ok,
    );
    const updatesLog = path.join(stateDir, "updates.log");
    const updates = (): string[] =>
      fs.existsSync(updatesLog) ? fs.readFileSync(updatesLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string) : [];
    const leadMsgs = (groupId: string) => hub.getMessages({ streamKey: `lead:${groupId}` });
    const g4 = (await post("/api/groups", { title: "reports", leadAgent: "mock-a", cwd })).group;
    const leadKey4 = `mock-a:${g4.groupId}__lead`;
    const seenBefore = updates().length;

    // A dispatched task ends while the lead is idle: the lead is given a turn about it.
    const bg = hub.dispatchPeerTask({
      targetAgent: "mock-a", groupId: g4.groupId, session: "bg", callerAgent: "mock-a",
      callerSession: leadKey4, depth: 0, isolateWorktree: false, prompt: "Count the widgets.",
    });
    check("lead is told when a dispatched sub-session finishes", await until(() => updates().slice(seenBefore).some((u) => u.includes(bg.taskId) && u.includes("finished"))), bg.taskId);
    check(
      "the transcript shows the update and the lead's reply",
      await until(() => {
        const m = leadMsgs(g4.groupId);
        return m.some((x) => x.role === "system" && /bg/.test(x.text)) && m[m.length - 1]?.role === "assistant" && m[m.length - 1]?.status === "done";
      }),
    );
    // peer_ask: the lead waits for the answer itself, so there is nothing to report.
    const countBeforeAsk = updates().length;
    const asked = await hub.askPeer({
      targetAgent: "mock-a", groupId: g4.groupId, session: "sync", callerAgent: "mock-a",
      callerSession: leadKey4, depth: 0, isolateWorktree: false, prompt: "Quick one.",
    });
    await sleep(800);
    check("no separate report for a result the lead waited for", updates().length === countBeforeAsk && asked.status === "completed");

    // A sub-session that stops to ask: the lead hears about it with the question id.
    const subKey = bg.targetSessionKey;
    const pendingAnswer = hub.askUserQuestion({ sessionKey: subKey, groupId: g4.groupId, title: "Which database?", questions: [{ id: "db", question: "PostgreSQL or SQLite?", type: "single", options: ["PostgreSQL", "SQLite"] }] });
    check("lead is told when a sub-session asks", await until(() => updates().some((u) => u.includes("Which database?") && u.includes("peer_answer_question") && /question id q-/.test(u))));
    const qid = /question id (q-[0-9a-f]+)/.exec(updates().find((u) => u.includes("Which database?")) ?? "")?.[1] ?? "";
    res = await post("/api/questions/resolve", { questionId: qid, answers: { db: "PostgreSQL" } });
    const answered = await pendingAnswer;
    check("the lead's answer reaches the sub-session", res.ok === true && answered.cancelled === false && answered.answers.db === "PostgreSQL");

    // A step whose agent says it failed is a failed step, and the lead decides what next.
    await post("/api/settings", { workflowParallel: 3 });
    await post("/api/workflows/save", {
      groupId: g4.groupId,
      steps: [
        { id: "fetch", agent: "mock-a", prompt: "FAILME fetch the data." },
        { id: "report", agent: "mock-a", prompt: "Write the report.", dependsOn: ["fetch"] },
        { id: "extra", agent: "mock-a", prompt: "FAILME optional extra." },
      ],
    });
    await post("/api/workflows/run", { groupId: g4.groupId });
    const wf4 = async (): Promise<Json> => (await get(`/api/workflows?groupId=${g4.groupId}`)).workflow;
    check("workflow stops", await until(async () => (await wf4()).status !== "running", 30000));
    let w = await wf4();
    const st = (id: string) => w.steps.find((s: Json) => s.id === id);
    check(
      "a reply that says FAILED fails the step and holds back what depends on it",
      w.status === "failed" && st("fetch").status === "failed" && st("fetch").error === "FAILED: no access" && st("report").status !== "completed",
      `${st("fetch").status}/${st("fetch").error} report=${st("report").status}`,
    );
    check(
      "the lead is asked to decide, not told it is done",
      await until(() => updates().some((u) => u.includes('FAILED "fetch"') && u.includes("workflow_continue") && u.includes("NOT done"))),
    );
    res = await post("/api/workflows/continue", { groupId: g4.groupId, depth: 1, guidance: [{ stepId: "fetch", text: "x" }] });
    check("a sub-session cannot make that decision", res.ok === false);
    res = await post("/api/workflows/continue", {
      groupId: g4.groupId,
      guidance: [{ stepId: "fetch", text: "Use the cached copy instead." }],
      skip: [{ stepId: "extra", reason: "not needed" }],
    });
    check("the lead's decision restarts the workflow", res.ok === true && res.workflow.status === "running", res.error);
    check("it then completes", await until(async () => (await wf4()).status === "completed", 30000), (await wf4()).status);
    w = await wf4();
    check(
      "retried with the lead's guidance; the skipped step did not block the rest",
      /other way/.test(st("fetch").output ?? "") && st("report").status === "completed" && /Skipped by the lead: not needed/.test(st("extra").output ?? ""),
      st("fetch").output,
    );
    check("the lead is told when the workflow finishes", await until(() => updates().some((u) => u.includes("The workflow finished"))));

    // Stopping a run yourself is not a failure for the lead to act on.
    await post("/api/workflows/save", { groupId: g4.groupId, steps: [{ id: "long", agent: "mock-a", prompt: "SLOW task." }] });
    const beforeStop = updates().length;
    await post("/api/workflows/run", { groupId: g4.groupId });
    await post("/api/workflows/cancel", { groupId: g4.groupId });
    await until(async () => (await wf4()).status !== "running", 15000);
    await sleep(1200);
    check("a run the user stopped is not reported as a failure", updates().length === beforeStop, String(updates().length - beforeStop));

    console.log("=== 6. Shared MCP servers ===");
    const codexDefs = parseCodexMcpServers(
      [
        'model = "x"',
        "[mcp_servers]",
        "[mcp_servers.db]",
        'url = "http://127.0.0.1:18780/mcp/db"',
        "[mcp_servers.repl]",
        "args = []",
        "command = 'C:\\tools\\repl.exe'",
        'env_vars = ["PASS_ME"]',
        "[mcp_servers.repl.env]",
        "HOME_DIR = 'D:\\data'",
        '[mcp_servers."kyp-review"]',
        'command = "python"',
        'args = ["D:/x/proxy.py", "--fast"]',
        '[plugins."x"]',
        "enabled = true",
      ].join("\n"),
    );
    check(
      "Codex config is read",
      codexDefs.length === 3 &&
        codexDefs[0]!.transport === "http" &&
        codexDefs[1]!.command === "C:\\tools\\repl.exe" &&
        codexDefs[1]!.env?.HOME_DIR === "D:\\data" &&
        codexDefs[1]!.envVars?.[0] === "PASS_ME" &&
        codexDefs[2]!.name === "kyp-review" &&
        codexDefs[2]!.args?.join() === "D:/x/proxy.py,--fast",
      JSON.stringify(codexDefs).slice(0, 200),
    );
    check(
      "Claude-style JSON is read",
      parseJsonMcpServers({ a: { command: "npx", args: ["-y", "srv"], env: { K: "v" } }, b: { type: "http", url: "http://x/mcp" }, c: { type: "sse", url: "http://x/sse" } }).map((s) => s.name + ":" + s.transport).join() === "a:stdio,b:http",
    );

    const mcpHome = path.join(tmp, "mcp-home");
    const mcpProj = path.join(tmp, "mcp-proj");
    fs.mkdirSync(path.join(mcpHome, ".codex"), { recursive: true });
    fs.mkdirSync(mcpProj, { recursive: true });
    fs.writeFileSync(path.join(mcpHome, ".codex", "config.toml"), '[mcp_servers.db]\nurl = "http://127.0.0.1:1/mcp"\n[mcp_servers.tool]\ncommand = "node"\nargs = ["t.js"]\n', "utf8");
    fs.writeFileSync(path.join(mcpProj, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"], env: { TOKEN: "${RTM_TEST_DOCS_TOKEN}" } } } }), "utf8");
    const mcpEnv: NodeJS.ProcessEnv = {};
    const mgr2 = new McpServerManager(path.join(tmp, "mcp-servers.json"), mcpHome, mcpEnv);
    const names = (agent: string, role: "lead" | "sub", http = true) =>
      mgr2.forSession({ agent, role, cwd: mcpProj, httpSupported: http }).map((s) => s.name).join();
    check("discovered servers are off until switched on", names("opencode", "lead") === "" && mgr2.list(mcpProj).length === 3);
    mgr2.setState("codex:db", { enabled: true });
    mgr2.setState("codex:tool", { enabled: true });
    check("shared with other agents, lead only", names("opencode", "lead") === "db,tool" && names("opencode", "sub") === "");
    check("not passed back to the agent that already has it", names("codex", "lead") === "");
    check("HTTP servers only go to agents that support them", names("opencode", "lead", false) === "tool");
    mgr2.setState("codex:tool", { roles: ["lead", "sub"] });
    check("sub-sessions get it once ticked", names("opencode", "sub") === "tool");
    mgr2.setState("codex:tool", { agent: "opencode", agentEnabled: false });
    check("can be switched off for one agent", names("opencode", "lead") === "db" && names("kimi", "lead") === "db,tool");
    mgr2.setState("project:docs", { enabled: true });
    check("an untrusted project file is not started", !names("kimi", "lead").includes("docs") && mgr2.list(mcpProj).find((s) => s.id === "project:docs")?.trusted === false);
    mgr2.setProjectTrust(mcpProj, true);
    check("a trusted one with a missing variable is still held back", !names("kimi", "lead").includes("docs") && mgr2.list(mcpProj).find((s) => s.id === "project:docs")?.missingEnv.join() === "RTM_TEST_DOCS_TOKEN");
    mcpEnv.RTM_TEST_DOCS_TOKEN = "secret";
    const docs = mgr2.forSession({ agent: "kimi", role: "lead", cwd: mcpProj, httpSupported: true }).find((s) => s.name === "docs") as { env: Array<{ name: string; value: string }> } | undefined;
    check("started once the variable is set, with its value filled in", docs?.env[0]?.value === "secret");
    fs.appendFileSync(path.join(mcpProj, ".mcp.json"), "\n", "utf8");
    check("changing the project file withdraws the trust", !names("kimi", "lead").includes("docs"));
    let refused = false;
    try { mgr2.save({ name: "agent-hub-peers", transport: "stdio", command: "x" }); } catch { refused = true; }
    check("the workbench's own server name is reserved", refused);

    // End to end: the hub hands the server to a real session/new, by role.
    const newLog = path.join(stateDir, "session-new.log");
    const lastMcp = (): string[] => {
      const lines = fs.existsSync(newLog) ? fs.readFileSync(newLog, "utf8").trim().split("\n") : [];
      return lines.length ? (JSON.parse(lines[lines.length - 1]!).mcp as string[]) : [];
    };
    res = await post("/api/mcp/save", { groupId: g.groupId, server: { name: "demo-tools", transport: "stdio", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } });
    check("server added through the API and listed", res.ok === true && res.servers.some((s: Json) => s.id === "rtm:demo-tools" && s.enabled), res.error);
    const g3 = (await post("/api/groups", { title: "mcp", leadAgent: "mock-a", cwd })).group;
    await post("/api/chat", { groupId: g3.groupId, prompt: "hello" });
    check("lead session receives the shared server", lastMcp().includes("demo-tools") && lastMcp().includes("agent-hub-peers"), lastMcp().join());
    const subTask = hub.dispatchPeerTask({
      targetAgent: "mock-a", groupId: g3.groupId, session: "s1", callerAgent: "mock-a",
      callerSession: `mock-a:${g3.groupId}__lead`, depth: 0, isolateWorktree: false, prompt: "hi",
    });
    await until(() => sessions().find((s) => s.sessionKey === subTask.targetSessionKey)?.status === "idle");
    check("sub-session does not", !lastMcp().includes("demo-tools") && lastMcp().includes("agent-hub-peers"), lastMcp().join());
    await post("/api/mcp/state", { groupId: g3.groupId, id: "rtm:demo-tools", roles: ["lead", "sub"] });
    const subTask2 = hub.dispatchPeerTask({
      targetAgent: "mock-a", groupId: g3.groupId, session: "s2", callerAgent: "mock-a",
      callerSession: `mock-a:${g3.groupId}__lead`, depth: 0, isolateWorktree: false, prompt: "hi",
    });
    await until(() => sessions().find((s) => s.sessionKey === subTask2.targetSessionKey)?.status === "idle");
    check("sub-session does after it is ticked", lastMcp().includes("demo-tools"), lastMcp().join());
    res = await post("/api/mcp/delete", { groupId: g3.groupId, name: "demo-tools" });
    check("server deleted", res.ok === true && !res.servers.some((s: Json) => s.id === "rtm:demo-tools"));
  } finally {
    await hub.stop();
  }

  console.log("=== 7. Supervisor restarts a killed hub and keeps its logs ===");
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

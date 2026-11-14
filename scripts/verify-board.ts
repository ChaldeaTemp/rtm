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

import type { BoardStatus, TaskBoardInfo } from "../src/types.js";
import {
  clampBoardParallel,
  clampIdleLeadMinutes,
  pickToStart,
  applyBoardAction,
  missingDeliverables,
} from "../src/hub/task-board.js";

console.log("=== 1. Board logic ===");
const q = (id: string, queuedAt: number, status: BoardStatus = "queued") =>
  ({ groupId: id, board: { status, brief: id, queuedAt, rejectCount: 0 } as TaskBoardInfo });
check("clamp parallel", clampBoardParallel(undefined) === 2 && clampBoardParallel(0) === 2 && clampBoardParallel(99) === 8 && clampBoardParallel(3) === 3);
check("clamp idle lead", clampIdleLeadMinutes(undefined) === 0 && clampIdleLeadMinutes(-1) === 0 && clampIdleLeadMinutes(999) === 240);
check("oldest first, up to the limit", pickToStart([q("c", 30), q("a", 10), q("b", 20)], new Set(), 2).join() === "a,b");
check("running tasks use slots", pickToStart([q("r", 1, "running"), q("a", 10), q("b", 20)], new Set(), 2).join() === "a");
check("a waiting task frees its slot", pickToStart([q("r", 1, "running"), q("a", 10)], new Set(["r"]), 1).join() === "a");
check("delivered, done and failed use no slot", pickToStart([q("d", 1, "delivered"), q("e", 2, "done"), q("f", 3, "failed"), q("a", 10)], new Set(), 1).join() === "a");
check("archived and non-board tasks are ignored", pickToStart([{ groupId: "x" }, { ...q("z", 5), archived: true }, q("a", 10)], new Set(), 1).join() === "a");

const delivered = { ...q("d", 100, "delivered").board, deliveredAt: 200 };
check("confirm", applyBoardAction(delivered, "confirm", { now: 300 }).status === "done");
const rejected = applyBoardAction(delivered, "reject", { now: 300, note: "missing tests", earliestQueuedAt: 50 });
check("reject goes to the head of the queue", rejected.status === "queued" && rejected.queuedAt === 49 && rejected.rejectCount === 1 && rejected.rejectNote === "missing tests" && rejected.deliverables === undefined);
check("reject with an empty queue", applyBoardAction(delivered, "reject", { now: 300, note: "n" }).queuedAt === 300);
const failedBoard = { ...q("f", 100, "failed").board, failReason: "x" };
const retried = applyBoardAction(failedBoard, "retry", { now: 400 });
check("retry goes to the tail", retried.status === "queued" && retried.queuedAt === 400 && retried.failReason === undefined);
check("cancel a running task", applyBoardAction(q("r", 1, "running").board, "cancel", { now: 5 }).status === "failed");
check("resume clears interrupted", applyBoardAction({ ...q("r", 1, "running").board, interrupted: true }, "resume", { now: 5 }).interrupted === undefined);
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
check("actions outside their status are refused",
  throws(() => applyBoardAction(q("a", 1).board, "confirm", { now: 1 })) &&
  throws(() => applyBoardAction(delivered, "retry", { now: 1 })) &&
  throws(() => applyBoardAction(q("d", 1, "done").board, "cancel", { now: 1 })) &&
  throws(() => applyBoardAction(q("r", 1, "running").board, "resume", { now: 1 })) &&
  throws(() => applyBoardAction(delivered, "reject", { now: 1 })));   // 打回必须带说明

const root = path.resolve("/proj");
const has = (p: string) => p === path.join(root, "out", "a.md");
check("existing file passes", missingDeliverables([{ kind: "file", path: "out/a.md" }, { kind: "text", note: "n" }], [root], has).length === 0);
check("missing file is listed", missingDeliverables([{ kind: "file", path: "out/b.md" }], [root], has).join() === "out/b.md");
check("a path outside the roots counts as missing", missingDeliverables([{ kind: "file", path: "../etc/passwd" }, { kind: "file", path: path.resolve("/other/x") }], [root], () => true).length === 2);
check("a file entry without a path counts as missing", missingDeliverables([{ kind: "file" }], [root], has).length === 1);

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-verify-board-"));
  const cwd = path.join(tmp, "proj");
  const stateDir = path.join(tmp, "mock-state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const hub = new AgentHubServer({ baseCwd: cwd, port: 0, writeRuntimeFile: false, persistState: true, defaultLead: "mock-a" });
  const url = await hub.start(0);
  const post = (p: string, body: unknown): Promise<Json> =>
    fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
  const get = (p: string): Promise<Json> => fetch(url + p).then((r) => r.json() as Promise<Json>);
  const sessions = (): Json[] => (hub as unknown as { listVisibleSessions(): Json[] }).listVisibleSessions();

  try {
    const regRes = await post("/api/agents/save", {
      id: "mock-a", label: "MOCK-A", description: "mock", enabled: true,
      command: process.execPath, args: [MOCK], env: { MOCK_STATE_DIR: stateDir },
    });
    check("mock agent mock-a registered", regRes.ok === true, regRes.error);

    console.log("=== 2. Publish and schedule ===");
    await post("/api/settings", { boardParallel: 1 });
    let res = await post("/api/board/publish", {
      common: "Shared rule: reply in one line.",
      items: [{ brief: "VERYSLOW first", cwd }, { brief: "second", cwd }, { brief: "third", cwd, title: "Third" }],
    });
    check("three tasks published", res.ok === true && res.groups?.length === 3, res.error);
    const ids: string[] = (res.groups ?? []).map((g: Json) => g.groupId);
    const cards = async (): Promise<Json[]> => (await get("/api/board")).cards ?? [];
    const card = async (id: string): Promise<Json | undefined> => (await cards()).find((c) => c.groupId === id);
    check("only the first one runs", await until(async () => (await card(ids[0]))?.board.status === "running"));
    check("the others wait in order", (await cards()).filter((c) => c.board.status === "queued").map((c) => c.groupId).join() === ids.slice(1).join());
    check("its lead got the brief, the shared text and the report instruction", await until(() => {
      const m = hub.getMessages({ streamKey: `lead:${ids[0]}` }).find((x: Json) => x.role === "user");
      return !!m && /Shared rule/.test(m.text) && /VERYSLOW first/.test(m.text) && /task_report/.test(m.text);
    }));
    check("shared text is also in the task context", Boolean((await get(`/api/context?groupId=${ids[1]}`)).context?.sections?.some((s: Json) => s.key === "common" && /Shared rule/.test(s.content))));
    check("publishing is all or nothing", (await post("/api/board/publish", { items: [{ brief: "ok", cwd }, { brief: "bad", cwd: path.join(tmp, "nope") }] })).ok === false && (await cards()).length === 3);
    await post("/api/agents/save", {
      id: "mock-off", label: "MOCK-OFF", description: "disabled", enabled: false,
      command: process.execPath, args: [MOCK],
    });
    check("disabled leadAgent is refused all or nothing", (await post("/api/board/publish", { items: [{ brief: "ok", cwd }, { brief: "bad", cwd, leadAgent: "mock-off" }] })).ok === false && (await cards()).length === 3);
    check("an empty brief is refused", (await post("/api/board/publish", { items: [{ brief: "  " }] })).ok === false);
    check("tasks made the old way are not on the board", (await post("/api/groups", { title: "plain", leadAgent: "mock-a", cwd })).ok === true && (await cards()).length === 3);

    // 内存压力守卫自动验证（单独起临时 hub 测试，不影响主 hub 的 ids[0..2]）
    {
      const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-verify-mem-"));
      const memCwd = path.join(memTmp, "proj");
      const memState = path.join(memTmp, "mock-state");
      fs.mkdirSync(memCwd, { recursive: true });
      fs.mkdirSync(memState, { recursive: true });
      let memAvailableMB = 3000;
      const memHub = new AgentHubServer({
        baseCwd: memCwd,
        port: 0,
        writeRuntimeFile: false,
        defaultLead: "mock-a",
      });
      (memHub as any).memory.sampler = async () => ({ availableMB: memAvailableMB, totalMB: 57000 });
      const memUrl = await memHub.start(0);
      const memPost = (p: string, b: unknown): Promise<Json> =>
        fetch(memUrl + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as Promise<Json>);
      const memGet = (p: string): Promise<Json> => fetch(memUrl + p).then((r) => r.json() as Promise<Json>);
      try {
        await memPost("/api/agents/save", {
          id: "mock-a", label: "MOCK-A", description: "mock", enabled: true,
          command: process.execPath, args: [MOCK], env: { MOCK_STATE_DIR: memState },
        });
        await (memHub as any).memory.sample();
        await memPost("/api/board/publish", {
          items: [{ brief: "mem-test task", cwd: memCwd }],
        });
        const memCard = async () => ((await memGet("/api/board")).cards as Json[])?.[0];
        check("queued when low memory even with available slot", (await memCard())?.board.status === "queued");
        memAvailableMB = 9000;
        await (memHub as any).memory.sample();
        check("starts automatically once memory recovers to ok", await until(async () => (await memCard())?.board.status === "running"));
      } finally {
        await memHub.stop();
        try { fs.rmSync(memTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore on windows */ }
      }
    }
  } finally {
    await hub.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore on windows */ }
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nBoard verification passed completely.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

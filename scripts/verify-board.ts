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

if (failed > 0) process.exitCode = 1;

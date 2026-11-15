import "./isolate-data.js";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

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
  buildBoardPrompt,
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

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-verify-board-"));
  const cwd = path.join(tmp, "proj");
  const stateDir = path.join(tmp, "mock-state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Scheduling checks use stable headroom. The tests below supply low-memory readings explicitly.
  const normalMemory = async () => ({ availableMB: 9000, totalMB: 57000 });
  const hub = new AgentHubServer({ baseCwd: cwd, port: 0, writeRuntimeFile: false, persistState: true, defaultLead: "mock-a" });
  (hub as any).memory.sampler = normalMemory;
  const url = await hub.start(0);
  const post = (p: string, body: unknown): Promise<Json> =>
    fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
  const get = (p: string): Promise<Json> => fetch(url + p).then((r) => r.json() as Promise<Json>);
  const sessions = (): Json[] => (hub as unknown as { listVisibleSessions(): Json[] }).listVisibleSessions();
  const updatesLog = path.join(stateDir, "updates.log");
  const updates = (): string[] =>
    fs.existsSync(updatesLog)
      ? fs.readFileSync(updatesLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string)
      : [];
  const promptLog = path.join(stateDir, "session-turns.log");
  const prompts = (): string[] => fs.existsSync(promptLog)
    ? fs.readFileSync(promptLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((event) => event.event === "prompt").map((event) => event.preview)
    : [];

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
      items: [{ brief: "VERYSLOW first", cwd }, { brief: "second", cwd }, { brief: "VERYSLOW third", cwd, title: "Third" }],
    });
    check("three tasks published", res.ok === true && res.groups?.length === 3, res.error);
    const ids: string[] = (res.groups ?? []).map((g: Json) => g.groupId);
    const cards = async (): Promise<Json[]> => (await get("/api/board")).cards ?? [];
    const card = async (id: string): Promise<Json | undefined> => (await cards()).find((c) => c.groupId === id);
    check("only the first one runs", await until(async () => (await card(ids[0]))?.board.status === "running"));
    check("the others wait in order", (await cards()).filter((c) => c.board.status === "queued").map((c) => c.groupId).join() === ids.slice(1).join());
    check("the lead receives the brief, shared text and report instruction", await until(() =>
      prompts().some((p) => p.includes("Shared rule") && p.includes("VERYSLOW first") && p.includes("task_report"))));
    const boardMessage = hub.getMessages({ streamKey: `lead:${ids[0]}` }).find((m) => m.role === "user");
    check("the chat message shows the brief and shared text", Boolean(boardMessage?.text.includes("Shared rule") &&
      boardMessage.text.includes("VERYSLOW first") && !boardMessage.text.includes("<task_board>")));
    check("shared text is also in the task context", Boolean((await get(`/api/context?groupId=${ids[1]}`)).context?.sections?.some((s: Json) => s.key === "common" && /Shared rule/.test(s.content))));
    check("publishing is all or nothing", (await post("/api/board/publish", { items: [{ brief: "ok", cwd }, { brief: "bad", cwd: path.join(tmp, "nope") }] })).ok === false && (await cards()).length === 3);
    await post("/api/agents/save", {
      id: "mock-off", label: "MOCK-OFF", description: "disabled", enabled: false,
      command: process.execPath, args: [MOCK],
    });
    check("disabled leadAgent is refused all or nothing", (await post("/api/board/publish", { items: [{ brief: "ok", cwd }, { brief: "bad", cwd, leadAgent: "mock-off" }] })).ok === false && (await cards()).length === 3);
    check("an empty brief is refused", (await post("/api/board/publish", { items: [{ brief: "  " }] })).ok === false);
    check("tasks made the old way are not on the board", (await post("/api/groups", { title: "plain", leadAgent: "mock-a", cwd })).ok === true && (await cards()).length === 3);

    // WS snapshot includes boardCards and defaultTitleNumber
    const snapshot = await new Promise<Json>((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for WS snapshot"));
      }, 10000);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Json;
          if (msg.type === "snapshot") {
            clearTimeout(timer);
            ws.close();
            resolve(msg);
          }
        } catch {
          // ignore
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const snapCards = Array.isArray(snapshot.boardCards) ? (snapshot.boardCards as Json[]) : [];
    const snapCard0 = snapCards.find((c) => c.groupId === ids[0]);
    const snapCard1 = snapCards.find((c) => c.groupId === ids[1]);
    const snapCard2 = snapCards.find((c) => c.groupId === ids[2]);
    const snapGroups = Array.isArray(snapshot.taskGroups) ? (snapshot.taskGroups as Json[]) : [];
    const snapDefaultGroup = snapGroups.find((g) => g.groupId === "grp-default");
    const snapGroup1 = snapGroups.find((g) => g.groupId === ids[1]);
    check(
      "WS snapshot includes boardCards and defaultTitleNumber",
      snapshot.type === "snapshot" &&
        snapCards.length === 3 &&
        Boolean(snapCard0) &&
        "defaultTitleNumber" in snapCard0! &&
        typeof snapCard1?.defaultTitleNumber === "number" &&
        snapCard1.defaultTitleNumber >= 2 &&
        snapCard2?.defaultTitleNumber === null &&
        snapGroup1?.defaultTitleNumber === snapCard1.defaultTitleNumber &&
        snapDefaultGroup?.defaultTitleNumber === 1,
      JSON.stringify({
        len: snapCards.length,
        n0: snapCard0?.defaultTitleNumber,
        n1: snapCard1?.defaultTitleNumber,
        n2: snapCard2?.defaultTitleNumber,
        g1: snapGroup1?.defaultTitleNumber,
        def: snapDefaultGroup?.defaultTitleNumber,
      }),
    );

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

    console.log("=== 3. Report ===");
    const report = (groupId: string, body: Json) => post("/api/board/report", { groupId, ...body });
    res = await report(ids[0], { outcome: "delivered", summary: "done", deliverables: [{ kind: "file", path: "out/missing.md" }] });
    check("a missing file is refused and named", res.ok === false && /out\/missing\.md/.test(res.error ?? "") && (await card(ids[0]))?.board.status === "running");
    res = await report(ids[0], { outcome: "delivered", summary: "done", deliverables: [{ kind: "file", path: "../outside.md" }] });
    check("a path outside the task directory is refused", res.ok === false);
    fs.mkdirSync(path.join(cwd, "out"), { recursive: true });
    res = await report(ids[0], { outcome: "delivered", summary: "done", deliverables: [{ kind: "file", path: "out" }] });
    check("a directory itself is refused as a file deliverable", res.ok === false);
    res = await report(ids[0], { depth: 1, outcome: "delivered", summary: "done" });
    check("a sub-session cannot report", res.ok === false && (await card(ids[0]))?.board.status === "running");
    fs.writeFileSync(path.join(cwd, "out", "a.md"), "x");
    res = await report(ids[0], { outcome: "delivered", summary: "wrote a.md", deliverables: [{ kind: "file", path: "out/a.md" }, { kind: "text", note: "see chat" }] });
    check("delivered", res.ok === true && res.board.status === "delivered" && res.board.deliverables.length === 2 && typeof res.board.deliveredAt === "number", res.error);
    const downloadUrl = `${url}/api/board/deliverable?groupId=${ids[0]}&index=`;
    const downloaded = await fetch(downloadUrl + "0");
    check("a reported file downloads as an attachment",
      downloaded.ok && downloaded.headers.get("content-disposition")?.startsWith("attachment") === true &&
      await downloaded.text() === "x");
    check("text and unreported files cannot use the download route",
      (await fetch(downloadUrl + "1")).status === 404 && (await fetch(downloadUrl + "2")).status === 404);
    fs.unlinkSync(path.join(cwd, "out", "a.md"));
    const outsideDir = path.join(tmp, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "a.md"), "outside");
    fs.rmdirSync(path.join(cwd, "out"));
    fs.symlinkSync(outsideDir, path.join(cwd, "out"), "junction");
    check("a delivery path redirected outside the task is refused", (await fetch(downloadUrl + "0")).status === 404);
    check("the next task starts", await until(async () => (await card(ids[1]))?.board.status === "running"));
    check("reporting twice is refused", (await report(ids[0], { outcome: "delivered", summary: "again" })).ok === false);
    check("its sessions are released once the turn ends", await until(() => sessions().filter((s) => s.groupId === ids[0]).every((s) => s.status === "closed"), 30000));
    res = await report(ids[1], { outcome: "failed", summary: "cannot", reason: "no access" });
    check("failed with a reason", res.ok === true && res.board.status === "failed" && res.board.failReason === "no access");
    check("failed needs a reason", (await report(ids[2], { outcome: "failed", summary: "x" })).ok === false);
    const plain = (await post("/api/groups", { title: "plain2", leadAgent: "mock-a", cwd })).group;
    check("a task that is not on the board is refused", (await report(plain.groupId, { outcome: "delivered", summary: "x" })).ok === false);

    console.log("=== 4. Waiting and user actions ===");
    const act = (groupId: string, action: string, note?: string) => post("/api/board/action", { groupId, action, note });
    check("third task is running", await until(async () => (await card(ids[2]))?.board.status === "running"));
    res = await post("/api/board/publish", { items: [{ brief: "SLOW fourth", cwd }] });
    const fourth: string = res.groups[0].groupId;
    const pendingQ = hub.askUserQuestion({
      groupId: ids[2],
      sessionKey: `mock-a:${ids[2]}__lead`,
      title: "Pick",
      questions: [{ id: "a", question: "A?", type: "text" }],
    });
    check("a question makes the task wait", await until(async () => {
      const c = await card(ids[2]);
      return c?.waiting === true && c?.waitingReason === "question";
    }, 5000));
    check("its slot goes to the next task", await until(async () => (await card(fourth))?.board.status === "running", 5000));
    const qid = hub.listPendingQuestions().find((q) => q.groupId === ids[2])?.questionId ?? "";
    await post("/api/questions/resolve", { questionId: qid, answers: { a: "x" } });
    await pendingQ;
    check("answering ends the wait; both now run", await until(async () => (await card(ids[2]))?.waiting === false) && (await card(fourth))?.board.status === "running");

    check("confirm", (await act(ids[0], "confirm")).group?.board.status === "done");
    check("confirm twice is refused", (await act(ids[0], "confirm")).ok === false);
    check("retry puts a failed task at the tail", (await act(ids[1], "retry")).group?.board.status === "queued");
    await report(fourth, { outcome: "delivered", summary: "ok" });
    check("reject needs a note", (await act(fourth, "reject")).ok === false);
    res = await act(fourth, "reject", "add tests");
    check("rejected task is queued ahead of the retried one", res.group?.board.rejectCount === 1 &&
      (await cards()).filter((c) => c.board.status === "queued").map((c) => c.groupId).join() === [fourth, ids[1]].join());
    const staleCancel = await post("/api/board/action", { groupId: ids[2], action: "cancel", expectedStatus: "queued" });
    check("a stale queue cancellation cannot stop a running task", staleCancel.ok === false && (await card(ids[2]))?.board.status === "running");
    check("cancel a running task", (await act(ids[2], "cancel")).group?.board.status === "failed");
    check("the rejected task restarts with the note", await until(() =>
      prompts().some((p) => p.includes("SLOW fourth") && p.includes("add tests") && p.includes("task_report"))));
    check("the rejected dispatch still displays the brief", hub.getMessages({ streamKey: `lead:${fourth}` })
      .filter((m) => m.role === "user").every((m) => m.text === "SLOW fourth"));
    res = await post("/api/board/publish", { items: [{ brief: "to cancel", cwd }] });
    const queuedOne: string = res.groups[0].groupId;
    check("cancelling a queued task archives it", (await act(queuedOne, "cancel")).group?.archived === true && !(await cards()).some((c) => c.groupId === queuedOne));

    res = await post("/api/board/publish", { items: [{ brief: "to archive", cwd }, { brief: "to delete", cwd }, { brief: "after them", cwd }] });
    const [toArchive, toDelete, afterThem]: string[] = res.groups.map((g: Json) => g.groupId);
    await post("/api/groups/update", { groupId: ids[1], archived: true });
    await post("/api/groups/update", { groupId: toArchive, archived: true });
    await post("/api/groups/delete", { groupId: toDelete });
    await report(fourth, { outcome: "delivered", summary: "ok2" });
    check("archived and deleted queued tasks never start and the queue moves on",
      await until(async () => (await card(afterThem))?.board.status === "running") &&
      hub.getGroup(toArchive)?.board?.status === "queued" &&
      hub.getGroup(toDelete) === undefined);
    await act(afterThem, "cancel");
    check("archived board tasks refuse report and actions",
      (await report(toArchive, { outcome: "delivered", summary: "x" })).ok === false &&
      (await act(toArchive, "cancel")).ok === false &&
      (await act(ids[1], "retry")).ok === false);

    res = await post("/api/board/publish", { items: [{ brief: "VERYSLOW perm-first", cwd }, { brief: "VERYSLOW perm-second", cwd }] });
    const [permTask, permNext]: string[] = res.groups.map((g: Json) => g.groupId);
    await until(() => (hub as any).pool.getSession(`mock-a:${permTask}__lead`)?.status === "busy", 5000);
    (hub as any).pool.setPermissionMode("manual");
    const permPromise = (hub as any).pool.handlePermissionRequest(
      `mock-a:${permTask}__lead`,
      "mock-a",
      {
        sessionId: "s-perm",
        toolCall: { toolCallId: "tc-perm", title: "write_file", kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    check("a pending permission makes the task wait and frees its slot", await until(async () => {
      const c = await card(permTask);
      return c?.waiting === true && c?.waitingReason === "permission" && (await card(permNext))?.board.status === "running";
    }, 5000));
    await act(permTask, "cancel");
    await act(permNext, "cancel");
    check("cancelling resolves pending permissions", (await permPromise)?.outcome?.outcome === "cancelled" && (hub as any).pool.getPendingPermissions().length === 0);
    (hub as any).pool.setPermissionMode("approve-all");
    await act(permTask, "retry");
    const permBehind: string = (await post("/api/board/publish", { items: [{ brief: "VERYSLOW perm-behind", cwd }] })).groups[0].groupId;
    await sleep(300);
    check("retried task after permission cancel occupies its slot and survives old turn catch",
      (await card(permTask))?.board.status === "running" &&
      (await card(permTask))?.waiting === false &&
      (await card(permBehind))?.board.status === "queued");
    await act(permTask, "cancel");
    await act(permBehind, "cancel");

    const [startingGroup] = hub.publishBoardTasks({ items: [{ brief: "CODEWORD? OSPREY-99", cwd }] });
    await hub.actOnBoardTask({ groupId: startingGroup.groupId, action: "cancel" });
    await sleep(500);
    check("cancelling during session startup aborts the first turn",
      (await card(startingGroup.groupId))?.board.status === "failed" &&
      !hub.getMessages({ streamKey: `lead:${startingGroup.groupId}` }).some((m: Json) => m.role === "assistant" && /OSPREY-99/.test(m.text)));

    const subCancelTask: string = (await post("/api/board/publish", { items: [{ brief: "VERYSLOW sub-cancel", cwd }] })).groups[0].groupId;
    await until(() => (hub as any).pool.getSession(`mock-a:${subCancelTask}__lead`)?.status === "busy", 5000);
    hub.dispatchPeerTask({
      callerAgent: "mock-a",
      callerSession: `mock-a:${subCancelTask}__lead`,
      targetAgent: "mock-a",
      groupId: subCancelTask,
      prompt: "VERYSLOW sub-worker",
      depth: 0,
    });
    await until(() => (hub as any).pool.listSessions().some((s: Json) => s.groupId === subCancelTask && s.role === "sub" && s.status === "busy"), 5000);
    await act(subCancelTask, "cancel");
    await sleep(400);
    check("sub-session failure on cancel does not wake the closed lead",
      sessions().filter((s) => s.groupId === subCancelTask).every((s) => s.status === "closed") &&
      hub.getMessages({ streamKey: `lead:${subCancelTask}` }).filter((m: Json) => m.role === "assistant").length === 1);

    const subDeliverTask: string = (await post("/api/board/publish", { items: [{ brief: "SLOW sub-deliver", cwd }] })).groups[0].groupId;
    await until(() => (hub as any).pool.getSession(`mock-a:${subDeliverTask}__lead`)?.status === "busy", 5000);
    hub.dispatchPeerTask({
      callerAgent: "mock-a",
      callerSession: `mock-a:${subDeliverTask}__lead`,
      targetAgent: "mock-a",
      groupId: subDeliverTask,
      prompt: "VERYSLOW sub-worker-2",
      depth: 0,
    });
    await until(() => (hub as any).pool.listSessions().some((s: Json) => s.groupId === subDeliverTask && s.role === "sub" && s.status === "busy"), 5000);
    await report(subDeliverTask, { outcome: "delivered", summary: "delivered with active sub" });
    check("sub-session closed after delivery does not wake the closed lead",
      await until(() => sessions().filter((s) => s.groupId === subDeliverTask).every((s) => s.status === "closed"), 5000) &&
      (await sleep(400), sessions().filter((s) => s.groupId === subDeliverTask).every((s) => s.status === "closed")) &&
      hub.getMessages({ streamKey: `lead:${subDeliverTask}` }).filter((m: Json) => m.role === "assistant").length === 1);

    console.log("=== 5. A lead that ends without reporting ===");
    await post("/api/settings", { boardParallel: 8 });
    const beforeSilent = updates().length;
    res = await post("/api/board/publish", { items: [{ brief: "never reports", cwd }] });
    const silent: string = res.groups[0].groupId;
    const leadMsgs = () => hub.getMessages({ streamKey: `lead:${silent}` });
    check("it is asked to report or continue", await until(() =>
      updates().slice(beforeSilent).some((u) => /<workbench_update>/.test(u) && /task_report/.test(u)) &&
      leadMsgs().some((m: Json) => m.role === "system"), 5000));
    check("after the limit it waits for the user", await until(async () => {
      const c = await card(silent);
      return c?.board.status === "running" && c?.waiting === true && c?.waitingReason === "stalled";
    }, 60000));
    const turnsAtStall = leadMsgs().filter((m: Json) => m.role === "assistant").length;
    await sleep(1500);
    check("no more automatic turns after that", leadMsgs().filter((m: Json) => m.role === "assistant").length === turnsAtStall);

    await post("/api/settings", { boardParallel: 1 });
    const slotHolder: string = (await post("/api/board/publish", { items: [{ brief: "SLOW holder", cwd }] })).groups[0].groupId;
    check("stalled task frees its slot for another task", await until(async () => (await card(slotHolder))?.board.status === "running"));
    const userChatPromise = post("/api/chat", { groupId: silent, prompt: "SLOW keep going" });
    check("a user message clears the stall even over the parallel limit", await until(async () => {
      const c = await card(silent);
      return c?.board.status === "running" && c?.waiting === false && c?.waitingReason === undefined;
    }, 5000));
    check("direct user message succeeds", (await userChatPromise).ok === true);
    await act(silent, "cancel");
    await act(slotHolder, "cancel");

    console.log("=== 6. Restart and sleeping leads ===");
    await post("/api/settings", { boardParallel: 2 });
    res = await post("/api/board/publish", {
      items: [
        { brief: "Remember OSPREY-58. VERYSLOW", cwd },
        { brief: "VERYSLOW direct-msg", cwd },
        { brief: "VERYSLOW waits behind", cwd },
      ],
    });
    const [running, runningDirect, behind]: string[] = res.groups.map((g: Json) => g.groupId);
    check("first is running", await until(async () =>
      (await card(running))?.board.status === "running" &&
      (await card(runningDirect))?.board.status === "running" &&
      hub.getMessages({ streamKey: `lead:${running}` }).length > 0));
    await post("/api/settings", { boardParallel: 1 });
    await hub.stop();

    const stateJsonRaw = fs.readFileSync(path.join(process.env.RTM_DATA_DIR!, "state.json"), "utf8");
    check("waiting state is never persisted to disk", !/"waiting"\s*:/.test(stateJsonRaw) && !/"waitingReason"\s*:/.test(stateJsonRaw));
    const legacyState = JSON.parse(stateJsonRaw);
    const oldDispatch = legacyState.messages.find((m: Json) => m.groupId === running && m.role === "user");
    const visibleBrief = oldDispatch.text;
    oldDispatch.text = buildBoardPrompt(visibleBrief, "legacy review note");
    delete oldDispatch.boardDispatch;
    fs.writeFileSync(path.join(process.env.RTM_DATA_DIR!, "state.json"), JSON.stringify(legacyState));

    const hub2 = new AgentHubServer({ baseCwd: cwd, port: 0, writeRuntimeFile: false, persistState: true, defaultLead: "mock-a" });
    (hub2 as any).memory.sampler = normalMemory;
    const url2 = await hub2.start(0);
    const post2 = (p: string, body: unknown): Promise<Json> =>
      fetch(url2 + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
    const card2 = async (id: string): Promise<Json | undefined> =>
      ((await (await fetch(url2 + "/api/board")).json() as Json).cards as Json[] ?? []).find((c: Json) => c.groupId === id);
    try {
      const restoredDispatch = hub2.getMessages({ streamKey: `lead:${running}` }).find((m) => m.role === "user");
      check("legacy board chat is cleaned and its retry context is retained",
        restoredDispatch?.text === visibleBrief && restoredDispatch?.boardDispatch?.rejectNote === "legacy review note");
      if (!(hub2 as any).registry.isEnabledAgent("mock-a")) {
        await post2("/api/agents/save", {
          id: "mock-a", label: "MOCK-A", description: "mock", enabled: true,
          command: process.execPath, args: [MOCK], env: { MOCK_STATE_DIR: stateDir },
        });
      }
      check("after a restart the running task waits for the user",
        (await card2(running))?.board.status === "running" &&
        (await card2(running))?.waiting === true &&
        (await card2(running))?.waitingReason === "interrupted");
      check("it is not restarted by itself",
        (hub2 as any).listVisibleSessions().every((s: Json) => s.groupId !== running || s.status === "closed"));
      check("the queued task starts", await until(async () => (await card2(behind))?.board.status === "running", 5000));

      const directChatPromise = post2("/api/chat", { groupId: runningDirect, prompt: "SLOW continue directly" });
      check("a user message clears interrupted even over the parallel limit", await until(async () => {
        const c = await card2(runningDirect);
        return c?.board.status === "running" && c?.waiting === false && c?.waitingReason === undefined;
      }, 5000));
      check("direct message to interrupted task succeeds", (await directChatPromise).ok === true);
      await post2("/api/board/action", { groupId: runningDirect, action: "cancel" });

      const beforeResume = updates().length;
      res = await post2("/api/board/action", { groupId: running, action: "resume" });
      check("resume clears the mark", res.ok === true && res.group?.board.interrupted === undefined, res.error);
      check("the resumed lead is given what was said before", await until(() =>
        updates().slice(beforeResume).some((u) => /OSPREY-58/.test(u)), 30000));
      await post2("/api/board/action", { groupId: running, action: "cancel" });
      await post2("/api/board/action", { groupId: behind, action: "cancel" });

      console.log("=== 7. Idle leads ===");
      const plainTask = (await post2("/api/groups", { title: "plain", leadAgent: "mock-a", cwd })).group;
      await post2("/api/chat", { groupId: plainTask.groupId, prompt: "hello" });
      const leadKey = `mock-a:${plainTask.groupId}__lead`;
      check("lead is idle", await until(() => (hub2 as any).listVisibleSessions().find((s: Json) => s.sessionKey === leadKey)?.status === "idle"));
      check("leads are kept by default", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions(Date.now() + 24 * 3600_000).length === 0);
      await post2("/api/settings", { idleLeadMinutes: 30 });
      check("kept while recently used", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions().length === 0);
      const holdQ = hub2.askUserQuestion({
        groupId: plainTask.groupId,
        sessionKey: leadKey,
        title: "Hold?",
        questions: [{ id: "q", question: "Q?", type: "text" }],
      });
      check("kept while waiting on a question", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions(Date.now() + 31 * 60_000).length === 0);
      const holdQId = hub2.listPendingQuestions().find((q) => q.groupId === plainTask.groupId)?.questionId ?? "";
      await post2("/api/questions/resolve", { questionId: holdQId, answers: { q: "ok" } });
      await holdQ;
      check("released after the idle time", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions(Date.now() + 31 * 60_000).includes(leadKey));

      await post2("/api/settings", { idleLeadMinutes: 0 });
      const plainTask2 = (await post2("/api/groups", { title: "plain-mem", leadAgent: "mock-a", cwd })).group;
      await post2("/api/chat", { groupId: plainTask2.groupId, prompt: "hello mem" });
      const leadKey2 = `mock-a:${plainTask2.groupId}__lead`;
      await until(() => (hub2 as any).listVisibleSessions().find((s: Json) => s.sessionKey === leadKey2)?.status === "idle");
      (hub2 as any).memory.sampler = async () => ({ availableMB: 3000, totalMB: 57000 });
      await (hub2 as any).memory.sample();
      check("under memory pressure kept under 10 minutes", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions(Date.now() + 5 * 60_000).length === 0);
      check("under memory pressure released after 10 minutes", typeof (hub2 as any).sweepIdleLeadSessions === "function" && (hub2 as any).sweepIdleLeadSessions(Date.now() + 11 * 60_000).includes(leadKey2));
    } finally {
      await hub2.stop();
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

import "./isolate-data.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHubServer } from "../src/hub/server.js";
import { boardStatus, nextActiveGroupId, visibleTaskGroups } from "../src/ui/task-view.js";
import { buildClassicModel } from "../src/ui/board-classic-model.js";

const state: any = { taskGroups: new Map(), sessions: new Map(), messagesByStream: new Map(), workflows: new Map() };
state.taskGroups.set("grp-default", { groupId: "grp-default", defaultTitleNumber: 1 });
assert.equal(visibleTaskGroups(state).length, 0, "unused initial group is not a task");
state.taskGroups.set("old", { groupId: "old", archived: true });
assert.equal(nextActiveGroupId(state), "", "all archived has no implicit active selection");
state.taskGroups.set("new", { groupId: "new" });
assert.equal(nextActiveGroupId(state), "new", "archived task never becomes fallback");
state.messagesByStream.set("lead:grp-default", [{ groupId: "grp-default" }]);
assert.equal(visibleTaskGroups(state).length, 3, "a used default group stays visible");
const cards: any[] = ["queued", "running", "delivered", "failed", "done"].map((status) => ({ groupId: status, board: { status }, waiting: false }));
cards.push({ groupId: "waiting", board: { status: "running" }, waiting: true });
const scene = buildClassicModel(cards);
assert.deepEqual([scene.groups.queued.length, scene.groups.running.length, scene.groups.attention.length, scene.done.length], [1, 1, 3, 1]);
for (const card of cards) assert.equal(boardStatus(card, cards), card.groupId, "workbench agrees with board status");
assert.equal(boardStatus({ groupId: "running", board: { status: "running", interrupted: true } }, cards), "running", "server card overrides stale group flags");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rtm-release-test-"));
const hub = new AgentHubServer({ baseCwd: cwd, port: 0, writeRuntimeFile: false, defaultLead: "mock-a" });
(hub as any).memory.sampler = async () => ({ availableMB: 9000, totalMB: 16000 });
try {
  const url = await hub.start(0);
  const post = async (route: string, body: object): Promise<any> => {
    const response = await fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as any;
    assert.equal(response.ok && result.ok !== false, true, `${route}: ${result.error || response.status}`);
    return result;
  };
  await post("/api/agents/save", { id: "mock-a", label: "Mock", enabled: true, command: process.execPath,
    args: [path.resolve("scripts/mock-agent.mjs")], env: { MOCK_STATE_DIR: cwd, MOCK_SLOW_MS: "3600000" } });
  const result = await post("/api/board/publish", { items: [{ brief: "SLOW release archive regression", cwd, leadAgent: "mock-a" }] });
  const id = result.groups[0].groupId;
  for (let i = 0; i < 100 && !(hub as any).pool.getSession(`mock-a:${id}__lead`); i++) await new Promise((r) => setTimeout(r, 50));
  const question = hub.askUserQuestion({ groupId: id, sessionKey: `mock-a:${id}__lead`, title: "Archive me", questions: [{ id: "q", question: "Continue?", type: "text" }] });
  await post("/api/groups/update", { groupId: id, archived: true });
  assert.equal((await question).cancelled, true, "archive resolves pending questions");
  assert.equal(hub.listBoardCards().some((c) => c.groupId === id), false, "archive disappears from every board");
  assert.equal(hub.getGroup(id)?.board?.interrupted, true, "archiving running work marks it interrupted");
  await post("/api/groups/update", { groupId: id, archived: false });
  const restored = hub.listBoardCards().find((c) => c.groupId === id);
  assert.equal(restored?.waitingReason, "interrupted", "restore waits for explicit resume, not phantom running");
  assert.equal(restored?.waiting, true);
  const exported = await (await fetch(`${url}/api/groups/export?groupId=${encodeURIComponent(id)}&format=json`)).json() as any;
  assert.ok(exported.markdown?.includes("release archive regression"), "restored task retains its history / brief");
  await post("/api/board/action", { groupId: id, action: "resume" });
  assert.equal(hub.getGroup(id)?.board?.interrupted, undefined, "resume clears interruption");
  await post("/api/groups/update", { groupId: id, archived: true });
  console.log("PASS release: selection, cross-skin state, archive / restore / resume and export");
} finally { await hub.stop(); }

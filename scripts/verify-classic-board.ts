// Classic skin board view model: grouping, counting, preview slots and module counts.
// Pure functions from src/ui/board-classic-model.js; no hub or browser needed.

import {
  attentionReason,
  buildClassicModel,
  categoryIndex,
  classicCategory,
  summarizeAgents,
  summarizeMcp,
  summarizeResources,
  updateFeatured,
  waitingReasonOf,
} from "../src/ui/board-classic-model.js";

type Json = Record<string, any>;
let failed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failed += 1;
}

let at = 0;
const card = (id: string, status: string, extra: Json = {}, board: Json = {}): Json => ({
  groupId: id, title: id, cwd: extra.cwd ?? "D:/a", leadAgent: "codex", waiting: false,
  board: { status, brief: id, queuedAt: board.queuedAt ?? ++at, rejectCount: 0, ...board }, ...extra,
});

console.log("=== Classification ===");
const mixed = [
  card("q1", "queued"), card("q2", "queued"),
  card("r1", "running"),
  card("w-perm", "running", { waiting: true, waitingReason: "permission" }),
  card("w-q", "running", { waiting: true, waitingReason: "question" }),
  card("w-int", "running", { waiting: true, waitingReason: "interrupted" }, { interrupted: true }),
  card("w-stall", "running", { waiting: true }, { stalled: true }),
  card("d1", "delivered"),
  card("f1", "failed", {}, { failReason: "Cancelled by user" }),
  card("done1", "done"),
];
const m = buildClassicModel(mixed);
check("queued bank", m.groups.queued.map((c: Json) => c.groupId).join() === "q1,q2");
check("running bank excludes waiting tasks", m.groups.running.map((c: Json) => c.groupId).join() === "r1");
check("needs-you bank holds waiting, delivered and failed",
  m.groups.attention.map((c: Json) => c.groupId).sort().join() === ["d1", "f1", "w-int", "w-perm", "w-q", "w-stall"].sort().join());
check("done stays off the three banks", m.done.length === 1 && m.done[0].groupId === "done1");
check("active total equals the three LCD readings", m.active === m.groups.queued.length + m.groups.running.length + m.groups.attention.length && m.active === 9);
check("reason readings add up to the needs-you bank",
  m.reasons.decision + m.reasons.review + m.reasons.failed === m.groups.attention.length && m.reasons.decision === 4 && m.reasons.review === 1 && m.reasons.failed === 1);
check("waiting sub-reasons keep the server priority",
  waitingReasonOf(mixed[3]) === "permission" && waitingReasonOf(mixed[6]) === "stalled" &&
  waitingReasonOf(card("x", "running", { waiting: true }, { interrupted: true, stalled: true })) === "interrupted");
check("a task with several blocking flags counts once",
  buildClassicModel([card("multi", "running", { waiting: true, waitingReason: "permission" }, { interrupted: true, stalled: true })]).reasons.decision === 1);
check("status mapping", classicCategory(card("a", "running", { waiting: true })) === "attention" && attentionReason(card("a", "running")) === null);
check("unknown statuses are ignored", buildClassicModel([card("z", "archived")]).active === 0);
check("duplicated cards count once", buildClassicModel([card("dup", "queued"), card("dup", "queued")]).active === 1);
const ordered = buildClassicModel([card("late", "queued", {}, { queuedAt: 50 }), card("early", "queued", {}, { queuedAt: 10 })]);
check("queue keeps queuedAt order", ordered.groups.queued.map((c: Json) => c.groupId).join() === "early,late");
const scoped = buildClassicModel([card("a", "queued", { cwd: "D:/A" }), card("b", "queued", { cwd: "D:/B" })], { project: "d:/b", projectKey: (v: string) => v.toLowerCase() });
check("project filter applies to every count", scoped.active === 1 && scoped.groups.queued[0].groupId === "b");

console.log("=== Preview slots ===");
const many = (n: number, status = "queued") => Array.from({ length: n }, (_, i) => card(`${status}-${i}`, status));
for (const n of [0, 1, 2, 3, 100]) {
  const model = buildClassicModel(many(n));
  const slots = updateFeatured(undefined, model.groups);
  const hidden = model.groups.queued.length - slots.queued.length;
  check(`${n} queued: at most two previews, +N is the rest`, slots.queued.length === Math.min(2, n) && hidden === Math.max(0, n - 2));
}
const base = buildClassicModel(many(5));
let slots = updateFeatured(undefined, base.groups);
check("first previews follow queue order", slots.queued.join() === "queued-0,queued-1");
const updated = buildClassicModel(many(5).reverse());
check("updates within a group keep slots", updateFeatured(slots, updated.groups).queued.join() === slots.queued.join());
const departed = buildClassicModel(many(5).filter((c) => c.groupId !== "queued-0"));
slots = updateFeatured(slots, departed.groups);
check("a departing task frees its slot for the next one", slots.queued.join() === "queued-1,queued-2");
const arrived = updateFeatured(slots, departed.groups, new Map([["queued", ["queued-4"]]]));
check("a fresh arrival replaces the last slot only", arrived.queued.join() === "queued-1,queued-4");
check("arrivals do not change queue order", departed.groups.queued.map((c: Json) => c.groupId).join() === "queued-1,queued-2,queued-3,queued-4");
check("unknown arrivals are ignored", updateFeatured(slots, departed.groups, new Map([["queued", ["nope"]]])).queued.join() === "queued-1,queued-2");
const idx = categoryIndex(m);
check("category index covers every card", idx.get("q1") === "queued" && idx.get("w-q") === "attention" && idx.get("done1") === "done");

console.log("=== Module counts ===");
const agents = summarizeAgents([
  { agent: "codex", enabled: true, available: true, authReady: true },
  { agent: "codex", enabled: true, available: true, authReady: true },
  { agent: "claude", enabled: true, available: true, authReady: false },
  { agent: "kimi", enabled: false, available: false, authReady: false },
]);
check("agents count enabled configurations by id", agents.included.length === 2 && agents.excluded.length === 1 && agents.excluded[0].reasons[0] === "disabled");
const resources = [
  { id: "s1", kind: "skill", enabled: true }, { id: "s1", kind: "skill", enabled: true },
  { id: "s2", kind: "skill", enabled: false }, { id: "r1", kind: "rule", enabled: true },
  { id: "r2", kind: "rule", enabled: true }, { id: "r3", kind: "rule", enabled: false },
];
const skills = summarizeResources(resources, "skill");
const rules = summarizeResources(resources, "rule");
check("shared resources are enabled skills by id", skills.included.length === 1 && skills.excluded.length === 1);
check("rules are counted separately", rules.included.length === 2 && rules.excluded.length === 1);
const mcp = summarizeMcp([
  { id: "rtm:a", enabled: true, trusted: true, missingEnv: [] },
  { id: "rtm:a", enabled: true, trusted: true, missingEnv: [] },
  { id: "rtm:b", enabled: false, trusted: true, missingEnv: [] },
  { id: "project:c", enabled: true, trusted: false, missingEnv: [] },
  { id: "codex:d", enabled: true, trusted: true, missingEnv: ["TOKEN"] },
  { id: "project:e", enabled: false, trusted: false, missingEnv: ["X"] },
]);
check("MCP counts enabled, trusted, complete servers", mcp.included.length === 1 && mcp.included[0].id === "rtm:a");
check("MCP exclusions name every reason",
  mcp.excluded.length === 4 && mcp.excluded.find((e: Json) => e.item.id === "project:e")?.reasons.join() === "disabled,untrusted,missingEnv");
check("empty lists are a real zero", summarizeMcp([]).included.length === 0 && summarizeResources([], "rule").included.length === 0);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nClassic board model verification passed completely.");
process.exit(failed ? 1 : 0);

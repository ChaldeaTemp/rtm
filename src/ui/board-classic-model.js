// Classic board view model. Pure functions only: no DOM, no fetch, so scripts can test them.
// The backend status machine is untouched; the three scene groups are a front-end mapping.

export const CLASSIC_GROUPS = ["queued", "running", "attention"];
export const ATTENTION_REASONS = ["decision", "review", "failed"];
export const PREVIEW_SLOTS = 2;

/** Same priority as board.js getWaitingReason(): the server's waitingReason wins. */
export function waitingReasonOf(card) {
  return card.waitingReason || (card.board.interrupted ? "interrupted" : card.board.stalled ? "stalled" : "question");
}

/** queued | running | attention | done | null (unknown statuses stay off the scene). */
export function classicCategory(card) {
  const status = card?.board?.status;
  if (status === "queued") return "queued";
  if (status === "running") return card.waiting ? "attention" : "running";
  if (status === "delivered" || status === "failed") return "attention";
  if (status === "done") return "done";
  return null;
}

/** decision | review | failed for tasks that need the user, otherwise null. One reason per task. */
export function attentionReason(card) {
  const status = card?.board?.status;
  if (status === "running" && card.waiting) return "decision";
  if (status === "delivered") return "review";
  if (status === "failed") return "failed";
  return null;
}

/**
 * One derived model for the queue banks, the LCD, the reason readouts and the list dialogs.
 * `cards` are HUB_APP.getState().boardCards (server order is queuedAt ascending).
 */
export function buildClassicModel(cards, { project = "", projectKey = (v) => v } = {}) {
  const groups = { queued: [], running: [], attention: [] };
  const done = [];
  const reasons = { decision: 0, review: 0, failed: 0 };
  const seen = new Set();
  const list = Array.isArray(cards) ? cards : [];
  for (const card of list) {
    if (!card?.groupId || !card.board || seen.has(card.groupId)) continue;
    if (project && projectKey(card.cwd) !== project) continue;
    seen.add(card.groupId);
    const category = classicCategory(card);
    if (category === "done") done.push(card);
    else if (category) groups[category].push(card);
    const reason = attentionReason(card);
    if (reason) reasons[reason]++;
  }
  groups.queued.sort((a, b) => (a.board.queuedAt || 0) - (b.board.queuedAt || 0));
  const active = groups.queued.length + groups.running.length + groups.attention.length;
  return { groups, done, reasons, active };
}

/**
 * Keeps each group's preview slots stable: a task keeps its slot while it stays in the group,
 * free slots are filled in group order, and `arrivals` (tasks that just entered a group, or
 * were just published) replace the last slot so the scene shows them without moving slot 0.
 */
export function updateFeatured(previous, groups, arrivals = new Map()) {
  const next = {};
  for (const key of CLASSIC_GROUPS) {
    const ids = groups[key].map((card) => card.groupId);
    const present = new Set(ids);
    const slots = (previous?.[key] || []).filter((id) => present.has(id)).slice(0, PREVIEW_SLOTS);
    for (const id of arrivals.get(key) || []) {
      if (!present.has(id) || slots.includes(id)) continue;
      if (slots.length < PREVIEW_SLOTS) slots.push(id);
      else slots[PREVIEW_SLOTS - 1] = id;
    }
    for (const id of ids) {
      if (slots.length >= PREVIEW_SLOTS) break;
      if (!slots.includes(id)) slots.push(id);
    }
    next[key] = slots;
  }
  return next;
}

/** groupId → category for detecting real cross-category transitions between snapshots. */
export function categoryIndex(model) {
  const index = new Map();
  for (const key of CLASSIC_GROUPS) for (const card of model.groups[key]) index.set(card.groupId, key);
  for (const card of model.done) index.set(card.groupId, "done");
  return index;
}

// ---- Configuration modules -------------------------------------------------------------

function uniqueBy(list, key) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = key(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Enabled agent configurations by id. Not sessions, models, running tasks or live processes. */
export function summarizeAgents(agents) {
  const all = uniqueBy(agents, (a) => a?.agent || a?.id);
  return {
    included: all.filter((a) => a.enabled !== false),
    excluded: all.filter((a) => a.enabled === false).map((item) => ({ item, reasons: ["disabled"] })),
  };
}

/** Enabled resources of one kind ("skill" for shared resources, "rule" for rules), by id. */
export function summarizeResources(resources, kind) {
  const all = uniqueBy(resources, (r) => r?.id).filter((r) => r.kind === kind);
  return {
    included: all.filter((r) => r.enabled),
    excluded: all.filter((r) => !r.enabled).map((item) => ({ item, reasons: ["disabled"] })),
  };
}

/** Shareable MCP servers: enabled, trusted and with every referenced variable set. */
export function summarizeMcp(servers) {
  const all = uniqueBy(servers, (s) => s?.id);
  const included = [];
  const excluded = [];
  for (const server of all) {
    const reasons = [];
    if (!server.enabled) reasons.push("disabled");
    if (!server.trusted) reasons.push("untrusted");
    if (Array.isArray(server.missingEnv) && server.missingEnv.length) reasons.push("missingEnv");
    if (reasons.length) excluded.push({ item: server, reasons });
    else included.push(server);
  }
  return { included, excluded };
}

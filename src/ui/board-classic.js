// Classic skin task board: an isometric register scene over the real board cards.
// Business state, actions and the task detail dialog stay in board.js; this module only maps
// cards to three banks, draws the scene, animates presentation and fills classic panels.

import { getLocale, t, th } from "./i18n.js";
import {
  ATTENTION_REASONS,
  CLASSIC_GROUPS,
  PREVIEW_SLOTS,
  attentionReason,
  buildClassicModel,
  categoryIndex,
  summarizeAgents,
  summarizeMcp,
  summarizeResources,
  updateFeatured,
} from "./board-classic-model.js";

const NS = "http://www.w3.org/2000/svg";
// Scene drawn in 1380×720 units; the visible window is the viewBox below. Every shape, hit
// area and animation uses these same units.
const VIEWBOX = "100 85 1170 620";

// A shallow oblique projection: u runs right (barely descending), v comes toward the viewer
// (down and slightly left), z is up. Text is never projected; it is drawn upright at the
// centre of the face it labels, so the scene stays readable.
const PROJ = { b: 0.42, c: 0.18, d: 0.55 };
const point = (x, y, u, v, z = 0) => [x + u - PROJ.b * v, y + PROJ.c * u + PROJ.d * v - z];
const round = (p) => p.map((n) => Math.round(n * 10) / 10);

// Agent CPU: a substrate with a raised chip. Ports sit on the substrate's top edges.
const CPU = { x: 623, y: 290, w: 146, d: 124 };
const CHIP = point(CPU.x, CPU.y, 22, 18, 10);
const CPU_PORTS = {
  queued: round(point(CPU.x, CPU.y, 0, 70, 10)),
  running: round(point(CPU.x, CPU.y, CPU.w, 40, 10)),
  attention: round(point(CPU.x, CPU.y, CPU.w, 100, 10)),
};
const CPU_OUT = [round(point(CHIP[0], CHIP[1], 51, 41, 22)), round(point(CPU.x, CPU.y, 73, 62, 10))];

// Banks: a base of 230×82 with three sockets. Each trace runs from its CPU port along a
// horizontal, a vertical at `busX`, and a horizontal into the bank's side port.
const BANKS = {
  queued: { index: 0, x: 190, y: 330, side: "right", busX: 500 },
  running: { index: 1, x: 930, y: 190, side: "left", busX: 830 },
  attention: { index: 2, x: 950, y: 480, side: "left", busX: 850 },
};
for (const [key, bank] of Object.entries(BANKS)) {
  const from = CPU_PORTS[key];
  const to = round(point(bank.x, bank.y, bank.side === "right" ? 236 : -6, 41, 5));
  bank.route = [from, [bank.busX, from[1]], [bank.busX, to[1]], to];
}
const BASE = ["var(--bg)", "var(--bg-panel)", "var(--cb-side)"];
const RAISED = ["var(--bg-elevated)", "var(--bg-panel)", "var(--cb-side)"];
const GROUP_LABEL = { queued: "boardColQueued", running: "boardColRunning", attention: "classicAttention" };
const REASON_LABEL = { decision: "boardColDecision", review: "boardColReview", failed: "boardColFailed" };
const MODULES = {
  agents: { title: "classicAgentsTitle", note: "classicAgentsNote", tab: "agents", name: "classicCpuName" },
  resources: { title: "classicResourcesTitle", note: "classicResourcesNote", tab: "resources", name: "classicResources" },
  rules: { title: "classicRulesTitle", note: "classicRulesNote", tab: "resources", name: "classicRules" },
  mcp: { title: "classicMcpTitle", note: "classicMcpNote", tab: "mcp", name: "classicMcpTitle" },
};

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const pts = (list) => list.map((p) => p.join(",")).join(" ");
const pathD = (list) => "M " + list.map((p) => p.join(" ")).join(" L ");
const pad2 = (n) => String(n).padStart(2, "0");
const slotPos = (bank, i) => point(bank.x, bank.y, 19 + i * 75, 16, 10);
const landing = (bank, i) => slotPos(bank, i).map((v, j) => v + (j === 0 ? 4 : 3));

function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) if (attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
  parent?.append(node);
  return node;
}

function txt(x, y, text, attrs, parent) {
  const node = el("text", { x, y, ...attrs }, parent);
  node.textContent = text;
  return node;
}

function box(parent, x, y, w, depth, h, colors, capClass = "") {
  const p = (u, v, z = 0) => point(x, y, u, v, z);
  const a = p(0, 0, h), b = p(w, 0, h), c = p(w, depth, h), f = p(0, depth, h);
  el("polygon", { points: pts([p(3, 5), p(w + 9, 5), p(w + 9, depth + 8), p(3, depth + 8)]), class: "cb-shadow" }, parent);
  el("polygon", { points: pts([f, c, p(w, depth), p(0, depth)]), fill: colors[1], class: "cb-edge" }, parent);
  el("polygon", { points: pts([b, c, p(w, depth), p(w, 0)]), fill: colors[2], class: "cb-edge" }, parent);
  el("polygon", { points: pts([a, b, c, f]), fill: colors[0], class: `cb-edge ${capClass}`.trim() }, parent);
}

// Decorations painted onto a top face (marks, insets) follow the projection.
const topFace = (parent, x, y) => el("g", { transform: `matrix(1 ${PROJ.c} ${-PROJ.b} ${PROJ.d} ${x} ${y})` }, parent);

// Upright text centred on a screen point.
function faceText(parent, [x, y], text, cls, dy = 0) {
  return txt(Math.round(x * 10) / 10, Math.round((y + dy) * 10) / 10, text, { "text-anchor": "middle", "dominant-baseline": "central", class: cls }, parent);
}

function shortId(card) {
  return String(card.groupId || "").replace(/^grp-/, "").slice(0, 4);
}

export function createClassicBoard(api) {
  let root = null;
  const dom = {};
  let active = false;
  let model = buildClassicModel([]);
  let featured = { queued: [], running: [], attention: [] };
  let prevIndex = null;
  let prevFeatured = null;
  let lastSignature = "";
  let selected = "";
  let selectedByUser = false;
  let projectOptions = "";
  let introDone = false;
  let intro = null;
  let wasVisible = false;
  const flying = new Map();
  const pendingPins = new Set();
  let pendingFocusId = "";
  let closing = null;
  let tooltipFor = null;

  const config = { scope: "", seq: 0, controller: null, entries: new Map() };

  // ---- Mount / lifecycle ---------------------------------------------------------------

  function mount() {
    if (root?.isConnected) return;
    root = document.createElement("div");
    root.className = "cb-root";
    root.hidden = true;
    root.innerHTML = `
      <div class="cb-toolbar">
        <div class="cb-context">
          <label class="cb-label" for="cbProject"></label>
          <select id="cbProject" class="cb-project"></select>
          <span class="cb-divider"></span>
          <span class="cb-label" data-cb="tasksLabel"></span>
          <span class="cb-mono" data-cb="activeCount"></span>
        </div>
        <div class="cb-actions">
          <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-cb="replay"></button>
        </div>
      </div>
      <div class="cb-stage alma-box">
        <span class="alma-box-label" data-cb="stageLabel"></span><span class="alma-box-corner-tl">┌</span><span class="alma-box-corner-tr">┐</span><span class="alma-box-corner-bl">└</span><span class="alma-box-corner-br">┘</span>
        <div class="cb-annotation" data-cb="annotation"></div>
        <svg class="cb-scene" viewBox="${VIEWBOX}" role="group" preserveAspectRatio="xMidYMid meet">
          <defs><pattern id="cbGrid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" class="cb-grid-dot" /></pattern></defs>
          <rect x="25" y="25" width="1330" height="675" fill="url(#cbGrid)" />
          <g class="cb-traces"></g><g class="cb-modules"></g><g class="cb-flight" aria-hidden="true"></g>
        </svg>
      </div>
      <footer class="cb-footer">
        <span><i class="cb-dot"></i><span data-cb="footPreview"></span></span>
        <span data-cb="footStack"></span>
        <span class="cb-status" role="status" data-cb="status"></span>
        <span class="cb-footnote" data-cb="footScope"></span>
      </footer>
      <div class="cb-tooltip" hidden></div>`;
    const anchor = api.screen.querySelector(".board-main");
    anchor.before(root);
    for (const node of root.querySelectorAll("[data-cb]")) dom[node.dataset.cb] = node;
    dom.project = root.querySelector("#cbProject");
    dom.projectLabel = root.querySelector('label[for="cbProject"]');
    dom.svg = root.querySelector(".cb-scene");
    dom.traces = root.querySelector(".cb-traces");
    dom.modules = root.querySelector(".cb-modules");
    dom.flight = root.querySelector(".cb-flight");
    dom.stage = root.querySelector(".cb-stage");
    dom.tooltip = root.querySelector(".cb-tooltip");

    dom.project.addEventListener("change", () => {
      api.setProject(dom.project.value);
      api.renderBody();
    });
    dom.replay.addEventListener("click", () => {
      if (intro) skipIntro();
      else void playIntro();
    });
    // Any interaction with the scene ends the intro so the page is never held hostage.
    dom.stage.addEventListener("pointerdown", () => intro && skipIntro());
    dom.stage.addEventListener("keydown", () => intro && skipIntro());
  }

  function deactivate() {
    if (!active) return;
    active = false;
    cancelAnimations();
    prevIndex = null;
    lastSignature = "";
    hideTip();
    config.controller?.abort();
    config.controller = null;
    config.seq++;
    config.scope = "";
    if (root) root.hidden = true;
  }

  function cancelAnimations() {
    if (intro) {
      for (const anim of intro.anims) anim.cancel();
      intro = null;
    }
    for (const flight of flying.values()) flight.anim?.cancel();
    flying.clear();
    dom.flight?.replaceChildren();
    updateReplayButton();
  }

  // ---- Render ----------------------------------------------------------------------------

  function render() {
    mount();
    const state = api.getState();
    const visible = !api.screen.hidden;
    if (!visible) {
      deactivate();
      return;
    }
    const becameVisible = !active || !wasVisible;
    active = true;
    wasVisible = true;
    root.hidden = false;

    const loaded = state.boardLoaded === true;
    model = buildClassicModel(api.getCards(), { project: api.getProject(), projectKey: api.projectKey });
    const index = categoryIndex(model);
    const arrivals = new Map(CLASSIC_GROUPS.map((key) => [key, []]));
    const moves = [];
    if (prevIndex && loaded) {
      for (const [id, to] of index) {
        const from = prevIndex.get(id);
        if (!from || from === to || !CLASSIC_GROUPS.includes(to)) continue;
        arrivals.get(to).push(id);
        if (CLASSIC_GROUPS.includes(from)) moves.push({ id, from, to });
      }
    }
    for (const id of pendingPins) {
      const key = index.get(id);
      if (!key) continue;
      pendingPins.delete(id);
      if (CLASSIC_GROUPS.includes(key) && !arrivals.get(key).includes(id)) arrivals.get(key).push(id);
    }
    prevFeatured = featured;
    featured = updateFeatured(featured, model.groups, arrivals);
    if (loaded) prevIndex = index;

    if (!selectedByUser || !CLASSIC_GROUPS.includes(selected)) selected = defaultSelected();

    renderToolbar(state, loaded);
    if (becameVisible || currentScope() !== config.scope) ensureConfig(becameVisible);

    const signature = sceneSignature(state, loaded);
    if (signature !== lastSignature) {
      lastSignature = signature;
      drawScene(state, loaded);
    }
    applySelection();
    if (pendingFocusId) focusPublished();

    if (!loaded) setStatus(t("classicStatusWaiting"));
    else if (!introDone) {
      introDone = true;
      void playIntro();
    } else if (moves.length && !intro) startMoves(moves);
  }

  function defaultSelected() {
    if (model.groups.attention.length) return "attention";
    if (model.groups.running.length) return "running";
    return "queued";
  }

  function renderToolbar(state, loaded) {
    const cards = api.getCards();
    const paths = new Map();
    for (const project of state.projects || []) if (project?.path) paths.set(api.projectKey(project.path), project.path);
    for (const card of cards) if (card.cwd) paths.set(api.projectKey(card.cwd), card.cwd);
    const current = api.getProject();
    if (current && !paths.has(current)) paths.set(current, current);
    const choices = [...paths].sort(([, a], [, b]) => api.getProjectLabel(a).localeCompare(api.getProjectLabel(b)) || a.localeCompare(b));
    const options = `<option value="">${th("boardAllProjects")}</option>` +
      choices.map(([key, cwd]) => `<option value="${api.escapeHtml(key)}" title="${api.escapeHtml(cwd)}">${api.escapeHtml(api.getProjectLabel(cwd))}</option>`).join("");
    if (options !== projectOptions) {
      dom.project.innerHTML = options;
      projectOptions = options;
    }
    dom.project.value = current;
    dom.projectLabel.textContent = t("workingDirectory");
    dom.project.title = currentScope();
    dom.tasksLabel.textContent = t("classicActiveTasks");
    dom.activeCount.textContent = loaded ? String(model.active) : "—";
    dom.stageLabel.textContent = t("classicRegister");
    dom.annotation.textContent = t("classicAnnotation", PREVIEW_SLOTS);
    dom.svg.setAttribute("aria-label", t("classicSceneLabel"));
    const shown = CLASSIC_GROUPS.reduce((sum, key) => sum + featured[key].length, 0);
    dom.footPreview.textContent = t("classicFooterPreview", shown);
    dom.footStack.textContent = t("classicFooterStack");
    dom.footScope.textContent = t("classicFooterScope", loaded ? model.active : "—", currentScope() || "—");
    dom.footScope.title = currentScope();
    updateReplayButton();
  }

  function updateReplayButton() {
    if (!dom.replay) return;
    dom.replay.textContent = t(intro ? "classicSkip" : "classicReplay");
    dom.replay.disabled = !intro && (!api.getState().boardLoaded || reducedMotion());
  }

  function setStatus(text) {
    if (dom.status && dom.status.textContent !== text) dom.status.textContent = text;
  }

  function cardById(id) {
    for (const key of CLASSIC_GROUPS) {
      const found = model.groups[key].find((card) => card.groupId === id);
      if (found) return found;
    }
    return model.done.find((card) => card.groupId === id) || null;
  }

  function sceneSignature(state, loaded) {
    const counts = moduleCounts(state);
    const parts = [getLocale(), loaded, model.active, model.done.length, ATTENTION_REASONS.map((r) => model.reasons[r]).join()];
    for (const key of CLASSIC_GROUPS) {
      parts.push(key, model.groups[key].length);
      for (const id of featured[key]) {
        const card = cardById(id);
        parts.push(id, api.getCardTitle(card), card.board.status, card.waiting ? card.waitingReason || "w" : "");
      }
    }
    for (const key of Object.keys(MODULES)) parts.push(counts[key].text, counts[key].state);
    return JSON.stringify(parts);
  }

  // ---- Scene drawing ---------------------------------------------------------------------

  function interactive(g, sceneKey, label, fn) {
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", label);
    g.setAttribute("aria-haspopup", "dialog");
    g.dataset.sceneKey = sceneKey;
    const run = () => {
      if (intro) skipIntro();
      fn(g);
    };
    g.addEventListener("click", run);
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        run();
      }
    });
  }

  function drawScene(state, loaded) {
    const focusKey = dom.svg.contains(document.activeElement) ? document.activeElement.closest("[data-scene-key]")?.dataset.sceneKey : "";
    hideTip();
    dom.traces.replaceChildren();
    dom.modules.replaceChildren();
    for (const [key, bank] of Object.entries(BANKS)) {
      el("path", { d: pathD(bank.route), class: "cb-trace", "data-key": key }, dom.traces);
      const end = bank.route.at(-1);
      el("circle", { cx: end[0], cy: end[1], r: 4, class: "cb-port", "data-key": key }, dom.traces);
    }
    const counts = moduleCounts(state);
    drawIntake();
    drawCore(counts.agents);
    drawMonitor(loaded);
    drawCollaborators(counts);
    txt(670, 414, t("classicCpuName"), { "text-anchor": "middle", class: "cb-label-lg" }, dom.modules);
    txt(670, 437, "", { "text-anchor": "middle", class: "cb-selected", "data-cb-selected": "" }, dom.modules);
    for (const key of CLASSIC_GROUPS) drawBank(key, loaded);
    if (focusKey) dom.svg.querySelector(`[data-scene-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  function drawIntake() {
    const g = el("g", { class: "cb-object" }, dom.modules);
    const [x, y] = [250, 150];
    box(g, x, y, 86, 64, 16, RAISED, "cb-cap");
    el("path", { d: "M 28 32 H 58 M 43 17 V 47", class: "cb-plus" }, topFace(g, x, y - 16));
    txt(280, 230, t("classicIntake"), { "text-anchor": "middle", class: "cb-label-lg" }, g);
    txt(280, 251, t("classicNewTask"), { "text-anchor": "middle", class: "cb-label-sm" }, g);
    el("path", { d: "M 223 185 L 205 195 V 322", class: "cb-trace" }, dom.traces);
    interactive(g, "intake", t("classicIntakeLabel"), (node) => openPanel({ type: "publish" }, node, "intake"));
  }

  function drawCore(count) {
    const core = el("g", { class: "cb-object" }, dom.modules);
    box(core, CPU.x, CPU.y, CPU.w, CPU.d, 10, BASE);
    const [cx, cy] = CHIP;
    // Pins lie on the substrate; the raised chip sits above them.
    for (let i = 0; i < 6; i++) {
      const u = 13 + i * 15, v = 10 + i * 12;
      for (const pair of [[[-10, v], [0, v]], [[102, v], [112, v]], [[u, -10], [u, 0]], [[u, 82], [u, 92]]]) {
        el("path", { d: pathD(pair.map(([x, y]) => point(cx, cy, x, y))), class: "cb-pin" }, core);
      }
    }
    box(core, cx, cy, 102, 82, 22, RAISED, "cb-cap");
    el("rect", { x: 6, y: 6, width: 90, height: 70, class: "cb-inset" }, topFace(core, cx, cy - 22));
    const centre = point(cx, cy, 51, 41, 22);
    faceText(core, centre, "AGENT CPU", "cb-chip-caption", -19);
    faceText(core, centre, count.text, "cb-chip-count", 1);
    faceText(core, centre, t("classicCpuCaption"), "cb-chip-sub", 21);
    for (const [key, [x, y]] of Object.entries(CPU_PORTS)) {
      el("circle", { cx: x, cy: y, r: 4, class: "cb-port", "data-key": key }, core);
    }
    interactive(core, "module:agents", moduleLabel("agents", count), (node) => openModule("agents", node));
  }

  function lcdNumber(parent, x, y, value) {
    const digits = ["abcedf", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgecd", "abc", "abcdefg", "abfgcd"];
    const segments = { a: [4, 2, 18, 2], b: [20, 5, 20, 17], c: [20, 23, 20, 35], d: [4, 38, 18, 38], e: [2, 23, 2, 35], f: [2, 5, 2, 17], g: [4, 20, 18, 20] };
    const text = value === null ? "--" : pad2(value);
    // Three or more digits shrink to keep the cell width.
    const scale = text.length > 2 ? 2 / text.length : 1;
    const display = el("g", { transform: `translate(${x} ${y}) scale(${scale})`, "aria-hidden": "true" }, parent);
    [...text].forEach((ch, i) => {
      for (const [key, [x1, y1, x2, y2]] of Object.entries(segments)) {
        const on = ch === "-" ? key === "g" : digits[Number(ch)].includes(key);
        el("line", { x1: x1 + i * 28, y1, x2: x2 + i * 28, y2, class: on ? "cb-seg is-on" : "cb-seg" }, display);
      }
    });
  }

  function drawMonitor(loaded) {
    const panel = el("g", { role: "group", "aria-label": "TASK MONITOR" }, dom.modules);
    el("path", { d: "M 427 108 H 851 V 219 H 427 Z", class: "cb-plate-back" }, panel);
    el("rect", { x: 420, y: 100, width: 424, height: 112, class: "cb-plate" }, panel);
    el("rect", { x: 430, y: 123, width: 404, height: 79, class: "cb-lcd" }, panel);
    txt(434, 115, "TASK MONITOR", { class: "cb-small" }, panel);
    txt(830, 115, t("classicMonitorTotal", loaded ? model.active : "--"), { "text-anchor": "end", class: "cb-small" }, panel);
    // Three active banks, then the finished count behind a divider; done tasks are not active.
    const cells = [
      ...CLASSIC_GROUPS.map((key) => ({ key, caption: t(GROUP_LABEL[key]), count: model.groups[key].length, open: (node) => openGroup(key, node, "", `lcd:${key}`) })),
      { key: "done", caption: t("classicDone"), count: model.done.length, open: (node) => openPanel({ type: "finished", query: "" }, node, "lcd:done") },
    ];
    cells.forEach(({ key, caption, count, open }, i) => {
      const g = el("g", { class: `cb-object cb-lcd-readout${key === "done" ? " is-done" : ""}`, "data-key": key }, panel);
      const x = 437 + i * 100;
      el("rect", { x, y: 129, width: 92, height: 68, class: "cb-lcd-cell" }, g);
      txt(x + 9, 141, caption, { class: "cb-lcd-caption" }, g);
      lcdNumber(g, x + 16, 150, loaded ? count : null);
      interactive(g, `lcd:${key}`, t("classicLcdLabel", caption, loaded ? count : "—"), open);
    });
    el("path", { d: "M 733 131 V 195", class: "cb-lcd-divider" }, panel);
    el("path", { d: "M 632 219 V 281", class: "cb-trace is-faint" }, dom.traces);

    const reasons = el("g", { role: "group", "aria-label": t("classicReasonsTitle") }, dom.modules);
    el("rect", { x: 190, y: 546, width: 286, height: 102, class: "cb-plate-back" }, reasons);
    el("rect", { x: 184, y: 540, width: 286, height: 102, class: "cb-plate" }, reasons);
    txt(198, 560, t("classicReasonsTitle"), { class: "cb-small" }, reasons);
    ATTENTION_REASONS.forEach((reason, i) => {
      const g = el("g", { class: "cb-object cb-reason", "data-reason": reason }, reasons);
      const x = 198 + i * 87;
      el("rect", { x, y: 572, width: 77, height: 55, class: "cb-reason-cell" }, g);
      el("path", { d: `M ${x + 1} 573 V 626`, class: `cb-reason-mark is-${reason}` }, g);
      const count = model.reasons[reason];
      // Short captions: the cells are narrow; the dialog and aria-label use the full wording.
      txt(x + 10, 592, t({ decision: "classicCellDecision", review: "classicCellReview", failed: "classicCellFailed" }[reason]), { class: "cb-small" }, g);
      txt(x + 10, 617, loaded ? pad2(count) : "--", { class: "cb-reason-value" }, g);
      interactive(g, `reason:${reason}`, t("classicLcdLabel", t(REASON_LABEL[reason]), loaded ? count : "—"),
        (node) => openGroup("attention", node, reason, `reason:${reason}`));
    });
  }

  function drawCollaborators(counts) {
    el("path", { d: "M 575 360 L 545 385 V 490 H 835 M 575 490 V 532 M 705 490 V 532 M 835 490 V 532", class: "cb-trace is-dashed" }, dom.traces);
    for (const [key, x] of [["resources", 547], ["rules", 677], ["mcp", 807]]) {
      const y = 562;
      const g = el("g", { class: "cb-object" }, dom.modules);
      let height = 25;
      let centre = point(x, y, 38, 25, height);
      if (key === "resources") {
        // Three shallow trays form a shared resource archive.
        for (let i = 0; i < 3; i++) box(g, x, y - i * 9, 76, 50, 7, RAISED, i === 2 ? "cb-cap" : "");
      } else if (key === "rules") {
        height = 18;
        box(g, x, y, 76, 50, height, RAISED, "cb-cap");
        const face = topFace(g, x, y - height);
        el("rect", { x: 7, y: 8, width: 22, height: 34, class: "cb-doc" }, face);
        el("path", { d: "M 11 16 H 25 M 11 23 H 25 M 11 30 H 21", class: "cb-doc-lines" }, face);
        centre = point(x, y, 53, 25, height);
      } else {
        box(g, x, y, 76, 50, height, RAISED, "cb-cap");
        // Interface sockets on the front face.
        const [fx, fy] = point(x, y, 0, 50, 0);
        const front = el("g", { transform: `matrix(1 ${PROJ.c} 0 1 ${fx} ${fy})` }, g);
        for (let i = 0; i < 3; i++) el("rect", { x: 9 + i * 22, y: -19, width: 15, height: 10, class: "cb-doc" }, front);
      }
      const count = counts[key];
      faceText(g, centre, count.text, "cb-module-count");
      const caption = key === "mcp" ? "MCP" : t(MODULES[key].name);
      txt(x + 28, y + 70, caption, { "text-anchor": "middle", class: "cb-small" }, g);
      if (count.state !== "ok") {
        txt(x + 28, y + 84, t(count.state === "stale" ? "classicModuleStale" : count.state === "error" ? "classicModuleFailed" : "classicLoading"),
          { "text-anchor": "middle", class: `cb-small is-${count.state}` }, g);
      }
      interactive(g, `module:${key}`, moduleLabel(key, count), (node) => openModule(key, node));
    }
  }

  function moduleLabel(key, count) {
    const name = key === "mcp" ? "MCP" : t(MODULES[key].name);
    return count.value === null ? t("classicModuleUnknown", name) : t("classicModuleLabel", name, count.value);
  }

  function drawBank(key, loaded) {
    const bank = BANKS[key];
    const group = el("g", { "data-bank": key }, dom.modules);
    const all = model.groups[key];
    box(group, bank.x, bank.y, 230, 82, 10, BASE);
    for (let i = 0; i < 3; i++) {
      const [x, y] = slotPos(bank, i);
      const corners = [[0, 0], [58, 0], [58, 55], [0, 55]].map(([u, v]) => point(x, y, u, v));
      el("polygon", { points: pts(corners), class: "cb-socket" }, group);
      el("polyline", { points: pts([corners[3], corners[0], corners[1]]), class: "cb-socket-lip" }, group);
    }
    featured[key].forEach((id, i) => {
      const card = cardById(id);
      if (!card) return;
      const [x, y] = slotPos(bank, i);
      const reason = attentionReason(card);
      const g = el("g", { class: `cb-object cb-task${reason ? ` is-${reason}` : ""}`, "data-slot": `${key}:${i}`, "data-group-id": id }, group);
      box(g, x + 4, y + 3, 50, 46, 26, RAISED, "cb-cap");
      el("path", { d: "M 6 6 H 15 M 35 40 h 10", class: "cb-task-mark" }, topFace(g, x + 4, y + 3 - 26));
      faceText(g, point(x + 4, y + 3, 25, 23, 26), shortId(card), "cb-task-id");
      const title = `${api.getCardNumber(card)} · ${api.getCardTitle(card)}`;
      interactive(g, `task:${id}`, `${title}${reason ? ` · ${reasonText(card)}` : ""}`, (node) => openTask(card, node));
      g.addEventListener("mouseenter", () => showTip(g, title));
      g.addEventListener("mouseleave", hideTip);
      g.addEventListener("focus", () => showTip(g, title));
      g.addEventListener("blur", hideTip);
      if (isHidden(`${key}:${i}`, id)) g.style.visibility = "hidden";
    });
    const hidden = Math.max(0, all.length - featured[key].length);
    if (hidden) {
      const [x, y] = slotPos(bank, 2);
      const g = el("g", { class: "cb-object cb-stack", "data-slot": `${key}:stack` }, group);
      for (let z = 0; z < 3; z++) box(g, x + 4, y + 3 - z * 7, 50, 46, 5, RAISED, z === 2 ? "cb-cap" : "");
      faceText(g, point(x + 4, y + 3 - 14, 25, 23, 5), `+${hidden}`, "cb-stack-count");
      interactive(g, `stack:${key}`, t("classicStackLabel", t(GROUP_LABEL[key]), hidden, all.length), (node) => openGroup(key, node, "", `stack:${key}`));
      if (isHidden(`${key}:stack`)) g.style.visibility = "hidden";
    }
    const lx = bank.x + 98, ly = bank.y + 120;
    txt(lx, ly, `R${bank.index}   ${t(GROUP_LABEL[key])}`, { "text-anchor": "middle", class: "cb-label-lg" }, group);
    txt(lx, ly + 23, !loaded ? "—" : all.length ? t("classicBankCount", all.length, featured[key].length) : t("classicBankEmpty"),
      { "text-anchor": "middle", class: "cb-label-sm" }, group);
  }

  function isHidden(slot, id) {
    if (intro && !slot.startsWith("queued") && !intro.revealed.has(slot)) return true;
    return Boolean(id && flying.has(id));
  }

  function reveal(slot) {
    const node = dom.svg?.querySelector(`[data-slot="${slot}"]`);
    if (node && !(node.dataset.groupId && flying.has(node.dataset.groupId))) node.style.visibility = "";
  }

  function reasonText(card) {
    const reason = attentionReason(card);
    if (reason === "decision") return api.getWaitingBadgeInfo(card).text;
    return reason ? t(REASON_LABEL[reason]) : "";
  }

  function applySelection() {
    for (const node of dom.svg.querySelectorAll(".cb-trace[data-key], .cb-port[data-key]")) {
      node.classList.toggle("is-active", node.dataset.key === selected);
    }
    for (const node of dom.svg.querySelectorAll(".cb-lcd-readout")) {
      node.classList.toggle("is-selected", node.dataset.key === selected);
    }
    const label = dom.svg.querySelector("[data-cb-selected]");
    if (label) label.textContent = t("classicSelected", t(GROUP_LABEL[selected]));
    if (!intro && api.getState().boardLoaded) setStatus(t("classicStatusSelected", t(GROUP_LABEL[selected])));
  }

  function select(key, byUser = true) {
    if (!CLASSIC_GROUPS.includes(key)) return;
    selected = key;
    if (byUser) selectedByUser = true;
    if (dom.svg) applySelection();
  }

  function showTip(node, text) {
    if (intro || api.getOverlay()) return;
    const rect = node.getBoundingClientRect();
    dom.tooltip.textContent = text;
    dom.tooltip.hidden = false;
    dom.tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 340))}px`;
    dom.tooltip.style.top = `${rect.bottom + 10}px`;
    tooltipFor = node;
  }

  function hideTip() {
    if (dom.tooltip) dom.tooltip.hidden = true;
    tooltipFor = null;
  }

  // ---- Animation -------------------------------------------------------------------------

  function makeActor(text) {
    const actor = el("g", { class: "cb-actor" }, dom.flight);
    box(actor, 0, 0, 50, 46, 26, RAISED, "cb-cap");
    faceText(actor, point(0, 0, 25, 23, 26), text, "cb-task-id");
    return actor;
  }

  function fly(actor, points, duration) {
    const lengths = points.map((p, i) => (i ? Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0));
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    let walked = 0;
    return actor.animate(points.map((p, i) => {
      walked += lengths[i];
      return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: walked / total };
    }), { duration: reducedMotion() ? 0 : duration, easing: "linear", fill: "forwards" });
  }

  async function playIntro() {
    if (intro || !active || !api.getState().boardLoaded || reducedMotion()) {
      updateReplayButton();
      return;
    }
    const run = { revealed: new Set(), skip: false, anims: new Set() };
    intro = run;
    hideTip();
    for (const node of dom.svg.querySelectorAll('[data-slot]:not([data-slot^="queued"])')) node.style.visibility = "hidden";
    updateReplayButton();
    for (const key of ["running", "attention"]) {
      if (intro !== run) return;
      select(key, false);
      setStatus(t("classicStatusIntro", t(GROUP_LABEL[key])));
      for (let i = 0; i < PREVIEW_SLOTS; i++) {
        const card = cardById(featured[key][i]);
        if (!card) continue;
        const actor = makeActor(shortId(card));
        for (const [points, duration] of [[[...CPU_OUT, BANKS[key].route[0]], 220], [[...BANKS[key].route, landing(BANKS[key], i)], 320]]) {
          const anim = fly(actor, points, run.skip ? 0 : duration);
          run.anims.add(anim);
          try {
            await anim.finished;
          } catch {
            actor.remove();
            return;
          }
          run.anims.delete(anim);
        }
        actor.remove();
        if (intro !== run) return;
        run.revealed.add(`${key}:${i}`);
        reveal(`${key}:${i}`);
      }
      run.revealed.add(`${key}:stack`);
      reveal(`${key}:stack`);
    }
    if (intro !== run) return;
    intro = null;
    selected = selectedByUser ? selected : defaultSelected();
    applySelection();
    setStatus(t("classicStatusIntroDone", t(GROUP_LABEL[selected])));
    updateReplayButton();
  }

  function skipIntro() {
    if (!intro) return;
    intro.skip = true;
    for (const anim of [...intro.anims]) anim.finish();
  }

  function positionOf(key, id, slots) {
    const i = slots[key].indexOf(id);
    return landing(BANKS[key], i < 0 ? 2 : i);
  }

  function startMoves(moves) {
    if (reducedMotion() || moves.length > 4) {
      const last = moves.at(-1);
      if (last) setStatus(t("classicStatusMoved", api.getCardNumber(cardById(last.id) || { groupId: last.id }), t(GROUP_LABEL[last.to])));
      return;
    }
    for (const move of moves) {
      const card = cardById(move.id);
      if (!card) continue;
      const previous = flying.get(move.id);
      // A newer target replaces an older flight; start from where that one was heading.
      const start = previous ? previous.target : positionOf(move.from, move.id, prevFeatured);
      previous?.anim.cancel();
      previous?.actor.remove();
      const target = positionOf(move.to, move.id, featured);
      const actor = makeActor(shortId(card));
      const from = BANKS[move.from].route, to = BANKS[move.to].route;
      const anim = fly(actor, [start, ...from.slice().reverse(), ...CPU_OUT.slice().reverse(), ...to, target], 760);
      const flight = { anim, actor, target };
      flying.set(move.id, flight);
      const node = dom.svg.querySelector(`[data-group-id="${CSS.escape(move.id)}"]`);
      if (node) node.style.visibility = "hidden";
      select(move.to, false);
      anim.finished.then(() => {
        if (flying.get(move.id) !== flight) return;
        flying.delete(move.id);
        actor.remove();
        const landed = dom.svg.querySelector(`[data-group-id="${CSS.escape(move.id)}"]`);
        if (landed && !(intro && !intro.revealed.has(landed.dataset.slot))) landed.style.visibility = "";
        setStatus(t("classicStatusMoved", api.getCardNumber(card), t(GROUP_LABEL[move.to])));
      }, () => actor.remove());
    }
  }

  // ---- Configuration modules -------------------------------------------------------------

  function currentScope() {
    const project = api.getProject();
    if (project) {
      const state = api.getState();
      const fromCards = api.getCards().find((card) => card.cwd && api.projectKey(card.cwd) === project)?.cwd;
      const fromProjects = (state.projects || []).find((item) => item?.path && api.projectKey(item.path) === project)?.path;
      return fromCards || fromProjects || project;
    }
    return String(api.getPublishCwd() || api.getState().baseCwd || "").trim();
  }

  async function fetchJson(url, signal) {
    const res = await api.apiFetch(url, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function ensureConfig(force = false) {
    const scope = currentScope();
    if (!scope) return;
    if (!force && scope === config.scope) return;
    config.controller?.abort();
    const controller = new AbortController();
    const seq = ++config.seq;
    config.scope = scope;
    config.controller = controller;
    let entry = config.entries.get(scope);
    if (!entry) {
      entry = { resources: { status: "loading", data: null, error: "" }, mcp: { status: "loading", data: null, error: "" } };
      config.entries.set(scope, entry);
    } else {
      for (const part of [entry.resources, entry.mcp]) part.status = "loading";
    }
    const query = `?cwd=${encodeURIComponent(scope)}`;
    const load = (part, url, pick) => fetchJson(url, controller.signal).then((data) => {
      if (seq !== config.seq) return;
      Object.assign(part, { status: "ok", data: pick(data), error: "" });
    }, (err) => {
      if (seq !== config.seq) return;
      Object.assign(part, { status: "error", error: err?.message || String(err) });
    });
    void Promise.all([
      load(entry.resources, `/api/resources${query}`, (data) => (Array.isArray(data.resources) ? data.resources : [])),
      load(entry.mcp, `/api/mcp${query}`, (data) => (Array.isArray(data.servers) ? data.servers : [])),
    ]).then(() => {
      if (seq === config.seq && active) api.renderBody();
    });
  }

  function configPart(key) {
    const entry = config.entries.get(config.scope);
    return key === "mcp" ? entry?.mcp : entry?.resources;
  }

  function summarize(key, state) {
    if (key === "agents") {
      const agents = Array.isArray(state.agents) ? state.agents : [];
      return { status: agents.length ? "ok" : "loading", error: "", summary: agents.length ? summarizeAgents(agents) : null };
    }
    const part = configPart(key);
    if (!part) return { status: "loading", error: "", summary: null };
    const summary = part.data
      ? key === "mcp" ? summarizeMcp(part.data) : summarizeResources(part.data, key === "rules" ? "rule" : "skill")
      : null;
    return { status: part.status, error: part.error, summary };
  }

  function moduleCounts(state) {
    const out = {};
    for (const key of Object.keys(MODULES)) {
      const { status, summary } = summarize(key, state);
      const value = summary ? summary.included.length : null;
      // Unknown or failed counts never show as 0.
      const shown = status === "ok" ? "ok" : summary ? (status === "error" ? "stale" : "ok") : status;
      out[key] = { value, text: value === null ? "--" : pad2(value), state: shown };
    }
    return out;
  }

  // ---- Panels inside the shared board dialog ----------------------------------------------

  function openPanel(panel, origin, originKey) {
    hideTip();
    api.openOverlay({ panel, originKey }, origin);
    if (panel.type === "publish") {
      api.getDialog().querySelector(".board-brief-input")?.focus();
    }
  }

  function openGroup(key, origin, reason, originKey) {
    select(key);
    openPanel({ type: "group", key, reason, query: "" }, origin, originKey);
  }

  function openModule(key, origin) {
    if (key !== "agents") ensureConfig(true);
    openPanel({ type: "module", key }, origin, `module:${key}`);
  }

  function openTask(card, origin) {
    hideTip();
    const key = model.groups.queued.includes(card) ? "queued" : model.groups.running.includes(card) ? "running" : "attention";
    select(key);
    api.openOverlay({ groupId: card.groupId, originGroupId: card.groupId, originKey: `task:${card.groupId}` }, origin);
  }

  function panelView(panel) {
    return `${panel.type}:${panel.key || ""}`;
  }

  function header(crumb, title, count) {
    return `
      <header class="board-overlay-header">
        <button type="button" class="board-overlay-close" data-board-overlay-ui="close" aria-label="${th("close")}">&times;</button>
        <div class="board-overlay-meta cb-crumb">${api.escapeHtml(crumb)}</div>
        <h2 id="boardOverlayTitle" tabindex="-1">${api.escapeHtml(title)}<span class="cb-title-count" data-cb-panel="count">${api.escapeHtml(count)}</span></h2>
      </header>`;
  }

  function renderPanel(detail, dialog) {
    const panel = detail.panel;
    const view = panelView(panel);
    if (dialog.dataset.classicView !== view) {
      api.restorePublisher();
      dialog.dataset.classicView = view;
      dialog.dataset.cbMarkup = "";
      dialog.innerHTML = panelShell(panel);
      if (panel.type === "publish") api.mountPublisher(dialog.querySelector(".cb-publish-host"));
      const search = dialog.querySelector(".cb-search");
      if (search) {
        search.value = panel.query || "";
        search.addEventListener("input", () => {
          panel.query = search.value;
          updateList(panel, dialog);
        });
      }
    }
    if (panel.type === "group" || panel.type === "finished") updateList(panel, dialog);
    if (panel.type === "module") updateModule(panel, dialog);
  }

  function panelShell(panel) {
    if (panel.type === "publish") {
      return `${header(`${t("classicIntake")} / ${t("boardColQueued")}`, t("classicPublishTitle"), "")}
        <div class="board-overlay-body"><p class="cb-note">${th("classicPublishNote")}</p><div class="cb-publish-host"></div></div>`;
    }
    if (panel.type === "module") {
      const info = MODULES[panel.key];
      return `${header(`${t("classicCpuName")} / ${panel.key === "agents" ? t("classicCpuCaption") : panel.key === "mcp" ? "MCP" : t(info.name)}`, t(info.title), "")}
        <div class="board-overlay-body" data-cb-panel="module"></div>
        <footer class="board-overlay-footer"><span></span><div class="board-card-actions">
          <button type="button" class="board-card-btn" data-classic-ui="settings" data-tab="${info.tab}">${th("classicOpenSettings")}</button>
        </div></footer>`;
    }
    const finished = panel.type === "finished";
    const crumb = finished ? t("classicFinishedTitle") : `R${BANKS[panel.key].index} / ${t(GROUP_LABEL[panel.key])}`;
    const chips = panel.key === "attention"
      ? `<div class="cb-chips" role="group">${["", ...ATTENTION_REASONS].map((reason) =>
        `<button type="button" class="cb-chip" data-classic-ui="reason" data-reason="${reason}"></button>`).join("")}</div>`
      : "";
    return `${header(crumb, finished ? t("classicFinishedTitle") : t(GROUP_LABEL[panel.key]), "")}
      <div class="board-overlay-body cb-list-body">
        <p class="cb-note">${th(finished ? "classicFinishedNote" : "classicGroupNote")}</p>
        ${chips}
        <input class="text-input cb-search" type="search" autocomplete="off" placeholder="${th("classicSearch")}" aria-label="${th("classicSearch")}" />
        <div class="cb-rows" data-cb-panel="rows"></div>
      </div>`;
  }

  function rowSearchText(card) {
    return [api.getCardTitle(card), api.getCardNumber(card), card.groupId, api.getProjectLabel(card.cwd), card.cwd, reasonText(card), card.board.failReason]
      .filter(Boolean).join(" ").toLocaleLowerCase();
  }

  function updateList(panel, dialog) {
    const cards = panel.type === "finished" ? model.done : model.groups[panel.key] || [];
    const byReason = panel.reason ? cards.filter((card) => attentionReason(card) === panel.reason) : cards;
    const query = String(panel.query || "").trim().toLocaleLowerCase();
    const list = query ? byReason.filter((card) => rowSearchText(card).includes(query)) : byReason;
    const count = dialog.querySelector('[data-cb-panel="count"]');
    if (count) count.textContent = t("classicTaskCount", cards.length);
    for (const chip of dialog.querySelectorAll('[data-classic-ui="reason"]')) {
      const reason = chip.dataset.reason;
      const n = reason ? model.reasons[reason] : cards.length;
      chip.textContent = `${reason ? t(REASON_LABEL[reason]) : t("classicAllReasons")} ${n}`;
      chip.setAttribute("aria-pressed", String((panel.reason || "") === reason));
    }
    const rows = dialog.querySelector('[data-cb-panel="rows"]');
    const markup = list.length ? list.map((card) => {
      const reason = attentionReason(card);
      const tag = reason ? `<span class="cb-tag is-${reason}">${api.escapeHtml(reasonText(card))}</span>` : "";
      return `<button type="button" class="cb-row" data-classic-ui="open-task" data-board-task="${api.escapeHtml(card.groupId)}">
        <span class="cb-row-id">${api.escapeHtml(api.getCardNumber(card))}</span>
        <span class="cb-row-title">${api.escapeHtml(api.getCardTitle(card))}</span>
        <span class="cb-row-project" title="${api.escapeHtml(card.cwd || "")}">${api.escapeHtml(api.getProjectLabel(card.cwd))}</span>
        ${tag}<span class="cb-row-arrow" aria-hidden="true">↗</span></button>`;
    }).join("") : `<p class="cb-empty">${th(cards.length ? "classicNoMatches" : panel.type === "finished" ? "classicFinishedEmpty" : "boardEmptyColumn")}</p>`;
    if (rows.dataset.markup === markup) return;
    const focused = rows.contains(document.activeElement) ? document.activeElement.dataset.boardTask : "";
    const scroll = rows.scrollTop;
    rows.innerHTML = markup;
    rows.dataset.markup = markup;
    rows.scrollTop = scroll;
    if (focused) rows.querySelector(`[data-board-task="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function excludedReasonText(reason, item) {
    if (reason === "untrusted") return t("classicWhyUntrusted");
    if (reason === "missingEnv") return t("classicWhyMissingEnv", (item.missingEnv || []).join(", "));
    return t("classicWhyDisabled");
  }

  function itemLine(key, item) {
    const e = api.escapeHtml;
    if (key === "agents") {
      const status = !item.available ? t("classicAgentMissing") : item.authReady ? t("classicAgentReady") : t("classicAgentNoAuth");
      return `<span class="cb-item-name">${e(item.label || item.agent)}</span><span class="cb-item-id">${e(item.agent)}</span>
        <span class="cb-item-detail${item.available && item.authReady ? "" : " is-warn"}">${e(status)}</span>`;
    }
    if (key === "mcp") {
      const details = [item.source, item.transport, t("classicMcpRoles", (item.roles || []).join(" / "))];
      if (item.disabledAgents?.length) details.push(t("classicMcpOffFor", item.disabledAgents.map((a) => api.agentName(a)).join(", ")));
      if (item.nativeAgents?.length) details.push(t("classicMcpNative", item.nativeAgents.map((a) => api.agentName(a)).join(", ")));
      return `<span class="cb-item-name">${e(item.name)}</span><span class="cb-item-detail">${e(details.join(" · "))}</span>`;
    }
    const scope = item.scope === "project" ? t("project") : t("global");
    const off = item.disabledAgents?.length ? ` · ${t("classicMcpOffFor", item.disabledAgents.map((a) => api.agentName(a)).join(", "))}` : "";
    return `<span class="cb-item-name">${e(item.name)}</span><span class="cb-item-detail">${e(`${scope}${off}`)}</span>
      ${item.description ? `<span class="cb-item-desc">${e(item.description)}</span>` : ""}`;
  }

  function updateModule(panel, dialog) {
    const key = panel.key;
    const { status, error, summary } = summarize(key, api.getState());
    const count = dialog.querySelector('[data-cb-panel="count"]');
    if (count) count.textContent = summary ? String(summary.included.length) : "—";
    const scope = key === "agents" ? "" : `<p class="cb-scope">${th("classicModuleScopeLine", config.scope || "—")}</p>`;
    let state = "";
    if (status === "loading") state = `<p class="cb-note" role="status">${th("classicLoading")}</p>`;
    if (status === "error") {
      state = `<div class="cb-error" role="alert"><span>${th("classicLoadFailedDetail", error)}</span>
        <button type="button" class="board-card-btn" data-classic-ui="retry-config">${th("classicRetry")}</button></div>
        ${summary ? `<p class="cb-note">${th("classicStaleNote")}</p>` : ""}`;
    }
    const items = summary ? (summary.included.length
      ? `<ul class="cb-items">${summary.included.map((item) => `<li>${itemLine(key, item)}</li>`).join("")}</ul>`
      : `<p class="cb-empty">${th("classicEmptyModule")}</p>`) : "";
    const excluded = summary?.excluded.length
      ? `<details class="cb-excluded"${panel.excludedOpen ? " open" : ""}><summary>${th("classicExcluded", summary.excluded.length)}</summary>
          <ul class="cb-items">${summary.excluded.map(({ item, reasons }) => `<li>${itemLine(key, item)}
            <span class="cb-item-why">${api.escapeHtml(reasons.map((r) => excludedReasonText(r, item)).join(" · "))}</span></li>`).join("")}</ul></details>`
      : "";
    const markup = `<p class="cb-note">${th(MODULES[key].note)}</p>${scope}${state}${items}${excluded}`;
    const body = dialog.querySelector('[data-cb-panel="module"]');
    if (body.dataset.markup === markup) return;
    const scroll = body.scrollTop;
    const refocus = body.contains(document.activeElement) ? document.activeElement.dataset.classicUi || (document.activeElement.matches("summary") ? "summary" : "") : "";
    body.innerHTML = markup;
    body.dataset.markup = markup;
    body.scrollTop = scroll;
    body.querySelector("details")?.addEventListener("toggle", (event) => { panel.excludedOpen = event.target.open; });
    if (refocus) (body.querySelector(`[data-classic-ui="${refocus}"]`) || body.querySelector(refocus === "summary" ? "summary" : null))?.focus({ preventScroll: true });
  }

  function onOverlayClick(event) {
    const control = event.target.closest("[data-classic-ui]");
    const detail = api.getOverlay();
    if (!control || !detail?.panel) return false;
    const ui = control.dataset.classicUi;
    if (ui === "open-task") {
      detail.groupId = control.dataset.boardTask;
      api.renderOverlay();
      const dialog = api.getDialog();
      dialog.querySelector(".board-overlay-body").scrollTop = 0;
      dialog.querySelector("#boardOverlayTitle")?.focus();
    } else if (ui === "reason") {
      detail.panel.reason = control.dataset.reason;
      api.renderOverlay();
    } else if (ui === "retry-config") {
      ensureConfig(true);
      api.renderOverlay();
    } else if (ui === "settings") {
      api.closeOverlay();
      api.openSettings(control.dataset.tab);
    }
    return true;
  }

  // ---- Dialog open/close motion and focus return -------------------------------------------

  function animateOpen(dialog, origin) {
    if (reducedMotion() || !origin?.getBoundingClientRect) return;
    const from = origin.getBoundingClientRect();
    const to = dialog.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    dialog.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.15)`, opacity: 0.2 },
      { transform: "none", opacity: 1 },
    ], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
  }

  function cancelClosing() {
    closing?.cancel();
    closing = null;
  }

  function focusTarget(detail) {
    if (!root || root.hidden) return null;
    const find = (key) => key && root.querySelector(`[data-scene-key="${CSS.escape(key)}"]`);
    const preferred = find(detail.focusKey);
    if (preferred) return preferred;
    if (detail.origin?.isConnected && root.contains(detail.origin)) return detail.origin;
    const id = detail.groupId || detail.originGroupId;
    const fallback = id && find(`task:${id}`);
    if (fallback) return fallback;
    const key = id && categoryIndex(model).get(id);
    return find(detail.originKey) || (key && find(key === "done" ? "lcd:done" : `stack:${key}`)) || find(key ? `lcd:${key}` : "") || dom.stage;
  }

  async function closeOverlay(dialog, detail, animate) {
    const target = focusTarget(detail);
    if (animate && target && !reducedMotion() && dialog.open) {
      const from = dialog.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const anim = dialog.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(.15)`, opacity: 0 },
      ], { duration: 190, easing: "ease-in", fill: "forwards" });
      closing = anim;
      // A hidden or throttled page may not advance animation frames; never leave it open.
      const guard = setTimeout(() => anim.playState === "running" && anim.finish(), 400);
      try {
        await anim.finished;
      } catch {
        return; // reopened while collapsing
      } finally {
        clearTimeout(guard);
      }
      if (closing !== anim) return;
      closing = null;
      dialog.close();
      anim.cancel();
    } else {
      dialog.close();
    }
    delete dialog.dataset.classicView;
    if (target === dom.stage) dom.stage.tabIndex = -1;
    target?.focus({ preventScroll: true });
  }

  // ---- Publishing --------------------------------------------------------------------------

  function onPublished(ids) {
    for (const id of ids) pendingPins.add(id);
    pendingFocusId = ids[0] || "";
    // Draw first: if the snapshot already arrived, the dialog collapses onto the new block.
    api.renderBody();
    setStatus(t("classicStatusPublished", ids.length));
    const detail = api.getOverlay();
    if (detail?.panel?.type === "publish") {
      detail.focusKey = pendingFocusId ? `task:${pendingFocusId}` : "";
      api.closeOverlay({ animate: true });
    }
  }

  // The snapshot may arrive after the publish response; move focus once the block exists,
  // but only if the user is still where the dialog left them.
  function focusPublished() {
    if (api.getOverlay()) return;
    const node = dom.svg.querySelector(`[data-scene-key="task:${CSS.escape(pendingFocusId)}"]`);
    if (!node) return;
    pendingFocusId = "";
    const current = document.activeElement;
    if (!current || current === document.body || current.closest?.('[data-scene-key="intake"]')) {
      node.focus({ preventScroll: true });
    }
  }

  return {
    render,
    deactivate,
    renderPanel,
    onOverlayClick,
    animateOpen,
    cancelClosing,
    closeOverlay,
    onPublished,
    onConfigChanged() {
      if (active) ensureConfig(true);
    },
    // Exposed for browser checks only.
    debug: () => ({ model, featured, selected, intro: Boolean(intro), flying: [...flying.keys()], scope: config.scope }),
  };
}

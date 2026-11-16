// Roundtable skin task board: the operations room. Queued tasks wait in standby pods, running
// tasks are beacons on the observation globe, tasks that need the user come back to the
// decision table. Business state, actions and publishing stay in board.js; this module maps
// the real board cards onto the scene, animates differences and fills the roundtable dialogs.

import { getLocale, t, th } from "./i18n.js";
import {
  ATTENTION_REASONS,
  CLASSIC_GROUPS,
  PREVIEW_SLOTS,
  attentionReason,
  buildClassicModel,
  categoryIndex,
  updateFeatured,
} from "./board-classic-model.js";
import { CONFIG_KEYS, createSceneConfig } from "./board-scene-config.js";

const NS = "http://www.w3.org/2000/svg";
const ROOM_IMAGE = "/ui/scenes/roundtable-room.jpg";
const GLOBE_IMAGE = "/ui/scenes/roundtable-globe.webp";
// One coordinate system for painting, objects, hit areas and effects.
const VIEW = { w: 1440, h: 780 };
const SLOTS = {
  queued: [[174, 338], [277, 363]],
  running: [[748, 244], [946, 346]],
  attention: [[719, 600], [921, 620]],
};
const MORE = { queued: [350, 406], running: [930, 178], attention: [1080, 652] };
const BEACON_LIFT = { queued: 31, running: 47, attention: 44 };
const GATE = [555, 345];
const GATE_ENTRY = [414, 385];
const GROUP_LABEL = { queued: "boardColQueued", running: "boardColRunning", attention: "classicAttention" };
const REASON_LABEL = { decision: "boardColDecision", review: "boardColReview", failed: "boardColFailed" };
const SUPPORT = {
  agents: { label: "rtRoster", tab: "agents" },
  resources: { label: "classicResources", tab: "resources" },
  rules: { label: "rtRules", tab: "resources" },
  mcp: { label: "rtMcp", tab: "mcp" },
};

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const pad2 = (n) => String(n).padStart(2, "0");

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

function clip(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// The static room: gradients, painting, globe, standby dock, transfer gate and decision table.
// Text here is atmosphere; the product brand stays in the top bar.
function sceneMarkup() {
  return `
  <defs>
    <radialGradient id="rt-ambient"><stop stop-color="#194e64" stop-opacity=".5"/><stop offset="1" stop-color="#194e64" stop-opacity="0"/></radialGradient>
    <linearGradient id="rt-roomShade" x2="0" y2="1"><stop stop-color="#060e22" stop-opacity=".05"/><stop offset=".24" stop-color="#071224" stop-opacity=".12"/><stop offset=".76" stop-color="#081426" stop-opacity=".35"/><stop offset="1" stop-color="#060f20" stop-opacity=".5"/></linearGradient>
    <linearGradient id="rt-lightBeam" x2="0" y2="1"><stop stop-color="#b2eff7" stop-opacity=".02"/><stop offset="1" stop-color="#b2eff7" stop-opacity=".22"/></linearGradient>
    <linearGradient id="rt-podMaterial" x2="1" y2="0"><stop stop-color="#152b43"/><stop offset=".22" stop-color="#438293" stop-opacity=".8"/><stop offset=".5" stop-color="#163f55" stop-opacity=".65"/><stop offset=".85" stop-color="#10293c" stop-opacity=".85"/><stop offset="1" stop-color="#b0e0e4" stop-opacity=".6"/></linearGradient>
    <linearGradient id="rt-ceramicTop" x2="0" y2="1"><stop stop-color="#8dabbc"/><stop offset=".45" stop-color="#4e6c84"/><stop offset="1" stop-color="#263d56"/></linearGradient>
    <linearGradient id="rt-terminalFace" x2=".4" y2="1"><stop stop-color="#264760"/><stop offset=".5" stop-color="#142a43"/><stop offset="1" stop-color="#0c1a2e"/></linearGradient>
    <linearGradient id="rt-transferColumn" x2="0" y2="1"><stop stop-color="#b0fbff" stop-opacity="0"/><stop offset=".5" stop-color="#9af2ff" stop-opacity=".25"/><stop offset="1" stop-color="#ddffff" stop-opacity=".65"/></linearGradient>
    <linearGradient id="rt-dossierCyan" x2="1" y2="1"><stop stop-color="#3b8d9e"/><stop offset=".48" stop-color="#153d58"/><stop offset="1" stop-color="#091b31"/></linearGradient>
    <linearGradient id="rt-dossierGold" x2="1" y2="1"><stop stop-color="#b49a62"/><stop offset=".4" stop-color="#4b4538"/><stop offset="1" stop-color="#182939"/></linearGradient>
    <linearGradient id="rt-rimMetal" x2="0" y2="1"><stop stop-color="#a2bac4"/><stop offset=".14" stop-color="#4a697b"/><stop offset=".45" stop-color="#253d52"/><stop offset="1" stop-color="#0b192b"/></linearGradient>
    <linearGradient id="rt-dispatchFace" x2=".7" y2="1"><stop stop-color="#f4e4bd"/><stop offset=".4" stop-color="#d7ba80"/><stop offset="1" stop-color="#9d814e"/></linearGradient>
    <linearGradient id="rt-consoleGlass" x2=".6" y2="1"><stop stop-color="#1c354a" stop-opacity=".96"/><stop offset=".45" stop-color="#0c1c2f" stop-opacity=".94"/><stop offset="1" stop-color="#101f31" stop-opacity=".86"/></linearGradient>
    <radialGradient id="rt-tableSurface" cx="47%" cy="30%" r="75%"><stop stop-color="#294959"/><stop offset=".62" stop-color="#162f43"/><stop offset="1" stop-color="#09172a"/></radialGradient>
    <linearGradient id="rt-tableApron" x2="0" y2="1"><stop stop-color="#688493"/><stop offset=".1" stop-color="#1c364b"/><stop offset=".52" stop-color="#0b1a2d"/><stop offset=".8" stop-color="#152c42"/><stop offset="1" stop-color="#071221"/></linearGradient>
    <radialGradient id="rt-slotGlass"><stop stop-color="#8a7852" stop-opacity=".35"/><stop offset="1" stop-color="#071c2b"/></radialGradient>
    <linearGradient id="rt-goldProjection" x2="0" y2="1"><stop stop-color="#e1c181" stop-opacity="0"/><stop offset="1" stop-color="#e1c181" stop-opacity=".13"/></linearGradient>
    <filter id="rt-softGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="rt-halo" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="rt-objectShadow" x="-35%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="10" stdDeviation="9" flood-color="#020817" flood-opacity=".55"/></filter>
  </defs>
  <g class="rt-architecture" aria-hidden="true">
    <rect width="1440" height="780" class="rt-room-fill"/>
    <image class="rt-room-painting" href="${ROOM_IMAGE}" x="0" y="0" width="1440" height="780" preserveAspectRatio="xMidYMid slice"/>
    <rect class="rt-room-shade" width="1440" height="780" fill="url(#rt-roomShade)"/>
    <ellipse cx="824" cy="342" rx="310" ry="270" fill="url(#rt-ambient)"/>
    <text x="80" y="111" class="rt-micro" letter-spacing="3">CHALDEA / MISSION CONTROL</text>
    <text x="1368" y="111" text-anchor="end" class="rt-micro">OBSERVATION DECK · 01</text>
  </g>
  <g class="rt-observation" aria-hidden="true">
    <ellipse cx="824" cy="516" rx="250" ry="32" class="rt-cyan-fill" opacity=".025"/>
    <ellipse cx="824" cy="516" rx="222" ry="22" class="rt-projection-base"/>
    <ellipse cx="824" cy="516" rx="185" ry="14" class="rt-projection-base" opacity=".45"/>
    <path d="M647 508 L673 404 M1001 508 L975 404" class="rt-cyan-line" opacity=".12"/>
    <image class="rt-globe-painting" href="${GLOBE_IMAGE}" x="598" y="79" width="452" height="452"/>
    <ellipse cx="824" cy="305" rx="229" ry="229" fill="none" stroke="#a0edf3" stroke-opacity=".12" stroke-dasharray="1 19"/>
    <text x="824" y="72" text-anchor="middle" class="rt-eyebrow" data-rt-text="observation"></text>
    <text x="1058" y="295" class="rt-micro" transform="rotate(90 1058 295)">SPIRITRON OBSERVATION FIELD</text>
  </g>
  <g class="rt-standby" aria-hidden="true">
    <path d="M98 420 L184 388 399 437 309 478Z" fill="url(#rt-tableSurface)" stroke="#547287"/>
    <path d="M98 420 V438 L309 497 399 455 V437 L309 478Z" fill="url(#rt-tableApron)" stroke="#547287"/>
    <path d="M113 434 L309 488 382 453" fill="none" class="rt-cyan-line" opacity=".4"/>
    <path d="M116 420 L186 400 378 439 308 463Z" fill="#071626" fill-opacity=".5" stroke="#80b5c0" stroke-opacity=".25"/>
    <path d="M130 443 L153 449 M169 454 L192 460 M315 478 L336 470 M349 465 L371 456" stroke="#94cbd2" stroke-width="2"/>
    <path d="M122 449 V461 L309 513 376 482 V466 L309 493Z" fill="#0b192a" stroke="#31485b"/>
    <path d="M352 443 Q478 443 574 370" class="rt-standby-route"/>
    <g class="rt-gate" transform="translate(555 345) rotate(26)">
      <ellipse rx="26" ry="55" fill="#102b42" fill-opacity=".6" stroke="#628997" stroke-width="6"/>
      <ellipse rx="19" ry="45" fill="#79d8eb" fill-opacity=".08" stroke="#b4f6ff" stroke-width="1.5" stroke-opacity=".65"/>
      <path d="M-26 0 H-35 M26 0 H35 M0-55 V-64 M0 55 V64" class="rt-cyan-line"/>
    </g>
    <text x="509" y="434" text-anchor="middle" class="rt-micro" data-rt-text="gate"></text>
  </g>
  <g class="rt-table" aria-hidden="true" filter="url(#rt-objectShadow)">
    <ellipse cx="830" cy="716" rx="354" ry="45" fill="#010712" opacity=".65"/>
    <path d="M580 668 L602 721 663 730 650 686Z M1010 686 L998 730 1059 721 1080 668Z" fill="url(#rt-rimMetal)" stroke="#364f62"/>
    <path d="M480 629 A350 78 0 0 0 1180 629 V663 A350 78 0 0 1 480 663Z" fill="url(#rt-tableApron)" stroke="#4e677a"/>
    <ellipse cx="830" cy="629" rx="350" ry="78" fill="url(#rt-rimMetal)" stroke="#aec5cc" stroke-opacity=".7"/>
    <ellipse cx="830" cy="626" rx="337" ry="70" fill="url(#rt-tableSurface)" stroke="#162e40" stroke-width="3"/>
    <ellipse cx="830" cy="626" rx="319" ry="60" fill="none" stroke="#c6b68e" stroke-opacity=".45"/>
    <ellipse cx="830" cy="626" rx="279" ry="45" fill="#061629" fill-opacity=".48" stroke="#7eafb9" stroke-opacity=".2"/>
    <path d="M495 632 A335 72 0 0 0 1165 632" fill="none" stroke="#b1e7ed" stroke-width="2.5" stroke-opacity=".8"/>
    <path d="M493 656 Q830 792 1167 656" fill="none" stroke="#345266" stroke-width="2"/>
    <path d="M512 678 L526 681 M541 688 L556 692 M1104 692 L1119 688 M1134 681 L1148 677" stroke="#b4dfe3" stroke-width="3"/>
    <path d="M580 584 L598 594 M688 563 L700 578 M960 563 L948 578 M1080 584 L1062 594" stroke="#d4c29a" stroke-opacity=".6" stroke-width="3"/>
    <path d="M783 706 H877 L886 715 877 728 H783 L774 715Z" fill="#071423" stroke="#7c7764" stroke-opacity=".6"/>
    <text x="830" y="721" text-anchor="middle" class="rt-table-plate">DECISION DECK</text>
  </g>
  <g class="rt-world"></g>
  <g class="rt-fx" pointer-events="none" aria-hidden="true"></g>
  <g class="rt-flight" pointer-events="none" aria-hidden="true"></g>`;
}

// The emblem used on dossier sidebars.
const EMBLEM = `<svg class="rt-emblem" viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-opacity=".7"/>
  <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="1 5"/>
  <path d="M50 10 L78 50 50 90 22 50Z" fill="currentColor" fill-opacity=".08" stroke="currentColor"/>
  <path d="M50 26 L66 50 50 74 34 50Z M50 10 V90 M22 50 H78" fill="none" stroke="currentColor" stroke-opacity=".55"/>
</svg>`;

export function createRoundtableBoard(api) {
  let root = null;
  const dom = {};
  let active = false;
  let model = buildClassicModel([]);
  let featured = { queued: [], running: [], attention: [] };
  let prevIndex = null;
  let prevFeatured = null;
  let lastSignature = "";
  let projectOptions = "";
  let introDone = false;
  let intro = null;
  const flights = new Map();
  const pendingPins = new Set();
  let pendingFocusId = "";
  let closing = null;

  const config = createSceneConfig({
    getState: () => api.getState(),
    getCards: () => api.getCards(),
    getProject: () => api.getProject(),
    getPublishCwd: () => api.getPublishCwd(),
    projectKey: (value) => api.projectKey(value),
    apiFetch: (...args) => api.apiFetch(...args),
    onUpdate: () => active && api.renderBody(),
  });

  // ---- Mount / lifecycle ---------------------------------------------------------------

  function mount() {
    if (root?.isConnected) return;
    root = document.createElement("div");
    root.className = "rt-root";
    root.hidden = true;
    root.innerHTML = `
      <div class="rt-toolbar">
        <div class="rt-context">
          <span class="rt-live" aria-hidden="true"></span>
          <label class="rt-label" for="rtProject" data-rt="projectLabel"></label>
          <select id="rtProject" class="rt-select"></select>
          <span class="rt-divider" aria-hidden="true"></span>
          <span class="rt-label" data-rt="tasksLabel"></span>
          <span class="rt-mono" data-rt="activeCount"></span>
        </div>
        <div class="rt-actions">
          <button type="button" class="rt-btn" data-rt="finished" data-scene-key="finished" aria-haspopup="dialog"></button>
          <button type="button" class="rt-btn" data-rt="replay"></button>
        </div>
      </div>
      <div class="rt-stage" data-rt="stage">
        <svg class="rt-scene" viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="group" preserveAspectRatio="xMidYMid meet">${sceneMarkup()}</svg>
        <div class="rt-hint" data-rt="hint"></div>
        <div class="rt-tooltip" role="tooltip" hidden></div>
      </div>
      <footer class="rt-footer">
        <span class="rt-status" role="status" data-rt="status"></span>
        <span class="rt-footnote" data-rt="footnote"></span>
      </footer>`;
    api.screen.querySelector(".board-main").before(root);
    for (const node of root.querySelectorAll("[data-rt]")) dom[node.dataset.rt] = node;
    dom.project = root.querySelector("#rtProject");
    dom.svg = root.querySelector(".rt-scene");
    dom.world = root.querySelector(".rt-world");
    dom.fx = root.querySelector(".rt-fx");
    dom.flight = root.querySelector(".rt-flight");
    dom.tooltip = root.querySelector(".rt-tooltip");
    for (const image of root.querySelectorAll("image")) {
      // A missing painting must not leave a broken image; objects remain recognisable.
      image.addEventListener("error", () => image.setAttribute("visibility", "hidden"), { once: true });
    }

    dom.project.addEventListener("change", () => {
      api.setProject(dom.project.value);
      api.renderBody();
    });
    dom.finished.addEventListener("click", () => openArchive("done", "", dom.finished, "finished"));
    dom.replay.addEventListener("click", () => {
      if (intro) skipAll();
      else void playIntro();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) skipAll();
    });
    // Any interaction ends a running intro; the room never holds the user back.
    dom.stage.addEventListener("pointerdown", () => intro && skipAll());
    dom.stage.addEventListener("keydown", () => intro && skipAll());
  }

  function deactivate() {
    if (!active) return;
    active = false;
    cancelAllFlights();
    prevIndex = null;
    lastSignature = "";
    hideTip();
    config.reset();
    if (root) root.hidden = true;
  }

  // ---- Render ----------------------------------------------------------------------------

  function render() {
    mount();
    if (api.screen.hidden) {
      deactivate();
      return;
    }
    const becameVisible = !active;
    active = true;
    root.hidden = false;

    const state = api.getState();
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
    // Flights for tasks that left the scene or changed again are stale.
    for (const [id, flight] of flights) if (index.get(id) !== flight.to) cancelFlight(id);

    renderChrome(state, loaded);
    if (becameVisible || config.currentScope() !== config.scope) config.ensure(becameVisible);

    const signature = sceneSignature(loaded);
    if (signature !== lastSignature) {
      lastSignature = signature;
      drawWorld(loaded);
    }
    if (pendingFocusId) focusPublished();

    if (!loaded) setStatus(t("rtStatusWaiting"));
    else if (!introDone) {
      introDone = true;
      void playIntro();
    } else if (moves.length && !intro) startMoves(moves);
    else if (!intro && !flights.size) setStatus(t("rtStatusReady"));
  }

  function renderChrome(state, loaded) {
    const paths = new Map();
    for (const project of state.projects || []) if (project?.path) paths.set(api.projectKey(project.path), project.path);
    for (const card of api.getCards()) if (card.cwd) paths.set(api.projectKey(card.cwd), card.cwd);
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
    dom.project.title = config.currentScope();
    dom.projectLabel.textContent = t("workingDirectory");
    dom.tasksLabel.textContent = t("classicActiveTasks");
    dom.activeCount.textContent = loaded ? String(model.active) : "—";
    dom.finished.textContent = t("rtFinished", model.done.length);
    dom.svg.setAttribute("aria-label", t("rtSceneLabel"));
    dom.hint.innerHTML = `<span aria-hidden="true">▱</span>${th("rtHintOpen")}<i aria-hidden="true"></i>${th("rtHintMore")}`;
    dom.footnote.textContent = t("rtFootnote", loaded ? model.active : "—", config.currentScope() || "—");
    dom.footnote.title = config.currentScope();
    for (const node of dom.svg.querySelectorAll("[data-rt-text]")) {
      node.textContent = node.dataset.rtText === "gate" ? t("rtGate") : `CHALDEAS · ${t("rtObservation")}`;
    }
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

  function sceneSignature(loaded) {
    const counts = config.counts();
    const agents = config.summarize("agents").summary?.included.map((a) => [a.agent, a.available, a.authReady]) || [];
    const parts = [getLocale(), loaded, model.active, ATTENTION_REASONS.map((r) => model.reasons[r]).join(), agents];
    for (const key of CLASSIC_GROUPS) {
      parts.push(key, model.groups[key].length);
      for (const id of featured[key]) {
        const card = cardById(id);
        parts.push(id, api.getCardTitle(card), api.getLeadLabel(card), card.board.status, card.waiting ? card.waitingReason || "w" : "");
      }
    }
    for (const key of CONFIG_KEYS) parts.push(counts[key].value, counts[key].state);
    return JSON.stringify(parts);
  }

  // ---- Scene objects ---------------------------------------------------------------------

  function interactive(g, sceneKey, label, fn) {
    g.classList.add("rt-object");
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", label);
    g.setAttribute("aria-haspopup", "dialog");
    g.dataset.sceneKey = sceneKey;
    const run = () => {
      if (intro) skipAll();
      fn(g);
    };
    g.addEventListener("click", run);
    g.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        run();
      }
    });
    return g;
  }

  function drawWorld(loaded) {
    const focusKey = dom.svg.contains(document.activeElement) ? document.activeElement.closest("[data-scene-key]")?.dataset.sceneKey : "";
    hideTip();
    dom.world.replaceChildren();
    zoneHeader("queued", 102, 208, t("rtZoneQueued"), loaded);
    zoneHeader("running", 1090, 214, t("rtZoneRunning"), loaded);
    zoneHeader("attention", 518, 520, t("rtZoneAttention"), loaded);
    for (const key of CLASSIC_GROUPS) {
      const layer = el("g", { "data-group": key }, dom.world);
      featured[key].forEach((id, i) => {
        const card = cardById(id);
        if (card) taskObject(card, key, i, layer);
      });
      moreObject(key, layer);
    }
    drawIntake();
    drawRoster();
    drawConsole(loaded);
    if (focusKey) dom.svg.querySelector(`[data-scene-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  function zoneHeader(key, x, y, subtitle, loaded) {
    const g = el("g", { "data-zone": key }, dom.world);
    const name = t(GROUP_LABEL[key]);
    const title = txt(x, y, name, { class: "rt-zone-title" }, g);
    const count = loaded ? pad2(model.groups[key].length) : "--";
    // The count follows the title so longer (English) names never overlap it.
    const width = Math.max(78, (title.getComputedTextLength?.() || name.length * 23) + 22);
    txt(x + width, y, count, { class: "rt-zone-number" }, g);
    txt(x, y + 25, subtitle, { class: "rt-zone-subtitle" }, g);
    el("path", { d: `M${x} ${y - 28} V${y - 36} H${x + 21}`, fill: "none", class: key === "attention" ? "rt-gold-line" : "rt-cyan-line" }, g);
    el("rect", { x: x - 10, y: y - 40, width: width + 70, height: 80, class: "rt-hit" }, g);
    interactive(g, `zone:${key}`, t("rtZoneLabel", name, loaded ? model.groups[key].length : "—"), (node) => openArchive(key, "", node, `zone:${key}`));
  }

  // A sealed mission dossier; the same silhouette is used in pods, on the globe, at the table
  // and while transferring.
  function missionBeacon(parent, x, y, size, gold = false) {
    const ink = gold ? "#ffe0a2" : "#b9f4ff";
    const g = el("g", { transform: `translate(${x} ${y}) scale(${size / 25})`, class: "rt-beacon" }, parent);
    el("path", { d: "M-17-25 H8 L20-14 V23 L14 29 H-17Z", fill: gold ? "#725532" : "#24516a", stroke: ink, "stroke-opacity": 0.6 }, g);
    el("path", { d: "M-21-29 H6 L16-19 V23 H-21Z", fill: gold ? "url(#rt-dossierGold)" : "url(#rt-dossierCyan)", stroke: ink, "stroke-width": 1.2, class: "rt-hot" }, g);
    el("path", { d: "M6-29 V-19 H16 M16-19 L20-14 M16 23 L20 23 M-21 23 L-17 29 H14 L16 23", fill: "none", stroke: ink, "stroke-opacity": 0.65 }, g);
    el("path", { d: "M-17-24 H-8 M-17-24 V-15 M12 18 H4 M12 18 V10", fill: "none", stroke: ink, "stroke-width": 1.5 }, g);
    el("path", { d: "M-3-17 L5-6 -3 5 -11-6Z M-3-12 V0 M-7-6 H1", fill: "none", stroke: ink, "stroke-width": 1.2 }, g);
    el("path", { d: "M-12 11 H6 M-12 15 H0", stroke: ink, "stroke-opacity": 0.7 }, g);
    el("path", { d: "M-19-27 H5 L14-18 V-10 L-19 10Z", fill: "#e5ffff", opacity: 0.07 }, g);
    return g;
  }

  function reasonText(card) {
    const reason = attentionReason(card);
    if (reason === "decision") return api.getWaitingBadgeInfo(card).text;
    return reason ? t(REASON_LABEL[reason]) : "";
  }

  function taskObject(card, key, index, parent) {
    const [x, y] = SLOTS[key][index];
    const id = card.groupId;
    const number = api.getCardNumber(card);
    const g = el("g", { class: `rt-task is-${key}`, transform: `translate(${x} ${y})`, "data-group-id": id, "data-slot": `${key}:${index}` }, parent);
    if (key === "queued") {
      el("ellipse", { cx: 0, cy: 47, rx: 48, ry: 17, fill: "#020a16", opacity: 0.8 }, g);
      el("path", { d: "M-38 30 L-31 18 H31 L40 30 V45 L25 55 H-25 L-38 45Z", fill: "url(#rt-rimMetal)", stroke: "#648599" }, g);
      el("ellipse", { cx: 0, cy: 30, rx: 34, ry: 10, fill: "#071c2d", stroke: "#88c6d5", "stroke-opacity": 0.7 }, g);
      el("path", { d: "M-33-90 Q0-106 33-90 L33 30 Q0 44-33 30Z", fill: "url(#rt-podMaterial)", stroke: "#82bac8", "stroke-opacity": 0.55 }, g);
      el("path", { d: "M-32-87 L-31 29 M31-87 L32 29", stroke: "#a2dae4", "stroke-width": 4, "stroke-opacity": 0.5 }, g);
      el("path", { d: "M-38-93 L-25-102 H25 L38-93 V-85 Q0-67-38-85Z", fill: "url(#rt-rimMetal)", stroke: "#9abcc8", "stroke-width": 0.8 }, g);
      el("ellipse", { cx: 0, cy: -93, rx: 29, ry: 7, fill: "#122b3e", stroke: "#78b9c8", "stroke-opacity": 0.6 }, g);
      el("path", { d: "M-25-82 Q0-73 25-82 M-25 41 Q0 51 25 41", fill: "none", stroke: "#b5f5fa", "stroke-width": 2 }, g);
      el("path", { d: "M-20-76 H-12 V25 H-20Z", fill: "#c4ffff", opacity: 0.06 }, g);
      missionBeacon(g, 0, -31, 25);
      el("path", { d: "M-27 21 H27 V36 H-27Z", fill: "#0a1a2b", stroke: "#4c7184", "stroke-width": 0.5 }, g);
      txt(0, 32, number, { "text-anchor": "middle", class: "rt-task-id rt-pod-id" }, g);
      el("path", { d: "M-44-91 V-105 H-27 M27-105 H44 V-91 M-44 37 V59 H-27 M27 59 H44 V37", fill: "none", class: "rt-hover-ring rt-cyan-line" }, g);
      el("rect", { x: -44, y: -108, width: 88, height: 167, class: "rt-hit" }, g);
    } else if (key === "running") {
      el("ellipse", { cx: 0, cy: 20, rx: 32, ry: 12, class: "rt-cyan-fill", "fill-opacity": 0.06, stroke: "#b2eff7", "stroke-opacity": 0.4 }, g);
      el("path", { d: "M-15-48 L-25 20 Q0 31 25 20 L15-48Z", fill: "url(#rt-lightBeam)" }, g);
      el("path", { d: "M0-35 V20 M-40 20 H-24 M24 20 H40", class: "rt-cyan-line", "stroke-opacity": 0.5 }, g);
      missionBeacon(g, 0, -47, 19);
      el("ellipse", { cx: 0, cy: 20, rx: 42, ry: 17, fill: "none", class: "rt-hover-ring rt-gold-line" }, g);
      txt(44, -31, number, { class: "rt-task-id" }, g);
      txt(44, -12, clip(api.getLeadLabel(card), 14), { class: "rt-owner" }, g);
      el("rect", { x: -44, y: -75, width: 158, height: 115, class: "rt-hit" }, g);
    } else {
      el("ellipse", { cx: 0, cy: 17, rx: 67, ry: 19, fill: "#020c19", opacity: 0.65 }, g);
      el("path", { d: "M-62 8 A62 16 0 0 0 62 8 V15 A62 16 0 0 1-62 15Z", fill: "url(#rt-rimMetal)", stroke: "#6a797a", "stroke-width": 0.6 }, g);
      el("ellipse", { cx: 0, cy: 8, rx: 62, ry: 16, fill: "url(#rt-slotGlass)", stroke: "#c4ab7e", "stroke-opacity": 0.75 }, g);
      el("ellipse", { cx: 0, cy: 8, rx: 48, ry: 10, fill: "none", stroke: "#edcf91", "stroke-opacity": 0.25 }, g);
      el("path", { d: "M-27-31 L-39 8 Q0 20 39 8 L27-31Z", fill: "url(#rt-goldProjection)" }, g);
      el("path", { d: "M-57 8 H-43 M43 8 H57 M0-8 V-3 M0 19 V24", stroke: "#f6d495", "stroke-width": 1.5 }, g);
      missionBeacon(g, 0, -44, 29, true);
      txt(39, -48, number, { class: "rt-task-id" }, g);
      // The scene shows the short reason; the sub-reason is in the label, tooltip and dossier.
      const reason = attentionReason(card);
      txt(39, -28, t({ decision: "classicCellDecision", review: "classicCellReview", failed: "classicCellFailed" }[reason] || "classicCellDecision"), { class: `rt-task-reason is-${reason}` }, g);
      txt(0, 39, `SLOT 0${index + 1}`, { "text-anchor": "middle", class: "rt-slot-caption" }, g);
      el("ellipse", { cx: 0, cy: 8, rx: 72, ry: 24, fill: "none", class: "rt-hover-ring rt-gold-line" }, g);
      el("rect", { x: -74, y: -83, width: 190, height: 126, class: "rt-hit" }, g);
    }
    const title = `${number} · ${api.getCardTitle(card)}`;
    const extra = key === "attention" ? ` · ${reasonText(card)}` : key === "running" ? ` · ${api.getLeadLabel(card)}` : "";
    interactive(g, `task:${id}`, `${title}${extra}`, (node) => openTask(card, node));
    g.addEventListener("pointerenter", () => showTip(g, title + extra));
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("focus", () => showTip(g, title + extra));
    g.addEventListener("blur", hideTip);
    if (isHidden(`${key}:${index}`, id)) g.style.visibility = "hidden";
    return g;
  }

  function moreObject(key, parent) {
    const total = model.groups[key].length;
    const hidden = Math.max(0, total - featured[key].length);
    if (!hidden) return;
    const [x, y] = MORE[key];
    const g = el("g", { class: "rt-more", transform: `translate(${x} ${y})`, "data-slot": `${key}:more` }, parent);
    if (key === "queued") {
      for (let i = 2; i >= 0; i--) {
        el("path", { d: `M${-21 + i * 4} ${-25 - i * 5} L${i * 4} ${-37 - i * 5} ${21 + i * 4} ${-25 - i * 5} ${i * 4} ${-13 - i * 5}Z`, fill: "url(#rt-ceramicTop)", stroke: "#547287", class: i === 0 ? "rt-hot" : "" }, g);
      }
    } else if (key === "running") {
      el("circle", { r: 24, fill: "#102b43", "fill-opacity": 0.7, stroke: "#b2eff7", "stroke-dasharray": "3 4", class: "rt-hot" }, g);
      for (let i = 0; i < 3; i++) el("circle", { cx: -8 + i * 8, cy: -32, r: 1.5, class: "rt-cyan-fill" }, g);
    } else {
      el("ellipse", { rx: 43, ry: 19, fill: "#101c31", stroke: "#f0d2a0", "stroke-dasharray": "3 4", class: "rt-hot" }, g);
    }
    txt(0, key === "queued" ? 10 : 5, `+${hidden}`, { "text-anchor": "middle", class: "rt-count-label" }, g);
    el("rect", { x: -45, y: -46, width: 90, height: 79, fill: "none", class: "rt-hover-ring rt-gold-line" }, g);
    el("rect", { x: -45, y: -46, width: 90, height: 79, class: "rt-hit" }, g);
    interactive(g, `more:${key}`, t("classicStackLabel", t(GROUP_LABEL[key]), hidden, total), (node) => openArchive(key, "", node, `more:${key}`));
    if (isHidden(`${key}:more`)) g.style.visibility = "hidden";
  }

  function drawIntake() {
    const g = el("g", { class: "rt-intake", transform: "translate(102 504)" }, dom.world);
    el("path", { d: "M0 5 H269 L285 21 V60 H9 L0 51Z", fill: "#070f1e", opacity: 0.75, transform: "translate(0 6)" }, g);
    el("path", { d: "M0 0 H269 L285 16 V60 H16 L0 44Z", fill: "url(#rt-dispatchFace)", stroke: "#f4d6a0", "stroke-width": 1.2, class: "rt-hot" }, g);
    el("path", { d: "M1 1 H268 L283 16 M16 59 H284", fill: "none", stroke: "#fff1c6", "stroke-opacity": 0.65 }, g);
    el("path", { d: "M57 10 V50", stroke: "#6d572f", "stroke-opacity": 0.5 }, g);
    el("path", { d: "M29 18 V42 M17 30 H41", stroke: "#172b39", "stroke-width": 2 }, g);
    txt(74, 28, t("rtDispatch"), { class: "rt-dispatch-label" }, g);
    txt(74, 45, "MISSION DISPATCH", { class: "rt-dispatch-caption" }, g);
    el("path", { d: "M257 25 L263 31 257 37", fill: "none", stroke: "#263b46", "stroke-width": 1.5 }, g);
    interactive(g, "intake", t("rtDispatchLabel"), (node) => openPanel({ type: "dispatch" }, node, "intake"));
  }

  const GLYPHS = [
    "M-13-6 L-20 0-13 6 M10-6 L17 0 10 6 M3-11 L-4 11",
    "M0-13 V13 M-13 0 H13 M-9-9 L9 9 M-9 9 L9-9",
    "M-13-10 H3 L12-1 V10 H-3 L-13 0Z M-6-3 H5 V4 H-6Z",
    "M0-13 L13 0 0 13 -13 0Z M0-6 L6 0 0 6 -6 0Z",
  ];

  function drawRoster() {
    const rail = el("g", { class: "rt-roster" }, dom.world);
    el("path", { d: "M102 587 H367 L387 607 V708 H102Z", fill: "url(#rt-consoleGlass)", stroke: "#567588", "stroke-opacity": 0.65 }, rail);
    const { status, summary } = config.summarize("agents");
    const agents = summary?.included || [];
    const header = el("g", {}, rail);
    txt(118, 610, t("rtRoster"), { class: "rt-infra-label" }, header);
    txt(370, 610, summary ? `${pad2(agents.length)} AGENTS` : "-- AGENTS", { "text-anchor": "end", class: "rt-infra-caption" }, header);
    el("rect", { x: 103, y: 588, width: 282, height: 35, class: "rt-hit" }, header);
    interactive(header, "roster", summary ? t("rtRosterLabel", agents.length) : t("classicModuleUnknown", t("rtRoster")), (node) => openSupport("agents", node, "roster"));
    if (!summary) {
      txt(244, 664, t(status === "error" ? "classicModuleFailed" : "classicLoading"), { "text-anchor": "middle", class: "rt-infra-caption" }, rail);
      return;
    }
    if (!agents.length) {
      txt(244, 664, t("rtNoAgents"), { "text-anchor": "middle", class: "rt-infra-caption" }, rail);
      return;
    }
    // Three badges at most; more agents collapse into the last one.
    const shown = agents.length > 3 ? agents.slice(0, 2) : agents.slice(0, 3);
    const badges = shown.map((agent, i) => ({ agent, glyph: GLYPHS[i % GLYPHS.length] }));
    if (agents.length > 3) badges.push({ more: agents.length - 2 });
    badges.forEach((badge, i) => {
      const g = el("g", { transform: `translate(${151 + i * 93} 652)` }, rail);
      el("path", { d: "M-28-22 H18 L28-12 V23 H-28Z", fill: "url(#rt-rimMetal)", stroke: "#66889b", class: "rt-hot" }, g);
      el("path", { d: "M-25-19 H16 L24-11 V19 H-25Z", fill: "url(#rt-terminalFace)", stroke: "#b4d4df", "stroke-opacity": 0.18 }, g);
      if (badge.more) {
        txt(0, 6, `+${badge.more}`, { "text-anchor": "middle", class: "rt-count-label" }, g);
        txt(0, 41, t("rtMoreAgents"), { "text-anchor": "middle", class: "rt-agent-name" }, g);
        el("rect", { x: -38, y: -26, width: 76, height: 74, class: "rt-hit" }, g);
        interactive(g, "roster:more", t("rtRosterLabel", agents.length), (node) => openSupport("agents", node, "roster:more"));
        return;
      }
      const { agent } = badge;
      const name = api.agentName(agent.agent) || agent.label || agent.agent;
      el("path", { d: badge.glyph, fill: "none", stroke: "#dfcba6", "stroke-width": 1.3 }, g);
      // Configuration evidence only: available + signed in, signed out, or command missing.
      const health = !agent.available ? "missing" : agent.authReady ? "ready" : "auth";
      el("circle", { cx: 19, cy: 14, r: 2.4, class: `rt-health is-${health}` }, g);
      txt(0, 41, clip(name, 10), { "text-anchor": "middle", class: "rt-agent-name" }, g);
      el("rect", { x: -38, y: -26, width: 76, height: 74, class: "rt-hit" }, g);
      const healthText = t(health === "ready" ? "classicAgentReady" : health === "auth" ? "classicAgentNoAuth" : "classicAgentMissing");
      interactive(g, `agent:${agent.agent}`, `${name} · ${healthText}`, (node) => openSupport("agents", node, `agent:${agent.agent}`, agent.agent));
    });
  }

  function drawConsole(loaded) {
    // One recessed console carries mission metrics and shared capabilities.
    const g = el("g", { class: "rt-console", transform: "translate(1112 286)" }, dom.world);
    el("path", { d: "M0 0 H237 L256 19 V286 H0Z", fill: "url(#rt-consoleGlass)", stroke: "#587c90", "stroke-opacity": 0.8 }, g);
    el("path", { d: "M0 0 H40 M237 0 L256 19 V44 M0 260 V286 H26", fill: "none", stroke: "#aac7cc", "stroke-width": 2 }, g);
    txt(18, 29, t("rtConsole"), { class: "rt-infra-label" }, g);
    txt(236, 29, loaded ? t("rtConsoleTotal", pad2(model.active)) : t("rtConsoleTotal", "--"), { "text-anchor": "end", class: "rt-console-total" }, g);
    el("path", { d: "M18 44 H236", stroke: "#7392a0", "stroke-opacity": 0.3 }, g);
    ATTENTION_REASONS.forEach((reason, i) => {
      const row = el("g", { transform: `translate(${19 + i * 78} 59)`, "data-reason": reason }, g);
      const count = model.reasons[reason];
      txt(0, 25, loaded ? pad2(count) : "--", { class: `rt-console-number is-${reason}` }, row);
      txt(0, 48, t({ decision: "classicCellDecision", review: "classicCellReview", failed: "classicCellFailed" }[reason]), { class: "rt-console-small" }, row);
      el("rect", { x: -8, y: -5, width: 74, height: 65, class: "rt-console-hit" }, row);
      interactive(row, `reason:${reason}`, t("classicLcdLabel", t(REASON_LABEL[reason]), loaded ? count : "—"), (node) => openArchive("attention", reason, node, `reason:${reason}`));
    });
    el("path", { d: "M18 124 H236", stroke: "#7392a0", "stroke-opacity": 0.3 }, g);
    const counts = config.counts();
    const icons = {
      resources: "M2 5 H10 L14 9 H25 V24 H2Z M2 11 H25",
      rules: "M4 4 H23 V25 H4Z M9 10 H18 M9 15 H18 M9 20 H15",
      mcp: "M4 7 H11 V14 H4Z M18 18 H25 V25 H18Z M11 10 H21 V18",
    };
    ["resources", "rules", "mcp"].forEach((key, i) => {
      const row = el("g", { transform: `translate(18 ${137 + i * 45})` }, g);
      const count = counts[key];
      el("path", { d: icons[key], fill: "none", stroke: "#a6c9d3", "stroke-width": 1.2 }, row);
      txt(39, 19, t(SUPPORT[key].label), { class: "rt-infra-label" }, row);
      txt(193, 19, count.value === null ? "--" : pad2(count.value), { "text-anchor": "end", class: "rt-console-value" }, row);
      if (count.state !== "ok") {
        txt(39, 34, t(count.state === "stale" ? "classicModuleStale" : count.state === "error" ? "classicModuleFailed" : "classicLoading"), { class: `rt-console-state is-${count.state}` }, row);
      }
      el("path", { d: "M211 12 L216 17 211 22", fill: "none", stroke: "#7999ac" }, row);
      el("rect", { x: -8, y: -1, width: 236, height: 43, class: "rt-console-hit" }, row);
      const label = count.value === null ? t("classicModuleUnknown", t(SUPPORT[key].label)) : t("classicModuleLabel", t(SUPPORT[key].label), count.value);
      interactive(row, `module:${key}`, label, (node) => openSupport(key, node, `module:${key}`));
    });
    txt(18, 273, "CHALDEA / SUPPORT LINK", { class: "rt-console-foot" }, g);
  }

  function isHidden(slot, id) {
    if (intro && !slot.startsWith("queued") && !intro.revealed.has(slot)) return true;
    return Boolean(id && flights.has(id));
  }

  function reveal(slot) {
    const node = dom.svg?.querySelector(`[data-slot="${slot}"]`);
    if (node && !(node.dataset.groupId && flights.has(node.dataset.groupId))) node.style.visibility = "";
  }

  function showTip(node, text) {
    if (intro || api.getOverlay()) return;
    const rect = node.getBoundingClientRect();
    dom.tooltip.textContent = text;
    dom.tooltip.hidden = false;
    dom.tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 340))}px`;
    dom.tooltip.style.top = `${Math.min(rect.bottom + 10, innerHeight - 60)}px`;
  }

  function hideTip() {
    if (dom.tooltip) dom.tooltip.hidden = true;
  }

  // ---- Effects ---------------------------------------------------------------------------
  // A flight owns its animations and effect nodes so it can be skipped or cancelled alone.

  // Every flight lands by its deadline even when the page does not advance animation frames
  // (background tab, hidden window): the scene must never keep objects hidden.
  function newFlight(to, deadlineMs) {
    const flight = { to, anims: new Set(), nodes: new Set(), skip: false, cancelled: false, deadline: 0 };
    flight.deadline = setTimeout(() => finishFlight(flight), deadlineMs);
    return flight;
  }

  async function play(flight, node, keyframes, duration, options = {}) {
    if (flight.cancelled) throw new Error("cancelled");
    // Skipped or reduced: no zero-length animations that would wait for a frame.
    if (flight.skip || reducedMotion()) return;
    const anim = node.animate(keyframes, { duration: flight.skip || reducedMotion() ? 0 : duration, easing: "ease-in-out", fill: "forwards", ...options });
    flight.anims.add(anim);
    try {
      await anim.finished;
    } finally {
      flight.anims.delete(anim);
    }
    if (flight.cancelled) throw new Error("cancelled");
  }

  function fxNode(flight, parent, tag, attrs) {
    const node = el(tag, attrs, parent);
    flight.nodes.add(node);
    return node;
  }

  function disposeFlight(flight) {
    clearTimeout(flight.deadline);
    flight.cancelled = true;
    for (const anim of flight.anims) anim.cancel();
    flight.anims.clear();
    for (const node of flight.nodes) node.remove();
    flight.nodes.clear();
  }

  function finishFlight(flight) {
    flight.skip = true;
    for (const anim of [...flight.anims]) anim.finish();
  }

  function cancelFlight(id) {
    const flight = flights.get(id);
    if (!flight) return;
    flights.delete(id);
    disposeFlight(flight);
    revealTask(id);
  }

  function cancelAllFlights() {
    if (intro) {
      disposeFlight(intro);
      intro = null;
    }
    for (const id of [...flights.keys()]) cancelFlight(id);
    dom.fx?.replaceChildren();
    dom.flight?.replaceChildren();
    if (dom.svg) dom.svg.dataset.transferPhase = "idle";
    updateReplayButton();
  }

  function skipAll() {
    if (intro) finishFlight(intro);
    for (const flight of flights.values()) finishFlight(flight);
  }

  function revealTask(id) {
    const node = dom.svg?.querySelector(`[data-group-id="${CSS.escape(id)}"]`);
    if (node && !(intro && !intro.revealed.has(node.dataset.slot))) node.style.visibility = "";
  }

  function actor(flight, card, gold) {
    const g = fxNode(flight, dom.flight, "g", { class: "rt-actor" });
    el("circle", { r: 23, fill: gold ? "#f0d2a0" : "#b2eff7", opacity: 0.13, filter: "url(#rt-softGlow)" }, g);
    missionBeacon(g, 0, 0, 17, gold);
    txt(27, 4, api.getCardNumber(card), { class: "rt-task-id" }, g);
    return g;
  }

  function pathFrames(points) {
    const lengths = points.map((p, i) => (i ? Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0));
    const total = lengths.reduce((a, b) => a + b, 0);
    let walked = 0;
    return points.map((p, i) => {
      walked += lengths[i];
      return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: total ? walked / total : i / Math.max(1, points.length - 1) };
    });
  }

  async function pulse(flight, [x, y], gold, vertical = false) {
    const g = fxNode(flight, dom.fx, "g", {});
    const stroke = gold ? "#f0d2a0" : "#b2eff7";
    el("ellipse", { rx: vertical ? 22 : 49, ry: vertical ? 48 : 15, fill: "none", stroke, "stroke-width": 1.5 }, g);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      el("path", { d: `M${Math.cos(a) * 19} ${Math.sin(a) * 19} l${Math.cos(a) * 8} ${Math.sin(a) * 8}`, stroke, opacity: 0.6 }, g);
    }
    await play(flight, g, [
      { transform: `translate(${x}px, ${y}px) scale(.7)`, opacity: 0.9 },
      { transform: `translate(${x}px, ${y}px) scale(1.35)`, opacity: 0 },
    ], 320, { easing: "ease-out" });
    g.remove();
    flight.nodes.delete(g);
  }

  function chargeField(flight, [x, y]) {
    const g = fxNode(flight, dom.fx, "g", { transform: `translate(${x} ${y})`, opacity: 0 });
    el("path", { d: "M-29 -90 L-43 49 Q0 72 43 49 L29 -90Z", fill: "url(#rt-transferColumn)" }, g);
    el("ellipse", { cx: 0, cy: 49, rx: 54, ry: 17, fill: "#95e9ff", opacity: 0.15, filter: "url(#rt-halo)" }, g);
    el("ellipse", { cx: 0, cy: 49, rx: 46, ry: 14, fill: "none", stroke: "#d0fcff", "stroke-width": 1.4 }, g);
    el("ellipse", { cx: 0, cy: 49, rx: 33, ry: 10, fill: "none", stroke: "#85ebff", "stroke-width": 0.8, "stroke-dasharray": "4 3" }, g);
    return g;
  }

  // 32 spiritron shards either leave `from` towards `to`, or gather at `to`.
  async function particles(flight, from, to, gather) {
    const layer = fxNode(flight, dom.fx, "g", { "data-effect": gather ? "reconstruct" : "deconstruct" });
    const work = [];
    for (let i = 0; i < 32; i++) {
      const angle = i * 2.399963, spread = 20 + (i % 7) * 6, dx = Math.cos(angle) * spread, dy = Math.sin(angle) * spread;
      const start = gather ? [to[0] + dx * 1.6, to[1] + dy * 1.6] : [from[0] + dx * 0.16, from[1] + dy * 0.3];
      const middle = gather ? [to[0] + dx * 0.8, to[1] + dy * 0.8] : [from[0] + dx * 1.5, from[1] + dy - 35];
      const end = gather ? to : [to[0] + dx * 0.08, to[1] + dy * 0.15];
      const shard = el("rect", { x: -1.5, y: -2, width: i % 3 === 0 ? 3 : 2, height: i % 3 === 0 ? 8 : 3, fill: i % 4 === 0 ? "#fffde2" : "#aef8ff", rx: 0.5, opacity: 0 }, layer);
      work.push(play(flight, shard, [
        { transform: `translate(${start[0]}px, ${start[1]}px) rotate(${i * 31}deg)`, opacity: 0, offset: 0 },
        { transform: `translate(${middle[0]}px, ${middle[1]}px) rotate(${i * 31 + 70}deg)`, opacity: 0.9, offset: 0.38 },
        { transform: `translate(${end[0]}px, ${end[1]}px) rotate(${i * 31 + 120}deg)`, opacity: 0, offset: 1 },
      ], 560 + (i % 4) * 30, { easing: gather ? "cubic-bezier(.6,0,.8,.4)" : "cubic-bezier(.2,.6,.5,1)" }));
    }
    await Promise.all(work);
    layer.remove();
    flight.nodes.delete(layer);
  }

  function phase(name, label) {
    dom.svg.dataset.transferPhase = name;
    if (label) setStatus(t("rtTransfer", label));
  }

  // Spiritron transfer: charge in the pod → deconstruct into the gate → reconstruct at target.
  async function rayshift(flight, beacon, start, end) {
    beacon.style.transform = `translate(${start[0]}px, ${start[1]}px)`;
    phase("charge", t("rtPhaseCharge"));
    const charge = chargeField(flight, start);
    await play(flight, charge, [{ opacity: 0 }, { opacity: 0.7, offset: 0.65 }, { opacity: 0.5 }], 380);
    phase("deconstruct", t("rtPhaseDeconstruct"));
    await Promise.all([
      play(flight, beacon, [{ opacity: 1 }, { opacity: 0 }], 220),
      particles(flight, start, GATE, false),
      pulse(flight, GATE, false, true),
      play(flight, charge, [{ opacity: 0.5 }, { opacity: 0 }], 560),
    ]);
    charge.remove();
    flight.nodes.delete(charge);
    phase("reconstruct", t("rtPhaseReconstruct"));
    const destination = chargeField(flight, end);
    beacon.style.transform = `translate(${end[0]}px, ${end[1]}px)`;
    await Promise.all([
      particles(flight, end, end, true),
      play(flight, destination, [{ opacity: 0 }, { opacity: 0.65, offset: 0.65 }, { opacity: 0 }], 680),
    ]);
    destination.remove();
    flight.nodes.delete(destination);
    await play(flight, beacon, [{ opacity: 0 }, { opacity: 1 }], 170);
    phase("idle");
  }

  function beaconPoint(key, slots, id) {
    const i = slots[key].indexOf(id);
    const p = i < 0 ? MORE[key] : SLOTS[key][i];
    return [p[0], p[1] - (i < 0 ? 0 : BEACON_LIFT[key])];
  }

  function routeBetween(from, to, start, end) {
    if (from === "queued" && to === "running") return [start, GATE_ENTRY, GATE, [650, 280], end];
    if (from === "running" && to === "queued") return [start, [650, 280], GATE, GATE_ENTRY, end];
    if (to === "attention") return [start, [start[0], 460], [end[0], 504], end];
    if (from === "attention" && to === "running") return [start, [start[0], 505], [end[0], 442], end];
    return [start, [454, 508], [345, 465], end];
  }

  async function playIntro() {
    if (intro || !active || !api.getState().boardLoaded || reducedMotion()) {
      updateReplayButton();
      return;
    }
    const run = Object.assign(newFlight("intro", 9000), { revealed: new Set() });
    intro = run;
    hideTip();
    for (const node of dom.svg.querySelectorAll('[data-slot]:not([data-slot^="queued"])')) node.style.visibility = "hidden";
    updateReplayButton();
    try {
      for (const key of ["running", "attention"]) {
        setStatus(t(key === "running" ? "rtIntroRunning" : "rtIntroAttention"));
        for (let i = 0; i < PREVIEW_SLOTS; i++) {
          const card = cardById(featured[key][i]);
          if (!card) continue;
          const beacon = actor(run, card, key === "attention");
          const end = beaconPoint(key, featured, card.groupId);
          if (key === "running") await rayshift(run, beacon, GATE_ENTRY, end);
          else await play(run, beacon, pathFrames([[824, 390], [824, 477], [end[0], 510], end]), 560, { easing: "cubic-bezier(.4,0,.2,1)" });
          beacon.remove();
          run.nodes.delete(beacon);
          run.revealed.add(`${key}:${i}`);
          reveal(`${key}:${i}`);
        }
        run.revealed.add(`${key}:more`);
        reveal(`${key}:more`);
      }
    } catch {
      return; // cancelled: whoever cancelled already restored the scene
    }
    if (intro !== run) return;
    intro = null;
    disposeFlight(run);
    dom.svg.dataset.transferPhase = "idle";
    for (const node of dom.svg.querySelectorAll("[data-slot]")) reveal(node.dataset.slot);
    setStatus(t("rtStatusReady"));
    updateReplayButton();
  }

  function startMoves(moves) {
    // A burst of changes (reconnect, bulk actions) lands directly instead of queueing effects.
    if (reducedMotion() || moves.length > 3) return;
    for (const move of moves) {
      const card = cardById(move.id);
      if (!card) continue;
      const previous = flights.get(move.id);
      const start = previous?.end || beaconPoint(move.from, prevFeatured, move.id);
      if (previous) {
        flights.delete(move.id);
        disposeFlight(previous);
      }
      const end = beaconPoint(move.to, featured, move.id);
      const flight = Object.assign(newFlight(move.to, 4000), { end });
      flights.set(move.id, flight);
      const node = dom.svg.querySelector(`[data-group-id="${CSS.escape(move.id)}"]`);
      if (node) node.style.visibility = "hidden";
      void (async () => {
        const gold = move.to === "attention";
        const beacon = actor(flight, card, gold);
        try {
          if (move.from === "queued" && move.to === "running") await rayshift(flight, beacon, start, end);
          else {
            setStatus(t(gold ? "rtMoveAttention" : "rtMoveOther", api.getCardNumber(card), t(GROUP_LABEL[move.to])));
            await play(flight, beacon, pathFrames(routeBetween(move.from, move.to, start, end)), 1000, { easing: "cubic-bezier(.4,0,.2,1)" });
          }
          await pulse(flight, [end[0], end[1] + (gold ? 51 : 36)], gold);
        } catch {
          return;
        }
        if (flights.get(move.id) !== flight) return;
        flights.delete(move.id);
        disposeFlight(flight);
        dom.svg.dataset.transferPhase = "idle";
        revealTask(move.id);
        setStatus(t("rtLanded", api.getCardNumber(card), t(GROUP_LABEL[move.to])));
      })();
    }
  }

  // ---- Dialogs ---------------------------------------------------------------------------

  function openPanel(panel, origin, originKey) {
    hideTip();
    api.openOverlay({ panel, originKey }, origin);
    if (panel.type === "dispatch") api.getDialog().querySelector(".board-brief-input")?.focus();
  }

  function openArchive(tab, reason, origin, originKey) {
    openPanel({ type: "archive", tab, reason, query: "" }, origin, originKey);
  }

  function openSupport(section, origin, originKey, item = "") {
    if (section !== "agents") config.ensure(true);
    openPanel({ type: "support", section, item }, origin, originKey);
  }

  function openTask(card, origin) {
    hideTip();
    api.openOverlay({ groupId: card.groupId, originGroupId: card.groupId, originKey: `task:${card.groupId}`, tab: "overview" }, origin);
  }

  function sheet(kind, crumb, aside, main, footer = "") {
    return `<div class="rt-sheet rt-${kind}">
      <header class="rt-sheet-head">
        <span class="rt-crumb"><i aria-hidden="true">◆</i>${crumb}</span>
        <button type="button" class="rt-close" data-board-overlay-ui="close" aria-label="${th("close")}">&times;</button>
      </header>
      <div class="rt-sheet-grid">
        <aside class="rt-aside">${aside}</aside>
        <section class="rt-main">${main}</section>
      </div>
      ${footer}
    </div>`;
  }

  function statusChip(key) {
    const label = key === "done" ? t("boardColConfirmed") : key === "waiting" ? t("boardColDecision")
      : key === "delivered" ? t("boardColReview") : key === "failed" ? t("boardColFailed") : t(GROUP_LABEL[key] || "boardColQueued");
    return `<span class="rt-chip is-${api.escapeHtml(key)}">${api.escapeHtml(label)}</span>`;
  }

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" }) : "";
  }

  // Task dossier: archive sidebar, tabbed content, command area. Actions stay the shared ones.
  function taskMarkup(model, detail, card) {
    const e = api.escapeHtml;
    if (!card) {
      return sheet("dossier", "MISSION DOSSIER", `${EMBLEM}<p class="rt-aside-note">${th("boardTaskUnavailable")}</p>`,
        `<p class="rt-eyebrow">MISSION BRIEFING</p><h2 id="boardOverlayTitle" tabindex="-1">${e(model.title)}</h2>
         <div class="board-overlay-body"><p role="status">${th("boardTaskUnavailable")}</p></div>`);
    }
    const parts = model.parts;
    const info = card.board;
    const key = model.key;
    const number = api.getCardNumber(card);
    const tab = ["overview", "record", "deliverables"].includes(detail.tab) ? detail.tab : "overview";
    const tabs = [["overview", t("rtTabOverview")], ["record", t("rtTabRecord")], ["deliverables", t("rtTabDeliverables", parts.deliverableCount)]]
      .map(([id, label]) => `<button type="button" role="tab" class="rt-tab" aria-selected="${tab === id}" data-board-overlay-ui="rt-tab:${id}">${e(label)}</button>`).join("");
    const timeline = [
      [t("rtRecQueued"), info.queuedAt],
      [t("rtRecStarted"), info.startedAt],
      [t("rtRecDelivered"), info.deliveredAt],
      [t("rtRecClosed"), info.closedAt],
    ].filter(([, at]) => at).map(([label, at]) => `<li><span>${e(label)}</span><time>${e(formatTime(at))}</time></li>`).join("");
    const record = `
      <ol class="rt-timeline">${timeline}</ol>
      ${info.rejectCount ? `<p class="rt-note">${th("boardRejectCountBadge", info.rejectCount)}</p>` : ""}
      ${parts.progress || ""}`;
    const content = tab === "record" ? record
      : tab === "deliverables" ? (parts.deliverables || `<p class="rt-empty">${th("rtNoDeliverables")}</p>`)
      : `${parts.decision}${parts.failure}${parts.brief}${parts.rejectNote}${parts.directory}`;
    const commandTitle = { queued: "rtCmdQueued", running: "rtCmdRunning", waiting: "rtCmdWaiting", delivered: "rtCmdDelivered", failed: "rtCmdFailed", done: "rtCmdDone" }[key] || "rtCmdRunning";
    const aside = `${EMBLEM}
      <p class="rt-aside-project">${e(api.getProjectLabel(card.cwd))}</p>
      <p class="rt-aside-number">${e(number)}</p>
      <p class="rt-aside-note">${th("rtDossierNote")}</p>
      <dl class="rt-aside-meta"><dt>${th("lead")}</dt><dd>${e(api.getLeadLabel(card))}</dd><dt>${th("rtState")}</dt><dd>${statusChip(key)}</dd></dl>`;
    const main = `
      <div class="rt-dossier-body">
        <div class="rt-dossier-content">
          <p class="rt-eyebrow">MISSION BRIEFING</p>
          <h2 id="boardOverlayTitle" tabindex="-1">${e(model.title)}</h2>
          <div class="rt-meta">${statusChip(key)}<span><small>${th("lead")}</small>${e(api.getLeadLabel(card))}</span><span><small>${th("project")}</small>${e(api.getProjectLabel(card.cwd))}</span></div>
          <div class="rt-tabs" role="tablist">${tabs}</div>
          <div class="board-overlay-body rt-tabpanel" role="tabpanel">${content}</div>
        </div>
        <aside class="rt-command">
          <p class="rt-eyebrow is-gold">MASTER COMMAND</p>
          <h3>${th(commandTitle)}</h3>
          <p class="rt-command-hint">${e(parts.hint || "")}</p>
          ${parts.prompt}
          ${model.error ? `<p role="alert" class="board-publish-error board-overlay-error">${e(model.error)}</p>` : ""}
          <div class="board-card-actions rt-command-actions">${parts.actions}</div>
          <div class="board-card-actions rt-command-nav">${parts.workbench}${parts.back}</div>
        </aside>
      </div>`;
    return sheet("dossier", `MISSION DOSSIER / ${e(number)}`, aside, main);
  }

  function panelView(panel) {
    return `${panel.type}:${panel.type === "archive" ? "" : panel.section || ""}`;
  }

  function renderPanel(detail, dialog) {
    const panel = detail.panel;
    const view = panelView(panel);
    if (dialog.dataset.rtView !== view) {
      api.restorePublisher();
      dialog.dataset.rtView = view;
      dialog.innerHTML = panelShell(panel);
      if (panel.type === "dispatch") api.mountPublisher(dialog.querySelector(".rt-publish-host"));
      const search = dialog.querySelector(".rt-search");
      if (search) {
        search.value = panel.query || "";
        search.addEventListener("input", () => {
          panel.query = search.value;
          updateArchive(panel, dialog);
        });
      }
    }
    if (panel.type === "archive") updateArchive(panel, dialog);
    if (panel.type === "support") updateSupport(panel, dialog);
  }

  function panelShell(panel) {
    if (panel.type === "dispatch") {
      return sheet("dispatch", `NEW MISSION / ${th("rtDispatchTitle")}`,
        `${EMBLEM}<h3 class="rt-aside-title">${th("rtDispatchTitle")}</h3><p class="rt-aside-note">${th("rtDispatchNote")}</p>
         <ol class="rt-steps"><li class="is-current">${th("rtStepFill")}</li><li>${th("rtStepQueue")}</li><li>${th("rtStepRun")}</li></ol>`,
        `<p class="rt-eyebrow">MISSION REGISTRATION</p>
         <h2 id="boardOverlayTitle" tabindex="-1">${th("rtDispatch")}</h2>
         <p class="rt-note">${th("classicPublishNote")}</p>
         <div class="board-overlay-body rt-publish-host"></div>
         <div class="rt-destination"><p class="rt-eyebrow">DESTINATION</p><strong>${th("rtDestination")}</strong><span>${th("rtDestinationNote")}</span></div>`);
    }
    if (panel.type === "support") {
      return sheet("support", `CHALDEA SUPPORT / ${th("rtSupportTitle")}`,
        `<p class="rt-eyebrow">SUPPORT TERMINAL</p><h3 class="rt-aside-title">${th("rtSupportTitle")}</h3>
         <nav class="rt-support-nav" data-rt-panel="nav"></nav>`,
        `<p class="rt-eyebrow" data-rt-panel="eyebrow"></p>
         <h2 id="boardOverlayTitle" tabindex="-1"><span data-rt-panel="title"></span><small data-rt-panel="count"></small></h2>
         <p class="rt-note" data-rt-panel="note"></p>
         <div class="board-overlay-body rt-support-body" data-rt-panel="body"></div>`,
        `<footer class="rt-sheet-foot"><span data-rt-panel="foot"></span><button type="button" class="rt-btn" data-rt-ui="settings">${th("classicOpenSettings")}</button></footer>`);
    }
    return sheet("archive", `MISSION ARCHIVE / ${th("rtArchiveTitle")}`,
      `${EMBLEM}<h3 class="rt-aside-title">${th("rtArchiveTitle")}</h3><p class="rt-aside-note">${th("rtArchiveNote")}</p>
       <div class="rt-aside-total"><span>${th("rtActiveTasks")}</span><strong data-rt-panel="active"></strong><small data-rt-panel="scope"></small></div>`,
      `<p class="rt-eyebrow">MISSION ARCHIVE</p>
       <h2 id="boardOverlayTitle" tabindex="-1"><span data-rt-panel="title"></span><small data-rt-panel="count"></small></h2>
       <div class="rt-archive-bar">
         <div class="rt-tabs" role="tablist" data-rt-panel="tabs"></div>
         <input class="rt-search" type="search" autocomplete="off" placeholder="${th("rtArchiveSearch")}" aria-label="${th("rtArchiveSearch")}" />
       </div>
       <div class="rt-chips" data-rt-panel="chips"></div>
       <div class="rt-table-head" aria-hidden="true"><span>${th("rtColNumber")}</span><span>${th("rtColTask")}</span><span>${th("lead")}</span><span>${th("rtColState")}</span></div>
       <div class="board-overlay-body rt-rows" data-rt-panel="rows"></div>
       <p class="rt-note rt-archive-foot" data-rt-panel="foot"></p>`);
  }

  function rowSearchText(card) {
    return [api.getCardTitle(card), api.getCardNumber(card), card.groupId, api.getProjectLabel(card.cwd), card.cwd, api.getLeadLabel(card), reasonText(card), card.board.failReason]
      .filter(Boolean).join(" ").toLocaleLowerCase();
  }

  function setText(dialog, name, text) {
    const node = dialog.querySelector(`[data-rt-panel="${name}"]`);
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setHtml(dialog, name, html) {
    const node = dialog.querySelector(`[data-rt-panel="${name}"]`);
    if (!node || node.dataset.markup === html) return node;
    const focusedUi = node.contains(document.activeElement) ? document.activeElement.dataset.rtUi + "|" + (document.activeElement.dataset.value || document.activeElement.dataset.boardTask || "") : "";
    const scroll = node.scrollTop;
    node.innerHTML = html;
    node.dataset.markup = html;
    node.scrollTop = scroll;
    if (focusedUi) {
      const [ui, value] = focusedUi.split("|");
      const target = [...node.querySelectorAll(`[data-rt-ui="${CSS.escape(ui)}"]`)].find((item) => (item.dataset.value || item.dataset.boardTask || "") === value);
      target?.focus({ preventScroll: true });
    }
    return node;
  }

  function updateArchive(panel, dialog) {
    const e = api.escapeHtml;
    const tabKeys = [...CLASSIC_GROUPS, "done"];
    const tab = tabKeys.includes(panel.tab) ? panel.tab : "queued";
    const cards = tab === "done" ? model.done : model.groups[tab];
    const byReason = tab === "attention" && panel.reason ? cards.filter((card) => attentionReason(card) === panel.reason) : cards;
    const query = String(panel.query || "").trim().toLocaleLowerCase();
    const list = query ? byReason.filter((card) => rowSearchText(card).includes(query)) : byReason;
    const label = (key) => (key === "done" ? t("rtFinishedTab") : t(GROUP_LABEL[key]));
    setText(dialog, "title", label(tab));
    setText(dialog, "count", t("classicTaskCount", cards.length));
    setText(dialog, "active", pad2(model.active));
    setText(dialog, "scope", api.getProject() ? api.getProjectLabel(config.currentScope()) : t("boardAllProjects"));
    setHtml(dialog, "tabs", tabKeys.map((key) => {
      const n = key === "done" ? model.done.length : model.groups[key].length;
      return `<button type="button" role="tab" class="rt-tab" aria-selected="${key === tab}" data-rt-ui="archive-tab" data-value="${key}">${e(label(key))}<small>${n}</small></button>`;
    }).join(""));
    setHtml(dialog, "chips", tab === "attention" ? ["", ...ATTENTION_REASONS].map((reason) => {
      const n = reason ? model.reasons[reason] : cards.length;
      return `<button type="button" class="rt-chip-btn" aria-pressed="${(panel.reason || "") === reason}" data-rt-ui="reason" data-value="${reason}">${e(reason ? t(REASON_LABEL[reason]) : t("classicAllReasons"))} ${n}</button>`;
    }).join("") : "");
    setHtml(dialog, "rows", list.length ? list.map((card) => {
      const reason = attentionReason(card);
      const state = reason ? `<span class="rt-chip is-${reason}">${e(reasonText(card))}</span>` : statusChip(tab === "done" ? "done" : tab);
      return `<button type="button" class="rt-row" data-rt-ui="open-task" data-board-task="${e(card.groupId)}">
        <span class="rt-row-id">${e(api.getCardNumber(card))}</span>
        <span class="rt-row-title"><b>${e(api.getCardTitle(card))}</b><small title="${e(card.cwd || "")}">${e(api.getProjectLabel(card.cwd))}</small></span>
        <span class="rt-row-agent">◇ ${e(api.getLeadLabel(card))}</span>
        <span class="rt-row-state">${state}</span></button>`;
    }).join("") : `<p class="rt-empty">${th(cards.length ? "classicNoMatches" : tab === "done" ? "rtFinishedEmpty" : "boardEmptyColumn")}</p>`);
    setText(dialog, "foot", t("rtShowing", list.length, cards.length));
  }

  function excludedText(reason, item) {
    if (reason === "untrusted") return t("classicWhyUntrusted");
    if (reason === "missingEnv") return t("classicWhyMissingEnv", (item.missingEnv || []).join(", "));
    return t("classicWhyDisabled");
  }

  function itemId(section, item) {
    return section === "agents" ? item.agent : item.id;
  }

  function itemName(section, item) {
    return section === "agents" ? api.agentName(item.agent) || item.label || item.agent : item.name;
  }

  function itemSubtitle(section, item) {
    if (section === "agents") {
      return t(!item.available ? "classicAgentMissing" : item.authReady ? "classicAgentReady" : "classicAgentNoAuth");
    }
    if (section === "mcp") return `${item.source} · ${item.transport}`;
    return item.scope === "project" ? t("project") : t("global");
  }

  function names(list) {
    return (list || []).map((id) => api.agentName(id) || id).join(", ");
  }

  // Configuration details. Never prints env/header values, commands or URLs of MCP servers.
  function itemDetail(section, item, reasons) {
    const e = api.escapeHtml;
    const rows = [];
    if (section === "agents") {
      rows.push([t("rtFieldId"), item.agent], [t("rtFieldHealth"), itemSubtitle(section, item)]);
      if (item.defaultModel) rows.push([t("rtFieldModel"), item.defaultModel]);
      if (item.authHint && !item.authReady) rows.push([t("rtFieldAuth"), item.authHint]);
      rows.push([t("rtFieldKind"), item.builtin ? t("rtBuiltin") : t("rtCustom")]);
    } else if (section === "mcp") {
      rows.push([t("rtFieldSource"), item.source], [t("rtFieldTransport"), item.transport], [t("rtFieldRoles"), (item.roles || []).join(" / ")]);
      if (item.nativeAgents?.length) rows.push([t("rtFieldNative"), names(item.nativeAgents)]);
      if (item.disabledAgents?.length) rows.push([t("rtFieldOffFor"), names(item.disabledAgents)]);
      rows.push([t("rtFieldTrusted"), item.trusted ? t("rtYes") : t("rtNo")]);
      if (item.missingEnv?.length) rows.push([t("rtFieldMissing"), item.missingEnv.join(", ")]);
    } else {
      rows.push([t("rtFieldScope"), itemSubtitle(section, item)], [t("rtFieldKind"), section === "rules" ? t("rtRule") : t("rtSkill")]);
      if (item.origin) rows.push([t("rtFieldSource"), item.origin]);
      if (item.nativeAgents?.length) rows.push([t("rtFieldNative"), names(item.nativeAgents)]);
      if (item.bridgedAgents?.length) rows.push([t("rtFieldBridged"), names(item.bridgedAgents)]);
      if (item.disabledAgents?.length) rows.push([t("rtFieldOffFor"), names(item.disabledAgents)]);
      if (item.primaryPath) rows.push([t("rtFieldPath"), item.primaryPath]);
    }
    return `<div class="rt-detail">
      <p class="rt-eyebrow">CONFIGURATION</p>
      <h3>${e(itemName(section, item))}</h3>
      ${reasons?.length ? `<p class="rt-why">${e(reasons.map((r) => excludedText(r, item)).join(" · "))}</p>` : ""}
      <dl>${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl>
      ${item.description ? `<p class="rt-detail-desc">${e(item.description)}</p>` : ""}
    </div>`;
  }

  function updateSupport(panel, dialog) {
    const e = api.escapeHtml;
    const section = SUPPORT[panel.section] ? panel.section : "agents";
    const counts = config.counts();
    setHtml(dialog, "nav", CONFIG_KEYS.map((key) => {
      const n = counts[key].value === null ? "—" : pad2(counts[key].value);
      return `<button type="button" class="rt-nav-item" aria-current="${key === section}" data-rt-ui="section" data-value="${key}"><span>${e(t(SUPPORT[key].label))}</span><b>${n}</b></button>`;
    }).join(""));
    const { status, error, summary } = config.summarize(section);
    setText(dialog, "eyebrow", { agents: "AGENT ROSTER", resources: "ARCHIVE", rules: "PROTOCOL", mcp: "COMMUNICATION" }[section]);
    setText(dialog, "title", t(SUPPORT[section].label));
    setText(dialog, "count", summary ? String(summary.included.length) : "—");
    setText(dialog, "note", t({ agents: "classicAgentsNote", resources: "classicResourcesNote", rules: "classicRulesNote", mcp: "classicMcpNote" }[section]));
    setText(dialog, "foot", section === "agents" ? t("rtScopeHub") : t("classicModuleScopeLine", config.scope || "—"));
    const included = summary?.included || [];
    const excluded = summary?.excluded || [];
    const all = [...included.map((item) => ({ item, reasons: null })), ...excluded];
    const selected = all.find(({ item }) => itemId(section, item) === panel.item) || all[0];
    let state = "";
    if (status === "loading" && !summary) state = `<p class="rt-note" role="status">${th("classicLoading")}</p>`;
    if (status === "error") {
      state = `<div class="rt-error" role="alert"><span>${th("classicLoadFailedDetail", error)}</span><button type="button" class="rt-btn" data-rt-ui="retry">${th("classicRetry")}</button></div>${summary ? `<p class="rt-note">${th("classicStaleNote")}</p>` : ""}`;
    }
    const item = (entry) => {
      const id = itemId(section, entry.item);
      return `<button type="button" class="rt-item${entry.reasons ? " is-excluded" : ""}" aria-current="${selected && itemId(section, selected.item) === id}" data-rt-ui="item" data-value="${e(id)}">
        <span><b>${e(itemName(section, entry.item))}</b><small>${e(entry.reasons ? entry.reasons.map((r) => excludedText(r, entry.item)).join(" · ") : itemSubtitle(section, entry.item))}</small></span><i aria-hidden="true">›</i></button>`;
    };
    const lists = summary ? `
      <div class="rt-items">
        ${included.length ? included.map((item) => ({ item, reasons: null })).map(item).join("") : `<p class="rt-empty">${th("classicEmptyModule")}</p>`}
        ${excluded.length ? `<p class="rt-items-label">${th("classicExcluded", excluded.length)}</p>${excluded.map(item).join("")}` : ""}
      </div>
      ${selected ? itemDetail(section, selected.item, selected.reasons) : `<div class="rt-detail"><p class="rt-empty">${th("classicEmptyModule")}</p></div>`}` : "";
    setHtml(dialog, "body", `${state}<div class="rt-support-split">${lists}</div>`);
  }

  function onOverlayClick(event) {
    const detail = api.getOverlay();
    if (!detail) return false;
    const tabControl = event.target.closest('[data-board-overlay-ui^="rt-tab:"]');
    if (tabControl && detail.groupId) {
      detail.tab = tabControl.dataset.boardOverlayUi.slice("rt-tab:".length);
      api.renderOverlay();
      return true;
    }
    const control = event.target.closest("[data-rt-ui]");
    if (!control || !detail.panel) return false;
    const ui = control.dataset.rtUi;
    const value = control.dataset.value ?? "";
    if (ui === "open-task") {
      detail.groupId = control.dataset.boardTask;
      detail.tab = "overview";
      api.renderOverlay();
      api.getDialog().querySelector("#boardOverlayTitle")?.focus();
    } else if (ui === "archive-tab") {
      Object.assign(detail.panel, { tab: value, reason: "" });
      api.renderOverlay();
    } else if (ui === "reason") {
      detail.panel.reason = value;
      api.renderOverlay();
    } else if (ui === "section") {
      Object.assign(detail.panel, { section: value, item: "" });
      if (value !== "agents") config.ensure(false);
      api.renderOverlay();
    } else if (ui === "item") {
      detail.panel.item = value;
      api.renderOverlay();
    } else if (ui === "retry") {
      config.ensure(true);
      api.renderOverlay();
    } else if (ui === "settings") {
      const tab = SUPPORT[detail.panel.section]?.tab || "agents";
      api.closeOverlay();
      api.openSettings(tab);
    }
    return true;
  }

  // ---- Dialog motion and focus return ----------------------------------------------------

  function animateOpen(dialog, origin) {
    if (reducedMotion() || !origin?.getBoundingClientRect) return;
    const from = origin.getBoundingClientRect();
    const to = dialog.getBoundingClientRect();
    dialog.animate([
      { transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(.08)`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: 330, easing: "cubic-bezier(.16,1,.3,1)" });
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
    const task = id && find(`task:${id}`);
    if (task) return task;
    const key = id && categoryIndex(model).get(id);
    return find(detail.originKey) || (key === "done" ? find("finished") : key && (find(`more:${key}`) || find(`zone:${key}`))) || dom.stage;
  }

  async function closeOverlay(dialog, detail, animate) {
    const target = focusTarget(detail);
    if (animate && target && !reducedMotion() && dialog.open) {
      const from = dialog.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const anim = dialog.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(.08)`, opacity: 0 },
      ], { duration: 240, easing: "ease-in", fill: "forwards" });
      closing = anim;
      // A hidden or throttled page may not advance frames; never leave the dialog open.
      const guard = setTimeout(() => anim.playState === "running" && anim.finish(), 450);
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
    delete dialog.dataset.rtView;
    if (target === dom.stage) dom.stage.tabIndex = -1;
    target?.focus({ preventScroll: true });
  }

  // ---- Publishing ------------------------------------------------------------------------

  function onPublished(ids) {
    for (const id of ids) pendingPins.add(id);
    pendingFocusId = ids[0] || "";
    api.renderBody();
    setStatus(t("classicStatusPublished", ids.length));
    const detail = api.getOverlay();
    if (detail?.panel?.type === "dispatch") {
      detail.focusKey = pendingFocusId ? `task:${pendingFocusId}` : "";
      api.closeOverlay({ animate: true });
    }
  }

  function focusPublished() {
    if (api.getOverlay()) return;
    const node = dom.svg.querySelector(`[data-scene-key="task:${CSS.escape(pendingFocusId)}"]`);
    if (!node) return;
    pendingFocusId = "";
    const current = document.activeElement;
    if (!current || current === document.body || current.closest?.('[data-scene-key="intake"]')) node.focus({ preventScroll: true });
  }

  return {
    render,
    deactivate,
    renderPanel,
    taskMarkup,
    onOverlayClick,
    animateOpen,
    cancelClosing,
    closeOverlay,
    onPublished,
    onConfigChanged() {
      if (active) config.ensure(true);
    },
    // Exposed for browser checks only.
    debug: () => ({
      model,
      featured,
      intro: Boolean(intro),
      flights: [...flights.keys()],
      phase: dom.svg?.dataset.transferPhase || "idle",
      fxNodes: (dom.fx?.childElementCount || 0) + (dom.flight?.childElementCount || 0),
      scope: config.scope,
    }),
  };
}

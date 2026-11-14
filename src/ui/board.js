import { apiFetch, displayTaskTitle, t, th } from "./i18n.js";

let nextDraftId = 1;

const BOARD_STATE = {
  mounted: false,
  drafts: [{ id: nextDraftId++, text: "" }],
  cwd: "",
  cwdTouched: false,
  leadAgent: "",
  leadTouched: false,
  common: "",
  moreOpen: false,
  confirmedOpen: false,
  submitting: false,
  errorText: "",
  actionBusyIds: new Set(),
};

const dom = {
  screen: null,
  titleEl: null,
  slotsPill: null,
  memPill: null,
  settingsBtn: null,
  settingsLabel: null,
  workbenchBtn: null,
  workbenchLabel: null,
  briefList: null,
  addBriefBtn: null,
  cwdLabel: null,
  cwdInput: null,
  browseBtn: null,
  publishBtn: null,
  errorEl: null,
  moreDetails: null,
  moreSummary: null,
  leadLabel: null,
  leadChips: null,
  commonLabel: null,
  commonInput: null,
  columnsWrap: null,
};

function getApp() {
  return window.HUB_APP || {};
}

function getHubState() {
  return getApp().getState?.() || {};
}

function escapeHtml(value) {
  const fn = getApp().escapeHtml;
  if (typeof fn === "function") return fn(value);
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveDefaultCwd(state) {
  const firstProject = Array.isArray(state.projects) && state.projects[0]?.path ? String(state.projects[0].path).trim() : "";
  if (firstProject) return firstProject;
  const recentProject = Array.isArray(state.settings?.recentProjects) && state.settings.recentProjects[0]?.path
    ? String(state.settings.recentProjects[0].path).trim()
    : "";
  if (recentProject) return recentProject;
  return String(state.baseCwd || "").trim();
}

function getAgentId(item) {
  return item?.agent || item?.id || "";
}

function resolveDefaultLead(state) {
  const enabled = getApp().getEnabledAgents?.() || state.agents || [];
  const defaultLead = state.defaultLead || "claude";
  if (enabled.some((a) => getAgentId(a) === defaultLead && a.enabled !== false)) {
    return defaultLead;
  }
  const firstEnabled = enabled.find((a) => a.enabled !== false);
  return getAgentId(firstEnabled) || defaultLead;
}

function syncDefaultsFromState() {
  const state = getHubState();
  if (!BOARD_STATE.cwdTouched) {
    const fallbackCwd = resolveDefaultCwd(state);
    if (fallbackCwd && BOARD_STATE.cwd !== fallbackCwd) {
      BOARD_STATE.cwd = fallbackCwd;
      if (dom.cwdInput && document.activeElement !== dom.cwdInput) {
        dom.cwdInput.value = fallbackCwd;
      }
    }
  }
  const enabled = getApp().getEnabledAgents?.() || (Array.isArray(state.agents) ? state.agents.filter((a) => a.enabled !== false) : []);
  if (!BOARD_STATE.leadTouched || (BOARD_STATE.leadAgent && enabled.length && !enabled.some((a) => getAgentId(a) === BOARD_STATE.leadAgent))) {
    const nextLead = resolveDefaultLead(state);
    if (nextLead) BOARD_STATE.leadAgent = nextLead;
  }
}

function countNonEmptyBriefs() {
  let count = 0;
  for (const item of BOARD_STATE.drafts) {
    if (String(item.text || "").trim()) count++;
  }
  return count;
}

function updatePublishButtonLabel() {
  if (!dom.publishBtn) return;
  const count = countNonEmptyBriefs();
  dom.publishBtn.textContent = count > 1 ? t("boardPublishCount", count) : t("boardPublishAction");
  dom.publishBtn.disabled = BOARD_STATE.submitting;
}

function updateErrorBanner() {
  if (!dom.errorEl) return;
  const msg = String(BOARD_STATE.errorText || "").trim();
  dom.errorEl.textContent = msg;
  dom.errorEl.hidden = !msg;
}

function renderBriefRows(focusDraftId = null) {
  if (!dom.briefList) return;
  const existingRows = new Map();
  for (const row of dom.briefList.querySelectorAll(".board-brief-row")) {
    const id = Number(row.dataset.draftId);
    if (Number.isFinite(id)) existingRows.set(id, row);
  }

  const canRemove = BOARD_STATE.drafts.length > 1;
  const orderedNodes = [];

  for (let idx = 0; idx < BOARD_STATE.drafts.length; idx++) {
    const draft = BOARD_STATE.drafts[idx];
    let row = existingRows.get(draft.id);
    if (!row) {
      row = document.createElement("div");
      row.className = "board-brief-row";
      row.dataset.draftId = String(draft.id);

      const indexBadge = document.createElement("span");
      indexBadge.className = "board-brief-index";

      const textarea = document.createElement("textarea");
      textarea.className = "text-area board-brief-input";
      textarea.rows = 2;
      textarea.value = draft.text;
      textarea.addEventListener("input", () => {
        draft.text = textarea.value;
        if (BOARD_STATE.errorText) {
          BOARD_STATE.errorText = "";
          updateErrorBanner();
        }
        updatePublishButtonLabel();
      });
      textarea.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void handlePublish();
        }
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "board-brief-remove";
      removeBtn.innerHTML = "&times;";
      removeBtn.addEventListener("click", () => {
        if (BOARD_STATE.drafts.length <= 1) return;
        BOARD_STATE.drafts = BOARD_STATE.drafts.filter((item) => item.id !== draft.id);
        renderBriefRows();
        updatePublishButtonLabel();
      });

      row.append(indexBadge, textarea, removeBtn);
    }

    const indexBadge = row.querySelector(".board-brief-index");
    if (indexBadge) {
      indexBadge.textContent = String(idx + 1);
      indexBadge.hidden = !canRemove;
    }

    const textarea = row.querySelector(".board-brief-input");
    if (textarea) {
      const placeholder = t("boardPublishPlaceholder");
      if (textarea.placeholder !== placeholder) textarea.placeholder = placeholder;
      if (document.activeElement !== textarea && textarea.value !== draft.text) {
        textarea.value = draft.text;
      }
      textarea.disabled = BOARD_STATE.submitting;
    }

    const removeBtn = row.querySelector(".board-brief-remove");
    if (removeBtn) {
      const title = t("boardRemoveItem");
      removeBtn.title = title;
      removeBtn.setAttribute("aria-label", title);
      removeBtn.hidden = !canRemove;
      removeBtn.disabled = BOARD_STATE.submitting;
    }

    orderedNodes.push(row);
  }

  // Remove stale rows
  for (const [id, row] of existingRows.entries()) {
    if (!BOARD_STATE.drafts.some((d) => d.id === id)) {
      row.remove();
    }
  }

  // Ensure DOM order matches drafts without disturbing focused element
  orderedNodes.forEach((node, idx) => {
    if (dom.briefList.children[idx] !== node) {
      dom.briefList.insertBefore(node, dom.briefList.children[idx] || null);
    }
  });

  if (focusDraftId !== null) {
    const targetRow = dom.briefList.querySelector(`.board-brief-row[data-draft-id="${focusDraftId}"] .board-brief-input`);
    targetRow?.focus();
  }
}

function renderLeadAgentPicker() {
  if (!dom.leadChips) return;
  const state = getHubState();
  const enabledAgents = getApp().getEnabledAgents?.() || (Array.isArray(state.agents) ? state.agents.filter((a) => a.enabled !== false) : []);
  dom.leadChips.innerHTML = "";

  for (const item of enabledAgents) {
    const agentId = getAgentId(item);
    if (!agentId) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    const active = agentId === BOARD_STATE.leadAgent;
    btn.className = `agent-chip ${active ? "active" : ""}`;
    btn.dataset.agent = agentId;
    getApp().applyAgentColorVar?.(btn, agentId);
    const label = getApp().agentName?.(agentId) || item.label || item.name || agentId;
    btn.innerHTML = `<span class="dot"></span><span>${escapeHtml(label)}</span>`;
    btn.addEventListener("click", () => {
      BOARD_STATE.leadAgent = agentId;
      BOARD_STATE.leadTouched = true;
      renderLeadAgentPicker();
    });
    dom.leadChips.appendChild(btn);
  }
}

async function handleBrowseDirectory() {
  const app = getApp();
  const initialDir = (dom.cwdInput?.value || BOARD_STATE.cwd || "").trim();
  try {
    let picked = null;
    if (typeof app.pickDirectoryDialog === "function") {
      picked = await app.pickDirectoryDialog(initialDir);
    } else {
      const res = await apiFetch("/api/workspace/pick-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialDir }),
      });
      const data = await res.json();
      if (data?.ok && data.path) picked = data.path;
    }
    if (picked) {
      BOARD_STATE.cwd = picked;
      BOARD_STATE.cwdTouched = true;
      if (dom.cwdInput) dom.cwdInput.value = picked;
    }
  } catch (err) {
    BOARD_STATE.errorText = err?.message || String(err);
    updateErrorBanner();
  }
}

async function handlePublish() {
  if (BOARD_STATE.submitting) return;
  const cwd = (dom.cwdInput ? dom.cwdInput.value : BOARD_STATE.cwd).trim();
  BOARD_STATE.cwd = cwd;
  const leadAgent = BOARD_STATE.leadAgent || resolveDefaultLead(getHubState());
  const common = (dom.commonInput ? dom.commonInput.value : BOARD_STATE.common).trim();
  BOARD_STATE.common = common;

  const nonEmptyBriefs = BOARD_STATE.drafts
    .map((d) => String(d.text || "").trim())
    .filter(Boolean);

  if (!nonEmptyBriefs.length) {
    BOARD_STATE.errorText = t("boardPublishPlaceholder");
    updateErrorBanner();
    const firstInput = dom.briefList?.querySelector(".board-brief-input");
    firstInput?.focus();
    return;
  }

  BOARD_STATE.submitting = true;
  BOARD_STATE.errorText = "";
  updateErrorBanner();
  renderBriefRows();
  updatePublishButtonLabel();

  try {
    const items = nonEmptyBriefs.map((brief) => ({
      brief,
      cwd: cwd || undefined,
      leadAgent: leadAgent || undefined,
    }));
    const res = await apiFetch("/api/board/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        common: common || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    // Reset drafts on success while preserving chosen cwd and leadAgent
    BOARD_STATE.drafts = [{ id: nextDraftId++, text: "" }];
    BOARD_STATE.common = "";
    if (dom.commonInput) dom.commonInput.value = "";
    BOARD_STATE.errorText = "";
  } catch (err) {
    BOARD_STATE.errorText = err?.message || String(err);
  } finally {
    BOARD_STATE.submitting = false;
    updateErrorBanner();
    renderBriefRows();
    updatePublishButtonLabel();
  }
}

async function handleCardAction(card, action) {
  if (!card?.groupId || BOARD_STATE.actionBusyIds.has(card.groupId)) return;
  let note;
  if (action === "reject") {
    const showPrompt = getApp().showPromptModal;
    const rawNote = typeof showPrompt === "function"
      ? await showPrompt({
        title: t("boardRejectPromptTitle"),
        message: t("boardRejectPromptMsg"),
        placeholder: t("boardRejectPromptMsg"),
      })
      : window.prompt(t("boardRejectPromptMsg"), "");
    if (rawNote === null) return;
    note = String(rawNote || "").trim();
    if (!note) return;
  }

  BOARD_STATE.actionBusyIds.add(card.groupId);
  renderColumns();
  try {
    const res = await apiFetch("/api/board/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: card.groupId,
        action,
        note,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    BOARD_STATE.errorText = err?.message || String(err);
    updateErrorBanner();
  } finally {
    BOARD_STATE.actionBusyIds.delete(card.groupId);
    renderColumns();
  }
}

function getCardTitle(card) {
  if (typeof card?.defaultTitleNumber === "number") {
    return t("numberedTask", card.defaultTitleNumber);
  }
  const state = getHubState();
  const group = state.taskGroups?.get?.(card?.groupId) || null;
  if (typeof group?.defaultTitleNumber === "number") {
    return t("numberedTask", group.defaultTitleNumber);
  }
  return displayTaskTitle(card || {});
}

function getShortCwd(cwd) {
  const cleaned = String(cwd || "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "";
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function getWaitingBadgeInfo(card) {
  const reason = card?.waitingReason || (card?.board?.interrupted ? "interrupted" : card?.board?.stalled ? "stalled" : "question");
  if (reason === "permission") {
    return { text: t("boardWaitPermission"), cls: "is-permission" };
  }
  if (reason === "interrupted") {
    return { text: t("boardWaitInterrupted"), cls: "is-interrupted" };
  }
  if (reason === "stalled") {
    return { text: t("boardWaitStalled"), cls: "is-stalled" };
  }
  return { text: t("boardWaitQuestion"), cls: "is-question" };
}

function createCardElement(card, columnKey) {
  const el = document.createElement("article");
  const isDone = card?.board?.status === "done";
  const isBusy = BOARD_STATE.actionBusyIds.has(card.groupId);
  el.className = `board-card is-${columnKey}${isDone ? " is-done" : ""}${isBusy ? " is-busy" : ""}`;
  el.tabIndex = 0;
  el.setAttribute("role", "button");

  const title = getCardTitle(card);
  const leadBadgeHtml = getApp().agentTagHtml?.(card.leadAgent) || `<span class="agent-tag">${escapeHtml(card.leadAgent || "")}</span>`;
  const folderName = getShortCwd(card.cwd);
  const rejectCount = Number(card?.board?.rejectCount) || 0;
  const brief = String(card?.board?.brief || "").trim();
  const summary = String(card?.board?.summary || "").trim();
  const failReason = String(card?.board?.failReason || "").trim();
  const deliverables = Array.isArray(card?.board?.deliverables) ? card.board.deliverables : [];

  let badgesHtml = "";
  if (columnKey === "waiting") {
    const waitInfo = getWaitingBadgeInfo(card);
    badgesHtml += `<span class="board-wait-badge ${waitInfo.cls}">${escapeHtml(waitInfo.text)}</span>`;
  }
  if (rejectCount > 0) {
    badgesHtml += `<span class="board-reject-badge">${escapeHtml(t("boardRejectCountBadge", rejectCount))}</span>`;
  }

  let extraBodyHtml = "";
  if ((columnKey === "delivered" || isDone) && summary) {
    extraBodyHtml += `<div class="board-card-summary">${escapeHtml(summary)}</div>`;
  }
  if ((columnKey === "delivered" || isDone) && deliverables.length > 0) {
    const itemsHtml = deliverables
      .slice(0, 4)
      .map((item) => {
        const label = item.path || item.note || item.kind;
        return `<li class="board-deliverable-item" title="${escapeHtml(label)}">${escapeHtml(label)}</li>`;
      })
      .join("");
    extraBodyHtml += `
      <div class="board-card-deliverables">
        <div class="board-deliverables-count">${escapeHtml(t("boardDeliverablesCount", deliverables.length))}</div>
        <ul class="board-deliverables-list">${itemsHtml}</ul>
      </div>
    `;
  }
  if (columnKey === "failed" && failReason) {
    extraBodyHtml += `<div class="board-card-fail-reason">${escapeHtml(failReason)}</div>`;
  }

  // Action buttons per D3 spec
  const actions = [];
  const status = card?.board?.status;
  const isInterrupted = card?.waitingReason === "interrupted" || Boolean(card?.board?.interrupted);

  if (status === "delivered") {
    actions.push({ action: "confirm", label: t("boardActionConfirm"), cls: "is-primary" });
    actions.push({ action: "reject", label: t("boardActionReject"), cls: "is-warning" });
  } else if (status === "failed") {
    actions.push({ action: "retry", label: t("boardActionRetry"), cls: "is-primary" });
  } else if (status === "running") {
    if (isInterrupted) {
      actions.push({ action: "resume", label: t("boardActionResume"), cls: "is-primary" });
    }
    actions.push({ action: "cancel", label: t("boardActionCancel"), cls: "is-danger" });
  } else if (status === "queued") {
    actions.push({ action: "cancel", label: t("boardActionCancel"), cls: "is-danger" });
  }

  const actionsHtml = actions.length
    ? `<div class="board-card-actions">${actions
      .map(
        (btn) =>
          `<button type="button" class="board-card-btn ${btn.cls}" data-board-action="${btn.action}" ${isBusy ? "disabled" : ""}>${escapeHtml(btn.label)}</button>`
      )
      .join("")}</div>`
    : "";

  el.innerHTML = `
    <div class="board-card-top">
      <div class="board-card-title">${escapeHtml(title)}</div>
      ${leadBadgeHtml}
    </div>
    <div class="board-card-meta">
      ${folderName ? `<span class="board-card-cwd" title="${escapeHtml(card.cwd || "")}">${escapeHtml(folderName)}</span>` : ""}
      ${badgesHtml}
    </div>
    ${brief ? `<div class="board-card-brief">${escapeHtml(brief)}</div>` : ""}
    ${extraBodyHtml}
    ${actionsHtml}
  `;

  el.querySelectorAll("[data-board-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.getAttribute("data-board-action");
      if (action) void handleCardAction(card, action);
    });
  });

  const openCardInWorkbench = () => {
    const app = getApp();
    app.selectGroup?.(card.groupId, `lead:${card.groupId}`);
    app.setScreenMode?.("workbench");
  };

  el.addEventListener("click", openCardInWorkbench);
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openCardInWorkbench();
    }
  });

  return el;
}

function renderTopbar() {
  const state = getHubState();
  const cards = Array.isArray(state.boardCards) ? state.boardCards : [];
  const activeRunningCount = cards.filter((c) => c?.board?.status === "running" && !c?.waiting).length;
  const maxParallel = Number(state.settings?.boardParallel) || 2;

  if (dom.titleEl) dom.titleEl.textContent = t("taskBoard");
  if (dom.slotsPill) {
    dom.slotsPill.textContent = t("boardRunningSlots", activeRunningCount, maxParallel);
    dom.slotsPill.classList.toggle("is-active", activeRunningCount > 0);
  }
  if (dom.memPill) {
    const mem = state.memory;
    if (mem?.level && mem.level !== "ok") {
      const gb = ((mem.availableMB || 0) / 1024).toFixed(1);
      dom.memPill.hidden = false;
      dom.memPill.className = `board-mem-pill mem-${mem.level}`;
      dom.memPill.textContent = mem.level === "critical" ? t("memoryCritical", gb) : t("memoryLow", gb);
      dom.memPill.title = t("memoryWarning", gb);
    } else {
      dom.memPill.hidden = true;
    }
  }
  if (dom.settingsBtn) {
    const label = t("settings");
    dom.settingsBtn.title = label;
    dom.settingsBtn.setAttribute("aria-label", label);
  }
  if (dom.settingsLabel) dom.settingsLabel.textContent = t("settings");
  if (dom.workbenchLabel) dom.workbenchLabel.textContent = t("openWorkbench");
}

function renderPublisherStaticLabels() {
  if (dom.addBriefBtn) {
    dom.addBriefBtn.textContent = t("boardAddAnotherItem");
    dom.addBriefBtn.disabled = BOARD_STATE.submitting;
  }
  if (dom.cwdLabel) dom.cwdLabel.textContent = t("workingDirectory");
  if (dom.cwdInput) {
    dom.cwdInput.placeholder = t("defaultWorkingDirectoryOptional");
    dom.cwdInput.disabled = BOARD_STATE.submitting;
  }
  if (dom.browseBtn) {
    dom.browseBtn.textContent = t("browse");
    dom.browseBtn.disabled = BOARD_STATE.submitting;
  }
  if (dom.moreSummary) dom.moreSummary.textContent = t("boardMoreOptions");
  if (dom.leadLabel) dom.leadLabel.textContent = t("lead");
  if (dom.commonLabel) dom.commonLabel.textContent = t("boardSharedInstructions");
  if (dom.commonInput) {
    dom.commonInput.placeholder = t("boardSharedPlaceholder");
    dom.commonInput.disabled = BOARD_STATE.submitting;
  }
  updatePublishButtonLabel();
  updateErrorBanner();
}

function renderColumns() {
  if (!dom.columnsWrap) return;
  const state = getHubState();
  const cards = Array.isArray(state.boardCards) ? state.boardCards : [];

  const buckets = {
    queued: [],
    running: [],
    waiting: [],
    delivered: [],
    done: [],
    failed: [],
  };

  for (const card of cards) {
    const status = card?.board?.status;
    if (status === "queued") {
      buckets.queued.push(card);
    } else if (status === "running") {
      if (card.waiting) buckets.waiting.push(card);
      else buckets.running.push(card);
    } else if (status === "delivered") {
      buckets.delivered.push(card);
    } else if (status === "done") {
      buckets.done.push(card);
    } else if (status === "failed") {
      buckets.failed.push(card);
    }
  }

  const columnsMeta = [
    { key: "queued", label: t("boardColQueued"), items: buckets.queued },
    { key: "running", label: t("boardColRunning"), items: buckets.running },
    { key: "waiting", label: t("boardColWaiting"), items: buckets.waiting },
    { key: "delivered", label: t("boardColDelivered"), items: buckets.delivered, doneItems: buckets.done },
    { key: "failed", label: t("boardColFailed"), items: buckets.failed },
  ];

  dom.columnsWrap.innerHTML = "";

  for (const col of columnsMeta) {
    const colEl = document.createElement("section");
    colEl.className = `board-col board-col-${col.key}`;

    const totalCount = col.items.length;
    const headerEl = document.createElement("header");
    headerEl.className = "board-col-header";
    headerEl.innerHTML = `
      <span class="board-col-title">
        <span class="board-col-dot is-${col.key}"></span>
        <span>${escapeHtml(col.label)}</span>
      </span>
      <span class="board-col-count">${totalCount}</span>
    `;
    colEl.appendChild(headerEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "board-col-body";

    if (col.items.length === 0 && (!col.doneItems || col.doneItems.length === 0)) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "board-col-empty";
      emptyEl.textContent = t("boardEmptyColumn");
      bodyEl.appendChild(emptyEl);
    } else {
      for (const card of col.items) {
        bodyEl.appendChild(createCardElement(card, col.key));
      }
    }

    if (col.key === "delivered" && Array.isArray(col.doneItems) && col.doneItems.length > 0) {
      const detailsEl = document.createElement("details");
      detailsEl.className = "board-confirmed-details";
      detailsEl.open = BOARD_STATE.confirmedOpen;
      detailsEl.addEventListener("toggle", () => {
        BOARD_STATE.confirmedOpen = detailsEl.open;
      });

      const summaryEl = document.createElement("summary");
      summaryEl.className = "board-confirmed-summary";
      summaryEl.textContent = t("boardConfirmedSection", col.doneItems.length);
      detailsEl.appendChild(summaryEl);

      const confirmedList = document.createElement("div");
      confirmedList.className = "board-confirmed-list";
      for (const doneCard of col.doneItems) {
        confirmedList.appendChild(createCardElement(doneCard, "delivered"));
      }
      detailsEl.appendChild(confirmedList);
      bodyEl.appendChild(detailsEl);
    }

    colEl.appendChild(bodyEl);
    dom.columnsWrap.appendChild(colEl);
  }
}

function mountBoardScreen() {
  const screen = document.getElementById("boardScreen");
  if (!screen) return false;
  if (BOARD_STATE.mounted && dom.screen === screen) return true;

  dom.screen = screen;
  screen.innerHTML = `
    <header class="board-topbar">
      <div class="board-topbar-left">
        <img src="/ui/icon-64.png" class="board-brand-icon" alt="" width="24" height="24" />
        <h1 id="boardTitleText" class="board-title"></h1>
        <span id="boardSlotsPill" class="board-slots-pill"></span>
        <span id="boardMemPill" class="board-mem-pill" hidden></span>
      </div>
      <div class="board-topbar-right">
        <button id="boardSettingsBtn" class="board-top-btn" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span id="boardSettingsLabel"></span>
        </button>
        <button id="boardOpenWorkbenchBtn" class="alma-btn alma-btn-outline board-workbench-btn" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span id="boardWorkbenchLabel"></span>
        </button>
      </div>
    </header>

    <div class="board-main">
      <section class="board-publisher" aria-label="Task Publisher">
        <div id="boardBriefList" class="board-brief-list"></div>
        <div class="board-publisher-bar">
          <button id="boardAddBriefBtn" class="alma-btn alma-btn-outline board-add-item-btn" type="button"></button>
          <div class="board-cwd-group">
            <span id="boardCwdLabel" class="board-cwd-label"></span>
            <input id="boardCwdInput" class="text-input board-cwd-input" list="projectChoices" autocomplete="off" />
            <button id="boardBrowseCwdBtn" class="alma-btn alma-btn-outline" type="button"></button>
          </div>
          <button id="boardPublishBtn" class="alma-btn alma-btn-primary board-publish-btn" type="button"></button>
        </div>
        <div id="boardPublishError" class="board-publish-error" hidden></div>
        <details id="boardMoreDetails" class="board-more-options">
          <summary id="boardMoreSummary" class="board-more-summary"></summary>
          <div class="board-more-body">
            <div class="board-option-field">
              <span id="boardLeadLabel" class="board-option-label"></span>
              <div id="boardLeadChips" class="agent-chips"></div>
            </div>
            <div class="board-option-field board-option-shared">
              <label id="boardCommonLabel" class="board-option-label" for="boardCommonInput"></label>
              <textarea id="boardCommonInput" class="text-area board-common-input" rows="2"></textarea>
            </div>
          </div>
        </details>
      </section>

      <section id="boardColumnsWrap" class="board-columns" aria-label="Task Progress Columns"></section>
    </div>
  `;

  dom.titleEl = screen.querySelector("#boardTitleText");
  dom.slotsPill = screen.querySelector("#boardSlotsPill");
  dom.memPill = screen.querySelector("#boardMemPill");
  dom.settingsBtn = screen.querySelector("#boardSettingsBtn");
  dom.settingsLabel = screen.querySelector("#boardSettingsLabel");
  dom.workbenchBtn = screen.querySelector("#boardOpenWorkbenchBtn");
  dom.workbenchLabel = screen.querySelector("#boardWorkbenchLabel");
  dom.briefList = screen.querySelector("#boardBriefList");
  dom.addBriefBtn = screen.querySelector("#boardAddBriefBtn");
  dom.cwdLabel = screen.querySelector("#boardCwdLabel");
  dom.cwdInput = screen.querySelector("#boardCwdInput");
  dom.browseBtn = screen.querySelector("#boardBrowseCwdBtn");
  dom.publishBtn = screen.querySelector("#boardPublishBtn");
  dom.errorEl = screen.querySelector("#boardPublishError");
  dom.moreDetails = screen.querySelector("#boardMoreDetails");
  dom.moreSummary = screen.querySelector("#boardMoreSummary");
  dom.leadLabel = screen.querySelector("#boardLeadLabel");
  dom.leadChips = screen.querySelector("#boardLeadChips");
  dom.commonLabel = screen.querySelector("#boardCommonLabel");
  dom.commonInput = screen.querySelector("#boardCommonInput");
  dom.columnsWrap = screen.querySelector("#boardColumnsWrap");

  dom.settingsBtn?.addEventListener("click", () => {
    getApp().openSettings?.("general");
  });
  dom.workbenchBtn?.addEventListener("click", () => {
    getApp().setScreenMode?.("workbench");
  });
  dom.addBriefBtn?.addEventListener("click", () => {
    const newId = nextDraftId++;
    BOARD_STATE.drafts.push({ id: newId, text: "" });
    renderBriefRows(newId);
    updatePublishButtonLabel();
  });
  dom.cwdInput?.addEventListener("input", () => {
    BOARD_STATE.cwd = dom.cwdInput.value;
    BOARD_STATE.cwdTouched = true;
  });
  dom.browseBtn?.addEventListener("click", () => {
    void handleBrowseDirectory();
  });
  dom.publishBtn?.addEventListener("click", () => {
    void handlePublish();
  });
  dom.moreDetails?.addEventListener("toggle", () => {
    BOARD_STATE.moreOpen = Boolean(dom.moreDetails?.open);
  });
  dom.commonInput?.addEventListener("input", () => {
    BOARD_STATE.common = dom.commonInput.value;
  });

  BOARD_STATE.mounted = true;
  return true;
}

export function renderBoard() {
  if (!mountBoardScreen()) return;
  syncDefaultsFromState();
  renderTopbar();
  renderPublisherStaticLabels();
  renderBriefRows();
  renderLeadAgentPicker();
  renderColumns();
}

window.HUB_BOARD = {
  render: renderBoard,
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderBoard(), { once: true });
} else {
  renderBoard();
}

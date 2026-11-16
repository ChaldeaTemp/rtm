import { apiFetch, displayTaskTitle, getLocale, t, th } from "./i18n.js";
import { createClassicBoard } from "./board-classic.js";
import { createRoundtableBoard } from "./board-roundtable.js";

let nextDraftId = 1;

const BOARD_STATE = {
  mounted: false,
  drafts: [{ id: nextDraftId++, text: "" }],
  cwd: "",
  cwdTouched: false,
  leadAgent: "",
  leadTouched: false,
  common: "",
  confirmedOpen: false,
  submitting: false,
  errorText: "",
  actionBusyIds: new Set(),
  search: "",
  project: "",
  overlay: null,
  rejectDrafts: new Map(),
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
        row.classList.toggle("has-multiline", draft.text.includes("\n"));
        if (BOARD_STATE.errorText) {
          BOARD_STATE.errorText = "";
          updateErrorBanner();
        }
        updatePublishButtonLabel();
      });
      textarea.addEventListener("keydown", (e) => {
        if (!e.isComposing && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
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
      textarea.setAttribute("aria-label", canRemove ? t("boardBriefNumber", idx + 1) : t("boardBriefLabel"));
      if (document.activeElement !== textarea && textarea.value !== draft.text) {
        textarea.value = draft.text;
      }
      row.classList.toggle("has-multiline", draft.text.includes("\n"));
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
      renderPublisherStaticLabels();
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
  const leadAgent = dom.screen.classList.contains("board-simple")
    ? resolveDefaultLead(getHubState())
    : BOARD_STATE.leadAgent || resolveDefaultLead(getHubState());
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
  renderPublisherStaticLabels();

  let published = null;
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
    if (!res.ok || data?.ok !== true) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    // Reset drafts on success while preserving chosen cwd and leadAgent
    BOARD_STATE.drafts = [{ id: nextDraftId++, text: "" }];
    BOARD_STATE.common = "";
    if (dom.commonInput) dom.commonInput.value = "";
    if (dom.screen.classList.contains("board-simple")) dom.moreDetails.open = false;
    BOARD_STATE.errorText = "";
    if (activeScene()) {
      // Scene objects appear only from the authoritative card list; this just pins them into view.
      published = (Array.isArray(data.groups) ? data.groups : []).map((group) => group?.groupId).filter(Boolean);
    }
  } catch (err) {
    BOARD_STATE.errorText = err?.message || String(err);
  } finally {
    BOARD_STATE.submitting = false;
    updateErrorBanner();
    renderBriefRows();
    renderPublisherStaticLabels();
  }
  if (published) activeScene()?.onPublished(published);
}

async function handleCardAction(card, action, detail = null) {
  if (!card?.groupId || BOARD_STATE.actionBusyIds.has(card.groupId)) return;
  const app = getApp();
  if (!detail && action === "cancel") {
    const confirmed = await app.showConfirmModal({
      title: t("boardCancelTitle", getCardTitle(card)),
      message: t(card.board.status === "queued" ? "boardCancelQueued" : "boardCancelRunning"),
      confirmText: t("boardCancelConfirm"),
      cancelText: t("boardKeepTask"),
      danger: true,
      focusCancel: true,
    });
    if (!confirmed) return;
  }
  let note = detail?.note;
  if (!detail && action === "reject") {
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

  if (BOARD_STATE.actionBusyIds.has(card.groupId)) return;
  BOARD_STATE.actionBusyIds.add(card.groupId);
  if (detail) detail.error = "";
  BOARD_STATE.errorText = "";
  updateErrorBanner();
  renderColumns();
  try {
    const res = await apiFetch("/api/board/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: card.groupId,
        action,
        note,
        expectedStatus: action === "cancel" ? card.board.status : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    if (action === "reject") BOARD_STATE.rejectDrafts.delete(card.groupId);
    if (detail) detail.prompt = null;
  } catch (err) {
    const message = err?.message || String(err);
    if (detail && BOARD_STATE.overlay === detail) {
      detail.error = message;
    } else {
      BOARD_STATE.errorText = message;
      updateErrorBanner();
      if (dom.screen?.hidden) void app.showConfirmModal({ message, confirmText: t("ok") });
    }
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
  const reason = getWaitingReason(card);
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

function getWaitingReason(card) {
  return card.waitingReason || (card.board.interrupted ? "interrupted" : card.board.stalled ? "stalled" : "question");
}

function getBoardCards() {
  const cards = getHubState().boardCards;
  return Array.isArray(cards) ? cards : [];
}

function getColumnKey(card) {
  return card.board.status === "running" && card.waiting ? "waiting" : card.board.status;
}

function getProjectLabel(cwd) {
  return getShortCwd(cwd) || t("noDirectorySelected");
}

function getCardNumber(card) {
  return `#${card.groupId.replace(/^grp-/, "")}`;
}

function openInWorkbench(card, reason) {
  getApp().openPendingTask?.(card.groupId, reason);
}

function getCardActions(card, columnKey) {
  const status = card.board.status;
  const cancel = { action: "cancel", label: t("boardActionCancel"), cls: "is-secondary" };
  if (status === "delivered") {
    return [
      { action: "confirm", label: t("boardActionConfirm"), cls: "is-primary" },
      { action: "reject", label: t("boardActionReject"), cls: "is-warning" },
    ];
  }
  if (status === "failed") return [{ action: "retry", label: t("boardActionRetry"), cls: "is-primary" }];
  if (status === "queued") return [cancel];
  if (status !== "running") return [];
  if (card.board.interrupted || card.waitingReason === "interrupted") {
    return [{ action: "resume", label: t("boardActionResume"), cls: "is-primary" }, cancel];
  }
  if (columnKey !== "waiting") return [cancel];
  const reason = getWaitingReason(card);
  const label = reason === "permission" ? "boardActionPermission" : reason === "stalled" ? "boardActionGuide" : "boardActionAnswer";
  return [{ action: "handle", label: t(label), cls: "is-primary" }, cancel];
}

function renderCardActions(actions, busy) {
  return actions.map(({ action, label, cls }) =>
    `<button type="button" class="board-card-btn ${cls}" data-board-action="${action}" ${busy ? "disabled" : ""}>${escapeHtml(label)}</button>`
  ).join("");
}

function renderDeliverable(card, item, index) {
  const label = item.kind === "text" ? item.note || item.path : item.path || item.note;
  let displayLabel = label;
  let href;
  if (item.kind === "file" && item.path) {
    href = `/api/board/deliverable?${new URLSearchParams({ groupId: card.groupId, index })}`;
  } else if (item.kind === "link" && label) {
    const url = URL.canParse(label, location.href) ? new URL(label, location.href) : null;
    if (url?.origin === location.origin && url.pathname.startsWith("/artifacts/")) {
      const id = url.pathname.slice("/artifacts/".length);
      const artifact = getHubState().artifacts?.get(id);
      if (artifact?.groupId === card.groupId) {
        href = getApp().buildArtifactUrl(id);
        displayLabel = artifact.title || label;
      }
    } else if (/^https?:\/\//i.test(label) && (url?.protocol === "https:" || url?.protocol === "http:")) {
      href = url.href;
    }
  }
  const text = escapeHtml(displayLabel || item.kind);
  const note = item.kind !== "text" && item.path && item.note
    ? `<div class="board-deliverable-note">${escapeHtml(item.note)}</div>`
    : "";
  const linkLabel = item.kind === "file" ? t("boardDownloadFile", label) : label;
  return `<li class="board-deliverable-item">${href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(linkLabel)}">${text}</a>`
    : text}${note}</li>`;
}

function createCardElement(card, columnKey) {
  const el = document.createElement("article");
  const isDone = card?.board?.status === "done";
  const isBusy = BOARD_STATE.actionBusyIds.has(card.groupId);
  el.className = `board-card is-${columnKey}${isDone ? " is-done" : ""}${isBusy ? " is-busy" : ""}`;

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
    const itemsHtml = deliverables.map((item, index) => renderDeliverable(card, item, index)).join("");
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

  const actions = getCardActions(card, columnKey);

  const actionsHtml = actions.length
    ? `<div class="board-card-actions">${renderCardActions(actions, isBusy)}</div>`
    : "";

  el.innerHTML = `
    <div class="board-card-top">
      <button type="button" class="board-card-title">${escapeHtml(title)}</button>
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
      if (action === "handle") openInWorkbench(card, getWaitingReason(card));
      else if (action) void handleCardAction(card, action);
    });
  });

  el.addEventListener("click", (e) => {
    if (!e.target.closest("a, .board-card-deliverables")) openInWorkbench(card);
  });

  return el;
}

const SIMPLE_COLUMN_LABELS = {
  queued: "boardColQueued",
  running: "boardColRunning",
  waiting: "boardColDecision",
  delivered: "boardColReview",
  failed: "boardColFailed",
  done: "boardColConfirmed",
};

function cardHint(card, key) {
  if (key === "waiting") return getWaitingBadgeInfo(card).text;
  if (key === "delivered") return t("boardReviewHint", card.board.deliverables?.length || 0);
  if (key === "failed") return card.board.failReason || t("boardFailedHint");
  return t({ queued: "boardQueuedHint", running: "boardRunningHint", done: "boardColConfirmed" }[key]);
}

function createSimpleCard(card, key, pick) {
  const button = document.createElement("button");
  const title = getCardTitle(card);
  button.type = "button";
  button.className = `board-simple-card is-${key}`;
  button.dataset.boardTask = card.groupId;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `
    <span class="board-simple-card-meta">
      <span title="${escapeHtml(card.cwd)}">${escapeHtml(getProjectLabel(card.cwd))}</span>
      <span class="board-simple-number" title="${escapeHtml(card.groupId)}">${escapeHtml(getCardNumber(card))}</span>
    </span>
    <span class="board-simple-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
    <span class="board-simple-card-hint">${escapeHtml(cardHint(card, key))}</span>
  `;
  button.addEventListener("click", () => pick(card.groupId, button));
  return button;
}

function filteredBoardCards(cards) {
  const query = BOARD_STATE.search.trim().toLocaleLowerCase();
  const projectKey = getApp().projectKey;
  return cards.filter((card) => {
    if (BOARD_STATE.project && projectKey(card.cwd) !== BOARD_STATE.project) return false;
    return !query || [getCardTitle(card), getProjectLabel(card.cwd), card.cwd, card.groupId, getCardNumber(card)]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });
}

function renderSimpleFilters(allCards, filtered) {
  const { projectKey } = getApp();
  const paths = new Map(allCards.filter((card) => card.cwd).map((card) => [projectKey(card.cwd), card.cwd]));
  if (BOARD_STATE.project && !paths.has(BOARD_STATE.project)) paths.set(BOARD_STATE.project, BOARD_STATE.project);
  const choices = [...paths].sort(([, a], [, b]) => getProjectLabel(a).localeCompare(getProjectLabel(b)) || a.localeCompare(b));
  const project = dom.projectFilter;
  const options = `<option value="">${th("boardAllProjects")}</option>` +
    choices.map(([key, cwd]) => `<option value="${escapeHtml(key)}" title="${escapeHtml(cwd)}">${escapeHtml(getProjectLabel(cwd))}</option>`).join("");
  if (dom.projectOptions !== options) {
    project.innerHTML = options;
    dom.projectOptions = options;
  }
  project.value = BOARD_STATE.project;
  dom.searchInput.placeholder = t("boardSearchTasks");
  dom.searchInput.setAttribute("aria-label", t("boardSearchTasks"));
  project.setAttribute("aria-label", t("boardFilterProject"));
  dom.clearFilters.textContent = t("boardClearFilters");
  dom.clearFilters.disabled = !BOARD_STATE.search && !BOARD_STATE.project;
  dom.resultCount.textContent = t("boardVisibleCount", filtered.length, allCards.length);

  for (const btn of dom.attentionButtons) {
    const key = btn.dataset.boardAttention;
    const count = filtered.filter((card) => getColumnKey(card) === key).length;
    btn.textContent = t(key === "waiting" ? "boardDecisionCount" : "boardReviewCount", count);
  }
}

function currentSkin() {
  return document.body.dataset.skin || "modern";
}

// Skins that draw the board as a scene register here; the others use the column view.
const scenes = {};

function sceneFor(skin) {
  return Object.hasOwn(scenes, skin) ? scenes[skin] : null;
}

function activeScene() {
  return dom.screen ? sceneFor(dom.screen.dataset.scene || "") : null;
}

function clearSceneViews() {
  delete dom.overlay.dataset.classicView;
  delete dom.overlay.dataset.rtView;
}

function openBoardOverlay(data, origin) {
  const skin = currentSkin();
  BOARD_STATE.overlay = { ...data, skin, origin, originColumn: origin.closest?.(".board-col")?.dataset.column };
  dom.overlayMarkup = null;
  clearSceneViews();
  for (const scene of Object.values(scenes)) scene.cancelClosing();
  renderBoardOverlay(filteredBoardCards(getBoardCards()));
  if (!dom.overlay.open) dom.overlay.showModal();
  sceneFor(skin)?.animateOpen(dom.overlay, origin);
  dom.overlay.querySelector("#boardOverlayTitle")?.focus();
}

// Scene intakes show the shared publisher inside the dialog; it returns home afterwards.
function mountPublisher(host) {
  host.append(dom.publisher);
}

function restorePublisher() {
  if (dom.publisherAnchor && dom.publisher.parentNode !== dom.publisherAnchor.parentNode) {
    dom.publisherAnchor.after(dom.publisher);
  }
}

function closeBoardOverlay({ animate = false } = {}) {
  if (!dom.overlay.open || !BOARD_STATE.overlay) return;
  const overlay = BOARD_STATE.overlay;
  BOARD_STATE.overlay = null;
  restorePublisher();
  const scene = sceneFor(overlay.skin);
  if (scene) {
    void scene.closeOverlay(dom.overlay, overlay, animate && !dom.screen.hidden);
    return;
  }
  const { origin, originColumn, originGroupId } = overlay;
  dom.overlay.close();
  const column = originColumn && dom.columnsWrap.querySelector(`[data-column="${originColumn}"]`);
  const replacement = originGroupId && column?.querySelector(`[data-board-task="${CSS.escape(originGroupId)}"]`);
  if (dom.screen.hidden || !dom.screen.classList.contains("board-simple")) return;
  const focus = origin.isConnected ? origin : replacement;
  focus?.focus({ preventScroll: true });
  if (!focus || document.activeElement !== focus) (column || dom.searchInput).focus({ preventScroll: true });
}

function renderDetailSection(label, text, cls = "") {
  if (!text) return "";
  return `<section class="board-detail-section ${cls}">
    <h3>${escapeHtml(label)}</h3><p>${escapeHtml(text)}</p>
  </section>`;
}

function renderDetailPrompt(detail, card, busy) {
  const action = detail.prompt.action;
  const cancel = action === "cancel";
  return `
    <section class="board-detail-prompt">
      <h3>${cancel ? th("boardCancelTitle", getCardTitle(card)) : th("boardRejectPromptTitle")}</h3>
      ${cancel
        ? `<p>${th(card.board.status === "queued" ? "boardCancelQueued" : "boardCancelRunning")}</p>`
        : `<label for="boardRejectNote">${th("boardRejectPromptMsg")}</label>
           <textarea id="boardRejectNote" class="text-area" rows="3" data-board-overlay-ui="note" ${busy ? "disabled" : ""}></textarea>`}
      <div class="board-card-actions">
        <button type="button" class="board-card-btn" data-board-overlay-ui="dismiss-prompt" ${busy ? "disabled" : ""}>${cancel ? th("boardKeepTask") : th("boardActionCancel")}</button>
        <button type="button" class="board-card-btn ${cancel ? "is-secondary" : "is-warning"}" data-board-overlay-ui="submit-prompt" ${busy ? "disabled" : ""}>${cancel ? th("boardCancelConfirm") : th("boardActionReject")}</button>
      </div>
    </section>`;
}

function getDecisionContext(card) {
  const state = getHubState();
  const reason = getWaitingReason(card);
  if (reason === "question") {
    const pending = [...(state.pendingQuestions?.values() || [])].find((item) => item.groupId === card.groupId);
    return pending?.fields?.map((item) => item.question).filter(Boolean).join("\n") || pending?.title;
  }
  if (reason === "permission") {
    return [...(state.pendingPermissions?.values() || [])].find((item) => item.groupId === card.groupId)?.toolTitle;
  }
  return "";
}

function renderTaskDetail(detail, card) {
  const title = card ? getCardTitle(card) : (detail.title || t("taskBoard"));
  detail.title = title;
  const key = card ? getColumnKey(card) : null;
  const busy = BOARD_STATE.actionBusyIds.has(detail.groupId);
  const actions = card ? getCardActions(card, key) : [];
  if (detail.prompt && (!actions.some(({ action }) => action === detail.prompt.action) ||
    (detail.prompt.action === "cancel" && card.board.status !== detail.prompt.status) ||
    (detail.prompt.action === "reject" && card.board.deliveredAt !== detail.prompt.deliveredAt))) {
    detail.prompt = null;
    if (!busy && card) detail.error = t("boardActionStateChanged");
  }
  const info = card?.board;
  const progress = key === "running" ? getHubState().progress?.get(detail.groupId)?.summary : "";
  const startedAt = key === "running" && info.startedAt
    ? t("boardStartedAt", new Date(info.startedAt).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" }))
    : "";
  const decision = key === "waiting" ? getDecisionContext(card) : "";
  const deliverables = (key === "delivered" || key === "done") ? info.deliverables || [] : [];
  const back = detail.bucket || detail.panel
    ? `<button type="button" class="board-card-btn" data-board-overlay-ui="back">${th("boardBackToList")}</button>`
    : "";
  const parts = card ? {
    brief: renderDetailSection(t("boardBriefLabel"), info.brief),
    decision: key === "waiting" ? renderDetailSection(decision ? cardHint(card, key) : t("boardColDecision"), decision || cardHint(card, key), "is-decision") : "",
    failure: key === "failed" ? renderDetailSection(t("boardFailureReason"), cardHint(card, key), "is-failure") : "",
    progress: renderDetailSection(t(key === "running" ? "boardProgress" : "boardResult"), info.summary || progress || startedAt),
    deliverables: deliverables.length ? `<div class="board-card-deliverables">
          <div class="board-deliverables-count">${th("boardDeliverablesCount", deliverables.length)}</div>
          <ul class="board-deliverables-list">${deliverables.map((item, i) => renderDeliverable(card, item, i)).join("")}</ul>
        </div>` : "",
    directory: renderDetailSection(t("workingDirectory"), card.cwd, "is-directory"),
    rejectNote: renderDetailSection(t("boardRejectPromptTitle"), info.rejectNote),
    prompt: detail.prompt ? renderDetailPrompt(detail, card, busy) : "",
    back,
    workbench: `<button type="button" class="board-card-btn" data-board-overlay-ui="workbench">${th("boardOpenSession")}</button>`,
    actions: detail.prompt ? "" : renderCardActions(actions.toReversed(), busy),
    deliverableCount: deliverables.length,
    hint: cardHint(card, key),
    progressText: progress,
  } : null;
  return {
    key,
    parts,
    title,
    meta: card ? `<span class="board-detail-status is-${key}">${th(SIMPLE_COLUMN_LABELS[key])}</span>
      <span>${escapeHtml(getProjectLabel(card.cwd))} · ${escapeHtml(getCardNumber(card))}</span>` : "",
    body: `
      ${card ? `
        ${renderDetailSection(t("boardBriefLabel"), info.brief)}
        ${key === "waiting" ? renderDetailSection(decision ? cardHint(card, key) : t("boardColDecision"), decision || cardHint(card, key), "is-decision") : ""}
        ${key === "failed" ? renderDetailSection(t("boardFailureReason"), cardHint(card, key), "is-failure") : ""}
        ${renderDetailSection(t(key === "running" ? "boardProgress" : "boardResult"), info.summary || progress || startedAt)}
        ${deliverables.length ? `<div class="board-card-deliverables">
          <div class="board-deliverables-count">${th("boardDeliverablesCount", deliverables.length)}</div>
          <ul class="board-deliverables-list">${deliverables.map((item, i) => renderDeliverable(card, item, i)).join("")}</ul>
        </div>` : ""}
        ${renderDetailSection(t("workingDirectory"), card.cwd, "is-directory")}
        ${renderDetailSection(t("boardRejectPromptTitle"), info.rejectNote)}
        ${detail.prompt ? renderDetailPrompt(detail, card, busy) : ""}
      ` : `<p role="status">${th("boardTaskUnavailable")}</p>`}
    `,
    error: detail.error,
    footer: `
      <div class="board-card-actions">${back}
        ${card ? `<button type="button" class="board-card-btn" data-board-overlay-ui="workbench">${th("boardOpenSession")}</button>` : ""}
      </div>
      <div class="board-card-actions">${detail.prompt ? "" : renderCardActions(actions.toReversed(), busy)}</div>`,
  };
}

function renderBoardOverlay(filtered) {
  const detail = BOARD_STATE.overlay;
  if (!detail) return;
  const scene = sceneFor(detail.skin);
  if (!detail.groupId && detail.panel) {
    dom.overlayMarkup = null;
    scene?.renderPanel(detail, dom.overlay);
    return;
  }
  const selected = detail.groupId ? getBoardCards().find((card) => card.groupId === detail.groupId) : null;
  const model = detail.groupId ? renderTaskDetail(detail, selected) : {
    title: t(SIMPLE_COLUMN_LABELS[detail.bucket]),
    meta: "",
    body: "",
    footer: "",
  };
  const list = detail.groupId ? null : filtered.filter((card) => getColumnKey(card) === detail.bucket);
  const markup = (detail.groupId && scene?.taskMarkup?.(model, detail, selected)) || `
    <header class="board-overlay-header">
      <button type="button" class="board-overlay-close" data-board-overlay-ui="close" aria-label="${th("close")}">&times;</button>
      ${model.meta ? `<div class="board-overlay-meta">${model.meta}</div>` : ""}
      <h2 id="boardOverlayTitle" tabindex="-1">${escapeHtml(model.title)}</h2>
    </header>
    <div class="board-overlay-body">${model.body}</div>
    ${model.error ? `<p role="alert" class="board-publish-error board-overlay-error">${escapeHtml(model.error)}</p>` : ""}
    ${model.footer ? `<footer class="board-overlay-footer">${model.footer}</footer>` : ""}`;
  // Do not replace controls after pushes that leave this panel unchanged.
  const listKey = list && JSON.stringify(list.map((card) => [card.groupId, card.cwd, getCardTitle(card), cardHint(card, detail.bucket)]));
  if (dom.overlayMarkup === markup && dom.overlayListKey === listKey) return;
  const active = document.activeElement;
  const focusAttr = ["data-board-overlay-ui", "data-board-action", "data-board-task"].find((attr) => active?.hasAttribute(attr));
  const restoreFocus = dom.overlay.contains(active);
  const scroll = dom.overlay.querySelector(".board-overlay-body")?.scrollTop || 0;
  dom.overlayMarkup = markup;
  dom.overlayListKey = listKey;
  restorePublisher();
  clearSceneViews();
  dom.overlay.innerHTML = markup;
  const body = dom.overlay.querySelector(".board-overlay-body");
  const note = dom.overlay.querySelector("#boardRejectNote");
  if (note) {
    note.value = BOARD_STATE.rejectDrafts.get(detail.groupId) || "";
    dom.overlay.querySelector('[data-board-overlay-ui="submit-prompt"]').disabled = note.disabled || !note.value.trim();
  }
  if (list?.length) {
    body.classList.add("board-overlay-list");
    for (const card of list) {
      body.append(createSimpleCard(card, detail.bucket, (groupId) => {
        detail.groupId = groupId;
        renderBoardOverlay(filteredBoardCards(getBoardCards()));
        dom.overlay.querySelector(".board-overlay-body").scrollTop = 0;
        dom.overlay.querySelector("#boardOverlayTitle").focus();
      }));
    }
  } else if (list) {
    body.innerHTML = `<p class="board-col-empty">${th("boardEmptyColumn")}</p>`;
  }
  body.scrollTop = scroll;
  if (restoreFocus) {
    const focus = focusAttr && dom.overlay.querySelector(`[${focusAttr}="${CSS.escape(active.getAttribute(focusAttr))}"]:not(:disabled)`);
    (focus || dom.overlay.querySelector("#boardOverlayTitle")).focus({ preventScroll: true });
    if (focus && focus === note) note.setSelectionRange(active.selectionStart, active.selectionEnd, active.selectionDirection);
  }
}

function handleOverlayClick(event) {
  const detail = BOARD_STATE.overlay;
  const control = event.target.closest("[data-board-overlay-ui], [data-board-action]");
  if (!detail || !control) return;
  const ui = control.dataset.boardOverlayUi;
  if (ui === "close") return closeBoardOverlay({ animate: true });
  if (ui === "back") {
    const previous = detail.groupId;
    Object.assign(detail, { groupId: null, prompt: null, error: "" });
    renderBoardOverlay(filteredBoardCards(getBoardCards()));
    dom.overlay.querySelector(`[data-board-task="${CSS.escape(previous)}"]`)?.focus();
    return;
  }
  const card = getBoardCards().find(({ groupId }) => groupId === detail.groupId);
  if (!card) return;
  if (ui === "workbench") {
    closeBoardOverlay();
    openInWorkbench(card);
    return;
  }
  if (BOARD_STATE.actionBusyIds.has(card.groupId)) return;
  if (ui === "dismiss-prompt") {
    const action = detail.prompt.action;
    detail.prompt = null;
    renderBoardOverlay(filteredBoardCards(getBoardCards()));
    dom.overlay.querySelector(`[data-board-action="${action}"]`)?.focus();
    return;
  }
  const action = ui === "submit-prompt" ? detail.prompt?.action : control.dataset.boardAction;
  if (!getCardActions(card, getColumnKey(card)).some((item) => item.action === action)) return;
  if (action === "handle") {
    closeBoardOverlay();
    openInWorkbench(card, getWaitingReason(card));
    return;
  }
  if (ui !== "submit-prompt" && (action === "cancel" || action === "reject")) {
    detail.error = "";
    detail.prompt = { action, status: card.board.status, deliveredAt: card.board.deliveredAt };
    renderBoardOverlay(filteredBoardCards(getBoardCards()));
    dom.overlay.querySelector(action === "cancel" ? '[data-board-overlay-ui="dismiss-prompt"]' : "#boardRejectNote")?.focus();
    return;
  }
  detail.note = action === "reject" ? BOARD_STATE.rejectDrafts.get(card.groupId)?.trim() : undefined;
  if (action === "reject" && !detail.note) return;
  void handleCardAction(card, action, detail);
}

function renderTopbar() {
  const state = getHubState();
  const cards = getBoardCards();
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
  dom.publisher.setAttribute("aria-label", t("boardPublisherLabel"));
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
  dom.publishPath.textContent = BOARD_STATE.cwd || t("defaultWorkingDirectoryOptional");
  dom.publishPath.title = BOARD_STATE.cwd;
  dom.publishOptions.textContent = t("boardBatchOptions");
  dom.publishOptions.setAttribute("aria-expanded", String(dom.moreDetails.open));
  updatePublishButtonLabel();
  updateErrorBanner();
}

function renderColumns() {
  if (!dom.columnsWrap) return;
  const scene = activeScene();
  if (scene) {
    scene.render();
    renderBoardOverlay();
    return;
  }
  const simple = dom.screen.classList.contains("board-simple");
  const allCards = getBoardCards();
  const cards = simple ? filteredBoardCards(allCards) : allCards;
  if (simple) renderSimpleFilters(allCards, cards);

  const buckets = {
    queued: [],
    running: [],
    waiting: [],
    delivered: [],
    done: [],
    failed: [],
  };

  for (const card of cards) buckets[getColumnKey(card)]?.push(card);

  const columnsMeta = [
    { key: "queued", label: t("boardColQueued"), items: buckets.queued },
    { key: "running", label: t("boardColRunning"), items: buckets.running },
    { key: "waiting", label: t(simple ? "boardColDecision" : "boardColWaiting"), items: buckets.waiting },
    { key: "delivered", label: t(simple ? "boardColReview" : "boardColDelivered"), items: buckets.delivered, doneItems: buckets.done },
    { key: "failed", label: t("boardColFailed"), items: buckets.failed },
  ];

  const scrollPositions = new Map();
  const active = document.activeElement;
  const activeColumn = active?.closest("[data-column]");
  const confirmed = dom.columnsWrap.querySelector(".board-confirmed-details");
  if (confirmed) BOARD_STATE.confirmedOpen = confirmed.open;
  for (const col of dom.columnsWrap.children) {
    scrollPositions.set(col.dataset.column, col.querySelector(".board-col-body").scrollTop);
  }
  const columns = document.createDocumentFragment();
  const createColumnCard = simple ? (card, key) => createSimpleCard(card, key, (groupId, origin) => {
    openBoardOverlay({ groupId, originGroupId: groupId }, origin);
  }) : createCardElement;

  for (const col of columnsMeta) {
    const colEl = document.createElement("section");
    colEl.className = `board-col board-col-${col.key}`;
    colEl.dataset.column = col.key;
    if (simple) {
      colEl.tabIndex = -1;
      colEl.setAttribute("aria-label", col.label);
    }

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
      emptyEl.textContent = t(simple && !cards.length && (BOARD_STATE.search.trim() || BOARD_STATE.project)
        ? "boardNoFilterMatches" : "boardEmptyColumn");
      bodyEl.appendChild(emptyEl);
    } else {
      for (const card of col.items) {
        bodyEl.appendChild(createColumnCard(card, col.key));
      }
    }

    if (col.key === "delivered" && Array.isArray(col.doneItems) && col.doneItems.length > 0) {
      const detailsEl = document.createElement("details");
      detailsEl.className = "board-confirmed-details";
      detailsEl.open = BOARD_STATE.confirmedOpen;

      const summaryEl = document.createElement("summary");
      summaryEl.className = "board-confirmed-summary";
      summaryEl.textContent = t(simple ? "boardAcceptedSection" : "boardConfirmedSection", col.doneItems.length);
      detailsEl.appendChild(summaryEl);

      const confirmedList = document.createElement("div");
      confirmedList.className = "board-confirmed-list";
      for (const doneCard of col.doneItems) {
        confirmedList.appendChild(createColumnCard(doneCard, simple ? "done" : "delivered"));
      }
      detailsEl.appendChild(confirmedList);
      bodyEl.appendChild(detailsEl);
    }

    colEl.appendChild(bodyEl);
    columns.appendChild(colEl);
  }
  dom.columnsWrap.replaceChildren(columns);
  for (const col of dom.columnsWrap.children) {
    col.querySelector(".board-col-body").scrollTop = scrollPositions.get(col.dataset.column) || 0;
  }
  if (simple && activeColumn) {
    const column = dom.columnsWrap.querySelector(`[data-column="${activeColumn.dataset.column}"]`);
    const groupId = active.dataset.boardTask;
    const replacement = groupId ? column.querySelector(`[data-board-task="${CSS.escape(groupId)}"]`)
      : active.matches("summary") ? column.querySelector("summary") : null;
    replacement?.focus({ preventScroll: true });
    if (!replacement || document.activeElement !== replacement) column.focus({ preventScroll: true });
  }
  if (simple) renderBoardOverlay(cards);
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
      <div class="board-attention board-simple-only">
        <button type="button" class="board-attention-btn is-waiting" data-board-attention="waiting" aria-haspopup="dialog"></button>
        <button type="button" class="board-attention-btn is-delivered" data-board-attention="delivered" aria-haspopup="dialog"></button>
      </div>
      <section class="board-publisher">
        <div id="boardBriefList" class="board-brief-list"></div>
        <div class="board-publisher-bar">
          <span id="boardPublishPath" class="board-publish-path board-simple-only"></span>
          <button id="boardPublishOptions" class="alma-btn alma-btn-outline board-simple-only" type="button" aria-controls="boardMoreDetails boardCwdGroup boardAddBriefBtn"></button>
          <button id="boardAddBriefBtn" class="alma-btn alma-btn-outline board-add-item-btn" type="button"></button>
          <div id="boardCwdGroup" class="board-cwd-group">
            <label id="boardCwdLabel" class="board-cwd-label" for="boardCwdInput"></label>
            <input id="boardCwdInput" class="text-input board-cwd-input" list="projectChoices" autocomplete="off" />
            <button id="boardBrowseCwdBtn" class="alma-btn alma-btn-outline" type="button"></button>
          </div>
          <button id="boardPublishBtn" class="alma-btn alma-btn-primary board-publish-btn" type="button"></button>
        </div>
        <div id="boardPublishError" class="board-publish-error" role="alert" hidden></div>
        <details id="boardMoreDetails" class="board-more-options">
          <summary id="boardMoreSummary" class="board-more-summary"></summary>
          <div class="board-more-body">
            <div class="board-option-field board-option-lead">
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

      <div class="board-filters board-simple-only">
        <input id="boardSearch" class="text-input" type="search" autocomplete="off" />
        <select id="boardProjectFilter" class="text-input"></select>
        <button id="boardClearFilters" class="alma-btn alma-btn-outline" type="button"></button>
        <span id="boardResultCount" class="board-result-count" role="status"></span>
      </div>
      <section id="boardColumnsWrap" class="board-columns"></section>
    </div>
    <dialog class="board-overlay" aria-labelledby="boardOverlayTitle"></dialog>
  `;

  dom.titleEl = screen.querySelector("#boardTitleText");
  dom.slotsPill = screen.querySelector("#boardSlotsPill");
  dom.memPill = screen.querySelector("#boardMemPill");
  dom.settingsBtn = screen.querySelector("#boardSettingsBtn");
  dom.settingsLabel = screen.querySelector("#boardSettingsLabel");
  dom.workbenchBtn = screen.querySelector("#boardOpenWorkbenchBtn");
  dom.workbenchLabel = screen.querySelector("#boardWorkbenchLabel");
  dom.publisher = screen.querySelector(".board-publisher");
  dom.publishPath = screen.querySelector("#boardPublishPath");
  dom.publishOptions = screen.querySelector("#boardPublishOptions");
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
  dom.attentionButtons = [...screen.querySelectorAll("[data-board-attention]")];
  dom.searchInput = screen.querySelector("#boardSearch");
  dom.projectFilter = screen.querySelector("#boardProjectFilter");
  dom.clearFilters = screen.querySelector("#boardClearFilters");
  dom.resultCount = screen.querySelector("#boardResultCount");
  dom.overlay = screen.querySelector(".board-overlay");
  dom.publisherAnchor = document.createComment("board-publisher");
  dom.publisher.before(dom.publisherAnchor);

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
    renderPublisherStaticLabels();
  });
  dom.browseBtn?.addEventListener("click", () => {
    void handleBrowseDirectory();
  });
  dom.publishBtn?.addEventListener("click", () => {
    void handlePublish();
  });
  dom.publishOptions.addEventListener("click", () => {
    dom.moreDetails.open = !dom.moreDetails.open;
    renderPublisherStaticLabels();
  });
  dom.commonInput?.addEventListener("input", () => {
    BOARD_STATE.common = dom.commonInput.value;
  });
  for (const btn of dom.attentionButtons) {
    btn.addEventListener("click", () => openBoardOverlay({ bucket: btn.dataset.boardAttention }, btn));
  }
  dom.searchInput.addEventListener("input", () => {
    BOARD_STATE.search = dom.searchInput.value;
    renderColumns();
  });
  dom.projectFilter.addEventListener("change", () => {
    BOARD_STATE.project = dom.projectFilter.value;
    renderColumns();
  });
  dom.clearFilters.addEventListener("click", () => {
    BOARD_STATE.search = "";
    BOARD_STATE.project = "";
    dom.searchInput.value = "";
    renderColumns();
    dom.searchInput.focus();
  });
  dom.overlay.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeBoardOverlay({ animate: true });
  });
  let pointerOnBackdrop = false;
  dom.overlay.addEventListener("pointerdown", (event) => {
    pointerOnBackdrop = event.target === dom.overlay;
  });
  dom.overlay.addEventListener("click", (event) => {
    if (event.target === dom.overlay && pointerOnBackdrop) closeBoardOverlay({ animate: true });
    else if (!sceneFor(BOARD_STATE.overlay?.skin)?.onOverlayClick(event)) handleOverlayClick(event);
    pointerOnBackdrop = false;
  });
  dom.overlay.addEventListener("input", (event) => {
    if (event.target.id !== "boardRejectNote" || !BOARD_STATE.overlay) return;
    BOARD_STATE.rejectDrafts.set(BOARD_STATE.overlay.groupId, event.target.value);
    dom.overlay.querySelector('[data-board-overlay-ui="submit-prompt"]').disabled = !event.target.value.trim();
  });

  BOARD_STATE.mounted = true;
  return true;
}

export function renderBoard() {
  if (!mountBoardScreen()) return;
  const skin = currentSkin();
  const simple = skin === "modern";
  if (dom.overlay.open && BOARD_STATE.overlay && (dom.screen.hidden || BOARD_STATE.overlay.skin !== skin)) closeBoardOverlay();
  dom.screen.classList.toggle("board-simple", simple);
  dom.screen.classList.toggle("board-classic", skin === "classic");
  dom.screen.classList.toggle("board-roundtable", skin === "roundtable");
  if (sceneFor(skin)) dom.screen.dataset.scene = skin;
  else delete dom.screen.dataset.scene;
  for (const [name, scene] of Object.entries(scenes)) if (name !== skin) scene.deactivate();
  syncDefaultsFromState();
  renderTopbar();
  renderPublisherStaticLabels();
  renderBriefRows();
  renderLeadAgentPicker();
  renderColumns();
}

const sceneApi = {
  get screen() {
    return dom.screen;
  },
  getState: getHubState,
  getCards: getBoardCards,
  apiFetch,
  escapeHtml,
  getCardTitle,
  getCardNumber,
  getProjectLabel,
  getWaitingBadgeInfo,
  agentName: (id) => getApp().agentName?.(id) || id,
  projectKey: (value) => getApp().projectKey?.(value) ?? String(value || ""),
  getProject: () => BOARD_STATE.project,
  setProject(value) {
    BOARD_STATE.project = value;
  },
  getPublishCwd: () => BOARD_STATE.cwd,
  getOverlay: () => BOARD_STATE.overlay,
  getDialog: () => dom.overlay,
  openOverlay: openBoardOverlay,
  closeOverlay: closeBoardOverlay,
  renderOverlay: () => renderBoardOverlay(filteredBoardCards(getBoardCards())),
  renderBody: () => renderColumns(),
  mountPublisher,
  restorePublisher,
  openSettings: (tab) => getApp().openSettings?.(tab),
  openWorkbench: (groupId) => (groupId ? getApp().openPendingTask?.(groupId) : getApp().setScreenMode?.("workbench")),
  getLeadLabel: (card) => getApp().agentName?.(card?.leadAgent) || card?.leadAgent || "",
};
scenes.classic = createClassicBoard(sceneApi);
scenes.roundtable = createRoundtableBoard(sceneApi);

window.HUB_BOARD = {
  render: renderBoard,
  resume: (card) => handleCardAction(card, "resume"),
  onProgress(groupId) {
    if (BOARD_STATE.overlay?.groupId === groupId) renderBoardOverlay();
  },
  onConfigChanged() {
    for (const scene of Object.values(scenes)) scene.onConfigChanged();
  },
  // Read-only views for browser checks of the scene boards.
  classicDebug: () => scenes.classic.debug(),
  roundtableDebug: () => scenes.roundtable.debug(),
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderBoard(), { once: true });
} else {
  renderBoard();
}

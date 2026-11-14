import { apiFetch, displayTaskTitle, getLocale, th, t } from "./i18n.js";

// Shared Resources & Context/Token Telemetry Stage Panels

const app = window.HUB_APP;

const PANEL_STATE = {
  filter: "all", // all | global-rule | project-rule | skill
  search: "",
  showRuleForm: false,
  expandedId: null,
  previewCache: new Map(),
  loadingResources: false,
  syncNotice: "",
  resourcesCwd: "",
  resourcesGroupId: "",
};

function getResourceScope() {
  const groupId = app?.STATE?.activeGroupId || "";
  const cwd = (groupId ? app?.STATE?.taskGroups?.get(groupId)?.cwd : "") || "";
  return { groupId, cwd };
}

function buildResourceQuery(extra = {}) {
  const { groupId, cwd } = getResourceScope();
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (groupId) params.set("groupId", groupId);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function fetchResources() {
  if (PANEL_STATE.loadingResources) return;
  PANEL_STATE.loadingResources = true;
  try {
    // 规则和技能按项目目录隔离，带上当前任务的 cwd 与 groupId
    const { groupId, cwd } = getResourceScope();
    PANEL_STATE.resourcesCwd = cwd;
    PANEL_STATE.resourcesGroupId = groupId;
    const res = await apiFetch(`/api/resources${buildResourceQuery()}`);
    const data = await res.json();
    if (data.ok) {
      app.STATE.resourcesList = data.resources || [];
      app.STATE.resourceBudgets = data.budgets || [];
      app.refreshHeaderMetrics();
      if (app.STATE.stageView === "resources") {
        renderResourcesPanel();
      }
    }
  } catch (err) {
    app.appendLog(t("couldNotLoadSharedResources", err.message));
  } finally {
    PANEL_STATE.loadingResources = false;
  }
}

async function toggleResource(id, enabled, agent) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await apiFetch("/api/resources/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        enabled,
        agent: agent || undefined,
        cwd: cwd || undefined,
        groupId: groupId || undefined,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      app.STATE.resourcesList = data.resources || [];
      app.STATE.resourceBudgets = data.budgets || [];
      app.refreshHeaderMetrics();
      renderResourcesPanel();
    }
  } catch (err) {
    app.appendLog(t("couldNotChangeResourceStatus", err.message));
  }
}

async function saveCustomRule(name, scope, content) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await apiFetch("/api/resources/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        scope,
        content,
        cwd: cwd || undefined,
        groupId: groupId || undefined,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      app.STATE.resourcesList = data.resources || [];
      app.STATE.resourceBudgets = data.budgets || [];
      PANEL_STATE.showRuleForm = false;
      app.refreshHeaderMetrics();
      app.appendLog(t("savedSharedRule", name, scope));
      renderResourcesPanel();
    } else {
      app.appendLog(t("couldNotSaveRule", data.error || "unknown"));
    }
  } catch (err) {
    app.appendLog(t("ruleSaveError", err.message));
  }
}

async function deleteCustomRule(id) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await apiFetch("/api/resources/rules/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        cwd: cwd || undefined,
        groupId: groupId || undefined,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      app.STATE.resourcesList = data.resources || [];
      app.STATE.resourceBudgets = data.budgets || [];
      if (PANEL_STATE.expandedId === id) PANEL_STATE.expandedId = null;
      app.refreshHeaderMetrics();
      renderResourcesPanel();
    }
  } catch (err) {
    app.appendLog(t("couldNotDeleteRule", err.message));
  }
}

async function syncProjectRuleFiles() {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await apiFetch("/api/resources/sync-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: cwd || undefined,
        groupId: groupId || undefined,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const names = (data.updatedFiles || []).map((p) => p.split(/[\\/]/).pop()).join(", ");
      PANEL_STATE.syncNotice = t("wroteProjectRuleBlock", names);
      app.appendLog(PANEL_STATE.syncNotice);
      await fetchResources();
    }
  } catch (err) {
    app.appendLog(t("couldNotSyncProjectRuleFiles", err.message));
  }
}

async function togglePreviewResource(id) {
  if (PANEL_STATE.expandedId === id) {
    PANEL_STATE.expandedId = null;
    renderResourcesPanel();
    return;
  }
  PANEL_STATE.expandedId = id;
  const { cwd } = getResourceScope();
  const cacheKey = `${cwd}::${id}`;
  if (!PANEL_STATE.previewCache.has(cacheKey)) {
    try {
      const res = await apiFetch(`/api/resources/content${buildResourceQuery({ id })}`);
      const data = await res.json();
      if (data.ok) {
        PANEL_STATE.previewCache.set(cacheKey, data.content || "");
      }
    } catch {
      PANEL_STATE.previewCache.set(cacheKey, t("couldNotReadContent"));
    }
  }
  renderResourcesPanel();
}

function renderResourcesPanel() {
  const container = app.els.resourcesView;
  if (!container) return;

  const oldRuleForm = container.querySelector("#hubRuleForm");
  const draftName = oldRuleForm?.querySelector("#hubRuleName").value || "";
  const draftScope = oldRuleForm?.querySelector("#hubRuleScope").value || "project";
  const draftContent = oldRuleForm?.querySelector("#hubRuleContent").value || "";
  const esc = app.escapeHtml;
  const fmtTok = app.formatTokens;
  const items = app.STATE.resourcesList || [];
  const budgets = app.STATE.resourceBudgets || [];

  const enabledRules = items.filter((i) => i.enabled && i.kind === "rule").length;
  const enabledSkills = items.filter((i) => i.enabled && i.kind === "skill").length;

  const filtered = items.filter((item) => {
    if (PANEL_STATE.filter === "global-rule" && !(item.kind === "rule" && item.scope === "global")) return false;
    if (PANEL_STATE.filter === "project-rule" && !(item.kind === "rule" && item.scope === "project")) return false;
    if (PANEL_STATE.filter === "skill" && item.kind !== "skill") return false;
    if (PANEL_STATE.search.trim()) {
      const q = PANEL_STATE.search.trim().toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.primaryPath.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const budgetCards = budgets
    .map(
      (b) => `
      <div class="stat-card">
        <div class="stat-card-label">
          ${app.agentTagHtml ? app.agentTagHtml(b.agent) : `<span class="agent-tag" data-agent="${esc(b.agent)}">${esc(b.agent)}</span>`}
          <span>${th("firstTurnBridgingTokens", fmtTok(b.firstTurnInjectionTokens))}</span>
        </div>
        <div class="stat-card-value">${th("rulesSkills", b.nativeRules + b.bridgedRules, b.nativeSkills + b.bridgedSkills)}</div>
        <div class="stat-card-meta">
          <span>${th("nativeRulesSkills", b.nativeRules, b.nativeSkills)}</span>
          <span>${th("injectedByRtmRulesSkills", b.bridgedRules, b.bridgedSkills)}</span>
        </div>
        ${b.droppedRules?.length ? `<div class="stat-card-warn" title="${esc(b.droppedRules.join("、"))}">${th("rulesOverBudgetPathsOnly", b.droppedRules.length)}</div>` : ""}
      </div>`,
    )
    .join("");

  const enabledAgentIds = (app.getEnabledAgents?.() || []).map((a) => a.agent);
  const covAgents = enabledAgentIds.length > 0 ? enabledAgentIds : ["claude", "codex", "agy", "opencode", "kimi"];

  const ruleFormHtml = PANEL_STATE.showRuleForm
    ? `
      <form id="hubRuleForm" class="rule-editor-box">
        <div class="rule-editor-row">
          <input id="hubRuleName" class="text-input" type="text" placeholder="${th("ruleNameEGProjectConventions")}" required />
          <select id="hubRuleScope" class="perm-select">
            <option value="project">${th("scopeCurrentProjectRtm")}</option>
            <option value="global">${th("scopeGlobalRtm")}</option>
          </select>
        </div>
        <textarea id="hubRuleContent" class="rule-editor-textarea" placeholder="${th("ruleEditorPlaceholder", covAgents.join(" / "))}"></textarea>
        <div class="panel-toolbar">
          <span class="mono" style="font-size:11px;color:var(--faint)">${th("savesToRtmWithoutChangingTheAgents")}</span>
          <div style="display:flex;gap:8px">
            <button id="cancelRuleFormBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button">${th("cancel")}</button>
            <button class="alma-btn alma-btn-primary alma-btn-sm" type="submit">${th("saveSharedRule")}</button>
          </div>
        </div>
      </form>`
    : "";

  const { cwd: previewCwd } = getResourceScope();
  const rowsHtml =
    filtered.length === 0
      ? `<div class="empty-note">${th("noRulesOrSkillsMatchTheCurrent")}</div>`
      : filtered
          .map((item) => {
            const isExpanded = PANEL_STATE.expandedId === item.id;
            const previewText = isExpanded
              ? PANEL_STATE.previewCache.get(`${previewCwd}::${item.id}`) || t("loading")
              : "";
            const canDelete = item.origin === "hub-project" || item.origin === "hub-global";
            const covHtml = covAgents
              .map((ag) => {
                if (!item.enabled) {
                  return `<span class="cov-pill off">${th("disabled", ag)}</span>`;
                }
                // 点一下只对这一个 Agent 停用或恢复，其他 Agent 不受影响
                const offForAgent = (item.disabledAgents || []).includes(ag);
                const isNative = item.nativeAgents.includes(ag);
                const cls = offForAgent ? "off" : isNative ? "native" : "bridged";
                const text = offForAgent ? t("disable") : isNative ? t("native") : t("injected");
                const tip = offForAgent ? t("reEnableFor", ag) : t("disableForOnly", ag);
                return `<button type="button" class="cov-pill ${cls}" data-toggle-res-agent="${esc(item.id)}" data-agent="${esc(ag)}" data-next-enabled="${offForAgent}" title="${tip}">${ag}: ${text}</button>`;
              })
              .join("");

            const tokText =
              item.kind === "skill"
                ? t("indexFullTextTokens", item.indexTokens, fmtTok(item.fullTokens))
                : `~${fmtTok(item.fullTokens)} tok`;

            return `
              <div class="resource-row ${item.enabled ? "" : "disabled"}">
                <div class="resource-row-top">
                  <div class="resource-main">
                    <div class="resource-title-line">
                      <span class="kind-tag ${esc(item.kind)}">${item.kind === "rule" ? "RULE" : "SKILL"}</span>
                      <span class="scope-tag">${item.scope === "project" ? t("project") : t("global")}</span>
                      <span class="origin-tag">${esc(item.origin)}</span>
                      <span class="resource-name">${esc(item.name)}</span>
                      <span class="origin-tag">${tokText}</span>
                    </div>
                    <div class="resource-desc">${esc(item.description)}</div>
                    <div class="resource-path">${esc(item.primaryPath)}${item.sources.length > 1 ? t("duplicateSources", item.sources.length - 1) : ""}</div>
                  </div>
                  <div class="resource-right">
                    <div class="coverage-pills">${covHtml}</div>
                    <div class="resource-actions">
                      <button class="alma-btn alma-btn-outline alma-btn-sm" data-preview-res="${esc(item.id)}" type="button">${isExpanded ? t("collapse") : t("preview")}</button>
                      <button class="alma-btn alma-btn-sm ${item.enabled ? "" : "alma-btn-primary"}" data-toggle-res="${esc(item.id)}" data-next-enabled="${!item.enabled}" type="button">${item.enabled ? t("disable") : t("enable")}</button>
                      ${canDelete ? `<button class="alma-btn alma-btn-danger alma-btn-sm" data-del-res="${esc(item.id)}" type="button">${th("delete")}</button>` : ""}
                    </div>
                  </div>
                </div>
                ${isExpanded ? `<pre class="resource-preview-box">${esc(previewText)}</pre>` : ""}
              </div>`;
          })
          .join("");

  container.innerHTML = `
    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("rulesAndSkillsByAgent")}</div>
      <div class="panel-sec-sub">${th("rtmInjectsMissingRulesInFullAnd", items.filter((i) => i.kind === "skill").reduce((s, i) => s + i.indexTokens, 0))}</div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>${th("enabledSharedResources")}</span><span>${th("afterDeduplication")}</span></div>
        <div class="stat-card-value">${th("rulesSkills", enabledRules, enabledSkills)}</div>
        <div class="stat-card-meta"><span>${th("found", items.length)}</span><span>${th("projectGlobal")}</span></div>
      </div>
      ${budgetCards}
    </div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("rulesAndSkills")}</div>
      <div class="panel-sec-sub">${PANEL_STATE.syncNotice ? esc(PANEL_STATE.syncNotice) : ""}</div>
    </div>

    <div class="panel-toolbar">
      <div class="filter-pills">
        <button class="filter-pill ${PANEL_STATE.filter === "all" ? "active" : ""}" data-res-filter="all" type="button">${th("all", items.length)}</button>
        <button class="filter-pill ${PANEL_STATE.filter === "global-rule" ? "active" : ""}" data-res-filter="global-rule" type="button">${th("globalRules")}</button>
        <button class="filter-pill ${PANEL_STATE.filter === "project-rule" ? "active" : ""}" data-res-filter="project-rule" type="button">${th("projectRules")}</button>
        <button class="filter-pill ${PANEL_STATE.filter === "skill" ? "active" : ""}" data-res-filter="skill" type="button">${th("sharedSkills")}</button>
      </div>
      <div class="toolbar-right">
        <input id="resSearchInput" class="panel-search" type="search" placeholder="${th("searchRuleAndSkillNamesOrPaths")}" value="${esc(PANEL_STATE.search)}" />
        <button id="toggleNewRuleBtn" class="alma-btn alma-btn-primary alma-btn-sm" type="button">${th("newSharedRule")}</button>
        <button id="syncProjectFilesBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button" title="${th("syncTheSharedRuleBlockToAgents")}">${th("syncToProjectFiles")}</button>
      </div>
    </div>

    ${ruleFormHtml}

    <div class="resource-list">${rowsHtml}</div>
  `;

  container.querySelectorAll("[data-res-filter]").forEach((btn) => {
    btn.onclick = () => {
      PANEL_STATE.filter = btn.dataset.resFilter || "all";
      renderResourcesPanel();
    };
  });

  const searchInput = container.querySelector("#resSearchInput");
  if (searchInput) {
    searchInput.oninput = (e) => {
      PANEL_STATE.search = e.target.value;
      renderResourcesPanel();
      const refocused = container.querySelector("#resSearchInput");
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(refocused.value.length, refocused.value.length);
      }
    };
  }

  const toggleFormBtn = container.querySelector("#toggleNewRuleBtn");
  if (toggleFormBtn) {
    toggleFormBtn.onclick = () => {
      PANEL_STATE.showRuleForm = !PANEL_STATE.showRuleForm;
      renderResourcesPanel();
    };
  }

  const cancelFormBtn = container.querySelector("#cancelRuleFormBtn");
  if (cancelFormBtn) {
    cancelFormBtn.onclick = () => {
      PANEL_STATE.showRuleForm = false;
      renderResourcesPanel();
    };
  }

  const ruleForm = container.querySelector("#hubRuleForm");
  if (ruleForm) {
    const nameInput = ruleForm.querySelector("#hubRuleName");
    const scopeInput = ruleForm.querySelector("#hubRuleScope");
    const contentInput = ruleForm.querySelector("#hubRuleContent");
    nameInput.value = draftName;
    scopeInput.value = draftScope;
    contentInput.value = draftContent;
    ruleForm.onsubmit = (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const scope = scopeInput.value;
      const content = contentInput.value.trim();
      if (name && content) {
        void saveCustomRule(name, scope, content);
      }
    };
  }

  const syncBtn = container.querySelector("#syncProjectFilesBtn");
  if (syncBtn) {
    syncBtn.onclick = () => void syncProjectRuleFiles();
  }

  container.querySelectorAll("[data-preview-res]").forEach((btn) => {
    btn.onclick = () => void togglePreviewResource(btn.dataset.previewRes);
  });

  container.querySelectorAll("[data-toggle-res]").forEach((btn) => {
    btn.onclick = () =>
      void toggleResource(btn.dataset.toggleRes, btn.dataset.nextEnabled === "true");
  });

  container.querySelectorAll("[data-toggle-res-agent]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      void toggleResource(btn.dataset.toggleResAgent, btn.dataset.nextEnabled === "true", btn.dataset.agent);
    };
  });

  container.querySelectorAll("[data-del-res]").forEach((btn) => {
    btn.onclick = () => void deleteCustomRule(btn.dataset.delRes);
  });
}

function renderTelemetryPanel() {
  const container = app.els.telemetryView;
  if (!container) return;

  const esc = app.escapeHtml;
  const fmtTok = app.formatTokens;
  const enabledAgentIds = (app.getEnabledAgents?.() || []).map((a) => a.agent);
  const baseAgentList = enabledAgentIds.length > 0 ? enabledAgentIds : ["claude", "codex", "agy", "opencode", "kimi"];
  const telemetry = app.STATE.telemetry || {
    totals: { turns: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0, costUsd: 0 },
    byAgent: {},
    recentTurns: [],
  };

  const allTelemetryAgents = [...new Set([...baseAgentList, ...Object.keys(telemetry.byAgent || {})])];
  const totals = telemetry.totals;
  const cacheBase = totals.inputTokens + totals.cachedReadTokens;
  const cacheRate = cacheBase > 0 ? Math.round((totals.cachedReadTokens / cacheBase) * 100) : 0;

  const agentCards = allTelemetryAgents
    .map((ag) => {
      const t = telemetry.byAgent?.[ag] || { turns: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0, costUsd: 0 };
      const aCacheBase = t.inputTokens + t.cachedReadTokens;
      const aCachePct = aCacheBase > 0 ? Math.round((t.cachedReadTokens / aCacheBase) * 100) : 0;
      const costText = t.costUsd > 0 ? ` · $${t.costUsd.toFixed(4)}` : "";
      const tagHtml = app.agentTagHtml ? app.agentTagHtml(ag) : `<span class="agent-tag" data-agent="${esc(ag)}">${esc(ag)}</span>`;
      return `
        <div class="stat-card">
          <div class="stat-card-label">
            ${tagHtml}
            <span>${th("agentTurnCount", t.turns, t.modelId ? ` · ${t.modelId}` : "", costText)}</span>
          </div>
          <div class="stat-card-value">${fmtTok(t.totalTokens)}</div>
          <div class="stat-card-meta">
            <span>${th("input", fmtTok(t.inputTokens))}</span>
            <span>${th("cached2", fmtTok(t.cachedReadTokens), aCachePct)}</span>
            <span>${th("output2", fmtTok(t.outputTokens + t.thoughtTokens))}</span>
          </div>
        </div>`;
    })
    .join("");

  // 上下文分析：按任务分组，主导在上、子会话缩进在下；每个会话一条「窗口里装了什么」的分段条
  const sessions = [...app.STATE.sessions.values()];
  const byGroup = new Map();
  for (const sess of sessions) {
    const list = byGroup.get(sess.groupId) || [];
    list.push(sess);
    byGroup.set(sess.groupId, list);
  }
  const groupsSorted = [...byGroup.entries()].sort(
    (x, y) => Math.max(...y[1].map((s) => s.updatedAt)) - Math.max(...x[1].map((s) => s.updatedAt)),
  );

  const analyzeSession = (sess) => {
    const cb = sess.contextBreakdown || {};
    const rules = cb.sharedRulesTokens || 0;
    const skills = cb.skillsIndexTokens || 0;
    const handoff = cb.handoffTokens || 0;
    const dialog = (cb.userPromptsTokens || 0) + (cb.agentOutputsTokens || 0);
    const known = rules + skills + handoff + dialog;
    const winMax = sess.usage?.maxTokens || 0;
    const winUsed = sess.usage?.usedTokens || 0;
    // 适配器回报了窗口占用时，以它为准：已知四项之外的差额就是工具结果、原生规则、系统提示等
    const other = winUsed > known ? winUsed - known : 0;
    const used = winUsed > 0 ? Math.max(winUsed, known) : known;
    const scale = winMax > 0 ? winMax : Math.max(1, used);
    const totals = sess.tokenTotals || {};
    const cacheBase = (totals.inputTokens || 0) + (totals.cachedReadTokens || 0);
    const cachePct = cacheBase > 0 ? Math.round(((totals.cachedReadTokens || 0) / cacheBase) * 100) : null;

    const notes = [];
    if (winMax > 0 && used / winMax >= 0.8) {
      notes.push({ level: "warn", text: t("contextWindowIsFullStartANew", Math.round((used / winMax) * 100)) });
    }
    if (used > 0 && (rules + skills) / used >= 0.3 && rules + skills >= 2000) {
      notes.push({ level: "info", text: t("injectedRulesAndTheSkillIndexAccount", Math.round(((rules + skills) / used) * 100)) });
    }
    if (used > 0 && other / used >= 0.6) {
      notes.push({ level: "info", text: t("comesFromToolResultsAndAgentSystem", Math.round((other / used) * 100)) });
    }
    if (handoff >= 8000) {
      notes.push({ level: "info", text: t("tokensOfHistoryWerePassedToThe", fmtTok(handoff)) });
    }
    if ((cb.droppedRules || []).length > 0) {
      notes.push({ level: "warn", text: t("rulesOverBudgetPathsOnly", cb.droppedRules.length) });
    }
    return { cb, rules, skills, handoff, dialog, other, used, winMax, winUsed, scale, totals, cachePct, notes };
  };

  const segment = (cls, value, scale) =>
    value > 0 ? `<div class="${cls}" style="width:${((value / scale) * 100).toFixed(2)}%"></div>` : "";

  const sessionRow = (sess) => {
    const a = analyzeSession(sess);
    const isSub = sess.role !== "lead";
    const ruleBadges = (a.cb.injectedRules || [])
      .map((r) => `<span class="origin-tag">${esc(r.name)} ${fmtTok(r.tokens)}</span>`)
      .join("");
    const legend = [
      ["seg-rules", t("rules"), a.rules],
      ["seg-skills", t("skillIndex"), a.skills],
      ["seg-handoff", t("handoff"), a.handoff],
      ["seg-dialog", t("chat"), a.dialog],
      ["seg-other", t("toolsAndOther"), a.other],
    ]
      .filter(([, , v]) => v > 0)
      .map(([cls, label, v]) => `<span><i class="legend-dot ${cls}"></i>${label} ${fmtTok(v)}</span>`)
      .join("");
    return `
      <div class="ctx-session${isSub ? " is-sub" : ""}">
        <div class="ctx-session-head">
          <div class="ctx-session-name">
            ${app.agentTagHtml ? app.agentTagHtml(sess.agent) : `<span class="agent-tag" data-agent="${esc(sess.agent)}">${esc(sess.agent)}</span>`}
            <span>${isSub ? esc(sess.label || sess.name) : t("lead")}</span>
            ${sess.currentModelId ? `<span class="ctx-faint">${esc(sess.currentModelId.split("/").pop())}</span>` : ""}
          </div>
          <div class="ctx-faint">
            ${a.winMax > 0 ? t("contextWindow", fmtTok(a.used), fmtTok(a.winMax), Math.round((a.used / a.winMax) * 100)) : a.used > 0 ? t("tokensTheAdapterDidNotReportThe", fmtTok(a.used)) : t("noDataYet")}
            ${a.cachePct !== null ? t("cacheHitRate", a.cachePct) : ""}
          </div>
        </div>
        <div class="stacked-bar" title="${th("breakdownOfTheContextWindow")}">
          ${segment("seg-rules", a.rules, a.scale)}${segment("seg-skills", a.skills, a.scale)}${segment("seg-handoff", a.handoff, a.scale)}${segment("seg-dialog", a.dialog, a.scale)}${segment("seg-other", a.other, a.scale)}
        </div>
        ${legend ? `<div class="legend-row">${legend}</div>` : ""}
        ${a.notes.map((n) => `<div class="ctx-note ${n.level}">${esc(n.text)}</div>`).join("")}
        ${ruleBadges ? `<details class="ctx-rules"><summary>${th("injectedRules", (a.cb.injectedRules || []).length)}</summary><div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">${ruleBadges}</div></details>` : ""}
      </div>`;
  };

  const breakdownHtml =
    groupsSorted.length === 0
      ? `<div class="empty-note">${th("noSessionsYetSendAMessageTo")}</div>`
      : groupsSorted
          .map(([groupId, list]) => {
            const grp = app.STATE.taskGroups.get(groupId);
            const leads = list.filter((s) => s.role === "lead");
            const subs = list.filter((s) => s.role !== "lead").sort((x, y) => x.createdAt - y.createdAt);
            const sumTotal = (arr) => arr.reduce((n, s) => n + (s.tokenTotals?.totalTokens || 0), 0);
            const leadTok = sumTotal(leads);
            const subTok = sumTotal(subs);
            const handoffTok = list.reduce((n, s) => n + (s.contextBreakdown?.handoffTokens || 0), 0);
            const turns = list.reduce((n, s) => n + (s.tokenTotals?.turns || 0), 0);
            return `
              <div class="breakdown-card">
                <div class="breakdown-top">
                  <strong>${esc(grp ? displayTaskTitle(grp) : groupId)}</strong>
                  <div class="ctx-faint">
                    ${th("groupUsage", fmtTok(leadTok + subTok), turns)}
                    ${subs.length > 0 ? th("groupSubsessionUsage", fmtTok(leadTok), subs.length, fmtTok(subTok)) : ""}
                    ${handoffTok > 0 ? th("groupHandoffUsage", fmtTok(handoffTok)) : ""}
                  </div>
                </div>
                ${leads.map(sessionRow).join("")}
                ${subs.map(sessionRow).join("")}
              </div>`;
          })
          .join("");

  const recentTurns = [...(telemetry.recentTurns || [])].reverse();
  const rowsHtml =
    recentTurns.length === 0
      ? `<tr><td colspan="10" style="text-align:center;color:var(--faint)">${th("noTurnsYet")}</td></tr>`
      : recentTurns
          .map((turn) => {
            const u = turn.usage || {};
            const turnGroup = app.STATE.taskGroups.get(turn.groupId);
            const inj = (turn.injectedRulesTokens || 0) + (turn.injectedSkillsTokens || 0) + (turn.handoffTokens || 0);
            return `
              <tr>
                <td>#${turn.turnSeq}</td>
                <td>${app.formatTime(turn.timestamp)}</td>
                <td>${esc(turnGroup ? displayTaskTitle(turnGroup) : turn.groupTitle || turn.groupId)}</td>
                <td>${app.agentTagHtml ? app.agentTagHtml(turn.agent) : `<span class="agent-tag" data-agent="${esc(turn.agent)}">${esc(turn.agent)}</span>`}${u.modelId ? ` <span class="mono" style="font-size:10.5px;color:var(--muted)">${esc(u.modelId)}</span>` : ""}</td>
                <td>${turn.role === "lead" ? t("lead") : t("subsession2")}</td>
                <td class="num-col">${inj > 0 ? `+${fmtTok(inj)}` : "0"}</td>
                <td class="num-col">${fmtTok(u.inputTokens)}</td>
                <td class="num-col">${fmtTok(u.cachedReadTokens)}</td>
                <td class="num-col">${fmtTok(u.outputTokens + u.thoughtTokens)}</td>
                <td class="num-col"><strong>${u.isEstimated ? "~" : ""}${fmtTok(u.totalTokens)}</strong></td>
              </tr>`;
          })
          .join("");

  container.innerHTML = `
    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("tokenUsage")}</div>
      <div class="panel-sec-sub"></div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>${th("allAgents")}</span><span>${th("totalTurnCount", totals.turns, totals.estimatedTurns ? t("estimated", totals.estimatedTurns) : "")}</span></div>
        <div class="stat-card-value">${fmtTok(totals.totalTokens)}</div>
        <div class="stat-card-meta">
          <span>${th("input", fmtTok(totals.inputTokens))}</span>
          <span>${th("cacheHitRate2", cacheRate)}</span>
          <span>${th("output2", fmtTok(totals.outputTokens + totals.thoughtTokens))}</span>
        </div>
      </div>
      ${agentCards}
    </div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("contextBreakdown")}</div>
      <div class="panel-sec-sub"></div>
    </div>

    <div class="session-breakdown-list">${breakdownHtml}</div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("turnHistory")}</div>
      <div class="panel-sec-sub">${th("indicatesAnEstimate")}</div>
    </div>

    <div class="telemetry-table-wrap">
      <table class="telemetry-table">
        <thead>
          <tr>
            <th>#</th>
            <th>${th("time")}</th>
            <th>${th("taskGroup")}</th>
            <th>Agent</th>
            <th>${th("role")}</th>
            <th class="num-col">${th("contextInjection")}</th>
            <th class="num-col">Input</th>
            <th class="num-col">Cache Read</th>
            <th class="num-col">Out / Think</th>
            <th class="num-col">Total</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 工作流：把主导要分给子会话的活先摆成几步（可以有先后依赖），确认后再一起发布
// ---------------------------------------------------------------------------
const WF_STATE = {
  drafts: new Map(), // groupId -> { steps, baseUpdatedAt, dirty, version }
  ctxDrafts: new Map(), // groupId -> { common, sections, stamp, dirty, version }
  ctxOpen: false, // 共享上下文区域是否展开
  zoom: 1, // 流程画布缩放比例 (0.6 - 1.6)
  lastSignature: "",
  selectedId: null, // 明细浮窗当前对着的步骤
};

function buildWorkflowTemplateSteps(templateKey, agents, leadAgent) {
  const pool = (Array.isArray(agents) ? agents : []).filter((a) => a.available !== false);
  const all = pool.length > 0 ? pool : agents || [];
  const primary = all[0]?.agent || leadAgent || "claude";
  const secondary = all.find((a) => a.agent !== primary)?.agent || primary;
  const third = all.find((a) => a.agent !== primary && a.agent !== secondary)?.agent || leadAgent || primary;

  if (templateKey === "impl-review") {
    return [
      {
        id: "step1",
        name: t("designAndImplementation"),
        agent: primary,
        prompt: t("readTheRequirementsAndExistingCodeImplement"),
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step2",
        name: t("codeReviewAndTests"),
        agent: secondary,
        prompt: t("reviewThePreviousChangesForEdgeCases"),
        dependsOn: ["step1"],
        isolateWorktree: false,
        contextRefs: [],
      },
    ];
  }
  if (templateKey === "parallel-research") {
    return [
      {
        id: "step1",
        name: t("reviewTheCurrentCode"),
        agent: primary,
        prompt: t("traceTheExistingImplementationAndCallPaths"),
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step2",
        name: t("assessOptionsAndRisks"),
        agent: secondary,
        prompt: t("evaluateImplementationOptionsForPerformanceCompatibilityAnd"),
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step3",
        name: t("summarizeFindingsAndActions"),
        agent: third,
        prompt: t("combineTheFindingsFromTheFirstTwo"),
        dependsOn: ["step1", "step2"],
        isolateWorktree: false,
        contextRefs: [],
      },
    ];
  }
  return [
    {
      id: "step1",
      name: t("makeChangesInAWorktree"),
      agent: primary,
      prompt: t("implementTheChangesInAnIsolatedGit"),
      dependsOn: [],
      isolateWorktree: true,
      contextRefs: [],
    },
    {
      id: "step2",
      name: t("regressionTestingAndAcceptance"),
      agent: secondary,
      prompt: t("checkTheWorkspaceChangeSummaryAndRun"),
      dependsOn: ["step1"],
      isolateWorktree: false,
      contextRefs: [],
    },
  ];
}

// 带验收关卡的步骤，运行中要分清是在做、在验收还是在返工
function workflowErrorText(step) {
  if (step.errorKind) return t(step.errorKind, step.round ?? 1);
  if (step.error === "验收方没有给出 VERDICT 结论，需要人工判断") {
    return t("reviewVerdictMissing");
  }
  const reviewRounds = step.error.match(/^验收未通过（已验收 (\d+) 轮）$/);
  if (reviewRounds) return t("reviewAttemptsExhausted", reviewRounds[1]);
  return step.error === "hub 重启时中断" ? t("serviceRestarted") : step.error;
}

function wfStepStatusText(live, status) {
  if (status === "running" && live?.review) {
    if (live.phase === "review") return t("inReviewRound", live.round || 1);
    if ((live.round || 1) > 1) return t("reworkingRound", live.round);
  }
  return t(WF_STEP_STATUS_TEXT[status] || status);
}

const WF_STEP_STATUS_TEXT = {
  draft: "draft",
  pending: "waitingForDependencies",
  running: "inProgress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

function wfServerWorkflow(groupId) {
  return app.STATE.workflows?.get(groupId) || { groupId, status: "draft", steps: [], updatedAt: 0 };
}

// 本地草稿：服务端有更新且本地没有未保存的改动时，跟随服务端
function wfDraft(groupId) {
  const server = wfServerWorkflow(groupId);
  let draft = WF_STATE.drafts.get(groupId);
  if (!draft || (!draft.dirty && draft.baseUpdatedAt !== server.updatedAt)) {
    draft = {
      steps: server.steps.map((s) => ({
        id: s.id,
        name: s.name,
        agent: s.agent,
        prompt: s.prompt,
        dependsOn: [...s.dependsOn],
        isolateWorktree: Boolean(s.isolateWorktree),
        contextRefs: [...(s.contextRefs || [])],
        review: s.review ? { ...s.review } : null,
      })),
      baseUpdatedAt: server.updatedAt,
      dirty: false,
      version: (draft?.version || 0) + 1,
    };
    WF_STATE.drafts.set(groupId, draft);
  }
  return draft;
}

function wfTouch(draft, structural) {
  draft.dirty = true;
  if (structural) draft.version += 1;
}

// 每一步离起点有几层依赖，用来缩进，让先后关系一眼能看出来
function wfDepths(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map();
  const depth = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const step = byId.get(id);
    const d = step && step.dependsOn.length > 0 ? 1 + Math.max(...step.dependsOn.map((dep) => depth(dep, seen))) : 0;
    memo.set(id, d);
    return d;
  };
  return new Map(steps.map((s) => [s.id, depth(s.id)]));
}

async function wfPost(path, body, raw) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (data.workflow) {
    app.STATE.workflows.set(data.workflow.groupId, data.workflow);
  }
  return raw ? data : data.workflow;
}

function wfServerContext(groupId) {
  return app.STATE.contexts?.get(groupId) || { groupId, sections: [] };
}

// 共享上下文的本地草稿：公共分区 + 手写的命名分区。步骤结果由系统写入，只读，不进草稿
function wfContextDraft(groupId) {
  const server = wfServerContext(groupId);
  const stamp = server.sections.map((s) => `${s.key}:${s.updatedAt}`).join("|");
  let draft = WF_STATE.ctxDrafts.get(groupId);
  if (!draft || (!draft.dirty && draft.stamp !== stamp)) {
    draft = {
      common: server.sections.find((s) => s.kind === "common")?.content || "",
      sections: server.sections
        .filter((s) => s.kind === "section")
        .map((s) => ({ key: s.key, summary: s.summary || "", content: s.content, saved: true })),
      stamp,
      dirty: false,
      version: (draft?.version || 0) + 1,
    };
    WF_STATE.ctxDrafts.set(groupId, draft);
  }
  return draft;
}

async function wfSaveContext(groupId) {
  const draft = wfContextDraft(groupId);
  if (!draft.dirty) return;
  const res = await apiFetch("/api/context/replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      groupId,
      common: draft.common,
      sections: draft.sections
        .filter((s) => s.key.trim() && s.content.trim())
        .map((s) => ({ key: s.key.trim(), summary: s.summary.trim() || undefined, content: s.content })),
    }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  app.STATE.contexts.set(groupId, data.context);
  draft.dirty = false;
  draft.stamp = "";
}

async function wfSave(groupId) {
  // 步骤引用的分区要先存在，所以先存上下文再存步骤
  await wfSaveContext(groupId);
  const draft = wfDraft(groupId);
  const workflow = await wfPost("/api/workflows/save", { groupId, steps: draft.steps });
  draft.dirty = false;
  draft.baseUpdatedAt = -1; // 下次渲染时按服务端返回的结果重建
  return workflow;
}

// 模板：把一套编排（步骤、先后、Agent、验收关卡）存下来，换个任务还能直接载入
async function wfLoadTemplates() {
  try {
    const data = await (await apiFetch("/api/workflows/templates")).json();
    WF_STATE.templates = data.templates || [];
  } catch {
    WF_STATE.templates = [];
  }
}

async function wfTemplateAction(groupId, value) {
  try {
    if (value === "save") {
      const name = await app.showPromptModal({ title: t("saveAsTemplate"), label: t("templateName"), confirmText: t("save") });
      if (!name || !String(name).trim()) return;
      await wfSave(groupId);
      const data = await wfPost("/api/workflows/templates/save", { groupId, name: String(name).trim() }, true);
      WF_STATE.templates = data.templates || [];
    } else if (value.startsWith("load:")) {
      const draft = wfDraft(groupId);
      if (draft.steps.length > 0) {
        const ok = await app.showConfirmModal({
          title: t("loadTemplate"),
          message: t("theTemplateReplacesTheCurrentStepsUpdate"),
          confirmText: t("load"),
        });
        if (!ok) return;
      }
      await wfPost("/api/workflows/templates/apply", { groupId, name: value.slice(5) });
      draft.dirty = false;
      draft.baseUpdatedAt = -1;
    } else if (value.startsWith("delete:")) {
      const data = await wfPost("/api/workflows/templates/delete", { name: value.slice(7) }, true);
      WF_STATE.templates = data.templates || [];
    }
  } catch (err) {
    await app.showConfirmModal({ title: t("couldNotApplyTemplateAction"), message: err.message, confirmText: t("ok") });
  }
  WF_STATE.lastSignature = "";
  renderWorkflowPanel();
}

// 内存紧张时发布工作流要先问一句：这正是把后端拖垮的场景
async function wfConfirmMemory() {
  const mem = app.getMemoryStatus ? app.getMemoryStatus() : { level: "ok" };
  if (mem.level === "ok") return true;
  const gb = mem.availableMB !== undefined ? (mem.availableMB / 1024).toFixed(1) : "?";
  return app.showConfirmModal({
    title: t("lowAvailableMemory"),
    message: t("aboutGbOfSystemMemoryRemainsEach", gb),
    confirmText: t("publishAnyway"),
    cancelText: t("cancel2"),
  });
}

async function wfRunAction(groupId, action) {
  try {
    if (action === "save") await wfSave(groupId);
    else if ((action === "run" || action === "resume") && !(await wfConfirmMemory())) return;
    else if (action === "run") {
      await wfSave(groupId);
      await wfPost("/api/workflows/run", { groupId });
    } else if (action === "retry") {
      await wfSaveContext(groupId);
      const curDraft = wfDraft(groupId);
      if (curDraft.dirty) await wfSave(groupId);
      await wfPost("/api/workflows/retry", { groupId });
    } else if (action === "resume") {
      await wfPost("/api/workflows/resume", { groupId });
    } else if (action === "cancel") await wfPost("/api/workflows/cancel", { groupId });
  } catch (err) {
    await app.showConfirmModal({ title: t("workflowDidNotRun"), message: err.message, confirmText: t("ok") });
  }
  WF_STATE.lastSignature = "";
  renderWorkflowPanel();
}

async function wfAskLeadToDraft(group) {
  const goal = await app.showPromptModal({
    title: t("askToDraftAWorkflow", group.leadAgent),
    message: t("enterAGoalTheLeadWillBreak"),
    placeholder: t("exampleAddUnitTestsForSignIn"),
    confirmText: t("draftWorkflow"),
  });
  if (!goal || !goal.trim()) return;
  const prompt = [
    t("planASubsessionWorkflowForTheGoal"),
    t("forEachStepSpecifyTheAgentCheck"),
    t("submitTheDraftOnlyDoNotRun"),
    "",
    t("goal", goal.trim()),
  ].join("\n");
  void app.sendStreamPrompt(prompt, `lead:${group.groupId}`);
  app.appendLog(t("askedToDraftAWorkflow", group.leadAgent));
}

// 流程图布局：按「离起点有几层依赖」分列，从左到右；同一列里自上而下排
const WF_NODE_W = 228;
const WF_NODE_H = 72;
const WF_COL_GAP = 64;
const WF_ROW_GAP = 16;
const WF_PAD = 18;

function wfGetStepOutputPreview(groupId, stepId, sessionKey) {
  const resultSec = wfServerContext(groupId).sections.find(
    (s) => s.kind === "result" && s.key === `result:${stepId}`,
  );
  if (resultSec && resultSec.content && resultSec.content.trim()) {
    return resultSec.content.trim();
  }
  if (!sessionKey) return "";
  const stream = app.STATE.messagesByStream?.get(`sub:${sessionKey}`) || [];
  for (let i = stream.length - 1; i >= 0; i--) {
    if (stream[i].role === "assistant" && stream[i].text && stream[i].text.trim()) {
      return stream[i].text.trim();
    }
  }
  return "";
}

function wfLayout(steps) {
  const depths = wfDepths(steps);
  const columns = [];
  for (const step of steps) {
    const d = depths.get(step.id) || 0;
    (columns[d] = columns[d] || []).push(step);
  }
  const pos = new Map();
  let maxRows = 0;
  columns.forEach((col, c) => {
    maxRows = Math.max(maxRows, col.length);
    col.forEach((step, r) => {
      pos.set(step.id, {
        x: WF_PAD + c * (WF_NODE_W + WF_COL_GAP),
        y: WF_PAD + r * (WF_NODE_H + WF_ROW_GAP),
      });
    });
  });
  return {
    pos,
    width: WF_PAD * 2 + columns.length * WF_NODE_W + Math.max(0, columns.length - 1) * WF_COL_GAP,
    height: WF_PAD * 2 + maxRows * WF_NODE_H + Math.max(0, maxRows - 1) * WF_ROW_GAP,
  };
}

function wfClosePopover() {
  WF_STATE.selectedId = null;
  document.getElementById("wfPopover")?.remove();
  document.querySelectorAll(".wf-node.selected").forEach((n) => n.classList.remove("selected"));
}

// 明细浮窗：草稿状态下可编辑，运行中只读。贴着被点的节点出现，不遮住它
function wfOpenPopover(ctx, stepId) {
  const { group, draft, server, running, showResults, agents, steps } = ctx;
  document.getElementById("wfPopover")?.remove();
  const esc = app.escapeHtml;
  const index = steps.findIndex((s) => s.id === stepId);
  const step = steps[index];
  const nodeEl = document.querySelector(`.wf-node[data-wf-node="${CSS.escape(stepId)}"]`);
  if (!step || !nodeEl) return;
  WF_STATE.selectedId = stepId;
  document.querySelectorAll(".wf-node.selected").forEach((n) => n.classList.remove("selected"));
  nodeEl.classList.add("selected");

  const live = server.steps.find((s) => s.id === stepId);
  // 可选的分区：已保存的加上草稿里刚写的
  const sectionKeys = [
    ...new Set([
      ...wfServerContext(group.groupId).sections.filter((s) => s.kind === "section").map((s) => s.key),
      ...wfContextDraft(group.groupId).sections.map((s) => s.key.trim().toLowerCase()).filter(Boolean),
    ]),
  ];
  const status = running || showResults ? live?.status || "draft" : "draft";
  const readonly = running;
  const others = steps.filter((s) => s.id !== stepId);

  const pop = document.createElement("div");
  pop.id = "wfPopover";
  pop.className = "wf-popover";
  pop.innerHTML = `
    <div class="wf-pop-head">
      ${
        readonly
          ? `<strong>${esc(step.name)}</strong>`
          : `<input class="text-input wf-name" data-wf-field="name" value="${esc(step.name)}" placeholder="${th("stepName")}" />`
      }
      <button type="button" class="mini-icon-btn" id="wfPopClose" title="${th("close")}">×</button>
    </div>
    <div class="wf-pop-row">
      <label>${th("assignTo")}</label>
      ${
        readonly
          ? app.agentTagHtml
            ? app.agentTagHtml(step.agent)
            : esc(step.agent)
          : `<select class="perm-select" data-wf-field="agent">${agents
              .map((a) => `<option value="${esc(a.agent)}" ${a.agent === step.agent ? "selected" : ""}>${esc(a.label || a.agent)}</option>`)
              .join("")}</select>`
      }
      ${running || showResults ? `<span class="wf-step-status">${esc(t(WF_STEP_STATUS_TEXT[status] || status))}</span>` : ""}
    </div>
    ${
      others.length > 0
        ? `<div class="wf-pop-block">
            <label>${readonly ? t("startAfterTheseStepsFinish") : t("runAfterTheseStepsSelect")}</label>
            <div class="wf-deps">${
              readonly
                ? step.dependsOn.length > 0
                  ? step.dependsOn.map((d) => `<span class="origin-tag">${esc(steps.find((s) => s.id === d)?.name || d)}</span>`).join("")
                  : '<span class="ctx-faint">' + th("noDependenciesStartsWhenPublished") + '</span>'
                : others
                    .map(
                      (s) =>
                        `<button type="button" class="filter-pill${step.dependsOn.includes(s.id) ? " active" : ""}" data-wf-dep-id="${esc(s.id)}">${esc(s.name || s.id)}</button>`,
                    )
                    .join("")
            }</div>
          </div>`
        : ""
    }
    ${
      sectionKeys.length > 0
        ? `<div class="wf-pop-block">
            <label>${readonly ? t("contextSections") : t("includeTheseSectionsSharedContextIsAlways")}</label>
            <div class="wf-deps">${
              readonly
                ? (step.contextRefs || []).length > 0
                  ? step.contextRefs.map((k) => `<span class="origin-tag">${esc(k)}</span>`).join("")
                  : '<span class="ctx-faint">' + th("sharedContextOnly") + '</span>'
                : sectionKeys
                    .map(
                      (k) =>
                        `<button type="button" class="filter-pill${(step.contextRefs || []).includes(k) ? " active" : ""}" data-wf-ctx-key="${esc(k)}">${esc(k)}</button>`,
                    )
                    .join("")
            }</div>
          </div>`
        : ""
    }
    <div class="wf-pop-block">
      <label>${th("instructions")}</label>
      ${
        readonly
          ? `<div class="wf-prompt-readonly">${esc(step.prompt)}</div>`
          : `<textarea class="rule-editor-textarea wf-prompt" data-wf-field="prompt" placeholder="${th("writeSelfContainedInstructionsForThisSubsession")}">${esc(step.prompt)}</textarea>`
      }
    </div>
    ${
      readonly
        ? ""
        : `<label class="wf-check"><input type="checkbox" data-wf-field="isolateWorktree" ${step.isolateWorktree ? "checked" : ""} />${th("makeChangesInAnIsolatedGitWorktree")}</label>`
    }
    ${(() => {
      // 验收关卡：做完后交给另一个 Agent 验收，不通过自动打回重做
      const review = readonly ? live?.review || step.review : step.review;
      if (readonly) {
        if (!review) return "";
        const round = live?.round ? t("round", live.round, live.phase === "review" ? t("inReview") : live.phase === "work" && live.round > 1 ? t("reworking") : "") : "";
        return `<div class="wf-pop-block"><label>${th("review")}</label><div class="wf-deps"><span class="origin-tag">${th("reviewerUpToRounds", review.agent, review.maxRounds, round)}</span></div>${
          live?.reviewNotes ? `<details class="wf-review-notes"><summary>${th("reviewFeedback")}</summary><pre>${esc(live.reviewNotes)}</pre></details>` : ""
        }</div>`;
      }
      return `<div class="wf-pop-block">
        <label>${th("acceptanceReview")}</label>
        <div class="wf-pop-head">
          <select class="perm-select" data-wf-review="agent">
            <option value="">${th("noReview")}</option>
            ${agents.map((a) => `<option value="${esc(a.agent)}" ${review?.agent === a.agent ? "selected" : ""}>${th("reviewer", a.label || a.agent)}</option>`).join("")}
          </select>
          ${
            review
              ? `<select class="perm-select" data-wf-review="maxRounds" title="${th("aFailedReviewSendsTheStepBack")}">${[1, 2, 3, 4, 5]
                  .map((n) => `<option value="${n}" ${(review.maxRounds || 2) === n ? "selected" : ""}>${th("upToRounds", n)}</option>`)
                  .join("")}</select>`
              : ""
          }
        </div>
        ${review ? `<textarea class="rule-editor-textarea" data-wf-review="criteria" rows="2" placeholder="${th("acceptanceCriteriaOptionalDefaultsToTheStep")}">${esc(review.criteria || "")}</textarea>` : ""}
      </div>`;
    })()}
    ${live?.error && (running || showResults) ? `<div class="wf-error">${esc(workflowErrorText(live))}</div>` : ""}
    ${(() => {
      if (!(running || showResults) || !live?.sessionKey) return "";
      const outText = wfGetStepOutputPreview(group.groupId, step.id, live.sessionKey);
      if (!outText) return "";
      const clipped = outText.length > 1600 ? t("nOpenTheSessionForTheFull", outText.slice(0, 1600)) : outText;
      return `<details class="wf-pop-result"><summary>${th("stepOutputPreviewCharacters", outText.length)}</summary><pre class="wf-pop-result-pre">${esc(clipped)}</pre></details>`;
    })()}
    <div class="wf-pop-foot">
      ${readonly ? "<span></span>" : '<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" id="wfPopRemove">' + th("deleteThisStep") + '</button>'}
      ${live?.sessionKey && (running || showResults) ? '<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfPopOpen">' + th("openSession") + '</button>' : ""}
    </div>
  `;
  document.body.appendChild(pop);

  // 位置：优先放在节点右侧，放不下就放左侧；上下不超出窗口
  const rect = nodeEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = rect.right + 12;
  if (left + pw > window.innerWidth - 12) left = Math.max(12, rect.left - pw - 12);
  const top = Math.min(Math.max(12, rect.top), Math.max(12, window.innerHeight - ph - 12));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  pop.querySelector("#wfPopClose").onclick = wfClosePopover;
  const rerenderKeepingOpen = () => {
    WF_STATE.lastSignature = "";
    renderWorkflowPanel();
  };
  pop.querySelectorAll("[data-wf-field]").forEach((el) => {
    const apply = () => {
      const target = draft.steps[index];
      if (!target) return;
      target[el.dataset.wfField] = el.type === "checkbox" ? el.checked : el.value;
      wfTouch(draft, false);
    };
    el.oninput = apply;
    el.onchange = () => {
      apply();
      // 名称和 Agent 显示在图上，改完要重画；浮窗保持打开
      if (el.dataset.wfField === "name" || el.dataset.wfField === "agent") {
        wfTouch(draft, true);
        rerenderKeepingOpen();
      }
    };
  });
  pop.querySelectorAll("[data-wf-review]").forEach((el) => {
    el.onchange = () => {
      const target = draft.steps[index];
      if (!target) return;
      const field = el.dataset.wfReview;
      if (field === "agent") {
        target.review = el.value ? { agent: el.value, maxRounds: target.review?.maxRounds || 2, criteria: target.review?.criteria || "" } : null;
      } else if (target.review) {
        target.review[field] = field === "maxRounds" ? Number(el.value) : el.value;
      }
      wfTouch(draft, true);
      if (field === "agent") rerenderKeepingOpen();
    };
  });
  pop.querySelectorAll("[data-wf-ctx-key]").forEach((btn) => {
    btn.onclick = () => {
      const target = draft.steps[index];
      const key = btn.dataset.wfCtxKey;
      const refs = target.contextRefs || [];
      target.contextRefs = refs.includes(key) ? refs.filter((k) => k !== key) : [...refs, key];
      wfTouch(draft, true);
      rerenderKeepingOpen();
    };
  });
  pop.querySelectorAll("[data-wf-dep-id]").forEach((btn) => {
    btn.onclick = () => {
      const target = draft.steps[index];
      const depId = btn.dataset.wfDepId;
      const next = target.dependsOn.includes(depId)
        ? target.dependsOn.filter((d) => d !== depId)
        : [...target.dependsOn, depId];
      // 不允许连成环：如果对方已经（间接）依赖这一步，就不能再反过来依赖它
      const reaches = (from, to, seen = new Set()) => {
        if (from === to) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return (draft.steps.find((s) => s.id === from)?.dependsOn || []).some((d) => reaches(d, to, seen));
      };
      if (next.includes(depId) && reaches(depId, target.id)) {
        void app.showConfirmModal({
          title: t("dependencyWouldCreateACycle"),
          message: t("alreadyDependsOnThisStepMakingThis", steps.find((s) => s.id === depId)?.name || depId),
          confirmText: t("ok"),
        });
        return;
      }
      target.dependsOn = next;
      wfTouch(draft, true);
      rerenderKeepingOpen();
    };
  });
  const removeBtn = pop.querySelector("#wfPopRemove");
  if (removeBtn) {
    removeBtn.onclick = () => {
      const [removed] = draft.steps.splice(index, 1);
      if (removed) {
        for (const s of draft.steps) s.dependsOn = s.dependsOn.filter((d) => d !== removed.id);
      }
      wfTouch(draft, true);
      wfClosePopover();
      rerenderKeepingOpen();
    };
  }
  const openBtn = pop.querySelector("#wfPopOpen");
  if (openBtn) {
    openBtn.onclick = () => {
      wfClosePopover();
      app.setStageView("chat");
      app.selectGroup(group.groupId, `sub:${live.sessionKey}`);
    };
  }
}

function renderWorkflowPanel() {
  if (!app) return;
  const container = app.els.workflowView;
  if (!container) return;
  const esc = app.escapeHtml;
  const group = app.STATE.taskGroups.get(app.STATE.activeGroupId);
  if (!group) return;
  const groupId = group.groupId;
  const server = wfServerWorkflow(groupId);
  const running = server.status === "running";
  // 中途停下的工作流（某步失败、手动停止、后端重启）可以保留已完成的步骤接着跑
  const serverSteps = server.steps || [];
  const unfinishedCount = serverSteps.filter((s) => s.status !== "completed").length;
  const canResume = server.status === "failed" && unfinishedCount > 0 && unfinishedCount < serverSteps.length;
  const draft = wfDraft(groupId);
  const agents = app.getEnabledAgents();

  // 浮窗里打字不触发重绘；只有结构或状态变了才重建
  const signature = [
    groupId,
    getLocale(),
    displayTaskTitle(group),
    group.leadAgent,
    server.updatedAt,
    server.status,
    server.steps.map((s) => `${s.id}:${s.status}`).join(","),
    draft.version,
    agents.map((a) => a.agent).join(","),
    wfServerContext(groupId).sections.map((s) => `${s.key}:${s.updatedAt}`).join(","),
    wfContextDraft(groupId).version,
    WF_STATE.ctxOpen,
  ].join("|");
  if (signature === WF_STATE.lastSignature && container.childElementCount > 0) return;
  // 流程图：按当前缩放比例和步骤依赖重算节点与连线
  WF_STATE.lastSignature = signature;

  const steps = running ? server.steps : draft.steps;
  const serverById = new Map(server.steps.map((s) => [s.id, s]));
  const showResults = !running && !draft.dirty && (server.status === "completed" || server.status === "failed");
  const statusOf = (step) => (running || showResults ? serverById.get(step.id)?.status || "draft" : "draft");
  const hasRetryableSteps =
    !running &&
    server.steps.some((s) => s.status === "failed" || s.status === "cancelled" || s.status === "skipped");

  const doneCount = server.steps.filter((s) => s.status === "completed").length;
  const statusLine = running
    ? t("runningSteps", doneCount, server.steps.length)
    : showResults
      ? server.status === "completed"
        ? t("allStepsCompletedInTheLastRun")
        : t("someStepsDidNotCompleteInThe")
      : steps.length === 0
        ? ""
        : draft.dirty
          ? t("unsavedChanges")
          : server.proposedBy && server.proposedBy !== "user"
            ? t("draftedByReviewAndPublishToRun", server.proposedBy)
            : t("draft");

  // 共享上下文：公共部分写一次，每一步都会带上；命名分区只给引用它的步骤
  const ctxDraft = wfContextDraft(groupId);
  const ctxResults = wfServerContext(groupId).sections.filter((sec) => sec.kind === "result");
  const refCount = (key) => steps.filter((st) => (st.contextRefs || []).includes(key)).length;
  const ctxSummary = [
    ctxDraft.common.trim() ? t("sharedContextCharacters", ctxDraft.common.trim().length) : t("noCommonContext"),
    ctxDraft.sections.length > 0 ? t("sections", ctxDraft.sections.length) : "",
    ctxResults.length > 0 ? t("stepResults", ctxResults.length) : "",
    ctxDraft.dirty ? t("unsaved") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const ctxHtml = `
    <details class="wf-context" id="wfContextBox" ${WF_STATE.ctxOpen ? "open" : ""}>
      <summary><span>${th("sharedContext")}</span><span class="ctx-faint">${esc(ctxSummary)}</span></summary>
      <div class="wf-context-body">
        <div class="wf-pop-block">
          <label>${th("commonContext")}<span class="dirs-hint">${th("everySubsessionReceivesThisAddItHere")}</span></label>
          <textarea class="rule-editor-textarea" id="wfCtxCommon" ${running ? "readonly" : ""} placeholder="${th("goalsVersionsConventionsConstraintsAndReferenceLocations")}">${esc(ctxDraft.common)}</textarea>
        </div>
        ${ctxDraft.sections
          .map(
            (sec, i) => `
          <div class="wf-ctx-section">
            <div class="wf-ctx-section-head">
              <input class="text-input" data-ctx-field="key" data-ctx-index="${i}" value="${esc(sec.key)}" placeholder="${th("sectionKeyEGUserMgmt")}" ${sec.saved || running ? "readonly" : ""} />
              <input class="text-input" data-ctx-field="summary" data-ctx-index="${i}" value="${esc(sec.summary)}" placeholder="${th("shortDescriptionOfThisSection")}" ${running ? "readonly" : ""} />
              <span class="ctx-faint">${th("referencedBySteps", refCount(sec.key.trim().toLowerCase()))}</span>
              ${running ? "" : `<button type="button" class="mini-icon-btn" data-ctx-remove="${i}" title="${th("deleteThisSection")}">×</button>`}
            </div>
            <textarea class="rule-editor-textarea" data-ctx-field="content" data-ctx-index="${i}" ${running ? "readonly" : ""} placeholder="${th("contentNeededByOnlySomeSteps")}">${esc(sec.content)}</textarea>
          </div>`,
          )
          .join("")}
        ${
          ctxResults.length > 0
            ? `<div class="wf-deps"><span class="wf-deps-label">${th("stepResultsSavedAutomaticallyAndSharedWith")}</span>${ctxResults
                .map((sec) => `<span class="origin-tag" title="${esc(sec.content.slice(0, 400))}">${esc(sec.summary || sec.key)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${
          running
            ? ""
            : `<div class="panel-toolbar">
                 <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfCtxAddBtn">${th("addSection")}</button>
                 <button type="button" class="alma-btn alma-btn-sm" id="wfCtxSaveBtn" ${ctxDraft.dirty ? "" : "disabled"}>${th("saveContext")}</button>
               </div>`
        }
      </div>
    </details>`;

  const layout = wfLayout(steps);
  const edges = [];
  for (const step of steps) {
    const to = layout.pos.get(step.id);
    const toStatus = statusOf(step);
    for (const dep of step.dependsOn) {
      const from = layout.pos.get(dep);
      if (!from || !to) continue;
      const x1 = from.x + WF_NODE_W;
      const y1 = from.y + WF_NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + WF_NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const depStatus = statusOf(steps.find((s) => s.id === dep));
      const isDone = depStatus === "completed";
      const isActive = isDone && toStatus === "running";
      const edgeCls = isActive ? "wf-edge active" : isDone ? "wf-edge done" : "wf-edge";
      edges.push(
        `<path class="${edgeCls}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" marker-end="url(#wfArrow)" />`,
      );
    }
  }
  const nodes = steps
    .map((step, index) => {
      const p = layout.pos.get(step.id);
      const status = statusOf(step);
      return `
        <button type="button" class="wf-node status-${esc(status)}" data-wf-node="${esc(step.id)}"
          style="left:${p.x}px;top:${p.y}px;width:${WF_NODE_W}px;height:${WF_NODE_H}px" title="${esc(step.name)}">
          <span class="wf-node-top">
            <span class="dot ${status === "running" ? "busy" : status === "completed" ? "completed" : status === "failed" ? "failed" : "idle"}"></span>
            <span class="wf-node-name">${esc(step.name || t("stepNumber", index + 1))}</span>
          </span>
          <span class="wf-node-bottom">
            ${app.agentTagHtml ? app.agentTagHtml(step.agent) : esc(step.agent)}
            <span class="wf-node-status">${running || showResults ? esc(wfStepStatusText(steps.find((s) => s.id === step.id) && server.steps.find((s) => s.id === step.id), status)) : step.prompt.trim() ? (step.review ? t("reviewRequired") : step.isolateWorktree ? "worktree" : "") : t("missingInstructions")}</span>
          </span>
        </button>`;
    })
    .join("");

  const zoom = Math.min(1.6, Math.max(0.6, Number(WF_STATE.zoom) || 1));
  const zoomPct = Math.round(zoom * 100);
  const scaledW = Math.round(layout.width * zoom);
  const scaledH = Math.round(layout.height * zoom);
  const scrollPrev = container.querySelector(".wf-canvas-wrap");
  const prevScroll = scrollPrev ? { left: scrollPrev.scrollLeft, top: scrollPrev.scrollTop } : null;

  container.innerHTML = `
    <div class="panel-sec-head">
      <div class="panel-sec-title">${th("workflowFor", displayTaskTitle(group))}</div>
      <div class="panel-sec-sub">${esc(statusLine)}</div>
    </div>
    <div class="panel-toolbar">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${
          running
            ? ""
            : `<select class="perm-select" id="wfTemplateSelect" title="${th("loadASavedWorkflowAsADraft")}">
                 <option value="">${th("templates")}</option>
                 ${(WF_STATE.templates || []).map((t) => `<option value="load:${esc(t.name)}">${th("loadSteps", t.name, t.stepCount)}</option>`).join("")}
                 ${steps.length > 0 ? '<option value="save">' + th("saveCurrentWorkflowAsATemplate") + '</option>' : ""}
                 ${(WF_STATE.templates || []).map((t) => `<option value="delete:${esc(t.name)}">${th("delete2", t.name)}</option>`).join("")}
               </select>
               <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAddStepBtn">${th("addStep")}</button>
               <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAskLeadBtn" title="${th("askTheLeadToBreakDownThe")}">${th("askToDraft", group.leadAgent)}</button>`
        }
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${
          running
            ? `<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" id="wfCancelBtn">${th("stop")}</button>`
            : `<button type="button" class="alma-btn alma-btn-sm" id="wfSaveBtn" ${steps.length === 0 ? "disabled" : ""}>${th("saveDraft")}</button>
               ${
                 canResume
                   ? `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfRunBtn" title="${th("runAllStepsFromScratchAndDiscard")}">${th("rerunAll")}</button>
                      <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfResumeBtn" title="${th("keepCompletedStepsAndResultsAndRun")}">${th("resumeRemainingSteps", unfinishedCount)}</button>`
                   : `${hasRetryableSteps ? '<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfRetryBtn" title="' + th("keepCompletedResultsAndRerunFailedOr") + '">' + th("retryUnfinishedSteps") + '</button>' : ""}
                      <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfRunBtn" ${steps.length === 0 ? "disabled" : ""}>${th("publish")}</button>`
               }`
        }
      </div>
    </div>
    ${ctxHtml}
    ${
      steps.length === 0
        ? `<div class="empty-note">${th("noStepsYetAddTasksForSubsessions", group.leadAgent)}
            <div class="wf-templates">
              <button type="button" class="wf-tpl-card" data-wf-tpl="impl-review">
                <span class="wf-tpl-title">${th("implementReview")}</span>
                <span class="wf-tpl-desc">${th("oneAgentImplementsAndRunsBasicChecks")}</span>
              </button>
              <button type="button" class="wf-tpl-card" data-wf-tpl="parallel-research">
                <span class="wf-tpl-title">${th("parallelResearchSummary")}</span>
                <span class="wf-tpl-desc">${th("twoAgentsInvestigateTheCurrentCodeAnd")}</span>
              </button>
              <button type="button" class="wf-tpl-card" data-wf-tpl="worktree-verify">
                <span class="wf-tpl-title">${th("isolatedChangesVerification")}</span>
                <span class="wf-tpl-desc">${th("makeChangesInAnIsolatedGitWorktree2")}</span>
              </button>
            </div>
          </div>`
        : `<div class="wf-canvas-shell">
             <div class="wf-zoom-bar">
               <button type="button" class="wf-zoom-btn" data-wf-zoom="out" title="${th("zoomOut")}">-</button>
               <span class="wf-zoom-label" id="wfZoomLabel">${zoomPct}%</span>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="in" title="${th("zoomIn")}">+</button>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="reset" title="${th("resetTo100")}">100%</button>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="fit" title="${th("fitCanvasWidth")}">${th("fit")}</button>
             </div>
             <div class="wf-canvas-wrap">
               <div class="wf-canvas-sizer" style="width:${scaledW}px;height:${scaledH}px">
                 <div class="wf-canvas" style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom})">
                   <svg class="wf-edges" width="${layout.width}" height="${layout.height}">
                     <defs>
                       <marker id="wfArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                         <path d="M0,0 L8,4 L0,8 z" class="wf-arrow" />
                       </marker>
                     </defs>
                     ${edges.join("")}
                   </svg>
                   ${nodes}
                 </div>
               </div>
             </div>
           </div>
           <div class="ctx-faint">${th(running ? "workflowOrder" : "editWorkflowOrder")}</div>`
    }
  `;
  const wrap = container.querySelector(".wf-canvas-wrap");
  if (wrap && prevScroll) {
    wrap.scrollLeft = prevScroll.left;
    wrap.scrollTop = prevScroll.top;
  }

  const ctxBox = document.getElementById("wfContextBox");
  if (ctxBox) {
    ctxBox.ontoggle = () => {
      WF_STATE.ctxOpen = ctxBox.open;
    };
  }
  const markCtxDirty = (structural) => {
    ctxDraft.dirty = true;
    if (structural) {
      ctxDraft.version += 1;
      renderWorkflowPanel();
    } else {
      const saveBtn = document.getElementById("wfCtxSaveBtn");
      if (saveBtn) saveBtn.disabled = false;
    }
  };
  const commonEl = document.getElementById("wfCtxCommon");
  if (commonEl) {
    commonEl.oninput = () => {
      ctxDraft.common = commonEl.value;
      markCtxDirty(false);
    };
  }
  container.querySelectorAll("[data-ctx-field]").forEach((el) => {
    el.oninput = () => {
      const sec = ctxDraft.sections[Number(el.dataset.ctxIndex)];
      if (!sec) return;
      sec[el.dataset.ctxField] = el.value;
      markCtxDirty(false);
    };
  });
  container.querySelectorAll("[data-ctx-remove]").forEach((btn) => {
    btn.onclick = () => {
      const [removed] = ctxDraft.sections.splice(Number(btn.dataset.ctxRemove), 1);
      // 分区没了，引用它的步骤也不再引用
      if (removed) {
        const key = removed.key.trim().toLowerCase();
        for (const st of draft.steps) {
          if ((st.contextRefs || []).includes(key)) {
            st.contextRefs = st.contextRefs.filter((k) => k !== key);
            wfTouch(draft, false);
          }
        }
      }
      markCtxDirty(true);
    };
  });
  const ctxAddBtn = document.getElementById("wfCtxAddBtn");
  if (ctxAddBtn) {
    ctxAddBtn.onclick = () => {
      ctxDraft.sections.push({ key: "", summary: "", content: "", saved: false });
      WF_STATE.ctxOpen = true;
      markCtxDirty(true);
    };
  }
  const ctxSaveBtn = document.getElementById("wfCtxSaveBtn");
  if (ctxSaveBtn) {
    ctxSaveBtn.onclick = async () => {
      try {
        await wfSaveContext(groupId);
      } catch (err) {
        await app.showConfirmModal({ title: t("couldNotSaveContext"), message: err.message, confirmText: t("ok") });
      }
      WF_STATE.lastSignature = "";
      renderWorkflowPanel();
    };
  }

  const ctx = { group, draft, server, running, showResults, agents, steps };
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind("wfAddStepBtn", () => {
    const used = new Set(draft.steps.map((s) => s.id));
    let n = draft.steps.length + 1;
    while (used.has(`step${n}`)) n += 1;
    // 选中了某一步时，新步骤默认接在它后面
    const after = WF_STATE.selectedId && used.has(WF_STATE.selectedId) ? [WF_STATE.selectedId] : [];
    draft.steps.push({
      id: `step${n}`,
      name: t("stepNumber", n),
      agent: agents.find((a) => a.agent !== group.leadAgent)?.agent || agents[0]?.agent || group.leadAgent,
      prompt: "",
      dependsOn: after,
      isolateWorktree: false,
      contextRefs: [],
    });
    wfTouch(draft, true);
    WF_STATE.selectedId = `step${n}`;
    WF_STATE.lastSignature = "";
    renderWorkflowPanel();
  });
  bind("wfAskLeadBtn", () => void wfAskLeadToDraft(group));
  bind("wfSaveBtn", () => void wfRunAction(groupId, "save"));
  bind("wfRunBtn", () => {
    wfClosePopover();
    void wfRunAction(groupId, "run");
  });
  bind("wfRetryBtn", () => {
    wfClosePopover();
    void wfRunAction(groupId, "retry");
  });
  const tplSelect = document.getElementById("wfTemplateSelect");
  if (tplSelect) {
    if (!WF_STATE.templatesLoaded) {
      WF_STATE.templatesLoaded = true;
      void wfLoadTemplates().then(() => {
        WF_STATE.lastSignature = "";
        renderWorkflowPanel();
      });
    }
    tplSelect.onchange = () => {
      const value = tplSelect.value;
      tplSelect.value = "";
      if (value) void wfTemplateAction(groupId, value);
    };
  }
  bind("wfResumeBtn", () => {
    wfClosePopover();
    void wfRunAction(groupId, "resume");
  });
  bind("wfCancelBtn", () => void wfRunAction(groupId, "cancel"));

  container.querySelectorAll("[data-wf-tpl]").forEach((btn) => {
    btn.onclick = () => {
      draft.steps = buildWorkflowTemplateSteps(btn.dataset.wfTpl, agents, group.leadAgent);
      wfTouch(draft, true);
      WF_STATE.selectedId = draft.steps[0]?.id || null;
      WF_STATE.lastSignature = "";
      renderWorkflowPanel();
    };
  });

  container.querySelectorAll("[data-wf-zoom]").forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.wfZoom;
      const cur = Number(WF_STATE.zoom) || 1;
      if (mode === "in") {
        WF_STATE.zoom = Math.min(1.6, Number((cur + 0.15).toFixed(2)));
      } else if (mode === "out") {
        WF_STATE.zoom = Math.max(0.6, Number((cur - 0.15).toFixed(2)));
      } else if (mode === "fit" && wrap) {
        const avail = Math.max(240, wrap.clientWidth - 16);
        WF_STATE.zoom = Math.min(1, Math.max(0.6, Number((avail / Math.max(1, layout.width)).toFixed(2))));
      } else {
        WF_STATE.zoom = 1;
      }
      WF_STATE.lastSignature = "";
      renderWorkflowPanel();
    };
  });

  container.querySelectorAll("[data-wf-node]").forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      if (WF_STATE.selectedId === node.dataset.wfNode && document.getElementById("wfPopover")) {
        wfClosePopover();
      } else {
        wfOpenPopover(ctx, node.dataset.wfNode);
      }
    };
  });
  if (wrap) wrap.onscroll = () => document.getElementById("wfPopover") && wfClosePopover();

  // 重绘后把之前打开的浮窗接回去
  if (WF_STATE.selectedId && steps.some((s) => s.id === WF_STATE.selectedId)) {
    wfOpenPopover(ctx, WF_STATE.selectedId);
  } else {
    wfClosePopover();
  }
}

// 点浮窗和节点以外的地方、按 Esc、离开工作流视图时关掉浮窗
document.addEventListener("mousedown", (e) => {
  const pop = document.getElementById("wfPopover");
  if (!pop) return;
  if (pop.contains(e.target) || e.target.closest?.(".wf-node") || e.target.closest?.(".alma-modal-backdrop")) return;
  wfClosePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("wfPopover")) wfClosePopover();
});

if (app) {
  app.onStateChange = () => {
    const activeGroup = app.STATE.taskGroups.get(app.STATE.activeGroupId);
    const activeGroupId = activeGroup?.groupId || "";
    const activeCwd = activeGroup?.cwd || "";
    const scopeChanged =
      PANEL_STATE.resourcesGroupId !== activeGroupId || PANEL_STATE.resourcesCwd !== activeCwd;

    if (scopeChanged) {
      void fetchResources();
    } else if (app.STATE.stageView === "resources") {
      if (app.STATE.resourcesList.length === 0) {
        void fetchResources();
      } else {
        renderResourcesPanel();
      }
    }
    if (app.STATE.stageView === "telemetry") {
      renderTelemetryPanel();
    } else if (app.STATE.stageView === "workflow") {
      renderWorkflowPanel();
    }
    if (app.STATE.stageView !== "workflow") wfClosePopover();
  };
  app.onResourcesUpdated = () => {
    void fetchResources();
  };
  void fetchResources();
}

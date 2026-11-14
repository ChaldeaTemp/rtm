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
    const res = await fetch(`/api/resources${buildResourceQuery()}`);
    const data = await res.json();
    if (data.ok) {
      app.STATE.resourcesList = data.resources || [];
      app.STATE.resourceBudgets = data.budgets || [];
      app.refreshHeaderMetrics();
      if (app.isResourcesViewOpen?.()) {
        renderResourcesPanel();
      }
    }
  } catch (err) {
    app.appendLog(`加载共享资源失败: ${err.message}`);
  } finally {
    PANEL_STATE.loadingResources = false;
  }
}

async function toggleResource(id, enabled, agent) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await fetch("/api/resources/toggle", {
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
    app.appendLog(`切换资源状态失败: ${err.message}`);
  }
}

async function saveCustomRule(name, scope, content) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await fetch("/api/resources/rules", {
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
      app.appendLog(`已保存共享规则: ${name} (${scope})`);
      renderResourcesPanel();
    } else {
      app.appendLog(`保存规则失败: ${data.error || "unknown"}`);
    }
  } catch (err) {
    app.appendLog(`保存规则异常: ${err.message}`);
  }
}

async function deleteCustomRule(id) {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await fetch("/api/resources/rules/delete", {
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
    app.appendLog(`删除规则失败: ${err.message}`);
  }
}

async function syncProjectRuleFiles() {
  try {
    const { groupId, cwd } = getResourceScope();
    const res = await fetch("/api/resources/sync-project", {
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
      PANEL_STATE.syncNotice = `已写入项目规则块: ${names}`;
      app.appendLog(PANEL_STATE.syncNotice);
      await fetchResources();
    }
  } catch (err) {
    app.appendLog(`同步项目规则文件失败: ${err.message}`);
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
      const res = await fetch(`/api/resources/content${buildResourceQuery({ id })}`);
      const data = await res.json();
      if (data.ok) {
        PANEL_STATE.previewCache.set(cacheKey, data.content || "");
      }
    } catch {
      PANEL_STATE.previewCache.set(cacheKey, "(读取内容失败)");
    }
  }
  renderResourcesPanel();
}

function renderResourcesPanel() {
  const container = app.els.resourcesView;
  if (!container) return;

  const esc = app.escapeHtml;
  const fmtTok = app.formatTokens;
  const items = app.STATE.resourcesList || [];
  const budgets = app.STATE.resourceBudgets || [];

  const enabledRules = items.filter((i) => i.enabled && i.kind === "rule").length;
  const enabledSkills = items.filter((i) => i.enabled && i.kind === "skill").length;
  const projRuleCount = items.filter((i) => i.kind === "rule" && i.scope === "project").length;
  const globRuleCount = items.filter((i) => i.kind === "rule" && i.scope === "global").length;
  const skillCount = items.filter((i) => i.kind === "skill").length;
  const skillIndexTokTotal = items
    .filter((i) => i.kind === "skill")
    .reduce((s, i) => s + i.indexTokens, 0);

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

  const { cwd: previewCwd } = getResourceScope();
  const scopeLabel = previewCwd
    ? previewCwd.split(/[\\/]/).filter(Boolean).pop() || previewCwd
    : "全局默认";

  const budgetChips = budgets
    .map((b) => {
      const tagHtml = app.agentTagHtml
        ? app.agentTagHtml(b.agent)
        : `<span class="agent-tag" data-agent="${esc(b.agent)}">${esc(b.agent)}</span>`;
      const warnHtml = b.droppedRules?.length
        ? `<span class="res-budget-warn" title="${esc(b.droppedRules.join("、"))}">超预算 ${b.droppedRules.length} 条</span>`
        : "";
      return `
        <div class="res-budget-chip">
          <div class="res-budget-chip-top">
            ${tagHtml}
            <span class="res-budget-tok">~${fmtTok(b.firstTurnInjectionTokens)} tok</span>
          </div>
          <div class="res-budget-chip-meta">
            <span>原生 ${b.nativeRules + b.nativeSkills} · 注入 ${b.bridgedRules + b.bridgedSkills}</span>
            ${warnHtml}
          </div>
        </div>`;
    })
    .join("");

  const enabledAgentIds = (app.getEnabledAgents?.() || []).map((a) => a.agent);
  const covAgents = enabledAgentIds.length > 0 ? enabledAgentIds : ["claude", "codex", "agy", "opencode", "kimi"];

  const ruleFormHtml = PANEL_STATE.showRuleForm
    ? `
      <form id="hubRuleForm" class="rule-editor-box">
        <div class="rule-editor-row">
          <input id="hubRuleName" class="text-input" type="text" placeholder="规则名称（如 project-conventions）" required />
          <select id="hubRuleScope" class="perm-select">
            <option value="project">作用域：当前项目 (.rtm)</option>
            <option value="global">作用域：全局 (~/.rtm)</option>
          </select>
        </div>
        <textarea id="hubRuleContent" class="rule-editor-textarea" placeholder="# 规则标题&#10;&#10;在这里编写跨 ${esc(covAgents.join(" / "))} 共享的 Markdown 规则..."></textarea>
        <div class="panel-toolbar">
          <span class="mono" style="font-size:11px;color:var(--faint)">仅写入 .rtm 目录，不修改原生全局配置</span>
          <div style="display:flex;gap:8px">
            <button id="cancelRuleFormBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button">取消</button>
            <button class="alma-btn alma-btn-primary alma-btn-sm" type="submit">保存共享规则</button>
          </div>
        </div>
      </form>`
    : "";

  const rowsHtml =
    filtered.length === 0
      ? `<div class="empty-note">当前筛选条件下没有匹配的规则或技能。</div>`
      : filtered
          .map((item) => {
            const isExpanded = PANEL_STATE.expandedId === item.id;
            const previewText = isExpanded
              ? PANEL_STATE.previewCache.get(`${previewCwd}::${item.id}`) || "加载中..."
              : "";
            const canDelete = item.origin === "hub-project" || item.origin === "hub-global";
            const covHtml = covAgents
              .map((ag) => {
                if (!item.enabled) {
                  return `<span class="cov-pill off">${ag}: 停用</span>`;
                }
                // 点一下只对这一个 Agent 停用或恢复，其他 Agent 不受影响
                const offForAgent = (item.disabledAgents || []).includes(ag);
                const isNative = item.nativeAgents.includes(ag);
                const cls = offForAgent ? "off" : isNative ? "native" : "bridged";
                const text = offForAgent ? "停用" : isNative ? "原生" : "注入";
                const tip = offForAgent ? `点击恢复对 ${ag} 生效` : `点击只对 ${ag} 停用`;
                return `<button type="button" class="cov-pill ${cls}" data-toggle-res-agent="${esc(item.id)}" data-agent="${esc(ag)}" data-next-enabled="${offForAgent}" title="${tip}">${ag}: ${text}</button>`;
              })
              .join("");

            const tokText =
              item.kind === "skill"
                ? `索引 ~${item.indexTokens} / 全文 ~${fmtTok(item.fullTokens)} tok`
                : `~${fmtTok(item.fullTokens)} tok`;
            const dedupHint = item.sources.length > 1 ? ` (+${item.sources.length - 1} 个去重来源)` : "";

            return `
              <div class="resource-row ${item.enabled ? "" : "disabled"}">
                <div class="res-row-head">
                  <div class="res-row-badges">
                    <span class="kind-tag ${esc(item.kind)}">${item.kind === "rule" ? "规则" : "技能"}</span>
                    <span class="resource-name">${esc(item.name)}</span>
                    <span class="scope-tag">${item.scope === "project" ? "项目" : "全局"}</span>
                    <span class="origin-tag">${esc(item.origin)}</span>
                    <span class="origin-tag">${tokText}</span>
                  </div>
                  <div class="resource-actions">
                    <button class="alma-btn alma-btn-outline alma-btn-sm" data-preview-res="${esc(item.id)}" type="button">${isExpanded ? "收起" : "预览"}</button>
                    <button class="alma-btn alma-btn-sm ${item.enabled ? "" : "alma-btn-primary"}" data-toggle-res="${esc(item.id)}" data-next-enabled="${!item.enabled}" type="button">${item.enabled ? "停用" : "启用"}</button>
                    ${canDelete ? `<button class="alma-btn alma-btn-danger alma-btn-sm" data-del-res="${esc(item.id)}" type="button">删除</button>` : ""}
                  </div>
                </div>
                <div class="res-row-body">
                  <div class="resource-desc">${esc(item.description)}</div>
                  <div class="resource-path" title="${esc(item.primaryPath + dedupHint)}">${esc(item.primaryPath)}${dedupHint}</div>
                </div>
                <div class="res-row-foot">
                  <span class="res-cov-label">按 Agent 生效</span>
                  <div class="coverage-pills">${covHtml}</div>
                </div>
                ${isExpanded ? `<pre class="resource-preview-box">${esc(previewText)}</pre>` : ""}
              </div>`;
          })
          .join("");

  container.innerHTML = `
    <div class="res-overview">
      <div class="res-overview-top">
        <div class="res-overview-stats">
          <span class="res-scope-pill" title="${esc(previewCwd || "全局")}">作用域：${esc(scopeLabel)}</span>
          <strong>已启用 ${enabledRules} 规则 · ${enabledSkills} 技能</strong>
          <span class="res-overview-faint">共发现 ${items.length} 项 · 技能索引合计 ~${fmtTok(skillIndexTokTotal)} tok</span>
        </div>
        <div class="res-overview-hint">规则按需注入缺失端；技能仅注渐进索引</div>
      </div>
      ${budgetChips ? `<div class="res-budget-strip">${budgetChips}</div>` : ""}
    </div>

    <div class="res-toolbar-stack">
      <div class="res-toolbar-row">
        <div class="filter-pills">
          <button class="filter-pill ${PANEL_STATE.filter === "all" ? "active" : ""}" data-res-filter="all" type="button">全部 (${items.length})</button>
          <button class="filter-pill ${PANEL_STATE.filter === "project-rule" ? "active" : ""}" data-res-filter="project-rule" type="button">项目规则 (${projRuleCount})</button>
          <button class="filter-pill ${PANEL_STATE.filter === "global-rule" ? "active" : ""}" data-res-filter="global-rule" type="button">全局规则 (${globRuleCount})</button>
          <button class="filter-pill ${PANEL_STATE.filter === "skill" ? "active" : ""}" data-res-filter="skill" type="button">共享技能 (${skillCount})</button>
        </div>
        <div class="res-toolbar-actions">
          <button id="toggleNewRuleBtn" class="alma-btn alma-btn-primary alma-btn-sm" type="button">+ 新建规则</button>
          <button id="syncProjectFilesBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button" title="显式将 Hub 共享规则块同步至项目根目录 AGENTS.md / CLAUDE.md">同步至项目文件</button>
        </div>
      </div>
      <div class="res-toolbar-row">
        <input id="resSearchInput" class="panel-search res-search-grow" type="search" placeholder="搜索规则/技能名称、描述或路径..." value="${esc(PANEL_STATE.search)}" />
        ${PANEL_STATE.syncNotice ? `<span class="res-sync-notice">${esc(PANEL_STATE.syncNotice)}</span>` : ""}
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
    ruleForm.onsubmit = (e) => {
      e.preventDefault();
      const name = container.querySelector("#hubRuleName").value.trim();
      const scope = container.querySelector("#hubRuleScope").value;
      const content = container.querySelector("#hubRuleContent").value.trim();
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
            <span>${t.turns} 轮${t.modelId ? ` · ${esc(t.modelId)}` : ""}${costText}</span>
          </div>
          <div class="stat-card-value">${fmtTok(t.totalTokens)}</div>
          <div class="stat-card-meta">
            <span>输入 ${fmtTok(t.inputTokens)}</span>
            <span>缓存 ${fmtTok(t.cachedReadTokens)} (${aCachePct}%)</span>
            <span>输出 ${fmtTok(t.outputTokens + t.thoughtTokens)}</span>
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
      notes.push({ level: "warn", text: `窗口已用 ${Math.round((used / winMax) * 100)}%，接近上限，建议新开任务或让 Agent 压缩上下文` });
    }
    if (used > 0 && (rules + skills) / used >= 0.3 && rules + skills >= 2000) {
      notes.push({ level: "info", text: `固定注入的规则和技能索引占 ${Math.round(((rules + skills) / used) * 100)}%，可以在资源页停用用不到的规则` });
    }
    if (used > 0 && other / used >= 0.6) {
      notes.push({ level: "info", text: `${Math.round((other / used) * 100)}% 来自工具结果和 Agent 自带的系统内容，读大文件或长日志时最容易涨` });
    }
    if (handoff >= 8000) {
      notes.push({ level: "info", text: `切换主导时交接了 ${fmtTok(handoff)} tok 的历史` });
    }
    if ((cb.droppedRules || []).length > 0) {
      notes.push({ level: "warn", text: `${cb.droppedRules.length} 条规则超出预算，只给了文件路径` });
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
      ["seg-rules", "规则", a.rules],
      ["seg-skills", "技能索引", a.skills],
      ["seg-handoff", "交接", a.handoff],
      ["seg-dialog", "对话", a.dialog],
      ["seg-other", "工具与其他", a.other],
    ]
      .filter(([, , v]) => v > 0)
      .map(([cls, label, v]) => `<span><i class="legend-dot ${cls}"></i>${label} ${fmtTok(v)}</span>`)
      .join("");
    return `
      <div class="ctx-session${isSub ? " is-sub" : ""}">
        <div class="ctx-session-head">
          <div class="ctx-session-name">
            ${app.agentTagHtml ? app.agentTagHtml(sess.agent) : `<span class="agent-tag" data-agent="${esc(sess.agent)}">${esc(sess.agent)}</span>`}
            <span>${isSub ? esc(sess.label || sess.name) : "主导"}</span>
            ${sess.currentModelId ? `<span class="ctx-faint">${esc(sess.currentModelId.split("/").pop())}</span>` : ""}
          </div>
          <div class="ctx-faint">
            ${a.winMax > 0 ? `窗口 ${fmtTok(a.used)} / ${fmtTok(a.winMax)}（${Math.round((a.used / a.winMax) * 100)}%）` : a.used > 0 ? `约 ${fmtTok(a.used)} tok，适配器没有回报窗口大小` : "还没有数据"}
            ${a.cachePct !== null ? `　缓存命中 ${a.cachePct}%` : ""}
          </div>
        </div>
        <div class="stacked-bar" title="上下文窗口里各部分的占比">
          ${segment("seg-rules", a.rules, a.scale)}${segment("seg-skills", a.skills, a.scale)}${segment("seg-handoff", a.handoff, a.scale)}${segment("seg-dialog", a.dialog, a.scale)}${segment("seg-other", a.other, a.scale)}
        </div>
        ${legend ? `<div class="legend-row">${legend}</div>` : ""}
        ${a.notes.map((n) => `<div class="ctx-note ${n.level}">${esc(n.text)}</div>`).join("")}
        ${ruleBadges ? `<details class="ctx-rules"><summary>注入了 ${(a.cb.injectedRules || []).length} 条规则</summary><div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">${ruleBadges}</div></details>` : ""}
      </div>`;
  };

  const breakdownHtml =
    groupsSorted.length === 0
      ? `<div class="empty-note">还没有会话。发一条消息后，这里会显示每个会话的上下文窗口里装了什么。</div>`
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
                  <strong>${esc(grp?.title || groupId)}</strong>
                  <div class="ctx-faint">
                    累计 ${fmtTok(leadTok + subTok)} tok，${turns} 轮
                    ${subs.length > 0 ? `　主导 ${fmtTok(leadTok)} · ${subs.length} 个子会话 ${fmtTok(subTok)}` : ""}
                    ${handoffTok > 0 ? `　交接 ${fmtTok(handoffTok)}` : ""}
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
      ? `<tr><td colspan="10" style="text-align:center;color:var(--faint)">暂无对话轮次记录</td></tr>`
      : recentTurns
          .map((t) => {
            const u = t.usage || {};
            const inj = (t.injectedRulesTokens || 0) + (t.injectedSkillsTokens || 0) + (t.handoffTokens || 0);
            return `
              <tr>
                <td>#${t.turnSeq}</td>
                <td>${app.formatTime(t.timestamp)}</td>
                <td>${esc(t.groupTitle || t.groupId)}</td>
                <td>${app.agentTagHtml ? app.agentTagHtml(t.agent) : `<span class="agent-tag" data-agent="${esc(t.agent)}">${esc(t.agent)}</span>`}${u.modelId ? ` <span class="mono" style="font-size:10.5px;color:var(--muted)">${esc(u.modelId)}</span>` : ""}</td>
                <td>${t.role === "lead" ? "主导" : "子会话"}</td>
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
      <div class="panel-sec-title">Token 用量</div>
      <div class="panel-sec-sub"></div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>全部 Agent 合计</span><span>${totals.turns} 轮${totals.estimatedTurns ? `，其中 ${totals.estimatedTurns} 轮为估算` : ""}</span></div>
        <div class="stat-card-value">${fmtTok(totals.totalTokens)}</div>
        <div class="stat-card-meta">
          <span>输入 ${fmtTok(totals.inputTokens)}</span>
          <span>缓存命中 ${cacheRate}%</span>
          <span>输出 ${fmtTok(totals.outputTokens + totals.thoughtTokens)}</span>
        </div>
      </div>
      ${agentCards}
    </div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">上下文分析</div>
      <div class="panel-sec-sub"></div>
    </div>

    <div class="session-breakdown-list">${breakdownHtml}</div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">逐轮记录</div>
      <div class="panel-sec-sub">带 ~ 的是估算值</div>
    </div>

    <div class="telemetry-table-wrap">
      <table class="telemetry-table">
        <thead>
          <tr>
            <th>#</th>
            <th>时间</th>
            <th>任务分组</th>
            <th>Agent</th>
            <th>角色</th>
            <th class="num-col">上下文注入</th>
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
  ctxActiveKey: "common", // 当前查看/编辑的分区：common | sec:<idx> | res:<key>
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
        name: "方案设计与实现",
        agent: primary,
        prompt: "阅读需求与现有代码结构，完成核心实现改动并自行运行基础检查。",
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step2",
        name: "代码审查与测试补充",
        agent: secondary,
        prompt: "基于前一步改动结果审查边界条件、错误处理与回归风险，并补充或运行验证测试。",
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
        name: "代码现状调研",
        agent: primary,
        prompt: "梳理相关模块现有实现、调用链路及历史约束，输出带文件路径与行号的调研结论。",
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step2",
        name: "方案与风险评估",
        agent: secondary,
        prompt: "从性能、兼容性与可测试性维度分析可选改造路径并指出潜在风险点。",
        dependsOn: [],
        isolateWorktree: false,
        contextRefs: [],
      },
      {
        id: "step3",
        name: "汇总结论与行动清单",
        agent: third,
        prompt: "结合前两步的调研与评估结果，给出可执行的设计方案和分步实施清单。",
        dependsOn: ["step1", "step2"],
        isolateWorktree: false,
        contextRefs: [],
      },
    ];
  }
  return [
    {
      id: "step1",
      name: "Worktree 隔离改动",
      agent: primary,
      prompt: "在独立 git worktree 中完成代码修改并提交本地检查结果。",
      dependsOn: [],
      isolateWorktree: true,
      contextRefs: [],
    },
    {
      id: "step2",
      name: "回归测试与验收",
      agent: secondary,
      prompt: "核对工作区变更摘要并执行全量构建、类型检查与关键回归测试。",
      dependsOn: ["step1"],
      isolateWorktree: false,
      contextRefs: [],
    },
  ];
}

// 带验收关卡的步骤，运行中要分清是在做、在验收还是在返工
function wfStepStatusText(live, status) {
  if (status === "running" && live?.review) {
    if (live.phase === "review") return `验收中 · 第 ${live.round || 1} 轮`;
    if ((live.round || 1) > 1) return `返工中 · 第 ${live.round} 轮`;
  }
  return WF_STEP_STATUS_TEXT[status] || status;
}

const WF_STEP_STATUS_TEXT = {
  draft: "草稿",
  pending: "等待上游",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
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
  const res = await fetch(path, {
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
  const res = await fetch("/api/context/replace", {
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
    const data = await (await fetch("/api/workflows/templates")).json();
    WF_STATE.templates = data.templates || [];
  } catch {
    WF_STATE.templates = [];
  }
}

async function wfTemplateAction(groupId, value) {
  try {
    if (value === "save") {
      const name = await app.showPromptModal({ title: "存为模板", label: "模板名称", confirmText: "保存" });
      if (!name || !String(name).trim()) return;
      await wfSave(groupId);
      const data = await wfPost("/api/workflows/templates/save", { groupId, name: String(name).trim() }, true);
      WF_STATE.templates = data.templates || [];
    } else if (value.startsWith("load:")) {
      const draft = wfDraft(groupId);
      if (draft.steps.length > 0) {
        const ok = await app.showConfirmModal({
          title: "载入模板",
          message: "当前的步骤会被模板替换，步骤里的任务内容需要按这次的任务改一改。",
          confirmText: "载入",
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
    await app.showConfirmModal({ title: "模板操作没有成功", message: err.message, confirmText: "知道了" });
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
    title: "可用内存不多了",
    message: `系统可用内存只剩约 ${gb} GB。每个运行中的步骤都要启动一组 Agent 进程，内存耗尽时后端可能被系统终止。现在发布的话，步骤会一次只跑一个。建议先关掉不用的程序。`,
    confirmText: "仍然发布",
    cancelText: "先不发布",
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
    await app.showConfirmModal({ title: "工作流没有执行", message: err.message, confirmText: "知道了" });
  }
  WF_STATE.lastSignature = "";
  renderWorkflowPanel();
}

async function wfAskLeadToDraft(group) {
  const goal = await app.showPromptModal({
    title: `让 ${group.leadAgent} 起草工作流`,
    message: "写下要完成的目标。主导会把它拆成几步子会话并存成草稿，不会直接执行。",
    placeholder: "例如：给登录模块补单元测试，并让另一个 Agent 审查",
    confirmText: "起草",
  });
  if (!goal || !goal.trim()) return;
  const prompt = [
    "请为下面的目标规划一个子会话工作流，并调用 MCP 工具 workflow_propose 提交草稿。",
    "要求：每一步写清楚交给哪个 Agent（先用 peer_list_agents 看可用的）、自包含的任务说明、依赖哪些步骤；可以并行的步骤不要互相依赖。",
    "只提交草稿，不要自己执行或委派这些步骤，我会在工作流面板里确认后发布。",
    "",
    `目标：${goal.trim()}`,
  ].join("\n");
  void app.sendStreamPrompt(prompt, `lead:${group.groupId}`);
  app.appendLog(`已让 ${group.leadAgent} 起草工作流`);
}

// 流程图布局：按「离起点有几层依赖」分列，从左到右；同列按重心启发式排序减少交叉
const WF_NODE_W = 236;
const WF_NODE_H = 76;
const WF_COL_GAP = 84;
const WF_ROW_GAP = 42;
const WF_PAD_X = 24;
const WF_PAD_Y = 36;

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
  let maxDepth = 0;
  for (const d of depths.values()) {
    if (d > maxDepth) maxDepth = d;
  }
  const columns = Array.from({ length: maxDepth + 1 }, () => []);
  for (const step of steps) {
    const d = depths.get(step.id) || 0;
    columns[d].push(step);
  }

  // 两轮正反向重心排序，让有依赖关系的步骤尽量对齐同一水平线，减少交叉线
  const orderIdx = new Map(steps.map((s, i) => [s.id, i]));
  const stepIds = new Set(steps.map((s) => s.id));
  const depsOf = new Map();
  const childrenOf = new Map(steps.map((s) => [s.id, []]));
  for (const s of steps) {
    const deps = (s.dependsOn || []).filter((d) => stepIds.has(d) && d !== s.id);
    depsOf.set(s.id, deps);
    for (const d of deps) childrenOf.get(d).push(s.id);
  }

  const rowOf = new Map();
  columns.forEach((col) => col.forEach((s, r) => rowOf.set(s.id, r)));

  const sortColumn = (c, neighborMap) => {
    const col = columns[c];
    if (!col || col.length <= 1) return;
    const weights = new Map();
    col.forEach((s, idx) => {
      const nb = neighborMap.get(s.id) || [];
      const w = nb.length > 0 ? nb.reduce((sum, id) => sum + (rowOf.get(id) ?? idx), 0) / nb.length : idx;
      weights.set(s.id, { w, cur: idx, orig: orderIdx.get(s.id) ?? idx });
    });
    col.sort((a, b) => {
      const wa = weights.get(a.id);
      const wb = weights.get(b.id);
      if (Math.abs(wa.w - wb.w) > 1e-6) return wa.w - wb.w;
      if (wa.cur !== wb.cur) return wa.cur - wb.cur;
      return wa.orig - wb.orig;
    });
    col.forEach((s, r) => rowOf.set(s.id, r));
  };

  if (columns.length > 1) {
    for (let pass = 0; pass < 2; pass++) {
      for (let c = 1; c < columns.length; c++) sortColumn(c, depsOf);
      for (let c = columns.length - 2; c >= 0; c--) sortColumn(c, childrenOf);
    }
    for (let c = 1; c < columns.length; c++) sortColumn(c, depsOf);
  }

  const pos = new Map();
  let maxRows = 0;
  columns.forEach((col, c) => {
    maxRows = Math.max(maxRows, col.length);
    col.forEach((step, r) => {
      pos.set(step.id, {
        x: WF_PAD_X + c * (WF_NODE_W + WF_COL_GAP),
        y: WF_PAD_Y + r * (WF_NODE_H + WF_ROW_GAP),
        col: c,
        row: r,
      });
    });
  });
  return {
    pos,
    columns,
    maxRows,
    width: WF_PAD_X * 2 + columns.length * WF_NODE_W + Math.max(0, columns.length - 1) * WF_COL_GAP,
    height: WF_PAD_Y * 2 + maxRows * WF_NODE_H + Math.max(0, maxRows - 1) * WF_ROW_GAP,
  };
}

// 计算工作流连线：端口错位减少重合；跨列且前方有节点遮挡时走水平行间走廊绕行
function wfBuildEdges(steps, layout, statusMap) {
  const allPos = [...layout.pos.values()];
  const stepOrder = new Map(steps.map((s, i) => [s.id, i]));
  const rawEdges = [];

  for (const step of steps) {
    const to = layout.pos.get(step.id);
    if (!to) continue;
    const toStatus = statusMap.get(step.id) || "draft";
    for (const dep of step.dependsOn || []) {
      const from = layout.pos.get(dep);
      if (!from) continue;
      const depStatus = statusMap.get(dep) || "draft";
      const isDone = depStatus === "completed";
      const isActive = isDone && toStatus === "running";
      const isBlocked = depStatus === "failed" || depStatus === "cancelled" || depStatus === "skipped";
      rawEdges.push({
        depId: dep,
        stepId: step.id,
        from,
        to,
        edgeCls: isActive ? "wf-edge active" : isDone ? "wf-edge done" : isBlocked ? "wf-edge blocked" : "wf-edge",
        markerId: isActive ? "wfArrowActive" : isDone ? "wfArrowDone" : isBlocked ? "wfArrowBlocked" : "wfArrow",
      });
    }
  }

  // 多出边 / 多入边纵向微错位（控制在节点中部 ±18px 内，避开边角）
  const outByNode = new Map();
  const inByNode = new Map();
  for (const e of rawEdges) {
    if (!outByNode.has(e.depId)) outByNode.set(e.depId, []);
    outByNode.get(e.depId).push(e);
    if (!inByNode.has(e.stepId)) inByNode.set(e.stepId, []);
    inByNode.get(e.stepId).push(e);
  }
  for (const list of outByNode.values()) {
    list.sort(
      (a, b) =>
        a.to.y - b.to.y ||
        a.to.col - b.to.col ||
        (stepOrder.get(a.stepId) ?? 0) - (stepOrder.get(b.stepId) ?? 0),
    );
    const gap = Math.min(10, 36 / Math.max(1, list.length));
    list.forEach((e, idx) => {
      e.y1 = e.from.y + WF_NODE_H / 2 + (idx - (list.length - 1) / 2) * gap;
    });
  }
  for (const list of inByNode.values()) {
    list.sort(
      (a, b) =>
        a.from.y - b.from.y ||
        a.from.col - b.from.col ||
        (stepOrder.get(a.depId) ?? 0) - (stepOrder.get(b.depId) ?? 0),
    );
    const gap = Math.min(10, 36 / Math.max(1, list.length));
    list.forEach((e, idx) => {
      e.y2 = e.to.y + WF_NODE_H / 2 + (idx - (list.length - 1) / 2) * gap;
    });
  }

  const maxRows = Math.max(1, layout.maxRows || 1);
  const corridorBaseY = (k) => {
    if (k <= 0) return WF_PAD_Y - 18;
    if (k >= maxRows) return layout.height - WF_PAD_Y + 18;
    return WF_PAD_Y + k * (WF_NODE_H + WF_ROW_GAP) - WF_ROW_GAP / 2;
  };

  const isObstructed = (e) => {
    if (e.to.col <= e.from.col + 1) return false;
    const minY = Math.min(e.y1, e.y2);
    const maxY = Math.max(e.y1, e.y2);
    return allPos.some(
      (n) =>
        n.col > e.from.col &&
        n.col < e.to.col &&
        n.y - 10 <= maxY &&
        n.y + WF_NODE_H + 10 >= minY,
    );
  };

  // 为需要绕行的跨列边挑选最近的水平走廊，并对同走廊重叠线段分道
  const corridorGroups = new Map();
  for (const e of rawEdges) {
    if (!isObstructed(e)) continue;
    let bestK = 0;
    let bestCost = Infinity;
    for (let k = 0; k <= maxRows; k++) {
      const cy = corridorBaseY(k);
      const outerPenalty = k === 0 || k === maxRows ? 10 : 0;
      const cost = Math.abs(e.y1 - cy) + Math.abs(e.y2 - cy) + outerPenalty;
      if (cost < bestCost) {
        bestCost = cost;
        bestK = k;
      }
    }
    e.corridorK = bestK;
    if (!corridorGroups.has(bestK)) corridorGroups.set(bestK, []);
    corridorGroups.get(bestK).push(e);
  }

  for (const [k, groupEdges] of corridorGroups.entries()) {
    groupEdges.sort(
      (a, b) => a.from.col - b.from.col || a.to.col - b.to.col || a.y1 + a.y2 - (b.y1 + b.y2),
    );
    const laneEnds = [];
    for (const e of groupEdges) {
      let lane = laneEnds.findIndex((lastToCol) => e.from.col >= lastToCol);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(e.to.col);
      } else {
        laneEnds[lane] = e.to.col;
      }
      e.lane = lane;
    }
    const laneCount = laneEnds.length;
    const step = Math.min(6, 22 / Math.max(1, laneCount - 1));
    const base = corridorBaseY(k);
    for (const e of groupEdges) {
      const offset = Math.max(-11, Math.min(11, (e.lane - (laneCount - 1) / 2) * step));
      e.corridorY = base + offset;
    }
  }

  const turnW = Math.min(72, WF_COL_GAP - 12);
  const cp = Math.round(turnW * 0.42);
  return rawEdges.map((e) => {
    const x1 = e.from.x + WF_NODE_W;
    const x2 = e.to.x;
    let d;
    if (e.corridorY !== undefined) {
      const xTurn1 = x1 + turnW;
      const xTurn2 = x2 - turnW;
      const cy = Math.round(e.corridorY * 10) / 10;
      d = `M${x1},${e.y1} C${x1 + cp},${e.y1} ${xTurn1 - cp},${cy} ${xTurn1},${cy} L${xTurn2},${cy} C${xTurn2 + cp},${cy} ${x2 - cp},${e.y2} ${x2},${e.y2}`;
    } else {
      const mid = (x1 + x2) / 2;
      d = `M${x1},${e.y1} C${mid},${e.y1} ${mid},${e.y2} ${x2},${e.y2}`;
    }
    return `<path class="${e.edgeCls}" d="${d}" marker-end="url(#${e.markerId})" />`;
  });
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
          : `<input class="text-input wf-name" data-wf-field="name" value="${esc(step.name)}" placeholder="步骤名称" />`
      }
      <button type="button" class="mini-icon-btn" id="wfPopClose" title="关闭">×</button>
    </div>
    <div class="wf-pop-row">
      <label>交给</label>
      ${
        readonly
          ? app.agentTagHtml
            ? app.agentTagHtml(step.agent)
            : esc(step.agent)
          : `<select class="perm-select" data-wf-field="agent">${agents
              .map((a) => `<option value="${esc(a.agent)}" ${a.agent === step.agent ? "selected" : ""}>${esc(a.label || a.agent)}</option>`)
              .join("")}</select>`
      }
      ${running || showResults ? `<span class="wf-step-status">${esc(WF_STEP_STATUS_TEXT[status] || status)}</span>` : ""}
    </div>
    ${
      others.length > 0
        ? `<div class="wf-pop-block">
            <label>${readonly ? "等这些步骤完成后开始" : "在这些步骤之后（点选）"}</label>
            <div class="wf-deps">${
              readonly
                ? step.dependsOn.length > 0
                  ? step.dependsOn.map((d) => `<span class="origin-tag">${esc(steps.find((s) => s.id === d)?.name || d)}</span>`).join("")
                  : '<span class="ctx-faint">没有依赖，一发布就开始</span>'
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
            <label>${readonly ? "附带的上下文分区" : "附带这些上下文分区（公共部分总会带上）"}</label>
            <div class="wf-deps">${
              readonly
                ? (step.contextRefs || []).length > 0
                  ? step.contextRefs.map((k) => `<span class="origin-tag">${esc(k)}</span>`).join("")
                  : '<span class="ctx-faint">只带公共部分</span>'
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
      <label>任务内容</label>
      ${
        readonly
          ? `<div class="wf-prompt-readonly">${esc(step.prompt)}</div>`
          : `<textarea class="rule-editor-textarea wf-prompt" data-wf-field="prompt" placeholder="交给这个子会话的任务，写得让它不看上下文也能做">${esc(step.prompt)}</textarea>`
      }
    </div>
    ${
      readonly
        ? ""
        : `<label class="wf-check"><input type="checkbox" data-wf-field="isolateWorktree" ${step.isolateWorktree ? "checked" : ""} />在独立的 git worktree 里改动</label>`
    }
    ${(() => {
      // 验收关卡：做完后交给另一个 Agent 验收，不通过自动打回重做
      const review = readonly ? live?.review || step.review : step.review;
      if (readonly) {
        if (!review) return "";
        const round = live?.round ? ` · 第 ${live.round} 轮${live.phase === "review" ? "验收中" : live.phase === "work" && live.round > 1 ? "返工中" : ""}` : "";
        return `<div class="wf-pop-block"><label>验收</label><div class="wf-deps"><span class="origin-tag">${esc(review.agent)} 验收，最多 ${review.maxRounds} 轮${round}</span></div>${
          live?.reviewNotes ? `<details class="wf-review-notes"><summary>验收意见</summary><pre>${esc(live.reviewNotes)}</pre></details>` : ""
        }</div>`;
      }
      return `<div class="wf-pop-block">
        <label>验收关卡</label>
        <div class="wf-pop-head">
          <select class="perm-select" data-wf-review="agent">
            <option value="">不验收</option>
            ${agents.map((a) => `<option value="${esc(a.agent)}" ${review?.agent === a.agent ? "selected" : ""}>${esc(a.label || a.agent)} 验收</option>`).join("")}
          </select>
          ${
            review
              ? `<select class="perm-select" data-wf-review="maxRounds" title="验收不通过会打回重做，到这个轮数还不过就算失败">${[1, 2, 3, 4, 5]
                  .map((n) => `<option value="${n}" ${(review.maxRounds || 2) === n ? "selected" : ""}>最多 ${n} 轮</option>`)
                  .join("")}</select>`
              : ""
          }
        </div>
        ${review ? `<textarea class="rule-editor-textarea" data-wf-review="criteria" rows="2" placeholder="验收标准（可不填，默认按任务内容验收）">${esc(review.criteria || "")}</textarea>` : ""}
      </div>`;
    })()}
    ${live?.error && (running || showResults) ? `<div class="wf-error">${esc(live.error)}</div>` : ""}
    ${(() => {
      if (!(running || showResults) || !live?.sessionKey) return "";
      const outText = wfGetStepOutputPreview(group.groupId, step.id, live.sessionKey);
      if (!outText) return "";
      const clipped = outText.length > 1600 ? `${outText.slice(0, 1600)}\n...(更多内容请点「查看会话」)` : outText;
      return `<details class="wf-pop-result"><summary>步骤输出预览（${outText.length} 字）</summary><pre class="wf-pop-result-pre">${esc(clipped)}</pre></details>`;
    })()}
    <div class="wf-pop-foot">
      ${readonly ? "<span></span>" : '<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" id="wfPopRemove">删除这一步</button>'}
      ${live?.sessionKey && (running || showResults) ? '<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfPopOpen">查看会话</button>' : ""}
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
          title: "不能这样排",
          message: `「${steps.find((s) => s.id === depId)?.name || depId}」已经排在这一步之后，再让这一步等它会成环。`,
          confirmText: "知道了",
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
    group.title,
    group.leadAgent,
    server.updatedAt,
    server.status,
    server.steps.map((s) => `${s.id}:${s.status}:${s.phase || ""}:${s.round || 1}`).join(","),
    draft.version,
    agents.map((a) => a.agent).join(","),
    wfServerContext(groupId).sections.map((s) => `${s.key}:${s.updatedAt}`).join(","),
    wfContextDraft(groupId).version,
    WF_STATE.ctxOpen,
    WF_STATE.ctxActiveKey,
  ].join("|");
  if (signature === WF_STATE.lastSignature && container.childElementCount > 0) return;
  // 流程图：按当前缩放比例和步骤依赖重算节点与连线
  WF_STATE.lastSignature = signature;

  const steps = running ? server.steps : draft.steps;
  const serverById = new Map(server.steps.map((s) => [s.id, s]));
  const showResults = !running && !draft.dirty && (server.status === "completed" || server.status === "failed");
  const statusOf = (step) => (step && (running || showResults) ? serverById.get(step.id)?.status || "draft" : "draft");
  const hasRetryableSteps =
    !running &&
    server.steps.some((s) => s.status === "failed" || s.status === "cancelled" || s.status === "skipped");

  const doneCount = server.steps.filter((s) => s.status === "completed").length;
  const statusLine = running
    ? `正在运行：${doneCount} / ${server.steps.length} 步完成`
    : showResults
      ? server.status === "completed"
        ? "上次运行全部完成"
        : "上次运行有步骤没有完成"
      : steps.length === 0
        ? ""
        : draft.dirty
          ? "有未保存的修改"
          : server.proposedBy && server.proposedBy !== "user"
            ? `${server.proposedBy} 起草的草稿，确认后发布`
            : "草稿";

  // 共享上下文：收起时一行徽章+直达标签，展开后左导航右编辑/只读预览，不挤占画布
  const ctxDraft = wfContextDraft(groupId);
  const ctxResults = wfServerContext(groupId).sections.filter((sec) => sec.kind === "result");
  const refCount = (key) => (key ? steps.filter((st) => (st.contextRefs || []).includes(key)).length : 0);

  let ctxActiveKey = WF_STATE.ctxActiveKey || "common";
  if (ctxActiveKey.startsWith("sec:")) {
    const idx = Number(ctxActiveKey.slice(4));
    if (!Number.isInteger(idx) || idx < 0 || idx >= ctxDraft.sections.length) ctxActiveKey = "common";
  } else if (ctxActiveKey.startsWith("res:")) {
    const resKey = ctxActiveKey.slice(4);
    if (!ctxResults.some((sec) => sec.key === resKey)) ctxActiveKey = "common";
  }
  WF_STATE.ctxActiveKey = ctxActiveKey;

  const commonTrimmed = ctxDraft.common.trim();
  const commonPreview = commonTrimmed.replace(/\s+/g, " ").slice(0, 42) + (commonTrimmed.length > 42 ? "…" : "");
  const hasGlanceItems = Boolean(commonTrimmed || ctxDraft.sections.length > 0 || ctxResults.length > 0);
  const glanceHtml = hasGlanceItems
    ? `<div class="wf-ctx-glance" id="wfCtxGlance" ${WF_STATE.ctxOpen ? "hidden" : ""}>
         ${commonTrimmed ? `<button type="button" class="wf-ctx-chip is-common" data-ctx-jump="common" title="点击展开并编辑公共部分">公共：${esc(commonPreview)}</button>` : ""}
         ${ctxDraft.sections
           .map(
             (sec, i) =>
               `<button type="button" class="wf-ctx-chip" data-ctx-jump="sec:${i}" title="${esc(sec.summary || sec.key || "点击查看/编辑")}">${esc(sec.key || `分区 ${i + 1}`)} · ${refCount(sec.key.trim().toLowerCase())}步</button>`,
           )
           .join("")}
         ${ctxResults
           .map(
             (sec) =>
               `<button type="button" class="wf-ctx-chip is-result" data-ctx-jump="res:${esc(sec.key)}" title="点击查看步骤产出">${esc((sec.summary || sec.key).replace(/的结果.*$/, ""))}</button>`,
           )
           .join("")}
       </div>`
    : "";

  let activePaneHtml = "";
  if (ctxActiveKey.startsWith("sec:")) {
    const secIdx = Number(ctxActiveKey.slice(4));
    const sec = ctxDraft.sections[secIdx];
    const secRefs = refCount(sec.key.trim().toLowerCase());
    activePaneHtml = `
      <div class="wf-ctx-pane-head">
        <span class="wf-ctx-pane-title">命名分区</span>
        <span class="ctx-faint">${secRefs} 步引用 · 上限 8000 字</span>
      </div>
      <div class="wf-ctx-section-head">
        <input class="text-input" data-ctx-field="key" data-ctx-index="${secIdx}" value="${esc(sec.key)}" placeholder="分区名，如 user-mgmt" ${sec.saved || running ? "readonly" : ""} />
        <input class="text-input" data-ctx-field="summary" data-ctx-index="${secIdx}" value="${esc(sec.summary)}" placeholder="一句话说明里面是什么" ${running ? "readonly" : ""} />
        ${running ? "" : `<button type="button" class="mini-icon-btn" data-ctx-remove="${secIdx}" title="删除这个分区">×</button>`}
      </div>
      <textarea class="rule-editor-textarea wf-ctx-editor" data-ctx-field="content" data-ctx-index="${secIdx}" ${running ? "readonly" : ""} placeholder="只有部分步骤需要的内容">${esc(sec.content)}</textarea>`;
  } else if (ctxActiveKey.startsWith("res:")) {
    const resKey = ctxActiveKey.slice(4);
    const resSec = ctxResults.find((s) => s.key === resKey);
    activePaneHtml = `
      <div class="wf-ctx-pane-head">
        <span class="wf-ctx-pane-title">${esc(resSec?.summary || resKey)}</span>
        <span class="ctx-faint">自动保存 · 下游步骤会自动收到${resSec?.truncated ? " · 已截断至 6000 字" : ""}</span>
      </div>
      <pre class="wf-ctx-result-pre">${esc(resSec?.content || "")}</pre>`;
  } else {
    activePaneHtml = `
      <div class="wf-ctx-pane-head">
        <span class="wf-ctx-pane-title">公共部分</span>
        <span class="ctx-faint">每个子会话都会收到，写一次即可 · 上限 4000 字</span>
      </div>
      <textarea class="rule-editor-textarea wf-ctx-editor" id="wfCtxCommon" ${running ? "readonly" : ""} placeholder="目标、版本、约定、禁止事项、材料在哪……">${esc(ctxDraft.common)}</textarea>`;
  }

  const ctxHtml = `
    <div class="wf-context-shell">
      <details class="wf-context" id="wfContextBox" ${WF_STATE.ctxOpen ? "open" : ""}>
        <summary>
          <span class="wf-ctx-head-left">
            <span class="wf-ctx-chevron" aria-hidden="true">▸</span>
            <span>共享上下文</span>
          </span>
          <span class="wf-ctx-badges">
            <span class="wf-ctx-pill">${commonTrimmed ? `公共 ${commonTrimmed.length} 字` : "公共未填"}</span>
            ${ctxDraft.sections.length > 0 ? `<span class="wf-ctx-pill">${ctxDraft.sections.length} 个分区</span>` : ""}
            ${ctxResults.length > 0 ? `<span class="wf-ctx-pill is-result">${ctxResults.length} 个产出</span>` : ""}
            ${ctxDraft.dirty ? `<span class="wf-ctx-pill is-dirty">未保存</span>` : ""}
          </span>
        </summary>
        <div class="wf-context-grid">
          <div class="wf-ctx-nav">
            <button type="button" class="wf-ctx-nav-item ${ctxActiveKey === "common" ? "active" : ""}" data-ctx-nav="common">
              <span class="wf-ctx-nav-name">公共部分</span>
              <span class="wf-ctx-nav-meta">${commonTrimmed.length}字</span>
            </button>
            ${
              ctxDraft.sections.length > 0
                ? `<div class="wf-ctx-nav-group">命名分区</div>
                   ${ctxDraft.sections
                     .map(
                       (sec, i) => `
                     <button type="button" class="wf-ctx-nav-item ${ctxActiveKey === `sec:${i}` ? "active" : ""}" data-ctx-nav="sec:${i}" title="${esc(sec.summary || sec.key || `分区 ${i + 1}`)}">
                       <span class="wf-ctx-nav-name">${esc(sec.key || `新分区 ${i + 1}`)}</span>
                       <span class="wf-ctx-nav-meta">${refCount(sec.key.trim().toLowerCase())}步</span>
                     </button>`,
                     )
                     .join("")}`
                : ""
            }
            ${
              ctxResults.length > 0
                ? `<div class="wf-ctx-nav-group">步骤产出（只读）</div>
                   ${ctxResults
                     .map(
                       (sec) => `
                     <button type="button" class="wf-ctx-nav-item is-result ${ctxActiveKey === `res:${sec.key}` ? "active" : ""}" data-ctx-nav="res:${esc(sec.key)}" title="${esc(sec.summary || sec.key)}">
                       <span class="wf-ctx-nav-name">${esc((sec.summary || sec.key).replace(/的结果.*$/, ""))}</span>
                       <span class="wf-ctx-nav-meta">${sec.content.length}字</span>
                     </button>`,
                     )
                     .join("")}`
                : ""
            }
            ${
              running
                ? ""
                : `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm wf-ctx-add-btn" id="wfCtxAddBtn">+ 添加分区</button>`
            }
          </div>
          <div class="wf-ctx-pane">
            ${activePaneHtml}
            ${
              running
                ? ""
                : `<div class="wf-ctx-pane-foot">
                     <span class="ctx-faint" id="wfCtxSaveState">${ctxDraft.dirty ? "有未保存的改动" : "已同步至工作流"}</span>
                     <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfCtxSaveBtn" ${ctxDraft.dirty ? "" : "disabled"}>保存上下文</button>
                   </div>`
            }
          </div>
        </div>
      </details>
      ${glanceHtml}
    </div>`;

  const statusMap = new Map(steps.map((s) => [s.id, statusOf(s)]));
  const layout = wfLayout(steps);
  const edges = wfBuildEdges(steps, layout, statusMap);

  let runDone = 0;
  let runActive = 0;
  let runFail = 0;
  let runWait = 0;
  let runSkip = 0;
  const nodes = steps
    .map((step, index) => {
      const p = layout.pos.get(step.id);
      const live = serverById.get(step.id);
      const status = statusMap.get(step.id) || "draft";
      if (status === "completed") runDone += 1;
      else if (status === "running") runActive += 1;
      else if (status === "failed") runFail += 1;
      else if (status === "pending") runWait += 1;
      else if (status === "skipped" || status === "cancelled") runSkip += 1;

      const isReady =
        running &&
        status === "pending" &&
        step.dependsOn.every((depId) => statusMap.get(depId) === "completed");
      const isReview = status === "running" && Boolean(live?.review && live?.phase === "review");
      const isRework = status === "running" && Boolean(live?.review && (live?.round || 1) > 1 && live?.phase !== "review");
      const isEmptyDraft = status === "draft" && !step.prompt.trim();

      let markHtml = `<span class="wf-status-mark is-draft">${index + 1}</span>`;
      if (status === "running") {
        markHtml = `<span class="wf-status-mark is-running" aria-hidden="true"></span>`;
      } else if (status === "completed") {
        markHtml = `<span class="wf-status-mark is-completed" aria-hidden="true">✓</span>`;
      } else if (status === "failed") {
        markHtml = `<span class="wf-status-mark is-failed" aria-hidden="true">✕</span>`;
      } else if (status === "pending") {
        markHtml = `<span class="wf-status-mark ${isReady ? "is-ready" : "is-pending"}" aria-hidden="true">${isReady ? "⏳" : "⋯"}</span>`;
      } else if (status === "skipped" || status === "cancelled") {
        markHtml = `<span class="wf-status-mark is-muted" aria-hidden="true">—</span>`;
      }

      const statusText =
        running || showResults
          ? isReady
            ? "排队待跑"
            : wfStepStatusText(live, status)
          : step.prompt.trim()
            ? "已就绪"
            : "待填任务";
      const nodeCls = [
        "wf-node",
        `status-${esc(status)}`,
        isReady ? "is-ready" : "",
        isReview ? "phase-review" : "",
        isRework ? "phase-rework" : "",
        isEmptyDraft ? "is-empty-draft" : "",
        WF_STATE.selectedId === step.id ? "selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const flagsHtml = [
        step.isolateWorktree ? `<span class="wf-mini-tag" title="独立 git worktree">wt</span>` : "",
        step.review ? `<span class="wf-mini-tag is-review" title="含验收关卡">验</span>` : "",
      ]
        .filter(Boolean)
        .join("");

      return `
        <button type="button" class="${nodeCls}" data-wf-node="${esc(step.id)}"
          style="left:${p.x}px;top:${p.y}px;width:${WF_NODE_W}px;height:${WF_NODE_H}px" title="${esc(step.name)}">
          <span class="wf-node-top">
            ${markHtml}
            <span class="wf-node-name">${esc(step.name || `步骤 ${index + 1}`)}</span>
          </span>
          <span class="wf-node-bottom">
            <span class="wf-node-tags">
              ${app.agentTagHtml ? app.agentTagHtml(step.agent) : esc(step.agent)}
              ${flagsHtml}
            </span>
            <span class="wf-node-status-pill">${esc(statusText)}</span>
          </span>
        </button>`;
    })
    .join("");

  const totalSteps = Math.max(1, steps.length);
  const runSummaryHtml =
    (running || showResults) && steps.length > 0
      ? `<div class="wf-run-summary">
           <div class="wf-run-bar" aria-hidden="true">
             ${runDone > 0 ? `<span class="wf-run-seg is-done" style="width:${(runDone / totalSteps) * 100}%"></span>` : ""}
             ${runActive > 0 ? `<span class="wf-run-seg is-running" style="width:${(runActive / totalSteps) * 100}%"></span>` : ""}
             ${runFail > 0 ? `<span class="wf-run-seg is-failed" style="width:${(runFail / totalSteps) * 100}%"></span>` : ""}
             ${runWait > 0 ? `<span class="wf-run-seg is-wait" style="width:${(runWait / totalSteps) * 100}%"></span>` : ""}
             ${runSkip > 0 ? `<span class="wf-run-seg is-skip" style="width:${(runSkip / totalSteps) * 100}%"></span>` : ""}
           </div>
           <div class="wf-run-counts">
             <span class="wf-run-badge is-done">已完成 ${runDone}/${steps.length}</span>
             ${runActive > 0 ? `<span class="wf-run-badge is-running">进行中 ${runActive}</span>` : ""}
             ${runWait > 0 ? `<span class="wf-run-badge is-wait">待跑/等待 ${runWait}</span>` : ""}
             ${runFail > 0 ? `<span class="wf-run-badge is-failed">失败 ${runFail}</span>` : ""}
             ${runSkip > 0 ? `<span class="wf-run-badge is-skip">跳过/取消 ${runSkip}</span>` : ""}
           </div>
         </div>`
      : "";

  const zoom = Math.min(1.6, Math.max(0.45, Number(WF_STATE.zoom) || 1));
  const zoomPct = Math.round(zoom * 100);
  const scaledW = Math.round(layout.width * zoom);
  const scaledH = Math.round(layout.height * zoom);
  const scrollPrev = container.querySelector(".wf-canvas-wrap");
  const prevScroll = scrollPrev ? { left: scrollPrev.scrollLeft, top: scrollPrev.scrollTop } : null;

  container.innerHTML = `
    <div class="panel-sec-head">
      <div class="panel-sec-title">${esc(group.title)} 的工作流</div>
      <div class="panel-sec-sub">${esc(statusLine)}</div>
    </div>
    <div class="panel-toolbar">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${
          running
            ? ""
            : `<select class="perm-select" id="wfTemplateSelect" title="把保存过的编排载入为草稿，或把当前编排存为模板">
                 <option value="">模板…</option>
                 ${(WF_STATE.templates || []).map((t) => `<option value="load:${esc(t.name)}">载入：${esc(t.name)}（${t.stepCount} 步）</option>`).join("")}
                 ${steps.length > 0 ? '<option value="save">把当前编排存为模板…</option>' : ""}
                 ${(WF_STATE.templates || []).map((t) => `<option value="delete:${esc(t.name)}">删除：${esc(t.name)}</option>`).join("")}
               </select>
               <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAddStepBtn">添加步骤</button>
               <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAskLeadBtn" title="主导把目标拆成几步并存成草稿，不会直接执行">让 ${esc(group.leadAgent)} 起草</button>`
        }
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${
          running
            ? `<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" id="wfCancelBtn">停止</button>`
            : `<button type="button" class="alma-btn alma-btn-sm" id="wfSaveBtn" ${steps.length === 0 ? "disabled" : ""}>保存草稿</button>
               ${
                 canResume
                   ? `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfRunBtn" title="所有步骤从头再跑一遍，已完成的结果会丢弃">全部重跑</button>
                      <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfResumeBtn" title="保留已完成的步骤和结果，只跑没完成的">继续未完成的 ${unfinishedCount} 步</button>`
                   : `${hasRetryableSteps ? '<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfRetryBtn" title="保留已完成步骤的结果，重跑失败或未完成步骤">重试未完成步骤</button>' : ""}
                      <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfRunBtn" ${steps.length === 0 ? "disabled" : ""}>发布</button>`
               }`
        }
      </div>
    </div>
    ${ctxHtml}
    ${runSummaryHtml}
    ${
      steps.length === 0
        ? `<div class="empty-note">还没有步骤。添加几步交给子会话的任务，或点下方模板快速起步；也可以让 ${esc(group.leadAgent)} 先起草。
            <div class="wf-templates">
              <button type="button" class="wf-tpl-card" data-wf-tpl="impl-review">
                <span class="wf-tpl-title">代码实现 + 审查</span>
                <span class="wf-tpl-desc">Agent A 实现功能与基础检查，Agent B 接力审查边界与补充测试</span>
              </button>
              <button type="button" class="wf-tpl-card" data-wf-tpl="parallel-research">
                <span class="wf-tpl-title">并行调研汇总</span>
                <span class="wf-tpl-desc">两位 Agent 并行做现状调研与风险评估，最后汇聚输出结论</span>
              </button>
              <button type="button" class="wf-tpl-card" data-wf-tpl="worktree-verify">
                <span class="wf-tpl-title">隔离修改 + 验证</span>
                <span class="wf-tpl-desc">在独立 git worktree 中改动代码，完成后由另一步做回归验证</span>
              </button>
            </div>
          </div>`
        : `<div class="wf-canvas-shell">
             <div class="wf-zoom-bar">
               <button type="button" class="wf-zoom-btn" data-wf-zoom="out" title="缩小">-</button>
               <span class="wf-zoom-label" id="wfZoomLabel">${zoomPct}%</span>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="in" title="放大">+</button>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="reset" title="恢复 100%">100%</button>
               <button type="button" class="wf-zoom-btn" data-wf-zoom="fit" title="适应画布宽度">适应</button>
             </div>
             <div class="wf-canvas-wrap">
               <div class="wf-canvas-sizer" style="width:${scaledW}px;height:${scaledH}px">
                 <div class="wf-canvas" style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom})">
                   <svg class="wf-edges" width="${layout.width}" height="${layout.height}">
                     <defs>
                       <marker id="wfArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                         <path d="M0,0 L8,4 L0,8 z" class="wf-arrow" />
                       </marker>
                       <marker id="wfArrowDone" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                         <path d="M0,0 L8,4 L0,8 z" class="wf-arrow is-done" />
                       </marker>
                       <marker id="wfArrowActive" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                         <path d="M0,0 L8,4 L0,8 z" class="wf-arrow is-active" />
                       </marker>
                       <marker id="wfArrowBlocked" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                         <path d="M0,0 L8,4 L0,8 z" class="wf-arrow is-blocked" />
                       </marker>
                     </defs>
                     ${edges.join("")}
                   </svg>
                   ${nodes}
                 </div>
               </div>
             </div>
           </div>
           <div class="ctx-faint">从左到右执行，同一列的步骤同时进行。点一个步骤看明细${running ? "" : "或修改"}。</div>`
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
      const nextOpen = ctxBox.open;
      if (WF_STATE.ctxOpen !== nextOpen) {
        WF_STATE.ctxOpen = nextOpen;
        const glance = document.getElementById("wfCtxGlance");
        if (glance) glance.hidden = nextOpen;
      }
    };
  }
  container.querySelectorAll("[data-ctx-jump]").forEach((btn) => {
    btn.onclick = () => {
      WF_STATE.ctxOpen = true;
      WF_STATE.ctxActiveKey = btn.dataset.ctxJump || "common";
      WF_STATE.lastSignature = "";
      renderWorkflowPanel();
    };
  });
  container.querySelectorAll("[data-ctx-nav]").forEach((btn) => {
    btn.onclick = () => {
      WF_STATE.ctxActiveKey = btn.dataset.ctxNav || "common";
      WF_STATE.lastSignature = "";
      renderWorkflowPanel();
    };
  });
  const markCtxDirty = (structural) => {
    ctxDraft.dirty = true;
    if (structural) {
      ctxDraft.version += 1;
      renderWorkflowPanel();
    } else {
      const saveBtn = document.getElementById("wfCtxSaveBtn");
      if (saveBtn) saveBtn.disabled = false;
      const saveState = document.getElementById("wfCtxSaveState");
      if (saveState) saveState.textContent = "有未保存的改动";
    }
  };
  const commonEl = document.getElementById("wfCtxCommon");
  if (commonEl) {
    commonEl.oninput = () => {
      ctxDraft.common = commonEl.value;
      const meta = container.querySelector('[data-ctx-nav="common"] .wf-ctx-nav-meta');
      if (meta) meta.textContent = `${commonEl.value.trim().length}字`;
      markCtxDirty(false);
    };
  }
  container.querySelectorAll("[data-ctx-field]").forEach((el) => {
    el.oninput = () => {
      const idx = Number(el.dataset.ctxIndex);
      const sec = ctxDraft.sections[idx];
      if (!sec) return;
      sec[el.dataset.ctxField] = el.value;
      if (el.dataset.ctxField === "key") {
        const navName = container.querySelector(`[data-ctx-nav="sec:${idx}"] .wf-ctx-nav-name`);
        if (navName) navName.textContent = el.value.trim() || `新分区 ${idx + 1}`;
      }
      markCtxDirty(false);
    };
  });
  container.querySelectorAll("[data-ctx-remove]").forEach((btn) => {
    btn.onclick = () => {
      const removeIdx = Number(btn.dataset.ctxRemove);
      const [removed] = ctxDraft.sections.splice(removeIdx, 1);
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
      WF_STATE.ctxActiveKey =
        ctxDraft.sections.length > 0 ? `sec:${Math.min(removeIdx, ctxDraft.sections.length - 1)}` : "common";
      markCtxDirty(true);
    };
  });
  const ctxAddBtn = document.getElementById("wfCtxAddBtn");
  if (ctxAddBtn) {
    ctxAddBtn.onclick = () => {
      ctxDraft.sections.push({ key: "", summary: "", content: "", saved: false });
      WF_STATE.ctxOpen = true;
      WF_STATE.ctxActiveKey = `sec:${ctxDraft.sections.length - 1}`;
      markCtxDirty(true);
    };
  }
  const ctxSaveBtn = document.getElementById("wfCtxSaveBtn");
  if (ctxSaveBtn) {
    ctxSaveBtn.onclick = async () => {
      try {
        await wfSaveContext(groupId);
      } catch (err) {
        await app.showConfirmModal({ title: "上下文没有保存", message: err.message, confirmText: "知道了" });
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
      name: `步骤 ${n}`,
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
        WF_STATE.zoom = Math.max(0.45, Number((cur - 0.15).toFixed(2)));
      } else if (mode === "fit" && wrap) {
        const availW = Math.max(240, wrap.clientWidth - 20);
        const availH = Math.max(240, wrap.clientHeight - 20);
        const fitRatio = Math.min(availW / Math.max(1, layout.width), availH / Math.max(1, layout.height));
        WF_STATE.zoom = Math.min(1, Math.max(0.45, Number(fitRatio.toFixed(2))));
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
    } else if (app.isResourcesViewOpen?.()) {
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

window.HUB_PANELS = {
  fetchResources,
  renderResourcesPanel,
};

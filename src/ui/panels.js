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
};

async function fetchResources() {
  if (PANEL_STATE.loadingResources) return;
  PANEL_STATE.loadingResources = true;
  try {
    // 规则和技能按目录不同而不同：看的是当前任务所在的项目
    const activeCwd = app.STATE.taskGroups.get(app.STATE.activeGroupId)?.cwd || "";
    PANEL_STATE.resourcesCwd = activeCwd;
    const res = await fetch(`/api/resources${activeCwd ? `?cwd=${encodeURIComponent(activeCwd)}` : ""}`);
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
    app.appendLog(`加载共享资源失败: ${err.message}`);
  } finally {
    PANEL_STATE.loadingResources = false;
  }
}

async function toggleResource(id, enabled) {
  try {
    const res = await fetch("/api/resources/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
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
    const res = await fetch("/api/resources/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scope, content }),
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
    const res = await fetch("/api/resources/rules/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
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
    const res = await fetch("/api/resources/sync-project", { method: "POST" });
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
  if (!PANEL_STATE.previewCache.has(id)) {
    try {
      const res = await fetch(`/api/resources/content?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.ok) {
        PANEL_STATE.previewCache.set(id, data.content || "");
      }
    } catch {
      PANEL_STATE.previewCache.set(id, "(读取内容失败)");
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
          <span class="agent-tag" data-agent="${esc(b.agent)}">${esc(b.agent)}</span>
          <span>首轮桥接 ~${fmtTok(b.firstTurnInjectionTokens)} tok</span>
        </div>
        <div class="stat-card-value">${b.nativeRules + b.bridgedRules} 规则 · ${b.nativeSkills + b.bridgedSkills} 技能</div>
        <div class="stat-card-meta">
          <span>原生 ${b.nativeRules}规则 · ${b.nativeSkills}技能</span>
          <span>Hub注入 ${b.bridgedRules}规则 · ${b.bridgedSkills}技能</span>
        </div>
        ${b.droppedRules?.length ? `<div class="stat-card-warn" title="${esc(b.droppedRules.join("、"))}">${b.droppedRules.length} 条规则超出预算，只给了文件路径</div>` : ""}
      </div>`,
    )
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
            const previewText = isExpanded ? PANEL_STATE.previewCache.get(item.id) || "加载中..." : "";
            const canDelete = item.origin === "hub-project" || item.origin === "hub-global";
            const covHtml = covAgents
              .map((ag) => {
                if (!item.enabled) {
                  return `<span class="cov-pill off">${ag}: 停用</span>`;
                }
                const isNative = item.nativeAgents.includes(ag);
                return isNative
                  ? `<span class="cov-pill native">${ag}: 原生</span>`
                  : `<span class="cov-pill bridged">${ag}: 注入</span>`;
              })
              .join("");

            const tokText =
              item.kind === "skill"
                ? `索引 ~${item.indexTokens} / 全文 ~${fmtTok(item.fullTokens)} tok`
                : `~${fmtTok(item.fullTokens)} tok`;

            return `
              <div class="resource-row ${item.enabled ? "" : "disabled"}">
                <div class="resource-row-top">
                  <div class="resource-main">
                    <div class="resource-title-line">
                      <span class="kind-tag ${esc(item.kind)}">${item.kind === "rule" ? "RULE" : "SKILL"}</span>
                      <span class="scope-tag">${item.scope === "project" ? "项目" : "全局"}</span>
                      <span class="origin-tag">${esc(item.origin)}</span>
                      <span class="resource-name">${esc(item.name)}</span>
                      <span class="origin-tag">${tokText}</span>
                    </div>
                    <div class="resource-desc">${esc(item.description)}</div>
                    <div class="resource-path">${esc(item.primaryPath)}${item.sources.length > 1 ? ` (+${item.sources.length - 1} 个去重来源)` : ""}</div>
                  </div>
                  <div class="resource-right">
                    <div class="coverage-pills">${covHtml}</div>
                    <div class="resource-actions">
                      <button class="alma-btn alma-btn-outline alma-btn-sm" data-preview-res="${esc(item.id)}" type="button">${isExpanded ? "收起" : "预览"}</button>
                      <button class="alma-btn alma-btn-sm ${item.enabled ? "" : "alma-btn-primary"}" data-toggle-res="${esc(item.id)}" data-next-enabled="${!item.enabled}" type="button">${item.enabled ? "停用" : "启用"}</button>
                      ${canDelete ? `<button class="alma-btn alma-btn-danger alma-btn-sm" data-del-res="${esc(item.id)}" type="button">删除</button>` : ""}
                    </div>
                  </div>
                </div>
                ${isExpanded ? `<pre class="resource-preview-box">${esc(previewText)}</pre>` : ""}
              </div>`;
          })
          .join("");

  container.innerHTML = `
    <div class="panel-sec-head">
      <div class="panel-sec-title">各 Agent 的规则与技能</div>
      <div class="panel-sec-sub">规则全文按需注入缺失端 · 技能仅注入渐进索引 (~${items.filter((i) => i.kind === "skill").reduce((s, i) => s + i.indexTokens, 0)} tok)</div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>已启用共享资源</span><span>去重后</span></div>
        <div class="stat-card-value">${enabledRules} 规则 · ${enabledSkills} 技能</div>
        <div class="stat-card-meta"><span>总发现 ${items.length} 项</span><span>项目+全局</span></div>
      </div>
      ${budgetCards}
    </div>

    <div class="panel-sec-head">
      <div class="panel-sec-title">规则与技能清单</div>
      <div class="panel-sec-sub">${PANEL_STATE.syncNotice ? esc(PANEL_STATE.syncNotice) : ""}</div>
    </div>

    <div class="panel-toolbar">
      <div class="filter-pills">
        <button class="filter-pill ${PANEL_STATE.filter === "all" ? "active" : ""}" data-res-filter="all" type="button">全部 (${items.length})</button>
        <button class="filter-pill ${PANEL_STATE.filter === "global-rule" ? "active" : ""}" data-res-filter="global-rule" type="button">全局规则</button>
        <button class="filter-pill ${PANEL_STATE.filter === "project-rule" ? "active" : ""}" data-res-filter="project-rule" type="button">项目规则</button>
        <button class="filter-pill ${PANEL_STATE.filter === "skill" ? "active" : ""}" data-res-filter="skill" type="button">共享技能</button>
      </div>
      <div class="toolbar-right">
        <input id="resSearchInput" class="panel-search" type="search" placeholder="搜索规则/技能名称或路径..." value="${esc(PANEL_STATE.search)}" />
        <button id="toggleNewRuleBtn" class="alma-btn alma-btn-primary alma-btn-sm" type="button">+ 新建共享规则</button>
        <button id="syncProjectFilesBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button" title="显式将 Hub 共享规则块同步至项目根目录 AGENTS.md / CLAUDE.md">同步至项目文件</button>
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
  lastSignature: "",
  selectedId: null, // 明细浮窗当前对着的步骤
};

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

async function wfPost(path, body) {
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
  return data.workflow;
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

async function wfRunAction(groupId, action) {
  try {
    if (action === "save") await wfSave(groupId);
    else if (action === "run") {
      await wfSave(groupId);
      await wfPost("/api/workflows/run", { groupId });
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

// 流程图布局：按「离起点有几层依赖」分列，从左到右；同一列里自上而下排
const WF_NODE_W = 208;
const WF_NODE_H = 58;
const WF_COL_GAP = 64;
const WF_ROW_GAP = 14;
const WF_PAD = 16;

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
    ${live?.error && (running || showResults) ? `<div class="wf-error">${esc(live.error)}</div>` : ""}
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
  const draft = wfDraft(groupId);
  const agents = app.getEnabledAgents();

  // 浮窗里打字不触发重绘；只有结构或状态变了才重建
  const signature = [
    groupId,
    group.title,
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
  WF_STATE.lastSignature = signature;

  const steps = running ? server.steps : draft.steps;
  const serverById = new Map(server.steps.map((s) => [s.id, s]));
  const showResults = !running && !draft.dirty && (server.status === "completed" || server.status === "failed");
  const statusOf = (step) => (running || showResults ? serverById.get(step.id)?.status || "draft" : "draft");

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

  // 共享上下文：公共部分写一次，每一步都会带上；命名分区只给引用它的步骤
  const ctxDraft = wfContextDraft(groupId);
  const ctxResults = wfServerContext(groupId).sections.filter((sec) => sec.kind === "result");
  const refCount = (key) => steps.filter((st) => (st.contextRefs || []).includes(key)).length;
  const ctxSummary = [
    ctxDraft.common.trim() ? `公共 ${ctxDraft.common.trim().length} 字` : "还没有公共内容",
    ctxDraft.sections.length > 0 ? `${ctxDraft.sections.length} 个分区` : "",
    ctxResults.length > 0 ? `${ctxResults.length} 个步骤结果` : "",
    ctxDraft.dirty ? "未保存" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const ctxHtml = `
    <details class="wf-context" id="wfContextBox" ${WF_STATE.ctxOpen ? "open" : ""}>
      <summary><span>共享上下文</span><span class="ctx-faint">${esc(ctxSummary)}</span></summary>
      <div class="wf-context-body">
        <div class="wf-pop-block">
          <label>公共部分<span class="dirs-hint">每个子会话都会收到，写一次即可，不用在每一步里重复</span></label>
          <textarea class="rule-editor-textarea" id="wfCtxCommon" ${running ? "readonly" : ""} placeholder="目标、版本、约定、禁止事项、材料在哪……">${esc(ctxDraft.common)}</textarea>
        </div>
        ${ctxDraft.sections
          .map(
            (sec, i) => `
          <div class="wf-ctx-section">
            <div class="wf-ctx-section-head">
              <input class="text-input" data-ctx-field="key" data-ctx-index="${i}" value="${esc(sec.key)}" placeholder="分区名，如 user-mgmt" ${sec.saved || running ? "readonly" : ""} />
              <input class="text-input" data-ctx-field="summary" data-ctx-index="${i}" value="${esc(sec.summary)}" placeholder="一句话说明里面是什么" ${running ? "readonly" : ""} />
              <span class="ctx-faint">${refCount(sec.key.trim().toLowerCase())} 步引用</span>
              ${running ? "" : `<button type="button" class="mini-icon-btn" data-ctx-remove="${i}" title="删除这个分区">×</button>`}
            </div>
            <textarea class="rule-editor-textarea" data-ctx-field="content" data-ctx-index="${i}" ${running ? "readonly" : ""} placeholder="只有部分步骤需要的内容">${esc(sec.content)}</textarea>
          </div>`,
          )
          .join("")}
        ${
          ctxResults.length > 0
            ? `<div class="wf-deps"><span class="wf-deps-label">步骤结果（自动保存，下游步骤会收到）</span>${ctxResults
                .map((sec) => `<span class="origin-tag" title="${esc(sec.content.slice(0, 400))}">${esc(sec.summary || sec.key)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${
          running
            ? ""
            : `<div class="panel-toolbar">
                 <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfCtxAddBtn">添加分区</button>
                 <button type="button" class="alma-btn alma-btn-sm" id="wfCtxSaveBtn" ${ctxDraft.dirty ? "" : "disabled"}>保存上下文</button>
               </div>`
        }
      </div>
    </details>`;

  const layout = wfLayout(steps);
  const edges = [];
  for (const step of steps) {
    const to = layout.pos.get(step.id);
    for (const dep of step.dependsOn) {
      const from = layout.pos.get(dep);
      if (!from || !to) continue;
      const x1 = from.x + WF_NODE_W;
      const y1 = from.y + WF_NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + WF_NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const done = statusOf(steps.find((s) => s.id === dep)) === "completed";
      edges.push(
        `<path class="wf-edge${done ? " done" : ""}" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" marker-end="url(#wfArrow)" />`,
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
            <span class="wf-node-name">${esc(step.name || `步骤 ${index + 1}`)}</span>
          </span>
          <span class="wf-node-bottom">
            ${app.agentTagHtml ? app.agentTagHtml(step.agent) : esc(step.agent)}
            <span class="wf-node-status">${running || showResults ? esc(WF_STEP_STATUS_TEXT[status] || status) : step.prompt.trim() ? "" : "还没写任务"}</span>
          </span>
        </button>`;
    })
    .join("");

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
            : `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAddStepBtn">添加步骤</button>
               <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="wfAskLeadBtn" title="主导把目标拆成几步并存成草稿，不会直接执行">让 ${esc(group.leadAgent)} 起草</button>`
        }
      </div>
      <div style="display:flex;gap:8px">
        ${
          running
            ? `<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" id="wfCancelBtn">停止</button>`
            : `<button type="button" class="alma-btn alma-btn-sm" id="wfSaveBtn" ${steps.length === 0 ? "disabled" : ""}>保存草稿</button>
               <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" id="wfRunBtn" ${steps.length === 0 ? "disabled" : ""}>发布</button>`
        }
      </div>
    </div>
    ${ctxHtml}
    ${
      steps.length === 0
        ? `<div class="empty-note">还没有步骤。添加几步交给子会话的任务，设好先后顺序，再点「发布」；或者让 ${esc(group.leadAgent)} 先起草。<br />没有依赖关系的步骤会同时开始，后一步能拿到它所依赖步骤的结果。</div>`
        : `<div class="wf-canvas-wrap">
             <div class="wf-canvas" style="width:${layout.width}px;height:${layout.height}px">
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
  bind("wfCancelBtn", () => void wfRunAction(groupId, "cancel"));

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
    if (app.STATE.stageView === "resources") {
      const activeCwd = app.STATE.taskGroups.get(app.STATE.activeGroupId)?.cwd || "";
      if (app.STATE.resourcesList.length === 0 || PANEL_STATE.resourcesCwd !== activeCwd) {
        void fetchResources();
      } else {
        renderResourcesPanel();
      }
    } else if (app.STATE.stageView === "telemetry") {
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

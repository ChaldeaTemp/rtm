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
    const res = await fetch("/api/resources");
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
        <div class="stat-card-value">${b.nativeRules + b.bridgedRules}R / ${b.nativeSkills + b.bridgedSkills}S</div>
        <div class="stat-card-meta">
          <span>原生 ${b.nativeRules}规则 · ${b.nativeSkills}技能</span>
          <span>Hub注入 ${b.bridgedRules}规则 · ${b.bridgedSkills}技能</span>
        </div>
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
            <option value="project">作用域：当前项目 (.agent-hub)</option>
            <option value="global">作用域：全局 Hub (~/.agent-hub)</option>
          </select>
        </div>
        <textarea id="hubRuleContent" class="rule-editor-textarea" placeholder="# 规则标题&#10;&#10;在这里编写跨 ${esc(covAgents.join(" / "))} 共享的 Markdown 规则..."></textarea>
        <div class="panel-toolbar">
          <span class="mono" style="font-size:11px;color:var(--faint)">仅写入 .agent-hub 目录，不修改原生全局配置</span>
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
      <div class="panel-sec-title"><span class="num">01</span>/ 跨端覆盖矩阵与渐进式注入预算</div>
      <div class="panel-sec-sub">规则全文按需注入缺失端 · 技能仅注入渐进索引 (~${items.filter((i) => i.kind === "skill").reduce((s, i) => s + i.indexTokens, 0)} tok)</div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>已启用共享资源</span><span>去重后</span></div>
        <div class="stat-card-value">${enabledRules}R / ${enabledSkills}S</div>
        <div class="stat-card-meta"><span>总发现 ${items.length} 项</span><span>项目+全局</span></div>
      </div>
      ${budgetCards}
    </div>

    <div class="panel-sec-head">
      <div class="panel-sec-title"><span class="num">02</span>/ 共享规则与技能清单</div>
      <div class="panel-sec-sub">${PANEL_STATE.syncNotice ? esc(PANEL_STATE.syncNotice) : "非侵入模式：会话首轮自动桥接，不改写原生全局配置"}</div>
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

  const sessions = [...app.STATE.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const breakdownHtml =
    sessions.length === 0
      ? `<div class="empty-note">尚无活跃会话。在对话工作台发送消息后，这里会实时展示规则/技能/交接上下文注入构成与窗口占用。</div>`
      : sessions
          .map((sess) => {
            const cb = sess.contextBreakdown || {
              sharedRulesTokens: 0,
              skillsIndexTokens: 0,
              handoffTokens: 0,
              userPromptsTokens: 0,
              agentOutputsTokens: 0,
              injectedRules: [],
              injectedSkillsCount: 0,
            };
            const dialogTok = (cb.userPromptsTokens || 0) + (cb.agentOutputsTokens || 0);
            const sum = Math.max(
              1,
              (cb.sharedRulesTokens || 0) +
                (cb.skillsIndexTokens || 0) +
                (cb.handoffTokens || 0) +
                dialogTok,
            );
            const pRules = ((cb.sharedRulesTokens || 0) / sum) * 100;
            const pSkills = ((cb.skillsIndexTokens || 0) / sum) * 100;
            const pHandoff = ((cb.handoffTokens || 0) / sum) * 100;
            const pDialog = (dialogTok / sum) * 100;

            const grp = app.STATE.taskGroups.get(sess.groupId);
            const winMax = sess.usage?.maxTokens || 0;
            const winUsed = sess.usage?.usedTokens || 0;
            const winPct = winMax > 0 ? Math.min(100, Math.round((winUsed / winMax) * 100)) : 0;

            const ruleBadges = (cb.injectedRules || [])
              .map((r) => `<span class="origin-tag">${esc(r.name)} (~${r.tokens})</span>`)
              .join("");

            return `
              <div class="breakdown-card">
                <div class="breakdown-top">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="agent-tag" data-agent="${esc(sess.agent)}">${esc(sess.agent)}</span>
                    <strong>${esc(grp?.title || sess.groupId)}</strong>
                    <span class="origin-tag">${sess.role === "lead" ? "主导" : `子会话: ${esc(sess.label)}`}</span>
                    <span class="mono" style="font-size:11px;color:var(--faint)">${esc(sess.sessionKey)}</span>
                  </div>
                  <div class="mono" style="font-size:11.5px;color:var(--muted)">
                    累计 ${fmtTok(sess.tokenTotals?.totalTokens || 0)} tok (${sess.tokenTotals?.turns || 0} 轮)
                    ${winMax > 0 ? ` · 窗口 ${fmtTok(winUsed)} / ${fmtTok(winMax)} (${winPct}%)` : ""}
                  </div>
                </div>
                ${
                  winMax > 0
                    ? `<div class="window-meter" title="ACP 上下文窗口占用 ${winUsed} / ${winMax}"><div class="window-meter-fill" style="width:${winPct}%"></div></div>`
                    : ""
                }
                <div class="stacked-bar" title="上下文注入与对话内容构成">
                  <div class="seg-rules" style="width:${pRules.toFixed(2)}%"></div>
                  <div class="seg-skills" style="width:${pSkills.toFixed(2)}%"></div>
                  <div class="seg-handoff" style="width:${pHandoff.toFixed(2)}%"></div>
                  <div class="seg-dialog" style="width:${pDialog.toFixed(2)}%"></div>
                </div>
                <div class="legend-row">
                  <span><i class="legend-dot seg-rules"></i>共享规则 ${fmtTok(cb.sharedRulesTokens)} tok (${cb.injectedRules?.length || 0} 项)</span>
                  <span><i class="legend-dot seg-skills"></i>渐进技能索引 ${fmtTok(cb.skillsIndexTokens)} tok (${cb.injectedSkillsCount || 0} 项)</span>
                  <span><i class="legend-dot seg-handoff"></i>主导切换交接 ${fmtTok(cb.handoffTokens)} tok</span>
                  <span><i class="legend-dot seg-dialog"></i>对话输入输出 ${fmtTok(dialogTok)} tok</span>
                </div>
                ${ruleBadges ? `<div style="display:flex;flex-wrap:wrap;gap:5px">${ruleBadges}</div>` : ""}
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
                <td><span class="agent-tag" data-agent="${esc(t.agent)}">${esc(t.agent)}</span></td>
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
      <div class="panel-sec-title"><span class="num">01</span>/ 全局与三端 Token 消耗总览</div>
      <div class="panel-sec-sub">汇总真实 ACP 用量回报 (usage / quota) 与上下文窗口状态</div>
    </div>

    <div class="panel-grid-4">
      <div class="stat-card">
        <div class="stat-card-label"><span>Hub 累计总消耗</span><span>${totals.turns} 轮</span></div>
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
      <div class="panel-sec-title"><span class="num">02</span>/ 各会话上下文注入与构成拆解</div>
      <div class="panel-sec-sub">区分共享规则 · 渐进技能索引 · 切换交接摘要 · 对话内容</div>
    </div>

    <div class="session-breakdown-list">${breakdownHtml}</div>

    <div class="panel-sec-head">
      <div class="panel-sec-title"><span class="num">03</span>/ 逐轮 Token 消耗记录</div>
      <div class="panel-sec-sub">~ 前缀表示适配器未回报精确 usage 时的字符估算值</div>
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

if (app) {
  app.onStateChange = () => {
    if (app.STATE.stageView === "resources") {
      if (app.STATE.resourcesList.length === 0) {
        void fetchResources();
      } else {
        renderResourcesPanel();
      }
    } else if (app.STATE.stageView === "telemetry") {
      renderTelemetryPanel();
    }
  };
  app.onResourcesUpdated = () => {
    void fetchResources();
  };
  void fetchResources();
}

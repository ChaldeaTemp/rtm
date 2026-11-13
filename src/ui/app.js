const STATE = {
  defaultGroupId: "grp-default",
  baseCwd: "",
  permissionMode: "approve-all",
  agents: [],
  taskGroups: new Map(),
  sessions: new Map(),
  tasks: new Map(),
  pendingPermissions: new Map(),
  pendingQuestions: new Map(),
  artifacts: new Map(),
  messagesByStream: new Map(),
  activeGroupId: "grp-default",
  activeStreamKey: "lead:grp-default",
  sendingStreams: new Set(),
  newTaskLead: "claude",
  inspectorCollapsed: false,
  stageView: "chat",
  telemetry: null,
  resourceBudgets: [],
  resourcesList: [],
  logs: [],
};

const BUILTIN_FALLBACK_AGENTS = [
  { agent: "claude", label: "claude", color: "#b8542c", darkColor: "#ef936c", enabled: true, available: true, authReady: true },
  { agent: "codex", label: "codex", color: "#0d7148", darkColor: "#6fe0a0", enabled: true, available: true, authReady: true },
  { agent: "agy", label: "agy", color: "#2358a6", darkColor: "#7cb3ff", enabled: true, available: true, authReady: true },
  { agent: "opencode", label: "opencode", color: "#6d3fc0", darkColor: "#b896ff", enabled: true, available: true, authReady: true },
  { agent: "kimi", label: "kimi", color: "#0d7490", darkColor: "#5eead4", enabled: true, available: true, authReady: true },
];

const els = {
  workbench: document.getElementById("workbench"),
  wsDot: document.getElementById("wsDot"),
  wsText: document.getElementById("wsText"),
  cwdPill: document.getElementById("cwdPill"),
  toggleNewTaskBtn: document.getElementById("toggleNewTaskBtn"),
  quickLaunchRow: document.getElementById("quickLaunchRow"),
  newTaskPopover: document.getElementById("newTaskPopover"),
  newTaskTitleInput: document.getElementById("newTaskTitleInput"),
  newTaskAgents: document.getElementById("newTaskAgents"),
  cancelNewTaskBtn: document.getElementById("cancelNewTaskBtn"),
  groupCountBadge: document.getElementById("groupCountBadge"),
  groupList: document.getElementById("groupList"),
  adapterPills: document.getElementById("adapterPills"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  navResBadge: document.getElementById("navResBadge"),
  navTokBadge: document.getElementById("navTokBadge"),
  navAgentsBadge: document.getElementById("navAgentsBadge"),
  liveContextPill: document.getElementById("liveContextPill"),
  chatStageHeader: document.getElementById("chatStageHeader"),
  chatComposerWrap: document.getElementById("chatComposerWrap"),
  resourcesView: document.getElementById("resourcesView"),
  telemetryView: document.getElementById("telemetryView"),
  agentsView: document.getElementById("agentsView"),
  stageTaskTitle: document.getElementById("stageTaskTitle"),
  streamBadge: document.getElementById("streamBadge"),
  leadSwitcher: document.getElementById("leadSwitcher"),
  backToLeadBtn: document.getElementById("backToLeadBtn"),
  permSelect: document.getElementById("permSelect"),
  toggleInspectorBtn: document.getElementById("toggleInspectorBtn"),
  sessionTabs: document.getElementById("sessionTabs"),
  permBanner: document.getElementById("permBanner"),
  questionBanner: document.getElementById("questionBanner"),
  messages: document.getElementById("messages"),
  composerLabel: document.getElementById("composerLabel"),
  promptInput: document.getElementById("promptInput"),
  composerHint: document.getElementById("composerHint"),
  stopSessionBtn: document.getElementById("stopSessionBtn"),
  sendBtn: document.getElementById("sendBtn"),
  inspSessionCount: document.getElementById("inspSessionCount"),
  inspSessions: document.getElementById("inspSessions"),
  inspTaskCount: document.getElementById("inspTaskCount"),
  inspTasks: document.getElementById("inspTasks"),
  logFeed: document.getElementById("logFeed"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTokens(n) {
  const val = Number(n || 0);
  if (!Number.isFinite(val) || val <= 0) return "0";
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 10_000) return `${(val / 1_000).toFixed(1)}k`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(2)}k`;
  return String(Math.round(val));
}

function refreshHeaderMetrics() {
  const totalTok = STATE.telemetry?.totals?.totalTokens || 0;
  if (els.navTokBadge) {
    els.navTokBadge.textContent = formatTokens(totalTok);
  }
  if (els.navResBadge) {
    const count =
      STATE.resourcesList.length > 0
        ? STATE.resourcesList.filter((r) => r.enabled).length
        : STATE.resourceBudgets[0]
          ? STATE.resourceBudgets[0].nativeRules +
            STATE.resourceBudgets[0].bridgedRules +
            STATE.resourceBudgets[0].nativeSkills +
            STATE.resourceBudgets[0].bridgedSkills
          : 0;
    els.navResBadge.textContent = String(count);
  }
  if (els.liveContextPill) {
    const key = activeSessionKeyForCurrentView();
    const sess = key ? STATE.sessions.get(key) : null;
    if (sess && sess.usage && sess.usage.maxTokens) {
      const used = sess.usage.usedTokens || 0;
      const pct = Math.min(100, Math.round((used / sess.usage.maxTokens) * 100));
      els.liveContextPill.textContent = `上下文 ${formatTokens(used)} / ${formatTokens(sess.usage.maxTokens)} (${pct}%)`;
    } else if (sess && sess.contextBreakdown) {
      const inj =
        (sess.contextBreakdown.sharedRulesTokens || 0) +
        (sess.contextBreakdown.skillsIndexTokens || 0) +
        (sess.contextBreakdown.handoffTokens || 0);
      const sessTotal = sess.tokenTotals?.totalTokens || 0;
      els.liveContextPill.textContent = `注入 ${formatTokens(inj)} · 消耗 ${formatTokens(sessTotal)} tok`;
    } else {
      const group = getActiveGroup();
      const budget = group ? STATE.resourceBudgets.find((b) => b.agent === group.leadAgent) : null;
      els.liveContextPill.textContent = budget
        ? `首轮注入 ~${formatTokens(budget.firstTurnInjectionTokens)} tok`
        : "上下文 0 tok";
    }
  }
}

function getEnabledAgents() {
  const list = STATE.agents && STATE.agents.length > 0 ? STATE.agents : BUILTIN_FALLBACK_AGENTS;
  const enabled = list.filter((a) => a.enabled !== false);
  return enabled.length > 0 ? enabled : BUILTIN_FALLBACK_AGENTS;
}

function getAgentColorStyle(agentId) {
  const found = (STATE.agents || []).find((a) => a.agent === agentId);
  if (!found || !found.color) return "";
  const isBuiltinStyled =
    agentId === "claude" ||
    agentId === "codex" ||
    agentId === "agy" ||
    agentId === "opencode" ||
    agentId === "kimi";
  if (isBuiltinStyled) return "";
  const isDark = document.body.classList.contains("dark");
  const color = isDark && found.darkColor ? found.darkColor : found.color;
  return ` style="--agent-color:${escapeHtml(color)}"`;
}

function agentTagHtml(agentId, text) {
  const label = text ?? agentId;
  return `<span class="agent-tag" data-agent="${escapeHtml(agentId)}"${getAgentColorStyle(agentId)}>${escapeHtml(label)}</span>`;
}

function renderAgentControls() {
  const enabled = getEnabledAgents();
  if (!enabled.some((a) => a.agent === STATE.newTaskLead)) {
    STATE.newTaskLead = enabled[0]?.agent || "claude";
  }

  if (els.navAgentsBadge) {
    els.navAgentsBadge.textContent = String(enabled.length);
  }

  if (els.quickLaunchRow) {
    els.quickLaunchRow.innerHTML = "";
    for (const item of enabled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-btn";
      btn.dataset.quickLead = item.agent;
      btn.textContent = `+ ${item.agent}`;
      btn.title = item.label || item.agent;
      btn.onclick = () => {
        void createTaskGroup({ leadAgent: item.agent });
      };
      els.quickLaunchRow.appendChild(btn);
    }
  }

  if (els.newTaskAgents) {
    els.newTaskAgents.innerHTML = "";
    for (const item of enabled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `popover-agent-opt${item.agent === STATE.newTaskLead ? " active" : ""}`;
      btn.dataset.agent = item.agent;
      btn.textContent = item.agent;
      btn.onclick = () => {
        STATE.newTaskLead = item.agent;
        els.newTaskAgents
          .querySelectorAll(".popover-agent-opt")
          .forEach((b) => b.classList.toggle("active", b === btn));
      };
      els.newTaskAgents.appendChild(btn);
    }
  }

  if (els.leadSwitcher) {
    const activeLead = getActiveGroup()?.leadAgent;
    els.leadSwitcher.innerHTML = '<span class="lead-switch-label">主导</span>';
    for (const item of enabled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lead-pill${item.agent === activeLead ? " active" : ""}`;
      btn.dataset.agent = item.agent;
      btn.textContent = item.agent;
      btn.title = item.available ? `${item.label || item.agent} (就绪)` : `${item.label || item.agent}: ${item.reason || "未就绪"}`;
      btn.onclick = () => {
        const group = getActiveGroup();
        if (group) void switchGroupLead(group.groupId, item.agent);
      };
      els.leadSwitcher.appendChild(btn);
    }
  }

  if (els.adapterPills) {
    els.adapterPills.innerHTML = "";
    for (const item of enabled) {
      const pill = document.createElement("span");
      pill.className = "adapter-pill";
      pill.dataset.adapter = item.agent;
      pill.title = item.authReady
        ? `${item.agent}: 已就绪`
        : item.authHint || item.reason || `${item.agent}: 未就绪`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.dataset.authDot = item.agent;
      if (!item.available) dot.classList.add("down");
      else if (item.authReady) dot.classList.add("ready");
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(item.agent));
      els.adapterPills.appendChild(pill);
    }
  }
}

function setStageView(view) {
  STATE.stageView = view;
  const stageEl = document.querySelector("main.stage");
  if (stageEl) {
    stageEl.dataset.view = view;
  }
  const isChat = view === "chat";
  if (els.chatStageHeader) els.chatStageHeader.hidden = !isChat;
  if (els.sessionTabs) els.sessionTabs.hidden = !isChat || !shouldShowSessionTabs();
  if (els.permBanner) els.permBanner.hidden = !isChat || STATE.pendingPermissions.size === 0;
  if (els.questionBanner) els.questionBanner.hidden = !isChat || STATE.pendingQuestions.size === 0;
  if (els.messages) els.messages.hidden = !isChat;
  if (els.chatComposerWrap) els.chatComposerWrap.hidden = !isChat;
  if (els.resourcesView) els.resourcesView.hidden = view !== "resources";
  if (els.telemetryView) els.telemetryView.hidden = view !== "telemetry";
  if (els.agentsView) els.agentsView.hidden = view !== "agents";

  document.querySelectorAll(".mode-tab[data-stage-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.stageView === view);
  });

  if (isChat) {
    renderStageHeaderAndTabs();
    renderPermissions();
    window.HUB_INTERACTIVE?.renderQuestions?.();
  }
  refreshHeaderMetrics();
  window.HUB_APP?.onStateChange?.();
}

function shouldShowSessionTabs() {
  const group = getActiveGroup();
  return Boolean(group && getGroupSubSessions(group.groupId).length > 0);
}

function renderInlineMarkdown(escapedText) {
  let s = escapedText;
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `@@CSPAN${idx}@@`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|file:\/\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  s = s.replace(/@@CSPAN(\d+)@@/g, (_m, idx) => codeSpans[Number(idx)] || "");
  return s;
}

function buildInlinePreviewSrcdoc(lang, rawCode) {
  const isSvg = lang === "svg";
  const body = isSvg
    ? `<div style="display:flex;align-items:center;justify-content:center;min-height:180px;">${rawCode}</div>`
    : rawCode;
  if (!isSvg && /<html[\s>]/i.test(rawCode)) {
    return rawCode;
  }
  return `<!doctype html><html><head><meta charset="utf-8" /><style>*{box-sizing:border-box}body{margin:0;padding:12px;background:#f3f2ec;color:#151514;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.5}</style></head><body>${body}</body></html>`;
}

function renderMarkdown(raw) {
  const src = String(raw || "");
  if (!src.trim()) return "";

  const codeBlocks = [];
  const withPlaceholders = src.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const lowerLang = (lang || "").trim().toLowerCase();
    const cleanLang = escapeHtml(lang || "text");
    const rawCode = code.replace(/\n$/, "");
    const cleanCode = escapeHtml(rawCode);
    const canPreview = (lowerLang === "html" || lowerLang === "svg") && rawCode.trim().length > 0;
    if (canPreview) {
      const srcdocAttr = escapeHtml(buildInlinePreviewSrcdoc(lowerLang, rawCode));
      codeBlocks.push(
        `<div class="md-code-wrap"><div class="md-code-head"><span>${cleanLang} · 交互预览</span><div style="display:flex;gap:6px"><button type="button" class="copy-code-btn inline-preview-toggle active" data-toggle-inline-preview="${idx}">源码/预览</button><button type="button" class="copy-code-btn" data-copy-code="${idx}">复制</button></div></div><div class="inline-preview-box" data-inline-preview="${idx}"><iframe class="artifact-frame" sandbox="allow-scripts" style="height:260px" srcdoc="${srcdocAttr}"></iframe></div><pre hidden><code data-raw-code="${idx}">${cleanCode}</code></pre></div>`,
      );
    } else {
      codeBlocks.push(
        `<div class="md-code-wrap"><div class="md-code-head"><span>${cleanLang}</span><button type="button" class="copy-code-btn" data-copy-code="${idx}">复制</button></div><pre><code data-raw-code="${idx}">${cleanCode}</code></pre></div>`,
      );
    }
    return `\n@@CBLOCK${idx}@@\n`;
  });

  const blocks = withPlaceholders.split(/\r?\n\r?\n+/);
  const htmlParts = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const cblockMatch = trimmed.match(/^@@CBLOCK(\d+)@@$/);
    if (cblockMatch) {
      htmlParts.push(codeBlocks[Number(cblockMatch[1])] || "");
      continue;
    }

    const lines = trimmed.split(/\r?\n/);
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .map((l) => `<li>${renderInlineMarkdown(escapeHtml(l.replace(/^\s*[-*]\s+/, "")))}</li>`)
        .join("");
      htmlParts.push(`<ul>${items}</ul>`);
      continue;
    }

    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      const items = lines
        .map((l) => `<li>${renderInlineMarkdown(escapeHtml(l.replace(/^\s*\d+\.\s+/, "")))}</li>`)
        .join("");
      htmlParts.push(`<ol>${items}</ol>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch && lines.length === 1) {
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${renderInlineMarkdown(escapeHtml(headingMatch[2]))}</h${level}>`);
      continue;
    }

    const inlineHtml = lines
      .map((l) => {
        const m = l.trim().match(/^@@CBLOCK(\d+)@@$/);
        if (m) return codeBlocks[Number(m[1])] || "";
        return renderInlineMarkdown(escapeHtml(l));
      })
      .join("<br />");

    htmlParts.push(`<p>${inlineHtml}</p>`);
  }

  return htmlParts.join("");
}

function appendLog(line) {
  STATE.logs.push(`[${formatTime(Date.now())}] ${line}`);
  if (STATE.logs.length > 160) {
    STATE.logs.shift();
  }
  const el = document.createElement("div");
  el.className = "log-line";
  el.textContent = STATE.logs[STATE.logs.length - 1];
  els.logFeed.appendChild(el);
  while (els.logFeed.children.length > 160) {
    els.logFeed.removeChild(els.logFeed.firstChild);
  }
  els.logFeed.scrollTop = els.logFeed.scrollHeight;
}

function getActiveGroup() {
  return (
    STATE.taskGroups.get(STATE.activeGroupId) ||
    STATE.taskGroups.get(STATE.defaultGroupId) ||
    [...STATE.taskGroups.values()][0]
  );
}

function getGroupSessions(groupId) {
  return [...STATE.sessions.values()]
    .filter((s) => s.groupId === groupId)
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "lead" ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
}

function getGroupSubSessions(groupId) {
  return getGroupSessions(groupId).filter((s) => s.role === "sub");
}

function getGroupTasks(groupId) {
  return [...STATE.tasks.values()]
    .filter((t) => t.groupId === groupId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function isGroupBusy(groupId) {
  for (const s of STATE.sessions.values()) {
    if (s.groupId === groupId && (s.status === "busy" || s.status === "starting")) {
      return true;
    }
  }
  return STATE.sendingStreams.has(`lead:${groupId}`);
}

function isSubStream(streamKey) {
  return typeof streamKey === "string" && streamKey.startsWith("sub:");
}

function activeSessionKeyForCurrentView() {
  const group = getActiveGroup();
  if (!group) return null;
  if (isSubStream(STATE.activeStreamKey)) {
    return STATE.activeStreamKey.slice(4);
  }
  const leadSession = [...STATE.sessions.values()].find(
    (s) => s.groupId === group.groupId && s.role === "lead" && s.agent === group.leadAgent,
  );
  return leadSession?.sessionKey || `${group.leadAgent}:${group.groupId}__lead`;
}

function selectGroup(groupId, streamKey) {
  const group = STATE.taskGroups.get(groupId);
  if (!group) return;
  STATE.activeGroupId = groupId;
  STATE.activeStreamKey = streamKey || `lead:${groupId}`;
  if (STATE.stageView !== "chat") {
    setStageView("chat");
  }
  renderAll();
  els.promptInput.focus();
}

function upsertMessageRecord(msg) {
  const list = STATE.messagesByStream.get(msg.streamKey) || [];
  const idx = list.findIndex((m) => m.messageId === msg.messageId);
  if (idx >= 0) {
    list[idx] = msg;
  } else {
    list.push(msg);
  }
  STATE.messagesByStream.set(msg.streamKey, list);
}

function findMessageById(streamKey, messageId) {
  if (!streamKey || !messageId) return null;
  const list = STATE.messagesByStream.get(streamKey);
  if (!list) return null;
  return list.find((m) => m.messageId === messageId) || null;
}

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  els.themeToggleBtn.textContent = dark ? "浅色" : "深色";
  try {
    localStorage.setItem("agent-hub-theme", dark ? "dark" : "light");
  } catch {
    // ignore storage failures
  }
}

async function createTaskGroup(opts = {}) {
  const res = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    appendLog(`创建任务失败: ${data.error || res.status}`);
    return;
  }
  STATE.taskGroups.set(data.group.groupId, data.group);
  selectGroup(data.group.groupId, `lead:${data.group.groupId}`);
}

async function renameTaskGroup(group) {
  const next = window.prompt("重命名任务分组：", group.title);
  if (!next || !next.trim() || next.trim() === group.title) return;
  await fetch("/api/groups/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: group.groupId, title: next.trim() }),
  });
}

async function deleteTaskGroup(group) {
  if (!window.confirm(`确认删除任务「${group.title}」并关闭其下的所有会话？`)) return;
  await fetch("/api/groups/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: group.groupId }),
  });
}

async function switchGroupLead(groupId, agent) {
  await fetch("/api/lead", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId, agent }),
  });
}

async function cancelSession(sessionKey) {
  if (!sessionKey) return;
  await fetch("/api/peer/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey }),
  });
}

function renderSidebarGroups() {
  const groups = [...STATE.taskGroups.values()].sort((a, b) => a.createdAt - b.createdAt);
  els.groupCountBadge.textContent = String(groups.length);
  els.groupList.innerHTML = "";

  for (const group of groups) {
    const isActiveGroup = group.groupId === STATE.activeGroupId;
    const subs = getGroupSubSessions(group.groupId);
    const groupTasks = getGroupTasks(group.groupId);
    const busy = isGroupBusy(group.groupId);

    const card = document.createElement("div");
    card.className = `group-card${isActiveGroup ? " active" : ""}`;
    card.onclick = () => selectGroup(group.groupId, `lead:${group.groupId}`);

    const top = document.createElement("div");
    top.className = "group-row-top";

    const titleWrap = document.createElement("div");
    titleWrap.className = "group-title-wrap";
    const statusDot = document.createElement("span");
    statusDot.className = `dot ${busy ? "busy" : "idle"}`;
    const titleEl = document.createElement("span");
    titleEl.className = "group-title";
    titleEl.textContent = group.title;
    titleWrap.appendChild(statusDot);
    titleWrap.appendChild(titleEl);

    const actions = document.createElement("div");
    actions.className = "group-actions";
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "mini-icon-btn";
    renameBtn.title = "重命名任务";
    renameBtn.textContent = "改";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      void renameTaskGroup(group);
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "mini-icon-btn del";
    delBtn.title = "删除任务";
    delBtn.textContent = "删";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      void deleteTaskGroup(group);
    };
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    top.appendChild(titleWrap);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "group-meta";
    meta.innerHTML = `
      ${agentTagHtml(group.leadAgent, `★ ${group.leadAgent}`)}
      <span>${subs.length} 子会话 · ${groupTasks.length} 委派</span>
    `;

    card.appendChild(top);
    card.appendChild(meta);

    if (subs.length > 0 || isActiveGroup) {
      const tree = document.createElement("div");
      tree.className = "session-tree";

      const leadStreamKey = `lead:${group.groupId}`;
      const leadNode = document.createElement("div");
      leadNode.className = `tree-node${STATE.activeStreamKey === leadStreamKey ? " active" : ""}`;
      leadNode.innerHTML = `
        <span class="tree-node-left">
          <span class="dot ${busy ? "busy" : "idle"}"></span>
          <span class="tree-node-label">★ 主导 · ${escapeHtml(group.leadAgent)}</span>
        </span>
      `;
      leadNode.onclick = (e) => {
        e.stopPropagation();
        selectGroup(group.groupId, leadStreamKey);
      };
      tree.appendChild(leadNode);

      for (const sub of subs) {
        const subStreamKey = `sub:${sub.sessionKey}`;
        const subNode = document.createElement("div");
        subNode.className = `tree-node${STATE.activeStreamKey === subStreamKey ? " active" : ""}`;
        subNode.title = sub.sessionKey;
        subNode.innerHTML = `
          <span class="tree-node-left">
            <span class="dot ${escapeHtml(sub.status)}"></span>
            <span class="tree-node-label">↳ ${escapeHtml(sub.agent)} · ${escapeHtml(sub.label || sub.name)}</span>
          </span>
          ${sub.isWorktree ? '<span class="wt-pill">wt</span>' : ""}
        `;
        subNode.onclick = (e) => {
          e.stopPropagation();
          selectGroup(group.groupId, subStreamKey);
        };
        tree.appendChild(subNode);
      }

      card.appendChild(tree);
    }

    els.groupList.appendChild(card);
  }
}

function renderStageHeaderAndTabs() {
  const group = getActiveGroup();
  if (!group) return;

  const subMode = isSubStream(STATE.activeStreamKey);
  const subSessionKey = subMode ? STATE.activeStreamKey.slice(4) : null;
  const subSession = subSessionKey ? STATE.sessions.get(subSessionKey) : null;

  els.stageTaskTitle.textContent = group.title;
  if (subMode && subSession) {
    els.streamBadge.textContent = `子会话 · ${subSession.agent} (${subSession.label || subSession.name})`;
    els.streamBadge.className = "stream-badge sub";
    els.leadSwitcher.hidden = true;
    els.backToLeadBtn.hidden = false;
    els.composerLabel.textContent = `直连子会话 · ${subSession.agent}:${subSession.label || subSession.name}`;
    els.composerHint.textContent = "可直接向该子会话追加追问，不会污染任务主对话上下文";
    els.promptInput.placeholder = `向子会话 ${subSession.agent} (${subSession.label || subSession.name}) 发送跟进消息...`;
  } else {
    els.streamBadge.textContent = `主导会话 · ${group.leadAgent}`;
    els.streamBadge.className = "stream-badge";
    els.leadSwitcher.hidden = false;
    els.backToLeadBtn.hidden = true;
    els.composerLabel.textContent = `${group.title} · 主导 ${group.leadAgent}`;
    els.composerHint.textContent = `当前任务独立由 ${group.leadAgent} 主导，可随时切换或与其他任务并行执行`;
    els.promptInput.placeholder = `向任务「${group.title}」主导 Agent（${group.leadAgent}）发送指令，Enter 发送...`;
  }

  document.querySelectorAll("#leadSwitcher .lead-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.agent === group.leadAgent);
  });

  // Sub-session tab bar
  const subs = getGroupSubSessions(group.groupId);
  if (subs.length === 0) {
    els.sessionTabs.hidden = true;
    els.sessionTabs.innerHTML = "";
  } else {
    els.sessionTabs.hidden = false;
    els.sessionTabs.innerHTML = "";
    const leadStreamKey = `lead:${group.groupId}`;
    const leadTab = document.createElement("button");
    leadTab.type = "button";
    leadTab.className = `session-tab${STATE.activeStreamKey === leadStreamKey ? " active" : ""}`;
    leadTab.innerHTML = `<span class="dot ${isGroupBusy(group.groupId) ? "busy" : "idle"}"></span>★ 主导 (${escapeHtml(group.leadAgent)})`;
    leadTab.onclick = () => selectGroup(group.groupId, leadStreamKey);
    els.sessionTabs.appendChild(leadTab);

    for (const sub of subs) {
      const key = `sub:${sub.sessionKey}`;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `session-tab${STATE.activeStreamKey === key ? " active" : ""}`;
      tab.title = sub.sessionKey;
      tab.innerHTML = `<span class="dot ${escapeHtml(sub.status)}"></span>↳ ${escapeHtml(sub.agent)} · ${escapeHtml(sub.label || sub.name)}${sub.isWorktree ? " [wt]" : ""}`;
      tab.onclick = () => selectGroup(group.groupId, key);
      els.sessionTabs.appendChild(tab);
    }
  }

  const activeKey = activeSessionKeyForCurrentView();
  const activeSess = activeKey ? STATE.sessions.get(activeKey) : null;
  const isBusy =
    STATE.sendingStreams.has(STATE.activeStreamKey) ||
    activeSess?.status === "busy" ||
    activeSess?.status === "starting";
  els.sendBtn.disabled = STATE.sendingStreams.has(STATE.activeStreamKey);
  els.sendBtn.textContent = STATE.sendingStreams.has(STATE.activeStreamKey) ? "执行中..." : "发送 ↵";
  els.stopSessionBtn.hidden = !isBusy;
}

function renderPermissions() {
  const items = [...STATE.pendingPermissions.values()];
  if (items.length === 0) {
    els.permBanner.hidden = true;
    els.permBanner.innerHTML = "";
    return;
  }
  els.permBanner.hidden = false;
  els.permBanner.innerHTML = "";

  for (const p of items) {
    const sess = STATE.sessions.get(p.sessionKey);
    const grp = sess ? STATE.taskGroups.get(sess.groupId) : null;
    const row = document.createElement("div");
    row.className = "perm-row";
    row.innerHTML = `
      <div>
        <strong class="mono">[需要确认]</strong>
        ${grp ? `<span class="mono">${escapeHtml(grp.title)}</span> · ` : ""}
        <span class="agent-tag" data-agent="${escapeHtml(p.agent)}">${escapeHtml(p.sessionKey)}</span>
        请求执行：<strong>${escapeHtml(p.toolTitle)}</strong>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "perm-actions";
    const allowOpt = p.options.find((o) => o.kind.startsWith("allow")) || p.options[0];
    const rejectOpt = p.options.find((o) => o.kind.startsWith("reject"));

    const allowBtn = document.createElement("button");
    allowBtn.type = "button";
    allowBtn.className = "alma-btn alma-btn-primary alma-btn-sm";
    allowBtn.textContent = allowOpt ? allowOpt.name : "允许";
    allowBtn.onclick = () => resolvePerm(p.requestId, allowOpt ? allowOpt.optionId : "cancel");
    actions.appendChild(allowBtn);

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
    denyBtn.textContent = rejectOpt ? rejectOpt.name : "拒绝";
    denyBtn.onclick = () => resolvePerm(p.requestId, rejectOpt ? rejectOpt.optionId : "cancel");
    actions.appendChild(denyBtn);

    row.appendChild(actions);
    els.permBanner.appendChild(row);
  }
}

async function resolvePerm(requestId, optionId) {
  await fetch("/api/permissions/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, optionId }),
  });
}

function renderEmptyStage(group) {
  const box = document.createElement("div");
  box.className = "alma-box empty-stage";
  box.innerHTML = `
    <span class="alma-box-label">workspace ready</span>
    <span class="alma-box-corner-tl">+</span>
    <span class="alma-box-corner-tr">+</span>
    <span class="alma-box-corner-bl">+</span>
    <span class="alma-box-corner-br">+</span>
    <div class="empty-inner">
      <h2>任务「${escapeHtml(group?.title || "任务 1")}」就绪 · 主导 ${escapeHtml(group?.leadAgent || "claude")}</h2>
      <p>每个任务拥有独立的主导 Agent 与上下文账本；你可以随时新建多个并行任务，查看委派子会话，或在对话中让 Agent 渲染交互式 HTML 组件。</p>
      <div class="starter-list">
        <button type="button" class="starter-btn" data-starter="列出当前项目目录核心文件，并委派 codex 检查主要入口逻辑是否存在边界问题">
          <span>列出项目核心文件，并委派 codex 协同审查边界问题</span>
          <span class="arrow">→</span>
        </button>
        <button type="button" class="starter-btn" data-starter="调用 peer_list_agents 查看当前已接入的本地 Agent（含 claude / codex / agy / opencode / kimi），并汇总状态报告">
          <span>查看多 Agent（claude / codex / agy / opencode / kimi）接入状态</span>
          <span class="arrow">→</span>
        </button>
        <button type="button" class="starter-btn" data-starter="调用 ui_render_artifact 生成一个交互式的项目模块结构与 Token 消耗估算看板（HTML）">
          <span>让 Agent 直接渲染可交互 HTML 组件卡片</span>
          <span class="arrow">→</span>
        </button>
      </div>
    </div>
  `;
  box.querySelectorAll("[data-starter]").forEach((btn) => {
    btn.onclick = () => {
      els.promptInput.value = btn.getAttribute("data-starter") || "";
      els.promptInput.focus();
    };
  });
  return box;
}

function matchTasksForAssistantMessage(msg, nextAssistantTimestamp) {
  if (msg.role !== "assistant" || isSubStream(msg.streamKey)) return [];
  const start = msg.timestamp - 500;
  const end = msg.completedAt ? msg.completedAt + 1500 : nextAssistantTimestamp || Number.MAX_SAFE_INTEGER;
  return getGroupTasks(msg.groupId).filter(
    (t) => t.createdAt >= start && t.createdAt <= end,
  );
}

function buildArtifactCardElement(artifact) {
  const card = document.createElement("div");
  card.className = "artifact-card";
  const url = `/artifacts/${encodeURIComponent(artifact.artifactId)}`;
  const initialHeight = Math.max(160, Math.min(780, Number(artifact.height) || 320));
  card.innerHTML = `
    <div class="artifact-head">
      <div class="artifact-title">
        <span class="artifact-kind">${escapeHtml(artifact.kind)}</span>
        <span title="${escapeHtml(artifact.title)}">${escapeHtml(artifact.title)}</span>
      </div>
      <div class="artifact-actions">
        <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-art-reload>刷新</button>
        <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-art-open>独立窗口 ↗</button>
      </div>
    </div>
    <iframe
      class="artifact-frame"
      data-artifact-frame="${escapeHtml(artifact.artifactId)}"
      sandbox="allow-scripts"
      src="${url}"
      style="height:${initialHeight}px"
    ></iframe>
  `;
  const frame = card.querySelector("iframe");
  card.querySelector("[data-art-reload]").onclick = () => {
    if (frame) frame.src = `${url}?t=${Date.now()}`;
  };
  card.querySelector("[data-art-open]").onclick = () => {
    window.open(url, "_blank", "noopener");
  };
  return card;
}

function buildMessageElement(msg, linkedTasks) {
  const entry = document.createElement("div");
  entry.className = `msg-entry role-${msg.role}`;
  entry.dataset.messageId = msg.messageId;

  if (msg.role === "system") {
    const div = document.createElement("div");
    div.className = "system-divider";
    div.textContent = msg.text;
    entry.appendChild(div);
    return entry;
  }

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (msg.agent) {
    let usageHtml = "";
    if (msg.usage && (msg.usage.totalTokens > 0 || msg.usage.inputTokens > 0)) {
      const estMark = msg.usage.isEstimated ? "~" : "";
      const cachePart =
        msg.usage.cachedReadTokens > 0
          ? ` · 缓存 ${formatTokens(msg.usage.cachedReadTokens)}`
          : "";
      const injPart =
        msg.injectedTokens && msg.injectedTokens > 0
          ? ` · 首轮注入 +${formatTokens(msg.injectedTokens)}`
          : "";
      usageHtml = `<span class="msg-usage-pill" title="输入 ${msg.usage.inputTokens} / 缓存 ${msg.usage.cachedReadTokens} / 输出 ${msg.usage.outputTokens} / 思考 ${msg.usage.thoughtTokens}">${estMark}↑${formatTokens(msg.usage.inputTokens)} ↓${formatTokens(msg.usage.outputTokens)}${cachePart}${injPart}</span>`;
    }
    meta.innerHTML = `${agentTagHtml(msg.agent, msg.senderLabel)}<span>${formatTime(msg.timestamp)}</span>${usageHtml}`;
  } else {
    meta.textContent = `${msg.senderLabel} · ${formatTime(msg.timestamp)}`;
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.role === "assistant") {
    if (msg.thoughtText && msg.thoughtText.trim()) {
      const details = document.createElement("details");
      details.className = "thought-box";
      details.innerHTML = `<summary>思考过程</summary><div class="thought-body">${escapeHtml(msg.thoughtText)}</div>`;
      bubble.appendChild(details);
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const strip = document.createElement("div");
      strip.className = "tool-strip";
      for (const tool of msg.toolCalls) {
        const chip = document.createElement("span");
        const isPeer = tool.title.includes("peer_") || tool.title.includes("peer");
        chip.className = `tool-chip${isPeer ? " peer-link" : ""}`;
        chip.textContent = `${tool.title}${tool.status ? ` · ${tool.status}` : ""}`;
        strip.appendChild(chip);
      }
      bubble.appendChild(strip);
    }

    const artifactList = Array.isArray(msg.artifactIds)
      ? msg.artifactIds.map((id) => STATE.artifacts.get(id)).filter(Boolean)
      : [];

    const body = document.createElement("div");
    body.className = "md-body";
    if (msg.text && msg.text.trim()) {
      body.innerHTML = renderMarkdown(msg.text);
      bubble.appendChild(body);
    } else if (msg.status === "streaming") {
      body.innerHTML = '<span class="mono" style="color:var(--faint)">思考并生成中...</span>';
      bubble.appendChild(body);
    } else if (artifactList.length === 0) {
      body.innerHTML = '<span class="mono" style="color:var(--faint)">(空回复)</span>';
      bubble.appendChild(body);
    }

    for (const art of artifactList) {
      bubble.appendChild(buildArtifactCardElement(art));
    }

    if (linkedTasks.length > 0) {
      const delWrap = document.createElement("div");
      delWrap.className = "delegation-strip";
      for (const task of linkedTasks) {
        const subSess = STATE.sessions.get(task.targetSessionKey);
        const label = subSess?.label || task.targetSessionKey.split("__sub__")[1] || task.targetSessionKey;
        const card = document.createElement("div");
        card.className = "delegation-card";
        card.innerHTML = `
          <div class="delegation-info">
            <span class="dot ${escapeHtml(task.status)}"></span>
            ${agentTagHtml(task.targetAgent)}
            <span class="mono">子会话: ${escapeHtml(label)}</span>
            <span class="mono" style="color:var(--faint)">[${escapeHtml(task.status)}]</span>
          </div>
        `;
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "alma-btn alma-btn-outline alma-btn-sm";
        openBtn.textContent = "查看子会话 →";
        openBtn.onclick = () => selectGroup(task.groupId, `sub:${task.targetSessionKey}`);
        card.appendChild(openBtn);
        delWrap.appendChild(card);
      }
      bubble.appendChild(delWrap);
    }
  } else {
    const pre = document.createElement("div");
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = msg.text;
    bubble.appendChild(pre);
  }

  entry.appendChild(meta);
  entry.appendChild(bubble);
  return entry;
}

function renderMessages() {
  const group = getActiveGroup();
  const list = STATE.messagesByStream.get(STATE.activeStreamKey) || [];
  els.messages.innerHTML = "";

  if (list.length === 0) {
    if (!isSubStream(STATE.activeStreamKey)) {
      els.messages.appendChild(renderEmptyStage(group));
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-stage alma-box";
      empty.innerHTML = `
        <span class="alma-box-label">sub-session</span>
        <div class="empty-inner">
          <h2>子会话尚无消息记录</h2>
          <p>该子会话被委派或发送消息后，完整工具调用与对话轨迹会实时显示在此处。</p>
        </div>
      `;
      els.messages.appendChild(empty);
    }
    return;
  }

  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    const nextAssistant = list.slice(i + 1).find((m) => m.role === "assistant");
    const linkedTasks = matchTasksForAssistantMessage(msg, nextAssistant?.timestamp);
    els.messages.appendChild(buildMessageElement(msg, linkedTasks));
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderInspector() {
  const group = getActiveGroup();
  if (!group) return;

  const sessions = getGroupSessions(group.groupId);
  els.inspSessionCount.textContent = String(sessions.length);
  els.inspSessions.innerHTML = "";

  if (sessions.length === 0) {
    const p = document.createElement("div");
    p.className = "insp-sub";
    p.textContent = "发送首条指令后将按需拉起主导 ACP 进程";
    els.inspSessions.appendChild(p);
  } else {
    for (const s of sessions) {
      const targetStream = s.role === "lead" ? `lead:${s.groupId}` : `sub:${s.sessionKey}`;
      const card = document.createElement("div");
      card.className = `insp-card${STATE.activeStreamKey === targetStream ? " active" : ""}`;
      const usageText =
        s.usage && typeof s.usage.usedTokens === "number"
          ? `tokens=${s.usage.usedTokens}${s.usage.maxTokens ? `/${s.usage.maxTokens}` : ""}`
          : "";
      card.innerHTML = `
        <div class="insp-row">
          <span class="mono" style="font-weight:600;display:inline-flex;align-items:center;gap:6px">
            <span class="dot ${escapeHtml(s.status)}"></span>
            ${s.role === "lead" ? "★ 主导" : "↳ 子会话"} · ${escapeHtml(s.agent)}
          </span>
          <span class="mono" style="font-size:11px;color:var(--faint)">${escapeHtml(s.status)}</span>
        </div>
        <div class="insp-sub" title="${escapeHtml(s.sessionKey)}">${escapeHtml(s.label || s.name)}${s.pid ? ` · pid=${s.pid}` : ""}</div>
        ${s.branch ? `<div class="insp-sub">branch: ${escapeHtml(s.branch)}</div>` : ""}
        ${usageText ? `<div class="insp-sub">${escapeHtml(usageText)}</div>` : ""}
      `;
      const rowActions = document.createElement("div");
      rowActions.className = "insp-row";
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "alma-btn alma-btn-outline alma-btn-sm";
      viewBtn.textContent = "查看对话";
      viewBtn.onclick = () => selectGroup(group.groupId, targetStream);
      rowActions.appendChild(viewBtn);

      if (s.status === "busy" || s.status === "starting") {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
        cancelBtn.textContent = "取消";
        cancelBtn.onclick = () => void cancelSession(s.sessionKey);
        rowActions.appendChild(cancelBtn);
      }
      card.appendChild(rowActions);
      els.inspSessions.appendChild(card);
    }
  }

  const tasks = getGroupTasks(group.groupId);
  els.inspTaskCount.textContent = String(tasks.length);
  els.inspTasks.innerHTML = "";

  if (tasks.length === 0) {
    const p = document.createElement("div");
    p.className = "insp-sub";
    p.textContent = "暂无 peer_ask / peer_dispatch 委派";
    els.inspTasks.appendChild(p);
  } else {
    for (const t of tasks) {
      const card = document.createElement("div");
      card.className = "insp-card";
      card.innerHTML = `
        <div class="insp-row">
          <span class="mono" style="display:inline-flex;align-items:center;gap:6px">
            <span class="dot ${escapeHtml(t.status)}"></span>
            ${escapeHtml(t.callerAgent)} → ${escapeHtml(t.targetAgent)}
          </span>
          <span class="mono" style="font-size:11px;color:var(--faint)">${escapeHtml(t.status)}</span>
        </div>
        <div class="insp-preview">${escapeHtml(t.prompt)}</div>
        ${t.branch ? `<div class="insp-sub">worktree: ${escapeHtml(t.branch)}</div>` : ""}
      `;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "alma-btn alma-btn-outline alma-btn-sm";
      btn.textContent = "打开子会话 →";
      btn.onclick = () => selectGroup(t.groupId, `sub:${t.targetSessionKey}`);
      card.appendChild(btn);
      els.inspTasks.appendChild(card);
    }
  }
}

function renderAll() {
  if (!STATE.taskGroups.has(STATE.activeGroupId)) {
    STATE.activeGroupId = STATE.defaultGroupId;
    STATE.activeStreamKey = `lead:${STATE.defaultGroupId}`;
  }
  renderAgentControls();
  renderSidebarGroups();
  renderStageHeaderAndTabs();
  renderPermissions();
  renderMessages();
  renderInspector();
  refreshHeaderMetrics();
  window.HUB_INTERACTIVE?.renderQuestions?.();
  window.HUB_APP?.onStateChange?.();
}

function updateStreamingMessageDom(msg) {
  if (msg.streamKey !== STATE.activeStreamKey) {
    return;
  }
  const existing = els.messages.querySelector(`[data-message-id="${CSS.escape(msg.messageId)}"]`);
  if (!existing) {
    renderMessages();
    return;
  }
  const list = STATE.messagesByStream.get(msg.streamKey) || [];
  const idx = list.findIndex((m) => m.messageId === msg.messageId);
  const nextAssistant = idx >= 0 ? list.slice(idx + 1).find((m) => m.role === "assistant") : undefined;
  const linkedTasks = matchTasksForAssistantMessage(msg, nextAssistant?.timestamp);
  const fresh = buildMessageElement(msg, linkedTasks);
  existing.replaceWith(fresh);
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function sendPrompt() {
  const prompt = els.promptInput.value.trim();
  const group = getActiveGroup();
  if (!prompt || !group) return;

  const targetStreamKey = STATE.activeStreamKey;
  if (STATE.sendingStreams.has(targetStreamKey)) {
    return;
  }

  const subMode = isSubStream(targetStreamKey);
  const targetSessionKey = subMode ? targetStreamKey.slice(4) : null;

  els.promptInput.value = "";
  els.promptInput.style.height = "auto";
  STATE.sendingStreams.add(targetStreamKey);
  renderStageHeaderAndTabs();
  renderSidebarGroups();

  try {
    const endpoint = subMode ? "/api/sessions/chat" : "/api/chat";
    const payload = subMode
      ? { sessionKey: targetSessionKey, prompt }
      : { groupId: group.groupId, prompt };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      appendLog(`发送失败 [${targetStreamKey}]: ${data.error || res.status}`);
    }
  } catch (err) {
    appendLog(`网络错误 [${targetStreamKey}]: ${err.message}`);
  } finally {
    STATE.sendingStreams.delete(targetStreamKey);
    renderStageHeaderAndTabs();
    renderSidebarGroups();
    els.promptInput.focus();
  }
}

async function loadAdapterHealth() {
  try {
    const res = await fetch("/api/agents");
    const data = await res.json();
    if (Array.isArray(data.agents)) {
      STATE.agents = data.agents;
      renderAgentControls();
      return;
    }
  } catch {
    // fallback to /api/health
  }
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const list = Array.isArray(data.allAgents) ? data.allAgents : data.adapters;
    if (Array.isArray(list)) {
      STATE.agents = list;
      renderAgentControls();
    }
  } catch {
    // ignore transient error
  }
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    els.wsDot.classList.add("ok");
    els.wsText.textContent = "live";
    appendLog("WebSocket 已连接");
  };
  ws.onclose = () => {
    els.wsDot.classList.remove("ok");
    els.wsText.textContent = "retrying";
    appendLog("WebSocket 断开，正在重连...");
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "snapshot") {
      STATE.defaultGroupId = msg.defaultGroupId || "grp-default";
      STATE.baseCwd = msg.baseCwd || "";
      STATE.permissionMode = msg.permissionMode || "approve-all";
      els.permSelect.value = STATE.permissionMode;
      els.cwdPill.textContent = STATE.baseCwd;
      els.cwdPill.title = STATE.baseCwd;

      STATE.taskGroups.clear();
      (msg.taskGroups || []).forEach((g) => STATE.taskGroups.set(g.groupId, g));
      if (!STATE.taskGroups.has(STATE.activeGroupId)) {
        STATE.activeGroupId = STATE.defaultGroupId;
        STATE.activeStreamKey = `lead:${STATE.defaultGroupId}`;
      }

      STATE.sessions.clear();
      (msg.sessions || []).forEach((s) => STATE.sessions.set(s.sessionKey, s));

      STATE.tasks.clear();
      (msg.tasks || []).forEach((t) => STATE.tasks.set(t.taskId, t));

      STATE.pendingPermissions.clear();
      (msg.pendingPermissions || []).forEach((p) => STATE.pendingPermissions.set(p.requestId, p));

      STATE.pendingQuestions.clear();
      (msg.pendingQuestions || []).forEach((q) => STATE.pendingQuestions.set(q.questionId, q));

      STATE.artifacts.clear();
      (msg.artifacts || []).forEach((a) => STATE.artifacts.set(a.artifactId, a));

      STATE.messagesByStream.clear();
      (msg.messages || []).forEach((m) => upsertMessageRecord(m));

      if (Array.isArray(msg.agents) && msg.agents.length > 0) {
        STATE.agents = msg.agents;
      }
      STATE.telemetry = msg.telemetry || null;
      STATE.resourceBudgets = msg.resourceBudgets || [];

      renderAll();
    } else if (msg.type === "agents_updated") {
      STATE.agents = msg.agents || [];
      renderAgentControls();
      renderSidebarGroups();
      renderStageHeaderAndTabs();
      window.HUB_INTERACTIVE?.onAgentsUpdated?.();
      window.HUB_APP?.onStateChange?.();
    } else if (msg.type === "artifact_created") {
      if (msg.artifact) {
        STATE.artifacts.set(msg.artifact.artifactId, msg.artifact);
        if (msg.artifact.groupId === STATE.activeGroupId) {
          renderMessages();
        }
        appendLog(`生成交互组件: ${msg.artifact.title} (${msg.artifact.kind})`);
      }
    } else if (msg.type === "question_requested") {
      if (msg.question) {
        STATE.pendingQuestions.set(msg.question.questionId, msg.question);
        window.HUB_INTERACTIVE?.renderQuestions?.();
        appendLog(`待确认问题: ${msg.question.title}`);
      }
    } else if (msg.type === "question_resolved") {
      STATE.pendingQuestions.delete(msg.questionId);
      window.HUB_INTERACTIVE?.renderQuestions?.();
      appendLog(msg.cancelled ? `已取消问题 ${msg.questionId}` : `已提交问题回答 ${msg.questionId}`);
    } else if (msg.type === "telemetry_updated") {
      STATE.telemetry = msg.telemetry;
      refreshHeaderMetrics();
      window.HUB_APP?.onStateChange?.();
    } else if (msg.type === "resources_updated") {
      STATE.resourceBudgets = msg.budgets || [];
      refreshHeaderMetrics();
      window.HUB_APP?.onResourcesUpdated?.();
    } else if (msg.type === "group_created" || msg.type === "group_updated") {
      STATE.taskGroups.set(msg.group.groupId, msg.group);
      renderSidebarGroups();
      renderStageHeaderAndTabs();
    } else if (msg.type === "group_deleted") {
      STATE.taskGroups.delete(msg.groupId);
      for (const key of STATE.messagesByStream.keys()) {
        if (key === `lead:${msg.groupId}` || key.includes(`:${msg.groupId}__`)) {
          STATE.messagesByStream.delete(key);
        }
      }
      if (STATE.activeGroupId === msg.groupId) {
        const first = [...STATE.taskGroups.values()][0];
        if (first) {
          STATE.activeGroupId = first.groupId;
          STATE.activeStreamKey = `lead:${first.groupId}`;
        }
      }
      renderAll();
      appendLog(`已删除任务分组 ${msg.groupId}`);
    } else if (msg.type === "group_lead_changed") {
      const grp = STATE.taskGroups.get(msg.groupId);
      if (grp) {
        grp.leadAgent = msg.leadAgent;
      }
      renderAll();
      appendLog(`任务 [${msg.groupId}] 主导切换: ${msg.previousLead} -> ${msg.leadAgent}`);
    } else if (msg.type === "message_upserted") {
      upsertMessageRecord(msg.message);
      if (msg.message.streamKey === STATE.activeStreamKey) {
        const exists = els.messages.querySelector(`[data-message-id="${CSS.escape(msg.message.messageId)}"]`);
        if (exists) {
          updateStreamingMessageDom(msg.message);
        } else {
          renderMessages();
        }
      }
    } else if (msg.type === "agent_chunk") {
      const rec = findMessageById(msg.streamKey, msg.messageId);
      if (rec) {
        if (msg.channel === "message") rec.text += msg.text;
        else if (msg.channel === "thought") rec.thoughtText += msg.text;
        updateStreamingMessageDom(rec);
      }
    } else if (msg.type === "tool_event") {
      appendLog(`[${msg.sessionKey}] tool ${msg.title} (${msg.status || "start"})`);
      const rec = findMessageById(msg.streamKey, msg.messageId);
      if (rec) {
        const existingTool = rec.toolCalls.find((t) => t.toolCallId === msg.toolCallId);
        if (existingTool) {
          existingTool.title = msg.title || existingTool.title;
          if (msg.status) existingTool.status = msg.status;
          if (msg.kind) existingTool.kind = msg.kind;
        } else {
          rec.toolCalls.push({
            toolCallId: msg.toolCallId,
            title: msg.title,
            kind: msg.kind,
            status: msg.status,
            rawInput: msg.rawInput,
            timestamp: msg.timestamp,
          });
        }
        updateStreamingMessageDom(rec);
      }
    } else if (msg.type === "session_updated") {
      STATE.sessions.set(msg.session.sessionKey, msg.session);
      renderSidebarGroups();
      renderStageHeaderAndTabs();
      renderInspector();
      refreshHeaderMetrics();
      window.HUB_APP?.onStateChange?.();
    } else if (msg.type === "task_updated") {
      STATE.tasks.set(msg.task.taskId, msg.task);
      renderSidebarGroups();
      renderInspector();
      if (msg.task.groupId === STATE.activeGroupId && !isSubStream(STATE.activeStreamKey)) {
        renderMessages();
      }
      appendLog(`委派 ${msg.task.taskId} [${msg.task.targetAgent}] -> ${msg.task.status}`);
    } else if (msg.type === "permission_requested") {
      STATE.pendingPermissions.set(msg.permission.requestId, msg.permission);
      renderPermissions();
      appendLog(`权限请求: ${msg.permission.sessionKey} (${msg.permission.toolTitle})`);
    } else if (msg.type === "permission_resolved") {
      STATE.pendingPermissions.delete(msg.requestId);
      renderPermissions();
    } else if (msg.type === "permission_mode_changed") {
      STATE.permissionMode = msg.permissionMode;
      els.permSelect.value = msg.permissionMode;
      appendLog(`权限策略已变更为: ${msg.permissionMode}`);
    }
  };
}

// Event bindings
els.toggleNewTaskBtn.onclick = () => {
  els.newTaskPopover.hidden = !els.newTaskPopover.hidden;
  if (!els.newTaskPopover.hidden) {
    els.newTaskTitleInput.focus();
  }
};

els.cancelNewTaskBtn.onclick = () => {
  els.newTaskPopover.hidden = true;
};

els.newTaskPopover.onsubmit = async (e) => {
  e.preventDefault();
  const title = els.newTaskTitleInput.value.trim();
  els.newTaskTitleInput.value = "";
  els.newTaskPopover.hidden = true;
  await createTaskGroup({ title: title || undefined, leadAgent: STATE.newTaskLead });
};

els.stageTaskTitle.onclick = () => {
  const group = getActiveGroup();
  if (group) void renameTaskGroup(group);
};

els.backToLeadBtn.onclick = () => {
  const group = getActiveGroup();
  if (group) selectGroup(group.groupId, `lead:${group.groupId}`);
};

els.stopSessionBtn.onclick = () => {
  const key = activeSessionKeyForCurrentView();
  if (key) void cancelSession(key);
};

els.permSelect.onchange = async () => {
  await fetch("/api/permissions/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: els.permSelect.value }),
  });
};

els.toggleInspectorBtn.onclick = () => {
  STATE.inspectorCollapsed = !STATE.inspectorCollapsed;
  els.workbench.classList.toggle("inspector-collapsed", STATE.inspectorCollapsed);
};

els.themeToggleBtn.onclick = () => {
  applyTheme(!document.body.classList.contains("dark"));
};

els.sendBtn.onclick = () => void sendPrompt();

els.promptInput.addEventListener("input", () => {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 200)}px`;
});

els.promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
  }
});

els.messages.addEventListener("click", (e) => {
  const toggleBtn = e.target.closest("[data-toggle-inline-preview]");
  if (toggleBtn) {
    const wrap = toggleBtn.closest(".md-code-wrap");
    const previewBox = wrap?.querySelector(".inline-preview-box");
    const preEl = wrap?.querySelector("pre");
    if (previewBox && preEl) {
      const showingPreview = !previewBox.hidden;
      previewBox.hidden = showingPreview;
      preEl.hidden = !showingPreview;
      toggleBtn.classList.toggle("active", !showingPreview);
    }
    return;
  }

  const btn = e.target.closest("[data-copy-code]");
  if (!btn) return;
  const wrap = btn.closest(".md-code-wrap");
  const codeEl = wrap?.querySelector("pre code");
  if (!codeEl) return;
  void navigator.clipboard?.writeText(codeEl.textContent || "");
  const orig = btn.textContent;
  btn.textContent = "已复制";
  setTimeout(() => {
    btn.textContent = orig;
  }, 1200);
});

document.querySelectorAll(".mode-tab[data-stage-view]").forEach((btn) => {
  btn.onclick = () => {
    const view = btn.dataset.stageView;
    if (view) setStageView(view);
  };
});

if (els.liveContextPill) {
  els.liveContextPill.onclick = () => {
    setStageView("telemetry");
  };
}

window.HUB_APP = {
  STATE,
  els,
  escapeHtml,
  formatTime,
  formatTokens,
  renderMarkdown,
  appendLog,
  selectGroup,
  setStageView,
  refreshHeaderMetrics,
  getEnabledAgents,
  agentTagHtml,
  renderAgentControls,
  onStateChange: null,
  onResourcesUpdated: null,
};

// Init theme & connections
try {
  applyTheme(localStorage.getItem("agent-hub-theme") === "dark");
} catch {
  applyTheme(false);
}
renderAgentControls();
setStageView("chat");
connectWs();
void loadAdapterHealth();

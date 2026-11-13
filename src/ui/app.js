const STATE = {
  defaultGroupId: "grp-default",
  baseCwd: "",
  desktopMode: false,
  port: 0,
  permissionMode: "approve-all",
  agents: [],
  modelCatalogs: new Map(),
  probingModelAgents: new Set(),
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
  groupSearchQuery: "",
  showArchivedGroups: false,
  draftsByStream: new Map(),
  qsItems: [],
  qsActiveIndex: 0,
};

const BUILTIN_FALLBACK_AGENTS = [
  { agent: "claude", label: "claude", color: "#b8542c", darkColor: "#ef936c", enabled: true, available: true, authReady: true },
  { agent: "codex", label: "codex", color: "#0d7148", darkColor: "#6fe0a0", enabled: true, available: true, authReady: true },
  { agent: "agy", label: "agy", color: "#2358a6", darkColor: "#7cb3ff", enabled: true, available: true, authReady: true },
  { agent: "opencode", label: "opencode", color: "#6d3fc0", darkColor: "#b896ff", enabled: true, available: true, authReady: true },
  { agent: "kimi", label: "kimi", color: "#0d7490", darkColor: "#5eead4", enabled: true, available: true, authReady: true },
];

const els = {
  appFavicon: document.getElementById("appFavicon"),
  workbench: document.getElementById("workbench"),
  wsDot: document.getElementById("wsDot"),
  wsText: document.getElementById("wsText"),
  portBadge: document.getElementById("portBadge"),
  cwdPill: document.getElementById("cwdPill"),
  pickCwdBtn: document.getElementById("pickCwdBtn"),
  toggleNewTaskBtn: document.getElementById("toggleNewTaskBtn"),
  quickLaunchRow: document.getElementById("quickLaunchRow"),
  newTaskPopover: document.getElementById("newTaskPopover"),
  newTaskTitleInput: document.getElementById("newTaskTitleInput"),
  newTaskCwdInput: document.getElementById("newTaskCwdInput"),
  newTaskPickCwdBtn: document.getElementById("newTaskPickCwdBtn"),
  newTaskAgents: document.getElementById("newTaskAgents"),
  cancelNewTaskBtn: document.getElementById("cancelNewTaskBtn"),
  groupCountBadge: document.getElementById("groupCountBadge"),
  groupSearchInput: document.getElementById("groupSearchInput"),
  toggleArchivedBtn: document.getElementById("toggleArchivedBtn"),
  groupList: document.getElementById("groupList"),
  adapterPills: document.getElementById("adapterPills"),
  themeToggleBtn: document.getElementById("themeToggleBtn"),
  quitHubBtn: document.getElementById("quitHubBtn"),
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
  exportGroupBtn: document.getElementById("exportGroupBtn"),
  toggleInspectorBtn: document.getElementById("toggleInspectorBtn"),
  sessionTabs: document.getElementById("sessionTabs"),
  permBanner: document.getElementById("permBanner"),
  questionBanner: document.getElementById("questionBanner"),
  messages: document.getElementById("messages"),
  composerLabel: document.getElementById("composerLabel"),
  promptInput: document.getElementById("promptInput"),
  modelSelect: document.getElementById("modelSelect"),
  effortSelect: document.getElementById("effortSelect"),
  refreshModelsBtn: document.getElementById("refreshModelsBtn"),
  composerHint: document.getElementById("composerHint"),
  stopSessionBtn: document.getElementById("stopSessionBtn"),
  sendBtn: document.getElementById("sendBtn"),
  inspSessionCount: document.getElementById("inspSessionCount"),
  inspSessions: document.getElementById("inspSessions"),
  inspTaskCount: document.getElementById("inspTaskCount"),
  inspTasks: document.getElementById("inspTasks"),
  logFeed: document.getElementById("logFeed"),
  jumpLatestBtn: document.getElementById("jumpLatestBtn"),
  appModalBackdrop: document.getElementById("appModalBackdrop"),
  appModalCornerTag: document.getElementById("appModalCornerTag"),
  appModalTitle: document.getElementById("appModalTitle"),
  appModalMessage: document.getElementById("appModalMessage"),
  appModalInput: document.getElementById("appModalInput"),
  appModalCancelBtn: document.getElementById("appModalCancelBtn"),
  appModalConfirmBtn: document.getElementById("appModalConfirmBtn"),
  quickSwitcherBackdrop: document.getElementById("quickSwitcherBackdrop"),
  quickSwitcherInput: document.getElementById("quickSwitcherInput"),
  quickSwitcherList: document.getElementById("quickSwitcherList"),
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

// 内置 Agent 的颜色走 CSS 变量；自定义 Agent 返回配置里的颜色（按当前主题选深/浅色）
function agentColorValue(agentId) {
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
  return isDark && found.darkColor ? found.darkColor : found.color;
}

function getAgentColorStyle(agentId) {
  const color = agentColorValue(agentId);
  return color ? ` style="--agent-color:${escapeHtml(color)}"` : "";
}

function applyAgentColorVar(el, agentId) {
  const color = agentColorValue(agentId);
  if (color) el.style.setProperty("--agent-color", color);
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
      applyAgentColorVar(btn, item.agent);
      btn.textContent = `+ ${item.agent}`;
      btn.title = `以 ${item.label || item.agent} 为主导，新建一个并行任务`;
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
      applyAgentColorVar(btn, item.agent);
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
      applyAgentColorVar(btn, item.agent);
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
      applyAgentColorVar(pill, item.agent);
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
  const time = formatTime(Date.now());
  STATE.logs.push(`[${time}] ${line}`);
  if (STATE.logs.length > 160) {
    STATE.logs.shift();
  }
  const el = document.createElement("div");
  el.className = "log-line";
  const timeEl = document.createElement("span");
  timeEl.className = "log-time";
  timeEl.textContent = time;
  el.appendChild(timeEl);
  el.appendChild(document.createTextNode(line));
  const stick = els.logFeed.scrollHeight - els.logFeed.scrollTop - els.logFeed.clientHeight < 40;
  els.logFeed.appendChild(el);
  while (els.logFeed.children.length > 160) {
    els.logFeed.removeChild(els.logFeed.firstChild);
  }
  if (stick) els.logFeed.scrollTop = els.logFeed.scrollHeight;
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

function isSessionRunning(sessionKey) {
  if (!sessionKey) return false;
  const sess = STATE.sessions.get(sessionKey);
  if (sess && (sess.status === "busy" || sess.status === "starting" || sess.status === "running")) {
    return true;
  }
  if (STATE.sendingStreams.has(`sub:${sessionKey}`)) {
    return true;
  }
  if (sess?.role === "lead" && STATE.sendingStreams.has(`lead:${sess.groupId}`)) {
    return true;
  }
  for (const t of STATE.tasks.values()) {
    if (t.targetSessionKey === sessionKey && (t.status === "running" || t.status === "queued")) {
      return true;
    }
  }
  const streamKey = sess?.role === "lead" ? `lead:${sess.groupId}` : `sub:${sessionKey}`;
  const msgs = STATE.messagesByStream.get(streamKey);
  if (msgs && msgs.length > 0 && msgs[msgs.length - 1]?.status === "streaming") {
    return true;
  }
  return false;
}

function isGroupBusy(groupId) {
  if (STATE.sendingStreams.has(`lead:${groupId}`)) {
    return true;
  }
  for (const s of STATE.sessions.values()) {
    if (s.groupId === groupId && isSessionRunning(s.sessionKey)) {
      return true;
    }
  }
  for (const t of STATE.tasks.values()) {
    if (t.groupId === groupId && (t.status === "running" || t.status === "queued")) {
      return true;
    }
  }
  return false;
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
  const nextStreamKey = streamKey || `lead:${groupId}`;
  if (STATE.activeStreamKey && els.promptInput) {
    if (els.promptInput.value) {
      STATE.draftsByStream.set(STATE.activeStreamKey, els.promptInput.value);
    } else {
      STATE.draftsByStream.delete(STATE.activeStreamKey);
    }
  }
  STATE.activeGroupId = groupId;
  STATE.activeStreamKey = nextStreamKey;
  if (els.promptInput) {
    const restored = STATE.draftsByStream.get(nextStreamKey) || "";
    els.promptInput.value = restored;
    els.promptInput.style.height = "auto";
    if (restored) {
      els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 200)}px`;
    }
  }
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

let activeModalCleanup = null;

function openAppModal(opts) {
  if (!els.appModalBackdrop) return Promise.resolve(opts.mode === "confirm" ? false : null);
  if (activeModalCleanup) {
    activeModalCleanup(opts.mode === "confirm" ? false : null);
  }

  return new Promise((resolve) => {
    const isPrompt = opts.mode === "prompt";
    els.appModalCornerTag.textContent = isPrompt ? "input" : "confirm";
    els.appModalTitle.textContent = opts.title || "确认操作";
    if (opts.message) {
      els.appModalMessage.hidden = false;
      els.appModalMessage.textContent = opts.message;
    } else {
      els.appModalMessage.hidden = true;
      els.appModalMessage.textContent = "";
    }

    if (isPrompt) {
      els.appModalInput.hidden = false;
      els.appModalInput.value = opts.defaultValue ?? "";
      els.appModalInput.placeholder = opts.placeholder || "";
    } else {
      els.appModalInput.hidden = true;
      els.appModalInput.value = "";
    }

    els.appModalConfirmBtn.textContent = opts.confirmText || "确定";
    els.appModalConfirmBtn.className = `alma-btn ${opts.danger ? "alma-btn-danger" : "alma-btn-primary"}`;
    els.appModalBackdrop.hidden = false;

    const finish = (result) => {
      activeModalCleanup = null;
      els.appModalBackdrop.hidden = true;
      els.appModalConfirmBtn.onclick = null;
      els.appModalCancelBtn.onclick = null;
      els.appModalBackdrop.onclick = null;
      els.appModalInput.onkeydown = null;
      resolve(result);
    };

    activeModalCleanup = finish;

    els.appModalConfirmBtn.onclick = () => {
      finish(isPrompt ? els.appModalInput.value : true);
    };
    els.appModalCancelBtn.onclick = () => {
      finish(isPrompt ? null : false);
    };
    els.appModalBackdrop.onclick = (e) => {
      if (e.target === els.appModalBackdrop) {
        finish(isPrompt ? null : false);
      }
    };
    els.appModalInput.onkeydown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(els.appModalInput.value);
      }
    };

    requestAnimationFrame(() => {
      if (isPrompt) {
        els.appModalInput.focus();
        els.appModalInput.select();
      } else {
        els.appModalConfirmBtn.focus();
      }
    });
  });
}

function showPromptModal(opts) {
  return openAppModal({ ...opts, mode: "prompt" });
}

function showConfirmModal(opts) {
  return openAppModal({ ...opts, mode: "confirm" });
}

async function renameTaskGroup(group) {
  const next = await showPromptModal({
    title: "重命名任务分组",
    message: "输入新的任务名称：",
    defaultValue: group.title,
    placeholder: "任务名称",
    confirmText: "保存",
  });
  if (!next || !next.trim() || next.trim() === group.title) return;
  await fetch("/api/groups/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: group.groupId, title: next.trim() }),
  });
}

async function toggleArchiveTaskGroup(group) {
  if (!group) return;
  const nextArchived = !group.archived;
  await fetch("/api/groups/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: group.groupId, archived: nextArchived }),
  });
  appendLog(nextArchived ? `已归档任务「${group.title}」` : `已恢复任务「${group.title}」`);
  if (nextArchived && STATE.activeGroupId === group.groupId && !STATE.showArchivedGroups) {
    const nextActive = [...STATE.taskGroups.values()].find(
      (g) => g.groupId !== group.groupId && !g.archived,
    );
    if (nextActive) {
      selectGroup(nextActive.groupId, `lead:${nextActive.groupId}`);
    }
  }
}

async function deleteTaskGroup(group) {
  const ok = await showConfirmModal({
    title: "删除任务分组",
    message: `确认删除任务「${group.title}」并关闭其下的所有会话？此操作不可撤销。`,
    confirmText: "确认删除",
    danger: true,
  });
  if (!ok) return;
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
  const allGroups = [...STATE.taskGroups.values()].sort((a, b) => a.createdAt - b.createdAt);
  const archivedCount = allGroups.filter((g) => Boolean(g.archived)).length;
  const activeCount = allGroups.length - archivedCount;
  els.groupCountBadge.textContent = String(activeCount);

  if (els.toggleArchivedBtn) {
    els.toggleArchivedBtn.hidden = archivedCount === 0 && !STATE.showArchivedGroups;
    els.toggleArchivedBtn.textContent = STATE.showArchivedGroups
      ? `活跃 ${activeCount}`
      : `归档 ${archivedCount}`;
    els.toggleArchivedBtn.classList.toggle("active", STATE.showArchivedGroups);
  }

  const query = STATE.groupSearchQuery.trim().toLowerCase();
  const groups = allGroups.filter((g) => {
    if (query) {
      const subs = getGroupSubSessions(g.groupId);
      const haystack = [
        g.title,
        g.leadAgent,
        g.cwd || "",
        ...subs.map((s) => `${s.agent} ${s.label || s.name}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    }
    return Boolean(g.archived) === STATE.showArchivedGroups;
  });

  els.groupList.innerHTML = "";
  if (groups.length === 0) {
    const emptyNote = document.createElement("div");
    emptyNote.className = "empty-note";
    emptyNote.textContent = query
      ? `没有匹配「${STATE.groupSearchQuery.trim()}」的任务`
      : STATE.showArchivedGroups
        ? "暂无已归档任务"
        : "暂无活跃任务";
    els.groupList.appendChild(emptyNote);
    return;
  }

  for (const group of groups) {
    const isActiveGroup = group.groupId === STATE.activeGroupId;
    const subs = getGroupSubSessions(group.groupId);
    const groupTasks = getGroupTasks(group.groupId);
    const busy = isGroupBusy(group.groupId);

    const card = document.createElement("div");
    card.className = `group-card${isActiveGroup ? " active" : ""}${group.archived ? " is-archived" : ""}`;
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
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "mini-icon-btn";
    archiveBtn.title = group.archived ? "取消归档" : "归档任务";
    archiveBtn.textContent = group.archived ? "↺" : "▣";
    archiveBtn.onclick = (e) => {
      e.stopPropagation();
      void toggleArchiveTaskGroup(group);
    };
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "mini-icon-btn";
    renameBtn.title = "重命名任务";
    renameBtn.textContent = "✎";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      void renameTaskGroup(group);
    };
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "mini-icon-btn del";
    delBtn.title = "删除任务";
    delBtn.textContent = "✕";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      void deleteTaskGroup(group);
    };
    actions.appendChild(archiveBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    top.appendChild(titleWrap);
    top.appendChild(actions);

    const leadSessKey = `${group.leadAgent}:${group.groupId}__lead`;
    const leadSess = STATE.sessions.get(leadSessKey);
    const activeModel = leadSess?.currentModelId || group.leadModel || "";
    const meta = document.createElement("div");
    meta.className = "group-meta";
    meta.innerHTML = `
      ${agentTagHtml(group.leadAgent, `★ ${group.leadAgent}`)}
      ${group.archived ? '<span class="archived-pill">已归档</span>' : ""}
      ${activeModel ? `<span class="model-badge-pill" title="当前/预设模型">${escapeHtml(activeModel)}</span>` : ""}
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
        const subRunning = isSessionRunning(sub.sessionKey);
        const subNode = document.createElement("div");
        subNode.className = `tree-node${STATE.activeStreamKey === subStreamKey ? " active" : ""}`;
        subNode.title = sub.sessionKey;
        subNode.innerHTML = `
          <span class="tree-node-left">
            <span class="dot ${subRunning ? "busy" : escapeHtml(sub.status)}"></span>
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

function getAgentCatalog(agentId) {
  if (!agentId) return null;
  const cached = STATE.modelCatalogs.get(agentId);
  if (cached) return cached;
  const fromAgent = (STATE.agents || []).find((a) => a.agent === agentId)?.modelCatalog;
  if (fromAgent) {
    STATE.modelCatalogs.set(agentId, fromAgent);
    return fromAgent;
  }
  return null;
}

async function ensureAgentModelsLoaded(agentId, force = false) {
  if (!agentId || STATE.probingModelAgents.has(agentId)) return;
  const existing = getAgentCatalog(agentId);
  if (!force && existing && Array.isArray(existing.models) && existing.models.length > 0) {
    return;
  }
  const meta = (STATE.agents || []).find((a) => a.agent === agentId);
  if (!force && meta && meta.available === false) {
    return;
  }

  STATE.probingModelAgents.add(agentId);
  renderModelSelectorBar();
  try {
    const res = await fetch(
      `/api/models?agent=${encodeURIComponent(agentId)}${force ? "&refresh=1" : ""}`,
    );
    const data = await res.json();
    if (res.ok && data.catalog) {
      STATE.modelCatalogs.set(agentId, data.catalog);
      if (force) {
        appendLog(
          `已刷新模型 [${agentId}]: ${data.catalog.models?.length || 0} 个模型` +
            (data.catalog.effort ? ` · 支持思考强度 (${data.catalog.effort.configId})` : ""),
        );
      }
    } else if (force) {
      appendLog(`探测模型失败 [${agentId}]: ${data.error || res.status}`);
    }
  } catch (err) {
    if (force) appendLog(`探测模型异常 [${agentId}]: ${err.message}`);
  } finally {
    STATE.probingModelAgents.delete(agentId);
    renderModelSelectorBar();
    window.HUB_INTERACTIVE?.onAgentsUpdated?.();
  }
}

function renderModelSelectorBar() {
  if (!els.modelSelect || !els.effortSelect) return;

  const subMode = isSubStream(STATE.activeStreamKey);
  const subSession = subMode ? STATE.sessions.get(STATE.activeStreamKey.slice(4)) : null;
  const group = getActiveGroup();

  let targetAgent = "";
  let catalog = null;
  let selectedModel = "";
  let selectedEffort = "";
  let isSubTarget = false;

  if (subMode) {
    if (!subSession) {
      els.modelSelect.innerHTML = '<option value="">子会话未就绪</option>';
      els.modelSelect.disabled = true;
      els.effortSelect.hidden = true;
      if (els.refreshModelsBtn) els.refreshModelsBtn.disabled = true;
      return;
    }
    isSubTarget = true;
    targetAgent = subSession.agent;
    catalog = subSession.modelCatalog || getAgentCatalog(targetAgent);
    selectedModel = subSession.currentModelId || catalog?.currentModelId || "";
    selectedEffort = subSession.currentEffort || catalog?.effort?.currentValue || "";
  } else {
    if (!group) return;
    targetAgent = group.leadAgent;
    const leadSession = STATE.sessions.get(`${targetAgent}:${group.groupId}__lead`);
    const agentMeta = (STATE.agents || []).find((a) => a.agent === targetAgent);
    catalog = leadSession?.modelCatalog || getAgentCatalog(targetAgent);
    selectedModel =
      group.agentModels?.[targetAgent] ||
      (group.leadAgent === targetAgent ? group.leadModel : "") ||
      "";
    const defaultHintVal = agentMeta?.defaultModel || catalog?.currentModelId || "";
    if (!selectedModel && leadSession?.currentModelId && leadSession.currentModelId !== defaultHintVal) {
      selectedModel = leadSession.currentModelId;
    }
    selectedEffort =
      group.agentEfforts?.[targetAgent] ||
      (group.leadAgent === targetAgent ? group.leadEffort : "") ||
      "";
  }

  const isProbing = STATE.probingModelAgents.has(targetAgent);
  if (!catalog && !isProbing) {
    void ensureAgentModelsLoaded(targetAgent, false);
  }

  els.modelSelect.disabled = false;
  els.modelSelect.innerHTML = "";

  const agentMeta = (STATE.agents || []).find((a) => a.agent === targetAgent);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];

  if (!isSubTarget) {
    const defOpt = document.createElement("option");
    defOpt.value = "";
    const autoHint = agentMeta?.defaultModel || catalog?.currentModelId || "跟随 CLI";
    defOpt.textContent =
      isProbing && models.length === 0 ? "加载模型列表中..." : `默认 (${autoHint})`;
    els.modelSelect.appendChild(defOpt);
  } else if (models.length === 0) {
    const singleOpt = document.createElement("option");
    singleOpt.value = selectedModel || "";
    singleOpt.textContent = selectedModel || (isProbing ? "加载模型列表中..." : "默认模型");
    els.modelSelect.appendChild(singleOpt);
  }

  const seenIds = new Set();
  for (const m of models) {
    if (!m?.id || seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
    els.modelSelect.appendChild(opt);
  }

  if (selectedModel && !seenIds.has(selectedModel)) {
    const customOpt = document.createElement("option");
    customOpt.value = selectedModel;
    customOpt.textContent = selectedModel;
    els.modelSelect.appendChild(customOpt);
  }
  els.modelSelect.value = selectedModel;

  const effortCfg = catalog?.effort;
  if (effortCfg && Array.isArray(effortCfg.options) && effortCfg.options.length > 0) {
    els.effortSelect.hidden = false;
    els.effortSelect.innerHTML = "";
    if (!isSubTarget) {
      const defEff = document.createElement("option");
      defEff.value = "";
      defEff.textContent = `思考: 默认 (${agentMeta?.defaultEffort || effortCfg.currentValue || "auto"})`;
      els.effortSelect.appendChild(defEff);
    }
    const seenEff = new Set();
    for (const o of effortCfg.options) {
      if (!o?.id || seenEff.has(o.id)) continue;
      seenEff.add(o.id);
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = `思考: ${o.name || o.id}`;
      els.effortSelect.appendChild(opt);
    }
    if (selectedEffort && !seenEff.has(selectedEffort)) {
      const extraEff = document.createElement("option");
      extraEff.value = selectedEffort;
      extraEff.textContent = `思考: ${selectedEffort}`;
      els.effortSelect.appendChild(extraEff);
    }
    els.effortSelect.value = selectedEffort;
  } else {
    els.effortSelect.hidden = true;
    els.effortSelect.innerHTML = "";
  }

  if (els.refreshModelsBtn) {
    els.refreshModelsBtn.disabled = isProbing;
    els.refreshModelsBtn.textContent = isProbing ? "探测中..." : "↻ 模型";
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
      const subRunning = isSessionRunning(sub.sessionKey);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `session-tab${STATE.activeStreamKey === key ? " active" : ""}`;
      tab.title = sub.sessionKey;
      tab.innerHTML = `<span class="dot ${subRunning ? "busy" : escapeHtml(sub.status)}"></span>↳ ${escapeHtml(sub.agent)} · ${escapeHtml(sub.label || sub.name)}${sub.isWorktree ? " [wt]" : ""}`;
      tab.onclick = () => selectGroup(group.groupId, key);
      els.sessionTabs.appendChild(tab);
    }
  }

  const activeKey = activeSessionKeyForCurrentView();
  const isBusy =
    STATE.sendingStreams.has(STATE.activeStreamKey) ||
    Boolean(activeKey && isSessionRunning(activeKey));
  els.sendBtn.disabled = STATE.sendingStreams.has(STATE.activeStreamKey);
  els.sendBtn.textContent = STATE.sendingStreams.has(STATE.activeStreamKey) ? "执行中..." : "发送 ↵";
  els.stopSessionBtn.hidden = !isBusy;
  renderModelSelectorBar();
}

const BASE_DOC_TITLE = "Agent Hub — 多 Agent 任务协同台";
const DEFAULT_FAVICON_HREF = "/ui/icon.svg";
const ALERT_FAVICON_HREF =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="14" fill="#151514"/>' +
      '<path d="M21 48 L32 16 L43 48 M25.5 36.5 H38.5" stroke="#f3f2ec" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<circle cx="49" cy="15" r="9" fill="#dc2626"/>' +
      "</svg>",
  );

let titleBlinkTimer = null;
let titleBlinkPhase = false;

function playSoftAlertChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const playTone = (freq, startOffset, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.04, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };
    playTone(660, 0, 0.14);
    playTone(880, 0.14, 0.22);
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // ignore WebAudio restrictions
  }
}

function syncAttentionIndicators(notifyPayload = null) {
  const permCount = STATE.pendingPermissions.size;
  const qCount = STATE.pendingQuestions.size;
  const total = permCount + qCount;

  if (els.appFavicon) {
    els.appFavicon.href = total > 0 ? ALERT_FAVICON_HREF : DEFAULT_FAVICON_HREF;
  }

  if (total === 0) {
    if (titleBlinkTimer) {
      clearInterval(titleBlinkTimer);
      titleBlinkTimer = null;
    }
    titleBlinkPhase = false;
    document.title = BASE_DOC_TITLE;
    return;
  }

  const parts = [];
  if (permCount > 0) parts.push(`${permCount} 权限`);
  if (qCount > 0) parts.push(`${qCount} 问题`);
  const summary = `⚠️ [${parts.join(" · ")}待确认]`;
  const isBackground = document.hidden || !document.hasFocus();

  if (isBackground) {
    if (!titleBlinkTimer) {
      titleBlinkPhase = false;
      document.title = `${summary} ${BASE_DOC_TITLE}`;
      titleBlinkTimer = setInterval(() => {
        titleBlinkPhase = !titleBlinkPhase;
        document.title = titleBlinkPhase
          ? "⚠️ Agent 正在等待你确认！"
          : `${summary} ${BASE_DOC_TITLE}`;
      }, 1000);
    }
    if (notifyPayload) {
      playSoftAlertChime();
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          const n = new Notification("Agent Hub 需要你的确认", {
            body: notifyPayload.body,
            tag: "agent-hub-pending",
            renotify: true,
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              // ignore
            }
            if (notifyPayload.groupId) {
              selectGroup(notifyPayload.groupId, notifyPayload.streamKey);
            }
            n.close();
          };
        } catch {
          // ignore desktop Notification failures
        }
      }
    }
  } else {
    if (titleBlinkTimer) {
      clearInterval(titleBlinkTimer);
      titleBlinkTimer = null;
    }
    document.title = `${summary} ${BASE_DOC_TITLE}`;
  }
}

function renderPermissions() {
  syncAttentionIndicators();
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
      <div class="empty-hint">
        <span><kbd>Enter</kbd> 发送</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
        <span>点击任务标题可重命名</span>
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

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

function findPrecedingPromptForMessage(streamKey, messageId) {
  const list = STATE.messagesByStream.get(streamKey) || [];
  const idx = list.findIndex((m) => m.messageId === messageId);
  const start = idx >= 0 ? idx - 1 : list.length - 1;
  for (let i = start; i >= 0; i--) {
    const candidate = list[i];
    if ((candidate.role === "user" || candidate.role === "caller") && candidate.text && candidate.text.trim()) {
      return candidate;
    }
  }
  return null;
}

async function regenerateAssistantMessage(streamKey, messageId) {
  if (!streamKey || STATE.sendingStreams.has(streamKey)) {
    appendLog("当前会话正在执行中，请先停止或等待本轮结束");
    return;
  }
  const sourcePrompt = findPrecedingPromptForMessage(streamKey, messageId);
  if (!sourcePrompt) {
    appendLog("未找到该回复对应的用户指令，无法重新生成");
    return;
  }
  await sendStreamPrompt(sourcePrompt.text.trim(), streamKey);
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
      const modelPart = msg.usage.modelId ? `${escapeHtml(msg.usage.modelId)} · ` : "";
      usageHtml = `<span class="msg-usage-pill" title="输入 ${msg.usage.inputTokens} / 缓存 ${msg.usage.cachedReadTokens} / 输出 ${msg.usage.outputTokens} / 思考 ${msg.usage.thoughtTokens}">${modelPart}${estMark}↑${formatTokens(msg.usage.inputTokens)} ↓${formatTokens(msg.usage.outputTokens)}${cachePart}${injPart}</span>`;
    }
    meta.innerHTML = `${agentTagHtml(msg.agent, msg.senderLabel)}<span>${formatTime(msg.timestamp)}</span>${usageHtml}`;
  } else {
    meta.innerHTML = `<span>${escapeHtml(`${msg.senderLabel} · ${formatTime(msg.timestamp)}`)}</span>`;
  }

  const canCopy = Boolean(msg.text && msg.text.trim() && msg.status !== "streaming");
  const canRegen =
    msg.role === "assistant" &&
    msg.status !== "streaming" &&
    Boolean(findPrecedingPromptForMessage(msg.streamKey, msg.messageId));
  if (canCopy || canRegen) {
    const actionWrap = document.createElement("span");
    actionWrap.className = "msg-actions";
    if (canCopy) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "msg-action-btn";
      copyBtn.dataset.copyMsg = msg.messageId;
      copyBtn.textContent = "复制整条";
      actionWrap.appendChild(copyBtn);
    }
    if (canRegen) {
      const regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.className = "msg-action-btn";
      regenBtn.dataset.regenMsg = msg.messageId;
      regenBtn.textContent = "重新生成";
      actionWrap.appendChild(regenBtn);
    }
    meta.appendChild(actionWrap);
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
        const delActions = document.createElement("div");
        delActions.className = "delegation-actions";
        if (task.status === "running" || task.status === "queued") {
          const stopTaskBtn = document.createElement("button");
          stopTaskBtn.type = "button";
          stopTaskBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
          stopTaskBtn.textContent = "停止";
          stopTaskBtn.onclick = () => void cancelSession(task.targetSessionKey);
          delActions.appendChild(stopTaskBtn);
        }
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "alma-btn alma-btn-outline alma-btn-sm";
        openBtn.textContent = "查看子会话 →";
        openBtn.onclick = () => selectGroup(task.groupId, `sub:${task.targetSessionKey}`);
        delActions.appendChild(openBtn);
        card.appendChild(delActions);
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

// 用户往上翻看历史时，不再被流式输出强行拉回底部
const STICK_THRESHOLD_PX = 80;
let lastRenderedStreamKey = null;

function isMessagesNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  updateJumpLatestBtn();
}

function updateJumpLatestBtn() {
  if (!els.jumpLatestBtn) return;
  const hasContent = els.messages.querySelector(".msg-entry") !== null;
  els.jumpLatestBtn.hidden = !hasContent || isMessagesNearBottom();
}

function renderMessages() {
  const group = getActiveGroup();
  const list = STATE.messagesByStream.get(STATE.activeStreamKey) || [];
  const streamChanged = lastRenderedStreamKey !== STATE.activeStreamKey;
  const stick = streamChanged || isMessagesNearBottom();
  const prevScrollTop = els.messages.scrollTop;
  lastRenderedStreamKey = STATE.activeStreamKey;
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
    updateJumpLatestBtn();
    return;
  }

  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    const nextAssistant = list.slice(i + 1).find((m) => m.role === "assistant");
    const linkedTasks = matchTasksForAssistantMessage(msg, nextAssistant?.timestamp);
    els.messages.appendChild(buildMessageElement(msg, linkedTasks));
  }
  if (stick) {
    scrollMessagesToBottom();
  } else {
    els.messages.scrollTop = prevScrollTop;
    updateJumpLatestBtn();
  }
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
      const running = isSessionRunning(s.sessionKey);
      const card = document.createElement("div");
      card.className = `insp-card${STATE.activeStreamKey === targetStream ? " active" : ""}`;
      const usageText =
        s.usage && typeof s.usage.usedTokens === "number"
          ? `tokens=${s.usage.usedTokens}${s.usage.maxTokens ? `/${s.usage.maxTokens}` : ""}`
          : "";
      card.innerHTML = `
        <div class="insp-row">
          <span class="mono" style="font-weight:600;display:inline-flex;align-items:center;gap:6px">
            <span class="dot ${running ? "busy" : escapeHtml(s.status)}"></span>
            ${s.role === "lead" ? "★ 主导" : "↳ 子会话"} · ${escapeHtml(s.agent)}
          </span>
          <span class="mono" style="font-size:11px;color:var(--faint)">${escapeHtml(running && s.status === "idle" ? "running" : s.status)}</span>
        </div>
        <div class="insp-sub" title="${escapeHtml(s.sessionKey)}">${escapeHtml(s.label || s.name)}${s.pid ? ` · pid=${s.pid}` : ""}</div>
        ${s.currentModelId ? `<div class="insp-sub">model: ${escapeHtml(s.currentModelId)}${s.currentEffort ? ` · effort=${escapeHtml(s.currentEffort)}` : ""}</div>` : ""}
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

      if (running) {
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
        cancelBtn.textContent = "停止";
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
      const taskActions = document.createElement("div");
      taskActions.className = "insp-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "alma-btn alma-btn-outline alma-btn-sm";
      btn.textContent = "打开子会话 →";
      btn.onclick = () => selectGroup(t.groupId, `sub:${t.targetSessionKey}`);
      taskActions.appendChild(btn);

      if (t.status === "running" || t.status === "queued") {
        const stopBtn = document.createElement("button");
        stopBtn.type = "button";
        stopBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
        stopBtn.textContent = "停止";
        stopBtn.onclick = () => void cancelSession(t.targetSessionKey);
        taskActions.appendChild(stopBtn);
      }
      card.appendChild(taskActions);
      els.inspTasks.appendChild(card);
    }
  }
}

function renderDesktopControls() {
  const activeCwd = getActiveGroup()?.cwd || STATE.baseCwd || "";
  if (els.cwdPill) {
    els.cwdPill.textContent = activeCwd;
    els.cwdPill.title = activeCwd;
  }
  const activePort = STATE.port || (location.port ? Number(location.port) : 0);
  if (els.portBadge) {
    els.portBadge.textContent = activePort ? `:${activePort}` : "";
    els.portBadge.title = activePort ? `当前监听端口 ${activePort}` : "";
  }
  if (els.quitHubBtn) {
    els.quitHubBtn.hidden = !STATE.desktopMode;
  }
}

async function pickDirectoryDialog(initialDir) {
  const res = await fetch("/api/workspace/pick-directory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initialDir: initialDir || undefined }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    appendLog(`选择目录失败: ${data.error || res.status}`);
    return null;
  }
  if (data.cancelled || data.canceled || !data.path) {
    return null;
  }
  return data.path;
}

async function changeActiveWorkspaceCwd() {
  const activeGroup = getActiveGroup();
  const initialDir = activeGroup?.cwd || STATE.baseCwd;
  const picked = await pickDirectoryDialog(initialDir);
  if (!picked) return;
  const res = await fetch("/api/workspace/cwd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: picked,
      groupId: activeGroup?.groupId || STATE.activeGroupId,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    appendLog(`切换工作区失败: ${data.error || res.status}`);
    return;
  }
  if (data.baseCwd) STATE.baseCwd = data.baseCwd;
  if (data.group) STATE.taskGroups.set(data.group.groupId, data.group);
  renderDesktopControls();
  renderSidebarGroups();
  renderStageHeaderAndTabs();
  appendLog(`工作区已切换至: ${data.group?.cwd || data.baseCwd || picked}`);
}

function renderAll() {
  if (!STATE.taskGroups.has(STATE.activeGroupId)) {
    STATE.activeGroupId = STATE.defaultGroupId;
    STATE.activeStreamKey = `lead:${STATE.defaultGroupId}`;
  }
  renderDesktopControls();
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
  const stick = isMessagesNearBottom();
  existing.replaceWith(fresh);
  if (stick) {
    scrollMessagesToBottom();
  } else {
    updateJumpLatestBtn();
  }
}

async function sendStreamPrompt(prompt, targetStreamKey) {
  if (!prompt || !targetStreamKey) return;
  if (STATE.sendingStreams.has(targetStreamKey)) {
    return;
  }

  const subMode = isSubStream(targetStreamKey);
  const targetSessionKey = subMode ? targetStreamKey.slice(4) : null;
  const targetGroupId = subMode
    ? STATE.sessions.get(targetSessionKey)?.groupId || STATE.activeGroupId
    : targetStreamKey.slice(5);
  if (!STATE.taskGroups.has(targetGroupId)) return;

  STATE.sendingStreams.add(targetStreamKey);
  if (targetStreamKey === STATE.activeStreamKey) {
    lastRenderedStreamKey = null;
    scrollMessagesToBottom();
  }
  renderStageHeaderAndTabs();
  renderSidebarGroups();

  try {
    const endpoint = subMode ? "/api/sessions/chat" : "/api/chat";
    const payload = subMode
      ? { sessionKey: targetSessionKey, prompt }
      : { groupId: targetGroupId, prompt };
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
    if (targetStreamKey === STATE.activeStreamKey) {
      els.promptInput.focus();
    }
  }
}

async function sendPrompt() {
  const prompt = els.promptInput.value.trim();
  const group = getActiveGroup();
  if (!prompt || !group) return;

  const targetStreamKey = STATE.activeStreamKey;
  if (STATE.sendingStreams.has(targetStreamKey)) {
    return;
  }

  els.promptInput.value = "";
  els.promptInput.style.height = "auto";
  STATE.draftsByStream.delete(targetStreamKey);
  await sendStreamPrompt(prompt, targetStreamKey);
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
    if (typeof data.desktopMode === "boolean") STATE.desktopMode = data.desktopMode;
    if (typeof data.port === "number") STATE.port = data.port;
    renderDesktopControls();
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
      STATE.desktopMode = Boolean(msg.desktopMode);
      STATE.port = typeof msg.port === "number" ? msg.port : 0;
      STATE.permissionMode = msg.permissionMode || "approve-all";
      els.permSelect.value = STATE.permissionMode;
      renderDesktopControls();

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
      STATE.modelCatalogs.clear();
      if (msg.modelCatalogs && typeof msg.modelCatalogs === "object") {
        for (const [k, v] of Object.entries(msg.modelCatalogs)) {
          if (v) STATE.modelCatalogs.set(k, v);
        }
      }
      for (const a of STATE.agents || []) {
        if (a?.modelCatalog && !STATE.modelCatalogs.has(a.agent)) {
          STATE.modelCatalogs.set(a.agent, a.modelCatalog);
        }
      }
      STATE.telemetry = msg.telemetry || null;
      STATE.resourceBudgets = msg.resourceBudgets || [];

      renderAll();
    } else if (msg.type === "models_updated") {
      if (msg.agent && msg.catalog) {
        STATE.modelCatalogs.set(msg.agent, msg.catalog);
        renderSidebarGroups();
        renderStageHeaderAndTabs();
        window.HUB_INTERACTIVE?.onAgentsUpdated?.();
      }
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
        syncAttentionIndicators({
          body: `${msg.question.agent || "Agent"} 发起提问：${msg.question.title}`,
          groupId: STATE.sessions.get(msg.question.sessionKey)?.groupId,
        });
        appendLog(`待确认问题: ${msg.question.title}`);
      }
    } else if (msg.type === "question_resolved") {
      STATE.pendingQuestions.delete(msg.questionId);
      window.HUB_INTERACTIVE?.renderQuestions?.();
      syncAttentionIndicators();
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
      renderDesktopControls();
      renderSidebarGroups();
      renderStageHeaderAndTabs();
    } else if (msg.type === "workspace_changed") {
      if (msg.baseCwd) STATE.baseCwd = msg.baseCwd;
      if (msg.group) STATE.taskGroups.set(msg.group.groupId, msg.group);
      renderDesktopControls();
      renderSidebarGroups();
      renderStageHeaderAndTabs();
      window.HUB_APP?.onStateChange?.();
      appendLog(`工作区目录已更新: ${msg.group?.cwd || msg.baseCwd}`);
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
      renderStageHeaderAndTabs();
      renderInspector();
      if (msg.task.groupId === STATE.activeGroupId && !isSubStream(STATE.activeStreamKey)) {
        renderMessages();
      }
      appendLog(`委派 ${msg.task.taskId} [${msg.task.targetAgent}] -> ${msg.task.status}`);
    } else if (msg.type === "permission_requested") {
      STATE.pendingPermissions.set(msg.permission.requestId, msg.permission);
      renderPermissions();
      const permSess = STATE.sessions.get(msg.permission.sessionKey);
      syncAttentionIndicators({
        body: `${msg.permission.agent} 请求确认：${msg.permission.toolTitle}`,
        groupId: permSess?.groupId,
        streamKey: permSess
          ? permSess.role === "lead"
            ? `lead:${permSess.groupId}`
            : `sub:${permSess.sessionKey}`
          : undefined,
      });
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
if (els.pickCwdBtn) {
  els.pickCwdBtn.onclick = () => void changeActiveWorkspaceCwd();
}

if (els.newTaskPickCwdBtn && els.newTaskCwdInput) {
  els.newTaskPickCwdBtn.onclick = async () => {
    const initial = els.newTaskCwdInput.value.trim() || getActiveGroup()?.cwd || STATE.baseCwd;
    const picked = await pickDirectoryDialog(initial);
    if (picked) els.newTaskCwdInput.value = picked;
  };
}

if (els.quitHubBtn) {
  els.quitHubBtn.onclick = async () => {
    els.quitHubBtn.disabled = true;
    try {
      await fetch("/api/system/shutdown", { method: "POST" });
    } catch {
      // backend may close before response flushes
    }
    window.close();
  };
}

els.toggleNewTaskBtn.onclick = () => {
  els.newTaskPopover.hidden = !els.newTaskPopover.hidden;
  if (!els.newTaskPopover.hidden) {
    if (els.newTaskCwdInput && !els.newTaskCwdInput.value.trim()) {
      els.newTaskCwdInput.placeholder = getActiveGroup()?.cwd || STATE.baseCwd || "默认工作区目录（可留空）";
    }
    els.newTaskTitleInput.focus();
  }
};

els.cancelNewTaskBtn.onclick = () => {
  els.newTaskPopover.hidden = true;
};

els.newTaskPopover.onsubmit = async (e) => {
  e.preventDefault();
  const title = els.newTaskTitleInput.value.trim();
  const cwd = els.newTaskCwdInput ? els.newTaskCwdInput.value.trim() : "";
  els.newTaskTitleInput.value = "";
  if (els.newTaskCwdInput) els.newTaskCwdInput.value = "";
  els.newTaskPopover.hidden = true;
  await createTaskGroup({
    title: title || undefined,
    leadAgent: STATE.newTaskLead,
    cwd: cwd || undefined,
  });
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

async function applyComposerModelOrEffortChange(patch) {
  const subMode = isSubStream(STATE.activeStreamKey);
  if (subMode) {
    const sessionKey = STATE.activeStreamKey.slice(4);
    const res = await fetch("/api/sessions/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, ...patch }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      appendLog(`切换子会话模型失败: ${data.error || res.status}`);
      renderModelSelectorBar();
      return;
    }
    if (data.session) {
      STATE.sessions.set(data.session.sessionKey, data.session);
      renderSidebarGroups();
      renderStageHeaderAndTabs();
      renderInspector();
    }
    appendLog(`子会话 [${sessionKey}] 模型配置已更新`);
    return;
  }

  const group = getActiveGroup();
  if (!group) return;
  const res = await fetch("/api/groups/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId: group.groupId, agent: group.leadAgent, ...patch }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    appendLog(`切换任务模型失败: ${data.error || res.status}`);
    renderModelSelectorBar();
    return;
  }
  if (data.group) {
    STATE.taskGroups.set(data.group.groupId, data.group);
  }
  if (data.session) {
    STATE.sessions.set(data.session.sessionKey, data.session);
  }
  renderSidebarGroups();
  renderStageHeaderAndTabs();
  renderInspector();
  const label = data.session?.currentModelId || data.group?.leadModel || "默认";
  appendLog(`任务 [${group.title}] (${group.leadAgent}) 模型设为: ${label}`);
}

if (els.modelSelect) {
  els.modelSelect.onchange = () => void applyComposerModelOrEffortChange({ model: els.modelSelect.value });
}

if (els.effortSelect) {
  els.effortSelect.onchange = () => void applyComposerModelOrEffortChange({ effort: els.effortSelect.value });
}

if (els.refreshModelsBtn) {
  els.refreshModelsBtn.onclick = () => {
    const subMode = isSubStream(STATE.activeStreamKey);
    const subSession = subMode ? STATE.sessions.get(STATE.activeStreamKey.slice(4)) : null;
    const targetAgent = subSession?.agent || getActiveGroup()?.leadAgent;
    if (targetAgent) {
      void ensureAgentModelsLoaded(targetAgent, true);
    }
  };
}

function setInspectorCollapsed(collapsed) {
  STATE.inspectorCollapsed = collapsed;
  els.workbench.classList.toggle("inspector-collapsed", collapsed);
  els.toggleInspectorBtn.classList.toggle("is-on", !collapsed);
  els.toggleInspectorBtn.setAttribute("aria-pressed", String(!collapsed));
  els.toggleInspectorBtn.title = collapsed ? "展开右侧会话 / 委派 / 日志面板" : "收起右侧面板";
  try {
    localStorage.setItem("agent-hub-inspector", collapsed ? "collapsed" : "open");
  } catch {
    // ignore storage failures
  }
}

els.toggleInspectorBtn.onclick = () => {
  setInspectorCollapsed(!STATE.inspectorCollapsed);
};

els.themeToggleBtn.onclick = () => {
  applyTheme(!document.body.classList.contains("dark"));
  // 自定义 Agent 的徽章色区分深浅主题，切换后重绘一次
  if (STATE.taskGroups.size > 0) renderAll();
};

els.sendBtn.onclick = () => void sendPrompt();

els.promptInput.addEventListener("input", () => {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 200)}px`;
});

els.promptInput.addEventListener("keydown", (e) => {
  // 中文输入法选词时按 Enter 只是上屏，不能当成发送
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
  }
});

els.messages.addEventListener("scroll", () => updateJumpLatestBtn(), { passive: true });

if (els.jumpLatestBtn) {
  els.jumpLatestBtn.onclick = () => scrollMessagesToBottom();
}

async function exportGroupMarkdown(group = getActiveGroup()) {
  if (!group) return;
  try {
    const res = await fetch(
      `/api/groups/export?groupId=${encodeURIComponent(group.groupId)}&format=json`,
    );
    const data = await res.json();
    if (!res.ok || data.ok === false || !data.markdown) {
      appendLog(`导出失败: ${data.error || res.status}`);
      return;
    }
    const blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.filename || `${group.groupId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    appendLog(`已导出 Markdown: ${a.download}`);
  } catch (err) {
    appendLog(`导出失败: ${err.message}`);
  }
}

function openNewTaskPopover() {
  if (STATE.stageView !== "chat") {
    setStageView("chat");
  }
  els.newTaskPopover.hidden = false;
  if (els.newTaskCwdInput && !els.newTaskCwdInput.value.trim()) {
    els.newTaskCwdInput.placeholder = getActiveGroup()?.cwd || STATE.baseCwd || "默认工作区目录（可留空）";
  }
  els.newTaskTitleInput.focus();
}

function buildQuickSwitcherItems(queryRaw) {
  const q = String(queryRaw || "").trim().toLowerCase();
  const groups = [...STATE.taskGroups.values()].sort((a, b) => {
    if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });

  const items = [];
  for (const g of groups) {
    const busy = isGroupBusy(g.groupId);
    items.push({
      id: `grp:${g.groupId}`,
      title: g.title,
      meta: `${g.leadAgent}${g.archived ? " · 已归档" : ""}${busy ? " · 运行中" : ""}`,
      dotClass: busy ? "busy" : "idle",
      searchText: `${g.title} ${g.leadAgent} ${g.cwd || ""}`.toLowerCase(),
      run: () => selectGroup(g.groupId, `lead:${g.groupId}`),
    });
    for (const sub of getGroupSubSessions(g.groupId)) {
      const running = isSessionRunning(sub.sessionKey);
      items.push({
        id: `sub:${sub.sessionKey}`,
        title: `${g.title} / ↳ ${sub.agent} · ${sub.label || sub.name}`,
        meta: running ? "子会话 · 运行中" : `子会话 · ${sub.status}`,
        dotClass: running ? "busy" : sub.status,
        searchText: `${g.title} ${sub.agent} ${sub.label || sub.name}`.toLowerCase(),
        run: () => selectGroup(g.groupId, `sub:${sub.sessionKey}`),
      });
    }
  }

  const activeGroup = getActiveGroup();
  items.push(
    {
      id: "cmd:new-task",
      title: "+ 新建并行任务",
      meta: "快捷键 Ctrl+N",
      dotClass: "idle",
      searchText: "新建 并行 任务 new task",
      run: () => openNewTaskPopover(),
    },
    {
      id: "cmd:export-md",
      title: "导出当前任务为 Markdown",
      meta: activeGroup ? activeGroup.title : "",
      dotClass: "idle",
      searchText: "导出 markdown md export",
      run: () => void exportGroupMarkdown(),
    },
    {
      id: "cmd:toggle-archived",
      title: STATE.showArchivedGroups ? "切回活跃任务列表" : "查看已归档任务",
      meta: "侧边栏筛选",
      dotClass: "idle",
      searchText: "归档 archive 任务列表",
      run: () => {
        STATE.showArchivedGroups = !STATE.showArchivedGroups;
        renderSidebarGroups();
      },
    },
    {
      id: "cmd:toggle-theme",
      title: document.body.classList.contains("dark") ? "切换为浅色主题" : "切换为深色主题",
      meta: "外观",
      dotClass: "idle",
      searchText: "主题 深色 浅色 theme dark light",
      run: () => {
        applyTheme(!document.body.classList.contains("dark"));
        if (STATE.taskGroups.size > 0) renderAll();
      },
    },
  );

  if (!q) return items;
  return items.filter((item) => item.searchText.includes(q));
}

function renderQuickSwitcherList() {
  if (!els.quickSwitcherList) return;
  const items = buildQuickSwitcherItems(els.quickSwitcherInput?.value || "");
  STATE.qsItems = items;
  if (STATE.qsActiveIndex >= items.length) {
    STATE.qsActiveIndex = 0;
  }
  els.quickSwitcherList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "未找到匹配的任务或命令";
    els.quickSwitcherList.appendChild(empty);
    return;
  }
  items.forEach((item, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `qs-item${idx === STATE.qsActiveIndex ? " active" : ""}`;
    btn.innerHTML = `
      <span class="qs-item-main">
        <span class="dot ${escapeHtml(item.dotClass)}"></span>
        <span>${escapeHtml(item.title)}</span>
      </span>
      <span class="qs-item-sub">${escapeHtml(item.meta)}</span>
    `;
    btn.onmouseenter = () => {
      STATE.qsActiveIndex = idx;
      els.quickSwitcherList.querySelectorAll(".qs-item").forEach((el, i) => {
        el.classList.toggle("active", i === idx);
      });
    };
    btn.onclick = () => {
      closeQuickSwitcher();
      item.run();
    };
    els.quickSwitcherList.appendChild(btn);
  });
}

function openQuickSwitcher() {
  if (!els.quickSwitcherBackdrop) return;
  els.quickSwitcherBackdrop.hidden = false;
  if (els.quickSwitcherInput) els.quickSwitcherInput.value = "";
  STATE.qsActiveIndex = 0;
  renderQuickSwitcherList();
  requestAnimationFrame(() => els.quickSwitcherInput?.focus());
}

function closeQuickSwitcher() {
  if (!els.quickSwitcherBackdrop) return;
  els.quickSwitcherBackdrop.hidden = true;
}

if (els.groupSearchInput) {
  els.groupSearchInput.addEventListener("input", () => {
    STATE.groupSearchQuery = els.groupSearchInput.value;
    renderSidebarGroups();
  });
}

if (els.toggleArchivedBtn) {
  els.toggleArchivedBtn.onclick = () => {
    STATE.showArchivedGroups = !STATE.showArchivedGroups;
    renderSidebarGroups();
  };
}

if (els.exportGroupBtn) {
  els.exportGroupBtn.onclick = () => void exportGroupMarkdown();
}

if (els.quickSwitcherBackdrop) {
  els.quickSwitcherBackdrop.onclick = (e) => {
    if (e.target === els.quickSwitcherBackdrop) closeQuickSwitcher();
  };
}

if (els.quickSwitcherInput) {
  els.quickSwitcherInput.addEventListener("input", () => {
    STATE.qsActiveIndex = 0;
    renderQuickSwitcherList();
  });
  els.quickSwitcherInput.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (STATE.qsItems.length > 0) {
        STATE.qsActiveIndex = (STATE.qsActiveIndex + 1) % STATE.qsItems.length;
        renderQuickSwitcherList();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (STATE.qsItems.length > 0) {
        STATE.qsActiveIndex = (STATE.qsActiveIndex - 1 + STATE.qsItems.length) % STATE.qsItems.length;
        renderQuickSwitcherList();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = STATE.qsItems[STATE.qsActiveIndex];
      if (target) {
        closeQuickSwitcher();
        target.run();
      }
    }
  });
}

window.addEventListener("focus", () => syncAttentionIndicators());
window.addEventListener("blur", () => syncAttentionIndicators());
document.addEventListener("visibilitychange", () => syncAttentionIndicators());

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const key = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && key === "k") {
    e.preventDefault();
    if (els.quickSwitcherBackdrop && !els.quickSwitcherBackdrop.hidden) {
      closeQuickSwitcher();
    } else {
      openQuickSwitcher();
    }
    return;
  }

  if (((e.ctrlKey || e.metaKey) || e.altKey) && !e.shiftKey && key === "n") {
    e.preventDefault();
    if (els.quickSwitcherBackdrop && !els.quickSwitcherBackdrop.hidden) closeQuickSwitcher();
    openNewTaskPopover();
    return;
  }

  if (e.key === "Escape") {
    if (els.appModalBackdrop && !els.appModalBackdrop.hidden) {
      e.preventDefault();
      els.appModalCancelBtn?.click();
      return;
    }
    if (els.quickSwitcherBackdrop && !els.quickSwitcherBackdrop.hidden) {
      e.preventDefault();
      closeQuickSwitcher();
      return;
    }
    if (!els.newTaskPopover.hidden) {
      e.preventDefault();
      els.newTaskPopover.hidden = true;
      return;
    }
    if (document.activeElement === els.groupSearchInput && els.groupSearchInput.value) {
      e.preventDefault();
      els.groupSearchInput.value = "";
      STATE.groupSearchQuery = "";
      renderSidebarGroups();
      return;
    }
    if (STATE.stageView === "chat") {
      const activeKey = activeSessionKeyForCurrentView();
      if (
        STATE.sendingStreams.has(STATE.activeStreamKey) ||
        (activeKey && isSessionRunning(activeKey))
      ) {
        e.preventDefault();
        void cancelSession(activeKey);
        appendLog("已按 Esc 停止当前会话");
      }
    }
  }
});

els.permSelect.addEventListener("change", () => {
  if (
    els.permSelect.value !== "approve-all" &&
    "Notification" in window &&
    Notification.permission === "default"
  ) {
    void Notification.requestPermission().catch(() => {});
  }
});

els.messages.addEventListener("click", (e) => {
  const copyMsgBtn = e.target.closest("[data-copy-msg]");
  if (copyMsgBtn) {
    const msgId = copyMsgBtn.dataset.copyMsg;
    const msg = findMessageById(STATE.activeStreamKey, msgId);
    if (msg?.text) {
      void copyTextToClipboard(msg.text).then((ok) => {
        if (!ok) return;
        const orig = copyMsgBtn.textContent;
        copyMsgBtn.textContent = "已复制";
        setTimeout(() => {
          copyMsgBtn.textContent = orig;
        }, 1200);
      });
    }
    return;
  }

  const regenBtn = e.target.closest("[data-regen-msg]");
  if (regenBtn) {
    const msgId = regenBtn.dataset.regenMsg;
    void regenerateAssistantMessage(STATE.activeStreamKey, msgId);
    return;
  }

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
  getAgentColorStyle,
  renderAgentControls,
  ensureAgentModelsLoaded,
  showPromptModal,
  showConfirmModal,
  onStateChange: null,
  onResourcesUpdated: null,
};

// Init theme & connections
try {
  applyTheme(localStorage.getItem("agent-hub-theme") === "dark");
} catch {
  applyTheme(false);
}
try {
  setInspectorCollapsed(localStorage.getItem("agent-hub-inspector") === "collapsed");
} catch {
  setInspectorCollapsed(false);
}
renderAgentControls();
setStageView("chat");
connectWs();
void loadAdapterHealth();

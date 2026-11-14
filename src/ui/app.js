import {
  renderMarkdown,
  highlightCode,
  renderUnifiedDiff,
  computeDiffStats,
  buildInlinePreviewSrcdoc,
  decodeUtf8Base64,
  partitionMessagesForDisplay,
  isFailedAssistantMsg,
  isPureErrorAssistantMsg,
} from "./markdown.js";

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
  settings: { autoTitle: false },
  workflows: new Map(),
  progress: new Map(),
  contexts: new Map(),
  projects: [],
  collapsedProjects: new Set(),
  settingsTab: "general",
  defaultLead: "",
  configuredDefaultLead: "",
  inspectorCollapsed: false,
  stageView: "chat",
  telemetry: null,
  resourceBudgets: [],
  resourcesList: [],
  logs: [],
  groupSearchQuery: "",
  showArchivedGroups: false,
  draftsByStream: new Map(),
  imageDraftsByStream: new Map(),
  queuedByStream: new Map(),
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
  inspectorBackdrop: document.getElementById("inspectorBackdrop"),
  wsDot: document.getElementById("wsDot"),
  portBadge: document.getElementById("portBadge"),
  cwdPill: document.getElementById("cwdPill"),
  pickCwdBtn: document.getElementById("pickCwdBtn"),
  toggleNewTaskBtn: document.getElementById("toggleNewTaskBtn"),
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
  composerBox: document.querySelector(".composer-box"),
  composerLabel: document.getElementById("composerLabel"),
  composerSuggest: document.getElementById("composerSuggest"),
  composerAttachments: document.getElementById("composerAttachments"),
  promptInput: document.getElementById("promptInput"),
  modelSelect: document.getElementById("modelSelect"),
  effortSelect: document.getElementById("effortSelect"),
  refreshModelsBtn: document.getElementById("refreshModelsBtn"),
  imageFileInput: document.getElementById("imageFileInput"),
  attachImageBtn: document.getElementById("attachImageBtn"),
  stopSessionBtn: document.getElementById("stopSessionBtn"),
  steerBtn: document.getElementById("steerBtn"),
  composerQueue: document.getElementById("composerQueue"),
  sendBtn: document.getElementById("sendBtn"),
  inspSessionCount: document.getElementById("inspSessionCount"),
  inspSessions: document.getElementById("inspSessions"),
  inspHead: document.getElementById("inspHead"),
  inspContext: document.getElementById("inspContext"),
  inspProgress: document.getElementById("inspProgress"),
  inspProgressCount: document.getElementById("inspProgressCount"),
  inspFiles: document.getElementById("inspFiles"),
  inspFileCount: document.getElementById("inspFileCount"),
  inspArtifacts: document.getElementById("inspArtifacts"),
  inspArtifactCount: document.getElementById("inspArtifactCount"),
  workflowView: document.getElementById("workflowView"),
  settingsBackdrop: document.getElementById("settingsBackdrop"),
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
        ? `首轮约 ${formatTokens(budget.firstTurnInjectionTokens)} tok`
        : "0 tok";
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

// 界面上一律显示 Agent 的名称；id 只用于内部标识
function agentName(agentId) {
  if (!agentId) return "";
  const list = STATE.agents && STATE.agents.length > 0 ? STATE.agents : BUILTIN_FALLBACK_AGENTS;
  return list.find((a) => a.agent === agentId)?.label || agentId;
}

// 服务端给的发送者标签以 id 开头（如 "codex 委派"），显示时换成名称
function senderLabelText(msg) {
  const label = msg.senderLabel || "";
  if (msg.agent && label.startsWith(msg.agent)) return agentName(msg.agent) + label.slice(msg.agent.length);
  return label;
}

function agentTagHtml(agentId, text) {
  const label = text ?? agentName(agentId);
  return `<span class="agent-tag" data-agent="${escapeHtml(agentId)}"${getAgentColorStyle(agentId)}>${escapeHtml(label)}</span>`;
}

// 服务端下发的默认主导：defaultLead 是新任务实际会用的，configuredDefaultLead 是用户保存的设置（空 = 自动）
function applyDefaultLead(msg) {
  if (!msg || !("defaultLead" in msg)) return;
  const next = msg.defaultLead || "";
  if (next && next !== STATE.defaultLead) {
    STATE.newTaskLead = next;
  }
  STATE.defaultLead = next;
  STATE.configuredDefaultLead = msg.configuredDefaultLead || "";
}

// 主导在新建任务时指定，这里只显示。要换人，在对话里让当前主导交接（lead_handoff）。
function renderLeadBadge(group) {
  if (!els.leadSwitcher) return;
  const lead = group?.leadAgent;
  els.leadSwitcher.innerHTML = '<span class="lead-switch-label">主导</span>';
  if (!lead) return;
  const badge = document.createElement("span");
  badge.className = "lead-pill active is-static";
  badge.dataset.agent = lead;
  applyAgentColorVar(badge, lead);
  badge.textContent = agentName(lead);
  els.leadSwitcher.appendChild(badge);
  els.leadSwitcher.title = `这个任务由 ${agentName(lead)} 主导。要换人，直接在对话里让它交接给其他 Agent`;
}

function renderAgentControls() {
  const enabled = getEnabledAgents();
  if (!enabled.some((a) => a.agent === STATE.newTaskLead)) {
    STATE.newTaskLead =
      (enabled.some((a) => a.agent === STATE.defaultLead) && STATE.defaultLead) ||
      enabled[0]?.agent ||
      "claude";
  }

  if (els.navAgentsBadge) {
    els.navAgentsBadge.textContent = String(enabled.length);
  }

  if (els.newTaskAgents) {
    els.newTaskAgents.innerHTML = "";
    for (const item of enabled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `popover-agent-opt${item.agent === STATE.newTaskLead ? " active" : ""}`;
      btn.dataset.agent = item.agent;
      applyAgentColorVar(btn, item.agent);
      btn.textContent = item.label || item.agent;
      btn.onclick = () => {
        STATE.newTaskLead = item.agent;
        els.newTaskAgents
          .querySelectorAll(".popover-agent-opt")
          .forEach((b) => b.classList.toggle("active", b === btn));
      };
      els.newTaskAgents.appendChild(btn);
    }
  }

  renderLeadBadge(getActiveGroup());
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
  if (els.workflowView) els.workflowView.hidden = view !== "workflow";

  document.querySelectorAll(".mode-tab[data-stage-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.stageView === view);
    if (btn.dataset.stageView === view) btn.classList.remove("has-news");
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
  // 每条日志都读 scrollHeight 会强制整页重新布局；同一帧的日志攒起来一次写入
  pendingLogLines.push(el);
  if (!logFeedRafId) logFeedRafId = requestAnimationFrame(flushLogFeed);
}

const pendingLogLines = [];
let logFeedRafId = 0;

function flushLogFeed() {
  logFeedRafId = 0;
  const stick = els.logFeed.scrollHeight - els.logFeed.scrollTop - els.logFeed.clientHeight < 40;
  els.logFeed.append(...pendingLogLines.splice(0));
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

function groupHasLeadSession(group) {
  for (const s of STATE.sessions.values()) {
    // 重启后留下的已关闭会话不算：它需要重新启动，值得预热
    if (
      s.groupId === group.groupId &&
      s.role === "lead" &&
      s.agent === group.leadAgent &&
      s.status !== "closed" &&
      s.status !== "error"
    ) {
      return true;
    }
  }
  return false;
}

// 提前启动任务的主导会话，缩短第一条消息的等待。不等结果，接口不存在或失败都静默忽略。
// 每个任务每个主导 Agent 只调一次；主导被切换后键不同，会再调一次
const warmedGroupLeads = new Set();

function warmGroupSession(groupId) {
  const group = STATE.taskGroups.get(groupId);
  if (!group || groupHasLeadSession(group)) return;
  const key = `${groupId}|${group.leadAgent}`;
  if (warmedGroupLeads.has(key)) return;
  warmedGroupLeads.add(key);
  try {
    fetch("/api/sessions/warm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    }).catch(() => {});
  } catch {
    // 预热只是优化，失败不影响正常发送
  }
}

function selectGroup(groupId, streamKey) {
  const group = STATE.taskGroups.get(groupId);
  if (!group) return;
  warmGroupSession(groupId);
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
  renderComposerAttachments();
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

const SKINS = ["modern", "classic", "roundtable"];

function currentThemeName() {
  return document.body.classList.contains("dark") ? "dark" : "light";
}

function currentSkinName() {
  return document.body.dataset.skin || "modern";
}

function buildArtifactUrl(artifactId) {
  const theme = currentThemeName();
  const skin = currentSkinName();
  return `/artifacts/${encodeURIComponent(artifactId)}?theme=${encodeURIComponent(theme)}&skin=${encodeURIComponent(skin)}`;
}

function refreshThemeSensitiveFrames() {
  const dark = currentThemeName() === "dark";
  const skin = currentSkinName();
  document.querySelectorAll("iframe.artifact-frame[data-artifact-frame]").forEach((frame) => {
    const id = frame.dataset.artifactFrame;
    if (!id) return;
    const nextUrl = buildArtifactUrl(id);
    if (frame.getAttribute("src") !== nextUrl) {
      frame.setAttribute("src", nextUrl);
    }
  });
  document.querySelectorAll(".md-code-block[data-code-b64]").forEach((block) => {
    const frame = block.querySelector("iframe.md-preview-frame");
    if (!frame) return;
    const lang = block.dataset.codeLang || "html";
    const code = decodeUtf8Base64(block.dataset.codeB64 || "");
    frame.setAttribute("srcdoc", buildInlinePreviewSrcdoc(lang, code, { dark, skin }));
  });
}

function applySkin(skin) {
  const next = SKINS.includes(skin) ? skin : "modern";
  // 默认皮肤不带属性，其余皮肤靠 body[data-skin] 套用各自的配色和装饰
  if (next === "modern") delete document.body.dataset.skin;
  else document.body.dataset.skin = next;
  document.documentElement.dataset.skin = next;
  document.querySelectorAll("#skinSeg button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.skin === next);
  });
  refreshThemeSensitiveFrames();
  try {
    localStorage.setItem("agent-hub-skin", next);
  } catch {
    // ignore storage failures
  }
}

// 设置项存在 hub 端（对所有窗口生效）；这里只负责读写和同步勾选状态
function applyHubSettings(settings) {
  if (!settings) return;
  STATE.settings = { ...STATE.settings, ...settings };
  const toggle = document.getElementById("autoTitleToggle");
  if (toggle) toggle.checked = Boolean(STATE.settings.autoTitle);
  const parallel = document.getElementById("workflowParallelSelect");
  if (parallel && STATE.settings.workflowParallel) parallel.value = String(STATE.settings.workflowParallel);
}

async function saveHubSettings(patch) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok && data.settings) applyHubSettings(data.settings);
    else appendLog(`保存设置失败: ${data.error || res.status}`);
  } catch (err) {
    appendLog(`保存设置失败: ${err.message}`);
  }
}

function isAgentsViewOpen() {
  return Boolean(els.settingsBackdrop && !els.settingsBackdrop.hidden && STATE.settingsTab === "agents");
}

function openSettings(tab) {
  if (!els.settingsBackdrop) return;
  STATE.settingsTab = tab || STATE.settingsTab || "general";
  els.settingsBackdrop.hidden = false;
  els.settingsBackdrop.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsTab === STATE.settingsTab);
  });
  els.settingsBackdrop.querySelectorAll("[data-settings-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== STATE.settingsTab;
  });
  if (STATE.settingsTab === "agents") window.HUB_INTERACTIVE?.renderAgentsView?.();
  if (STATE.settingsTab === "logs" && els.logFeed) els.logFeed.scrollTop = els.logFeed.scrollHeight;
}

function closeSettings() {
  if (els.settingsBackdrop) els.settingsBackdrop.hidden = true;
}

function initSettingsDialog() {
  const btn = document.getElementById("settingsBtn");
  if (!btn || !els.settingsBackdrop) return;
  btn.onclick = () => openSettings();
  document.getElementById("settingsCloseBtn").onclick = closeSettings;
  els.settingsBackdrop.addEventListener("mousedown", (e) => {
    if (e.target === els.settingsBackdrop) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.settingsBackdrop.hidden && els.appModalBackdrop?.hidden !== false) {
      closeSettings();
    }
  });
  els.settingsBackdrop.querySelectorAll("[data-settings-tab]").forEach((b) => {
    b.onclick = () => openSettings(b.dataset.settingsTab);
  });
  document.querySelectorAll("#skinSeg button").forEach((b) => {
    b.onclick = () => applySkin(b.dataset.skin);
  });
  const toggle = document.getElementById("autoTitleToggle");
  if (toggle) toggle.onchange = () => void saveHubSettings({ autoTitle: toggle.checked });
  const parallel = document.getElementById("workflowParallelSelect");
  if (parallel) parallel.onchange = () => void saveHubSettings({ workflowParallel: Number(parallel.value) });
}

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  els.themeToggleBtn.textContent = dark ? "浅色" : "深色";
  refreshThemeSensitiveFrames();
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
    void showConfirmModal({ title: "任务没有创建", message: data.error || `HTTP ${res.status}`, confirmText: "知道了" });
    return false;
  }
  STATE.taskGroups.set(data.group.groupId, data.group);
  selectGroup(data.group.groupId, `lead:${data.group.groupId}`);
  return true;
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
  // 恢复后回到活跃列表，否则刚恢复的任务会从眼前消失
  if (!nextArchived && STATE.showArchivedGroups) {
    STATE.showArchivedGroups = false;
    renderSidebarGroups();
  }
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

async function cancelSession(sessionKey) {
  if (!sessionKey) return;
  await fetch("/api/peer/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey }),
  });
}

function projectKey(dir) {
  return String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectName(dir) {
  const norm = String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.slice(norm.lastIndexOf("/") + 1) || norm || "未指定目录";
}

function applyProjects(projects) {
  if (!Array.isArray(projects)) return;
  STATE.projects = projects;
  const list = document.getElementById("projectChoices");
  if (list) {
    list.innerHTML = projects
      .map((p) => `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)}（${p.activeTasks} 个任务）</option>`)
      .join("");
  }
}

try {
  STATE.collapsedProjects = new Set(JSON.parse(localStorage.getItem("agent-hub-collapsed-projects") || "[]"));
} catch {
  STATE.collapsedProjects = new Set();
}

function toggleProjectCollapsed(key) {
  if (STATE.collapsedProjects.has(key)) STATE.collapsedProjects.delete(key);
  else STATE.collapsedProjects.add(key);
  try {
    localStorage.setItem("agent-hub-collapsed-projects", JSON.stringify([...STATE.collapsedProjects]));
  } catch {
    // ignore storage failures
  }
  renderSidebarGroups();
}

async function updateTaskGroup(patch) {
  const res = await fetch("/api/groups/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (data.group) STATE.taskGroups.set(data.group.groupId, data.group);
  return data.group;
}

// 任务的目录：一个工作目录（Agent 在这里启动）加若干附加目录（也允许它读写）
function openDirsDialog(group) {
  if (!group) return;
  document.getElementById("dirsBackdrop")?.remove();
  const draft = { cwd: group.cwd || "", extraDirs: [...(group.extraDirs || [])] };
  const backdrop = document.createElement("div");
  backdrop.id = "dirsBackdrop";
  backdrop.className = "alma-modal-backdrop";
  const close = () => backdrop.remove();
  const hasSession = [...STATE.sessions.values()].some(
    (s) => s.groupId === group.groupId && s.status !== "closed" && s.status !== "error",
  );

  const render = () => {
    backdrop.innerHTML = `
      <div class="alma-modal-card dirs-card" role="dialog" aria-modal="true" aria-label="任务目录">
        <h3 class="alma-modal-title">「${escapeHtml(group.title)}」的目录</h3>
        <div class="dirs-field">
          <label>工作目录</label>
          <div class="dirs-row">
            <input id="dirsCwdInput" class="text-input" type="text" list="projectChoices" value="${escapeHtml(draft.cwd)}" />
            <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-dirs-pick="cwd">浏览</button>
          </div>
        </div>
        <div class="dirs-field">
          <label>附加目录<span class="dirs-hint">Agent 也可以读写这些目录，适合一个任务跨多个项目</span></label>
          ${
            draft.extraDirs.length === 0
              ? '<div class="insp-empty">还没有附加目录</div>'
              : draft.extraDirs
                  .map(
                    (dir, i) => `
              <div class="dirs-row">
                <span class="dirs-path" title="${escapeHtml(dir)}">${escapeHtml(dir)}</span>
                <button type="button" class="mini-icon-btn" data-dirs-remove="${i}" title="移除">×</button>
              </div>`,
                  )
                  .join("")
          }
          <div class="dirs-row">
            <input id="dirsAddInput" class="text-input" type="text" list="projectChoices" placeholder="粘贴路径，或点浏览选择" />
            <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-dirs-pick="extra">浏览</button>
            <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" id="dirsAddBtn">添加</button>
          </div>
        </div>
        ${hasSession ? '<div class="dirs-note">保存后会关闭这个任务当前的会话；下一条消息会在新目录里重新启动，并带上之前的对话摘要。</div>' : ""}
        <div id="dirsError" class="wf-error" hidden></div>
        <div class="alma-modal-actions">
          <button type="button" class="alma-btn" id="dirsCancelBtn">取消</button>
          <button type="button" class="alma-btn alma-btn-primary" id="dirsSaveBtn">保存</button>
        </div>
      </div>`;
    const cwdInput = backdrop.querySelector("#dirsCwdInput");
    const addInput = backdrop.querySelector("#dirsAddInput");
    cwdInput.oninput = () => {
      draft.cwd = cwdInput.value;
    };
    const addExtra = (value) => {
      const dir = String(value || "").trim();
      if (dir && !draft.extraDirs.some((d) => projectKey(d) === projectKey(dir))) {
        draft.extraDirs.push(dir);
      }
      render();
    };
    backdrop.querySelector("#dirsAddBtn").onclick = () => addExtra(addInput.value);
    addInput.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        addExtra(addInput.value);
      }
    };
    backdrop.querySelectorAll("[data-dirs-remove]").forEach((btn) => {
      btn.onclick = () => {
        draft.extraDirs.splice(Number(btn.dataset.dirsRemove), 1);
        render();
      };
    });
    backdrop.querySelectorAll("[data-dirs-pick]").forEach((btn) => {
      btn.onclick = async () => {
        const picked = await pickDirectoryDialog(draft.cwd || STATE.baseCwd);
        if (!picked) return;
        if (btn.dataset.dirsPick === "cwd") {
          draft.cwd = picked;
          render();
        } else {
          addExtra(picked);
        }
      };
    });
    backdrop.querySelector("#dirsCancelBtn").onclick = close;
    backdrop.querySelector("#dirsSaveBtn").onclick = async () => {
      const pending = addInput.value.trim();
      if (pending && !draft.extraDirs.some((d) => projectKey(d) === projectKey(pending))) {
        draft.extraDirs.push(pending);
      }
      try {
        await updateTaskGroup({ groupId: group.groupId, cwd: draft.cwd.trim() || undefined, extraDirs: draft.extraDirs });
        close();
        renderAll();
        appendLog(`任务「${group.title}」的目录已更新`);
      } catch (err) {
        const box = backdrop.querySelector("#dirsError");
        box.hidden = false;
        box.textContent = err.message;
      }
    };
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  render();
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

  // 屏幕上的任务来自不止一个目录时，按项目分组；每组可折叠，组头可以直接在该项目下新建任务
  const groupedByProject = new Set(groups.map((g) => projectKey(g.cwd))).size > 1;
  if (STATE.showArchivedGroups && !query) {
    groups.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  }
  if (groupedByProject) {
    const order = new Map();
    for (const g of groups) {
      const key = projectKey(g.cwd);
      if (!order.has(key)) order.set(key, order.size);
    }
    groups.sort((a, b) => order.get(projectKey(a.cwd)) - order.get(projectKey(b.cwd)));
  }
  let lastProjectKey = null;

  for (const group of groups) {
    if (groupedByProject) {
      const key = projectKey(group.cwd);
      if (key !== lastProjectKey) {
        lastProjectKey = key;
        const collapsed = STATE.collapsedProjects.has(key);
        const count = groups.filter((g) => projectKey(g.cwd) === key).length;
        const head = document.createElement("div");
        head.className = `project-head${collapsed ? " collapsed" : ""}`;
        head.title = group.cwd;
        head.innerHTML = `
          <span class="project-caret">›</span>
          <span class="project-name">${escapeHtml(projectName(group.cwd))}</span>
          <span class="project-count">${count}</span>
        `;
        head.onclick = () => toggleProjectCollapsed(key);
        if (!STATE.showArchivedGroups) {
          const add = document.createElement("button");
          add.type = "button";
          add.className = "mini-icon-btn";
          add.title = `在 ${projectName(group.cwd)} 下新建任务`;
          add.textContent = "+";
          const projectCwd = group.cwd;
          add.onclick = (e) => {
            e.stopPropagation();
            void createTaskGroup({ leadAgent: STATE.newTaskLead, cwd: projectCwd });
          };
          head.appendChild(add);
        }
        els.groupList.appendChild(head);
      }
      if (STATE.collapsedProjects.has(key) && group.groupId !== STATE.activeGroupId) {
        continue;
      }
    }
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
      ${agentTagHtml(group.leadAgent, `★ ${agentName(group.leadAgent)}`)}
      ${group.archived ? `<span class="archived-pill">归档于 ${escapeHtml(new Date(group.archivedAt || group.updatedAt).toLocaleDateString())}</span>` : ""}
      ${(group.extraDirs || []).length > 0 ? `<span class="archived-pill" title="${escapeHtml(group.extraDirs.join("\n"))}">+${group.extraDirs.length} 个目录</span>` : ""}
      ${activeModel ? `<span class="model-badge-pill" title="当前/预设模型">${escapeHtml(activeModel)}</span>` : ""}
      ${subs.length > 0 ? `<span>${subs.length} 个子会话</span>` : ""}
    `;

    card.appendChild(top);
    card.appendChild(meta);

    // 只有主导会话时，卡片本身就代表它，不再展开一行重复的树节点
    if (subs.length > 0) {
      const tree = document.createElement("div");
      tree.className = "session-tree";

      const leadStreamKey = `lead:${group.groupId}`;
      const leadNode = document.createElement("div");
      leadNode.className = `tree-node${STATE.activeStreamKey === leadStreamKey ? " active" : ""}`;
      leadNode.innerHTML = `
        <span class="tree-node-left">
          <span class="dot ${busy ? "busy" : "idle"}"></span>
          <span class="tree-node-label">${escapeHtml(agentName(group.leadAgent))} · 主导</span>
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
        subNode.className = `tree-node is-sub${STATE.activeStreamKey === subStreamKey ? " active" : ""}`;
        subNode.title = sub.sessionKey;
        subNode.innerHTML = `
          <span class="tree-node-left">
            <span class="dot ${subRunning ? "busy" : escapeHtml(sub.status)}"></span>
            <span class="tree-node-label">${escapeHtml(agentName(sub.agent))} · ${escapeHtml(sub.label || sub.name)}</span>
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
    els.refreshModelsBtn.textContent = isProbing ? "…" : "↻";
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
    els.streamBadge.textContent = `子会话 · ${agentName(subSession.agent)} (${subSession.label || subSession.name})`;
    els.streamBadge.className = "stream-badge sub";
    els.leadSwitcher.hidden = true;
    els.backToLeadBtn.hidden = false;
    els.composerLabel.textContent = `直连子会话 · ${agentName(subSession.agent)}:${subSession.label || subSession.name}`;
    els.promptInput.placeholder = `给子会话 ${agentName(subSession.agent)} 发消息（输入 / 查命令，@ 引用文件）`;
  } else {
    // 主导是谁已由旁边的主导标记表明，这里不再重复
    els.streamBadge.textContent = "";
    els.streamBadge.className = "stream-badge";
    els.leadSwitcher.hidden = false;
    els.backToLeadBtn.hidden = true;
    els.composerLabel.textContent = `${group.title} · 主导 ${agentName(group.leadAgent)}`;
    els.promptInput.placeholder = `给 ${agentName(group.leadAgent)} 发消息（输入 / 查命令，@ 引用文件）`;
  }

  renderLeadBadge(group);

  // 已归档的任务只读：输入框换成一条「恢复任务」
  const archivedBar = document.getElementById("archivedBar");
  if (archivedBar && els.composerBox) {
    archivedBar.hidden = !group.archived;
    els.composerBox.hidden = Boolean(group.archived);
    els.leadSwitcher.classList.toggle("is-disabled", Boolean(group.archived));
  }

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
    leadTab.innerHTML = `<span class="dot ${isGroupBusy(group.groupId) ? "busy" : "idle"}"></span>${escapeHtml(agentName(group.leadAgent))} · 主导`;
    leadTab.onclick = () => selectGroup(group.groupId, leadStreamKey);
    els.sessionTabs.appendChild(leadTab);

    for (const sub of subs) {
      const key = `sub:${sub.sessionKey}`;
      const subRunning = isSessionRunning(sub.sessionKey);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `session-tab is-sub${STATE.activeStreamKey === key ? " active" : ""}`;
      tab.title = sub.sessionKey;
      tab.innerHTML = `<span class="dot ${subRunning ? "busy" : escapeHtml(sub.status)}"></span>${escapeHtml(agentName(sub.agent))} · ${escapeHtml(sub.label || sub.name)}${sub.isWorktree ? " [wt]" : ""}`;
      tab.onclick = () => selectGroup(group.groupId, key);
      els.sessionTabs.appendChild(tab);
    }
  }

  const prevWtBar = document.getElementById("subWorktreeBar");
  if (subMode && subSession && subSession.isWorktree) {
    const nextBar = buildWorktreeBarElement(
      subSession.sessionKey,
      subSession.branch || subSession.effectiveCwd,
    );
    nextBar.id = "subWorktreeBar";
    if (prevWtBar) {
      prevWtBar.replaceWith(nextBar);
    } else if (els.sessionTabs) {
      els.sessionTabs.insertAdjacentElement("afterend", nextBar);
    }
  } else {
    prevWtBar?.remove();
  }

  const activeKey = activeSessionKeyForCurrentView();
  const isBusy =
    STATE.sendingStreams.has(STATE.activeStreamKey) ||
    Boolean(activeKey && isSessionRunning(activeKey));
  // 忙的时候仍然可以发：默认排队，等这一轮结束再送出；「引导」则打断当前这一轮
  els.sendBtn.disabled = false;
  els.sendBtn.textContent = isBusy ? "排队" : "发送";
  els.sendBtn.title = isBusy ? "这一轮结束后自动发送（Enter）" : "";
  els.stopSessionBtn.hidden = !isBusy;
  if (els.steerBtn) els.steerBtn.hidden = !isBusy;
  // 页面级的「正在工作」提示：对话区顶部一条流动的细线
  document.querySelector("main.stage")?.classList.toggle("is-busy", isBusy);
  renderComposerQueue();
  renderModelSelectorBar();
}

const BASE_DOC_TITLE = "RoundTable Meeting";
// 图标地址带着服务端给的版本号（?v=…），这里沿用页面里的地址，换图标后不会被旧缓存挡住
const DEFAULT_FAVICON_HREF = document.getElementById("appFavicon")?.getAttribute("href") || "/ui/icon-64.png";
const ALERT_FAVICON_HREF = DEFAULT_FAVICON_HREF.replace("icon-64.png", "icon-alert.png");

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
          const n = new Notification("RoundTable Meeting 需要你的确认", {
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
    <div class="empty-inner">
      <h2>${escapeHtml(agentName(group?.leadAgent || "claude"))} 已就绪</h2>
      <p>直接发消息开始，或从下面选一个。</p>
      <div class="starter-list">
        <button type="button" class="starter-btn" data-starter="列出当前项目目录核心文件，并委派 codex 检查主要入口逻辑是否存在边界问题">
          <span>梳理项目核心文件，并委派另一个 Agent 审查</span>
        </button>
        <button type="button" class="starter-btn" data-starter="调用 peer_list_agents 查看当前已接入的本地 Agent，并汇总状态报告">
          <span>查看已接入的 Agent 状态</span>
        </button>
        <button type="button" class="starter-btn" data-starter="调用 ui_render_artifact 生成一个交互式的项目模块结构与 Token 消耗估算看板（HTML）">
          <span>生成一个可交互的项目结构看板</span>
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

const WORKFLOW_STATUS_TEXT = { draft: "草稿，待发布", running: "运行中", completed: "已完成", failed: "未全部完成" };

// 主导调用 workflow_propose 之后，在那条回复下面放一张工作流预览；点一下去工作流页
function buildWorkflowCardElement(msg) {
  if (msg.role !== "assistant" || isSubStream(msg.streamKey)) return null;
  if (!(msg.toolCalls || []).some((t) => String(t.title || "").includes("workflow_propose"))) return null;
  const workflow = STATE.workflows.get(msg.groupId);
  if (!workflow || workflow.steps.length === 0) return null;

  const done = workflow.steps.filter((s) => s.status === "completed").length;
  const statusText =
    workflow.status === "running"
      ? `运行中 ${done}/${workflow.steps.length}`
      : WORKFLOW_STATUS_TEXT[workflow.status] || workflow.status;
  const agents = [...new Set(workflow.steps.map((s) => s.agent))];
  const shown = workflow.steps.slice(0, 5);
  const card = document.createElement("button");
  card.type = "button";
  card.className = `wf-card status-${workflow.status}`;
  card.title = "打开工作流";
  card.innerHTML = `
    <div class="wf-card-head">
      <span class="wf-card-title">工作流 · ${workflow.steps.length} 步</span>
      <span class="wf-card-status">${escapeHtml(statusText)}</span>
    </div>
    <div class="wf-card-steps">
      ${shown
        .map(
          (s) => `<span class="wf-card-step status-${escapeHtml(s.status)}"><span class="dot ${s.status === "running" ? "busy" : s.status === "completed" ? "completed" : s.status === "failed" ? "failed" : "idle"}"></span>${escapeHtml(s.name)}</span>`,
        )
        .join('<span class="wf-card-arrow">›</span>')}
      ${workflow.steps.length > shown.length ? `<span class="wf-card-more">还有 ${workflow.steps.length - shown.length} 步</span>` : ""}
    </div>
    <div class="wf-card-foot">
      <span class="wf-card-agents">${agents.map((a) => agentTagHtml(a)).join("")}</span>
      <span class="wf-card-open">查看并发布 ›</span>
    </div>
  `;
  const groupId = msg.groupId;
  card.onclick = () => {
    if (STATE.activeGroupId !== groupId) selectGroup(groupId, `lead:${groupId}`);
    setStageView("workflow");
  };
  return card;
}

const TOOL_STATUS_TEXT = { pending: "等待中", in_progress: "进行中", completed: "完成", failed: "失败" };
const TASK_STATUS_TEXT = { queued: "排队中", running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消" };

function matchTasksForAssistantMessage(msg, nextAssistantTimestamp) {
  if (msg.role !== "assistant" || isSubStream(msg.streamKey)) return [];
  const start = msg.timestamp - 500;
  const end = msg.completedAt ? msg.completedAt + 1500 : nextAssistantTimestamp || Number.MAX_SAFE_INTEGER;
  return getGroupTasks(msg.groupId).filter(
    (t) => t.createdAt >= start && t.createdAt <= end,
  );
}

// 交互组件没有版本号，内容创建后不再变；用 id + 创建时间 + 内容长度判断「还是不是同一份」
function artifactCardKey(artifact) {
  return `${artifact.artifactId}:${artifact.createdAt || 0}:${(artifact.content || "").length}`;
}

const ARTIFACT_CARD_SELECTOR = ".artifact-card[data-artifact-key]";

function findReusableChild(cursor, node) {
  if (node.nodeType !== 1) return null;
  const isCard = node.matches(ARTIFACT_CARD_SELECTOR);
  const card = isCard ? node : node.querySelector(ARTIFACT_CARD_SELECTOR);
  if (!card) return null;
  const sel = `.artifact-card[data-artifact-key="${CSS.escape(card.dataset.artifactKey)}"]`;
  for (let c = cursor; c; c = c.nextSibling) {
    if (c.nodeType !== 1 || c.tagName !== node.tagName) continue;
    if (isCard ? c.matches(sel) : !c.matches(ARTIFACT_CARD_SELECTOR) && c.querySelector(sel)) return c;
  }
  return null;
}

function syncElementAttributes(target, source) {
  for (const attr of [...target.attributes]) {
    if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
  }
  for (const attr of [...source.attributes]) {
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  }
}

// 把 parent 的子节点换成 newNodes，但内容没变的交互组件卡片原地保留：
// iframe 只要从文档里摘下来再插回去就会重新加载，所以只增删它周围的节点，不移动它本身
function replaceChildrenKeepingArtifacts(parent, newNodes) {
  let cursor = parent.firstChild;
  for (const node of newNodes) {
    // 同一位置上渲染结果完全一样的节点不动，省掉这部分的重新布局
    if (cursor && cursor.nodeType === 1 && cursor.isEqualNode(node)) {
      cursor = cursor.nextSibling;
      continue;
    }
    const kept = findReusableChild(cursor, node);
    if (!kept) {
      parent.insertBefore(node, cursor);
      continue;
    }
    while (cursor !== kept) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    cursor = kept.nextSibling;
    if (!kept.matches(ARTIFACT_CARD_SELECTOR)) {
      syncElementAttributes(kept, node);
      replaceChildrenKeepingArtifacts(kept, [...node.childNodes]);
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

function buildArtifactCardElement(artifact) {
  const card = document.createElement("div");
  card.className = "artifact-card";
  card.dataset.artifactKey = artifactCardKey(artifact);
  const url = buildArtifactUrl(artifact.artifactId);
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
    const freshUrl = buildArtifactUrl(artifact.artifactId);
    if (frame) frame.src = `${freshUrl}&t=${Date.now()}`;
  };
  card.querySelector("[data-art-open]").onclick = () => {
    window.open(buildArtifactUrl(artifact.artifactId), "_blank", "noopener");
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
    const hasText = Boolean(candidate.text && candidate.text.trim());
    const hasImages = Array.isArray(candidate.images) && candidate.images.length > 0;
    const hasFiles = Array.isArray(candidate.files) && candidate.files.length > 0;
    if ((candidate.role === "user" || candidate.role === "caller") && (hasText || hasImages || hasFiles)) {
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
  await sendStreamPrompt((sourcePrompt.text || "").trim(), streamKey, [], {
    reuseMessageId: sourcePrompt.messageId,
    replaceAssistantMessageId: messageId,
  });
}

function classifyToolSemantic(tool) {
  const kind = String(tool?.kind || "").toLowerCase();
  const title = String(tool?.title || "").toLowerCase();
  if ((Array.isArray(tool?.diffs) && tool.diffs.length > 0) || /edit|write|create|delete|remove|move|rename|apply_patch|patch/.test(kind) || /\b(write|edit|patch|replace|delete)\b/.test(title)) {
    return { badge: "修改", cls: "is-edit" };
  }
  if (/execute|bash|command|terminal|shell/.test(kind) || /\b(run_command|bash|sh|powershell|pwsh|cmd|exec)\b/.test(title)) {
    return { badge: "命令", cls: "is-exec" };
  }
  if (/read/.test(kind) || /\b(read_file|view_file|read)\b/.test(title)) {
    return { badge: "读取", cls: "is-read" };
  }
  if (/search|grep|glob|find/.test(kind) || /\b(grep|search|glob|find|rg|select-string)\b/.test(title)) {
    return { badge: "搜索", cls: "is-search" };
  }
  if (/peer|subagent/.test(kind) || /\bpeer_|dispatch|subagent/.test(title)) {
    return { badge: "子代理", cls: "is-peer" };
  }
  return { badge: "工具", cls: "is-other" };
}

function appendRenderedMarkdown(container, rawText) {
  const html = renderMarkdown(rawText);
  if (!html) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const bodyNode = tmp.firstElementChild;
  if (bodyNode && bodyNode.classList.contains("md-body")) {
    container.appendChild(bodyNode);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "md-body";
    wrap.innerHTML = html;
    container.appendChild(wrap);
  }
}

function buildToolGroupElement(tools, isMsgStreaming, groupKey) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  let totalAdded = 0;
  let totalRemoved = 0;
  let failedCount = 0;
  const catCounts = new Map();
  const running = isMsgStreaming
    ? [...tools].reverse().find((t) => t.status !== "completed" && t.status !== "failed")
    : null;

  for (const tool of tools) {
    if (tool.status === "failed") failedCount++;
    const sem = classifyToolSemantic(tool);
    catCounts.set(sem.badge, (catCounts.get(sem.badge) || 0) + 1);
    if (Array.isArray(tool.diffs)) {
      for (const d of tool.diffs) {
        const st = computeDiffStats(d.oldText || "", d.newText || "");
        totalAdded += st.added;
        totalRemoved += st.removed;
      }
    }
  }

  const groupEl = document.createElement("details");
  groupEl.className = `tool-group-card${running ? " is-running" : ""}`;
  groupEl.dataset.toolKey = groupKey;

  const summary = document.createElement("summary");
  const badgeSummary = [...catCounts.entries()].map(([k, n]) => `${k} ${n}`).join(" · ");
  const summaryLabel = running
    ? `正在执行 · ${running.title || "工具"}（第 ${tools.length} 步）`
    : `${badgeSummary}${failedCount > 0 ? ` · ${failedCount} 失败` : ""}`;
  const diffPill =
    totalAdded > 0 || totalRemoved > 0
      ? `<span class="tool-diff-stats"><span class="stat-add">+${totalAdded}</span><span class="stat-del">-${totalRemoved}</span></span>`
      : "";
  summary.innerHTML = `<span>${escapeHtml(summaryLabel)}</span>${diffPill}`;
  groupEl.appendChild(summary);

  const body = document.createElement("div");
  body.className = "tool-group-body";
  for (const tool of tools) {
    const sem = classifyToolSemantic(tool);
    const row = document.createElement("div");
    row.className = `tool-item-row${tool.status === "failed" ? " failed" : ""}`;

    let toolAdded = 0;
    let toolRemoved = 0;
    const diffs = Array.isArray(tool.diffs) ? tool.diffs : [];
    const diffStatsList = diffs.map((d) => {
      const st = computeDiffStats(d.oldText || "", d.newText || "");
      toolAdded += st.added;
      toolRemoved += st.removed;
      return st;
    });

    const head = document.createElement("div");
    head.className = "tool-item-head";
    const locHint =
      Array.isArray(tool.locations) && tool.locations.length > 0
        ? ` · ${tool.locations[0].path}`
        : "";
    head.innerHTML = `
      <span class="tool-sem-badge ${sem.cls}">${escapeHtml(sem.badge)}</span>
      <span class="tool-row-title" title="${escapeHtml((tool.title || "") + locHint)}">${escapeHtml(tool.title || "")}</span>
      ${toolAdded > 0 || toolRemoved > 0 ? `<span class="tool-diff-stats"><span class="stat-add">+${toolAdded}</span><span class="stat-del">-${toolRemoved}</span></span>` : ""}
      <span class="tool-row-status">${escapeHtml(TOOL_STATUS_TEXT[tool.status] || tool.status || "")}</span>
    `;
    row.appendChild(head);

    diffs.forEach((d, di) => {
      const st = diffStatsList[di];
      const diffDet = document.createElement("details");
      diffDet.className = "tool-diff-details";
      diffDet.dataset.toolKey = `${tool.toolCallId}:diff:${di}`;
      diffDet.innerHTML = `
        <summary>${escapeHtml(d.path || "文件变更")} (+${st.added} -${st.removed})${d.truncated ? " [截断]" : ""}</summary>
        ${renderUnifiedDiff(d.oldText || "", d.newText || "", d.path || "")}
      `;
      row.appendChild(diffDet);
    });

    if (tool.outputText && String(tool.outputText).trim()) {
      const outDet = document.createElement("details");
      outDet.className = "tool-output-details";
      outDet.dataset.toolKey = `${tool.toolCallId}:out`;
      outDet.innerHTML = `
        <summary>执行输出${tool.outputTruncated ? "（已截断）" : ""}</summary>
        <pre class="tool-output-pre"><code>${escapeHtml(tool.outputText)}</code></pre>
      `;
      row.appendChild(outDet);
    }

    body.appendChild(row);
  }
  groupEl.appendChild(body);
  return groupEl;
}

function buildMessageElement(msg, linkedTasks) {
  const entry = document.createElement("div");
  entry.className = `msg-entry role-${msg.role}${msg.status === "streaming" ? " is-streaming" : ""}`;
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
      // 只显示模型和输入/输出量；缓存、思考、首轮注入放进悬停提示
      const detail = [
        `输入 ${msg.usage.inputTokens}`,
        `缓存 ${msg.usage.cachedReadTokens}`,
        `输出 ${msg.usage.outputTokens}`,
        `思考 ${msg.usage.thoughtTokens}`,
        msg.injectedTokens > 0 ? `首轮注入 ${msg.injectedTokens}` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      const modelPart = msg.usage.modelId ? `${escapeHtml(msg.usage.modelId.split("/").pop())}　` : "";
      usageHtml = `<span class="msg-usage-pill" title="${escapeHtml(detail)}">${modelPart}${estMark}↑${formatTokens(msg.usage.inputTokens)} ↓${formatTokens(msg.usage.outputTokens)}</span>`;
    }
    meta.innerHTML = `${agentTagHtml(msg.agent, senderLabelText(msg))}<span>${formatTime(msg.timestamp)}</span>${usageHtml}`;
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
  let delegEl = null;

  if (msg.role === "assistant") {
    const artifactList = Array.isArray(msg.artifactIds)
      ? msg.artifactIds.map((id) => STATE.artifacts.get(id)).filter(Boolean)
      : [];
    const failed = isFailedAssistantMsg(msg);
    const pureErr = isPureErrorAssistantMsg(msg);
    let renderedBlocks = 0;

    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      const toolById = new Map((msg.toolCalls || []).map((t) => [t.toolCallId, t]));
      let toolBatch = [];
      let thoughtIdx = 0;
      let batchIdx = 0;

      const flushTools = () => {
        if (toolBatch.length === 0) return;
        const firstId = toolBatch[0]?.toolCallId || String(batchIdx);
        const tg = buildToolGroupElement(
          toolBatch,
          msg.status === "streaming",
          `${msg.messageId}:tg:${firstId}`,
        );
        if (tg) {
          bubble.appendChild(tg);
          renderedBlocks++;
        }
        toolBatch = [];
        batchIdx++;
      };

      for (const part of msg.parts) {
        if (part.type === "tool") {
          const tool = toolById.get(part.toolCallId);
          if (tool) toolBatch.push(tool);
          continue;
        }
        flushTools();
        if (part.type === "thought" && part.text && part.text.trim()) {
          const details = document.createElement("details");
          details.className = "thought-box";
          details.dataset.thoughtIdx = String(thoughtIdx++);
          details.innerHTML = `<summary>思考过程</summary><div class="thought-body">${escapeHtml(part.text)}</div>`;
          bubble.appendChild(details);
          renderedBlocks++;
        } else if (part.type === "text" && part.text && part.text.trim()) {
          if (pureErr || (failed && /^\s*\[Error\]/i.test(part.text))) {
            continue;
          }
          appendRenderedMarkdown(bubble, part.text);
          renderedBlocks++;
        }
      }
      flushTools();
    } else {
      if (msg.thoughtText && msg.thoughtText.trim()) {
        const details = document.createElement("details");
        details.className = "thought-box";
        details.dataset.thoughtIdx = "0";
        details.innerHTML = `<summary>思考过程</summary><div class="thought-body">${escapeHtml(msg.thoughtText)}</div>`;
        bubble.appendChild(details);
        renderedBlocks++;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const tg = buildToolGroupElement(
          msg.toolCalls,
          msg.status === "streaming",
          `${msg.messageId}:tg:0`,
        );
        if (tg) {
          bubble.appendChild(tg);
          renderedBlocks++;
        }
      }

      if (msg.text && msg.text.trim() && !pureErr && !(failed && /^\s*\[Error\]/i.test(msg.text))) {
        appendRenderedMarkdown(bubble, msg.text);
        renderedBlocks++;
      }
    }

    if (failed) {
      const errCard = document.createElement("div");
      errCard.className = "msg-error-card";
      const errDisplayText = (msg.text || "").trim() || "会话执行失败";
      errCard.innerHTML = `
        <div class="msg-error-head">
          <span>执行失败</span>
          ${canRegen ? `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-regen-msg="${escapeHtml(msg.messageId)}">重试</button>` : ""}
        </div>
        <pre class="msg-error-text">${escapeHtml(errDisplayText)}</pre>
      `;
      bubble.appendChild(errCard);
      renderedBlocks++;
    }

    if (renderedBlocks === 0 && artifactList.length === 0) {
      const body = document.createElement("div");
      body.className = "md-body";
      if (msg.status === "streaming") {
        // 高思考强度下第一句话可能要等几分钟；显示已等多久，免得看起来像卡住
        body.innerHTML = `<span class="msg-waiting is-thinking"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>思考中 <span class="msg-elapsed" data-since="${Number(msg.timestamp) || Date.now()}"></span></span>`;
      } else {
        body.innerHTML =
          msg.status === "cancelled"
            ? '<span class="msg-waiting">已停止，没有输出</span>'
            : '<span class="msg-waiting">没有文字输出</span>';
      }
      bubble.appendChild(body);
    }

    for (const art of artifactList) {
      bubble.appendChild(buildArtifactCardElement(art));
    }

    if (linkedTasks.length > 0) {
      // 同一个子会话被调用多次只占一行，状态取最近一次；不再每次调用出一张卡片
      const bySession = new Map();
      for (const task of linkedTasks) {
        const entryForSession = bySession.get(task.targetSessionKey) || [];
        entryForSession.push(task);
        bySession.set(task.targetSessionKey, entryForSession);
      }
      delegEl = document.createElement("div");
      delegEl.className = "delegation-strip";
      for (const [sessionKey, tasks] of bySession) {
        const latest = tasks[tasks.length - 1];
        const active = tasks.some((t) => t.status === "running" || t.status === "queued");
        const status = active ? (tasks.some((t) => t.status === "running") ? "running" : "queued") : latest.status;
        const subSess = STATE.sessions.get(sessionKey);
        const label = subSess?.label || sessionKey.split("__sub__")[1] || sessionKey;
        const row = document.createElement("div");
        row.className = "delegation-card";
        // 按钮回调绑定的是这个子会话；写进 DOM 后，节点相等才意味着回调也等价（见 replaceChildrenKeepingArtifacts）
        row.dataset.sessionKey = sessionKey;
        row.innerHTML = `
          <div class="delegation-info">
            <span class="dot ${escapeHtml(status)}"></span>
            ${agentTagHtml(latest.targetAgent)}
            <span class="delegation-label">${escapeHtml(label)}</span>
            <span class="delegation-status">${escapeHtml(TASK_STATUS_TEXT[status] || status)}${tasks.length > 1 ? `，共 ${tasks.length} 次调用` : ""}</span>
          </div>
        `;
        const delActions = document.createElement("div");
        delActions.className = "delegation-actions";
        if (active) {
          const stopTaskBtn = document.createElement("button");
          stopTaskBtn.type = "button";
          stopTaskBtn.className = "alma-btn alma-btn-danger alma-btn-sm";
          stopTaskBtn.textContent = "停止";
          stopTaskBtn.onclick = () => void cancelSession(sessionKey);
          delActions.appendChild(stopTaskBtn);
        }
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "alma-btn alma-btn-sm";
        openBtn.textContent = "查看";
        openBtn.onclick = () => selectGroup(latest.groupId, `sub:${sessionKey}`);
        delActions.appendChild(openBtn);
        row.appendChild(delActions);
        if (subSess?.isWorktree) {
          row.appendChild(
            buildWorktreeBarElement(sessionKey, subSess.branch || subSess.effectiveCwd),
          );
        }
        delegEl.appendChild(row);
      }
    }
  } else {
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      const imgGrid = document.createElement("div");
      imgGrid.className = "msg-image-grid";
      for (const img of msg.images) {
        const link = document.createElement("a");
        link.href = img.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "msg-image-link";
        link.title = img.name || "查看原图";
        const elImg = document.createElement("img");
        elImg.src = img.url;
        elImg.alt = img.name || "uploaded image";
        elImg.className = "msg-image-thumb";
        elImg.loading = "lazy";
        link.appendChild(elImg);
        imgGrid.appendChild(link);
      }
      bubble.appendChild(imgGrid);
    }
    if (Array.isArray(msg.files) && msg.files.length > 0) {
      const fileList = document.createElement("div");
      fileList.className = "msg-file-list";
      for (const f of msg.files) {
        const chip = document.createElement("span");
        chip.className = "msg-file-chip";
        chip.title = f.localPath || f.name;
        chip.textContent = `${f.name} · ${formatFileSize(f.sizeBytes)}`;
        fileList.appendChild(chip);
      }
      bubble.appendChild(fileList);
    }
    if (msg.text && msg.text.trim()) {
      const pre = document.createElement("div");
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = msg.text;
      bubble.appendChild(pre);
    }
  }

  entry.appendChild(meta);
  entry.appendChild(bubble);
  if (delegEl) entry.appendChild(delegEl);
  const wfCard = buildWorkflowCardElement(msg);
  if (wfCard) entry.appendChild(wfCard);
  return entry;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m} 分 ${String(sec).padStart(2, "0")} 秒` : `${sec} 秒`;
}

function tickElapsedLabels() {
  const now = Date.now();
  document.querySelectorAll(".msg-elapsed[data-since]").forEach((el) => {
    el.textContent = formatElapsed(now - Number(el.dataset.since));
  });
}
setInterval(tickElapsedLabels, 1000);

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
  const hasContent = els.messages.querySelector(".msg-entry, .retry-fold") !== null;
  els.jumpLatestBtn.hidden = !hasContent || isMessagesNearBottom();
}

function collectDetailsState(rootEl, thoughtStates, toolOpenStates) {
  for (const box of rootEl.querySelectorAll("details.thought-box")) {
    const id = box.closest("[data-message-id]")?.dataset.messageId;
    if (!id) continue;
    const tKey = `${id}:${box.dataset.thoughtIdx || "0"}`;
    thoughtStates.set(tKey, {
      open: box.open,
      scrollTop: box.querySelector(".thought-body")?.scrollTop || 0,
    });
  }
  for (const det of rootEl.querySelectorAll("details[data-tool-key]")) {
    if (det.dataset.toolKey) {
      toolOpenStates.set(det.dataset.toolKey, det.open);
    }
  }
}

function restoreDetailsStateInto(rootEl, messageId, thoughtStates, toolOpenStates) {
  for (const box of rootEl.querySelectorAll("details.thought-box")) {
    const tKey = `${messageId}:${box.dataset.thoughtIdx || "0"}`;
    if (thoughtStates.get(tKey)?.open) {
      box.open = true;
    }
  }
  for (const det of rootEl.querySelectorAll("details[data-tool-key]")) {
    if (toolOpenStates.get(det.dataset.toolKey)) {
      det.open = true;
    }
  }
}

function restoreThoughtScrollPositions(thoughtStates) {
  for (const [tKey, prev] of thoughtStates) {
    if (!prev.open || !prev.scrollTop) continue;
    const sep = tKey.lastIndexOf(":");
    const id = sep >= 0 ? tKey.slice(0, sep) : tKey;
    const idx = sep >= 0 ? tKey.slice(sep + 1) : "0";
    const body = els.messages.querySelector(
      `[data-message-id="${CSS.escape(id)}"] details.thought-box[data-thought-idx="${CSS.escape(idx)}"] .thought-body`,
    );
    if (body) body.scrollTop = prev.scrollTop;
  }
}

function renderMessages() {
  const group = getActiveGroup();
  const list = STATE.messagesByStream.get(STATE.activeStreamKey) || [];
  const streamChanged = lastRenderedStreamKey !== STATE.activeStreamKey;
  const stick = streamChanged || isMessagesNearBottom();
  const prevScrollTop = els.messages.scrollTop;
  lastRenderedStreamKey = STATE.activeStreamKey;

  if (list.length === 0) {
    els.messages.innerHTML = "";
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

  // 整体重建前记下思考框、工具折叠、失败重试折叠的展开状态与滚动位置（切换会话流时不需要）
  const thoughtStates = new Map();
  const toolOpenStates = new Map();
  const retryFoldStates = new Map();
  if (!streamChanged) {
    collectDetailsState(els.messages, thoughtStates, toolOpenStates);
    for (const fold of els.messages.querySelectorAll("details.retry-fold[data-fold-key]")) {
      if (fold.dataset.foldKey) {
        retryFoldStates.set(fold.dataset.foldKey, fold.open);
      }
    }
  }

  const partitioned = partitionMessagesForDisplay(list);
  const fresh = [];
  for (const item of partitioned) {
    if (item.kind === "retry-fold") {
      const foldEl = document.createElement("details");
      foldEl.className = "retry-fold";
      foldEl.dataset.foldKey = item.key;
      if (retryFoldStates.get(item.key)) foldEl.open = true;
      const agentsText = item.agents.length > 0 ? item.agents.map((a) => agentName(a)).join(" / ") : "会话";
      const summaryEl = document.createElement("summary");
      summaryEl.className = "retry-fold-summary";
      summaryEl.innerHTML = `
        <span class="retry-fold-badge">已自动折叠 ${item.attempts} 次失败重试</span>
        <span class="retry-fold-meta">${escapeHtml(`${agentsText} · ${item.lastErrorSummary}`)}</span>
      `;
      const bodyEl = document.createElement("div");
      bodyEl.className = "retry-fold-body";
      for (const subMsg of item.messages) {
        const subEl = buildMessageElement(subMsg, []);
        restoreDetailsStateInto(subEl, subMsg.messageId, thoughtStates, toolOpenStates);
        bodyEl.appendChild(subEl);
      }
      foldEl.appendChild(summaryEl);
      foldEl.appendChild(bodyEl);
      fresh.push(foldEl);
      continue;
    }

    const msg = item.message;
    const i = item.index;
    const nextAssistant = list.slice(i + 1).find((m) => m.role === "assistant");
    const linkedTasks = matchTasksForAssistantMessage(msg, nextAssistant?.timestamp);
    const el = buildMessageElement(msg, linkedTasks);
    restoreDetailsStateInto(el, msg.messageId, thoughtStates, toolOpenStates);
    fresh.push(el);
  }
  replaceChildrenKeepingArtifacts(els.messages, fresh);
  restoreThoughtScrollPositions(thoughtStates);
  if (stick) {
    scrollMessagesToBottom();
  } else {
    els.messages.scrollTop = prevScrollTop;
    updateJumpLatestBtn();
  }
}

// 从工具调用里取出涉及的文件：优先用 ACP 的 locations，其次看入参里常见的路径字段
const TOOL_PATH_KEYS = ["file_path", "filePath", "path", "abs_path", "absolute_path", "notebook_path", "target_file", "filename"];
const TOOL_WRITE_RE = /^(edit|write|create|update|delete|remove|move|rename|apply_patch|multiedit|str_replace|patch)/i;

function collectSessionFiles(streamKey, cwd) {
  const files = new Map();
  const base = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const msg of STATE.messagesByStream.get(streamKey) || []) {
    for (const tool of msg.toolCalls || []) {
      const paths = [];
      for (const loc of tool.locations || []) {
        if (loc && typeof loc.path === "string") paths.push(loc.path);
      }
      if (paths.length === 0 && tool.rawInput && typeof tool.rawInput === "object") {
        for (const key of TOOL_PATH_KEYS) {
          const v = tool.rawInput[key];
          if (typeof v === "string" && v.trim()) paths.push(v.trim());
        }
      }
      const changed =
        ["edit", "delete", "move"].includes(tool.kind) || TOOL_WRITE_RE.test(String(tool.title || "").trim());
      for (const raw of paths) {
        const norm = raw.replace(/\\/g, "/");
        const key = norm.toLowerCase();
        const rel = base && key.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm;
        const prev = files.get(key);
        files.set(key, { path: raw, rel, changed: Boolean(prev?.changed) || changed, count: (prev?.count || 0) + 1 });
      }
    }
  }
  return [...files.values()].sort((x, y) => Number(y.changed) - Number(x.changed) || x.rel.localeCompare(y.rel));
}

const PROGRESS_STATUS = {
  completed: { mark: "✓", text: "完成" },
  in_progress: { mark: "●", text: "进行中" },
  blocked: { mark: "!", text: "受阻" },
  pending: { mark: "○", text: "未开始" },
};

// 进度：Agent 用 progress_update 维护的目标和步骤；没有时退回显示当前会话自己上报的计划
function renderInspectorProgress(group, activeSession) {
  if (!els.inspProgress) return;
  els.inspProgress.innerHTML = "";
  const progress = STATE.progress.get(group.groupId);
  const plan = Array.isArray(activeSession?.plan) ? activeSession.plan : [];
  const items =
    progress && progress.items.length > 0
      ? progress.items
      : plan.map((p) => ({ title: p.content, status: p.status }));
  const done = items.filter((i) => i.status === "completed").length;
  els.inspProgressCount.textContent = items.length > 0 ? `${done}/${items.length}` : "";

  if (!progress?.goal && !progress?.summary && items.length === 0) {
    els.inspProgress.appendChild(inspEmpty("任务分成多步时，Agent 会在这里更新目标和进度"));
    return;
  }

  const box = document.createElement("div");
  box.className = "insp-progress";
  if (progress?.goal) {
    const goal = document.createElement("div");
    goal.className = "insp-goal";
    goal.textContent = progress.goal;
    box.appendChild(goal);
  }
  if (items.length > 0) {
    const bar = document.createElement("div");
    bar.className = "window-meter";
    bar.innerHTML = `<div class="window-meter-fill" style="width:${Math.round((done / items.length) * 100)}%"></div>`;
    box.appendChild(bar);
  }
  if (progress?.summary) {
    const summary = document.createElement("div");
    summary.className = "insp-progress-summary";
    summary.textContent = progress.summary;
    box.appendChild(summary);
  }
  for (const item of items) {
    const meta = PROGRESS_STATUS[item.status] || PROGRESS_STATUS.pending;
    const row = document.createElement("div");
    row.className = `insp-step status-${item.status}`;
    row.title = meta.text;
    const mark = document.createElement("span");
    mark.className = "insp-step-mark";
    mark.textContent = meta.mark;
    const body = document.createElement("div");
    body.className = "insp-step-body";
    const title = document.createElement("div");
    title.className = "insp-step-title";
    title.textContent = item.title;
    body.appendChild(title);
    if (item.note) {
      const note = document.createElement("div");
      note.className = "insp-step-note";
      note.textContent = item.note;
      body.appendChild(note);
    }
    row.appendChild(mark);
    row.appendChild(body);
    box.appendChild(row);
  }
  const foot = document.createElement("div");
  foot.className = "insp-meta";
  foot.textContent = progress
    ? `${progress.updatedBy && progress.updatedBy !== "user" ? `${progress.updatedBy} ` : ""}更新于 ${formatTime(progress.updatedAt)}`
    : "来自这个会话自己的计划";
  box.appendChild(foot);
  els.inspProgress.appendChild(box);
}

function inspEmpty(text) {
  const p = document.createElement("div");
  p.className = "insp-empty";
  p.textContent = text;
  return p;
}

// 右侧面板只讲「当前这个会话」：它的上下文、它派出的子代理、它碰过的文件、任务里的产物
function renderInspector() {
  const group = getActiveGroup();
  if (!group || !els.inspContext) return;

  const sessions = getGroupSessions(group.groupId);
  const subMode = isSubStream(STATE.activeStreamKey);
  const activeKey = activeSessionKeyForCurrentView();
  const active = STATE.sessions.get(activeKey);
  const subs = sessions.filter((s) => s.role !== "lead");

  // 标题：正在看的是谁
  els.inspHead.innerHTML = `
    ${agentTagHtml(active?.agent || group.leadAgent)}
    <span class="insp-head-name">${escapeHtml(subMode ? active?.label || active?.name || "子会话" : "主导会话")}</span>
    <span class="insp-head-status">${active ? escapeHtml(isSessionRunning(activeKey) ? "进行中" : SESSION_STATUS_TEXT[active.status] || active.status) : "未启动"}</span>
  `;

  renderInspectorProgress(group, active);

  // 上下文
  els.inspContext.innerHTML = "";
  if (!active) {
    els.inspContext.appendChild(inspEmpty("发出第一条消息后显示"));
  } else {
    const cb = active.contextBreakdown || {};
    const rules = cb.sharedRulesTokens || 0;
    const skills = cb.skillsIndexTokens || 0;
    const handoff = cb.handoffTokens || 0;
    const dialog = (cb.userPromptsTokens || 0) + (cb.agentOutputsTokens || 0);
    const known = rules + skills + handoff + dialog;
    const winUsed = active.usage?.usedTokens || 0;
    const winMax = active.usage?.maxTokens || 0;
    const other = winUsed > known ? winUsed - known : 0;
    const used = winUsed > 0 ? Math.max(winUsed, known) : known;
    const scale = winMax > 0 ? winMax : Math.max(1, used);
    const seg = (cls, v) => (v > 0 ? `<div class="${cls}" style="width:${((v / scale) * 100).toFixed(2)}%"></div>` : "");
    const rows = [
      ["seg-rules", "规则", rules],
      ["seg-skills", "技能索引", skills],
      ["seg-handoff", "交接", handoff],
      ["seg-dialog", "对话", dialog],
      ["seg-other", "工具与其他", other],
    ].filter(([, , v]) => v > 0);
    const box = document.createElement("div");
    box.className = "insp-ctx";
    box.innerHTML = `
      <div class="insp-ctx-top">
        <strong>${formatTokens(used)}</strong>
        <span>${winMax > 0 ? `/ ${formatTokens(winMax)} tok（${Math.round((used / winMax) * 100)}%）` : "tok"}</span>
      </div>
      <div class="stacked-bar">${seg("seg-rules", rules)}${seg("seg-skills", skills)}${seg("seg-handoff", handoff)}${seg("seg-dialog", dialog)}${seg("seg-other", other)}</div>
      <div class="insp-ctx-legend">${rows.map(([cls, label, v]) => `<span><i class="legend-dot ${cls}"></i>${label}</span><span>${formatTokens(v)}</span>`).join("")}</div>
      ${active.currentModelId ? `<div class="insp-meta">${escapeHtml(active.currentModelId)}${active.currentEffort ? ` · ${escapeHtml(active.currentEffort)}` : ""}</div>` : ""}
      ${active.branch ? `<div class="insp-meta">分支 ${escapeHtml(active.branch)}</div>` : ""}
    `;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "insp-link-row";
    more.innerHTML = '<span>上下文分析</span><span class="insp-link-arrow">›</span>';
    more.onclick = () => setStageView("telemetry");
    box.appendChild(more);
    els.inspContext.appendChild(box);
  }

  // 子代理：主导一行在上，子会话缩进在下；每个子会话带调用次数和最近一次委派内容
  els.inspSessionCount.textContent = String(subs.length);
  els.inspSessions.innerHTML = "";
  if (subs.length === 0) {
    els.inspSessions.appendChild(inspEmpty("主导还没有委派子代理"));
  } else {
    const tasksBySession = new Map();
    for (const t of getGroupTasks(group.groupId)) {
      const list = tasksBySession.get(t.targetSessionKey) || [];
      list.push(t);
      tasksBySession.set(t.targetSessionKey, list);
    }
    const leadRow = document.createElement("button");
    leadRow.type = "button";
    leadRow.className = `insp-agent-row${subMode ? "" : " active"}`;
    leadRow.innerHTML = `<span class="dot ${isGroupBusy(group.groupId) ? "busy" : "idle"}"></span>${agentTagHtml(group.leadAgent)}<span class="insp-agent-name">主导</span>`;
    leadRow.onclick = () => selectGroup(group.groupId, `lead:${group.groupId}`);
    els.inspSessions.appendChild(leadRow);
    for (const sub of subs) {
      const running = isSessionRunning(sub.sessionKey);
      const tasks = tasksBySession.get(sub.sessionKey) || [];
      const last = tasks[tasks.length - 1];
      const row = document.createElement("div");
      row.className = `insp-agent-row is-sub${STATE.activeStreamKey === `sub:${sub.sessionKey}` ? " active" : ""}`;
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="insp-agent-line">
          <span class="dot ${running ? "busy" : escapeHtml(sub.status)}"></span>
          ${agentTagHtml(sub.agent)}
          <span class="insp-agent-name">${escapeHtml(sub.label || sub.name)}</span>
          <span class="insp-agent-status">${escapeHtml(running ? "进行中" : SESSION_STATUS_TEXT[sub.status] || sub.status)}${tasks.length > 1 ? ` · ${tasks.length} 次` : ""}</span>
        </div>
        ${last?.prompt ? `<div class="insp-agent-prompt">${escapeHtml(last.prompt)}</div>` : ""}
      `;
      row.onclick = () => selectGroup(group.groupId, `sub:${sub.sessionKey}`);
      if (running) {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "alma-btn alma-btn-danger alma-btn-sm";
        stop.textContent = "停止";
        stop.onclick = (e) => {
          e.stopPropagation();
          void cancelSession(sub.sessionKey);
        };
        row.querySelector(".insp-agent-line").appendChild(stop);
      }
      els.inspSessions.appendChild(row);
    }
  }

  // 文件：这个会话的工具调用碰过的文件，改过的排前面
  const files = collectSessionFiles(STATE.activeStreamKey, active?.effectiveCwd || group.cwd);
  els.inspFileCount.textContent = String(files.length);
  els.inspFiles.innerHTML = "";
  if (files.length === 0) {
    els.inspFiles.appendChild(inspEmpty("这个会话还没有读写文件"));
  } else {
    for (const f of files.slice(0, 60)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `insp-file${f.changed ? " changed" : ""}`;
      row.title = `${f.path}\n点击复制路径`;
      const slash = f.rel.lastIndexOf("/");
      row.innerHTML = `
        <span class="insp-file-mark">${f.changed ? "改" : "读"}</span>
        <span class="insp-file-name">${escapeHtml(slash >= 0 ? f.rel.slice(slash + 1) : f.rel)}</span>
        <span class="insp-file-dir">${escapeHtml(slash >= 0 ? f.rel.slice(0, slash) : "")}</span>
      `;
      row.onclick = () => {
        void navigator.clipboard?.writeText(f.path).then(() => appendLog(`已复制路径: ${f.path}`));
      };
      els.inspFiles.appendChild(row);
    }
    if (files.length > 60) els.inspFiles.appendChild(inspEmpty(`还有 ${files.length - 60} 个文件未列出`));
  }

  // 产物：这个任务里 Agent 生成的交互组件
  const artifacts = [...STATE.artifacts.values()]
    .filter((a) => a.groupId === group.groupId)
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  els.inspArtifactCount.textContent = String(artifacts.length);
  els.inspArtifacts.innerHTML = "";
  if (artifacts.length === 0) {
    els.inspArtifacts.appendChild(inspEmpty("还没有产物"));
  } else {
    for (const art of artifacts) {
      const link = document.createElement("a");
      link.className = "insp-file";
      link.href = buildArtifactUrl(art.artifactId);
      link.target = "_blank";
      link.rel = "noopener";
      link.title = "在新窗口打开";
      link.innerHTML = `
        <span class="insp-file-mark">${escapeHtml(String(art.kind || "html").toUpperCase().slice(0, 4))}</span>
        <span class="insp-file-name">${escapeHtml(art.title || art.artifactId)}</span>
      `;
      els.inspArtifacts.appendChild(link);
    }
  }
}

const SESSION_STATUS_TEXT = { starting: "启动中", idle: "空闲", busy: "进行中", error: "出错", closed: "已关闭" };

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
    if (els.portBadge.parentElement) els.portBadge.parentElement.title = activePort ? `当前监听端口 ${activePort}` : "";
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

const pendingStreamDomMap = new Map();
let streamDomRafId = 0;

function scheduleStreamingMessageDom(msg) {
  if (!msg || msg.streamKey !== STATE.activeStreamKey) return;
  pendingStreamDomMap.set(msg.messageId, msg);
  if (streamDomRafId) return;
  streamDomRafId = nextFrameOrSoon(() => {
    streamDomRafId = 0;
    const batch = [...pendingStreamDomMap.values()];
    pendingStreamDomMap.clear();
    for (const item of batch) {
      updateStreamingMessageDom(item);
    }
  });
}

// 流式过程中 session_updated / task_updated 很密：状态同步更新，各区域的 DOM 重绘合并到下一帧，
// 同一帧内每个区域最多重绘一次
const UI_REGION = {
  sidebar: 1,
  header: 2,
  inspector: 4,
  metrics: 8,
  messages: 16,
  stateChange: 32,
};
let pendingUiRegions = 0;
let uiRegionRafId = 0;

// 窗口在后台时浏览器会暂停 requestAnimationFrame，界面就停在旧状态；
// 所以同时挂一个定时器兜底，谁先到谁执行，只执行一次。
function nextFrameOrSoon(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(run);
  setTimeout(run, 300);
  return 1;
}

function scheduleUiRender(regions) {
  pendingUiRegions |= regions;
  if (uiRegionRafId) return;
  uiRegionRafId = nextFrameOrSoon(() => {
    uiRegionRafId = 0;
    const regionsToRender = pendingUiRegions;
    pendingUiRegions = 0;
    if (regionsToRender & UI_REGION.sidebar) renderSidebarGroups();
    if (regionsToRender & UI_REGION.header) renderStageHeaderAndTabs();
    if (regionsToRender & UI_REGION.inspector) renderInspector();
    if (regionsToRender & UI_REGION.metrics) refreshHeaderMetrics();
    if (regionsToRender & UI_REGION.messages) {
      // 整体重绘已经包含排队中的流式更新，不用再逐条重建
      pendingStreamDomMap.clear();
      renderMessages();
    }
    if (regionsToRender & UI_REGION.stateChange) window.HUB_APP?.onStateChange?.();
  });
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
  const thoughtStates = new Map();
  const toolOpenStates = new Map();
  collectDetailsState(existing, thoughtStates, toolOpenStates);
  restoreDetailsStateInto(fresh, msg.messageId, thoughtStates, toolOpenStates);
  const stick = isMessagesNearBottom();
  if (findReusableChild(existing, fresh) === existing) {
    // 消息里有内容没变的交互组件：原地更新，避免 iframe 重新加载
    syncElementAttributes(existing, fresh);
    replaceChildrenKeepingArtifacts(existing, [...fresh.childNodes]);
  } else {
    existing.replaceWith(fresh);
  }
  restoreThoughtScrollPositions(thoughtStates);
  if (stick) {
    scrollMessagesToBottom();
  } else {
    updateJumpLatestBtn();
  }
}

const ALLOWED_COMPOSER_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_COMPOSER_IMAGES = 6;
const MAX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_COMPOSER_FILES = 10;
const MAX_COMPOSER_FILE_BYTES = 12 * 1024 * 1024;

function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round((bytes || 0) / 1024))} KB`;
}

function getActiveImageDrafts(streamKey = STATE.activeStreamKey) {
  return STATE.imageDraftsByStream.get(streamKey) || [];
}

function renderComposerAttachments() {
  if (!els.composerAttachments) return;
  const list = getActiveImageDrafts();
  els.composerAttachments.innerHTML = "";
  if (list.length === 0) {
    els.composerAttachments.hidden = true;
    return;
  }
  els.composerAttachments.hidden = false;
  for (const img of list) {
    const chip = document.createElement("div");
    chip.className = img.isFile ? "composer-file-chip" : "composer-img-chip";
    chip.innerHTML = img.isFile
      ? `
      <span class="composer-img-name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
      <span class="composer-img-size mono">${formatFileSize(img.sizeBytes)}</span>
    `
      : `
      <img class="composer-img-thumb" src="${escapeHtml(img.dataUrl)}" alt="${escapeHtml(img.name)}" />
      <div class="composer-img-meta">
        <span class="composer-img-name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
        <span class="composer-img-size mono">${formatFileSize(img.sizeBytes)}</span>
      </div>
    `;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "composer-img-remove";
    rm.title = "移除";
    rm.textContent = "×";
    rm.onclick = () => {
      const next = getActiveImageDrafts().filter((item) => item.id !== img.id);
      if (next.length > 0) {
        STATE.imageDraftsByStream.set(STATE.activeStreamKey, next);
      } else {
        STATE.imageDraftsByStream.delete(STATE.activeStreamKey);
      }
      renderComposerAttachments();
    };
    chip.appendChild(rm);
    els.composerAttachments.appendChild(chip);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function addImageFilesToComposer(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (files.length === 0 || !STATE.activeStreamKey) return;
  const current = [...getActiveImageDrafts()];
  const skipped = [];
  for (const file of files) {
    const mimeType = (file.type || "").toLowerCase();
    if (!ALLOWED_COMPOSER_IMAGE_MIMES.has(mimeType)) {
      // 不是图片：作为文件附件，Agent 会从本地路径读取
      if (current.filter((d) => d.isFile).length >= MAX_COMPOSER_FILES) {
        skipped.push(`${file.name}（一次最多 ${MAX_COMPOSER_FILES} 个文件）`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_COMPOSER_FILE_BYTES) {
        skipped.push(`${file.name}（${file.size === 0 ? "空文件或文件夹" : "超过 12MB"}）`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const commaIdx = dataUrl.indexOf(",");
        current.push({
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          isFile: true,
          name: file.name || "file",
          mimeType,
          base64: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
          sizeBytes: file.size,
        });
      } catch (err) {
        skipped.push(`${file.name}（${err.message}）`);
      }
      continue;
    }
    if (current.filter((d) => !d.isFile).length >= MAX_COMPOSER_IMAGES) {
      skipped.push(`${file.name}（一次最多 ${MAX_COMPOSER_IMAGES} 张图片）`);
      continue;
    }
    if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
      appendLog(`图片 "${file.name}" 超过 10MB 上限，已跳过`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const commaIdx = dataUrl.indexOf(",");
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      current.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name || `screenshot-${current.length + 1}.${mimeType.split("/")[1] || "png"}`,
        mimeType,
        dataUrl,
        base64,
        sizeBytes: file.size,
      });
    } catch (err) {
      appendLog(`读取图片失败: ${err.message}`);
    }
  }
  STATE.imageDraftsByStream.set(STATE.activeStreamKey, current);
  renderComposerAttachments();
  if (skipped.length > 0) {
    void showConfirmModal({
      title: "有文件没有加上",
      message: skipped.join("\n"),
      confirmText: "知道了",
    });
  }
}

async function sendStreamPrompt(prompt, targetStreamKey, images = [], options = {}) {
  const cleanPrompt = (prompt || "").trim();
  const allAttachments = Array.isArray(images) ? images : [];
  const cleanImages = allAttachments.filter((a) => !a.isFile);
  const cleanFiles = allAttachments.filter((a) => a.isFile);
  const reuseMessageId =
    typeof options?.reuseMessageId === "string" && options.reuseMessageId ? options.reuseMessageId : undefined;
  const replaceAssistantMessageId =
    typeof options?.replaceAssistantMessageId === "string" && options.replaceAssistantMessageId
      ? options.replaceAssistantMessageId
      : undefined;
  if ((!cleanPrompt && allAttachments.length === 0 && !reuseMessageId) || !targetStreamKey) return;
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
      ? { sessionKey: targetSessionKey, prompt: cleanPrompt }
      : { groupId: targetGroupId, prompt: cleanPrompt };
    if (reuseMessageId) {
      payload.reuseMessageId = reuseMessageId;
    }
    if (replaceAssistantMessageId) {
      payload.replaceAssistantMessageId = replaceAssistantMessageId;
    }
    if (cleanImages.length > 0) {
      payload.images = cleanImages.map((img) => ({
        name: img.name,
        mimeType: img.mimeType,
        data: img.base64,
      }));
    }
    if (cleanFiles.length > 0) {
      payload.files = cleanFiles.map((f) => ({ name: f.name, mimeType: f.mimeType || undefined, data: f.base64 }));
    }
    if (options.steer) payload.steer = true;
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
    // 会话状态的更新可能稍晚到；稍等一下再看要不要送出排队的消息
    setTimeout(() => flushQueue(targetStreamKey), 150);
  }
}

function streamSessionKey(streamKey) {
  if (isSubStream(streamKey)) return streamKey.slice(4);
  const group = STATE.taskGroups.get(streamKey.slice(5));
  return group ? `${group.leadAgent}:${group.groupId}__lead` : null;
}

function isStreamBusy(streamKey) {
  return STATE.sendingStreams.has(streamKey) || isSessionRunning(streamSessionKey(streamKey));
}

// 排队：这一轮还没结束时发的消息先放着，结束后按顺序送出。只在本页面里，刷新会清空
function getQueue(streamKey) {
  return STATE.queuedByStream.get(streamKey) || [];
}

function renderComposerQueue() {
  if (!els.composerQueue) return;
  const queue = getQueue(STATE.activeStreamKey);
  els.composerQueue.innerHTML = "";
  els.composerQueue.hidden = queue.length === 0;
  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `queue-item${item.steer ? " is-steer" : ""}`;
    const tag = document.createElement("span");
    tag.className = "queue-tag";
    tag.textContent = item.steer ? "引导" : `排队 ${index + 1}`;
    const text = document.createElement("span");
    text.className = "queue-text";
    text.textContent = item.prompt || `${item.attachments.length} 个附件`;
    text.title = item.prompt;
    row.appendChild(tag);
    row.appendChild(text);
    if (item.attachments.length > 0 && item.prompt) {
      const att = document.createElement("span");
      att.className = "queue-att";
      att.textContent = `${item.attachments.length} 个附件`;
      row.appendChild(att);
    }
    if (!item.steer) {
      const steer = document.createElement("button");
      steer.type = "button";
      steer.className = "mini-icon-btn";
      steer.title = "不等了：打断当前这一轮，立刻用这条消息引导";
      steer.textContent = "↑";
      steer.onclick = () => steerWithQueued(STATE.activeStreamKey, item.id);
      row.appendChild(steer);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-icon-btn";
    remove.title = "取消这条";
    remove.textContent = "×";
    remove.onclick = () => {
      STATE.queuedByStream.set(STATE.activeStreamKey, getQueue(STATE.activeStreamKey).filter((q) => q.id !== item.id));
      renderComposerQueue();
    };
    row.appendChild(remove);
    els.composerQueue.appendChild(row);
  });
}

function enqueuePrompt(streamKey, prompt, attachments, steer) {
  const item = { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, prompt, attachments, steer };
  const queue = getQueue(streamKey);
  // 引导要抢在排队的消息前面
  STATE.queuedByStream.set(streamKey, steer ? [item, ...queue.filter((q) => !q.steer)] : [...queue, item]);
  renderComposerQueue();
}

// 这一轮结束了就把队首送出去。发送本身会再次触发这里，所以队列是一条一条排空的
function flushQueue(streamKey) {
  const queue = getQueue(streamKey);
  if (queue.length === 0 || isStreamBusy(streamKey)) return;
  const [next, ...rest] = queue;
  STATE.queuedByStream.set(streamKey, rest);
  renderComposerQueue();
  void sendStreamPrompt(next.prompt, streamKey, next.attachments, { steer: next.steer });
}

// 引导：打断当前这一轮，等它停下后把这条消息作为引导送出
function steerWithQueued(streamKey, itemId) {
  const queue = getQueue(streamKey);
  const item = queue.find((q) => q.id === itemId);
  if (!item) return;
  item.steer = true;
  STATE.queuedByStream.set(streamKey, [item, ...queue.filter((q) => q.id !== itemId && !q.steer)]);
  renderComposerQueue();
  if (isStreamBusy(streamKey)) {
    void cancelSession(streamSessionKey(streamKey));
  } else {
    flushQueue(streamKey);
  }
}

async function sendPrompt(options = {}) {
  const prompt = els.promptInput.value.trim();
  const group = getActiveGroup();
  const targetStreamKey = STATE.activeStreamKey;
  const images = [...getActiveImageDrafts(targetStreamKey)];
  if ((!prompt && images.length === 0) || !group) return;

  els.promptInput.value = "";
  els.promptInput.style.height = "52px";
  closeComposerSuggest();
  STATE.draftsByStream.delete(targetStreamKey);
  STATE.imageDraftsByStream.delete(targetStreamKey);
  renderComposerAttachments();

  if (isStreamBusy(targetStreamKey)) {
    enqueuePrompt(targetStreamKey, prompt, images, Boolean(options.steer));
    if (options.steer) void cancelSession(streamSessionKey(targetStreamKey));
    return;
  }
  await sendStreamPrompt(prompt, targetStreamKey, images);
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

// 与后端断开时：只记一条日志，超过几秒还没连上就在页面顶部明说，连上后自动消失。
// 后端崩溃由守护进程自动重启，页面这边只管不停重试。
const CONN = { lostAt: 0, bannerTimer: null };

function renderConnBanner() {
  let banner = document.getElementById("connBanner");
  if (!CONN.lostAt) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "connBanner";
    banner.className = "conn-banner";
    banner.setAttribute("role", "status");
    document.body.appendChild(banner);
  }
  const secs = Math.round((Date.now() - CONN.lostAt) / 1000);
  banner.textContent =
    secs < 60
      ? `与后端的连接断开了，正在重连（${secs} 秒）。后端如果是意外退出，会自动重启并恢复任务记录。`
      : `已经 ${Math.floor(secs / 60)} 分钟连不上后端。请重新启动 RoundTable Meeting，任务记录会保留；原因可查看数据目录下的 crash.log。`;
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    els.wsDot.classList.add("ok");
    els.wsDot.title = "WebSocket 已连接";
    if (CONN.lostAt) {
      appendLog(`已重新连接后端（中断 ${Math.round((Date.now() - CONN.lostAt) / 1000)} 秒）`);
    } else {
      appendLog("WebSocket 已连接");
    }
    CONN.lostAt = 0;
    clearInterval(CONN.bannerTimer);
    CONN.bannerTimer = null;
    renderConnBanner();
  };
  ws.onclose = () => {
    els.wsDot.classList.remove("ok");
    els.wsDot.title = "WebSocket 断开，正在重连...";
    if (!CONN.lostAt) {
      CONN.lostAt = Date.now();
      appendLog("与后端的连接断开，正在重连...");
      CONN.bannerTimer = setInterval(() => {
        if (Date.now() - CONN.lostAt >= 4000) renderConnBanner();
      }, 1000);
    }
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "snapshot") {
      applyDefaultLead(msg);
      applyHubSettings(msg.settings);
      STATE.workflows = new Map((msg.workflows || []).map((w) => [w.groupId, w]));
      STATE.progress = new Map((msg.progress || []).map((p) => [p.groupId, p]));
      applyProjects(msg.projects);
      STATE.contexts = new Map((msg.contexts || []).map((c) => [c.groupId, c]));
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
    } else if (msg.type === "context_updated") {
      STATE.contexts.set(msg.context.groupId, msg.context);
      window.HUB_APP?.onStateChange?.();
    } else if (msg.type === "projects_updated") {
      applyProjects(msg.projects);
    } else if (msg.type === "progress_updated") {
      STATE.progress.set(msg.progress.groupId, msg.progress);
      scheduleUiRender(UI_REGION.inspector);
    } else if (msg.type === "workflow_updated") {
      const prev = STATE.workflows.get(msg.workflow.groupId);
      STATE.workflows.set(msg.workflow.groupId, msg.workflow);
      // 主导刚交来一份草稿：提醒一声，不打断当前视图
      if (
        msg.workflow.status === "draft" &&
        msg.workflow.proposedBy &&
        msg.workflow.proposedBy !== "user" &&
        (!prev || prev.updatedAt !== msg.workflow.updatedAt)
      ) {
        appendLog(`${msg.workflow.proposedBy} 起草了一个 ${msg.workflow.steps.length} 步的工作流，等待发布`);
        document.querySelector('.mode-tab[data-stage-view="workflow"]')?.classList.add("has-news");
      }
      // 对话里的工作流预览卡片要跟着状态变
      if (msg.workflow.groupId === STATE.activeGroupId && STATE.stageView === "chat") {
        scheduleUiRender(UI_REGION.messages);
      }
      window.HUB_APP?.onStateChange?.();
    } else if (msg.type === "settings_updated") {
      applyHubSettings(msg.settings);
    } else if (msg.type === "agents_updated") {
      applyDefaultLead(msg);
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
      // 标题、主导变了：工作流、用量等面板上也显示着这些信息
      scheduleUiRender(UI_REGION.inspector | UI_REGION.stateChange);
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
      pendingStreamDomMap.delete(msg.message.messageId);
      if (msg.message.streamKey === STATE.activeStreamKey) {
        const exists = els.messages.querySelector(`[data-message-id="${CSS.escape(msg.message.messageId)}"]`);
        if (exists) {
          updateStreamingMessageDom(msg.message);
        } else {
          renderMessages();
        }
      }
    } else if (msg.type === "message_deleted") {
      const streamList = STATE.messagesByStream.get(msg.streamKey);
      if (Array.isArray(streamList)) {
        const filtered = streamList.filter((m) => m.messageId !== msg.messageId);
        if (filtered.length !== streamList.length) {
          STATE.messagesByStream.set(msg.streamKey, filtered);
          pendingStreamDomMap.delete(msg.messageId);
          if (msg.streamKey === STATE.activeStreamKey) {
            renderMessages();
          }
        }
      }
    } else if (msg.type === "agent_chunk") {
      const rec = findMessageById(msg.streamKey, msg.messageId);
      if (rec) {
        const partType = msg.channel === "thought" ? "thought" : "text";
        if (!Array.isArray(rec.parts)) rec.parts = [];
        const lastPart = rec.parts[rec.parts.length - 1];
        if (lastPart && lastPart.type === partType) {
          lastPart.text += msg.text;
        } else {
          rec.parts.push({ type: partType, text: msg.text });
        }
        if (msg.channel === "message") rec.text += msg.text;
        else if (msg.channel === "thought") rec.thoughtText += msg.text;
        scheduleStreamingMessageDom(rec);
      }
    } else if (msg.type === "tool_event") {
      appendLog(`[${msg.sessionKey}] tool ${msg.title} (${msg.status || "start"})`);
      const rec = findMessageById(msg.streamKey, msg.messageId);
      if (rec) {
        if (!Array.isArray(rec.parts)) rec.parts = [];
        if (!rec.parts.some((p) => p.type === "tool" && p.toolCallId === msg.toolCallId)) {
          rec.parts.push({ type: "tool", toolCallId: msg.toolCallId });
        }
        const existingTool = rec.toolCalls.find((t) => t.toolCallId === msg.toolCallId);
        if (existingTool) {
          existingTool.title = msg.title || existingTool.title;
          if (msg.status) existingTool.status = msg.status;
          if (msg.kind) existingTool.kind = msg.kind;
          if (msg.rawInput !== undefined) existingTool.rawInput = msg.rawInput;
          if (Array.isArray(msg.locations) && msg.locations.length > 0) existingTool.locations = msg.locations;
          if (msg.outputText !== undefined) existingTool.outputText = msg.outputText;
          if (msg.outputTruncated !== undefined) existingTool.outputTruncated = msg.outputTruncated;
          if (Array.isArray(msg.diffs)) existingTool.diffs = msg.diffs;
          if (msg.completedAt !== undefined) existingTool.completedAt = msg.completedAt;
        } else {
          rec.toolCalls.push({
            toolCallId: msg.toolCallId,
            title: msg.title,
            kind: msg.kind,
            status: msg.status,
            rawInput: msg.rawInput,
            locations: msg.locations,
            outputText: msg.outputText,
            outputTruncated: msg.outputTruncated,
            diffs: msg.diffs,
            timestamp: msg.timestamp,
            completedAt: msg.completedAt,
          });
        }
        scheduleUiRender(UI_REGION.inspector);
        scheduleStreamingMessageDom(rec);
      }
    } else if (msg.type === "session_updated") {
      STATE.sessions.set(msg.session.sessionKey, msg.session);
      if (msg.session.status === "idle" && STATE.queuedByStream.size > 0) {
        const streamKey = msg.session.role === "lead" ? `lead:${msg.session.groupId}` : `sub:${msg.session.sessionKey}`;
        setTimeout(() => flushQueue(streamKey), 150);
      }
      scheduleUiRender(
        UI_REGION.sidebar |
          UI_REGION.header |
          UI_REGION.inspector |
          UI_REGION.metrics |
          UI_REGION.stateChange,
      );
    } else if (msg.type === "task_updated") {
      STATE.tasks.set(msg.task.taskId, msg.task);
      let regions = UI_REGION.sidebar | UI_REGION.header | UI_REGION.inspector;
      if (msg.task.groupId === STATE.activeGroupId && !isSubStream(STATE.activeStreamKey)) {
        regions |= UI_REGION.messages;
      }
      scheduleUiRender(regions);
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
  els.pickCwdBtn.onclick = () => openDirsDialog(getActiveGroup());
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
  const extraInput = document.getElementById("newTaskExtraDirsInput");
  const extraDirs = extraInput
    ? extraInput.value
        .split(/\r?\n/)
        .map((d) => d.trim())
        .filter(Boolean)
    : [];
  const created = await createTaskGroup({
    title: title || undefined,
    leadAgent: STATE.newTaskLead,
    cwd: cwd || undefined,
    extraDirs: extraDirs.length > 0 ? extraDirs : undefined,
  });
  // 目录写错时保留表单内容，改完再提交
  if (created === false) return;
  els.newTaskTitleInput.value = "";
  if (els.newTaskCwdInput) els.newTaskCwdInput.value = "";
  if (extraInput) extraInput.value = "";
  els.newTaskPopover.hidden = true;
};

const restoreArchivedBtn = document.getElementById("restoreArchivedBtn");
if (restoreArchivedBtn) {
  restoreArchivedBtn.onclick = () => {
    const group = getActiveGroup();
    if (group?.archived) void toggleArchiveTaskGroup(group);
  };
}

els.stageTaskTitle.onclick = () => {
  const group = getActiveGroup();
  if (group) void renameTaskGroup(group);
};

els.backToLeadBtn.onclick = () => {
  const group = getActiveGroup();
  if (group) selectGroup(group.groupId, `lead:${group.groupId}`);
};

let lastEscStopAt = 0;

function setStopHint(text) {
  if (!els.stopSessionBtn) return;
  els.stopSessionBtn.textContent = text || "停止";
  els.stopSessionBtn.classList.toggle("is-armed", Boolean(text));
}

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

function getActiveStreamSession() {
  if (!STATE.activeStreamKey) return null;
  if (isSubStream(STATE.activeStreamKey)) {
    return STATE.sessions.get(STATE.activeStreamKey.slice(4)) || null;
  }
  const group = getActiveGroup();
  if (!group) return null;
  for (const sess of STATE.sessions.values()) {
    if (sess.groupId === group.groupId && sess.role === "lead" && sess.agent === group.leadAgent) {
      return sess;
    }
  }
  return null;
}

const SUGGEST_STATE = {
  items: [],
  index: 0,
  replaceStart: 0,
  replaceEnd: 0,
  fileCache: new Map(),
  debounceTimer: null,
};

function closeComposerSuggest() {
  SUGGEST_STATE.items = [];
  SUGGEST_STATE.index = 0;
  if (els.composerSuggest) {
    els.composerSuggest.hidden = true;
    els.composerSuggest.innerHTML = "";
  }
}

function renderComposerSuggestList() {
  if (!els.composerSuggest) return;
  if (SUGGEST_STATE.items.length === 0) {
    closeComposerSuggest();
    return;
  }
  els.composerSuggest.hidden = false;
  els.composerSuggest.innerHTML = SUGGEST_STATE.items
    .map((it, idx) => {
      const activeCls = idx === SUGGEST_STATE.index ? " active" : "";
      return `<button type="button" class="composer-suggest-item${activeCls}" data-suggest-idx="${idx}">
        <span class="composer-suggest-main">${escapeHtml(it.label)}</span>
        <span class="composer-suggest-desc">${escapeHtml(it.desc || "")}</span>
      </button>`;
    })
    .join("");
  els.composerSuggest.querySelectorAll("[data-suggest-idx]").forEach((btn) => {
    btn.onmousedown = (e) => {
      e.preventDefault();
      applyComposerSuggestItem(Number(btn.dataset.suggestIdx));
    };
  });
}

function applyComposerSuggestItem(idx) {
  const item = SUGGEST_STATE.items[idx];
  if (!item || !els.promptInput) return;
  const val = els.promptInput.value;
  const before = val.slice(0, SUGGEST_STATE.replaceStart);
  const after = val.slice(SUGGEST_STATE.replaceEnd);
  const inserted = item.insertText;
  els.promptInput.value = `${before}${inserted}${after}`;
  const cursor = before.length + inserted.length;
  els.promptInput.setSelectionRange(cursor, cursor);
  els.promptInput.focus();
  closeComposerSuggest();
  resizePromptInput();
}

function resizePromptInput() {
  if (!els.promptInput) return;
  els.promptInput.style.height = "auto";
  const nextH = Math.max(52, Math.min(els.promptInput.scrollHeight, 220));
  els.promptInput.style.height = `${nextH}px`;
}

async function refreshWorkspaceFileSuggest(groupId, query, tokenStart, tokenEnd) {
  const cwd = STATE.taskGroups.get(groupId)?.cwd || STATE.baseCwd || "";
  const cacheKey = `${cwd}::${query}`;
  let files = SUGGEST_STATE.fileCache.get(cacheKey);
  if (!files) {
    try {
      const res = await fetch(
        `/api/workspace/files?groupId=${encodeURIComponent(groupId)}&q=${encodeURIComponent(query)}`,
      );
      const data = await res.json();
      files = Array.isArray(data.files) ? data.files : [];
      SUGGEST_STATE.fileCache.set(cacheKey, files);
      if (SUGGEST_STATE.fileCache.size > 40) {
        const firstKey = SUGGEST_STATE.fileCache.keys().next().value;
        if (firstKey !== undefined) SUGGEST_STATE.fileCache.delete(firstKey);
      }
    } catch {
      files = [];
    }
  }
  // Ignore stale async result if caret or text moved on.
  const caret = els.promptInput?.selectionStart ?? 0;
  if (caret !== tokenEnd) return;
  SUGGEST_STATE.replaceStart = tokenStart;
  SUGGEST_STATE.replaceEnd = tokenEnd;
  SUGGEST_STATE.index = 0;
  SUGGEST_STATE.items = files.slice(0, 12).map((f) => ({
    label: `@${f}`,
    desc: "工作区文件",
    insertText: `@${f} `,
  }));
  renderComposerSuggestList();
}

function updateComposerSuggest() {
  if (!els.promptInput) return;
  const caret = els.promptInput.selectionStart ?? els.promptInput.value.length;
  const prefix = els.promptInput.value.slice(0, caret);

  if (SUGGEST_STATE.debounceTimer) {
    clearTimeout(SUGGEST_STATE.debounceTimer);
    SUGGEST_STATE.debounceTimer = null;
  }

  // "/" slash command at start of input
  const slashMatch = prefix.match(/^\/([^\s]*)$/);
  if (slashMatch) {
    const q = slashMatch[1].toLowerCase();
    const sess = getActiveStreamSession();
    const cmds = Array.isArray(sess?.availableCommands) ? sess.availableCommands : [];
    const matched = cmds
      .filter((c) => !q || String(c.name || "").toLowerCase().includes(q))
      .slice(0, 12);
    SUGGEST_STATE.replaceStart = 0;
    SUGGEST_STATE.replaceEnd = caret;
    SUGGEST_STATE.index = 0;
    SUGGEST_STATE.items = matched.map((c) => ({
      label: `/${c.name}`,
      desc: c.hint || c.description || "",
      insertText: `/${c.name} `,
    }));
    renderComposerSuggestList();
    return;
  }

  // "@" workspace file completion
  const atMatch = prefix.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch && STATE.activeGroupId) {
    const query = atMatch[1];
    const tokenStart = prefix.lastIndexOf("@");
    const groupId = STATE.activeGroupId;
    SUGGEST_STATE.debounceTimer = setTimeout(() => {
      void refreshWorkspaceFileSuggest(groupId, query, tokenStart, caret);
    }, 120);
    return;
  }

  closeComposerSuggest();
}

function isNarrowDrawerViewport() {
  return window.innerWidth <= 1120;
}

function syncInspectorBackdrop() {
  if (!els.inspectorBackdrop) return;
  els.inspectorBackdrop.hidden = STATE.inspectorCollapsed || !isNarrowDrawerViewport();
}

function setInspectorCollapsed(collapsed, opts = {}) {
  STATE.inspectorCollapsed = collapsed;
  els.workbench.classList.toggle("inspector-collapsed", collapsed);
  els.toggleInspectorBtn.classList.toggle("is-on", !collapsed);
  els.toggleInspectorBtn.setAttribute("aria-pressed", String(!collapsed));
  els.toggleInspectorBtn.title = collapsed ? "展开右侧会话面板" : "收起右侧面板";
  syncInspectorBackdrop();
  if (opts.persist !== false && !isNarrowDrawerViewport()) {
    try {
      localStorage.setItem("agent-hub-inspector", collapsed ? "collapsed" : "open");
    } catch {
      // ignore storage failures
    }
  }
}

els.toggleInspectorBtn.onclick = () => {
  setInspectorCollapsed(!STATE.inspectorCollapsed);
};

if (els.inspectorBackdrop) {
  els.inspectorBackdrop.onclick = () => setInspectorCollapsed(true, { persist: false });
}

window.addEventListener("resize", () => syncInspectorBackdrop());

els.themeToggleBtn.onclick = () => {
  applyTheme(!document.body.classList.contains("dark"));
  // 自定义 Agent 的徽章色区分深浅主题，切换后重绘一次
  if (STATE.taskGroups.size > 0) renderAll();
};

els.sendBtn.onclick = () => {
  closeComposerSuggest();
  void sendPrompt();
};

els.promptInput.addEventListener("input", () => {
  // 开始输入就预热主导会话；已预热或已有会话时 warmGroupSession 内部直接返回
  warmGroupSession(STATE.activeGroupId);
  resizePromptInput();
  updateComposerSuggest();
});

els.promptInput.addEventListener("keydown", (e) => {
  // 中文输入法选词时按 Enter 只是上屏，不能当成发送
  if (e.isComposing || e.keyCode === 229) return;
  if (els.composerSuggest && !els.composerSuggest.hidden && SUGGEST_STATE.items.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      SUGGEST_STATE.index = (SUGGEST_STATE.index + 1) % SUGGEST_STATE.items.length;
      renderComposerSuggestList();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      SUGGEST_STATE.index =
        (SUGGEST_STATE.index - 1 + SUGGEST_STATE.items.length) % SUGGEST_STATE.items.length;
      renderComposerSuggestList();
      return;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      applyComposerSuggestItem(SUGGEST_STATE.index);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeComposerSuggest();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt({ steer: (e.ctrlKey || e.metaKey) && isStreamBusy(STATE.activeStreamKey) });
  }
});

if (els.steerBtn) {
  els.steerBtn.onclick = () => void sendPrompt({ steer: true });
}

if (els.attachImageBtn && els.imageFileInput) {
  els.attachImageBtn.onclick = () => els.imageFileInput.click();
  els.imageFileInput.onchange = () => {
    if (els.imageFileInput.files && els.imageFileInput.files.length > 0) {
      void addImageFilesToComposer(els.imageFileInput.files);
      els.imageFileInput.value = "";
    }
  };
}

els.promptInput.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imgFiles = items
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (imgFiles.length === 0) return;
  const hasPlainText = Boolean(e.clipboardData?.getData("text/plain"));
  if (!hasPlainText) {
    e.preventDefault();
  }
  void addImageFilesToComposer(imgFiles);
});

if (els.composerBox) {
  els.composerBox.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      els.composerBox.classList.add("drag-over");
    }
  });
  els.composerBox.addEventListener("dragleave", (e) => {
    if (!els.composerBox.contains(e.relatedTarget)) {
      els.composerBox.classList.remove("drag-over");
    }
  });
  els.composerBox.addEventListener("drop", (e) => {
    els.composerBox.classList.remove("drag-over");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFilesToComposer(files);
  });
}

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

// 作为桌面应用窗口运行：关掉浏览器的表单记忆、拼写检查，以及页面右键菜单。
// 输入框里保留右键菜单（复制、粘贴要用）；选中了文字时也保留，方便复制。
function hardenTextField(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.dataset.hardened) return;
  el.dataset.hardened = "1";
  el.setAttribute("autocomplete", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("spellcheck", "false");
  el.setAttribute("data-form-type", "other");
  el.setAttribute("data-lpignore", "true");
}
document.querySelectorAll("input, textarea").forEach(hardenTextField);
document.addEventListener("focusin", (e) => hardenTextField(e.target), true);

document.addEventListener("contextmenu", (e) => {
  const target = e.target;
  const editable =
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "file"].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable);
  const hasSelection = String(window.getSelection?.() || "").trim().length > 0;
  if (!editable && !hasSelection) {
    e.preventDefault();
  }
});
// 把文件拖到输入框以外的地方时，浏览器默认会直接打开它并离开页面
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (e.dataTransfer?.types?.includes("Files") && !els.composerBox?.contains(e.target)) e.preventDefault();
});

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
        // 单按一下 Esc 太容易误触（关输入法候选、关弹窗的习惯动作），要连按两次才停止
        const now = Date.now();
        if (now - lastEscStopAt < 1500) {
          lastEscStopAt = 0;
          setStopHint("");
          void cancelSession(activeKey);
          appendLog("已按 Esc 停止当前会话");
        } else {
          lastEscStopAt = now;
          setStopHint("再按一次 Esc 停止");
          setTimeout(() => {
            if (Date.now() - lastEscStopAt >= 1500) setStopHint("");
          }, 1600);
        }
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

  const toggleBtn = e.target.closest("[data-preview-toggle], [data-toggle-inline-preview]");
  if (toggleBtn) {
    const wrap = toggleBtn.closest(".md-code-block, .md-code-wrap");
    const previewBox = wrap?.querySelector(".md-preview-box, .inline-preview-box");
    const preEl = wrap?.querySelector("pre");
    if (previewBox && preEl) {
      const showingPreview = !previewBox.hidden;
      previewBox.hidden = showingPreview;
      preEl.hidden = !showingPreview;
      toggleBtn.classList.toggle("active", !showingPreview);
      if (toggleBtn.hasAttribute("data-preview-toggle")) {
        toggleBtn.textContent = showingPreview ? "实时预览" : "查看源码";
      }
    }
    return;
  }

  const btn = e.target.closest("[data-copy-code]");
  if (!btn) return;
  const wrap = btn.closest(".md-code-block, .md-code-wrap");
  const codeText = wrap?.dataset?.codeB64
    ? decodeUtf8Base64(wrap.dataset.codeB64)
    : wrap?.querySelector("pre code")?.textContent || "";
  if (!codeText) return;
  void navigator.clipboard?.writeText(codeText);
  const orig = btn.textContent;
  btn.textContent = "✓ 已复制";
  setTimeout(() => {
    btn.textContent = orig;
  }, 1400);
});

async function openWorktreeDiffModal(sessionKey) {
  try {
    const res = await fetch(`/api/worktrees/diff?sessionKey=${encodeURIComponent(sessionKey)}`);
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      await showConfirmModal({
        title: "读取 Worktree 改动失败",
        message: data.error || `HTTP ${res.status}`,
        confirmText: "知道了",
      });
      return;
    }
    document.querySelector(".wt-diff-backdrop")?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "wt-diff-backdrop";
    const statusText = Array.isArray(data.statusLines) && data.statusLines.length > 0
      ? data.statusLines.join("\n")
      : data.clean
        ? "工作区干净，与基线分支相比暂无增量提交或未暂存改动。"
        : "";
    const diffHtml = data.diff && data.diff.trim()
      ? `<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang">diff${data.truncated ? " (已截断)" : ""}</span></div><pre class="md-code-pre"><code>${highlightCode("diff", data.diff)}</code></pre></div>`
      : `<div class="empty-note">暂无文本 Diff（可能是新增空目录或无实质改动）。</div>`;
    backdrop.innerHTML = `
      <div class="wt-diff-dialog" role="dialog" aria-modal="true">
        <div class="wt-diff-head">
          <div>
            <strong>Worktree 改动对比</strong>
            <span class="worktree-branch" style="margin-left:8px">${escapeHtml(data.branch || sessionKey)}</span>
          </div>
          <button type="button" class="mini-icon-btn" data-wt-modal-close title="关闭">×</button>
        </div>
        <div class="wt-diff-body">
          <div class="mono" style="font-size:12px;color:var(--muted)">基线目录: ${escapeHtml(data.baseCwd || "-")}</div>
          ${data.diffStat ? `<pre class="tool-output-pre">${escapeHtml(data.diffStat)}</pre>` : ""}
          ${statusText ? `<pre class="tool-output-pre">${escapeHtml(statusText)}</pre>` : ""}
          ${diffHtml}
        </div>
        <div class="wt-diff-foot">
          <div style="display:flex;gap:8px">
            <button type="button" class="alma-btn alma-btn-danger alma-btn-sm" data-wt-modal-discard>丢弃 Worktree</button>
            <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" data-wt-modal-merge>合入主工作区</button>
          </div>
          <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-wt-modal-close>关闭</button>
        </div>
      </div>
    `;
    const closeModal = () => {
      document.removeEventListener("keydown", onEsc);
      backdrop.remove();
    };
    const onEsc = (ev) => {
      if (ev.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", onEsc);
    backdrop.addEventListener("mousedown", (ev) => {
      if (ev.target === backdrop) closeModal();
    });
    backdrop.querySelectorAll("[data-wt-modal-close]").forEach((b) => (b.onclick = closeModal));
    backdrop.querySelector("[data-wt-modal-merge]").onclick = () => {
      closeModal();
      void mergeWorktreeSession(sessionKey);
    };
    backdrop.querySelector("[data-wt-modal-discard]").onclick = () => {
      closeModal();
      void discardWorktreeSession(sessionKey);
    };
    document.body.appendChild(backdrop);
  } catch (err) {
    appendLog(`读取 Worktree 改动异常: ${err.message}`);
  }
}

async function mergeWorktreeSession(sessionKey) {
  const ok = await showConfirmModal({
    title: "合入主工作区",
    message: `确认将子会话 worktree (${sessionKey}) 的改动快照并合入主工作区？合并成功后会自动移除临时 worktree。`,
    confirmText: "确认合入",
  });
  if (!ok) return;
  try {
    const res = await fetch("/api/worktrees/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, cleanup: true }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      await showConfirmModal({
        title: "合入主工作区失败",
        message: data.error || `HTTP ${res.status}`,
        confirmText: "知道了",
      });
      return;
    }
    appendLog(`Worktree 已合入主工作区 (${data.branch || sessionKey}): ${data.summary || "done"}`);
  } catch (err) {
    appendLog(`合入 Worktree 异常: ${err.message}`);
  }
}

async function discardWorktreeSession(sessionKey) {
  const ok = await showConfirmModal({
    title: "丢弃 Worktree",
    message: `确认丢弃子会话 worktree (${sessionKey}) 及其未合入改动？此操作不可撤销。`,
    confirmText: "确认丢弃",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch("/api/worktrees/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      await showConfirmModal({
        title: "丢弃 Worktree 失败",
        message: data.error || `HTTP ${res.status}`,
        confirmText: "知道了",
      });
      return;
    }
    appendLog(`已丢弃 Worktree: ${sessionKey}`);
  } catch (err) {
    appendLog(`丢弃 Worktree 异常: ${err.message}`);
  }
}

function buildWorktreeBarElement(sessionKey, branchLabel) {
  const bar = document.createElement("div");
  bar.className = "worktree-bar";
  bar.innerHTML = `
    <span class="wt-pill">worktree</span>
    <span class="worktree-branch">${escapeHtml(branchLabel || sessionKey)}</span>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">
      <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-wt-diff="${escapeHtml(sessionKey)}">查看改动 Diff</button>
      <button type="button" class="alma-btn alma-btn-primary alma-btn-sm" data-wt-merge="${escapeHtml(sessionKey)}">合入主工作区</button>
      <button type="button" class="alma-btn alma-btn-danger alma-btn-sm" data-wt-discard="${escapeHtml(sessionKey)}">丢弃 Worktree</button>
    </div>
  `;
  return bar;
}

document.addEventListener("click", (e) => {
  const diffBtn = e.target.closest("[data-wt-diff]");
  if (diffBtn) {
    void openWorktreeDiffModal(diffBtn.dataset.wtDiff);
    return;
  }
  const mergeBtn = e.target.closest("[data-wt-merge]");
  if (mergeBtn) {
    void mergeWorktreeSession(mergeBtn.dataset.wtMerge);
    return;
  }
  const discardBtn = e.target.closest("[data-wt-discard]");
  if (discardBtn) {
    void discardWorktreeSession(discardBtn.dataset.wtDiscard);
  }
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
  createTaskGroup,
  sendStreamPrompt,
  openSettings,
  closeSettings,
  isAgentsViewOpen,
  renderModelSelectorBar,
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
  const savedInspectorCollapsed = localStorage.getItem("agent-hub-inspector") === "collapsed";
  setInspectorCollapsed(isNarrowDrawerViewport() ? true : savedInspectorCollapsed, { persist: false });
} catch {
  setInspectorCollapsed(isNarrowDrawerViewport(), { persist: false });
}
try {
  applySkin(localStorage.getItem("agent-hub-skin") || "modern");
} catch {
  applySkin("modern");
}
initSettingsDialog();
renderAgentControls();
setStageView("chat");
connectWs();
void loadAdapterHealth();

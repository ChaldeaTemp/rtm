// 设置 → MCP：把各个 Agent 自己配置里已有的 MCP 服务（以及在这里新加的）共享给其他 Agent。
// 不改任何 Agent 自己的配置文件，只在启动会话时把选中的服务带上。

import { apiFetch, t, th } from "./i18n.js";

const app = window.HUB_APP;
const esc = (s) => app.escapeHtml(String(s ?? ""));

const MCP_STATE = { servers: [], cwd: "", loading: false, error: "", formOpen: false };

const SOURCE_KEY = { rtm: "mcpSourceRtm", codex: "mcpSourceCodex", claude: "mcpSourceClaude", project: "mcpSourceProject" };

function currentScope() {
  const group = app.STATE.taskGroups.get(app.STATE.activeGroupId);
  return { groupId: group?.groupId || "", cwd: group?.cwd || "" };
}

async function post(path, body) {
  const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function load() {
  MCP_STATE.loading = true;
  render();
  try {
    const { groupId } = currentScope();
    const data = await (await apiFetch(`/api/mcp${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`)).json();
    if (data.ok === false) throw new Error(data.error);
    MCP_STATE.servers = data.servers || [];
    MCP_STATE.cwd = data.cwd || "";
    MCP_STATE.error = "";
  } catch (err) {
    MCP_STATE.error = err.message;
  }
  MCP_STATE.loading = false;
  render();
}

async function act(fn) {
  try {
    const data = await fn();
    if (data?.servers) MCP_STATE.servers = data.servers;
    MCP_STATE.error = "";
  } catch (err) {
    MCP_STATE.error = err.message;
  }
  render();
}

function agentList() {
  return (app.STATE.agents || []).filter((a) => a.enabled !== false);
}

function serverCard(s) {
  const { groupId } = currentScope();
  const where = s.transport === "http" ? s.url : [s.command, ...(s.args || [])].join(" ");
  const blocked = !s.trusted
    ? t("mcpBlockedUntrusted")
    : s.missingEnv.length > 0
      ? t("mcpBlockedMissingEnv", s.missingEnv.join(", "))
      : "";
  const pills = agentList()
    .map((a) => {
      const label = a.label || a.agent;
      if (s.nativeAgents.includes(a.agent)) return `<span class="cov-pill native" title="${th("mcpPillNativeTip")}">${th("mcpPillNative", label)}</span>`;
      if (!s.enabled) return `<span class="cov-pill off">${th("mcpPillNotShared", label)}</span>`;
      const off = s.disabledAgents.includes(a.agent);
      return `<button type="button" class="cov-pill ${off ? "off" : "bridged"}" data-mcp-agent="${esc(s.id)}" data-agent="${esc(a.agent)}" data-next="${off}" title="${th(off ? "mcpPillShareTip" : "mcpPillOffTip")}">${th(off ? "mcpPillOff" : "mcpPillShared", label)}</button>`;
    })
    .join("");
  return `
    <div class="resource-row ${s.enabled ? "" : "disabled"}">
      <div class="resource-row-top">
        <div class="resource-main">
          <div class="resource-title-line">
            <span class="origin-tag">MCP</span>
            <span class="origin-tag">${SOURCE_KEY[s.source] ? th(SOURCE_KEY[s.source]) : esc(s.source)}</span>
            <strong>${esc(s.name)}</strong>
            <span class="res-meta">${th(s.transport === "http" ? "mcpTransportHttp" : "mcpTransportStdio")}</span>
          </div>
          <div class="agent-cmd-line" title="${esc(where)}">${esc(where)}</div>
          ${blocked ? `<div class="agent-probe-status err">${esc(blocked)}</div>` : ""}
        </div>
        <div class="resource-actions" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${
            s.source === "project" && !s.trusted
              ? `<button type="button" class="alma-btn alma-btn-sm alma-btn-primary" data-mcp-trust="1">${th("mcpTrustFile")}</button>`
              : `<label class="wf-check" title="${th("mcpAlsoSubTip")}">
                   <input type="checkbox" data-mcp-sub="${esc(s.id)}" ${s.roles.includes("sub") ? "checked" : ""} ${s.enabled ? "" : "disabled"} />${th("mcpAlsoSub")}
                 </label>
                 <button type="button" class="alma-btn alma-btn-sm ${s.enabled ? "" : "alma-btn-primary"}" data-mcp-toggle="${esc(s.id)}" data-next="${!s.enabled}">${th(s.enabled ? "mcpStopSharing" : "mcpShare")}</button>`
          }
          ${s.source === "rtm" ? `<button type="button" class="alma-btn alma-btn-sm alma-btn-outline" data-mcp-delete="${esc(s.name)}">${th("delete")}</button>` : ""}
        </div>
      </div>
      <div class="resource-cov">${pills}</div>
    </div>`;
}

function render() {
  const container = document.getElementById("mcpView");
  if (!container) return;
  const { groupId } = currentScope();
  const form = MCP_STATE.formOpen
    ? `<div class="alma-box" style="padding:12px;margin-bottom:12px">
         <div class="settings-row"><div class="settings-label">${th("mcpFormName")}</div><input id="mcpFormName" class="alma-input" placeholder="${th("mcpFormNamePlaceholder")}" /></div>
         <div class="settings-row"><div class="settings-label">${th("mcpFormType")}</div>
           <select id="mcpFormTransport" class="perm-select"><option value="stdio">${th("mcpFormTypeStdio")}</option><option value="http">${th("mcpFormTypeHttp")}</option></select></div>
         <div class="settings-row"><div class="settings-label">${th("mcpFormTarget")}</div><input id="mcpFormTarget" class="alma-input" placeholder="${th("mcpFormTargetPlaceholder")}" style="min-width:340px" /></div>
         <div class="settings-row"><div><div class="settings-label">${th("mcpFormEnv")}</div><div class="settings-note">${th("mcpFormEnvNote")}</div></div>
           <textarea id="mcpFormEnv" class="rule-editor-textarea" rows="2" style="min-width:340px"></textarea></div>
         <div style="display:flex;gap:8px;justify-content:flex-end">
           <button type="button" class="alma-btn alma-btn-sm" id="mcpFormCancel">${th("cancel")}</button>
           <button type="button" class="alma-btn alma-btn-sm alma-btn-primary" id="mcpFormSave">${th("save")}</button>
         </div>
       </div>`
    : "";
  container.innerHTML = `
    <div class="settings-note" style="margin-bottom:10px">
      ${th("mcpIntro")}
      ${MCP_STATE.cwd ? `<br />${th("mcpCurrentDir")}<span class="mono">${esc(MCP_STATE.cwd)}</span>` : ""}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button type="button" class="alma-btn alma-btn-sm alma-btn-outline" id="mcpAddBtn">${th("mcpAddServer")}</button>
      <button type="button" class="alma-btn alma-btn-sm alma-btn-outline" id="mcpReloadBtn">${th("mcpReload")}</button>
    </div>
    ${form}
    ${MCP_STATE.error ? `<div class="agent-probe-status err" style="margin-bottom:10px">${esc(MCP_STATE.error)}</div>` : ""}
    ${
      MCP_STATE.loading
        ? `<div class="empty-note">${th("mcpLoading")}</div>`
        : MCP_STATE.servers.length === 0
          ? `<div class="empty-note">${th("mcpEmpty")}</div>`
          : MCP_STATE.servers.map(serverCard).join("")
    }`;

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  bind("mcpReloadBtn", () => void load());
  bind("mcpAddBtn", () => {
    MCP_STATE.formOpen = true;
    render();
  });
  bind("mcpFormCancel", () => {
    MCP_STATE.formOpen = false;
    render();
  });
  bind("mcpFormSave", () => {
    const name = document.getElementById("mcpFormName").value.trim();
    const transport = document.getElementById("mcpFormTransport").value;
    const target = document.getElementById("mcpFormTarget").value.trim();
    const env = Object.fromEntries(
      document
        .getElementById("mcpFormEnv")
        .value.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1)]),
    );
    // 命令按空白拆成程序和参数；带空格的路径用引号包起来
    const parts = target.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, "")) || [];
    const server =
      transport === "http" ? { name, transport, url: target } : { name, transport, command: parts[0] || "", args: parts.slice(1), env };
    void act(async () => {
      const data = await post("/api/mcp/save", { groupId, server });
      MCP_STATE.formOpen = false;
      return data;
    });
  });
  container.querySelectorAll("[data-mcp-toggle]").forEach((btn) => {
    btn.onclick = () => void act(() => post("/api/mcp/state", { groupId, id: btn.dataset.mcpToggle, enabled: btn.dataset.next === "true" }));
  });
  container.querySelectorAll("[data-mcp-sub]").forEach((box) => {
    box.onchange = () => void act(() => post("/api/mcp/state", { groupId, id: box.dataset.mcpSub, roles: box.checked ? ["lead", "sub"] : ["lead"] }));
  });
  container.querySelectorAll("[data-mcp-agent]").forEach((btn) => {
    btn.onclick = () =>
      void act(() => post("/api/mcp/state", { groupId, id: btn.dataset.mcpAgent, agent: btn.dataset.agent, agentEnabled: btn.dataset.next === "true" }));
  });
  container.querySelectorAll("[data-mcp-delete]").forEach((btn) => {
    btn.onclick = () => void act(() => post("/api/mcp/delete", { groupId, name: btn.dataset.mcpDelete }));
  });
  container.querySelectorAll("[data-mcp-trust]").forEach((btn) => {
    btn.onclick = async () => {
      const ok = await app.showConfirmModal({
        title: t("mcpTrustTitle"),
        message: t("mcpTrustMessage"),
        confirmText: t("mcpTrustConfirm"),
      });
      if (ok) void act(() => post("/api/mcp/trust", { groupId, trusted: true }));
    };
  });
}

window.HUB_MCP = { render: () => void load(), rerender: render };

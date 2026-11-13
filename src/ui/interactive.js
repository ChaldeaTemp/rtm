const app = window.HUB_APP;

const INTERACTIVE_STATE = {
  showForm: false,
  editingId: null,
  formValues: {
    id: "",
    label: "",
    command: "",
    argsText: "",
    envText: "",
    color: "#3f6212",
    description: "",
  },
  probeResults: new Map(), // agentId -> { testing?: boolean, ok?: boolean, latencyMs?: number, sessionId?: string, error?: string }
  questionDrafts: new Map(), // questionId -> Map<fieldId, string | string[]>
};

const QUICK_TEMPLATES = [
  {
    name: "OpenCode ACP",
    id: "opencode",
    label: "opencode",
    command: "opencode",
    argsText: "acp",
    envText: "",
    color: "#6d3fc0",
    description: "OpenCode CLI 内置 ACP 服务端",
  },
  {
    name: "Kimi CLI ACP",
    id: "kimi",
    label: "kimi",
    command: "kimi",
    argsText: "acp",
    envText: "",
    color: "#0d7490",
    description: "Moonshot Kimi Code CLI 内置 ACP 服务端",
  },
  {
    name: "Gemini CLI",
    id: "gemini",
    label: "gemini",
    command: "gemini",
    argsText: "--experimental-acp",
    envText: "",
    color: "#1a73e8",
    description: "Google Gemini CLI（实验性 ACP 模式）",
  },
  {
    name: "Goose ACP",
    id: "goose",
    label: "goose",
    command: "goose",
    argsText: "acp",
    envText: "",
    color: "#c2410c",
    description: "Block Goose 本地 ACP Agent",
  },
  {
    name: "自定义 Node/Python 脚本",
    id: "custom-acp",
    label: "custom-acp",
    command: "node",
    argsText: "./scripts/my-acp-agent.mjs",
    envText: "MY_ENV=1",
    color: "#4338ca",
    description: "通过 stdio JSON-RPC 实现 ACP 协议的自定义脚本",
  },
];

function parseArgsText(raw) {
  return String(raw || "")
    .split(/[\r\n\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEnvText(raw) {
  const env = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function formatEnvText(env) {
  if (!env || typeof env !== "object") return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function renderQuestions() {
  if (!app) return;
  const container = app.els.questionBanner;
  if (!container) return;

  const isChat = app.STATE.stageView === "chat";
  const items = [...app.STATE.pendingQuestions.values()];
  if (!isChat || items.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  container.hidden = false;
  container.innerHTML = "";
  const esc = app.escapeHtml;

  for (const q of items) {
    if (!INTERACTIVE_STATE.questionDrafts.has(q.questionId)) {
      INTERACTIVE_STATE.questionDrafts.set(q.questionId, new Map());
    }
    const draft = INTERACTIVE_STATE.questionDrafts.get(q.questionId);
    const card = document.createElement("div");
    card.className = "question-card";

    const head = document.createElement("div");
    head.className = "question-card-head";
    const tagHtml = app.agentTagHtml
      ? app.agentTagHtml(q.agent)
      : `<span class="agent-tag" data-agent="${esc(q.agent)}">${esc(q.agent)}</span>`;
    head.innerHTML = `
      <div class="question-card-title">
        ${tagHtml}
        <span>${esc(q.title || "需要你确认问题")}</span>
      </div>
      <span class="mono" style="font-size:11px;color:var(--faint)">${app.formatTime(q.createdAt)}</span>
    `;
    card.appendChild(head);

    const fields = Array.isArray(q.fields) ? q.fields : [];
    for (const field of fields) {
      const fieldEl = document.createElement("div");
      fieldEl.className = "question-field";

      const promptEl = document.createElement("div");
      promptEl.className = "question-prompt";
      promptEl.textContent = field.question;
      fieldEl.appendChild(promptEl);

      if ((field.type === "single" || field.type === "multi") && Array.isArray(field.options) && field.options.length > 0) {
        const optList = document.createElement("div");
        optList.className = "question-opt-list";

        const isMulti = field.type === "multi";
        const currentVal = draft.get(field.id);

        for (const opt of field.options) {
          const btn = document.createElement("button");
          btn.type = "button";
          const selected = isMulti
            ? Array.isArray(currentVal) && currentVal.includes(opt)
            : currentVal === opt;
          btn.className = `question-opt${selected ? " selected" : ""}`;
          btn.textContent = opt;
          btn.onclick = () => {
            if (isMulti) {
              const prev = Array.isArray(draft.get(field.id)) ? [...draft.get(field.id)] : [];
              const idx = prev.indexOf(opt);
              if (idx >= 0) prev.splice(idx, 1);
              else prev.push(opt);
              draft.set(field.id, prev);
            } else {
              draft.set(field.id, opt);
            }
            renderQuestions();
          };
          optList.appendChild(btn);
        }
        fieldEl.appendChild(optList);

        if (field.type === "single") {
          const extraInput = document.createElement("input");
          extraInput.type = "text";
          extraInput.className = "question-text-input";
          extraInput.placeholder = field.placeholder || "或输入其他补充说明...";
          const knownOption = field.options.includes(currentVal);
          extraInput.value = !knownOption && typeof currentVal === "string" ? currentVal : "";
          extraInput.oninput = (e) => {
            draft.set(field.id, e.target.value);
            optList.querySelectorAll(".question-opt").forEach((b) => b.classList.remove("selected"));
          };
          fieldEl.appendChild(extraInput);
        }
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "question-text-input";
        input.placeholder = field.placeholder || "请输入回答...";
        input.value = typeof draft.get(field.id) === "string" ? draft.get(field.id) : "";
        input.oninput = (e) => {
          draft.set(field.id, e.target.value);
        };
        fieldEl.appendChild(input);
      }

      card.appendChild(fieldEl);
    }

    const actions = document.createElement("div");
    actions.className = "question-card-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "alma-btn alma-btn-outline alma-btn-sm";
    cancelBtn.textContent = "跳过 / 取消";
    cancelBtn.onclick = () => void submitQuestionResponse(q.questionId, true);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "alma-btn alma-btn-primary alma-btn-sm";
    submitBtn.textContent = "提交回答";
    submitBtn.onclick = () => void submitQuestionResponse(q.questionId, false);

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    card.appendChild(actions);

    container.appendChild(card);
  }
}

async function submitQuestionResponse(questionId, cancelled) {
  const answers = {};
  if (!cancelled) {
    const draft = INTERACTIVE_STATE.questionDrafts.get(questionId);
    if (draft) {
      for (const [k, v] of draft.entries()) {
        answers[k] = v;
      }
    }
  }
  try {
    const res = await fetch("/api/questions/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, answers, cancelled }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(`提交问题失败: ${data.error || res.status}`);
      return;
    }
    INTERACTIVE_STATE.questionDrafts.delete(questionId);
    app.STATE.pendingQuestions.delete(questionId);
    renderQuestions();
  } catch (err) {
    app.appendLog(`提交问题异常: ${err.message}`);
  }
}

async function refreshAgentsList() {
  try {
    const res = await fetch("/api/agents");
    const data = await res.json();
    if (res.ok && Array.isArray(data.agents)) {
      app.STATE.agents = data.agents;
      app.renderAgentControls?.();
      renderAgentsView();
    }
  } catch (err) {
    app.appendLog(`刷新 Agent 列表失败: ${err.message}`);
  }
}

async function probeAgentHandshake(id) {
  INTERACTIVE_STATE.probeResults.set(id, { testing: true });
  renderAgentsView();
  try {
    const res = await fetch("/api/agents/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    INTERACTIVE_STATE.probeResults.set(id, { testing: false, ...data });
    app.appendLog(
      data.ok
        ? `ACP 握手成功 [${id}] (${data.latencyMs}ms, session=${data.sessionId || "-"})`
        : `ACP 握手失败 [${id}]: ${data.error || "unknown"}`,
    );
  } catch (err) {
    INTERACTIVE_STATE.probeResults.set(id, { testing: false, ok: false, error: err.message });
  }
  renderAgentsView();
}

async function toggleAgentEnabled(id, enabled) {
  try {
    const res = await fetch("/api/agents/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(`切换 Agent 状态失败: ${data.error || res.status}`);
      return;
    }
    app.STATE.agents = data.agents || app.STATE.agents;
    app.renderAgentControls?.();
    renderAgentsView();
  } catch (err) {
    app.appendLog(`切换 Agent 状态异常: ${err.message}`);
  }
}

async function deleteCustomAgent(id) {
  if (!window.confirm(`确认移除自定义 Agent「${id}」？`)) return;
  try {
    const res = await fetch("/api/agents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(`移除 Agent 失败: ${data.error || res.status}`);
      return;
    }
    app.STATE.agents = data.agents || app.STATE.agents;
    app.renderAgentControls?.();
    renderAgentsView();
  } catch (err) {
    app.appendLog(`移除 Agent 异常: ${err.message}`);
  }
}

async function saveAgentForm(e) {
  e.preventDefault();
  const idEl = document.getElementById("agentCfgId");
  const labelEl = document.getElementById("agentCfgLabel");
  const cmdEl = document.getElementById("agentCfgCommand");
  const argsEl = document.getElementById("agentCfgArgs");
  const envEl = document.getElementById("agentCfgEnv");
  const colorEl = document.getElementById("agentCfgColor");
  const descEl = document.getElementById("agentCfgDesc");

  const payload = {
    id: idEl.value.trim(),
    label: labelEl.value.trim() || undefined,
    command: cmdEl.value.trim() || undefined,
    args: parseArgsText(argsEl.value),
    env: parseEnvText(envEl.value),
    color: colorEl.value.trim() || undefined,
    description: descEl.value.trim() || undefined,
    enabled: true,
  };

  if (!payload.id) return;

  try {
    const res = await fetch("/api/agents/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(`保存 Agent 配置失败: ${data.error || res.status}`);
      return;
    }
    INTERACTIVE_STATE.showForm = false;
    INTERACTIVE_STATE.editingId = null;
    app.STATE.agents = data.agents || app.STATE.agents;
    app.renderAgentControls?.();
    renderAgentsView();
    app.appendLog(`已保存 Agent 配置: ${payload.id}`);
  } catch (err) {
    app.appendLog(`保存 Agent 异常: ${err.message}`);
  }
}

function openFormWithTemplate(tpl) {
  INTERACTIVE_STATE.showForm = true;
  INTERACTIVE_STATE.editingId = null;
  INTERACTIVE_STATE.formValues = {
    id: tpl.id || "",
    label: tpl.label || tpl.id || "",
    command: tpl.command || "",
    argsText: tpl.argsText || "",
    envText: tpl.envText || "",
    color: tpl.color || "#3f6212",
    description: tpl.description || "",
  };
  renderAgentsView();
}

function openFormForEdit(agentItem) {
  INTERACTIVE_STATE.showForm = true;
  INTERACTIVE_STATE.editingId = agentItem.agent;
  INTERACTIVE_STATE.formValues = {
    id: agentItem.agent,
    label: agentItem.label || agentItem.agent,
    command: agentItem.customCommand || (agentItem.command?.[0] ?? ""),
    argsText: (agentItem.customArgs ?? agentItem.command?.slice(1) ?? []).join(" "),
    envText: formatEnvText(agentItem.env),
    color: agentItem.color || "#3f6212",
    description: agentItem.description || "",
  };
  renderAgentsView();
}

function renderAgentsView() {
  if (!app) return;
  const container = app.els.agentsView;
  if (!container) return;

  const esc = app.escapeHtml;
  const list = app.STATE.agents && app.STATE.agents.length > 0 ? app.STATE.agents : app.getEnabledAgents();

  const templateButtons = QUICK_TEMPLATES.map(
    (tpl, idx) =>
      `<button type="button" class="filter-pill" data-agent-tpl="${idx}">${esc(tpl.name)}</button>`,
  ).join("");

  const fv = INTERACTIVE_STATE.formValues;
  const formHtml = INTERACTIVE_STATE.showForm
    ? `
      <form id="agentRegistryForm" class="rule-editor-box">
        <div class="agent-template-bar">
          <span class="mono" style="font-size:11px;color:var(--muted)">快速模板：</span>
          ${templateButtons}
        </div>
        <div class="agent-form-grid">
          <div class="agent-form-field">
            <label>Agent ID (唯一标识)</label>
            <input id="agentCfgId" class="text-input" type="text" placeholder="如 gemini / goose / my-agent" value="${esc(fv.id)}" ${INTERACTIVE_STATE.editingId ? "readonly" : ""} required />
          </div>
          <div class="agent-form-field">
            <label>显示名称</label>
            <input id="agentCfgLabel" class="text-input" type="text" placeholder="如 gemini" value="${esc(fv.label)}" />
          </div>
          <div class="agent-form-field">
            <label>启动命令 (Command)</label>
            <input id="agentCfgCommand" class="text-input" type="text" placeholder="如 opencode / node / python" value="${esc(fv.command)}" />
          </div>
          <div class="agent-form-field">
            <label>命令参数 (Args，空格或换行分隔)</label>
            <input id="agentCfgArgs" class="text-input" type="text" placeholder="如 acp 或 --experimental-acp" value="${esc(fv.argsText)}" />
          </div>
          <div class="agent-form-field">
            <label>徽章颜色 (Hex)</label>
            <input id="agentCfgColor" class="text-input" type="text" placeholder="#3f6212" value="${esc(fv.color)}" />
          </div>
          <div class="agent-form-field">
            <label>说明备注</label>
            <input id="agentCfgDesc" class="text-input" type="text" placeholder="简短描述该 Agent 的用途" value="${esc(fv.description)}" />
          </div>
        </div>
        <div class="agent-form-field" style="margin-bottom:8px">
          <label>附加环境变量 (可选，每行 KEY=VALUE)</label>
          <textarea id="agentCfgEnv" class="rule-editor-textarea" style="min-height:64px" placeholder="OPENAI_BASE_URL=https://...&#10;CUSTOM_API_KEY=...">${esc(fv.envText)}</textarea>
        </div>
        <div class="panel-toolbar">
          <span class="mono" style="font-size:11px;color:var(--faint)">仅写入项目目录 .agent-hub/agents.json；任何支持 stdio ACP 协议的 CLI 均可接入并参与 peer_ask 委派与上下文统计</span>
          <div style="display:flex;gap:8px">
            <button id="cancelAgentFormBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button">取消</button>
            <button class="alma-btn alma-btn-primary alma-btn-sm" type="submit">保存接入配置</button>
          </div>
        </div>
      </form>`
    : "";

  const cardsHtml = list
    .map((item) => {
      const probe = INTERACTIVE_STATE.probeResults.get(item.agent);
      const tagHtml = app.agentTagHtml
        ? app.agentTagHtml(item.agent, item.label || item.agent)
        : `<span class="agent-tag" data-agent="${esc(item.agent)}">${esc(item.label || item.agent)}</span>`;
      const cmdDisplay = Array.isArray(item.command) && item.command.length > 0 ? item.command.join(" ") : "(未解析到命令)";
      let statusBadge = `<span class="cov-pill off">已停用</span>`;
      if (item.enabled !== false) {
        if (item.available && item.authReady) statusBadge = `<span class="cov-pill native">就绪</span>`;
        else if (item.available) statusBadge = `<span class="cov-pill bridged">待鉴权</span>`;
        else statusBadge = `<span class="cov-pill off">未检测到命令</span>`;
      }

      let probeClass = "agent-probe-status";
      let probeText = item.authHint || item.reason || "点击「测试握手」实时验证 ACP initialize + session/new";
      if (probe?.testing) {
        probeText = "正在启动子进程并执行 ACP 握手...";
      } else if (probe && probe.ok === true) {
        probeClass += " ok";
        probeText = `握手成功 (${probe.latencyMs}ms · session=${probe.sessionId || "ok"})`;
      } else if (probe && probe.ok === false) {
        probeClass += " err";
        probeText = `握手失败: ${probe.error || "unknown error"}`;
      }

      return `
        <div class="agent-cfg-card ${item.enabled === false ? "disabled" : ""}">
          <div class="agent-cfg-head">
            <div class="agent-cfg-title">
              ${tagHtml}
              <span class="agent-origin-badge">${item.builtin ? "内置" : "自定义"}</span>
              ${statusBadge}
            </div>
            <label class="toggle-wrap" title="启用/停用该 Agent">
              <input type="checkbox" data-toggle-agent="${esc(item.agent)}" ${item.enabled === false ? "" : "checked"} />
              <span>${item.enabled === false ? "停用" : "启用"}</span>
            </label>
          </div>
          ${item.description ? `<div class="res-desc">${esc(item.description)}</div>` : ""}
          <div class="agent-cmd-line" title="实际拉起的 stdio ACP 命令">${esc(cmdDisplay)}</div>
          <div class="${probeClass}">${esc(probeText)}</div>
          <div class="agent-cfg-actions">
            <div style="display:flex;gap:6px">
              <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-test-agent="${esc(item.agent)}" ${probe?.testing ? "disabled" : ""}>测试握手</button>
              <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-edit-agent="${esc(item.agent)}">配置</button>
            </div>
            ${item.builtin ? `<span class="mono" style="font-size:10.5px;color:var(--faint)">id=${esc(item.agent)}</span>` : `<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" data-del-agent="${esc(item.agent)}">移除</button>`}
          </div>
        </div>`;
    })
    .join("");

  container.innerHTML = `
    <div class="panel-sec-head">
      <div>
        <div class="panel-sec-title"><span class="num">04</span>/ ACP Agent 横向扩展接入</div>
        <div class="panel-sec-sub">统一通过 stdio ACP 协议纳管本地 CLI（claude / codex / agy / opencode / kimi 及自定义 Agent），复用权限审批、资源桥接与 Token 统计</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="refreshAgentsBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button">刷新状态</button>
        <button id="addCustomAgentBtn" class="alma-btn alma-btn-primary alma-btn-sm" type="button">${INTERACTIVE_STATE.showForm ? "收起表单" : "+ 接入自定义 Agent"}</button>
      </div>
    </div>
    ${formHtml}
    <div class="agents-grid">${cardsHtml}</div>
  `;

  const refreshBtn = document.getElementById("refreshAgentsBtn");
  if (refreshBtn) refreshBtn.onclick = () => void refreshAgentsList();

  const addBtn = document.getElementById("addCustomAgentBtn");
  if (addBtn) {
    addBtn.onclick = () => {
      if (INTERACTIVE_STATE.showForm) {
        INTERACTIVE_STATE.showForm = false;
        INTERACTIVE_STATE.editingId = null;
        renderAgentsView();
      } else {
        openFormWithTemplate({
          id: "",
          label: "",
          command: "",
          argsText: "acp",
          envText: "",
          color: "#3f6212",
          description: "",
        });
      }
    };
  }

  const cancelBtn = document.getElementById("cancelAgentFormBtn");
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      INTERACTIVE_STATE.showForm = false;
      INTERACTIVE_STATE.editingId = null;
      renderAgentsView();
    };
  }

  const form = document.getElementById("agentRegistryForm");
  if (form) form.onsubmit = saveAgentForm;

  container.querySelectorAll("[data-agent-tpl]").forEach((btn) => {
    btn.onclick = () => {
      const tpl = QUICK_TEMPLATES[Number(btn.dataset.agentTpl)];
      if (tpl) openFormWithTemplate(tpl);
    };
  });

  container.querySelectorAll("[data-toggle-agent]").forEach((el) => {
    el.onchange = () => void toggleAgentEnabled(el.dataset.toggleAgent, el.checked);
  });

  container.querySelectorAll("[data-test-agent]").forEach((btn) => {
    btn.onclick = () => void probeAgentHandshake(btn.dataset.testAgent);
  });

  container.querySelectorAll("[data-edit-agent]").forEach((btn) => {
    btn.onclick = () => {
      const found = list.find((a) => a.agent === btn.dataset.editAgent);
      if (found) openFormForEdit(found);
    };
  });

  container.querySelectorAll("[data-del-agent]").forEach((btn) => {
    btn.onclick = () => void deleteCustomAgent(btn.dataset.delAgent);
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || !data.__hubArtifactId) return;
  const h = Number(data.height);
  if (!Number.isFinite(h) || h <= 0) return;
  const target = document.querySelector(`iframe[data-artifact-frame="${CSS.escape(String(data.__hubArtifactId))}"]`);
  if (target) {
    target.style.height = `${Math.max(160, Math.min(780, Math.round(h + 12)))}px`;
  }
});

window.HUB_INTERACTIVE = {
  renderQuestions,
  renderAgentsView,
  onAgentsUpdated: () => {
    if (app?.STATE.stageView === "agents") {
      renderAgentsView();
    }
  },
};

if (app) {
  const prevOnStateChange = app.onStateChange;
  app.onStateChange = () => {
    prevOnStateChange?.();
    if (app.STATE.stageView === "agents") {
      renderAgentsView();
    } else if (app.STATE.stageView === "chat") {
      renderQuestions();
    }
  };
  if (app.STATE.stageView === "agents") {
    renderAgentsView();
  }
}

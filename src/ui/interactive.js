import { apiFetch, th, t } from "./i18n.js";

const app = window.HUB_APP;

const INTERACTIVE_STATE = {
  showForm: false,
  // "simple" 只填 ID、命令、参数；"full" 再加名称、模型、颜色、环境变量等
  formMode: "simple",
  editingId: null,
  formValues: {
    id: "",
    label: "",
    command: "",
    argsText: "",
    envText: "",
    color: "#3f6212",
    description: "",
    defaultModel: "",
    defaultEffort: "",
    modelsText: "",
  },
  probeResults: new Map(), // agentId -> { testing?: boolean, ok?: boolean, latencyMs?: number, sessionId?: string, error?: string }
  questionDrafts: new Map(), // questionId -> Map<fieldId, string | string[]>
};

// 预设（已知支持 ACP 的 CLI）由 hub 提供，并带上本机是否已安装
async function loadAgentPresets() {
  try {
    const res = await apiFetch("/api/agents/presets");
    const data = await res.json();
    if (res.ok && Array.isArray(data.presets)) {
      INTERACTIVE_STATE.presets = data.presets;
      if (app?.isAgentsViewOpen?.()) renderAgentsView();
    }
  } catch {
    // 旧版 hub 没有这个接口时，只是不显示预设
  }
}

async function addAgentPreset(id) {
  try {
    const res = await apiFetch("/api/agents/presets/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotAdd", id, data.error || res.status));
      return;
    }
    app.STATE.agents = data.agents || app.STATE.agents;
    INTERACTIVE_STATE.showForm = false;
    app.renderAgentControls?.();
    renderAgentsView();
    void loadAgentPresets();
    void probeAgentHandshake(id);
  } catch (err) {
    app.appendLog(t("errorAdding", id, err.message));
  }
}

// 把接入工作交给默认主导 Agent：它自己找启动命令，再调 hub 接口登记并验证握手
async function askAgentToRegister(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return;
  const lead = app.STATE.defaultLead || app.STATE.newTaskLead;
  const origin = location.origin;
  const prompt = [
    `请把本机的命令行工具「${name}」接入 RTM（${origin}）。`,
    "",
    "1. 找到它的可执行文件，查它的 --help 或文档，确认以 stdio 方式启动 ACP（Agent Client Protocol）服务的命令和参数。",
    `2. 登记：POST ${origin}/api/agents/save，JSON 请求体形如 {"id":"小写字母数字","label":"显示名","command":"可执行文件","args":["acp"]}。`,
    `3. 验证：POST ${origin}/api/agents/test，请求体 {"id":"上一步的 id"}。返回 ok 为 false 时按 error 调整命令或参数后重试。`,
    "4. 最后告诉我登记的 id、启动命令和握手结果。如果这个工具不支持 ACP，直接说明。",
    "",
    "只需要调用上面两个接口，不要阅读 RTM 的源码，也不要修改任何文件。",
  ].join("\n");
  INTERACTIVE_STATE.showForm = false;
  await app.createTaskGroup({ title: t("connect", name), leadAgent: lead });
  app.closeSettings?.();
  app.setStageView("chat");
  void app.sendStreamPrompt(prompt, app.STATE.activeStreamKey);
}

function parseModelsText(raw) {
  return [...new Set(String(raw || "").split(/[\r\n,，]+/).map((m) => m.trim()).filter(Boolean))];
}

// 切换简化/完整或重绘前，把输入框里的内容收回 formValues，避免丢失已填的字段
function captureAgentFormValues() {
  const fv = INTERACTIVE_STATE.formValues;
  const read = (id, key) => {
    const el = document.getElementById(id);
    if (el) fv[key] = el.value;
  };
  read("agentCfgId", "id");
  read("agentCfgCommand", "command");
  read("agentCfgArgs", "argsText");
  read("agentCfgLabel", "label");
  read("agentCfgDefaultModel", "defaultModel");
  read("agentCfgDefaultEffort", "defaultEffort");
  read("agentCfgModels", "modelsText");
  read("agentCfgColor", "color");
  read("agentCfgDesc", "description");
  read("agentCfgEnv", "envText");
}

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
        <span>${esc(q.title || t("questionsForYou"))}</span>
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
          extraInput.placeholder = field.placeholder || t("orEnterAdditionalDetails");
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
        input.placeholder = field.placeholder || t("enterYourAnswer");
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
    cancelBtn.textContent = t("skipCancel");
    cancelBtn.onclick = () => void submitQuestionResponse(q.questionId, true);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "alma-btn alma-btn-primary alma-btn-sm";
    submitBtn.textContent = t("submitAnswer");
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
    const res = await apiFetch("/api/questions/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, answers, cancelled }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotSubmitAnswer", data.error || res.status));
      return;
    }
    INTERACTIVE_STATE.questionDrafts.delete(questionId);
    app.STATE.pendingQuestions.delete(questionId);
    renderQuestions();
  } catch (err) {
    app.appendLog(t("answerSubmissionError", err.message));
  }
}

async function refreshAgentsList() {
  try {
    const res = await apiFetch("/api/agents");
    const data = await res.json();
    if (res.ok && Array.isArray(data.agents)) {
      app.STATE.agents = data.agents;
      if ("defaultLead" in data) {
        app.STATE.defaultLead = data.defaultLead || "";
        app.STATE.configuredDefaultLead = data.configuredDefaultLead || "";
      }
      app.renderAgentControls?.();
      renderAgentsView();
    }
  } catch (err) {
    app.appendLog(t("couldNotRefreshAgentList", err.message));
  }
}

// id 为空表示恢复自动（取第一个就绪的 Agent）
async function setDefaultLeadAgent(id) {
  try {
    const res = await apiFetch("/api/agents/default-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id || null }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotSetDefaultLead", data.error || res.status));
      return;
    }
    app.STATE.defaultLead = data.defaultLead || "";
    app.STATE.configuredDefaultLead = data.configured || "";
    if (data.defaultLead) app.STATE.newTaskLead = data.defaultLead;
    app.renderAgentControls?.();
    renderAgentsView();
    app.appendLog(id ? t("setAsTheDefaultLeadForNew", id) : t("defaultLeadSetToAutomaticCurrently", data.defaultLead));
  } catch (err) {
    app.appendLog(t("defaultLeadError", err.message));
  }
}

async function probeAgentHandshake(id) {
  INTERACTIVE_STATE.probeResults.set(id, { testing: true });
  renderAgentsView();
  try {
    const res = await apiFetch("/api/agents/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    INTERACTIVE_STATE.probeResults.set(id, { testing: false, ...data });
    if (data.ok && data.modelCatalog && app?.STATE?.modelCatalogs) {
      app.STATE.modelCatalogs.set(id, data.modelCatalog);
    }
    const modelCount = data.modelCatalog?.models?.length || 0;
    app.appendLog(
      data.ok
        ? t("acpHandshakeSucceededMsModelsSession", id, data.latencyMs, modelCount, data.sessionId || "-")
        : t("acpHandshakeFailed", id, data.error || "unknown"),
    );
  } catch (err) {
    INTERACTIVE_STATE.probeResults.set(id, { testing: false, ok: false, error: err.message });
  }
  renderAgentsView();
}

async function toggleAgentEnabled(id, enabled) {
  try {
    const res = await apiFetch("/api/agents/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotChangeAgentStatus", data.error || res.status));
      return;
    }
    app.STATE.agents = data.agents || app.STATE.agents;
    app.renderAgentControls?.();
    renderAgentsView();
  } catch (err) {
    app.appendLog(t("agentStatusError", err.message));
  }
}

async function deleteCustomAgent(id) {
  const ok = await (app.showConfirmModal
    ? app.showConfirmModal({
        title: t("removeCustomAgent"),
        message: t("removeTheCustomAgent", id),
        confirmText: t("removeAgent"),
        danger: true,
      })
    : Promise.resolve(false));
  if (!ok) return;
  try {
    const res = await apiFetch("/api/agents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotRemoveAgent", data.error || res.status));
      return;
    }
    app.STATE.agents = data.agents || app.STATE.agents;
    app.renderAgentControls?.();
    renderAgentsView();
  } catch (err) {
    app.appendLog(t("agentRemovalError", err.message));
  }
}

async function saveAgentForm(e) {
  e.preventDefault();
  captureAgentFormValues();
  const fv = INTERACTIVE_STATE.formValues;
  const full = INTERACTIVE_STATE.formMode === "full";
  const payload = {
    id: fv.id.trim(),
    command: fv.command.trim() || undefined,
    args: fv.command.trim() || fv.argsText.trim() ? parseArgsText(fv.argsText) : undefined,
    enabled: true,
  };
  if (full) {
    Object.assign(payload, {
      label: fv.label.trim() || undefined,
      env: parseEnvText(fv.envText),
      color: fv.color.trim() || undefined,
      description: fv.description.trim() || undefined,
      defaultModel: fv.defaultModel.trim(),
      defaultEffort: fv.defaultEffort.trim(),
      models: parseModelsText(fv.modelsText),
    });
  }

  if (!payload.id) return;

  try {
    const res = await apiFetch("/api/agents/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      app.appendLog(t("couldNotSaveAgentSettings", data.error || res.status));
      return;
    }
    INTERACTIVE_STATE.showForm = false;
    INTERACTIVE_STATE.editingId = null;
    app.STATE.agents = data.agents || app.STATE.agents;
    // 可用模型可能刚被改过：让模型选择框立刻用上新的列表
    for (const a of app.STATE.agents) {
      if (a.modelCatalog && app.STATE.modelCatalogs) app.STATE.modelCatalogs.set(a.agent, a.modelCatalog);
    }
    app.renderAgentControls?.();
    app.renderModelSelectorBar?.();
    renderAgentsView();
    app.appendLog(t("savedSettingsForAgent", payload.id));
  } catch (err) {
    app.appendLog(t("agentSettingsError", err.message));
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
    defaultModel: tpl.defaultModel || "",
    defaultEffort: tpl.defaultEffort || "",
    modelsText: "",
  };
  renderAgentsView();
}

function openFormForEdit(agentItem) {
  INTERACTIVE_STATE.showForm = true;
  INTERACTIVE_STATE.formMode = "full";
  INTERACTIVE_STATE.editingId = agentItem.agent;
  INTERACTIVE_STATE.formValues = {
    id: agentItem.agent,
    label: agentItem.label || agentItem.agent,
    // 内置 Agent 没改过命令时留空，表示继续用内置的启动方式
    command: agentItem.customCommand || (agentItem.builtin ? "" : (agentItem.command?.[0] ?? "")),
    argsText: (agentItem.customArgs ?? (agentItem.builtin ? [] : agentItem.command?.slice(1)) ?? []).join(" "),
    envText: formatEnvText(agentItem.env),
    color: agentItem.color || "#3f6212",
    description: agentItem.description || "",
    defaultModel: agentItem.defaultModel || "",
    defaultEffort: agentItem.defaultEffort || "",
    modelsText: (agentItem.models || []).join("\n"),
  };
  renderAgentsView();
}

function renderAgentsView() {
  if (!app) return;
  const container = app.els.agentsView;
  if (!container) return;

  const esc = app.escapeHtml;
  const list = app.STATE.agents && app.STATE.agents.length > 0 ? app.STATE.agents : app.getEnabledAgents();

  const fv = INTERACTIVE_STATE.formValues;
  const editing = Boolean(INTERACTIVE_STATE.editingId);
  const formCatalog = fv.id ? app.STATE.modelCatalogs?.get(fv.id) : null;
  const modelDatalist =
    formCatalog?.models?.length > 0
      ? `<datalist id="agentModelChoices">${formCatalog.models
          .map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`)
          .join("")}</datalist>`
      : "";
  const effortDatalist =
    formCatalog?.effort?.options?.length > 0
      ? `<datalist id="agentEffortChoices">${formCatalog.effort.options
          .map((o) => `<option value="${esc(o.id)}">${esc(o.name || o.id)}</option>`)
          .join("")}</datalist>`
      : "";

  const addable = (INTERACTIVE_STATE.presets || []).filter((p) => !p.registered);
  const installedPresets = addable.filter((p) => p.installed);
  const otherPresets = addable.filter((p) => !p.installed);
  const assistLead = app.STATE.defaultLead || app.STATE.newTaskLead;
  const presetTitle = (p) => `${p.description}: ${p.command} ${p.args.join(" ")}`;
  const addPanelHtml =
    INTERACTIVE_STATE.showForm && !editing
      ? `
      <div class="agent-add-panel">
        ${
          installedPresets.length > 0
            ? `<div class="agent-add-row">
                <span class="agent-add-label">${th("installedLocally")}</span>
                <div class="agent-add-chips">${installedPresets
                  .map(
                    (p) =>
                      `<button type="button" class="filter-pill preset-ready" data-add-preset="${esc(p.id)}" title="${esc(presetTitle(p))}">${th("add2", p.label)}</button>`,
                  )
                  .join("")}</div>
              </div>`
            : ""
        }
        <div class="agent-add-row">
          <span class="agent-add-label">${th("delegateToAnAgent")}</span>
          <div class="agent-add-chips">
            <input id="agentAssistInput" class="text-input" type="text" placeholder="${th("toolNameOrInstallationPath")}" autocomplete="off" />
            <button id="agentAssistBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button" title="${th("createATaskForToFindThe", assistLead)}">${th("askToConnectIt", assistLead)}</button>
          </div>
        </div>
        ${
          otherPresets.length > 0
            ? `<div class="agent-add-row">
                <span class="agent-add-label">${th("presets")}</span>
                <div class="agent-add-chips">${otherPresets
                  .map(
                    (p) =>
                      `<button type="button" class="filter-pill" data-fill-preset="${esc(p.id)}" title="${th("notDetectedLocally", presetTitle(p))}">${esc(p.label)}</button>`,
                  )
                  .join("")}</div>
              </div>`
            : ""
        }
      </div>`
      : "";

  const fullMode = INTERACTIVE_STATE.formMode === "full";
  const editingItem = editing ? list.find((a) => a.agent === INTERACTIVE_STATE.editingId) : null;
  const discoveredIds = editingItem?.discoveredModelIds || [];
  const fullFieldsHtml = fullMode
    ? `
        <div class="agent-form-grid">
          <div class="agent-form-field">
            <label>${th("displayName")}</label>
            <input id="agentCfgLabel" class="text-input" type="text" value="${esc(fv.label)}" />
          </div>
          <div class="agent-form-field">
            <label>${th("defaultModel")}</label>
            <input id="agentCfgDefaultModel" class="text-input" type="text" ${modelDatalist ? 'list="agentModelChoices"' : ""} placeholder="${th("useCliDefault")}" value="${esc(fv.defaultModel || "")}" />
          </div>
          <div class="agent-form-field">
            <label>${th("defaultReasoningEffort")}</label>
            <input id="agentCfgDefaultEffort" class="text-input" type="text" ${effortDatalist ? 'list="agentEffortChoices"' : ""} placeholder="${th("useCliDefault")}" value="${esc(fv.defaultEffort || "")}" />
          </div>
          <div class="agent-form-field">
            <label>${th("color")}</label>
            <input id="agentCfgColor" class="text-input" type="text" placeholder="#3f6212" value="${esc(fv.color)}" />
          </div>
          <div class="agent-form-field">
            <label>${th("notes")}</label>
            <input id="agentCfgDesc" class="text-input" type="text" value="${esc(fv.description)}" />
          </div>
        </div>
        <div class="agent-form-field">
          <label>${th("modelsListLabel")}${discoveredIds.length > 0
              ? ` <button type="button" id="fillDiscoveredModelsBtn" class="link-btn">${th("fillFromDetectedModels", discoveredIds.length)}</button>`
              : ""}</label>
          <textarea id="agentCfgModels" class="rule-editor-textarea" style="min-height:72px" placeholder="${th("showOnlyTheseModelsInTheModel")}">${esc(fv.modelsText || "")}</textarea>
        </div>
        <div class="agent-form-field">
          <label>${th("environmentVariablesOneKeyValuePerLine")}</label>
          <textarea id="agentCfgEnv" class="rule-editor-textarea" style="min-height:64px">${esc(fv.envText)}</textarea>
        </div>`
    : "";

  const formHtml = INTERACTIVE_STATE.showForm
    ? `
      ${addPanelHtml}
      <form id="agentRegistryForm" class="rule-editor-box">
        ${modelDatalist}${effortDatalist}
        <div class="panel-toolbar agent-form-head">
          <span class="agent-form-title">${editing ? t("configure", esc(fv.label || fv.id)) : t("addManually")}</span>
          <div class="settings-seg" id="agentFormModeSeg">
            <button type="button" data-form-mode="simple" class="${fullMode ? "" : "active"}">${th("basic")}</button>
            <button type="button" data-form-mode="full" class="${fullMode ? "active" : ""}">${th("advanced")}</button>
          </div>
        </div>
        <div class="agent-form-grid">
          <div class="agent-form-field">
            <label>ID</label>
            <input id="agentCfgId" class="text-input" type="text" placeholder="gemini" value="${esc(fv.id)}" ${editing ? "readonly" : ""} required />
          </div>
          <div class="agent-form-field">
            <label>${th("launchCommand")}</label>
            <input id="agentCfgCommand" class="text-input" type="text" placeholder="${editingItem?.builtin ? t("builtInDefault") : "gemini"}" value="${esc(fv.command)}" />
          </div>
          <div class="agent-form-field">
            <label>${th("arguments")}</label>
            <input id="agentCfgArgs" class="text-input" type="text" placeholder="${editingItem?.builtin ? t("builtInDefault") : "acp"}" value="${esc(fv.argsText)}" />
          </div>
        </div>
        ${fullFieldsHtml}
        <div class="panel-toolbar">
          <span></span>
          <div style="display:flex;gap:8px">
            <button id="cancelAgentFormBtn" class="alma-btn alma-btn-sm" type="button">${th("cancel")}</button>
            <button class="alma-btn alma-btn-primary alma-btn-sm" type="submit">${th("save")}</button>
          </div>
        </div>
      </form>`
    : "";

  const cardsHtml = list
    .map((item) => {
      const probe = INTERACTIVE_STATE.probeResults.get(item.agent);
      const isConfiguredLead = app.STATE.configuredDefaultLead === item.agent;
      const isAutoLead = !app.STATE.configuredDefaultLead && app.STATE.defaultLead === item.agent;
      const tagHtml = app.agentTagHtml
        ? app.agentTagHtml(item.agent, item.label || item.agent)
        : `<span class="agent-tag" data-agent="${esc(item.agent)}">${esc(item.label || item.agent)}</span>`;
      const cmdDisplay = Array.isArray(item.command) && item.command.length > 0 ? item.command.join(" ") : t("commandNotFound");
      let statusBadge = `<span class="cov-pill off">${th("disabled2")}</span>`;
      if (item.enabled !== false) {
        if (item.available && item.authReady) statusBadge = `<span class="cov-pill native">${th("ready")}</span>`;
        else if (item.available) statusBadge = `<span class="cov-pill bridged">${th("notSignedIn")}</span>`;
        else statusBadge = `<span class="cov-pill off">${th("notInstalled")}</span>`;
      }

      const catalog = item.modelCatalog || app.STATE.modelCatalogs?.get(item.agent);
      const modelCount = Array.isArray(catalog?.models) ? catalog.models.length : 0;
      const defaultModelText = item.defaultModel || catalog?.currentModelId || t("useCliDefault");
      // 只在有内容可说时才占一行：握手结果，或未就绪的原因
      let probeClass = "agent-probe-status";
      let probeText = item.authHintKey ? t(item.authHintKey) : item.authHint || item.reason || "";
      if (probe?.testing) {
        probeText = t("connecting");
      } else if (probe && probe.ok === true) {
        probeClass += " ok";
        probeText = t("handshakeSucceededInS", (probe.latencyMs / 1000).toFixed(1));
      } else if (probe && probe.ok === false) {
        probeClass += " err";
        probeText = t("handshakeFailed", probe.error || t("unknownError"));
      }

      return `
        <div class="agent-cfg-card ${item.enabled === false ? "disabled" : ""}" data-agent="${esc(item.agent)}"${app.getAgentColorStyle ? app.getAgentColorStyle(item.agent) : ""}>
          <div class="agent-cfg-head">
            <div class="agent-cfg-title">
              ${tagHtml}
              ${statusBadge}
              ${isConfiguredLead ? `<span class="cov-pill native" title="${th("leadsNewTasksByDefault")}">${th("defaultLead")}</span>` : isAutoLead ? `<span class="cov-pill bridged" title="${th("withAutomaticSelectionTheFirstReadyAgent")}">${th("defaultLeadAutomatic")}</span>` : ""}
            </div>
            <label class="toggle-wrap" title="${th("enableOrDisable")}">
              <input type="checkbox" data-toggle-agent="${esc(item.agent)}" ${item.enabled === false ? "" : "checked"} />
            </label>
          </div>
          <div class="res-meta">${esc(defaultModelText)}${item.defaultEffort ? ` · ${esc(item.defaultEffort)}` : ""}${modelCount > 0 ? t("availableModels", modelCount, item.models?.length ? t("restricted") : "") : ""}</div>
          <div class="agent-cmd-line" title="${esc(cmdDisplay)}">${esc(cmdDisplay)}</div>
          ${probeText ? `<div class="${probeClass}">${esc(probeText)}</div>` : ""}
          <div class="agent-cfg-actions">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-test-agent="${esc(item.agent)}" ${probe?.testing ? "disabled" : ""}>${th("test")}</button>
              <button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-edit-agent="${esc(item.agent)}">${th("configure2")}</button>
              ${item.enabled === false ? "" : isConfiguredLead ? `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-default-lead="" title="${th("chooseTheFirstReadyAgentAutomatically")}">${th("clearDefaultLead")}</button>` : `<button type="button" class="alma-btn alma-btn-outline alma-btn-sm" data-default-lead="${esc(item.agent)}">${th("setAsDefaultLead")}</button>`}
            </div>
            ${item.builtin ? "" : `<button type="button" class="alma-btn alma-btn-danger alma-btn-sm" data-del-agent="${esc(item.agent)}">${th("remove")}</button>`}
          </div>
        </div>`;
    })
    .join("");

  container.innerHTML = `
    <div class="panel-toolbar agents-toolbar">
      <span></span>
      <div style="display:flex;gap:8px">
        <button id="refreshAgentsBtn" class="alma-btn alma-btn-outline alma-btn-sm" type="button">${th("refresh")}</button>
        <button id="addCustomAgentBtn" class="alma-btn alma-btn-primary alma-btn-sm" type="button">${INTERACTIVE_STATE.showForm ? t("collapse") : t("addAgent")}</button>
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
        INTERACTIVE_STATE.formMode = "simple";
        openFormWithTemplate({
          id: "",
          label: "",
          command: "",
          argsText: "acp",
          envText: "",
          color: "#3f6212",
          description: "",
        });
        void loadAgentPresets();
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

  container.querySelectorAll("[data-form-mode]").forEach((btn) => {
    btn.onclick = () => {
      captureAgentFormValues();
      INTERACTIVE_STATE.formMode = btn.dataset.formMode;
      renderAgentsView();
    };
  });
  const fillModelsBtn = document.getElementById("fillDiscoveredModelsBtn");
  if (fillModelsBtn) {
    fillModelsBtn.onclick = () => {
      const area = document.getElementById("agentCfgModels");
      if (area) area.value = discoveredIds.join("\n");
    };
  }

  container.querySelectorAll("[data-add-preset]").forEach((btn) => {
    btn.onclick = () => void addAgentPreset(btn.dataset.addPreset);
  });
  container.querySelectorAll("[data-fill-preset]").forEach((btn) => {
    btn.onclick = () => {
      const preset = (INTERACTIVE_STATE.presets || []).find((p) => p.id === btn.dataset.fillPreset);
      if (preset) {
        openFormWithTemplate({ ...preset, argsText: preset.args.join(" ") });
      }
    };
  });
  const assistInput = document.getElementById("agentAssistInput");
  const assistBtn = document.getElementById("agentAssistBtn");
  if (assistInput && assistBtn) {
    assistBtn.onclick = () => void askAgentToRegister(assistInput.value);
    assistInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void askAgentToRegister(assistInput.value);
      }
    };
  }

  container.querySelectorAll("[data-toggle-agent]").forEach((el) => {
    el.onchange = () => void toggleAgentEnabled(el.dataset.toggleAgent, el.checked);
  });

  container.querySelectorAll("[data-default-lead]").forEach((btn) => {
    btn.onclick = () => void setDefaultLeadAgent(btn.dataset.defaultLead);
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
    if (app?.isAgentsViewOpen?.()) {
      renderAgentsView();
    }
  },
};

if (app) {
  const prevOnStateChange = app.onStateChange;
  app.onStateChange = () => {
    prevOnStateChange?.();
    if (app.isAgentsViewOpen?.()) {
      renderAgentsView();
    } else if (app.STATE.stageView === "chat") {
      renderQuestions();
    }
  };
  if (app.isAgentsViewOpen?.()) {
    renderAgentsView();
  }
}

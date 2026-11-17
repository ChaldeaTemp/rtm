import { apiFetch, getLocale, th, t } from "./i18n.js";

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
  quotas: new Map(),
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
    // 刚加进来的 Agent 如果还没登录，直接带着走完登录，不用自己去终端里敲命令
    const added = (app.STATE.agents || []).find((a) => a.agent === id);
    if (added && added.available && !added.authReady && added.canLogin) {
      const go = await app.showConfirmModal({
        title: t("agentNotSignedIn", added.label || id),
        message: t("openSignInPrompt"),
        confirmText: t("signIn"),
        cancelText: t("later"),
      });
      if (go) await loginAgent(id);
    }
    void probeAgentHandshake(id);
  } catch (err) {
    app.appendLog(t("errorAdding", id, err.message));
  }
}

// 登录：后端在本机打开一个终端窗口跑这个 Agent 的登录命令；这里等用户说登录好了再复查状态
async function loginAgent(id) {
  const label = (app.STATE.agents || []).find((a) => a.agent === id)?.label || id;
  try {
    const res = await apiFetch("/api/agents/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      await app.showConfirmModal({ title: t("couldNotOpenSignIn"), message: data.error || `HTTP ${res.status}`, confirmText: t("ok") });
      return;
    }
    for (;;) {
      const done = await app.showConfirmModal({
        title: t("signingInAgent", label),
        message: t("signInTerminalInstructions"),
        confirmText: t("signedInConfirmation"),
        cancelText: t("later"),
      });
      if (!done) return;
      const check = await (await apiFetch("/api/agents/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      app.STATE.agents = check.agents || app.STATE.agents;
      app.renderAgentControls?.();
      renderAgentsView();
      const now = (app.STATE.agents || []).find((a) => a.agent === id);
      if (now?.authReady) {
        void probeAgentHandshake(id);
        return;
      }
      const again = await app.showConfirmModal({
        title: t("signInNotDetected"),
        message: now?.authHintKey ? t(now.authHintKey, ...(now.authHintArgs || [])) : now?.authHint || t("signInIncomplete"),
        confirmText: t("checkAgain"),
        cancelText: t("close"),
      });
      if (!again) return;
    }
  } catch (err) {
    app.appendLog(t("agentSignInError", id, err.message));
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
  const items = [...app.STATE.pendingQuestions.values()].filter((q) => q.groupId === app.STATE.activeGroupId);
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
    card.dataset.questionId = q.questionId;
    card.tabIndex = -1;

    const head = document.createElement("div");
    head.className = "question-card-head";
    const tagHtml = app.agentTagHtml
      ? app.agentTagHtml(q.agent)
      : `<span class="agent-tag" data-agent="${esc(q.agent)}">${esc(q.agent)}</span>`;
    head.innerHTML = `
      <div class="question-card-title">
        ${tagHtml}
        <span>${esc(q.title || t("questionsForYou"))}</span>
        ${(() => {
          // 子会话提的问题要说清楚是谁在问：人多半停在主导对话里，不看这个就不知道哪条线卡住了
          const from = app.STATE.sessions.get(q.sessionKey);
          if (!from || from.role !== "sub") return "";
          return `<button type="button" class="origin-tag question-from" data-question-session="${esc(q.sessionKey)}" data-question-group="${esc(q.groupId || "")}">${th("questionFromSubSession", from.label || from.name)}</button>`;
        })()}
      </div>
      <span class="mono" style="font-size:11px;color:var(--faint)">${app.formatTime(q.createdAt)}</span>
    `;
    card.appendChild(head);
    const fromBtn = head.querySelector("[data-question-session]");
    if (fromBtn) {
      fromBtn.onclick = () => app.selectGroup?.(fromBtn.dataset.questionGroup || app.STATE.activeGroupId, `sub:${fromBtn.dataset.questionSession}`);
    }

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
      for (const [id, quota] of INTERACTIVE_STATE.quotas) {
        if (quota.status !== "loading") INTERACTIVE_STATE.quotas.delete(id);
      }
      if (INTERACTIVE_STATE.showForm) captureAgentFormValues();
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
  if (INTERACTIVE_STATE.showForm) captureAgentFormValues();
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
  if (INTERACTIVE_STATE.showForm) captureAgentFormValues();
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
    INTERACTIVE_STATE.quotas.delete(id);
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
    INTERACTIVE_STATE.quotas.delete(payload.id.toLowerCase());
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

function renderQuota(agent) {
  const quota = INTERACTIVE_STATE.quotas.get(agent);
  const heading = `<div class="agent-quota-heading">${th("agentSubscriptionQuota")}</div>`;
  if (!quota || quota.status === "loading") return `${heading}<div class="agent-quota-state is-loading">${th("agentQuotaLoading")}</div>`;
  if (quota.status !== "ok") {
    return `${heading}<div class="agent-quota-state">${th(quota.status === "error" ? "agentQuotaError" : "agentQuotaUnavailable")}</div>
      <button type="button" class="link-btn" data-quota-retry="${app.escapeHtml(agent)}">${th("agentQuotaRetry")}</button>`;
  }
  const locale = getLocale();
  const esc = app.escapeHtml;
  const date = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const windows = quota.windows.map(({ name, minutes, usedPercent, resetsAt }) => {
    let duration = "";
    if (minutes) {
      if (minutes % 1440 === 0) duration = t("agentQuotaDays", minutes / 1440);
      else if (minutes % 60 === 0) duration = t("agentQuotaHours", minutes / 60);
      else duration = t("agentQuotaMinutes", minutes);
    }
    if (name === "monthTotal") name = t("agentQuotaMonthTotal");
    if (name === "monthCode") name = t("agentQuotaMonthCode");
    const label = [name, duration].filter(Boolean).join(" · ") || t("agentSubscriptionQuota");
    const remaining = Number((100 - usedPercent).toFixed(1));
    const resetDate = new Date(resetsAt);
    const reset = Number.isFinite(resetDate.getTime()) ? t("agentQuotaResetAt", date.format(resetDate)) : "";
    const tone = remaining <= 10 ? "is-low" : remaining <= 30 ? "is-warning" : "";
    return `<li class="agent-quota-window ${tone}">
      <div class="agent-quota-line"><span>${esc(label)}</span><strong>${remaining}<small>% ${th("agentQuotaLeft")}</small></strong></div>
      <meter min="0" max="100" value="${remaining}" aria-label="${esc(t("agentQuotaRemaining", label, remaining))}">${remaining}%</meter>
      ${reset ? `<div class="agent-quota-reset">${esc(reset)}</div>` : ""}</li>`;
  });
  if (quota.balance) {
    const { amount, currency } = quota.balance;
    const balance = currency
      ? t("agentQuotaBalance", new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount))
      : t("agentQuotaCredits", new Intl.NumberFormat(locale).format(amount));
    windows.push(`<li>${esc(balance)}</li>`);
  }
  const updated = quota.sourceUpdatedAt || quota.checkedAt;
  return `${heading}<ul class="agent-quota-list">${windows.join("")}</ul>
    <div class="agent-quota-updated">${th(quota.source === "reclaude-cache" ? "agentQuotaCached" : "agentQuotaChecked", date.format(new Date(updated)))}</div>`;
}

async function loadQuota(row) {
  const agent = row.dataset.agentQuota;
  const quotas = INTERACTIVE_STATE.quotas;
  const current = quotas.get(agent);
  if (current?.status === "loading" || (current && Date.now() - current.checkedAt < (current.status === "ok" ? 60_000 : 15_000))) return;
  const pending = { status: "loading" };
  quotas.set(agent, pending);
  row.innerHTML = renderQuota(agent);
  let result;
  try {
    const response = await apiFetch(`/api/agents/quota?agent=${encodeURIComponent(agent)}`);
    const data = await response.json();
    if (response.ok) result = data.quota;
  } catch {
    // Show the row's retryable error state.
  }
  if (quotas.get(agent) !== pending) return;
  quotas.set(agent, result || { status: "error", checkedAt: Date.now() });
  const currentRow = app.els.agentsView.querySelector(`[data-agent-quota="${CSS.escape(agent)}"]`);
  if (currentRow) currentRow.innerHTML = renderQuota(agent);
}

function renderAgentsView() {
  if (!app) return;
  const container = app.els.agentsView;
  if (!container) return;

  const esc = app.escapeHtml;
  const list = app.STATE.agents && app.STATE.agents.length > 0 ? app.STATE.agents : app.getEnabledAgents();

  const fv = INTERACTIVE_STATE.formValues;
  const editing = Boolean(INTERACTIVE_STATE.editingId);
  const editingItem = editing ? list.find((a) => a.agent === INTERACTIVE_STATE.editingId) : null;
  const formCatalog = (fv.id ? app.STATE.modelCatalogs?.get(fv.id) : null) || editingItem?.modelCatalog;
  const modelOptions = formCatalog?.models || [];
  const claudeAliases = fv.id === "claude" && editingItem?.builtin && !fv.command?.trim()
    ? ["opus", "sonnet", "haiku", "fable", "opusplan"].filter((id) => !modelOptions.some((m) => m.id === id)) : [];
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
  const discoveredIds = editingItem?.discoveredModelIds || [];
  const fullFieldsHtml = fullMode
    ? `
        <div class="agent-form-grid">
          <div class="agent-form-field">
            <label>${th("displayName")}</label>
            <input id="agentCfgLabel" class="text-input" type="text" value="${esc(fv.label)}" />
          </div>
          <div class="agent-form-field">
            <label for="agentCfgDefaultModel">${th("defaultModel")}</label>
            <input id="agentCfgDefaultModel" class="text-input" type="text" placeholder="${th("useCliDefault")}" value="${esc(fv.defaultModel || "")}" />
            ${modelOptions.length || claudeAliases.length ? `<select id="agentModelChoices" class="perm-select" aria-label="${th("pickDetectedModel")}">
              <option value="" disabled selected>${th("pickDetectedModel")}</option>
              <option value=" ">${th("useCliModelInPicker")}</option>
              ${modelOptions.map((model) => `<option value="${esc(model.id)}">${esc(model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id)}</option>`).join("")}
              ${claudeAliases.length ? `<optgroup label="${th("agentModelAliases")}">${claudeAliases.map((id) => `<option value="${id}">${id}</option>`).join("")}</optgroup>` : ""}
            </select>` : ""}
            ${claudeAliases.length ? `<small class="res-meta">${th("agentModelAliasHint")}</small>` : ""}
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
        ${effortDatalist}
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
      let probeText = item.authHintKey ? t(item.authHintKey, ...(item.authHintArgs || [])) : item.authHint || item.reason || "";
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
          ${item.enabled && item.available && item.quotaSupported
            ? `<div class="agent-quota" role="status" data-agent-quota="${esc(item.agent)}">${renderQuota(item.agent)}</div>` : ""}
          <div class="agent-cfg-actions">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${item.enabled !== false && item.available && !item.authReady && item.canLogin ? `<button type="button" class="alma-btn alma-btn-primary alma-btn-sm" data-login-agent="${esc(item.agent)}">${th("signIn")}</button>` : ""}
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
  container.onclick = (event) => {
    const retry = event.target.closest("[data-quota-retry]");
    if (!retry) return;
    INTERACTIVE_STATE.quotas.delete(retry.dataset.quotaRetry);
    void loadQuota(retry.closest("[data-agent-quota]"));
  };

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
  const modelChoices = document.getElementById("agentModelChoices");
  if (modelChoices) {
    modelChoices.onchange = () => {
      const input = document.getElementById("agentCfgDefaultModel");
      input.value = modelChoices.value.trim();
      INTERACTIVE_STATE.formValues.defaultModel = input.value;
      modelChoices.selectedIndex = 0;
    };
  }

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

  container.querySelectorAll("[data-login-agent]").forEach((btn) => {
    btn.onclick = () => void loginAgent(btn.dataset.loginAgent);
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
  if (app.isAgentsViewOpen?.()) {
    container.querySelectorAll("[data-agent-quota]").forEach((row) => void loadQuota(row));
  }
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
      if (INTERACTIVE_STATE.showForm) captureAgentFormValues();
      renderAgentsView();
    }
  },
};

if (app) {
  const prevOnStateChange = app.onStateChange;
  app.onStateChange = () => {
    prevOnStateChange?.();
    if (app.isAgentsViewOpen?.()) {
      if (INTERACTIVE_STATE.showForm) captureAgentFormValues();
      renderAgentsView();
    } else if (app.STATE.stageView === "chat") {
      renderQuestions();
    }
  };
  if (app.isAgentsViewOpen?.()) {
    renderAgentsView();
  }
}

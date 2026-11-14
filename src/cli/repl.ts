import readline from "node:readline";
import { getLocale, t } from "../hub/i18n.js";
import { taskTitle } from "../ui/locale.js";
import type { AgentId, HubEvent, PermissionMode } from "../types.js";
import type { AgentHubServer } from "../hub/server.js";
import { openInteractiveWindow } from "../ui/launcher.js";

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (value === "all" || value === "approve-all") return "approve-all";
  if (value === "reads" || value === "approve-reads") return "approve-reads";
  if (value === "manual") return "manual";
  return undefined;
}

export async function runRepl(hub: AgentHubServer): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  let currentGroupId = hub.getDefaultGroupId();
  let activeLeadStreaming = false;
  let wroteStreamLine = false;

  const ensureValidGroup = () => {
    const existing = hub.getGroup(currentGroupId);
    if (existing) {
      return existing;
    }
    currentGroupId = hub.getDefaultGroupId();
    return hub.getGroup(currentGroupId) ?? hub.listGroups()[0]!;
  };

  const onEvent = (event: HubEvent): void => {
    if (event.type === "agent_chunk") {
      if (
        event.streamKey === `lead:${currentGroupId}` &&
        event.channel === "message" &&
        activeLeadStreaming
      ) {
        process.stdout.write(event.text);
        wroteStreamLine = true;
      }
    } else if (event.type === "tool_event") {
      if (activeLeadStreaming || event.streamKey !== `lead:${currentGroupId}`) {
        if (wroteStreamLine) {
          process.stdout.write("\n");
          wroteStreamLine = false;
        }
        process.stdout.write(
          t("cliTool", event.sessionKey, event.title, event.status ? ` (${event.status})` : ""),
        );
      }
    } else if (event.type === "task_updated") {
      if (
        event.task.status === "running" ||
        event.task.status === "completed" ||
        event.task.status === "failed"
      ) {
        if (wroteStreamLine) {
          process.stdout.write("\n");
          wroteStreamLine = false;
        }
        process.stdout.write(
          t("cliPeer", event.task.taskId, event.task.groupId, event.task.callerAgent, event.task.targetAgent, event.task.status),
        );
      }
    } else if (event.type === "permission_requested") {
      if (wroteStreamLine) {
        process.stdout.write("\n");
        wroteStreamLine = false;
      }
      const p = event.permission;
      process.stdout.write(
        t("cliPermission", p.sessionKey, p.toolTitle, p.requestId),
      );
    } else if (event.type === "artifact_created") {
      if (wroteStreamLine) {
        process.stdout.write("\n");
        wroteStreamLine = false;
      }
      process.stdout.write(
        t("cliArtifact", event.artifact.title, event.artifact.kind, hub.getUrl(), event.artifact.artifactId),
      );
    } else if (event.type === "question_requested") {
      if (wroteStreamLine) {
        process.stdout.write("\n");
        wroteStreamLine = false;
      }
      process.stdout.write(
        t("cliQuestion", event.question.title, event.question.questionId),
      );
    }
  };

  hub.pool.on("hub_event", onEvent);

  const printPrompt = (): void => {
    const grp = ensureValidGroup();
    const leadSess = hub.pool.getSession(`${grp.leadAgent}:${grp.groupId}__lead`);
    const activeModel = leadSess?.currentModelId || grp.leadModel;
    const modelSuffix = activeModel ? `(${activeModel})` : "";
    rl.setPrompt(
      t("cliPrompt", taskTitle(getLocale(), grp), grp.groupId, grp.leadAgent, modelSuffix, hub.pool.getPermissionMode()),
    );
    rl.prompt();
  };

  console.log(t("cliStarted", hub.getUrl(), hub.baseCwd));
  console.log(t("cliIntro"));
  printPrompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      printPrompt();
      continue;
    }

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest[0];

      if (cmd === "/quit" || cmd === "/exit") {
        break;
      }

      if (cmd === "/help") {
        const enabledIds = hub.registry.listEnabledIds().join("|");
        console.log(
          [
            t("cliCommands"),
            t("cliHelpTasks"),
            t("cliHelpNew", enabledIds),
            t("cliHelpUse"),
            t("cliHelpLead", enabledIds),
            t("cliHelpModels"),
            t("cliHelpModel"),
            t("cliHelpSubs"),
            t("cliHelpAgents"),
            t("cliHelpUi"),
            t("cliHelpBrowser"),
            t("cliHelpSessions"),
            t("cliHelpWorktrees"),
            t("cliHelpResources"),
            t("cliHelpUsage"),
            t("cliHelpApprove"),
            t("cliHelpCancel"),
            t("cliHelpQuit"),
          ].join("\n"),
        );
      } else if (cmd === "/tasks") {
        const groups = hub.listGroups();
        const sessions = hub.pool.listSessions();
        for (const g of groups) {
          const subs = sessions.filter((s) => s.groupId === g.groupId && s.role === "sub").length;
          const marker = g.groupId === currentGroupId ? "*" : " ";
          console.log(t("cliTaskRow", marker, g.groupId, taskTitle(getLocale(), g), g.leadAgent, subs));
        }
      } else if (cmd === "/new") {
        let leadAgent: AgentId | undefined;
        let titleParts = rest;
        if (rest[0] && hub.registry.isEnabledAgent(rest[0])) {
          leadAgent = rest[0];
          titleParts = rest.slice(1);
        }
        const title = titleParts.join(" ").trim() || undefined;
        const created = hub.createGroup({ title, leadAgent });
        currentGroupId = created.groupId;
        console.log(t("cliCreatedTask", created.groupId, taskTitle(getLocale(), created), created.leadAgent));
      } else if (cmd === "/use") {
        if (!arg || !hub.getGroup(arg)) {
          console.log(t("cliUseUsage"));
        } else {
          currentGroupId = arg;
          const g = hub.getGroup(arg)!;
          console.log(t("cliSwitchedTask", g.groupId, taskTitle(getLocale(), g), g.leadAgent));
        }
      } else if (cmd === "/lead") {
        const g = ensureValidGroup();
        if (!arg || !hub.registry.isEnabledAgent(arg)) {
          console.log(
            t("cliLeadUsage", hub.registry.listEnabledIds().join("|"), g.groupId, g.leadAgent),
          );
        } else {
          hub.setGroupLeadAgent(g.groupId, arg);
          console.log(t("cliChangedLead", g.groupId, arg));
        }
      } else if (cmd === "/models") {
        const g = ensureValidGroup();
        const refresh = rest.includes("--refresh");
        const candidateAgent = rest.find((r) => r !== "--refresh");
        const targetAgent =
          candidateAgent && hub.registry.isKnownAgent(candidateAgent) ? candidateAgent : g.leadAgent;
        console.log(t("cliProbingModels", targetAgent));
        const catalog = await hub.registry.discoverModels(targetAgent, hub.baseCwd, refresh);
        console.log(t("cliModelList", targetAgent, catalog.currentModelId ?? "auto"));
        for (const m of catalog.models) {
          console.log(`  - ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`);
        }
        if (catalog.effort) {
          console.log(
            t("cliModelEffort", catalog.effort.configId, catalog.effort.currentValue, catalog.effort.options.map((o) => o.id).join(", ")),
          );
        }
      } else if (cmd === "/model") {
        const g = ensureValidGroup();
        const leadSess = hub.pool.getSession(`${g.leadAgent}:${g.groupId}__lead`);
        if (!arg) {
          console.log(
            t("cliModelSettings", g.groupId, g.leadAgent, g.leadModel ?? "auto", g.leadEffort ?? "auto", leadSess?.currentModelId ?? "-", leadSess?.currentEffort ?? "-"),
          );
        } else {
          const modelVal = arg === "auto" || arg === "reset" ? "" : arg;
          const effortVal = rest[1]
            ? rest[1] === "auto" || rest[1] === "reset"
              ? ""
              : rest[1]
            : undefined;
          const res = await hub.setGroupModel(g.groupId, { model: modelVal, effort: effortVal });
          console.log(
            t("cliModelUpdated", g.groupId, res.group.leadAgent, res.group.leadModel ?? "auto", res.group.leadEffort ?? "auto", res.session ? t("cliModelLive", res.session.currentModelId ?? "-") : ""),
          );
        }
      } else if (cmd === "/agents") {
        for (const a of hub.registry.getHealthList(true)) {
          const status = t(!a.enabled ? "cliDisabled" : a.available ? "cliReady" : "cliUnavailable");
          const origin = t(a.builtin ? "cliBuiltin" : "cliCustom");
          console.log(`- ${a.agent} (${a.label}) [${status}, ${origin}]: ${a.reason ?? "OK"}`);
        }
      } else if (cmd === "/subs") {
        const subs = hub.pool
          .listSessions()
          .filter((s) => s.groupId === currentGroupId && s.role === "sub");
        if (subs.length === 0) {
          console.log(t("cliNoSubsessions", currentGroupId));
        } else {
          for (const s of subs) {
            console.log(t("cliSubsessionRow", s.sessionKey, s.status, s.label, s.branch ? ` branch=${s.branch}` : ""));
          }
        }
      } else if (cmd === "/ui" || cmd === "/pop") {
        const res = openInteractiveWindow(hub.getUrl(), true);
        console.log(t("cliOpenedWorkbench", res.mode, hub.getUrl()));
      } else if (cmd === "/browser") {
        const res = openInteractiveWindow(hub.getUrl(), false);
        console.log(t("cliOpenedWorkbench", res.mode, hub.getUrl()));
      } else if (cmd === "/sessions") {
        const sessions = hub.pool.listSessions();
        if (sessions.length === 0) {
          console.log(t("cliNoSessions"));
        } else {
          for (const s of sessions) {
            console.log(
              t("cliSessionRow", s.sessionKey, s.groupId, s.role, s.status, s.effectiveCwd, s.branch ? ` branch=${s.branch}` : ""),
            );
          }
        }
      } else if (cmd === "/worktrees") {
        const wts = hub.pool.listSessions().filter((s) => s.isWorktree);
        if (wts.length === 0) {
          console.log(t("cliNoWorktrees"));
        } else {
          for (const s of wts) {
            console.log(`- ${s.sessionKey}: ${s.effectiveCwd} (${s.branch ?? "detached"})`);
          }
        }
      } else if (cmd === "/resources") {
        const items = hub.resources.discover();
        const budgets = hub.resources.getAgentBudgets();
        const rules = items.filter((i) => i.kind === "rule");
        const skills = items.filter((i) => i.kind === "skill");
        console.log(t("cliSharedResources", rules.length, skills.length));
        for (const b of budgets) {
          console.log(
            t("cliResourceBudget", b.agent, b.nativeRules, b.nativeSkills, b.bridgedRules, b.bridgedSkills, b.firstTurnInjectionTokens),
          );
        }
      } else if (cmd === "/usage") {
        const snap = hub.getTelemetrySnapshot();
        console.log(
          t("cliUsageTotals", snap.totals.turns, snap.totals.totalTokens, snap.totals.inputTokens, snap.totals.cachedReadTokens, snap.totals.outputTokens, snap.totals.thoughtTokens),
        );
        for (const [agent, usage] of Object.entries(snap.byAgent)) {
          if (!usage) continue;
          console.log(
            t("cliAgentUsage", agent, usage.turns, usage.totalTokens, usage.inputTokens, usage.cachedReadTokens, usage.outputTokens),
          );
        }
      } else if (cmd === "/approve") {
        const mode = parsePermissionMode(arg);
        if (!mode) {
          console.log(t("cliApproveUsage", hub.pool.getPermissionMode()));
        } else {
          hub.pool.setPermissionMode(mode);
          console.log(t("cliPermissionChanged", mode));
        }
      } else if (cmd === "/cancel") {
        if (!arg) {
          console.log(t("cliCancelUsage"));
        } else {
          const ok = await hub.pool.cancelSession(arg);
          console.log(ok ? t("cliCancelSent", arg) : t("cliSessionMissing", arg));
        }
      } else {
        console.log(t("cliUnknownCommand", cmd));
      }

      printPrompt();
      continue;
    }

    activeLeadStreaming = true;
    wroteStreamLine = false;
    try {
      const grp = ensureValidGroup();
      const result = await hub.runLeadChat({ groupId: grp.groupId, prompt: line });
      if (!wroteStreamLine && result.outputText) {
        process.stdout.write(result.outputText);
        wroteStreamLine = true;
      }
      if (wroteStreamLine) {
        process.stdout.write("\n");
      }
    } catch (err) {
      console.error(t("cliError", err instanceof Error ? err.message : String(err)));
    } finally {
      activeLeadStreaming = false;
      wroteStreamLine = false;
    }

    printPrompt();
  }

  hub.pool.off("hub_event", onEvent);
  rl.close();
}

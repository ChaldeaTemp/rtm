import readline from "node:readline";
import type { AgentId, HubEvent, PermissionMode } from "../types.js";
import type { AgentHubServer } from "../hub/server.js";
import { openInteractiveWindow } from "../ui/launcher.js";

function isValidAgent(value: string | undefined): value is AgentId {
  return value === "claude" || value === "codex" || value === "agy";
}

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
          `\x1b[90m[${event.sessionKey}] tool: ${event.title}${event.status ? ` (${event.status})` : ""}\x1b[0m\n`,
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
          `\x1b[36m[peer ${event.task.taskId} | ${event.task.groupId}] ${event.task.callerAgent} -> ${event.task.targetAgent}: ${event.task.status}\x1b[0m\n`,
        );
      }
    } else if (event.type === "permission_requested") {
      if (wroteStreamLine) {
        process.stdout.write("\n");
        wroteStreamLine = false;
      }
      const p = event.permission;
      process.stdout.write(
        `\x1b[33m[permission] ${p.sessionKey} requests "${p.toolTitle}". Open /ui to approve or resolve via API (requestId=${p.requestId}).\x1b[0m\n`,
      );
    }
  };

  hub.pool.on("hub_event", onEvent);

  const printPrompt = (): void => {
    const grp = ensureValidGroup();
    rl.setPrompt(`[${grp.title} (${grp.groupId}) | lead:${grp.leadAgent} | ${hub.pool.getPermissionMode()}] > `);
    rl.prompt();
  };

  console.log(`Agent Hub started at ${hub.getUrl()} (cwd: ${hub.baseCwd})`);
  console.log(`Type a prompt, or /help for commands (/tasks, /new, /use, /lead, /subs, /ui, /quit).`);
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
        console.log(
          [
            "Commands:",
            "  /tasks                       List all task groups and sub-session counts",
            "  /new [claude|codex|agy] [t]  Create a new parallel task group and switch to it",
            "  /use <groupId>               Switch active task group",
            "  /lead <claude|codex|agy>     Switch the lead agent of the current task group",
            "  /subs                        List all sub-sessions in the current task group",
            "  /ui | /pop                   Open interactive desktop app window",
            "  /browser                     Open interactive workbench in default browser",
            "  /sessions                    List all active ACP sessions and worktrees",
            "  /worktrees                   List sessions isolated in git worktrees",
            "  /resources                   List shared rules & skills and per-agent budgets",
            "  /usage                       Show token consumption and context injection summary",
            "  /approve <all|reads|manual>  Set tool permission policy",
            "  /cancel <sessionKey>         Cancel a busy session",
            "  /quit                        Stop hub and exit",
          ].join("\n"),
        );
      } else if (cmd === "/tasks") {
        const groups = hub.listGroups();
        const sessions = hub.pool.listSessions();
        for (const g of groups) {
          const subs = sessions.filter((s) => s.groupId === g.groupId && s.role === "sub").length;
          const marker = g.groupId === currentGroupId ? "*" : " ";
          console.log(`${marker} ${g.groupId}  ${g.title}  lead=${g.leadAgent}  subs=${subs}`);
        }
      } else if (cmd === "/new") {
        let leadAgent: AgentId | undefined;
        let titleParts = rest;
        if (isValidAgent(rest[0])) {
          leadAgent = rest[0];
          titleParts = rest.slice(1);
        }
        const title = titleParts.join(" ").trim() || undefined;
        const created = hub.createGroup({ title, leadAgent });
        currentGroupId = created.groupId;
        console.log(`Created & switched to task ${created.groupId} (${created.title}, lead=${created.leadAgent})`);
      } else if (cmd === "/use") {
        if (!arg || !hub.getGroup(arg)) {
          console.log("Usage: /use <groupId> (run /tasks to see group IDs)");
        } else {
          currentGroupId = arg;
          const g = hub.getGroup(arg)!;
          console.log(`Switched to task ${g.groupId} (${g.title}, lead=${g.leadAgent})`);
        }
      } else if (cmd === "/lead") {
        const g = ensureValidGroup();
        if (!isValidAgent(arg)) {
          console.log(`Usage: /lead <claude|codex|agy> (current for ${g.groupId}: ${g.leadAgent})`);
        } else {
          hub.setGroupLeadAgent(g.groupId, arg);
          console.log(`Lead for task ${g.groupId} switched to ${arg}`);
        }
      } else if (cmd === "/subs") {
        const subs = hub.pool
          .listSessions()
          .filter((s) => s.groupId === currentGroupId && s.role === "sub");
        if (subs.length === 0) {
          console.log(`No sub-sessions in task ${currentGroupId}.`);
        } else {
          for (const s of subs) {
            console.log(`- ${s.sessionKey} [${s.status}] label=${s.label}${s.branch ? ` branch=${s.branch}` : ""}`);
          }
        }
      } else if (cmd === "/ui" || cmd === "/pop") {
        const res = openInteractiveWindow(hub.getUrl(), true);
        console.log(`Opened workbench (${res.mode}) at ${hub.getUrl()}`);
      } else if (cmd === "/browser") {
        const res = openInteractiveWindow(hub.getUrl(), false);
        console.log(`Opened workbench (${res.mode}) at ${hub.getUrl()}`);
      } else if (cmd === "/sessions") {
        const sessions = hub.pool.listSessions();
        if (sessions.length === 0) {
          console.log("No active sessions.");
        } else {
          for (const s of sessions) {
            console.log(
              `- ${s.sessionKey} [${s.groupId}:${s.role}] [${s.status}] cwd=${s.effectiveCwd}${s.branch ? ` branch=${s.branch}` : ""}`,
            );
          }
        }
      } else if (cmd === "/worktrees") {
        const wts = hub.pool.listSessions().filter((s) => s.isWorktree);
        if (wts.length === 0) {
          console.log("No active worktree sessions.");
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
        console.log(`Shared resources: ${rules.length} rules, ${skills.length} skills`);
        for (const b of budgets) {
          console.log(
            `  ${b.agent}: native=(${b.nativeRules}r/${b.nativeSkills}s) bridged=(${b.bridgedRules}r/${b.bridgedSkills}s) firstTurn~${b.firstTurnInjectionTokens} tok`,
          );
        }
      } else if (cmd === "/usage") {
        const snap = hub.getTelemetrySnapshot();
        console.log(
          `Totals: turns=${snap.totals.turns} total=${snap.totals.totalTokens} (in=${snap.totals.inputTokens}, cache=${snap.totals.cachedReadTokens}, out=${snap.totals.outputTokens}, thought=${snap.totals.thoughtTokens})`,
        );
        for (const agent of ["claude", "codex", "agy"] as const) {
          const t = snap.byAgent[agent];
          console.log(
            `  ${agent}: turns=${t.turns} total=${t.totalTokens} in=${t.inputTokens} cache=${t.cachedReadTokens} out=${t.outputTokens}`,
          );
        }
      } else if (cmd === "/approve") {
        const mode = parsePermissionMode(arg);
        if (!mode) {
          console.log(`Usage: /approve <all|reads|manual> (current: ${hub.pool.getPermissionMode()})`);
        } else {
          hub.pool.setPermissionMode(mode);
          console.log(`Permission mode set to ${mode}`);
        }
      } else if (cmd === "/cancel") {
        if (!arg) {
          console.log("Usage: /cancel <sessionKey>");
        } else {
          const ok = await hub.pool.cancelSession(arg);
          console.log(ok ? `Cancel sent to ${arg}` : `Session not found: ${arg}`);
        }
      } else {
        console.log(`Unknown command: ${cmd}. Try /help.`);
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
      console.error(`\n[Error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activeLeadStreaming = false;
      wroteStreamLine = false;
    }

    printPrompt();
  }

  hub.pool.off("hub_event", onEvent);
  rl.close();
}

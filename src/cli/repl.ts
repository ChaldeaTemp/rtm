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

  let activeLeadStreaming = false;
  let wroteStreamLine = false;

  const onEvent = (event: HubEvent): void => {
    if (event.type === "agent_chunk") {
      if (event.sessionKey.endsWith(":main") && event.channel === "message" && activeLeadStreaming) {
        process.stdout.write(event.text);
        wroteStreamLine = true;
      }
    } else if (event.type === "tool_event") {
      if (activeLeadStreaming || !event.sessionKey.endsWith(":main")) {
        if (wroteStreamLine) {
          process.stdout.write("\n");
          wroteStreamLine = false;
        }
        process.stdout.write(
          `\x1b[90m[${event.sessionKey}] tool: ${event.title}${event.status ? ` (${event.status})` : ""}\x1b[0m\n`,
        );
      }
    } else if (event.type === "task_updated") {
      if (event.task.status === "running" || event.task.status === "completed" || event.task.status === "failed") {
        if (wroteStreamLine) {
          process.stdout.write("\n");
          wroteStreamLine = false;
        }
        process.stdout.write(
          `\x1b[36m[peer ${event.task.taskId}] ${event.task.callerAgent} -> ${event.task.targetAgent}: ${event.task.status}\x1b[0m\n`,
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
    rl.setPrompt(`[lead:${hub.getLeadAgent()} | ${hub.pool.getPermissionMode()}] > `);
    rl.prompt();
  };

  console.log(`Agent Hub started at ${hub.getUrl()} (cwd: ${hub.baseCwd})`);
  console.log(`Type a prompt, or /help for commands (/lead, /ui, /sessions, /approve, /quit).`);
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
            "  /lead <claude|codex|agy>     Switch the active lead agent",
            "  /ui | /pop                   Open interactive desktop app window",
            "  /browser                     Open interactive workbench in default browser",
            "  /sessions                    List active ACP sessions and worktrees",
            "  /worktrees                   List sessions isolated in git worktrees",
            "  /approve <all|reads|manual>  Set tool permission policy",
            "  /cancel <sessionKey>         Cancel a busy session (e.g. codex:peer-codex)",
            "  /quit                        Stop hub and exit",
          ].join("\n"),
        );
      } else if (cmd === "/lead") {
        if (!isValidAgent(arg)) {
          console.log(`Usage: /lead <claude|codex|agy> (current: ${hub.getLeadAgent()})`);
        } else {
          hub.setLeadAgent(arg);
          console.log(`Lead switched to ${arg}`);
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
              `- ${s.sessionKey} [${s.status}] cwd=${s.effectiveCwd}${s.branch ? ` branch=${s.branch}` : ""}`,
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
      const result = await hub.runLeadChat({ prompt: line });
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

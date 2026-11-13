import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TaskRecord } from "../types.js";

function parseArgs(argv: string[]): {
  hubUrl: string;
  callerAgent: string;
  callerSession: string;
  depth: number;
} {
  let hubUrl = "http://127.0.0.1:4317";
  let callerAgent = "user";
  let callerSession = "main";
  let depth = 0;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--hub-url" && next) {
      hubUrl = next;
      i++;
    } else if (flag === "--caller" && next) {
      callerAgent = next;
      i++;
    } else if (flag === "--caller-session" && next) {
      callerSession = next;
      i++;
    } else if (flag === "--depth" && next) {
      depth = Number(next) || 0;
      i++;
    }
  }

  return { hubUrl, callerAgent, callerSession, depth };
}

async function callHub<T>(
  hubUrl: string,
  endpoint: string,
  options?: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const res = await fetch(`${hubUrl}${endpoint}`, {
    method: options?.method ?? "GET",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `Hub HTTP ${res.status}`);
  }
  return data;
}

function formatTaskResult(task: TaskRecord): string {
  const parts: string[] = [
    `[Peer Agent Result]`,
    `task_id: ${task.taskId}`,
    `target: ${task.targetSessionKey} (${task.status})`,
  ];
  if (task.worktreePath) {
    parts.push(`worktree_path: ${task.worktreePath}`);
  }
  if (task.branch) {
    parts.push(`branch: ${task.branch}`);
  }
  if (task.error) {
    parts.push(`error: ${task.error}`);
  }
  parts.push("", "--- Output ---", task.outputText || "(empty output)");
  if (task.workspaceSummary) {
    parts.push("", "--- Workspace ---", task.workspaceSummary);
  }
  return parts.join("\n");
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const server = new McpServer({
    name: "agent-hub-peers",
    version: "0.1.0",
  });

  server.registerTool(
    "peer_list_agents",
    {
      description:
        "List available peer coding agents (claude, codex, agy), adapter health, and active sessions in the hub.",
      inputSchema: {},
    },
    async () => {
      const health = await callHub<{
        leadAgent: string;
        baseCwd: string;
        adapters: Array<{ agent: string; available: boolean; reason?: string }>;
        sessions: Array<{ sessionKey: string; status: string; effectiveCwd: string; branch?: string }>;
      }>(cfg.hubUrl, "/api/health");
      return {
        content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
      };
    },
  );

  server.registerTool(
    "peer_ask",
    {
      description:
        "Synchronously ask another local agent (claude, codex, or agy) to perform a sub-task, review code, or answer a question, and return its full response and workspace diff summary.",
      inputSchema: {
        agent: z.enum(["claude", "codex", "agy"]).describe("Target peer agent ID."),
        prompt: z.string().min(1).describe("Clear, self-contained instruction for the peer agent."),
        session: z.string().optional().describe("Optional named session to reuse context."),
        cwd: z.string().optional().describe("Optional working directory override."),
        isolate_worktree: z
          .boolean()
          .optional()
          .describe("Set true to isolate edits into a dedicated git worktree branch."),
      },
    },
    async ({ agent, prompt, session, cwd, isolate_worktree }) => {
      const res = await callHub<{ task: TaskRecord }>(cfg.hubUrl, "/api/peer/ask", {
        method: "POST",
        body: {
          targetAgent: agent,
          prompt,
          session,
          cwd,
          isolateWorktree: Boolean(isolate_worktree),
          callerAgent: cfg.callerAgent,
          callerSession: cfg.callerSession,
          depth: cfg.depth,
        },
      });
      return {
        content: [{ type: "text", text: formatTaskResult(res.task) }],
      };
    },
  );

  server.registerTool(
    "peer_dispatch",
    {
      description:
        "Asynchronously dispatch a long-running sub-task to another local agent (claude, codex, or agy) and immediately return task_id for parallel execution.",
      inputSchema: {
        agent: z.enum(["claude", "codex", "agy"]).describe("Target peer agent ID."),
        prompt: z.string().min(1).describe("Clear, self-contained instruction for the peer agent."),
        session: z.string().optional().describe("Optional named session to reuse context."),
        cwd: z.string().optional().describe("Optional working directory override."),
        isolate_worktree: z
          .boolean()
          .optional()
          .describe("Set true to isolate edits into a dedicated git worktree branch."),
      },
    },
    async ({ agent, prompt, session, cwd, isolate_worktree }) => {
      const res = await callHub<{ task: TaskRecord }>(cfg.hubUrl, "/api/peer/dispatch", {
        method: "POST",
        body: {
          targetAgent: agent,
          prompt,
          session,
          cwd,
          isolateWorktree: Boolean(isolate_worktree),
          callerAgent: cfg.callerAgent,
          callerSession: cfg.callerSession,
          depth: cfg.depth,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                task_id: res.task.taskId,
                session_key: res.task.targetSessionKey,
                status: res.task.status,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "peer_status",
    {
      description:
        "Check status and output of an asynchronous peer task (by task_id) or session (by session key), optionally waiting up to wait_seconds for completion.",
      inputSchema: {
        task_id: z.string().optional().describe("Task ID returned by peer_dispatch."),
        session: z.string().optional().describe("Session key like 'codex:peer-codex'."),
        wait_seconds: z
          .number()
          .min(0)
          .max(60)
          .optional()
          .describe("Optional long-poll wait in seconds (0-60)."),
      },
    },
    async ({ task_id, session, wait_seconds }) => {
      const params = new URLSearchParams();
      if (task_id) params.set("taskId", task_id);
      if (session) params.set("sessionKey", session);
      if (wait_seconds !== undefined) params.set("waitSeconds", String(wait_seconds));
      const res = await callHub<{ task?: TaskRecord; session?: unknown; tasks?: TaskRecord[] }>(
        cfg.hubUrl,
        `/api/peer/status?${params.toString()}`,
      );
      if (res.task) {
        return {
          content: [{ type: "text", text: formatTaskResult(res.task) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    },
  );

  server.registerTool(
    "peer_cancel",
    {
      description: "Cooperatively cancel an active turn on a peer agent session.",
      inputSchema: {
        session: z.string().min(1).describe("Target session key (e.g. 'codex:peer-codex')."),
      },
    },
    async ({ session }) => {
      const res = await callHub<{ cancelled: boolean }>(cfg.hubUrl, "/api/peer/cancel", {
        method: "POST",
        body: { sessionKey: session },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[peer-mcp-server] Fatal:", err);
  process.exit(1);
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TaskRecord } from "../types.js";

function parseArgs(argv: string[]): {
  hubUrl: string;
  callerAgent: string;
  callerSession: string;
  depth: number;
  groupId?: string;
} {
  let hubUrl = "http://127.0.0.1:4317";
  let callerAgent = "user";
  let callerSession = "main";
  let depth = 0;
  let groupId: string | undefined;

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
    } else if (flag === "--group-id" && next) {
      groupId = next;
      i++;
    }
  }

  return { hubUrl, callerAgent, callerSession, depth, groupId };
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
        "List available peer coding agents (including built-in claude, codex, agy, opencode, kimi and any custom ACP agents), adapter health, and active sessions in the hub.",
      inputSchema: {},
    },
    async () => {
      const health = await callHub<{
        leadAgent: string;
        baseCwd: string;
        adapters: Array<{ agent: string; label?: string; available: boolean; reason?: string }>;
        sessions: Array<{ sessionKey: string; status: string; effectiveCwd: string; branch?: string }>;
      }>(cfg.hubUrl, `/api/health${cfg.groupId ? `?groupId=${encodeURIComponent(cfg.groupId)}` : ""}`);
      return {
        content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
      };
    },
  );

  server.registerTool(
    "peer_ask",
    {
      description:
        "Synchronously ask another local agent (e.g. claude, codex, agy, opencode, kimi, or custom ACP agent; check peer_list_agents) to perform a sub-task, review code, or answer a question, and return its full response and workspace diff summary.",
      inputSchema: {
        agent: z.string().min(1).describe("Target peer agent ID."),
        prompt: z.string().min(1).describe("Clear, self-contained instruction for the peer agent."),
        session: z.string().optional().describe("Optional named session to reuse context."),
        cwd: z.string().optional().describe("Optional working directory override."),
        isolate_worktree: z
          .boolean()
          .optional()
          .describe("Set true to isolate edits into a dedicated git worktree branch."),
        model: z.string().optional().describe("Optional model ID override for the target peer agent."),
        effort: z
          .string()
          .optional()
          .describe("Optional thinking/reasoning effort level (e.g. low, medium, high, xhigh, max)."),
      },
    },
    async ({ agent, prompt, session, cwd, isolate_worktree, model, effort }) => {
      const res = await callHub<{ task: TaskRecord }>(cfg.hubUrl, "/api/peer/ask", {
        method: "POST",
        body: {
          targetAgent: agent,
          prompt,
          session,
          cwd,
          isolateWorktree: Boolean(isolate_worktree),
          model,
          effort,
          callerAgent: cfg.callerAgent,
          callerSession: cfg.callerSession,
          depth: cfg.depth,
          groupId: cfg.groupId,
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
        "Asynchronously dispatch a long-running sub-task to another local agent (e.g. claude, codex, agy, opencode, kimi, or custom ACP agent) and immediately return task_id for parallel execution.",
      inputSchema: {
        agent: z.string().min(1).describe("Target peer agent ID."),
        prompt: z.string().min(1).describe("Clear, self-contained instruction for the peer agent."),
        session: z.string().optional().describe("Optional named session to reuse context."),
        cwd: z.string().optional().describe("Optional working directory override."),
        isolate_worktree: z
          .boolean()
          .optional()
          .describe("Set true to isolate edits into a dedicated git worktree branch."),
        model: z.string().optional().describe("Optional model ID override for the target peer agent."),
        effort: z
          .string()
          .optional()
          .describe("Optional thinking/reasoning effort level (e.g. low, medium, high, xhigh, max)."),
      },
    },
    async ({ agent, prompt, session, cwd, isolate_worktree, model, effort }) => {
      const res = await callHub<{ task: TaskRecord }>(cfg.hubUrl, "/api/peer/dispatch", {
        method: "POST",
        body: {
          targetAgent: agent,
          prompt,
          session,
          cwd,
          isolateWorktree: Boolean(isolate_worktree),
          model,
          effort,
          callerAgent: cfg.callerAgent,
          callerSession: cfg.callerSession,
          depth: cfg.depth,
          groupId: cfg.groupId,
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

  server.registerTool(
    "resource_list_shared",
    {
      description:
        "List enabled shared project/global rules and skills discovered across configured hub agents.",
      inputSchema: {},
    },
    async () => {
      const res = await callHub<{
        resources: Array<{
          id: string;
          kind: string;
          scope: string;
          name: string;
          description: string;
          primaryPath: string;
          enabled: boolean;
        }>;
      }>(cfg.hubUrl, "/api/resources");
      const enabled = res.resources
        .filter((r) => r.enabled)
        .map(({ id, kind, scope, name, description, primaryPath }) => ({
          id,
          kind,
          scope,
          name,
          description,
          primaryPath,
        }));
      return {
        content: [{ type: "text", text: JSON.stringify(enabled, null, 2) }],
      };
    },
  );

  server.registerTool(
    "resource_read_skill",
    {
      description: "Read the full SKILL.md instructions for a shared skill by skill name.",
      inputSchema: {
        skill_name: z.string().min(1).describe("Name of the shared skill to read."),
      },
    },
    async ({ skill_name }) => {
      const params = new URLSearchParams({ skill: skill_name });
      const res = await callHub<{
        item: { name: string; scope: string; primaryPath: string };
        content: string;
      }>(cfg.hubUrl, `/api/resources/content?${params.toString()}`);
      return {
        content: [
          {
            type: "text",
            text: `# Skill: ${res.item.name} (${res.item.scope})\nPath: ${res.item.primaryPath}\n\n${res.content}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ui_render_artifact",
    {
      description:
        "Render an interactive HTML/SVG/Mermaid widget directly inside the Agent Hub Workbench chat stream inside a sandboxed iframe.",
      inputSchema: {
        title: z.string().min(1).describe("Short descriptive title for the interactive widget."),
        kind: z.enum(["html", "svg", "mermaid"]).optional().default("html").describe("Widget content type."),
        content: z.string().min(1).describe("Self-contained HTML snippet/document, SVG markup, or Mermaid definition."),
        height: z.number().int().min(140).max(900).optional().describe("Optional initial iframe height in pixels."),
        open_window: z.boolean().optional().describe("Optional: also pop open the widget in a standalone app window."),
      },
    },
    async ({ title, kind, content, height, open_window }) => {
      const res = await callHub<{
        artifact: { artifactId: string; title: string; kind: string };
        previewUrl: string;
        openedWindow: boolean;
      }>(cfg.hubUrl, "/api/artifacts", {
        method: "POST",
        body: {
          groupId: cfg.groupId,
          sessionKey: cfg.callerSession,
          agent: cfg.callerAgent,
          title,
          kind,
          content,
          height,
          openWindow: Boolean(open_window),
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Rendered interactive artifact ${res.artifact.artifactId} ("${res.artifact.title}", kind=${res.artifact.kind}). Preview URL: ${res.previewUrl}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "hub_ask_user",
    {
      description:
        "Show an interactive structured questionnaire card in the Agent Hub Workbench UI and wait for the user's choices or text input.",
      inputSchema: {
        title: z.string().optional().describe("Optional card header title."),
        questions: z
          .array(
            z.object({
              id: z.string().optional().describe("Stable key returned in the answers object."),
              question: z.string().min(1).describe("Prompt shown to the user."),
              type: z.enum(["single", "multi", "text"]).optional().default("single"),
              options: z.array(z.string()).optional().describe("Choices for single/multi questions."),
              placeholder: z.string().optional().describe("Placeholder for free-text questions."),
            }),
          )
          .min(1),
        timeout_seconds: z.number().min(5).max(600).optional().describe("Max wait time before auto-cancelling."),
      },
    },
    async ({ title, questions, timeout_seconds }) => {
      const res = await callHub<{
        questionId: string;
        cancelled: boolean;
        answers: Record<string, unknown>;
      }>(cfg.hubUrl, "/api/questions/ask", {
        method: "POST",
        body: {
          groupId: cfg.groupId,
          sessionKey: cfg.callerSession,
          agent: cfg.callerAgent,
          title,
          questions,
          timeoutSeconds: timeout_seconds,
        },
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

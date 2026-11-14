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
    "peer_answer_question",
    {
      description:
        "Answer a question a sub-session of this task is blocked on (you were told its question id in a workbench update). Lead only. Use it when the task's goal, earlier decisions or shared context already settle the question; leave questions only the user can decide for the user.",
      inputSchema: {
        question_id: z.string().min(1),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .describe("Field id -> answer, using the field ids from the update (e.g. {\"q1\": \"Use PostgreSQL\"})."),
      },
    },
    async ({ question_id, answers }) => {
      if (cfg.depth > 0) {
        return { content: [{ type: "text", text: "Only the lead of the task can answer for the user." }], isError: true };
      }
      await callHub(cfg.hubUrl, "/api/questions/resolve", { method: "POST", body: { questionId: question_id, answers } });
      return { content: [{ type: "text", text: `Answered ${question_id}; the sub-session carries on.` }] };
    },
  );

  server.registerTool(
    "workflow_continue",
    {
      description:
        "Decide how a workflow goes on after a step failed (you are told in a workbench update). Lead only. Failed steps are tried again, with your `guidance` if you give any, and the steps that were held back then run. A step listed in `skip` is dropped so the steps after it go on without its result. To change the plan itself use workflow_propose instead.",
      inputSchema: {
        guidance: z
          .array(z.object({ step_id: z.string().min(1), text: z.string().min(1).describe("What to do differently this time.") }))
          .optional(),
        skip: z.array(z.object({ step_id: z.string().min(1), reason: z.string().optional() })).optional(),
      },
    },
    async ({ guidance, skip }) => {
      const res = await callHub<{ workflow: { status: string; steps: Array<{ id: string; status: string }> } }>(
        cfg.hubUrl,
        "/api/workflows/continue",
        {
          method: "POST",
          body: {
            groupId: cfg.groupId,
            depth: cfg.depth,
            guidance: guidance?.map((g) => ({ stepId: g.step_id, text: g.text })),
            skip: skip?.map((s) => ({ stepId: s.step_id, reason: s.reason })),
          },
        },
      );
      return {
        content: [
          {
            type: "text",
            text: `Workflow is ${res.workflow.status}: ${res.workflow.steps.map((s) => `${s.id}=${s.status}`).join(", ")}. You will get another workbench update when it ends.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "lead_handoff",
    {
      description:
        "Hand the lead role of this task over to another agent. Lead only, and only when the user asks for it (e.g. \"switch to codex\", \"let claude take over\"). The switch happens when your current turn ends: the new lead starts in a fresh session and sees nothing of this conversation except your `brief`, then reports to the user. After calling this, tell the user in one sentence that the handoff is done and stop; do not continue the work.",
      inputSchema: {
        to: z.string().min(1).describe("Id of the agent that takes over (see peer_list_agents for the enabled agents)."),
        brief: z
          .string()
          .min(1)
          .describe(
            "Everything your successor needs, written for someone who has seen nothing: the user's goal, what is done, decisions and their reasons, what is in progress or blocked, the next steps, key files and paths, and the user's preferences and constraints stated so far.",
          ),
      },
    },
    async ({ to, brief }) => {
      const res = await callHub<{ to: string; toLabel: string }>(cfg.hubUrl, "/api/lead/handoff", {
        method: "POST",
        body: { groupId: cfg.groupId, from: cfg.callerAgent, to, brief, depth: cfg.depth },
      });
      return {
        content: [
          {
            type: "text",
            text: `Handoff registered. ${res.toLabel} (${res.to}) takes over with your brief as soon as this turn ends. Tell the user so in one sentence and end your turn now.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "task_report",
    {
      description:
        `Report the outcome of a task that was published on the task board. Lead only. Call it once, when the work is finished ("delivered", with every deliverable; files as paths relative to the working directory, they are checked to exist) or cannot be done ("failed", with the reason). The board frees this task's slot when you report, and the user then confirms or sends the delivery back. After calling it, tell the user in a few lines what was delivered and end your turn.`,
      inputSchema: {
        outcome: z.enum(["delivered", "failed"]),
        summary: z.string().min(1),
        deliverables: z
          .array(
            z.object({
              kind: z.enum(["file", "text", "link"]),
              path: z.string().optional(),
              note: z.string().optional(),
            }),
          )
          .max(50)
          .optional(),
        reason: z.string().optional(),
      },
    },
    async ({ outcome, summary, deliverables, reason }) => {
      await callHub(cfg.hubUrl, "/api/board/report", {
        method: "POST",
        body: { groupId: cfg.groupId, depth: cfg.depth, outcome, summary, deliverables, reason },
      });
      return {
        content: [
          {
            type: "text",
            text: `Report registered (${outcome}). The task slot has been freed. Tell the user in a few lines what was delivered and end your turn now.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "progress_update",
    {
      description:
        "Update the task's Progress panel in the workbench: the goal, the steps with their status, and a short summary of where things stand. The user reads this panel instead of asking for status, so call it as soon as a task turns out to be multi-step, and again whenever the goal changes or a step starts, finishes or gets blocked. Omitted fields keep their previous value; `items`, when given, replaces the whole list.",
      inputSchema: {
        goal: z.string().optional().describe("What the task is trying to achieve, in one or two sentences."),
        summary: z.string().optional().describe("Where things stand right now, in one or two sentences."),
        items: z
          .array(
            z.object({
              title: z.string().min(1).describe("The step or milestone."),
              status: z.enum(["pending", "in_progress", "completed", "blocked"]),
              note: z.string().optional().describe("What is left, why it is blocked, or where the result is."),
            }),
          )
          .max(40)
          .optional()
          .describe("The full, current list of steps."),
      },
    },
    async ({ goal, summary, items }) => {
      const res = await callHub<{ progress: { items: Array<{ status: string }> } }>(cfg.hubUrl, "/api/progress", {
        method: "POST",
        body: { groupId: cfg.groupId, goal, summary, items, updatedBy: cfg.callerAgent },
      });
      const done = res.progress.items.filter((i) => i.status === "completed").length;
      return {
        content: [{ type: "text", text: `Progress panel updated (${done}/${res.progress.items.length} steps completed).` }],
      };
    },
  );

  server.registerTool(
    "workflow_propose",
    {
      description:
        "Draft a multi-step workflow of sub-sessions for the current task. Nothing runs yet: the draft appears in the workbench's Workflow panel, where the user reviews, edits and publishes it. Use this instead of several peer_dispatch calls when the work splits into steps with dependencies.\n\nWrite background ONCE, not per step. Every step's sub-session automatically receives `shared_context`, the sections the step lists in `context`, and the results of the steps it depends on. So: put what all steps must know (goal, target version, conventions, constraints, where the materials are) in `shared_context`; put material only some steps need in `sections` and reference it by key; keep each step's `prompt` to what is specific to that step. Do not repeat shared_context or section text inside prompts.",
      inputSchema: {
        shared_context: z
          .string()
          .optional()
          .describe("Background every step needs, written once. Keep it tight: it is sent with every step."),
        sections: z
          .array(
            z.object({
              key: z.string().describe("Short name: lowercase letters, digits, '-', '_', '.'"),
              summary: z.string().optional().describe("One line saying what the section holds."),
              content: z.string().min(1),
            }),
          )
          .max(40)
          .optional()
          .describe("Material that only some steps need. Steps reference these by key in `context`."),
        steps: z
          .array(
            z.object({
              id: z.string().describe("Short unique id: lowercase letters, digits, '-' or '_'."),
              name: z.string().optional().describe("Human-readable step name."),
              agent: z.string().min(1).describe("Agent ID that runs this step (see peer_list_agents)."),
              prompt: z
                .string()
                .min(1)
                .describe("What this step must do and deliver. Only what is specific to the step."),
              depends_on: z.array(z.string()).optional().describe("Ids of steps that must finish first."),
              context: z.array(z.string()).optional().describe("Keys of the sections this step needs."),
              isolate_worktree: z.boolean().optional().describe("Run the step in its own git worktree."),
              review: z
                .object({
                  agent: z.string().min(1).describe("Agent ID that reviews the step's work; pick a different agent than the one doing it."),
                  criteria: z.string().optional().describe("What the work must satisfy to be accepted."),
                  max_rounds: z.number().int().min(1).max(5).optional().describe("Reviews before the step fails (default 2)."),
                })
                .optional()
                .describe(
                  "Acceptance gate. When the step's agent is done the reviewer checks the work; a rejection goes back to the same agent with the findings. Use this instead of separate 'implement' and 'accept' steps.",
                ),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    async ({ shared_context, sections, steps }) => {
      const res = await callHub<{ workflow: { steps: Array<{ id: string }> } }>(
        cfg.hubUrl,
        "/api/workflows/save",
        {
          method: "POST",
          body: {
            groupId: cfg.groupId,
            proposedBy: cfg.callerAgent,
            sharedContext: shared_context,
            sections,
            steps: steps.map((s) => ({
              id: s.id,
              name: s.name,
              agent: s.agent,
              prompt: s.prompt,
              dependsOn: s.depends_on,
              contextRefs: s.context,
              isolateWorktree: s.isolate_worktree,
              review: s.review
                ? { agent: s.review.agent, criteria: s.review.criteria, maxRounds: s.review.max_rounds }
                : undefined,
            })),
          },
        },
      );
      return {
        content: [
          {
            type: "text",
            text: `Workflow draft saved with ${res.workflow.steps.length} step(s): ${res.workflow.steps.map((s) => s.id).join(", ")}. It has NOT started. A preview card linking to the Workflow panel now appears under your reply, so do not list every step again: say in a sentence or two what the plan is and ask the user to review and publish it.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "context_get",
    {
      description:
        "Read the task's shared context. Without `section` it returns the index (section keys and one-line summaries). With `section` it returns that section's full text: \"common\", a named section, or \"result:<stepId>\" for a finished workflow step. Read only what you need.",
      inputSchema: {
        section: z.string().optional().describe("Section key. Omit to list what exists."),
      },
    },
    async ({ section }) => {
      const group = cfg.groupId ? `groupId=${encodeURIComponent(cfg.groupId)}` : "";
      if (!section) {
        const res = await callHub<{ context: { sections: Array<{ key: string; summary?: string; content: string }> } }>(
          cfg.hubUrl,
          `/api/context?${group}`,
        );
        const lines = res.context.sections.map(
          (s) => `- ${s.key}${s.summary ? `: ${s.summary}` : ""} (${s.content.length} chars)`,
        );
        return {
          content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "This task has no shared context yet." }],
        };
      }
      const res = await callHub<{ section: { key: string; content: string } }>(
        cfg.hubUrl,
        `/api/context?${group}&key=${encodeURIComponent(section)}`,
      );
      return { content: [{ type: "text", text: res.section.content }] };
    },
  );

  server.registerTool(
    "context_put",
    {
      description:
        "Lead session only. Create or replace one section of the task's shared context, so sub-sessions get it without it being repeated in their prompts. Use \"common\" for what every step needs; any other key for material only some steps need. Empty content deletes the section. Sub-sessions already running do not see later changes unless they call context_get.",
      inputSchema: {
        section: z.string().min(1).describe("\"common\" or a short section name."),
        content: z.string().describe("The section's full text. Empty to delete."),
        summary: z.string().optional().describe("One line saying what the section holds."),
      },
    },
    async ({ section, content, summary }) => {
      const res = await callHub<{ context: { sections: Array<{ key: string }> } }>(cfg.hubUrl, "/api/context", {
        method: "POST",
        body: { groupId: cfg.groupId, key: section, content, summary, updatedBy: cfg.callerAgent, depth: cfg.depth },
      });
      return {
        content: [{ type: "text", text: `Shared context now has: ${res.context.sections.map((s) => s.key).join(", ") || "(nothing)"}.` }],
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
      const qs = cfg.groupId ? `?groupId=${encodeURIComponent(cfg.groupId)}` : "";
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
      }>(cfg.hubUrl, `/api/resources${qs}`);
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
      if (cfg.groupId) {
        params.set("groupId", cfg.groupId);
      }
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
        "Render an interactive HTML/SVG/Mermaid widget directly inside the RTM workbench chat stream inside a sandboxed iframe.",
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
        "Show an interactive structured questionnaire card in the RTM workbench UI and wait for the user's choices or text input.",
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

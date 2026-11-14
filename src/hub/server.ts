import { getLocale, negotiateLocale, t, withLocale } from "./i18n.js";
import { DEFAULT_LOCALE, matchLocale, messageSender, messageText, taskTitle, translate } from "../ui/locale.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  type AgentId,
  type ArtifactKind,
  type ArtifactRecord,
  type BoardCard,
  type BoardDeliverable,
  type BoardWaitingReason,
  type ChatImageAttachment,
  type ChatMessagePart,
  type ChatMessageRecord,
  type HubEvent,
  type PendingUserQuestion,
  type PermissionMode,
  type QuestionField,
  type SessionRecord,
  type SessionUsageTotals,
  type TaskBoardInfo,
  type TaskGroup,
  type TaskRecord,
  type WorkflowRecord,
  type TelemetrySnapshot,
  type TurnTelemetryRecord,
  type TurnUsage,
  type HubSettings,
  type ChatFileAttachment,
  type TaskProgress,
  type ProjectInfo,
} from "../types.js";
import type { PersistedHubState } from "./state-store.js";
import { openInteractiveWindow } from "../ui/launcher.js";
import { AcpPool, buildSessionKey, type WarmSessionOptions } from "./acp-pool.js";
import { AgentRegistry } from "./agent-registry.js";
import { ThreadLedger } from "./ledger.js";
import { MemoryMonitor, type MemoryStatus } from "./memory.js";
import { WorkflowTemplateStore } from "./workflow-templates.js";
import { McpServerManager } from "./mcp-servers.js";
import { checkPortAvailable, findAvailablePort, pickNativeDirectory } from "./port-finder.js";
import { openTerminalWindow, PROJECT_ROOT, resolveAgentLoginCommand } from "./process-tree.js";
import { WorkflowManager } from "./workflow.js";
import { TaskContextStore } from "./task-context.js";
import { HubStateStore } from "./state-store.js";
import {
  type BoardAction,
  DEFAULT_BOARD_PARALLEL,
  applyBoardAction,
  clampBoardParallel,
  clampIdleLeadMinutes,
  missingDeliverables,
  pickToStart,
} from "./task-board.js";
import { SharedResourceManager, estimateTokens } from "./resources.js";
import {
  inspectWorktreeChanges,
  mergeSessionWorktree,
  removeSessionWorktree,
  summarizeWorkspaceChanges,
} from "./worktree.js";
import { installDataDir } from "./data-dir.js";

const MAX_PEER_DEPTH = 3;
const RUNTIME_FILE = path.join(installDataDir(PROJECT_ROOT), "runtime.json");
const UPLOADS_DIR = path.join(installDataDir(PROJECT_ROOT), "uploads");
const SETTINGS_FILE = path.join(installDataDir(PROJECT_ROOT), "settings.json");
const STATE_FILE = path.join(installDataDir(PROJECT_ROOT), "state.json");
const WORKFLOW_TEMPLATES_FILE = path.join(installDataDir(PROJECT_ROOT), "workflow-templates.json");
const MCP_SERVERS_FILE = path.join(installDataDir(PROJECT_ROOT), "mcp-servers.json");
/** Events that never change what is persisted; everything else schedules a save. */
const TRANSIENT_EVENT_TYPES = new Set(["agent_chunk", "tool_event", "snapshot", "models_updated", "board_updated"]);
/** Session-name suffix of the throwaway session that names a task; never shown in the UI. */
const TITLE_SESSION_SUFFIX = "__title";

const DEFAULT_WORKFLOW_PARALLEL = 3;
const DEFAULT_IDLE_SUB_MINUTES = 15;
/** Under memory pressure an idle sub-session is released after this long, whatever the setting. */
const PRESSURE_IDLE_MS = 60_000;
/** Under memory pressure an idle lead session is released after this long, whatever the setting. */
const PRESSURE_IDLE_LEAD_MS = 10 * 60_000;
const SUB_RECAP_MAX_CHARS = 8000;
const SUB_RECAP_MESSAGE_CHARS = 2000;

function clampIdleSubMinutes(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_SUB_MINUTES;
  return Math.min(n, 240);
}

function clampWorkflowParallel(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : DEFAULT_WORKFLOW_PARALLEL;
}

function loadHubSettings(): HubSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<HubSettings>;
    return {
      autoTitle: parsed.autoTitle === true,
      workflowParallel: clampWorkflowParallel(parsed.workflowParallel),
      idleSubSessionMinutes: clampIdleSubMinutes(parsed.idleSubSessionMinutes),
      boardParallel: clampBoardParallel(parsed.boardParallel),
      idleLeadMinutes: clampIdleLeadMinutes(parsed.idleLeadMinutes),
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter((p) => p && typeof p.path === "string").slice(0, 20)
        : [],
    };
  } catch {
    return {
      autoTitle: false,
      workflowParallel: DEFAULT_WORKFLOW_PARALLEL,
      idleSubSessionMinutes: DEFAULT_IDLE_SUB_MINUTES,
      boardParallel: DEFAULT_BOARD_PARALLEL,
      idleLeadMinutes: 0,
    };
  }
}

/** Keeps the model's answer usable as a sidebar title: one line, no quotes, bounded length. */
function cleanGeneratedTitle(raw: string): string {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  const cleaned = line
    .replace(/^(标题|title)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「」《》#*\s]+|["'“”‘’「」《》*。.\s]+$/g, "");
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned;
}
const MAX_SINGLE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 40 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;
const ALLOWED_IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const AgentIdSchema = z.string().trim().min(1);
const PermissionModeSchema = z.enum(["approve-all", "approve-reads", "manual"]);

const ChatImageInputSchema = z.object({
  name: z.string().max(200).optional(),
  mimeType: z
    .string()
    .transform((m) => m.trim().toLowerCase())
    .refine((m) => m in ALLOWED_IMAGE_MIMES, {
      message: t("unsupportedImageFormat"),
    }),
  data: z.string().min(1),
});

const LeadBodySchema = z.object({
  agent: AgentIdSchema,
  groupId: z.string().optional(),
});

const WarmSessionBodySchema = z.object({
  groupId: z.string().min(1),
});

const ChatFileInputSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().optional(),
  data: z.string().min(1),
});

const ChatBodySchema = z
  .object({
    groupId: z.string().optional(),
    prompt: z.string().optional().default(""),
    images: z.array(ChatImageInputSchema).max(6).optional(),
    files: z.array(ChatFileInputSchema).max(MAX_FILES_PER_MESSAGE).optional(),
    steer: z.boolean().optional(),
    reuseMessageId: z.string().optional(),
    replaceAssistantMessageId: z.string().optional(),
    leadAgent: AgentIdSchema.optional(),
    cwd: z.string().optional(),
    session: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .refine(
    (v) =>
      v.prompt.trim().length > 0 ||
      (v.images?.length ?? 0) > 0 ||
      (v.files?.length ?? 0) > 0 ||
      Boolean(v.reuseMessageId?.trim()),
    {
      message: t("messageRequired"),
    },
  );

const CreateGroupBodySchema = z.object({
  title: z.string().optional(),
  leadAgent: AgentIdSchema.optional(),
  leadModel: z.string().optional(),
  leadEffort: z.string().optional(),
  cwd: z.string().optional(),
  extraDirs: z.array(z.string()).max(8).optional(),
});

const UpdateGroupBodySchema = z.object({
  groupId: z.string().min(1),
  title: z.string().optional(),
  leadAgent: AgentIdSchema.optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
  extraDirs: z.array(z.string()).max(8).optional(),
});

const GroupModelBodySchema = z.object({
  groupId: z.string().optional(),
  agent: AgentIdSchema.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const DeleteGroupBodySchema = z.object({
  groupId: z.string().min(1),
});

const PublishBoardBodySchema = z.object({
  items: z
    .array(
      z.object({
        brief: z.string(),
        title: z.string().optional(),
        leadAgent: AgentIdSchema.optional(),
        leadModel: z.string().optional(),
        leadEffort: z.string().optional(),
        cwd: z.string().optional(),
        extraDirs: z.array(z.string()).max(8).optional(),
      }),
    )
    .min(1)
    .max(50),
  common: z.string().optional(),
});

const ReportBoardBodySchema = z.object({
  groupId: z.string().min(1),
  depth: z.number().int().min(0).optional(),
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
});

const BoardActionBodySchema = z.object({
  groupId: z.string().min(1),
  action: z.enum(["confirm", "reject", "cancel", "retry", "resume"]),
  note: z.string().optional(),
});

const SessionChatBodySchema = z
  .object({
    sessionKey: z.string().min(1),
    prompt: z.string().optional().default(""),
    images: z.array(ChatImageInputSchema).max(6).optional(),
    files: z.array(ChatFileInputSchema).max(MAX_FILES_PER_MESSAGE).optional(),
    steer: z.boolean().optional(),
    reuseMessageId: z.string().optional(),
    replaceAssistantMessageId: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .refine(
    (v) =>
      v.prompt.trim().length > 0 ||
      (v.images?.length ?? 0) > 0 ||
      (v.files?.length ?? 0) > 0 ||
      Boolean(v.reuseMessageId?.trim()),
    {
      message: t("messageRequired"),
    },
  );

const SessionModelBodySchema = z.object({
  sessionKey: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const PeerCallBodySchema = z.object({
  targetAgent: AgentIdSchema,
  prompt: z.string().min(1),
  groupId: z.string().optional(),
  session: z.string().optional(),
  cwd: z.string().optional(),
  isolateWorktree: z.boolean().optional().default(false),
  model: z.string().optional(),
  effort: z.string().optional(),
  callerAgent: z.union([AgentIdSchema, z.literal("user")]).optional().default("user"),
  callerSession: z.string().optional().default("main"),
  depth: z.number().int().min(0).optional().default(0),
});

const ContextSectionSchema = z.object({
  key: z.string().min(1),
  summary: z.string().optional(),
  content: z.string(),
});

const ContextPutSchema = z.object({
  groupId: z.string().optional(),
  key: z.string().min(1),
  summary: z.string().optional(),
  content: z.string(),
  updatedBy: z.string().optional(),
  depth: z.number().int().min(0).optional(),
});

const ContextReplaceSchema = z.object({
  groupId: z.string().optional(),
  common: z.string().optional(),
  sections: z.array(ContextSectionSchema).max(40).optional(),
  updatedBy: z.string().optional(),
});

const WorkflowSaveSchema = z.object({
  groupId: z.string().optional(),
  proposedBy: z.string().optional(),
  /** Background shared by every step; replaces the task's common section when given. */
  sharedContext: z.string().optional(),
  /** Named context sections; replaces the task's hand-written sections when given. */
  sections: z.array(ContextSectionSchema).max(40).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        agent: z.string().min(1),
        prompt: z.string().optional().default(""),
        dependsOn: z.array(z.string()).optional(),
        isolateWorktree: z.boolean().optional(),
        contextRefs: z.array(z.string()).optional(),
        review: z
          .object({ agent: z.string().optional(), criteria: z.string().optional(), maxRounds: z.number().optional() })
          .nullish(),
      }),
    )
    .max(20),
});

const WorkflowGroupSchema = z.object({ groupId: z.string().min(1) });

const LeadHandoffSchema = z.object({
  groupId: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  brief: z.string().min(1),
  depth: z.number().optional(),
});

const ProgressUpdateSchema = z.object({
  groupId: z.string().optional(),
  goal: z.string().optional(),
  summary: z.string().optional(),
  items: z
    .array(
      z.object({
        title: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional().default("pending"),
        note: z.string().optional(),
      }),
    )
    .max(40)
    .optional(),
  updatedBy: z.string().optional(),
});

const CancelBodySchema = z.object({
  sessionKey: z.string().min(1),
  /** The turn is interrupted to redirect it, not to stop the work; a message follows. */
  steer: z.boolean().optional(),
});

const PermissionResolveSchema = z.object({
  requestId: z.string().min(1),
  optionId: z.string().min(1),
});

const PermissionModeBodySchema = z.object({
  mode: PermissionModeSchema,
});

const ResourceToggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  /** Only for this agent; omitted = for every agent. */
  agent: z.string().optional(),
  cwd: z.string().optional(),
  groupId: z.string().optional(),
});

const ResourceSaveRuleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "global"]),
  content: z.string().min(1),
  cwd: z.string().optional(),
  groupId: z.string().optional(),
});

const ResourceDeleteRuleSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().optional(),
  groupId: z.string().optional(),
});

const ResourceSyncSchema = z.object({
  cwd: z.string().optional(),
  groupId: z.string().optional(),
});

const WorktreeMergeBodySchema = z.object({
  sessionKey: z.string().min(1),
  cleanup: z.boolean().optional().default(true),
});

const WorktreeDiscardBodySchema = z.object({
  sessionKey: z.string().min(1),
});

const ArtifactCreateSchema = z.object({
  groupId: z.string().optional(),
  sessionKey: z.string().optional(),
  agent: AgentIdSchema.optional(),
  title: z.string().min(1),
  kind: z.enum(["html", "svg", "mermaid"]).optional().default("html"),
  content: z.string().min(1),
  height: z.number().int().min(140).max(900).optional(),
  openWindow: z.boolean().optional(),
});

const QuestionAskSchema = z.object({
  groupId: z.string().optional(),
  sessionKey: z.string().optional(),
  agent: AgentIdSchema.optional(),
  title: z.string().optional(),
  questions: z
    .array(
      z.object({
        id: z.string().optional(),
        question: z.string().min(1),
        type: z.enum(["single", "multi", "text"]).optional().default("single"),
        options: z.array(z.string()).optional(),
        placeholder: z.string().optional(),
      }),
    )
    .min(1),
  timeoutSeconds: z.number().min(5).max(600).optional(),
});

const QuestionResolveSchema = z.object({
  questionId: z.string().min(1),
  answers: z.record(z.string(), z.unknown()).optional().default({}),
  cancelled: z.boolean().optional().default(false),
});

const AgentSaveSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  color: z.string().optional(),
  darkColor: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  models: z.array(z.string()).optional(),
});

const AgentToggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

const AgentIdOnlySchema = z.object({
  id: z.string().min(1),
});

const DefaultLeadSchema = z.object({
  id: z.string().min(1).nullable().optional(),
});

const WorkspaceCwdSchema = z.object({
  cwd: z.string().min(1),
  groupId: z.string().optional(),
});

const WorkspacePickSchema = z.object({
  initialDir: z.string().optional(),
});

/** Raster app icons shipped next to the UI files; anything else under /ui/icon* is a 404. */
const UI_ICON_FILES: Record<string, string> = {
  "icon-32.png": "image/png",
  "icon-64.png": "image/png",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "icon-alert.png": "image/png",
  "icon.ico": "image/x-icon",
};

/**
 * Markup that renders a Mermaid diagram with the library served by the hub itself (no CDN).
 * If the source does not parse, the error and the source are shown instead of a blank card.
 */
function buildMermaidMarkup(source: string, preferDark?: boolean): string {
  const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const darkExpr =
    preferDark === true
      ? "true"
      : preferDark === false
        ? "false"
        : "window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches";
  return `<div id="mmd-out" class="mmd-out"></div>
    <pre id="mmd-src" class="mermaid-src" hidden>${escaped}</pre>
    <script src="/ui/vendor/mermaid.min.js"></script>
    <script>
    (async function () {
      var src = document.getElementById("mmd-src");
      var out = document.getElementById("mmd-out");
      try {
        var dark = ${darkExpr};
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
        var result = await mermaid.render("mmd-svg", src.textContent);
        out.innerHTML = result.svg;
      } catch (err) {
        var errorBox = document.createElement("div");
        errorBox.className = "mmd-error";
        errorBox.textContent = ${JSON.stringify(t("mermaidRenderError"))} + String(err && err.message ? err.message : err);
        out.replaceChildren(errorBox);
        src.hidden = false;
      }
    })();
    </script>`;
}

interface ArtifactThemeOptions {
  theme?: string;
  skin?: string;
}

function buildArtifactThemeCss(opts?: ArtifactThemeOptions): { cssVars: string; colorScheme: string; dark: boolean } {
  const dark = opts?.theme === "dark";
  const skin = opts?.skin || "classic";
  if (skin === "roundtable") {
    if (dark) {
      return {
        dark: true,
        colorScheme: "dark",
        cssVars: `--bg: #171512; --card: #211e1a; --ink: #ede6d6; --muted: #a69c8a; --line: #3b352c; --accent: #c9a45c;`,
      };
    }
    return {
      dark: false,
      colorScheme: "light",
      cssVars: `--bg: #f3f1ea; --card: #fbfaf5; --ink: #221f19; --muted: #676053; --line: #cfc8b8; --accent: #1d6b47;`,
    };
  }
  if (dark) {
    return {
      dark: true,
      colorScheme: "dark",
      cssVars: `--bg: #14171a; --card: #1d2226; --ink: #e8edf2; --muted: #98a3af; --line: #2f373f; --accent: #3cb882;`,
    };
  }
  return {
    dark: false,
    colorScheme: "light",
    cssVars: `--bg: #f3f2ec; --card: #faf9f5; --ink: #151514; --muted: #56564f; --line: #c4c2b6; --accent: #0d7148;`,
  };
}

function buildArtifactHtmlDocument(artifact: ArtifactRecord, opts?: ArtifactThemeOptions): string {
  const safeTitle = artifact.title.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );
  const themeStyle = buildArtifactThemeCss(opts);
  let bodyMarkup = artifact.content;
  const trimmed = artifact.content.trim();
  if (artifact.kind === "svg" && !/<svg[\s>]/i.test(trimmed)) {
    bodyMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">${artifact.content}</svg>`;
  } else if (artifact.kind === "mermaid") {
    bodyMarkup = buildMermaidMarkup(trimmed, opts?.theme ? themeStyle.dark : undefined);
  }

  // If the HTML already defines a full <html> document, inject theme variables & height reporter cleanly
  const themeInjectTag = `<style id="__rtm_theme_vars">
    :root {
      color-scheme: ${themeStyle.colorScheme};
      ${themeStyle.cssVars}
      --background: var(--bg);
      --foreground: var(--ink);
      --border: var(--line);
    }
  </style>`;
  const resizeScript = `<script>
  (function(){
    function report(){
      var h = Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __hubArtifactId: ${JSON.stringify(artifact.artifactId)}, height: h }, "*");
      }
    }
    window.addEventListener("load", report);
    if (typeof ResizeObserver !== "undefined") {
      try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
    }
    setTimeout(report, 120);
  })();
  </script>`;

  if (/<html[\s>]/i.test(trimmed)) {
    let doc = trimmed;
    if (doc.includes("</head>")) {
      doc = doc.replace("</head>", `${themeInjectTag}\n</head>`);
    }
    return doc.includes("</body>")
      ? doc.replace("</body>", `${resizeScript}\n</body>`)
      : `${doc}\n${resizeScript}`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: ${themeStyle.colorScheme};
      ${themeStyle.cssVars}
      --background: var(--bg);
      --foreground: var(--ink);
      --border: var(--line);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--ink);
      font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.55;
    }
    .mmd-out { overflow: auto; text-align: center; }
    .mmd-out svg { max-width: 100%; height: auto; }
    .mmd-error { color: #b42318; font-size: 13px; margin-bottom: 8px; text-align: left; }
    pre.mermaid-src, pre.mermaid {
      padding: 12px;
      background: var(--card);
      border: 1px solid var(--line);
      font-family: "JetBrains Mono", Consolas, monospace;
      overflow-x: auto;
    }
  </style>
</head>
<body>
${bodyMarkup}
${resizeScript}
</body>
</html>`;
}

function createEmptyTotals(): SessionUsageTotals {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export interface HubServerOptions {
  baseCwd: string;
  port?: number;
  defaultLead?: AgentId;
  permissionMode?: PermissionMode;
  writeRuntimeFile?: boolean;
  /**
   * Keep tasks, messages, workflows and telemetry across restarts. Defaults to
   * writeRuntimeFile, so throwaway hubs (tests, benchmarks) never touch the saved state.
   */
  persistState?: boolean;
  /** Where the state is kept; setting it turns persistence on. Defaults to .rtm/state.json. */
  stateFile?: string;
  strictPort?: boolean;
  desktopMode?: boolean;
  autoExitOnWindowClose?: boolean;
  autoExitGraceMs?: number;
  onAutoExit?: () => void;
}

export interface RuntimeFileInfo {
  url: string;
  port: number;
  pid: number;
  baseCwd: string;
  startedAt: number;
}

export function readRuntimeFile(): RuntimeFileInfo | undefined {
  if (!fs.existsSync(RUNTIME_FILE)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8")) as RuntimeFileInfo;
  } catch {
    return undefined;
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request payload too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function autoTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  if (!firstLine) {
    return t("newTaskFallback");
  }
  return firstLine.length > 26 ? `${firstLine.slice(0, 26)}…` : firstLine;
}

/**
 * Put in front of a message the user sent to redirect a turn they interrupted. The transcript
 * shows the user's words only; the agent also needs to know why its turn was cut short.
 */
interface LeadNotice {
  /** One line for the transcript. */
  summary: string;
  /** What the lead is told. */
  detail: string;
  taskId?: string;
  questionId?: string;
  boardNudge?: boolean;
}

/** How long an interrupted task waits for the guidance that should follow the interruption. */
const STEER_FOLLOW_UP_MS = 90_000;

/** Hub-started lead turns in a row before it waits for the user. */
const MAX_AUTO_LEAD_TURNS = 8;

function clipMiddle(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.floor(max * 0.6))}\n[... ${clean.length - max} characters omitted ...]\n${clean.slice(-Math.floor(max * 0.4))}`;
}

function buildHandoffPrompt(fromLabel: string, brief: string): string {
  return [
    "<lead_handoff>",
    `You are now the Lead Agent of this task. The user asked the previous lead (${fromLabel}) to hand the task over to you, and it wrote this brief for you:`,
    "",
    brief,
    "</lead_handoff>",
    "",
    "You have not seen the earlier conversation; the brief and the task's shared context (`context_get`) are what you have. Reply to the user now, briefly: what you understand you are taking over, and what you will do next. Do not start large pieces of work in this reply unless the brief says the user is waiting for them. If something essential is missing from the brief, ask the user.",
  ].join("\n");
}

const STEER_PREFIX =
  "[The user interrupted your previous turn on purpose to steer you. Take the guidance below into account, then continue the task you were working on; do not start over unless the guidance says so.]\n\n";

/** Tells the agent where the attached files were saved; empty when there are none. */
function buildAttachedFilesBlock(files: ChatFileAttachment[]): string {
  if (files.length === 0) {
    return "";
  }
  const lines = files.map((f) => `- ${f.localPath} (${f.name}, ${f.sizeBytes} bytes)`);
  return `\n\n<attached_files>\nThe user attached ${files.length} local file(s). Read them from these paths:\n${lines.join("\n")}\n</attached_files>`;
}

function cloneMessage(msg: ChatMessageRecord): ChatMessageRecord {
  return {
    ...msg,
    toolCalls: msg.toolCalls.map((t) => ({
      ...t,
      locations: t.locations ? t.locations.map((loc) => ({ ...loc })) : undefined,
      diffs: t.diffs ? t.diffs.map((d) => ({ ...d })) : undefined,
    })),
    parts: msg.parts ? msg.parts.map((p) => ({ ...p })) : undefined,
    artifactIds: msg.artifactIds ? [...msg.artifactIds] : undefined,
    images: msg.images ? msg.images.map((img) => ({ ...img })) : undefined,
    files: msg.files ? msg.files.map((f) => ({ ...f })) : undefined,
  };
}

export class AgentHubServer {
  private _baseCwd: string;
  get baseCwd(): string {
    return this._baseCwd;
  }
  readonly pool = new AcpPool();
  readonly registry: AgentRegistry;
  private readonly settings: HubSettings = loadHubSettings();
  private readonly lastCostBySession = new Map<string, number>();
  private stateStore?: HubStateStore;
  private progressByGroup = new Map<string, TaskProgress>();
  private readonly memory = new MemoryMonitor((status) => {
    this.broadcast({ type: "memory_status", memory: status, timestamp: Date.now() });
    if (status.level !== "ok") {
      this.sweepIdleSubSessions();
      this.sweepIdleLeadSessions();
    }
    if (status.level === "ok") this.pumpBoard();
  });
  private idleSweepTimer?: ReturnType<typeof setInterval>;
  private pumpingBoard = false;
  private pumpPending = false;
  private permissionGroupByRequestId = new Map<string, string>();
  private readonly workflowTemplates = new WorkflowTemplateStore(WORKFLOW_TEMPLATES_FILE);
  readonly mcpServers = new McpServerManager(MCP_SERVERS_FILE);
  /** Handoffs the current lead asked for; carried out when its turn ends. */
  private pendingHandoffs = new Map<string, { from: AgentId; to: AgentId; brief: string }>();
  /** Sessions from before a restart: not running, kept so their history stays reachable. */
  private archivedSessions = new Map<string, SessionRecord>();
  private readonly taskContext = new TaskContextStore((context) =>
    this.broadcast({ type: "context_updated", context, timestamp: Date.now() }),
  );
  /** Sessions whose running turn the user interrupted in order to redirect it, and when. */
  private readonly steerPending = new Map<string, number>();
  /**
   * Dispatched tasks whose turn was interrupted that way. To the user this is still the same
   * piece of work, so the task stays open and ends with the turn that carries the guidance.
   */
  private readonly steeredTasks = new Map<string, TaskRecord>();
  /** Things the lead of a task should hear about, kept until it is free to take a turn. */
  private readonly leadInbox = new Map<string, LeadNotice[]>();
  /** Tasks whose caller is waiting for the result itself (peer_ask) or already fetched it. */
  private readonly selfServedTaskIds = new Set<string>();
  /** Tasks started by the workflow engine; their results are reported per workflow, not per task. */
  private readonly workflowTaskIds = new Set<string>();
  /** Lead turns started by the hub in a row, per task, since the user last wrote. */
  private readonly autoLeadTurns = new Map<string, number>();
  private readonly workflows = new WorkflowManager({
    dispatch: ({ groupId, agent, prompt, session, isolateWorktree, contextRefs, upstreamStepIds }) => {
      const group = this.groups.get(groupId);
      const lead = group?.leadAgent ?? this.getDefaultLead();
      const task = this.dispatchPeerTask(
        {
          targetAgent: agent,
          prompt,
          groupId,
          session,
          isolateWorktree,
          callerAgent: lead,
          callerSession: buildSessionKey(lead, `${groupId}__lead`),
          depth: 0,
        },
        { sections: contextRefs, results: upstreamStepIds },
      );
      this.workflowTaskIds.add(task.taskId);
      return task;
    },
    onSettled: (workflow) => this.reportWorkflowToLead(workflow),
    // Short on memory: finish what is running before starting anything else.
    maxParallel: () =>
      this.memory.get().level === "ok" ? clampWorkflowParallel(this.settings.workflowParallel) : 1,
    missingContext: (groupId, keys) => this.taskContext.missingSections(groupId, keys),
    saveResult: (groupId, step, output) => this.taskContext.setResult(groupId, step, output),
    clearResults: (groupId) => this.taskContext.clearResults(groupId),
    cancel: (sessionKey) => void this.pool.cancelSession(sessionKey),
    isKnownAgent: (agent) => this.registry.isEnabledAgent(agent),
    onChange: (workflow) =>
      this.broadcast({ type: "workflow_updated", workflow, timestamp: Date.now() }),
  });
  /** Lead forced for this run via --lead; wins over the persisted default lead. */
  private readonly launchLead?: AgentId;
  readonly resources: SharedResourceManager;
  private groups = new Map<string, TaskGroup>();
  private ledgers = new Map<string, ThreadLedger>();
  private defaultGroupId = "grp-default";
  private groupCounter = 1;
  private tasks = new Map<string, TaskRecord>();
  private taskWaiters = new Map<string, Array<() => void>>();
  private messages = new Map<string, ChatMessageRecord>();
  private activeAssistantBySession = new Map<string, ChatMessageRecord>();
  private artifacts = new Map<string, ArtifactRecord>();
  private pendingQuestions = new Map<
    string,
    {
      info: PendingUserQuestion;
      timer: ReturnType<typeof setTimeout>;
      resolve: (res: { cancelled: boolean; answers: Record<string, unknown> }) => void;
    }
  >();
  private turnSeq = 0;
  private telemetryTotals: SessionUsageTotals = createEmptyTotals();
  private telemetryByAgent: Record<string, SessionUsageTotals> = {};
  private recentTurns: TurnTelemetryRecord[] = [];
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private wsClients = new Set<WebSocket>();
  private url = "";
  private port = 0;
  private writeRuntimeFile: boolean;
  private strictPort: boolean;
  private desktopMode: boolean;
  private autoExitOnWindowClose: boolean;
  private autoExitGraceMs: number;
  private onAutoExit?: () => void;
  private hadWsClient = false;
  private autoExitTimer?: ReturnType<typeof setTimeout>;

  constructor(options: HubServerOptions) {
    this._baseCwd = path.resolve(options.baseCwd);
    this.writeRuntimeFile = options.writeRuntimeFile ?? true;
    this.strictPort = options.strictPort ?? false;
    this.desktopMode = options.desktopMode ?? false;
    this.autoExitOnWindowClose = options.autoExitOnWindowClose ?? false;
    this.autoExitGraceMs = options.autoExitGraceMs ?? 5000;
    this.onAutoExit = options.onAutoExit;
    this.registry = new AgentRegistry(this.baseCwd, { persistCache: this.writeRuntimeFile });
    this.resources = new SharedResourceManager(this.baseCwd);
    this.resources.setAgentRegistry(this.registry);
    this.pool.setResourceManager(this.resources);
    this.pool.setAgentRegistry(this.registry);
    this.pool.setElicitationHandler((params) => this.handleElicitationRequest(params));
    this.pool.setExtraDirsResolver((groupId) => this.groups.get(groupId)?.extraDirs ?? []);
    this.pool.setSharedMcpResolver((input) => this.mcpServers.forSession(input));
    this.launchLead = options.defaultLead;
    // Auth probes refresh in the background; push the new state when it actually changed.
    this.registry.onHealthChanged(() => this.broadcastAgentsUpdated());
    for (const def of this.registry.listDefinitions()) {
      this.telemetryByAgent[def.id] = createEmptyTotals();
    }
    if (options.permissionMode) {
      this.pool.setPermissionMode(options.permissionMode);
    }

    const now = Date.now();
    const initialGroup: TaskGroup = {
      groupId: this.defaultGroupId,
      title: translate(DEFAULT_LOCALE, "numberedTask", 1),
      defaultTitleNumber: 1,
      leadAgent: this.registry.resolveDefaultLead(options.defaultLead),
      agentModels: {},
      agentEfforts: {},
      cwd: this.baseCwd,
      createdAt: now,
      updatedAt: now,
    };
    this.syncGroupLeadModelFields(initialGroup);
    this.groups.set(initialGroup.groupId, initialGroup);
    this.ledgers.set(initialGroup.groupId, new ThreadLedger());

    if (options.persistState ?? (Boolean(options.stateFile) || this.writeRuntimeFile)) {
      this.stateStore = new HubStateStore(options.stateFile ?? STATE_FILE, () => this.collectPersistedState());
      this.restorePersistedState();
    }

    this.pool.on("hub_event", (event: HubEvent) => {
      // The title-naming session is internal plumbing: none of its events reach clients.
      const eventSessionKey =
        event.type === "session_updated"
          ? event.session.sessionKey
          : "sessionKey" in event && typeof event.sessionKey === "string"
            ? event.sessionKey
            : "";
      if (eventSessionKey.endsWith(TITLE_SESSION_SUFFIX)) {
        return;
      }
      if (event.type === "agent_chunk") {
        const active = this.activeAssistantBySession.get(event.sessionKey);
        if (active) {
          const partType: ChatMessagePart["type"] = event.channel === "thought" ? "thought" : "text";
          if (!active.parts) active.parts = [];
          const lastPart = active.parts[active.parts.length - 1];
          if (lastPart && lastPart.type === partType) {
            lastPart.text += event.text;
          } else {
            active.parts.push({ type: partType, text: event.text });
          }
          if (event.channel === "message") {
            active.text += event.text;
          } else if (event.channel === "thought") {
            active.thoughtText += event.text;
          }
          event.messageId = active.messageId;
          event.streamKey = active.streamKey;
          event.groupId = active.groupId;
        }
      } else if (event.type === "tool_event") {
        const active = this.activeAssistantBySession.get(event.sessionKey);
        if (active) {
          if (!active.parts) active.parts = [];
          const existingTool = active.toolCalls.find((t) => t.toolCallId === event.toolCallId);
          if (existingTool) {
            existingTool.title = event.title || existingTool.title;
            if (event.kind) existingTool.kind = event.kind;
            if (event.status) existingTool.status = event.status;
            if (event.rawInput !== undefined) existingTool.rawInput = event.rawInput;
            if (event.locations && event.locations.length > 0) existingTool.locations = event.locations;
            if (event.outputText !== undefined) existingTool.outputText = event.outputText;
            if (event.outputTruncated !== undefined) existingTool.outputTruncated = event.outputTruncated;
            if (event.diffs && event.diffs.length > 0) existingTool.diffs = event.diffs;
            if (event.status === "completed" || event.status === "failed") {
              existingTool.completedAt = event.timestamp;
            }
            existingTool.timestamp = event.timestamp;
          } else {
            active.toolCalls.push({
              toolCallId: event.toolCallId,
              title: event.title,
              kind: event.kind,
              status: event.status,
              rawInput: event.rawInput,
              locations: event.locations,
              outputText: event.outputText,
              outputTruncated: event.outputTruncated,
              diffs: event.diffs,
              timestamp: event.timestamp,
              completedAt:
                event.status === "completed" || event.status === "failed" ? event.timestamp : undefined,
            });
            active.parts.push({ type: "tool", toolCallId: event.toolCallId });
          }
          event.messageId = active.messageId;
          event.streamKey = active.streamKey;
          event.groupId = active.groupId;
        }
      }
      let permissionBoardGroupId: string | undefined;
      if (event.type === "permission_requested") {
        const gId = this.findGroupIdForSessionKey(event.permission.sessionKey);
        if (gId) {
          this.permissionGroupByRequestId.set(event.permission.requestId, gId);
          permissionBoardGroupId = gId;
        }
      } else if (event.type === "permission_resolved") {
        permissionBoardGroupId = this.permissionGroupByRequestId.get(event.requestId);
        this.permissionGroupByRequestId.delete(event.requestId);
      }
      this.broadcast(event);
      if (permissionBoardGroupId) {
        this.refreshBoardIfRelevant(permissionBoardGroupId);
      }
    });
  }

  private resolveGroupId(raw: string | null | undefined): string {
    const id = raw?.trim();
    return id && this.groups.has(id) ? id : this.defaultGroupId;
  }

  private requireDirectory(raw: string): string {
    const resolved = path.resolve(raw.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(t("directoryDoesNotExist", resolved));
    }
    return resolved;
  }

  /** Existing, de-duplicated directories other than the task's own cwd. */
  private normalizeExtraDirs(raw: string[] | undefined, cwd: string): string[] {
    const seen = new Set([path.resolve(cwd).toLowerCase()]);
    const out: string[] = [];
    for (const item of raw ?? []) {
      if (!item?.trim()) continue;
      const resolved = this.requireDirectory(item);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }
    return out;
  }

  getMemoryStatus(): MemoryStatus {
    return this.memory.get();
  }

  /**
   * Releases the agent processes of sub-sessions nobody has used for a while. Each one holds a
   * few hundred MB whether or not it is doing anything. The session stays in the list as
   * asleep; the next message starts it again and gives it back what was said in it.
   * Lead sessions are handled separately by sweepIdleLeadSessions under their own setting.
   */
  sweepIdleSubSessions(now = Date.now()): string[] {
    const underPressure = this.memory.get().level !== "ok";
    const minutes = clampIdleSubMinutes(this.settings.idleSubSessionMinutes);
    if (!underPressure && minutes === 0) return [];
    const idleMs = underPressure ? Math.min(PRESSURE_IDLE_MS, minutes > 0 ? minutes * 60_000 : PRESSURE_IDLE_MS) : minutes * 60_000;
    const waiting = new Set(this.pool.getPendingPermissions().map((p) => p.sessionKey));
    const released: string[] = [];
    for (const session of this.pool.listSessions()) {
      if (session.role !== "sub" || session.status !== "idle") continue;
      if (now - session.updatedAt < idleMs) continue;
      if (waiting.has(session.sessionKey) || this.activeAssistantBySession.has(session.sessionKey)) continue;
      const asleep: SessionRecord = { ...session, status: "closed", closedReason: "idle", pid: undefined, updatedAt: now };
      this.archivedSessions.set(session.sessionKey, asleep);
      released.push(session.sessionKey);
      void this.pool.closeSession(session.sessionKey).then(() => {
        // The pool's own close event does not carry the reason.
        this.broadcast({ type: "session_updated", session: { ...asleep }, timestamp: Date.now() });
      });
    }
    return released;
  }

  /**
   * Releases idle lead sessions once they exceed `idleLeadMinutes` (0 = never, unless memory is
   * under pressure, which uses a fixed 10-minute threshold). Leads waiting on an unanswered
   * question, a pending permission, or an active reply are left alone.
   */
  sweepIdleLeadSessions(now = Date.now()): string[] {
    const underPressure = this.memory.get().level !== "ok";
    const minutes = clampIdleLeadMinutes(this.settings.idleLeadMinutes);
    if (!underPressure && minutes === 0) return [];
    const idleMs = underPressure ? PRESSURE_IDLE_LEAD_MS : minutes * 60_000;
    const sessionGroups = new Map(this.pool.listSessions().map((s) => [s.sessionKey, s.groupId]));
    const waitingPermSessions = new Set<string>();
    const waitingPermGroups = new Set<string>();
    for (const p of this.pool.getPendingPermissions()) {
      waitingPermSessions.add(p.sessionKey);
      const gId = sessionGroups.get(p.sessionKey) ?? this.permissionGroupByRequestId.get(p.requestId);
      if (gId) waitingPermGroups.add(gId);
    }
    const waitingQuestionSessions = new Set<string>();
    const waitingQuestionGroups = new Set<string>();
    for (const entry of this.pendingQuestions.values()) {
      waitingQuestionSessions.add(entry.info.sessionKey);
      waitingQuestionGroups.add(entry.info.groupId);
    }
    const released: string[] = [];
    for (const session of this.pool.listSessions()) {
      if (session.role !== "lead" || session.status !== "idle") continue;
      if (now - session.updatedAt < idleMs) continue;
      if (
        waitingPermSessions.has(session.sessionKey) ||
        waitingPermGroups.has(session.groupId) ||
        waitingQuestionSessions.has(session.sessionKey) ||
        waitingQuestionGroups.has(session.groupId) ||
        this.activeAssistantBySession.has(session.sessionKey)
      ) {
        continue;
      }
      const asleep: SessionRecord = {
        ...session,
        status: "closed",
        closedReason: "idle",
        pid: undefined,
        updatedAt: now,
      };
      this.archivedSessions.set(session.sessionKey, asleep);
      released.push(session.sessionKey);
      void this.pool.closeSession(session.sessionKey).then(() => {
        this.broadcast({ type: "session_updated", session: { ...asleep }, timestamp: Date.now() });
      });
    }
    return released;
  }

  /**
   * What was said before in a sub-session that has no running agent any more (put to sleep, or
   * the hub restarted). The agent that answers next is a fresh process and gets this instead
   * of starting blank. Empty while the session is alive or has no history.
   */
  private buildSubSessionRecap(sessionKey: string): string {
    const live = this.pool.getSession(sessionKey);
    if (live && live.status !== "closed" && live.status !== "error") return "";
    const history = this.getMessages({ streamKey: `sub:${sessionKey}` }).filter(
      (m) => m.role !== "system" && m.status !== "streaming" && m.text.trim(),
    );
    if (history.length === 0) return "";
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      const text = m.text.trim();
      const clipped =
        text.length > SUB_RECAP_MESSAGE_CHARS
          ? `${text.slice(0, SUB_RECAP_MESSAGE_CHARS * 0.6)}\n[... ${text.length - SUB_RECAP_MESSAGE_CHARS} characters omitted ...]\n${text.slice(-SUB_RECAP_MESSAGE_CHARS * 0.4)}`
          : text;
      const line = `[${m.role === "assistant" ? "Your reply" : "Request"}]\n${clipped}`;
      if (used + line.length > SUB_RECAP_MAX_CHARS && lines.length > 0) {
        omitted = i + 1;
        break;
      }
      lines.unshift(line);
      used += line.length;
    }
    return [
      "<previous_session>",
      "This sub-session was closed while it was not in use and has just been started again, so you have no memory of it. Here is what was said in it before, oldest first. Files you changed then are still on disk.",
      ...(omitted > 0 ? [`[${omitted} earlier message(s) omitted]`] : []),
      lines.join("\n\n"),
      "</previous_session>",
      "",
      "",
    ].join("\n");
  }

  /** Closes every live session of a task group (their records stay, marked closed). */
  private closeGroupSessions(groupId: string): void {
    const liveSessions = this.pool.listSessions();
    const liveKeys = new Set(liveSessions.map((s) => s.sessionKey));
    const group = this.groups.get(groupId);
    if (group) {
      const leadKey = buildSessionKey(group.leadAgent, `${groupId}__lead`);
      if (!liveKeys.has(leadKey)) {
        void this.pool.cancelSession(leadKey).catch(() => false);
      }
    }
    for (const task of this.tasks.values()) {
      if (
        task.groupId === groupId &&
        (task.status === "running" || task.status === "queued") &&
        !liveKeys.has(task.targetSessionKey)
      ) {
        void this.pool.cancelSession(task.targetSessionKey).catch(() => false);
      }
    }
    for (const session of liveSessions) {
      if (session.groupId !== groupId) continue;
      this.archivedSessions.set(session.sessionKey, { ...session, status: "closed", pid: undefined });
      void this.pool.closeSession(session.sessionKey);
    }
  }

  /** Remembers a directory as recently used and tells clients the project list changed. */
  private touchProject(dir: string): void {
    const resolved = path.resolve(dir);
    const rest = (this.settings.recentProjects ?? []).filter(
      (p) => path.resolve(p.path).toLowerCase() !== resolved.toLowerCase(),
    );
    this.settings.recentProjects = [{ path: resolved, lastUsedAt: Date.now() }, ...rest].slice(0, 20);
    // Throwaway hubs (tests, benchmarks) must not write their temp directories into the settings.
    if (this.writeRuntimeFile)
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // not persisted; still valid for this run
    }
    this.broadcast({ type: "projects_updated", projects: this.listProjects(), timestamp: Date.now() });
  }

  /** Directories that have tasks, plus recently used ones that still exist. */
  listProjects(): ProjectInfo[] {
    const byKey = new Map<string, ProjectInfo>();
    const ensure = (dir: string, lastUsedAt: number): ProjectInfo => {
      const resolved = path.resolve(dir);
      const key = resolved.toLowerCase();
      let info = byKey.get(key);
      if (!info) {
        info = { path: resolved, name: path.basename(resolved) || resolved, activeTasks: 0, archivedTasks: 0, lastUsedAt };
        byKey.set(key, info);
      }
      info.lastUsedAt = Math.max(info.lastUsedAt, lastUsedAt);
      return info;
    };
    for (const group of this.groups.values()) {
      const info = ensure(group.cwd, group.updatedAt);
      if (group.archived) info.archivedTasks += 1;
      else info.activeTasks += 1;
    }
    for (const recent of this.settings.recentProjects ?? []) {
      if (fs.existsSync(recent.path)) ensure(recent.path, recent.lastUsedAt);
    }
    return [...byKey.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  getProgress(groupId: string): TaskProgress | undefined {
    const progress = this.progressByGroup.get(groupId);
    return progress ? { ...progress, items: progress.items.map((i) => ({ ...i })) } : undefined;
  }

  /**
   * Updates a task's goal and progress. Fields that are left out keep their value, so an
   * agent can tick off a step without repeating the goal; `items`, when given, replaces the list.
   */
  updateProgress(input: {
    groupId?: string;
    goal?: string;
    summary?: string;
    items?: Array<{ title: string; status: TaskProgress["items"][number]["status"]; note?: string }>;
    updatedBy?: string;
  }): TaskProgress {
    const groupId = input.groupId?.trim() && this.groups.has(input.groupId.trim()) ? input.groupId.trim() : this.defaultGroupId;
    const prev = this.progressByGroup.get(groupId);
    const clip = (text: string | undefined, max: number) => {
      const t = text?.trim();
      return t ? (t.length > max ? `${t.slice(0, max)}…` : t) : undefined;
    };
    const next: TaskProgress = {
      groupId,
      goal: input.goal !== undefined ? clip(input.goal, 400) : prev?.goal,
      summary: input.summary !== undefined ? clip(input.summary, 600) : prev?.summary,
      items:
        input.items !== undefined
          ? input.items.map((i) => ({ title: clip(i.title, 200) ?? "", status: i.status, note: clip(i.note, 300) }))
          : (prev?.items ?? []),
      updatedBy: input.updatedBy && this.registry.isKnownAgent(input.updatedBy) ? input.updatedBy : "user",
      updatedAt: Date.now(),
    };
    this.progressByGroup.set(groupId, next);
    this.broadcast({ type: "progress_updated", progress: this.getProgress(groupId)!, timestamp: next.updatedAt });
    return this.getProgress(groupId)!;
  }

  getSettings(): HubSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<HubSettings>): HubSettings {
    if (typeof patch.autoTitle === "boolean") {
      this.settings.autoTitle = patch.autoTitle;
    }
    if (patch.workflowParallel !== undefined) {
      this.settings.workflowParallel = clampWorkflowParallel(patch.workflowParallel);
    }
    if (patch.idleSubSessionMinutes !== undefined) {
      this.settings.idleSubSessionMinutes = clampIdleSubMinutes(patch.idleSubSessionMinutes);
    }
    if (patch.boardParallel !== undefined) {
      this.settings.boardParallel = clampBoardParallel(patch.boardParallel);
    }
    if (patch.idleLeadMinutes !== undefined) {
      this.settings.idleLeadMinutes = clampIdleLeadMinutes(patch.idleLeadMinutes);
    }
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      // Not persisted; the setting still applies until the hub restarts.
    }
    this.broadcast({ type: "settings_updated", settings: this.getSettings(), timestamp: Date.now() });
    if (patch.boardParallel !== undefined) {
      this.pumpBoard();
    }
    return this.getSettings();
  }

  private workspaceFileCache = new Map<string, { at: number; files: string[] }>();

  private resolveResourceCwd(cwdParam?: string, groupId?: string): string {
    if (cwdParam && cwdParam.trim()) {
      return path.resolve(cwdParam.trim());
    }
    if (groupId && groupId.trim()) {
      const grp = this.groups.get(groupId.trim());
      if (grp?.cwd) return grp.cwd;
    }
    return this.baseCwd;
  }

  private listWorkspaceFiles(cwd: string, query: string): string[] {
    const resolvedCwd = path.resolve(cwd);
    const now = Date.now();
    const cached = this.workspaceFileCache.get(resolvedCwd);
    let files: string[];
    if (cached && now - cached.at < 10_000) {
      files = cached.files;
    } else {
      const IGNORED = new Set([
        ".git",
        "node_modules",
        "dist",
        ".rtm",
        ".rtm-worktrees",
        ".agent-hub",
        ".agent-hub-worktrees",
        ".venv",
        "venv",
        "coverage",
        "target",
        "build",
      ]);
      const collected: string[] = [];
      const queue: string[] = [resolvedCwd];
      const MAX_FILES = 2000;
      while (queue.length > 0 && collected.length < MAX_FILES) {
        const currentDir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (collected.length >= MAX_FILES) break;
          if (IGNORED.has(entry.name)) continue;
          const full = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            queue.push(full);
          } else if (entry.isFile()) {
            const rel = path.relative(resolvedCwd, full).replace(/\\/g, "/");
            if (rel) collected.push(rel);
          }
        }
      }
      collected.sort((a, b) => a.localeCompare(b));
      this.workspaceFileCache.set(resolvedCwd, { at: now, files: collected });
      files = collected;
    }

    const q = query.trim().toLowerCase();
    if (!q) {
      return files.slice(0, 25);
    }
    const scored: Array<{ file: string; score: number }> = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      const base = path.posix.basename(lower);
      if (base.startsWith(q)) {
        scored.push({ file, score: 0 });
      } else if (base.includes(q)) {
        scored.push({ file, score: 1 });
      } else if (lower.includes(q)) {
        scored.push({ file, score: 2 });
      }
    }
    scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
    return scored.slice(0, 25).map((item) => item.file);
  }

  private pickFastModelForTitle(agent: AgentId): string | undefined {
    const FAST_RE = /(haiku|mini|flash|nano|lite)/i;
    const catalogs = this.registry.getAllModelCatalogs();
    const catalog = catalogs[agent];
    const fromCatalog = catalog?.models?.find((m) => FAST_RE.test(m.id))?.id;
    if (fromCatalog) return fromCatalog;
    const defModels = this.registry.getDefinition(agent)?.models ?? [];
    return defModels.find((id) => FAST_RE.test(id));
  }

  /**
   * Asks the lead agent for a short task title in a throwaway session (no peer MCP, no shared
   * rules, so it stays out of the task's own context), then applies it unless the user has
   * renamed the task meanwhile. Failures are silent: the prompt-derived title stays.
   */
  private async generateTaskTitle(
    group: TaskGroup,
    currentTitle: string,
    userPrompt: string,
    answer: string,
  ): Promise<void> {
    const trimmedPrompt = userPrompt.trim();
    if (
      trimmedPrompt &&
      !trimmedPrompt.includes("\n") &&
      trimmedPrompt.length <= 18 &&
      /[\p{L}\p{N}]/u.test(trimmedPrompt)
    ) {
      const directTitle = cleanGeneratedTitle(trimmedPrompt);
      const live = this.groups.get(group.groupId);
      if (directTitle && live && live.title === currentTitle && live.title !== directTitle) {
        live.title = directTitle;
        live.updatedAt = Date.now();
        this.broadcast({ type: "group_updated", group: { ...live }, timestamp: live.updatedAt });
      }
      return;
    }

    const agent = group.leadAgent;
    const sessionName = `${group.groupId}${TITLE_SESSION_SUFFIX}`;
    const sessionKey = buildSessionKey(agent, sessionName);
    try {
      const result = await this.pool.runTurn({
        agent,
        sessionName,
        baseCwd: group.cwd,
        prompt: [
          "给下面这段对话起一个任务标题：不超过 12 个汉字（或 6 个英文单词），概括用户要做的事，不带标点和引号。只输出标题本身，不要调用任何工具。",
          "",
          `用户：${userPrompt.slice(0, 600)}`,
          "",
          `助手：${answer.slice(0, 600)}`,
        ].join("\n"),
        model: this.pickFastModelForTitle(agent),
        effort: "low",
        injectSharedResources: false,
        injectPeerMcp: false,
        isolateWorktree: false,
        groupId: "__internal",
        label: "title",
      });
      const title = cleanGeneratedTitle(result.outputText);
      const live = this.groups.get(group.groupId);
      if (title && live && live.title === currentTitle) {
        live.title = title;
        live.defaultTitleNumber = null;
        live.updatedAt = Date.now();
        this.broadcast({ type: "group_updated", group: { ...live }, timestamp: live.updatedAt });
      }
    } catch {
      // keep the prompt-derived title
    } finally {
      void this.pool.closeSession(sessionKey);
    }
  }

  private getOrCreateLedger(groupId: string): ThreadLedger {
    let ledger = this.ledgers.get(groupId);
    if (!ledger) {
      ledger = new ThreadLedger();
      this.ledgers.set(groupId, ledger);
    }
    return ledger;
  }

  get ledger(): ThreadLedger {
    return this.getOrCreateLedger(this.defaultGroupId);
  }

  getGroupLedger(groupId: string): ThreadLedger {
    return this.getOrCreateLedger(groupId);
  }

  getUrl(): string {
    return this.url;
  }

  getPort(): number {
    return this.port;
  }

  getDefaultGroupId(): string {
    return this.defaultGroupId;
  }

  listGroups(): TaskGroup[] {
    return [...this.groups.values()].map((g) => ({ ...g }));
  }

  getGroup(groupId: string): TaskGroup | undefined {
    const group = this.groups.get(groupId);
    return group ? { ...group } : undefined;
  }

  getLeadAgent(groupId?: string): AgentId {
    const group = this.groups.get(groupId ?? this.defaultGroupId) ?? this.groups.get(this.defaultGroupId);
    return group?.leadAgent ?? this.getDefaultLead();
  }

  /** Lead used for new task groups: --lead, then the persisted setting, then the first ready agent. */
  getDefaultLead(): AgentId {
    return this.registry.resolveDefaultLead(this.launchLead);
  }

  /** Persists the default lead (null = automatic) and tells every client. */
  setDefaultLead(agent: string | null): { defaultLead: AgentId; configured?: AgentId } {
    const configured = this.registry.setDefaultLead(agent);
    this.broadcastAgentsUpdated();
    return { defaultLead: this.getDefaultLead(), configured };
  }

  setLeadAgent(agent: AgentId): void {
    this.setGroupLeadAgent(this.defaultGroupId, agent);
  }

  private requireKnownAgent(agent: string): AgentId {
    const clean = agent.trim().toLowerCase();
    if (!this.registry.isKnownAgent(clean)) {
      const available = this.registry.listEnabledIds().join(", ");
      throw new Error(`Unknown agent "${agent}". Enabled agents: ${available}`);
    }
    return clean;
  }

  private agentLabel(agent: AgentId): string {
    return this.registry.getDefinition(agent)?.label || agent;
  }

  /**
   * The lead of a task asks to pass the lead role to another agent. Nothing switches yet:
   * the current lead finishes its turn first, then the new lead is started with the brief.
   */
  requestLeadHandoff(input: { groupId?: string; from: string; to: string; brief: string; depth?: number }): {
    groupId: string;
    to: AgentId;
    toLabel: string;
  } {
    const group = this.groups.get(input.groupId && this.groups.has(input.groupId) ? input.groupId : this.defaultGroupId)!;
    if ((input.depth ?? 0) > 0 || input.from.trim().toLowerCase() !== group.leadAgent) {
      throw new Error("Only the current lead of the task can hand the lead role over.");
    }
    const enabled = this.registry.listEnabledDefinitions();
    const wanted = input.to.trim().toLowerCase();
    const target = enabled.find((d) => d.id === wanted) ?? enabled.find((d) => (d.label || "").toLowerCase() === wanted);
    const others = enabled.filter((d) => d.id !== group.leadAgent);
    if (!target) {
      throw new Error(
        `No enabled agent "${input.to}". Agents that can take over: ${others.map((d) => d.id).join(", ") || "(none)"}`,
      );
    }
    if (target.id === group.leadAgent) {
      throw new Error(`${target.id} already leads this task.`);
    }
    const brief = input.brief.trim();
    if (!brief) {
      throw new Error("The handoff brief is empty.");
    }
    this.pendingHandoffs.set(group.groupId, { from: group.leadAgent, to: target.id, brief });
    return { groupId: group.groupId, to: target.id, toLabel: target.label || target.id };
  }

  /** Carries out a handoff the lead asked for during the turn that just ended. */
  private completePendingHandoff(group: TaskGroup, finishedLead: AgentId, turnSucceeded: boolean): void {
    const pending = this.pendingHandoffs.get(group.groupId);
    if (!pending) return;
    this.pendingHandoffs.delete(group.groupId);
    if (!turnSucceeded || pending.from !== finishedLead || group.leadAgent !== finishedLead || group.archived) return;
    try {
      this.setGroupLeadAgent(group.groupId, pending.to);
    } catch {
      return;
    }
    // Started before the finished turn's response goes out, so a message the user sends next
    // queues behind the takeover turn. Failures are already shown in the transcript.
    void this.runLeadChat({ groupId: group.groupId, handoff: { from: pending.from, brief: pending.brief } }).catch(() => {});
  }

  private syncGroupLeadModelFields(group: TaskGroup): void {
    const def = this.registry.getDefinition(group.leadAgent);
    group.leadModel = group.agentModels?.[group.leadAgent] ?? def?.defaultModel;
    group.leadEffort = group.agentEfforts?.[group.leadAgent] ?? def?.defaultEffort;
  }

  createGroup(input?: {
    title?: string;
    leadAgent?: AgentId;
    leadModel?: string;
    leadEffort?: string;
    cwd?: string;
    extraDirs?: string[];
  }, defaultTitleNumber = this.groupCounter + 1): TaskGroup {
    const now = Date.now();
    const cwd = input?.cwd?.trim() ? this.requireDirectory(input.cwd) : this.baseCwd;
    const extraDirs = this.normalizeExtraDirs(input?.extraDirs, cwd);
    this.groupCounter += 1;
    const rawTitle = input?.title?.trim();
    const leadAgent = input?.leadAgent ? this.requireKnownAgent(input.leadAgent) : this.getDefaultLead();
    const agentModels: Record<string, string> = {};
    const agentEfforts: Record<string, string> = {};
    if (input?.leadModel?.trim()) {
      agentModels[leadAgent] = input.leadModel.trim();
    }
    if (input?.leadEffort?.trim()) {
      agentEfforts[leadAgent] = input.leadEffort.trim();
    }
    const group: TaskGroup = {
      groupId: `grp-${randomUUID().slice(0, 6)}`,
      title: rawTitle || translate(DEFAULT_LOCALE, "numberedTask", defaultTitleNumber),
      defaultTitleNumber: rawTitle ? null : defaultTitleNumber,
      leadAgent,
      agentModels,
      agentEfforts,
      cwd,
      extraDirs: extraDirs.length > 0 ? extraDirs : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.syncGroupLeadModelFields(group);
    this.groups.set(group.groupId, group);
    this.ledgers.set(group.groupId, new ThreadLedger());
    this.touchProject(cwd);
    this.broadcast({
      type: "group_created",
      group: { ...group },
      timestamp: now,
    });
    return { ...group };
  }

  publishBoardTasks(input: {
    items: Array<{
      brief: string;
      title?: string;
      leadAgent?: AgentId;
      leadModel?: string;
      leadEffort?: string;
      cwd?: string;
      extraDirs?: string[];
    }>;
    common?: string;
  }): TaskGroup[] {
    if (!input || !Array.isArray(input.items) || input.items.length === 0) {
      throw new Error("publishBoardTasks requires at least one item");
    }

    for (const item of input.items) {
      if (!item || typeof item.brief !== "string" || !item.brief.trim()) {
        throw new Error("Task brief must not be empty");
      }
      const resolvedCwd = this.requireDirectory(item.cwd?.trim() ? item.cwd : this.baseCwd);
      if (item.extraDirs) {
        this.normalizeExtraDirs(item.extraDirs, resolvedCwd);
      }
      const targetLead = item.leadAgent?.trim() ? this.requireKnownAgent(item.leadAgent) : this.getDefaultLead();
      if (!this.registry.isEnabledAgent(targetLead)) {
        throw new Error(`Lead agent ${targetLead} is not enabled`);
      }
    }

    const cleanCommon = input.common?.trim();
    const now = Date.now();
    const groups: TaskGroup[] = [];

    for (let idx = 0; idx < input.items.length; idx++) {
      const item = input.items[idx];
      const created = this.createGroup({
        title: item.title,
        leadAgent: item.leadAgent?.trim() || undefined,
        leadModel: item.leadModel,
        leadEffort: item.leadEffort,
        cwd: item.cwd,
        extraDirs: item.extraDirs,
      });
      const group = this.groups.get(created.groupId)!;
      const trimmedBrief = item.brief.trim();
      group.board = {
        status: "queued",
        brief: cleanCommon ? `${cleanCommon}\n\n${trimmedBrief}` : trimmedBrief,
        queuedAt: now + idx,
        rejectCount: 0,
      };
      if (cleanCommon) {
        this.taskContext.put(group.groupId, {
          key: "common",
          content: cleanCommon,
          updatedBy: "user",
        });
      }
      group.updatedAt = Date.now();
      this.broadcast({
        type: "group_updated",
        group: { ...group },
        timestamp: group.updatedAt,
      });
      groups.push({ ...group, board: { ...group.board } });
    }

    this.broadcastBoardUpdated();
    this.pumpBoard();
    return groups;
  }

  listBoardCards(): BoardCard[] {
    const cards: BoardCard[] = [];
    for (const group of this.groups.values()) {
      if (group.board && !group.archived) {
        const waitingReason = this.boardWaiting(group.groupId);
        cards.push({
          groupId: group.groupId,
          title: group.title,
          leadAgent: group.leadAgent,
          cwd: group.cwd,
          board: { ...group.board },
          waiting: Boolean(waitingReason),
          waitingReason,
        });
      }
    }
    return cards.sort((a, b) => a.board.queuedAt - b.board.queuedAt);
  }

  private findGroupIdForSessionKey(sessionKey: string): string | undefined {
    const direct =
      this.pool.getSession(sessionKey)?.groupId ??
      this.archivedSessions.get(sessionKey)?.groupId;
    if (direct) return direct;
    for (const group of this.groups.values()) {
      if (
        sessionKey === buildSessionKey(group.leadAgent, `${group.groupId}__lead`) ||
        sessionKey.endsWith(`:${group.groupId}__lead`)
      ) {
        return group.groupId;
      }
    }
    for (const task of this.tasks.values()) {
      if (task.targetSessionKey === sessionKey) return task.groupId;
    }
    return undefined;
  }

  private cancelGroupPermissions(groupId: string): void {
    const sessionGroups = new Map(this.pool.listSessions().map((s) => [s.sessionKey, s.groupId]));
    for (const perm of this.pool.getPendingPermissions()) {
      const gId =
        sessionGroups.get(perm.sessionKey) ??
        this.permissionGroupByRequestId.get(perm.requestId) ??
        this.findGroupIdForSessionKey(perm.sessionKey);
      if (gId === groupId) {
        this.pool.resolvePermission(perm.requestId, "cancel");
      }
    }
    for (const [reqId, gId] of this.permissionGroupByRequestId) {
      if (gId === groupId) {
        this.permissionGroupByRequestId.delete(reqId);
      }
    }
  }

  private boardWaiting(groupId: string): BoardWaitingReason | undefined {
    const group = this.groups.get(groupId);
    if (!group || !group.board || group.board.status !== "running") {
      return undefined;
    }
    if (group.board.interrupted) return "interrupted";
    if (group.board.stalled) return "stalled";
    for (const entry of this.pendingQuestions.values()) {
      if (entry.info.groupId === groupId) return "question";
    }
    const pendingPerms = this.pool.getPendingPermissions();
    if (pendingPerms.length > 0) {
      const sessionGroups = new Map(this.pool.listSessions().map((s) => [s.sessionKey, s.groupId]));
      for (const perm of pendingPerms) {
        const gId =
          sessionGroups.get(perm.sessionKey) ??
          this.permissionGroupByRequestId.get(perm.requestId) ??
          this.findGroupIdForSessionKey(perm.sessionKey);
        if (gId === groupId) return "permission";
      }
    }
    return undefined;
  }

  private refreshBoardIfRelevant(groupId: string | undefined): void {
    if (!groupId) return;
    const group = this.groups.get(groupId);
    if (group?.board) {
      this.broadcastBoardUpdated();
      this.pumpBoard();
    }
  }

  private broadcastBoardUpdated(): void {
    this.broadcast({
      type: "board_updated",
      cards: this.listBoardCards(),
      timestamp: Date.now(),
    });
  }

  private boardChanged(group: TaskGroup): void {
    group.updatedAt = Date.now();
    this.broadcast({
      type: "group_updated",
      group: { ...group },
      timestamp: group.updatedAt,
    });
    this.broadcastBoardUpdated();
    this.pumpBoard();
  }

  private pumpBoard(): void {
    if (this.pumpingBoard) {
      this.pumpPending = true;
      return;
    }
    this.pumpingBoard = true;
    try {
      do {
        this.pumpPending = false;
        if (this.memory.get().level !== "ok") {
          return;
        }
        const waitingIds = new Set<string>();
        for (const group of this.groups.values()) {
          if (group.board && !group.archived && this.boardWaiting(group.groupId)) {
            waitingIds.add(group.groupId);
          }
        }
        const toStart = pickToStart(
          [...this.groups.values()],
          waitingIds,
          clampBoardParallel(this.settings.boardParallel),
        );
        for (const groupId of toStart) {
          const group = this.groups.get(groupId);
          if (!group || !group.board || group.board.status !== "queued") continue;
          group.board.status = "running";
          group.board.startedAt = Date.now();
          this.boardChanged(group);

          const rejectPrefix = group.board.rejectNote
            ? `<rejected>\nThe user sent your previous delivery back. Their note: ${group.board.rejectNote}\n</rejected>\n\n`
            : "";
          const prompt = `${rejectPrefix}${group.board.brief}\n\n<task_board>\nThis task was published on the task board. When the work is finished, call the \`task_report\` tool with outcome "delivered", a short summary, and every deliverable (files as paths relative to the working directory). If the task cannot be done, call \`task_report\` with outcome "failed" and the reason. Do not end without calling it: the board only frees this task's slot when you report.\n</task_board>`;

          const startedBoard = group.board;
          void this.runLeadChat({ groupId, prompt }).catch((err) => {
            if (group.board === startedBoard && group.board.status === "running") {
              group.board.status = "failed";
              group.board.failReason = err instanceof Error ? err.message : String(err);
              group.board.closedAt = Date.now();
              this.boardChanged(group);
            }
          });
        }
      } while (this.pumpPending);
    } finally {
      this.pumpingBoard = false;
    }
  }

  private releaseBoardSessions(groupId: string): void {
    const now = Date.now();
    const liveSessions = this.pool.listSessions();
    const liveKeys = new Set(liveSessions.map((s) => s.sessionKey));
    const group = this.groups.get(groupId);
    if (group) {
      const leadKey = buildSessionKey(group.leadAgent, `${groupId}__lead`);
      if (!liveKeys.has(leadKey)) {
        void this.pool.cancelSession(leadKey).catch(() => false);
      }
    }
    for (const task of this.tasks.values()) {
      if (
        task.groupId === groupId &&
        (task.status === "running" || task.status === "queued") &&
        !liveKeys.has(task.targetSessionKey)
      ) {
        void this.pool.cancelSession(task.targetSessionKey).catch(() => false);
      }
    }
    for (const session of liveSessions) {
      if (session.groupId !== groupId) continue;
      const asleep: SessionRecord = {
        ...session,
        status: "closed",
        closedReason: "idle",
        pid: undefined,
        updatedAt: now,
      };
      this.archivedSessions.set(session.sessionKey, asleep);
      void this.pool.closeSession(session.sessionKey).then(() => {
        if (!this.pool.getSession(session.sessionKey)) {
          this.broadcast({ type: "session_updated", session: { ...asleep }, timestamp: Date.now() });
        }
      });
    }
  }

  private checkBoardStall(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.archived || !group.board || group.board.status !== "running") {
      return;
    }
    if (this.boardWaiting(groupId)) return;
    if (this.pendingHandoffs.has(groupId)) return;
    if (this.steerPending.has(buildSessionKey(group.leadAgent, `${groupId}__lead`))) return;
    const hasBusySession = this.pool.listSessions().some(
      (s) => s.groupId === groupId && (s.status === "busy" || s.status === "starting"),
    );
    if (hasBusySession) return;
    const hasActiveTurn = [...this.activeAssistantBySession.values()].some((m) => m.groupId === groupId);
    if (hasActiveTurn) return;
    const hasRunningTask = [...this.tasks.values()].some(
      (task) => task.groupId === groupId && (task.status === "running" || task.status === "queued"),
    );
    if (hasRunningTask) return;
    if (this.workflows.get(groupId).status === "running") return;
    if ((this.leadInbox.get(groupId)?.length ?? 0) > 0) return;

    this.notifyLead(groupId, {
      boardNudge: true,
      summary: t("boardNudgeSummary"),
      detail:
        'You ended your turn, but this task is still open on the task board and nothing is running for it. Either call `task_report` now (outcome "delivered" with the deliverables, or "failed" with the reason), or say what is left and keep working.',
    });
  }

  reportBoardTask(input: {
    groupId: string;
    depth?: number;
    outcome: "delivered" | "failed";
    summary: string;
    deliverables?: BoardDeliverable[];
    reason?: string;
  }): TaskBoardInfo {
    if ((input.depth ?? 0) > 0) {
      throw new Error("Only the lead of the task can report its outcome on the task board.");
    }
    const group = this.groups.get(input.groupId);
    if (!group || !group.board) {
      throw new Error("This task is not on the task board; nothing to report.");
    }
    if (group.archived) {
      throw new Error("This task is archived.");
    }
    if (group.board.status !== "running") {
      throw new Error(`This task is ${group.board.status}; it can only be reported while running.`);
    }
    const cleanSummary = input.summary.trim();
    if (!cleanSummary) {
      throw new Error("Report summary must not be empty.");
    }
    const now = Date.now();
    if (input.outcome === "failed") {
      const cleanReason = input.reason?.trim();
      if (!cleanReason) {
        throw new Error("Failed outcome requires a non-empty reason.");
      }
      group.board.status = "failed";
      group.board.summary = cleanSummary;
      group.board.failReason = cleanReason;
      group.board.closedAt = now;
      delete group.board.stalled;
      delete group.board.interrupted;
    } else {
      const isExistingFile = (absPath: string): boolean => {
        try {
          return fs.statSync(absPath).isFile();
        } catch {
          return false;
        }
      };
      const missing = missingDeliverables(
        input.deliverables ?? [],
        [group.cwd, ...(group.extraDirs ?? [])],
        isExistingFile,
      );
      if (missing.length > 0) {
        throw new Error(
          `These files do not exist: ${missing.join(", ")}. Create them or correct the list, then report again.`,
        );
      }
      group.board.status = "delivered";
      group.board.summary = cleanSummary;
      group.board.deliverables = (input.deliverables ?? []).map((d) => ({ ...d }));
      group.board.deliveredAt = now;
      delete group.board.failReason;
      delete group.board.stalled;
      delete group.board.interrupted;
    }
    this.leadInbox.delete(group.groupId);
    this.boardChanged(group);
    const leadKey = buildSessionKey(group.leadAgent, `${group.groupId}__lead`);
    const leadSession = this.pool.getSession(leadKey);
    const leadBusy =
      this.activeAssistantBySession.has(leadKey) ||
      leadSession?.status === "busy" ||
      leadSession?.status === "starting";
    if (!leadBusy) {
      this.releaseBoardSessions(group.groupId);
    }
    return { ...group.board };
  }

  async actOnBoardTask(input: { groupId: string; action: BoardAction; note?: string }): Promise<TaskGroup> {
    const group = this.groups.get(input.groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${input.groupId}`);
    }
    if (!group.board) {
      throw new Error("This task is not on the task board.");
    }
    if (group.archived) {
      throw new Error("This task is archived.");
    }
    const prevStatus = group.board.status;
    let earliestQueuedAt: number | undefined;
    for (const candidate of this.groups.values()) {
      if (
        !candidate.archived &&
        candidate.board?.status === "queued" &&
        candidate.groupId !== group.groupId
      ) {
        if (earliestQueuedAt === undefined || candidate.board.queuedAt < earliestQueuedAt) {
          earliestQueuedAt = candidate.board.queuedAt;
        }
      }
    }
    const nextBoard = applyBoardAction(group.board, input.action, {
      now: Date.now(),
      note: input.note,
      earliestQueuedAt,
    });
    group.board = nextBoard;

    if (input.action === "resume") {
      delete group.board.stalled;
      this.autoLeadTurns.delete(group.groupId);
      const baseDetail =
        "The workbench was restarted while this task was running, and the user has now asked you to continue. Your previous session is gone; the history above is what was said. Check what is already done in the working directory, finish the task, and call `task_report` when done.";
      const hasTurns = (this.ledgers.get(group.groupId)?.getAllTurns().length ?? 0) > 0;
      const detail = hasTurns
        ? baseDetail
        : `${baseDetail}\n\nOriginal task brief:\n${group.board.brief}`;
      this.notifyLead(group.groupId, {
        summary: t("boardResumeSummary"),
        detail,
      });
    }

    if (input.action === "cancel") {
      this.leadInbox.delete(group.groupId);
      this.autoLeadTurns.delete(group.groupId);
      this.pendingHandoffs.delete(group.groupId);
      if (prevStatus === "queued") {
        return this.updateGroup({ groupId: group.groupId, archived: true });
      }
      if (prevStatus === "running") {
        this.workflows.cancel(group.groupId);
        for (const [questionId, entry] of this.pendingQuestions.entries()) {
          if (entry.info.groupId === group.groupId) {
            clearTimeout(entry.timer);
            this.pendingQuestions.delete(questionId);
            this.broadcast({
              type: "question_resolved",
              questionId,
              cancelled: true,
              answers: {},
              timestamp: Date.now(),
            });
            entry.resolve({ cancelled: true, answers: {} });
          }
        }
        this.cancelGroupPermissions(group.groupId);
        const sessionKeysToCancel = new Set<string>(
          this.pool
            .listSessions()
            .filter((s) => s.groupId === group.groupId)
            .map((s) => s.sessionKey),
        );
        sessionKeysToCancel.add(buildSessionKey(group.leadAgent, `${group.groupId}__lead`));
        for (const task of this.tasks.values()) {
          if (task.groupId === group.groupId && (task.status === "running" || task.status === "queued")) {
            sessionKeysToCancel.add(task.targetSessionKey);
          }
        }
        await Promise.all([...sessionKeysToCancel].map((key) => this.pool.cancelSession(key).catch(() => false)));
        this.releaseBoardSessions(group.groupId);
      }
    }

    this.boardChanged(group);
    return { ...group, board: { ...group.board } };
  }

  updateGroup(input: {
    groupId: string;
    title?: string;
    leadAgent?: AgentId;
    archived?: boolean;
    cwd?: string;
    extraDirs?: string[];
  }): TaskGroup {
    let group = this.groups.get(input.groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${input.groupId}`);
    }
    let changed = false;
    const cleanTitle = input.title?.trim();
    if (cleanTitle && (cleanTitle !== group.title || typeof group.defaultTitleNumber === "number")) {
      group.title = cleanTitle;
      group.defaultTitleNumber = null;
      changed = true;
    }
    // Directories: sessions are bound to the directories they started with, so a change
    // closes the task's sessions; the next message starts fresh ones and hands over the history.
    let dirsChanged = false;
    if (input.cwd !== undefined && input.cwd.trim()) {
      const nextCwd = this.requireDirectory(input.cwd);
      if (nextCwd.toLowerCase() !== path.resolve(group.cwd).toLowerCase()) {
        group.cwd = nextCwd;
        dirsChanged = true;
      }
    }
    if (input.extraDirs !== undefined || dirsChanged) {
      const nextExtra = this.normalizeExtraDirs(input.extraDirs ?? group.extraDirs, group.cwd);
      if (JSON.stringify(nextExtra) !== JSON.stringify(group.extraDirs ?? [])) {
        group.extraDirs = nextExtra.length > 0 ? nextExtra : undefined;
        dirsChanged = true;
      }
    }
    if (dirsChanged) {
      changed = true;
      this.closeGroupSessions(group.groupId);
      this.touchProject(group.cwd);
    }
    if (typeof input.archived === "boolean" && Boolean(group.archived) !== input.archived) {
      group.archived = input.archived;
      group.archivedAt = input.archived ? Date.now() : undefined;
      changed = true;
      if (input.archived) {
        // An archived task holds no agent processes and runs nothing.
        this.leadInbox.delete(group.groupId);
        this.workflows.cancel(group.groupId);
        this.cancelGroupPermissions(group.groupId);
        this.closeGroupSessions(group.groupId);
      }
      if (input.archived && this.defaultGroupId === group.groupId) {
        for (const candidate of this.groups.values()) {
          if (!candidate.archived && candidate.groupId !== group.groupId) {
            this.defaultGroupId = candidate.groupId;
            break;
          }
        }
      }
    }
    if (changed) {
      group.updatedAt = Date.now();
      this.broadcast({
        type: "group_updated",
        group: { ...group },
        timestamp: group.updatedAt,
      });
    }
    if (input.leadAgent) {
      this.setGroupLeadAgent(group.groupId, input.leadAgent);
      group = this.groups.get(group.groupId)!;
    }
    if (changed && group.board) {
      this.broadcastBoardUpdated();
      this.pumpBoard();
    }
    return { ...group };
  }

  setGroupLeadAgent(groupId: string, agent: AgentId): TaskGroup {
    const validAgent = this.requireKnownAgent(agent);
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${groupId}`);
    }
    if (group.leadAgent === validAgent) {
      return { ...group };
    }
    const previousLead = group.leadAgent;
    const now = Date.now();
    // A session pre-warmed for the previous lead that never ran a turn has no context worth
    // keeping; sessions that did run stay alive so switching back resumes them.
    void this.pool.discardWarmSession(buildSessionKey(previousLead, `${groupId}__lead`));
    group.leadAgent = validAgent;
    this.syncGroupLeadModelFields(group);
    group.updatedAt = now;

    const leadHandoff: [string, string] = [this.agentLabel(previousLead), this.agentLabel(validAgent)];
    this.upsertMessage({
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId,
      streamKey: `lead:${groupId}`,
      sessionKey: buildSessionKey(validAgent, `${groupId}__lead`),
      role: "system",
      senderLabel: "系统",
      leadHandoff,
      text: t("leadChanged", ...leadHandoff),
      thoughtText: "",
      toolCalls: [],
      status: "done",
      timestamp: now,
      completedAt: now,
    });

    this.broadcast({
      type: "group_lead_changed",
      groupId,
      leadAgent: agent,
      previousLead,
      timestamp: now,
    });
    this.broadcast({
      type: "group_updated",
      group: { ...group },
      timestamp: now,
    });
    if (groupId === this.defaultGroupId) {
      this.broadcast({
        type: "lead_changed",
        leadAgent: agent,
        previousLead,
        timestamp: now,
      });
    }
    if (group.board) {
      this.broadcastBoardUpdated();
    }
    return { ...group };
  }

  async setGroupModel(
    groupId: string,
    input: { agent?: AgentId; model?: string; effort?: string },
  ): Promise<{ group: TaskGroup; session?: SessionRecord }> {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${groupId}`);
    }
    const targetAgent = input.agent ? this.requireKnownAgent(input.agent) : group.leadAgent;
    group.agentModels ??= {};
    group.agentEfforts ??= {};

    if (input.model !== undefined) {
      const trimmed = input.model.trim();
      if (!trimmed) {
        delete group.agentModels[targetAgent];
      } else {
        group.agentModels[targetAgent] = trimmed;
      }
    }
    if (input.effort !== undefined) {
      const trimmed = input.effort.trim();
      if (!trimmed) {
        delete group.agentEfforts[targetAgent];
      } else {
        group.agentEfforts[targetAgent] = trimmed;
      }
    }

    this.syncGroupLeadModelFields(group);
    group.updatedAt = Date.now();
    this.broadcast({
      type: "group_updated",
      group: { ...group },
      timestamp: group.updatedAt,
    });

    const leadSessionKey = buildSessionKey(targetAgent, `${group.groupId}__lead`);
    const existingSession = this.pool.getSession(leadSessionKey);
    if (existingSession && existingSession.status !== "closed" && existingSession.status !== "error") {
      const def = this.registry.getDefinition(targetAgent);
      const catalog = existingSession.modelCatalog ?? this.registry.getModelCatalog(targetAgent);
      const effectiveModel =
        input.model !== undefined
          ? input.model.trim() || def?.defaultModel || catalog?.models[0]?.id
          : undefined;
      const effectiveEffort =
        input.effort !== undefined
          ? input.effort.trim() || def?.defaultEffort
          : undefined;
      if (effectiveModel || effectiveEffort) {
        const updatedSession = await this.pool.setSessionModel(
          leadSessionKey,
          effectiveModel,
          effectiveEffort,
        );
        return { group: { ...group }, session: updatedSession };
      }
    }

    return { group: { ...group } };
  }

  async deleteGroup(groupId: string): Promise<void> {
    const targetGroup = this.groups.get(groupId);
    if (!targetGroup) {
      throw new Error(`Unknown task group: ${groupId}`);
    }
    const hadBoard = Boolean(targetGroup.board);
    this.cancelGroupPermissions(groupId);
    const sessionsToClose = this.pool.listSessions().filter((s) => s.groupId === groupId);
    await Promise.all(sessionsToClose.map((s) => this.pool.closeSession(s.sessionKey)));

    // Clean up git worktrees created inside this group once ACP processes have released handles
    const worktreesToRemove = new Map<string, string>();
    for (const s of sessionsToClose) {
      if (s.isWorktree && s.effectiveCwd) {
        worktreesToRemove.set(path.resolve(s.effectiveCwd), s.baseCwd || targetGroup.cwd || this.baseCwd);
      }
    }
    for (const session of this.archivedSessions.values()) {
      if (session.groupId === groupId && session.isWorktree && session.effectiveCwd) {
        worktreesToRemove.set(
          path.resolve(session.effectiveCwd),
          session.baseCwd || targetGroup.cwd || this.baseCwd,
        );
      }
    }
    for (const task of this.tasks.values()) {
      if (task.groupId === groupId && task.worktreePath) {
        worktreesToRemove.set(path.resolve(task.worktreePath), targetGroup.cwd || this.baseCwd);
      }
    }
    for (const [wtPath, wtBaseCwd] of worktreesToRemove) {
      try {
        removeSessionWorktree(wtBaseCwd, wtPath);
      } catch {
        // Best-effort worktree removal; do not block deleting the group
      }
    }

    this.groups.delete(groupId);
    this.ledgers.delete(groupId);
    this.workflows.forget(groupId);
    this.taskContext.forget(groupId);
    this.progressByGroup.delete(groupId);
    this.leadInbox.delete(groupId);
    this.autoLeadTurns.delete(groupId);
    this.pendingHandoffs.delete(groupId);
    for (const [reqId, gId] of this.permissionGroupByRequestId) {
      if (gId === groupId) this.permissionGroupByRequestId.delete(reqId);
    }
    for (const [key, session] of this.archivedSessions) {
      if (session.groupId === groupId) this.archivedSessions.delete(key);
    }

    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const collectUploadPaths = (msg: ChatMessageRecord): string[] => {
      const paths: string[] = [];
      for (const img of msg.images ?? []) {
        if (typeof img.url === "string" && img.url.startsWith("/uploads/")) {
          const name = path.basename(decodeURIComponent(img.url.slice("/uploads/".length)));
          if (name) paths.push(path.resolve(UPLOADS_DIR, name));
        }
      }
      for (const file of msg.files ?? []) {
        if (file.localPath) paths.push(path.resolve(file.localPath));
      }
      return paths;
    };

    const candidateUploads = new Set<string>();
    for (const [msgId, msg] of this.messages.entries()) {
      if (msg.groupId === groupId) {
        for (const p of collectUploadPaths(msg)) candidateUploads.add(p);
        this.messages.delete(msgId);
      }
    }

    if (candidateUploads.size > 0) {
      const stillReferenced = new Set<string>();
      for (const msg of this.messages.values()) {
        for (const p of collectUploadPaths(msg)) stillReferenced.add(p);
      }
      const normRoot = process.platform === "win32" ? uploadsRoot.toLowerCase() : uploadsRoot;
      for (const filePath of candidateUploads) {
        if (stillReferenced.has(filePath)) continue;
        const normPath = process.platform === "win32" ? filePath.toLowerCase() : filePath;
        if (!normPath.startsWith(normRoot + path.sep)) continue;
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          // Best-effort attachment cleanup
        }
      }
    }

    for (const [artifactId, artifact] of this.artifacts.entries()) {
      if (artifact.groupId === groupId) {
        this.artifacts.delete(artifactId);
      }
    }
    for (const [questionId, entry] of this.pendingQuestions.entries()) {
      if (entry.info.groupId === groupId) {
        clearTimeout(entry.timer);
        this.pendingQuestions.delete(questionId);
        entry.resolve({ cancelled: true, answers: {} });
        this.broadcast({
          type: "question_resolved",
          questionId,
          cancelled: true,
          answers: {},
          timestamp: Date.now(),
        });
      }
    }
    for (const [sessionKey, active] of this.activeAssistantBySession.entries()) {
      if (active.groupId === groupId) {
        this.activeAssistantBySession.delete(sessionKey);
      }
    }
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.groupId === groupId) {
        this.tasks.delete(taskId);
      }
    }

    this.broadcast({
      type: "group_deleted",
      groupId,
      timestamp: Date.now(),
    });

    if (this.groups.size === 0) {
      const replacement = this.createGroup(undefined, 1);
      this.defaultGroupId = replacement.groupId;
    } else if (groupId === this.defaultGroupId) {
      const firstRemaining = this.groups.values().next().value as TaskGroup;
      this.defaultGroupId = firstRemaining.groupId;
    }

    if (hadBoard) {
      this.broadcastBoardUpdated();
      this.pumpBoard();
    }
  }

  private resolveSessionWorktreeTarget(sessionKey: string): {
    session?: SessionRecord;
    baseCwd: string;
    worktreePath: string;
  } {
    const session = this.pool.getSession(sessionKey) ?? this.archivedSessions.get(sessionKey);
    const matchingTask = [...this.tasks.values()]
      .reverse()
      .find((t) => t.targetSessionKey === sessionKey && t.worktreePath);
    const worktreePath =
      session?.isWorktree && session.effectiveCwd ? session.effectiveCwd : matchingTask?.worktreePath;
    if (!worktreePath) {
      throw new Error(t("thisSessionHasNoIsolatedGitWorktree"));
    }
    const groupId = session?.groupId ?? matchingTask?.groupId;
    const baseCwd =
      session?.baseCwd ||
      (groupId ? this.groups.get(groupId)?.cwd : undefined) ||
      this.baseCwd;
    return { session, baseCwd, worktreePath };
  }

  private async cleanupSessionWorktree(
    sessionKey: string,
    baseCwd: string,
    worktreePath: string,
  ): Promise<void> {
    const existing = this.pool.getSession(sessionKey) ?? this.archivedSessions.get(sessionKey);
    const nextRecord: SessionRecord | undefined = existing
      ? {
          ...existing,
          status: "closed",
          pid: undefined,
          isWorktree: false,
          effectiveCwd: baseCwd,
          branch: undefined,
          updatedAt: Date.now(),
        }
      : undefined;

    if (nextRecord) {
      this.archivedSessions.set(sessionKey, nextRecord);
    }
    if (this.pool.getSession(sessionKey)) {
      await this.pool.closeSession(sessionKey);
    }

    removeSessionWorktree(baseCwd, worktreePath);

    if (nextRecord) {
      this.broadcast({
        type: "session_updated",
        session: { ...nextRecord },
        timestamp: Date.now(),
      });
    }
    for (const task of this.tasks.values()) {
      if (task.targetSessionKey === sessionKey && task.worktreePath) {
        task.worktreePath = undefined;
        task.branch = undefined;
        task.updatedAt = Date.now();
        this.broadcast({
          type: "task_updated",
          task: { ...task },
          timestamp: Date.now(),
        });
      }
    }
    this.stateStore?.schedule();
  }

  getMessages(filter?: { groupId?: string; streamKey?: string }): ChatMessageRecord[] {
    const out: ChatMessageRecord[] = [];
    for (const msg of this.messages.values()) {
      if (filter?.groupId && msg.groupId !== filter.groupId) continue;
      if (filter?.streamKey && msg.streamKey !== filter.streamKey) continue;
      out.push(cloneMessage(msg));
    }
    return out;
  }

  exportGroupMarkdown(groupId: string): { filename: string; markdown: string } {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${groupId}`);
    }

    const title = taskTitle(getLocale(), group);
    const fmtTime = (ts: number) =>
      new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";

    const formatMessagesMarkdown = (msgs: ChatMessageRecord[]): string => {
      const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length === 0) {
        return t("noMessages");
      }
      const chunks: string[] = [];
      for (const m of sorted) {
        if (m.role === "system") {
          chunks.push(t("systemMessage", messageText(getLocale(), m)));
          continue;
        }
        const agentBadge = m.agent ? ` (\`${m.agent}\`)` : "";
        const modelBadge = m.usage?.modelId ? ` · \`${m.usage.modelId}\`` : "";
        chunks.push(`#### ${messageSender(getLocale(), m)}${agentBadge} · ${fmtTime(m.timestamp)}${modelBadge}`);
        if (m.usage && (m.usage.totalTokens > 0 || m.usage.inputTokens > 0)) {
          chunks.push(
            t("tokenUsageLine", m.usage.inputTokens, m.usage.outputTokens, m.usage.totalTokens),
          );
        }
        if (m.thoughtText?.trim()) {
          chunks.push(
            `<details>\n<summary>思考过程</summary>\n\n${m.thoughtText.trim()}\n\n</details>`,
          );
        }
        if (m.toolCalls?.length > 0) {
          const toolLines = m.toolCalls.map(
            (tool) => t("toolCallLine", tool.title, tool.status ? ` (${tool.status})` : ""),
          );
          chunks.push(toolLines.join("\n"));
        }
        if (m.images && m.images.length > 0) {
          chunks.push(
            t("attachedImagesLine", m.images.map((img) => `\`${img.name}\` (${img.mimeType})`).join("、")),
          );
        }
        const bodyText = m.text?.trim()
          ? m.text.trim()
          : m.status === "cancelled"
            ? t("stopped")
            : m.images && m.images.length > 0
              ? ""
              : t("emptyMessage");
        if (bodyText) {
          chunks.push(bodyText);
        }
        if (m.artifactIds && m.artifactIds.length > 0) {
          const artLines = m.artifactIds.map((id) => {
            const art = this.artifacts.get(id);
            return art
              ? t("artifactDetailsLine", art.title, art.kind, art.artifactId)
              : t("artifactLine", id);
          });
          chunks.push(artLines.join("\n"));
        }
      }
      return chunks.join("\n\n") + "\n";
    };

    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push("");
    lines.push(t("taskIdLine", group.groupId));
    lines.push(t("leadAgentLine", group.leadAgent));
    lines.push(t("workingDirectoryLine", group.cwd));
    lines.push(t("groupStatusLine", group.archived ? t("archived2") : t("activeTask")));
    lines.push(t("createdAtLine", fmtTime(group.createdAt)));
    lines.push(t("exportedAtLine", fmtTime(Date.now())));
    lines.push("");

    lines.push(t("leadHistoryHeading"));
    lines.push("");
    const leadMessages = this.getMessages({ groupId, streamKey: `lead:${groupId}` });
    lines.push(formatMessagesMarkdown(leadMessages));

    const groupTasks = [...this.tasks.values()]
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => a.createdAt - b.createdAt);

    lines.push(t("delegationsHeading"));
    lines.push("");
    if (groupTasks.length === 0) {
      lines.push(t("noDelegations"));
      lines.push("");
    } else {
      for (const task of groupTasks) {
        lines.push(`### ${task.callerAgent} → ${task.targetAgent} (\`${task.taskId}\`)`);
        lines.push("");
        lines.push(t("delegationStatusLine", task.status));
        lines.push(t("targetSessionLine", task.targetSessionKey));
        lines.push(t("delegationTimeLine", fmtTime(task.createdAt)));
        if (task.branch) {
          lines.push(t("worktreeBranchLine", task.branch));
        }
        lines.push("");
        lines.push(t("instructionsHeading"));
        lines.push("");
        lines.push(task.prompt);
        lines.push("");
        if (task.outputText?.trim()) {
          lines.push(t("outputHeading"));
          lines.push("");
          lines.push(task.outputText.trim());
          lines.push("");
        }
        if (task.error?.trim()) {
          lines.push(t("errorLine", task.error.trim()));
          lines.push("");
        }
      }
    }

    const subSessionMap = new Map<string, { sessionKey: string; label: string }>();
    for (const s of this.pool.listSessions()) {
      if (s.groupId === groupId && s.role === "sub") {
        subSessionMap.set(`sub:${s.sessionKey}`, {
          sessionKey: s.sessionKey,
          label: `${s.agent} · ${s.label || s.name}`,
        });
      }
    }
    for (const msg of this.messages.values()) {
      if (msg.groupId === groupId && msg.streamKey.startsWith("sub:")) {
        if (!subSessionMap.has(msg.streamKey)) {
          subSessionMap.set(msg.streamKey, {
            sessionKey: msg.sessionKey,
            label: msg.sessionKey,
          });
        }
      }
    }

    lines.push(t("subsessionsHeading"));
    lines.push("");
    if (subSessionMap.size === 0) {
      lines.push(t("noSubsessionMessages"));
      lines.push("");
    } else {
      for (const [streamKey, info] of subSessionMap.entries()) {
        lines.push(t("subsessionHeading", info.label, info.sessionKey));
        lines.push("");
        lines.push(formatMessagesMarkdown(this.getMessages({ groupId, streamKey })));
      }
    }

    const slug =
      title
        .replace(/[\\/:*?"<>|\s]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || group.groupId;
    const filename = `${slug}-${new Date().toISOString().slice(0, 10)}.md`;
    return {
      filename,
      markdown: lines.join("\n"),
    };
  }

  private upsertMessage(msg: ChatMessageRecord): ChatMessageRecord {
    this.messages.set(msg.messageId, msg);
    const cloned = cloneMessage(msg);
    this.broadcast({
      type: "message_upserted",
      message: cloned,
      timestamp: Date.now(),
    });
    return cloned;
  }

  private collectPersistedState(): Omit<PersistedHubState, "version" | "savedAt"> {
    const live = this.pool.listSessions().filter((s) => !s.sessionKey.endsWith(TITLE_SESSION_SUFFIX));
    const liveKeys = new Set(live.map((s) => s.sessionKey));
    return {
      defaultGroupId: this.defaultGroupId,
      groupCounter: this.groupCounter,
      groups: [...this.groups.values()],
      ledgers: [...this.ledgers.entries()].map(([groupId, ledger]) => ({ groupId, ...ledger.exportState() })),
      messages: [...this.messages.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      workflows: this.workflows.list(),
      progress: [...this.progressByGroup.values()],
      contexts: this.taskContext.list(),
      sessions: [...live, ...[...this.archivedSessions.values()].filter((s) => !liveKeys.has(s.sessionKey))],
      telemetry: {
        turnSeq: this.turnSeq,
        totals: this.telemetryTotals,
        byAgent: this.telemetryByAgent,
        recentTurns: this.recentTurns,
      },
    };
  }

  /**
   * Brings back what a previous run saved. Agent processes are gone, so anything that was
   * in flight is closed: streaming replies and running delegations become cancelled, and
   * sessions are kept only as closed records. The ledgers make the next turn hand the
   * history to a fresh lead session.
   */
  private restorePersistedState(): void {
    const state = this.stateStore?.load();
    if (!state || state.groups.length === 0) {
      return;
    }
    const knownAgent = (id: string) => this.registry.isKnownAgent(id);

    this.groups.clear();
    this.ledgers.clear();
    for (const group of state.groups) {
      if (!group?.groupId) continue;
      // An agent removed since the last run cannot lead; fall back instead of breaking the task.
      if (!knownAgent(group.leadAgent)) {
        group.leadAgent = this.getDefaultLead();
      }
      if (group.board?.status === "running") {
        group.board.interrupted = true;
        delete group.board.stalled;
      }
      this.syncGroupLeadModelFields(group);
      this.groups.set(group.groupId, group);
    }
    for (const entry of state.ledgers ?? []) {
      if (this.groups.has(entry.groupId)) {
        this.ledgers.set(entry.groupId, ThreadLedger.fromState(entry));
      }
    }
    for (const groupId of this.groups.keys()) {
      if (!this.ledgers.has(groupId)) this.ledgers.set(groupId, new ThreadLedger());
    }
    this.defaultGroupId = this.groups.has(state.defaultGroupId)
      ? state.defaultGroupId
      : [...this.groups.keys()][0]!;
    this.groupCounter = Math.max(state.groupCounter || 1, this.groups.size);

    for (const msg of state.messages ?? []) {
      if (!this.groups.has(msg.groupId)) continue;
      if (msg.status === "streaming") {
        msg.status = "cancelled";
        msg.completedAt = msg.completedAt ?? Date.now();
      }
      this.messages.set(msg.messageId, msg);
    }
    for (const task of state.tasks ?? []) {
      if (!this.groups.has(task.groupId)) continue;
      if (task.status === "running" || task.status === "queued") {
        task.status = "cancelled";
        task.error = task.error ?? "hub 重启时中断";
        task.completedAt = task.completedAt ?? Date.now();
      }
      this.tasks.set(task.taskId, task);
    }
    for (const artifact of state.artifacts ?? []) {
      if (this.groups.has(artifact.groupId)) this.artifacts.set(artifact.artifactId, artifact);
    }
    this.workflows.restore((state.workflows ?? []).filter((w) => this.groups.has(w.groupId)));
    for (const progress of state.progress ?? []) {
      if (this.groups.has(progress.groupId)) this.progressByGroup.set(progress.groupId, progress);
    }
    this.taskContext.restore((state.contexts ?? []).filter((c) => this.groups.has(c.groupId)));
    for (const session of state.sessions ?? []) {
      if (!this.groups.has(session.groupId)) continue;
      this.archivedSessions.set(session.sessionKey, {
        ...session,
        status: "closed",
        pid: undefined,
        lastError: undefined,
      });
    }
    if (state.telemetry) {
      this.turnSeq = state.telemetry.turnSeq || 0;
      this.telemetryTotals = { ...createEmptyTotals(), ...state.telemetry.totals };
      for (const [agent, totals] of Object.entries(state.telemetry.byAgent ?? {})) {
        this.telemetryByAgent[agent] = { ...createEmptyTotals(), ...totals };
      }
      this.recentTurns = (state.telemetry.recentTurns ?? []).slice(-200);
    }
  }

  /** Live sessions plus the closed ones kept from before a restart. */
  private listVisibleSessions(): SessionRecord[] {
    const live = this.pool.listSessions().filter((s) => !s.sessionKey.endsWith(TITLE_SESSION_SUFFIX));
    const liveKeys = new Set(live.map((s) => s.sessionKey));
    return [...live, ...[...this.archivedSessions.values()].filter((s) => !liveKeys.has(s.sessionKey))];
  }

  private broadcast(event: HubEvent): void {
    if (this.stateStore && !TRANSIENT_EVENT_TYPES.has(event.type)) {
      this.stateStore.schedule();
    }
    // Clients only ever see the models the agent is configured to offer.
    const outgoing =
      event.type === "models_updated"
        ? { ...event, catalog: this.registry.applyConfiguredModels(event.catalog) }
        : event;
    const payload = JSON.stringify(outgoing);
    for (const ws of this.wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  getTelemetrySnapshot(): TelemetrySnapshot {
    const byAgent: Record<string, SessionUsageTotals> = {};
    for (const def of this.registry.listDefinitions()) {
      byAgent[def.id] = { ...(this.telemetryByAgent[def.id] ?? createEmptyTotals()) };
    }
    for (const [id, totals] of Object.entries(this.telemetryByAgent)) {
      if (!byAgent[id]) {
        byAgent[id] = { ...totals };
      }
    }
    return {
      generatedAt: Date.now(),
      totals: { ...this.telemetryTotals },
      byAgent,
      recentTurns: [...this.recentTurns],
    };
  }

  private recordTurnTelemetry(params: {
    groupId: string;
    sessionKey: string;
    role: "lead" | "sub";
    agent: AgentId;
    handoffTokens: number;
    /** Rules + skills index actually sent this turn (non-zero on a session's first turn only). */
    injectedTokens?: number;
    usage: TurnUsage;
  }): void {
    // Adapters report cost as a running total per session; only the increase belongs to this turn.
    let turnCostUsd: number | undefined;
    if (typeof params.usage.costUsd === "number") {
      const prev = this.lastCostBySession.get(params.sessionKey) ?? 0;
      turnCostUsd = Math.max(0, params.usage.costUsd - prev);
      this.lastCostBySession.set(params.sessionKey, params.usage.costUsd);
    }
    const addToTotals = (target: SessionUsageTotals, usage: TurnUsage) => {
      target.turns += 1;
      target.inputTokens += usage.inputTokens;
      target.outputTokens += usage.outputTokens;
      target.cachedReadTokens += usage.cachedReadTokens;
      target.cachedWriteTokens += usage.cachedWriteTokens;
      target.thoughtTokens += usage.thoughtTokens;
      target.totalTokens += usage.totalTokens;
      if (typeof turnCostUsd === "number") {
        target.costUsd += turnCostUsd;
      }
      if (usage.isEstimated) {
        target.estimatedTurns = (target.estimatedTurns ?? 0) + 1;
      }
      if (usage.modelId) {
        target.modelId = usage.modelId;
      }
    };

    addToTotals(this.telemetryTotals, params.usage);
    if (!this.telemetryByAgent[params.agent]) {
      this.telemetryByAgent[params.agent] = createEmptyTotals();
    }
    addToTotals(this.telemetryByAgent[params.agent], params.usage);

    const session = this.pool.getSession(params.sessionKey);
    const group = this.groups.get(params.groupId);
    const turnRecord: TurnTelemetryRecord = {
      turnSeq: ++this.turnSeq,
      timestamp: Date.now(),
      groupId: params.groupId,
      groupTitle: group?.title,
      sessionKey: params.sessionKey,
      role: params.role,
      agent: params.agent,
      // Rules and the skills index go out once per session; later turns carry none.
      injectedRulesTokens:
        (params.injectedTokens ?? 0) > 0 ? (session?.contextBreakdown?.sharedRulesTokens ?? 0) : 0,
      injectedSkillsTokens:
        (params.injectedTokens ?? 0) > 0 ? (session?.contextBreakdown?.skillsIndexTokens ?? 0) : 0,
      handoffTokens: params.handoffTokens,
      usage: { ...params.usage, costUsd: turnCostUsd },
    };
    this.recentTurns.push(turnRecord);
    if (this.recentTurns.length > 200) {
      this.recentTurns.shift();
    }

    this.broadcast({
      type: "telemetry_updated",
      telemetry: this.getTelemetrySnapshot(),
      timestamp: Date.now(),
    });
  }

  listArtifacts(): ArtifactRecord[] {
    return [...this.artifacts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  listPendingQuestions(): PendingUserQuestion[] {
    return [...this.pendingQuestions.values()]
      .map((entry) => entry.info)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  createArtifact(rawInput: unknown): { artifact: ArtifactRecord; previewUrl: string; openedWindow: boolean } {
    const input = ArtifactCreateSchema.parse(rawInput);
    const callerSession = input.sessionKey ? this.pool.getSession(input.sessionKey) : undefined;
    const groupId =
      (input.groupId && this.groups.has(input.groupId) ? input.groupId : callerSession?.groupId) ??
      this.defaultGroupId;
    const agent = input.agent ?? callerSession?.agent ?? this.getLeadAgent(groupId);
    const resolvedSessionKey =
      input.sessionKey ?? callerSession?.sessionKey ?? buildSessionKey(agent, `${groupId}__lead`);
    const now = Date.now();
    const artifactId = `art-${randomUUID().slice(0, 8)}`;
    const artifact: ArtifactRecord = {
      artifactId,
      groupId,
      sessionKey: resolvedSessionKey,
      agent,
      title: input.title,
      kind: input.kind,
      content: input.content,
      height: input.height ?? 320,
      createdAt: now,
    };
    this.artifacts.set(artifactId, artifact);
    if (this.artifacts.size > 120) {
      const oldestKey = this.artifacts.keys().next().value;
      if (oldestKey) this.artifacts.delete(oldestKey);
    }

    const activeMsg = this.activeAssistantBySession.get(resolvedSessionKey);
    if (activeMsg) {
      activeMsg.artifactIds = [...(activeMsg.artifactIds ?? []), artifactId];
      this.upsertMessage(activeMsg);
    } else {
      this.upsertMessage({
        messageId: `msg-${randomUUID().slice(0, 8)}`,
        groupId,
        streamKey: callerSession?.role === "sub" ? `sub:${resolvedSessionKey}` : `lead:${groupId}`,
        sessionKey: resolvedSessionKey,
        role: "assistant",
        senderLabel: agent,
        agent,
        text: `生成交互组件：**${artifact.title}**`,
        thoughtText: "",
        toolCalls: [],
        artifactIds: [artifactId],
        status: "done",
        timestamp: now,
        completedAt: now,
      });
    }

    this.broadcast({ type: "artifact_created", artifact, timestamp: now });

    const previewUrl = `${this.url}/artifacts/${encodeURIComponent(artifactId)}`;
    let openedWindow = false;
    if (input.openWindow && this.url) {
      try {
        openInteractiveWindow(previewUrl, true);
        openedWindow = true;
      } catch {
        openedWindow = false;
      }
    }

    return { artifact, previewUrl, openedWindow };
  }

  async askUserQuestion(
    rawInput: unknown,
  ): Promise<{ questionId: string; cancelled: boolean; answers: Record<string, unknown> }> {
    const input = QuestionAskSchema.parse(rawInput);
    const callerSession = input.sessionKey ? this.pool.getSession(input.sessionKey) : undefined;
    const groupId =
      (input.groupId && this.groups.has(input.groupId) ? input.groupId : callerSession?.groupId) ??
      this.defaultGroupId;
    const agent = input.agent ?? callerSession?.agent ?? this.getLeadAgent(groupId);
    const resolvedSessionKey =
      input.sessionKey ?? callerSession?.sessionKey ?? buildSessionKey(agent, `${groupId}__lead`);
    const now = Date.now();
    const questionId = `q-${randomUUID().slice(0, 8)}`;
    const fields: QuestionField[] = input.questions.map((q, index) => ({
      id: q.id?.trim() || `q${index + 1}`,
      question: q.question,
      type: q.type,
      options: q.options && q.options.length > 0 ? q.options : undefined,
      placeholder: q.placeholder,
    }));

    const info: PendingUserQuestion = {
      questionId,
      groupId,
      sessionKey: resolvedSessionKey,
      agent,
      title: input.title?.trim() || t("questionForAgent", agent),
      fields,
      createdAt: now,
    };

    return await new Promise<{ questionId: string; cancelled: boolean; answers: Record<string, unknown> }>(
      (resolve) => {
        const timeoutMs = (input.timeoutSeconds ?? 300) * 1000;
        const timer = setTimeout(() => {
          const entry = this.pendingQuestions.get(questionId);
          if (!entry) return;
          this.pendingQuestions.delete(questionId);
          this.broadcast({
            type: "question_resolved",
            questionId,
            cancelled: true,
            answers: {},
            timestamp: Date.now(),
          });
          this.refreshBoardIfRelevant(groupId);
          entry.resolve({ cancelled: true, answers: {} });
        }, timeoutMs);

        this.pendingQuestions.set(questionId, {
          info,
          timer,
          resolve: (res) => resolve({ questionId, ...res }),
        });

        this.broadcast({
          type: "question_requested",
          question: info,
          timestamp: now,
        });
        this.refreshBoardIfRelevant(groupId);

        // A sub-session that stops to ask is blocked work the lead should know about; it may
        // well hold the answer. The user sees the question either way.
        if (callerSession?.role === "sub") {
          const who = `${this.agentLabel(agent)} · ${callerSession.label || callerSession.name}`;
          this.notifyLead(groupId, {
            questionId,
            summary: t("noticeSubSessionAsks", who),
            detail: [
              `Sub-session "${who}" is blocked waiting for an answer (question id ${questionId}): ${info.title}`,
              ...fields.map(
                (f) => `- [${f.id}] ${f.question}${f.options?.length ? ` Options: ${f.options.map((o) => (typeof o === "string" ? o : (o as { label?: string }).label ?? "")).join(" | ")}` : ""}`,
              ),
              "If the task's goal, decisions so far or shared context already answer it, answer with `peer_answer_question`. If only the user can decide, leave it: it is on their screen. Do not guess.",
            ].join("\n"),
          });
        }
      },
    );
  }

  resolveUserQuestion(rawInput: unknown): { resolved: boolean; questionId: string } {
    const input = QuestionResolveSchema.parse(rawInput);
    const entry = this.pendingQuestions.get(input.questionId);
    if (!entry) {
      throw new Error(`Unknown or expired question: ${input.questionId}`);
    }
    const groupId = entry.info.groupId;
    clearTimeout(entry.timer);
    this.pendingQuestions.delete(input.questionId);
    const answers = input.cancelled ? {} : input.answers;
    this.broadcast({
      type: "question_resolved",
      questionId: input.questionId,
      cancelled: input.cancelled,
      answers,
      timestamp: Date.now(),
    });
    this.refreshBoardIfRelevant(groupId);
    entry.resolve({ cancelled: input.cancelled, answers });
    return { resolved: true, questionId: input.questionId };
  }

  private broadcastAgentsUpdated(): void {
    const now = Date.now();
    this.broadcast({
      type: "agents_updated",
      agents: this.registry.getHealthList(true),
      defaultLead: this.getDefaultLead(),
      configuredDefaultLead: this.registry.getDefaultLead(),
      timestamp: now,
    });
    this.broadcast({
      type: "resources_updated",
      budgets: this.resources.getAgentBudgets(this.baseCwd),
      timestamp: now,
    });
  }

  private createSnapshot(): HubEvent {
    const ledger: ReturnType<ThreadLedger["getAllTurns"]> = [];
    for (const [groupId, groupLedger] of this.ledgers.entries()) {
      for (const turn of groupLedger.getAllTurns()) {
        ledger.push({ ...turn, groupId });
      }
    }
    ledger.sort((a, b) => a.timestamp - b.timestamp);

    return {
      type: "snapshot",
      settings: this.getSettings(),
      workflows: this.workflows.list(),
      progress: [...this.progressByGroup.values()],
      contexts: this.taskContext.list(),
      projects: this.listProjects(),
      defaultGroupId: this.defaultGroupId,
      defaultLead: this.getDefaultLead(),
      configuredDefaultLead: this.registry.getDefaultLead(),
      leadAgent: this.getLeadAgent(this.defaultGroupId),
      permissionMode: this.pool.getPermissionMode(),
      baseCwd: this.baseCwd,
      taskGroups: this.listGroups(),
      sessions: this.listVisibleSessions(),
      tasks: [...this.tasks.values()],
      pendingPermissions: this.pool.getPendingPermissions(),
      pendingQuestions: this.listPendingQuestions(),
      memory: this.memory.get(),
      ledger,
      messages: this.getMessages(),
      artifacts: this.listArtifacts(),
      telemetry: this.getTelemetrySnapshot(),
      resourceBudgets: this.resources.getAgentBudgets(this.baseCwd),
      agents: this.registry.getHealthList(true),
      modelCatalogs: this.registry.getAllModelCatalogs(),
      desktopMode: this.desktopMode,
      port: this.port,
    };
  }

  /**
   * Switches active workspace directory for default hub operations and target task group.
   */
  setWorkspaceCwd(rawCwd: string, groupId?: string): { baseCwd: string; group: TaskGroup } {
    const resolved = path.resolve(rawCwd.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Directory not found: ${resolved}`);
    }
    this._baseCwd = resolved;
    const targetGroupId =
      groupId && this.groups.has(groupId) ? groupId : this.defaultGroupId;
    const group = this.groups.get(targetGroupId)!;
    const now = Date.now();
    // Pre-warmed lead sessions were started in the old directory; drop the unused ones so the
    // first message starts in the new cwd instead of silently reusing the stale session.
    const discardStaleWarm = (g: TaskGroup): void => {
      if (g.cwd !== resolved) {
        void this.pool.discardWarmSession(buildSessionKey(g.leadAgent, `${g.groupId}__lead`));
      }
    };
    discardStaleWarm(group);
    group.cwd = resolved;
    group.updatedAt = now;

    if (targetGroupId !== this.defaultGroupId) {
      const defGroup = this.groups.get(this.defaultGroupId);
      if (defGroup) {
        discardStaleWarm(defGroup);
        defGroup.cwd = resolved;
        defGroup.updatedAt = now;
      }
    }

    if (this.writeRuntimeFile && this.url) {
      try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        const runtimeInfo: RuntimeFileInfo = {
          url: this.url,
          port: this.port,
          pid: process.pid,
          baseCwd: this.baseCwd,
          startedAt: Date.now(),
        };
        fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtimeInfo, null, 2), "utf8");
      } catch {
        // non-fatal
      }
    }

    const budgets = this.resources.getAgentBudgets(this.baseCwd);
    this.broadcast({
      type: "workspace_changed",
      baseCwd: this.baseCwd,
      group: { ...group },
      timestamp: now,
    });
    this.broadcast({
      type: "group_updated",
      group: { ...group },
      timestamp: now,
    });
    this.broadcast({
      type: "resources_updated",
      budgets,
      timestamp: now,
    });

    return { baseCwd: this.baseCwd, group: { ...group } };
  }

  private notifyTaskWaiters(taskId: string): void {
    const waiters = this.taskWaiters.get(taskId);
    if (!waiters) {
      return;
    }
    this.taskWaiters.delete(taskId);
    for (const wake of waiters) {
      wake();
    }
  }

  /**
   * A dispatched task's turn was cut short. If the user did it to redirect the session, the
   * task is kept running for the turn that follows; otherwise it ends as cancelled.
   */
  private settleInterruptedTask(task: TaskRecord): void {
    const key = task.targetSessionKey;
    const steeredAt = this.steerPending.get(key);
    if (steeredAt && Date.now() - steeredAt < STEER_FOLLOW_UP_MS) {
      this.steeredTasks.set(key, task);
      const timer = setTimeout(() => {
        // The guidance never came: this was a stop after all.
        if (this.steeredTasks.get(key) === task && !this.activeAssistantBySession.has(key)) {
          this.steeredTasks.delete(key);
          this.steerPending.delete(key);
          task.status = "cancelled";
          task.completedAt = Date.now();
          this.updateTask(task);
        }
      }, STEER_FOLLOW_UP_MS);
      timer.unref();
      return;
    }
    this.steeredTasks.delete(key);
    task.status = "cancelled";
    task.completedAt = Date.now();
    this.updateTask(task);
  }

  /** The turn that carried the user's guidance ended: that is the end of the steered task. */
  private finishSteeredTask(task: TaskRecord, outcome: { stopReason: string; outputText: string; error?: string }): void {
    if (outcome.stopReason === "cancelled") {
      this.settleInterruptedTask(task);
      return;
    }
    this.steeredTasks.delete(task.targetSessionKey);
    task.status = outcome.error ? "failed" : "completed";
    task.error = outcome.error;
    task.outputText = outcome.outputText;
    task.completedAt = Date.now();
    this.updateTask(task);
  }

  /**
   * Queues something for a task's lead and delivers it as soon as the lead is free. The lead
   * gets one turn for everything that piled up, decides what to do, and tells the user.
   */
  private notifyLead(groupId: string, notice: LeadNotice): void {
    const list = this.leadInbox.get(groupId) ?? [];
    list.push(notice);
    this.leadInbox.set(groupId, list);
    setImmediate(() => this.flushLeadInbox(groupId));
  }

  private flushLeadInbox(groupId: string): void {
    const queued = this.leadInbox.get(groupId);
    if (!queued || queued.length === 0) return;
    const group = this.groups.get(groupId);
    if (!group || group.archived || (group.board && (group.board.status !== "running" || group.board.interrupted))) {
      this.leadInbox.delete(groupId);
      return;
    }
    const leadKey = buildSessionKey(group.leadAgent, `${groupId}__lead`);
    const live = this.pool.getSession(leadKey);
    if (this.activeAssistantBySession.has(leadKey) || live?.status === "busy" || live?.status === "starting") {
      return; // delivered when that turn ends
    }
    // Drop what the lead dealt with meanwhile: a result it fetched, a question already answered.
    const fresh = queued.filter(
      (n) => !(n.taskId && this.selfServedTaskIds.has(n.taskId)) && !(n.questionId && !this.pendingQuestions.has(n.questionId)),
    );
    if (fresh.length === 0) {
      this.leadInbox.delete(groupId);
      return;
    }
    const turns = (this.autoLeadTurns.get(groupId) ?? 0) + 1;
    if (turns > MAX_AUTO_LEAD_TURNS) {
      // Keep them for the user's next message instead of letting agents drive each other forever.
      if (turns === MAX_AUTO_LEAD_TURNS + 1) {
        this.autoLeadTurns.set(groupId, turns);
        if (group.board?.status === "running" && !group.board.stalled) {
          group.board.stalled = true;
          this.boardChanged(group);
        }
        const now = Date.now();
        this.upsertMessage({
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          groupId,
          streamKey: `lead:${groupId}`,
          sessionKey: leadKey,
          role: "system",
          senderLabel: "系统",
          text: t("leadAutoTurnsPaused", MAX_AUTO_LEAD_TURNS),
          thoughtText: "",
          toolCalls: [],
          status: "done",
          timestamp: now,
          completedAt: now,
        });
      }
      const nonNudge = fresh.filter((n) => !n.boardNudge);
      if (nonNudge.length > 0) {
        this.leadInbox.set(groupId, nonNudge);
      } else {
        this.leadInbox.delete(groupId);
      }
      return;
    }
    this.autoLeadTurns.set(groupId, turns);
    this.leadInbox.delete(groupId);
    const detail = [
      "<workbench_update>",
      "These things happened in this task while you were not running. Nobody typed this message.",
      "",
      ...fresh.map((n, i) => `${i + 1}. ${n.detail}`),
      "</workbench_update>",
      "",
      "Act on them yourself: decide the next step (follow-up work, an answer for a waiting sub-session, a change to the workflow), keep the Progress panel current, then tell the user in a few lines what happened and what you did or decided. If nothing needs doing, say so in one line. A failure is not a completed task: do not report it as done.",
    ].join("\n");
    void this.runLeadChat({
      groupId,
      notice: { summary: fresh.map((n) => n.summary).join("\n"), detail },
    }).catch(() => {});
  }

  /** A sub-session task the lead dispatched and walked away from has ended: tell the lead. */
  private reportTaskToLead(task: TaskRecord): void {
    if (task.status === "cancelled" || task.callerAgent === "user") return;
    if (this.workflowTaskIds.has(task.taskId) || this.selfServedTaskIds.has(task.taskId)) return;
    const group = this.groups.get(task.groupId);
    if (!group || group.archived || (group.board && (group.board.status !== "running" || group.board.interrupted))) {
      return;
    }
    if (task.callerSession !== buildSessionKey(group.leadAgent, `${group.groupId}__lead`)) return;
    const session = this.pool.getSession(task.targetSessionKey) ?? this.archivedSessions.get(task.targetSessionKey);
    const name = `${this.agentLabel(task.targetAgent)} · ${session?.label || session?.name || task.targetSessionKey}`;
    const body =
      task.status === "failed"
        ? `<error>\n${clipMiddle(task.error ?? "unknown error", 1500)}\n</error>`
        : `<result>\n${clipMiddle(task.outputText || "(empty reply)", 3000)}\n</result>`;
    this.notifyLead(task.groupId, {
      taskId: task.taskId,
      summary: t(task.status === "failed" ? "noticeSubSessionFailed" : "noticeSubSessionFinished", name),
      detail: `Sub-session "${name}" ${task.status === "failed" ? "FAILED" : "finished"} the task you dispatched (task id ${task.taskId}).\n${body}`,
    });
  }

  /** A workflow run ended: the lead sums up, or decides what to do about a failure. */
  private reportWorkflowToLead(workflow: WorkflowRecord): void {
    const group = this.groups.get(workflow.groupId);
    if (!group || group.archived || (group.board && (group.board.status !== "running" || group.board.interrupted))) {
      return;
    }
    const failed = workflow.steps.filter((s) => s.status === "failed");
    const held = workflow.steps.filter((s) => s.status === "skipped" || s.status === "cancelled" || s.status === "pending");
    const done = workflow.steps.filter((s) => s.status === "completed");
    if (workflow.status === "completed") {
      this.notifyLead(workflow.groupId, {
        summary: t("noticeWorkflowFinished", done.length),
        detail: `The workflow finished: all ${done.length} steps completed. Their results are in the shared task context (sections "result:<step id>"; read them with context_get). Check that the results actually meet the goal, then sum up for the user and say what, if anything, is left.`,
      });
      return;
    }
    if (failed.length === 0) return; // stopped or interrupted, not failed: nothing to decide
    this.notifyLead(workflow.groupId, {
      summary: t("noticeWorkflowFailed", failed.map((s) => s.name).join("、")),
      detail: [
        `The workflow stopped: ${failed.length} step(s) failed, ${held.length} step(s) after them did not run, ${done.length} completed.`,
        ...failed.map(
          (s) => `- FAILED "${s.name}" (id ${s.id}, ${s.agent}): ${clipMiddle(s.error ?? "no reason given", 600)}${s.reviewNotes ? `\n  Reviewer said: ${clipMiddle(s.reviewNotes, 800)}` : ""}`,
        ),
        ...(held.length > 0 ? [`- Not run: ${held.map((s) => s.id).join(", ")}`] : []),
        "The task is NOT done. You decide how to go on:",
        "- `workflow_continue` with `guidance` for the failed step(s): they are tried again with your guidance and the steps held back then run;",
        "- `workflow_continue` with `skip` for a step that is no longer needed: the steps after it go on without its result;",
        "- `workflow_propose` to replace the plan when the approach itself is wrong;",
        "- `hub_ask_user` when only the user can decide.",
        "Then tell the user what failed, why, and what you decided.",
      ].join("\n"),
    });
  }

  private updateTask(task: TaskRecord): void {
    task.updatedAt = Date.now();
    this.tasks.set(task.taskId, { ...task });
    this.broadcast({
      type: "task_updated",
      task: { ...task },
      timestamp: task.updatedAt,
    });
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      this.notifyTaskWaiters(task.taskId);
      this.workflows.onTaskUpdated(task);
      this.reportTaskToLead(task);
    }
  }

  private persistUploadedImages(
    rawImages?: Array<{ name?: string; mimeType: string; data: string }>,
  ): Array<{
    attachment: ChatImageAttachment;
    name: string;
    mimeType: string;
    data: string;
    localPath: string;
  }> {
    if (!rawImages || rawImages.length === 0) {
      return [];
    }
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    return rawImages.map((raw, index) => {
      const normalizedMime = raw.mimeType.trim().toLowerCase() === "image/jpg"
        ? "image/jpeg"
        : raw.mimeType.trim().toLowerCase();
      const ext = ALLOWED_IMAGE_MIMES[normalizedMime];
      if (!ext) {
        throw new Error(`Unsupported image mimeType: ${raw.mimeType}`);
      }
      const cleanBase64 = raw.data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
      const buf = Buffer.from(cleanBase64, "base64");
      if (buf.byteLength === 0 || buf.byteLength > MAX_SINGLE_IMAGE_BYTES) {
        throw new Error(`Image "${raw.name || `#${index + 1}`}" exceeds 10MB or is empty.`);
      }
      const id = `img-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const fileName = `${id}.${ext}`;
      const localPath = path.join(UPLOADS_DIR, fileName);
      fs.writeFileSync(localPath, buf);
      const displayName = raw.name?.trim() || `${id}.${ext}`;
      return {
        attachment: {
          id,
          name: displayName,
          mimeType: normalizedMime,
          url: `/uploads/${fileName}`,
          sizeBytes: buf.byteLength,
        },
        name: displayName,
        mimeType: normalizedMime,
        data: buf.toString("base64"),
        localPath,
      };
    });
  }

  /**
   * Saves attached non-image files under uploads/files and returns what the message record
   * and the prompt need. The agent gets local paths, not the bytes.
   */
  private persistUploadedFiles(
    rawFiles?: Array<{ name: string; mimeType?: string; data: string }>,
  ): ChatFileAttachment[] {
    if (!rawFiles || rawFiles.length === 0) {
      return [];
    }
    const dir = path.join(UPLOADS_DIR, "files");
    fs.mkdirSync(dir, { recursive: true });
    return rawFiles.map((raw) => {
      const buf = Buffer.from(raw.data.replace(/^data:[^;]*;base64,/, "").replace(/\s+/g, ""), "base64");
      if (buf.byteLength === 0 || buf.byteLength > MAX_SINGLE_FILE_BYTES) {
        throw new Error(t("fileIsEmptyOrExceedsMb", raw.name, Math.round(MAX_SINGLE_FILE_BYTES / (1024 * 1024))));
      }
      // Keep the original name readable for the agent, minus anything path-like.
      const safeName = path.basename(raw.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "file";
      const id = `file-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const localPath = path.join(dir, `${id}-${safeName}`);
      fs.writeFileSync(localPath, buf);
      return { id, name: raw.name, sizeBytes: buf.byteLength, localPath };
    });
  }

  private async handleElicitationRequest(params: {
    sessionKey: string;
    groupId: string;
    agent: AgentId;
    request: acp.CreateElicitationRequest;
  }): Promise<acp.CreateElicitationResponse> {
    const req = params.request as {
      mode?: string;
      message?: string;
      url?: string;
      requestedSchema?: {
        title?: string;
        properties?: Record<string, Record<string, unknown>>;
      };
    };

    if (req.mode !== "form") {
      const fallbackQuestion = req.url
        ? `${req.message || t("agentNeedsConfirmation")} (${req.url})`
        : req.message || t("agentNeedsInput");
      const res = await this.askUserQuestion({
        agent: params.agent,
        sessionKey: params.sessionKey,
        groupId: params.groupId,
        title: t("agentConfirmation", params.agent),
        questions: [{ id: "response", question: fallbackQuestion, type: "text" }],
      });
      if (res.cancelled) {
        return { action: "cancel" };
      }
      return {
        action: "accept",
        content: { response: String(res.answers.response ?? "") },
      };
    }

    const propEntries = Object.entries(req.requestedSchema?.properties ?? {});
    const extractEnumOptions = (prop: Record<string, unknown>): string[] => {
      if (Array.isArray(prop.enum)) {
        return prop.enum.map((v) => String(v));
      }
      if (Array.isArray(prop.oneOf)) {
        return prop.oneOf
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const rec = item as Record<string, unknown>;
            return String(rec.const ?? rec.title ?? "");
          })
          .filter(Boolean);
      }
      const items = prop.items as Record<string, unknown> | undefined;
      if (items && Array.isArray(items.enum)) {
        return items.enum.map((v) => String(v));
      }
      if (items && Array.isArray(items.anyOf)) {
        return items.anyOf
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const rec = item as Record<string, unknown>;
            return String(rec.const ?? rec.title ?? "");
          })
          .filter(Boolean);
      }
      return [];
    };

    const fields: Array<{
      id: string;
      question: string;
      type: "single" | "multi" | "text";
      options?: string[];
      placeholder?: string;
    }> = [];

    for (const [key, prop] of propEntries) {
      const propType = typeof prop.type === "string" ? prop.type : "string";
      const label =
        (typeof prop.description === "string" && prop.description.trim()) ||
        (typeof prop.title === "string" && prop.title.trim()) ||
        key;
      const options = extractEnumOptions(prop);
      if (propType === "array") {
        fields.push({ id: key, question: label, type: "multi", options });
      } else if (propType === "boolean") {
        fields.push({ id: key, question: label, type: "single", options: ["true", "false"] });
      } else if (options.length > 0) {
        fields.push({ id: key, question: label, type: "single", options });
      } else {
        fields.push({
          id: key,
          question: label,
          type: "text",
          placeholder: prop.default != null ? String(prop.default) : undefined,
        });
      }
    }

    if (fields.length === 0) {
      fields.push({
        id: "response",
        question: req.message?.trim() || t("provideDetails"),
        type: "text",
      });
    }

    const res = await this.askUserQuestion({
      agent: params.agent,
      sessionKey: params.sessionKey,
      groupId: params.groupId,
      title: req.requestedSchema?.title?.trim() || req.message?.trim() || t("agentInput", params.agent),
      questions: fields,
    });
    if (res.cancelled) {
      return { action: "cancel" };
    }

    const content: Record<string, acp.ElicitationContentValue> = {};
    for (const field of fields) {
      const val = res.answers[field.id];
      const schemaProp = req.requestedSchema?.properties?.[field.id];
      const propType = typeof schemaProp?.type === "string" ? schemaProp.type : "string";
      if (propType === "boolean") {
        content[field.id] = val === true || val === "true";
      } else if (propType === "number" || propType === "integer") {
        const parsed = Number(val);
        content[field.id] = Number.isFinite(parsed) ? parsed : 0;
      } else if (propType === "array") {
        content[field.id] = Array.isArray(val)
          ? val.map((v) => String(v))
          : val !== undefined && val !== ""
            ? [String(val)]
            : [];
      } else {
        content[field.id] = Array.isArray(val) ? val.map(String).join(", ") : String(val ?? "");
      }
    }

    return { action: "accept", content };
  }

  /**
   * Single source of the lead session's creation options, shared by chat turns and pre-warming.
   * A warmed session is only reused if both paths resolve the same session key and options.
   */
  private buildLeadSessionOptions(
    group: TaskGroup,
    overrides?: { cwd?: string; session?: string; model?: string; effort?: string },
  ): WarmSessionOptions {
    const lead = group.leadAgent;
    const def = this.registry.getDefinition(lead);
    return {
      agent: lead,
      sessionName: overrides?.session ?? `${group.groupId}__lead`,
      baseCwd: overrides?.cwd ?? group.cwd,
      injectSharedResources: true,
      isolateWorktree: false,
      callDepth: 0,
      injectPeerMcp: true,
      groupId: group.groupId,
      role: "lead",
      label: t("leadSession"),
      model: overrides?.model?.trim() || group.agentModels?.[lead] || def?.defaultModel,
      effort: overrides?.effort?.trim() || group.agentEfforts?.[lead] || def?.defaultEffort,
    };
  }

  /**
   * Starts the group's lead session before the first message. Returns without waiting for startup.
   */
  warmLeadSession(groupId: string): { ok: true; sessionKey?: string; skipped?: string } {
    const group = this.groups.get(groupId);
    if (!group) {
      return { ok: true, skipped: "unknown_group" };
    }
    if (group.archived) {
      return { ok: true, skipped: "group_archived" };
    }
    if (!this.registry.isEnabledAgent(group.leadAgent)) {
      return { ok: true, skipped: "agent_disabled" };
    }
    try {
      this.registry.resolveCommand(group.leadAgent);
    } catch {
      return { ok: true, skipped: "agent_unavailable" };
    }
    const warm = this.pool.warmSession(this.buildLeadSessionOptions(group));
    return { ok: true, sessionKey: warm.sessionKey, skipped: warm.skipped };
  }

  private deleteMessage(msgId: string): void {
    const existing = this.messages.get(msgId);
    if (!existing) return;
    this.messages.delete(msgId);
    this.broadcast({
      type: "message_deleted",
      groupId: existing.groupId,
      streamKey: existing.streamKey,
      messageId: existing.messageId,
      timestamp: Date.now(),
    });
  }

  private resolveTurnInputForChat(
    streamKey: string,
    input: {
      prompt?: string;
      images?: Array<{ name?: string; mimeType: string; data: string }>;
      files?: Array<{ name: string; mimeType?: string; data: string }>;
      steer?: boolean;
      handoff?: { from: AgentId; brief: string };
      notice?: { summary: string; detail: string };
      reuseMessageId?: string;
      replaceAssistantMessageId?: string;
    },
  ): {
    reusedUserMessage: boolean;
    savedImages: Array<{
      attachment: ChatImageAttachment;
      name: string;
      mimeType: string;
      data: string;
      localPath: string;
    }>;
    savedFiles: ChatFileAttachment[];
    displayUserText: string;
    effectiveUserPrompt: string;
    promptForAgent: string;
  } {
    const reuseMsg = input.reuseMessageId?.trim()
      ? this.messages.get(input.reuseMessageId.trim())
      : undefined;
    const validReuse =
      reuseMsg &&
      reuseMsg.streamKey === streamKey &&
      (reuseMsg.role === "user" || reuseMsg.role === "caller")
        ? reuseMsg
        : undefined;

    let savedImages = this.persistUploadedImages(input.images);
    if (savedImages.length === 0 && validReuse?.images?.length) {
      savedImages = [];
      for (const att of validReuse.images) {
        try {
          const fileName = path.basename(decodeURIComponent(att.url.replace(/^\/uploads\//, "")));
          const localPath = path.join(UPLOADS_DIR, fileName);
          if (!fs.existsSync(localPath)) continue;
          const data = fs.readFileSync(localPath).toString("base64");
          savedImages.push({
            attachment: { ...att },
            name: att.name,
            mimeType: att.mimeType,
            data,
            localPath,
          });
        } catch {
          // Ignore missing historical image on disk during retry
        }
      }
    }

    let savedFiles = this.persistUploadedFiles(input.files);
    if (savedFiles.length === 0 && validReuse?.files?.length) {
      savedFiles = validReuse.files.map((f) => ({ ...f }));
    }

    if (input.replaceAssistantMessageId?.trim()) {
      const oldAssistant = this.messages.get(input.replaceAssistantMessageId.trim());
      if (oldAssistant && oldAssistant.streamKey === streamKey && oldAssistant.role === "assistant") {
        this.deleteMessage(oldAssistant.messageId);
      }
    }

    const displayUserText =
      (input.notice?.summary ?? input.handoff?.brief ?? input.prompt ?? "").trim() || (validReuse?.text ?? "").trim();
    const effectiveUserPrompt =
      displayUserText ||
      (savedFiles.length > 0 ? "请查看附带的文件。" : savedImages.length > 0 ? "请查看并分析附带的图片。" : "");
    if (!effectiveUserPrompt) {
      throw new Error(t("messageRequired"));
    }
    const promptForAgent = input.notice
      ? input.notice.detail
      : input.handoff
      ? buildHandoffPrompt(this.agentLabel(input.handoff.from), effectiveUserPrompt)
      : `${input.steer ? STEER_PREFIX : ""}${effectiveUserPrompt}${buildAttachedFilesBlock(savedFiles)}`;

    return {
      reusedUserMessage: Boolean(validReuse),
      savedImages,
      savedFiles,
      displayUserText,
      effectiveUserPrompt,
      promptForAgent,
    };
  }

  private markAssistantError(assistantMsg: ChatMessageRecord, errMsg: string): void {
    const errorTag = `[Error] ${errMsg}`;
    assistantMsg.status = "error";
    const prefix = assistantMsg.text ? `\n\n${errorTag}` : errorTag;
    assistantMsg.text = assistantMsg.text ? `${assistantMsg.text}${prefix}` : errorTag;
    if (assistantMsg.parts && assistantMsg.parts.length > 0) {
      const last = assistantMsg.parts[assistantMsg.parts.length - 1];
      if (last && last.type === "text") {
        last.text += prefix;
      } else {
        assistantMsg.parts.push({ type: "text", text: errorTag });
      }
    }
    assistantMsg.completedAt = Date.now();
    this.upsertMessage(assistantMsg);
  }

  async runLeadChat(input: {
    groupId?: string;
    prompt?: string;
    images?: Array<{ name?: string; mimeType: string; data: string }>;
    files?: Array<{ name: string; mimeType?: string; data: string }>;
    /** The user interrupted the running turn to redirect it; the agent is told so. */
    steer?: boolean;
    /** The previous lead passed the role on; `brief` is what it wrote for its successor. */
    handoff?: { from: AgentId; brief: string };
    /** A turn the hub starts to tell the lead what happened; `summary` is what the user sees. */
    notice?: { summary: string; detail: string };
    reuseMessageId?: string;
    replaceAssistantMessageId?: string;
    leadAgent?: AgentId;
    cwd?: string;
    session?: string;
    model?: string;
    effort?: string;
  }): Promise<{
    groupId: string;
    leadAgent: AgentId;
    sessionKey: string;
    outputText: string;
    stopReason: string;
    peerToolsCalled: string[];
  }> {
    const targetGroupId =
      input.groupId && this.groups.has(input.groupId) ? input.groupId : this.defaultGroupId;
    const group = this.groups.get(targetGroupId)!;
    const boardAtTurnStart = group.board;

    if (input.leadAgent) {
      this.setGroupLeadAgent(group.groupId, input.leadAgent);
    }
    if (group.archived) {
      throw new Error(t("thisTaskIsArchivedRestoreItBefore"));
    }

    // Escape hatch for a lead that cannot hand over by itself (it will not start, or is stuck):
    // "/lead <agent>" typed in the lead conversation switches the lead directly. No agent turn
    // runs; the new lead gets the history summary with the user's next message.
    if (!input.notice && !input.handoff) {
      // The user is driving again: hub-started turns may resume.
      this.autoLeadTurns.delete(group.groupId);
    }
    const forced = /^\/lead\s+(\S+)\s*$/i.exec((input.prompt ?? "").trim());
    if (forced && !input.handoff) {
      const previous = group.leadAgent;
      const enabled = this.registry.listEnabledDefinitions();
      const wanted = forced[1]!.toLowerCase();
      const target =
        enabled.find((d) => d.id === wanted) ?? enabled.find((d) => (d.label || "").toLowerCase() === wanted);
      if (!target) {
        throw new Error(
          t("noEnabledAgentNamedAvailableAgents", forced[1], enabled
            .filter((d) => d.id !== previous)
            .map((d) => d.id)
            .join("、")),
        );
      }
      if (target.id === previous) {
        throw new Error(t("alreadyLeadsThisTask", this.agentLabel(previous)));
      }
      this.pendingHandoffs.delete(group.groupId);
      void this.pool.cancelSession(buildSessionKey(previous, `${group.groupId}__lead`)).catch(() => false);
      this.setGroupLeadAgent(group.groupId, target.id);
      return {
        groupId: group.groupId,
        leadAgent: target.id,
        sessionKey: buildSessionKey(target.id, `${group.groupId}__lead`),
        outputText: "",
        stopReason: "end_turn",
        peerToolsCalled: [],
      };
    }

    const lead = group.leadAgent;
    const sessionName = input.session ?? `${group.groupId}__lead`;
    const sessionKey = buildSessionKey(lead, sessionName);
    const streamKey = `lead:${group.groupId}`;

    const prepared = this.resolveTurnInputForChat(streamKey, input);
    const { savedImages, savedFiles, displayUserText, effectiveUserPrompt, promptForAgent } = prepared;

    if (!input.notice && !input.handoff && group.board && (group.board.stalled || group.board.interrupted)) {
      delete group.board.stalled;
      delete group.board.interrupted;
      this.boardChanged(group);
    }

    const ledger = this.getOrCreateLedger(group.groupId);
    let promptDerivedTitle: string | undefined;
    const isDefaultTitle = typeof group.defaultTitleNumber === "number" ||
      (group.defaultTitleNumber === undefined && /^(任务\s*\d+|新任务|默认任务)$/.test(group.title));
    if (isDefaultTitle && ledger.getAllTurns().length === 0) {
      group.title = autoTitleFromPrompt(
        displayUserText || (savedImages[0]?.name ? t("imageTitle", savedImages[0].name) : t("imageAnalysis")),
      );
      group.defaultTitleNumber = null;
      promptDerivedTitle = group.title;
      group.updatedAt = Date.now();
      this.broadcast({
        type: "group_updated",
        group: { ...group },
        timestamp: group.updatedAt,
      });
    }

    // A lead session that died or was closed starts blank; hand it the history again.
    const existingLead = this.pool.getSession(sessionKey);
    if (!existingLead || existingLead.status === "closed" || existingLead.status === "error") {
      if (ledger.getAllTurns().length > 0) {
        ledger.forgetAgent(lead);
      }
    }
    // A fresh lead session learns about the task's other directories from its first prompt
    // (adapters that support it also get them as additionalDirectories in session/new).
    const startsFresh = !existingLead || existingLead.status === "closed" || existingLead.status === "error";
    const extraDirsNote =
      startsFresh && (group.extraDirs?.length ?? 0) > 0
        ? `\n\n<additional_directories>\nBesides the working directory, this task also covers these directories. Read and edit files there as needed:\n${group.extraDirs!.map((d) => `- ${d}`).join("\n")}\n</additional_directories>`
        : "";
    // On a handoff the previous lead's own brief replaces the mechanical history. It only counts
    // as delivered once this turn succeeds (recordTurn); a failed takeover gets the history later.
    const leadPromptMeta = input.handoff
      ? {
          prompt: `${promptForAgent}${extraDirsNote}`,
          handoffTokens: estimateTokens(promptForAgent),
          missedTurnsCount: 0,
        }
      : ledger.buildLeadPromptWithMeta(lead, `${promptForAgent}${extraDirsNote}`);

    if (!prepared.reusedUserMessage) {
      const now = Date.now();
      this.upsertMessage({
        messageId: `msg-${randomUUID().slice(0, 8)}`,
        groupId: group.groupId,
        streamKey,
        sessionKey,
        role: input.notice ? "system" : input.handoff ? "caller" : "user",
        senderLabel: input.notice ? "系统" : input.handoff ? `${this.agentLabel(input.handoff.from)} 交接` : "你",
        agent: input.handoff?.from,
        text: displayUserText,
        thoughtText: "",
        toolCalls: [],
        status: "done",
        timestamp: now,
        completedAt: now,
        images: savedImages.length > 0 ? savedImages.map((s) => s.attachment) : undefined,
        files: savedFiles.length > 0 ? savedFiles : undefined,
      });
    }

    const assistantMsg: ChatMessageRecord = {
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: group.groupId,
      streamKey,
      sessionKey,
      role: "assistant",
      senderLabel: lead,
      agent: lead,
      text: "",
      thoughtText: "",
      toolCalls: [],
      parts: [],
      status: "streaming",
      timestamp: Date.now(),
    };
    this.activeAssistantBySession.set(sessionKey, assistantMsg);
    this.upsertMessage(assistantMsg);

    let endedNormally = false;
    let handedOff = false;

    try {
      const result = await this.pool.runTurn({
        ...this.buildLeadSessionOptions(group, input),
        prompt: leadPromptMeta.prompt,
        images: savedImages.map(({ name, mimeType, data, localPath }) => ({
          name,
          mimeType,
          data,
          localPath,
        })),
        rawUserPrompt: effectiveUserPrompt,
        handoffTokens: leadPromptMeta.handoffTokens,
      });

      assistantMsg.status = result.stopReason === "cancelled" ? "cancelled" : "done";
      if (!assistantMsg.text && result.outputText) {
        assistantMsg.text = result.outputText;
        if (assistantMsg.parts && assistantMsg.parts.length === 0) {
          assistantMsg.parts.push({ type: "text", text: result.outputText });
        }
      }
      assistantMsg.usage = result.usage;
      assistantMsg.injectedTokens = result.injectedTokens;
      assistantMsg.completedAt = Date.now();
      this.upsertMessage(assistantMsg);

      this.recordTurnTelemetry({
        groupId: group.groupId,
        sessionKey: result.sessionKey,
        role: "lead",
        agent: lead,
        handoffTokens: leadPromptMeta.handoffTokens,
        injectedTokens: result.injectedTokens,
        usage: result.usage,
      });

      const turn = ledger.recordTurn({
        leadAgent: lead,
        userText: input.notice
          ? `[Workbench update] ${effectiveUserPrompt}`
          : input.handoff
            ? `[Handoff brief from ${input.handoff.from}] ${effectiveUserPrompt}`
            : effectiveUserPrompt,
        assistantSummary: result.outputText,
        peerCallsSummary: result.peerToolsCalled,
      });
      turn.groupId = group.groupId;
      this.broadcast({ type: "ledger_turn", turn: { ...turn }, timestamp: Date.now() });
      endedNormally = result.stopReason !== "cancelled";
      handedOff = endedNormally && this.pendingHandoffs.has(group.groupId);
      this.completePendingHandoff(group, lead, endedNormally);

      if (promptDerivedTitle && this.settings.autoTitle && result.stopReason !== "cancelled") {
        void this.generateTaskTitle(group, promptDerivedTitle, effectiveUserPrompt, result.outputText);
      }

      return {
        groupId: group.groupId,
        leadAgent: lead,
        sessionKey: result.sessionKey,
        outputText: result.outputText,
        stopReason: result.stopReason,
        peerToolsCalled: result.peerToolsCalled,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.completePendingHandoff(group, lead, false);
      if (errMsg.includes("SESSION_CANCELLED_BY_USER")) {
        assistantMsg.status = "cancelled";
        assistantMsg.completedAt = Date.now();
        this.upsertMessage(assistantMsg);
        return {
          groupId: group.groupId,
          leadAgent: lead,
          sessionKey,
          outputText: assistantMsg.text,
          stopReason: "cancelled",
          peerToolsCalled: [],
        };
      }
      this.markAssistantError(assistantMsg, errMsg);
      throw err;
    } finally {
      if (this.activeAssistantBySession.get(sessionKey)?.messageId === assistantMsg.messageId) {
        this.activeAssistantBySession.delete(sessionKey);
      }
      if (
        group.board &&
        group.board === boardAtTurnStart &&
        (group.board.status === "delivered" || group.board.status === "failed")
      ) {
        this.releaseBoardSessions(group.groupId);
      } else if (endedNormally && !handedOff && group.board === boardAtTurnStart) {
        this.checkBoardStall(group.groupId);
      }
      setImmediate(() => this.flushLeadInbox(group.groupId));
    }
  }

  async runSubSessionChat(input: {
    sessionKey: string;
    prompt?: string;
    images?: Array<{ name?: string; mimeType: string; data: string }>;
    files?: Array<{ name: string; mimeType?: string; data: string }>;
    steer?: boolean;
    reuseMessageId?: string;
    replaceAssistantMessageId?: string;
    model?: string;
    effort?: string;
  }): Promise<{
    sessionKey: string;
    groupId: string;
    outputText: string;
    stopReason: string;
  }> {
    const session = this.pool.getSession(input.sessionKey) ?? this.archivedSessions.get(input.sessionKey);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionKey}`);
    }
    if (this.groups.get(session.groupId)?.archived) {
      throw new Error(t("thisTaskIsArchivedRestoreItBefore"));
    }

    // Guidance after an interruption continues the dispatched task that was interrupted.
    const steeredTask = input.steer ? this.steeredTasks.get(session.sessionKey) : undefined;
    this.steerPending.delete(session.sessionKey);

    const streamKey = `sub:${session.sessionKey}`;
    // Built before this turn's messages are stored, so it holds only what came earlier.
    const recap = this.buildSubSessionRecap(session.sessionKey);
    const prepared = this.resolveTurnInputForChat(streamKey, input);
    const { savedImages, savedFiles, displayUserText, effectiveUserPrompt } = prepared;
    const promptForAgent = `${recap}${prepared.promptForAgent}`;

    if (!prepared.reusedUserMessage) {
      const now = Date.now();
      this.upsertMessage({
        messageId: `msg-${randomUUID().slice(0, 8)}`,
        groupId: session.groupId,
        streamKey,
        sessionKey: session.sessionKey,
        role: "user",
        senderLabel: "你",
        text: displayUserText,
        thoughtText: "",
        toolCalls: [],
        status: "done",
        timestamp: now,
        completedAt: now,
        images: savedImages.length > 0 ? savedImages.map((s) => s.attachment) : undefined,
        files: savedFiles.length > 0 ? savedFiles : undefined,
      });
    }

    const assistantMsg: ChatMessageRecord = {
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: session.groupId,
      streamKey,
      sessionKey: session.sessionKey,
      role: "assistant",
      senderLabel: session.agent,
      agent: session.agent,
      text: "",
      thoughtText: "",
      toolCalls: [],
      parts: [],
      status: "streaming",
      timestamp: Date.now(),
    };
    this.activeAssistantBySession.set(session.sessionKey, assistantMsg);
    this.upsertMessage(assistantMsg);

    try {
      const result = await this.pool.runTurn({
        agent: session.agent,
        sessionName: session.name,
        baseCwd: session.baseCwd,
        prompt: promptForAgent,
        images: savedImages.map(({ name, mimeType, data, localPath }) => ({
          name,
          mimeType,
          data,
          localPath,
        })),
        rawUserPrompt: effectiveUserPrompt,
        handoffTokens: recap ? estimateTokens(recap) : 0,
        injectSharedResources: true,
        isolateWorktree: session.isWorktree,
        callDepth: 1,
        injectPeerMcp: true,
        groupId: session.groupId,
        role: session.role,
        label: session.label,
        parentSessionKey: session.parentSessionKey,
        model: input.model,
        effort: input.effort,
      });

      assistantMsg.status = result.stopReason === "cancelled" ? "cancelled" : "done";
      if (!assistantMsg.text && result.outputText) {
        assistantMsg.text = result.outputText;
        if (assistantMsg.parts && assistantMsg.parts.length === 0) {
          assistantMsg.parts.push({ type: "text", text: result.outputText });
        }
      }
      assistantMsg.usage = result.usage;
      assistantMsg.injectedTokens = result.injectedTokens;
      assistantMsg.completedAt = Date.now();
      this.upsertMessage(assistantMsg);

      this.recordTurnTelemetry({
        groupId: session.groupId,
        sessionKey: result.sessionKey,
        role: session.role,
        agent: session.agent,
        handoffTokens: recap ? estimateTokens(recap) : 0,
        injectedTokens: result.injectedTokens,
        usage: result.usage,
      });

      if (steeredTask) this.finishSteeredTask(steeredTask, { stopReason: result.stopReason, outputText: result.outputText });
      return {
        sessionKey: result.sessionKey,
        groupId: session.groupId,
        outputText: result.outputText,
        stopReason: result.stopReason,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("SESSION_CANCELLED_BY_USER")) {
        assistantMsg.status = "cancelled";
        assistantMsg.completedAt = Date.now();
        this.upsertMessage(assistantMsg);
        if (steeredTask) this.finishSteeredTask(steeredTask, { stopReason: "cancelled", outputText: assistantMsg.text });
        return {
          sessionKey: session.sessionKey,
          groupId: session.groupId,
          outputText: assistantMsg.text,
          stopReason: "cancelled",
        };
      }
      this.markAssistantError(assistantMsg, errMsg);
      if (steeredTask) this.finishSteeredTask(steeredTask, { stopReason: "error", outputText: assistantMsg.text, error: errMsg });
      throw err;
    } finally {
      if (this.activeAssistantBySession.get(session.sessionKey)?.messageId === assistantMsg.messageId) {
        this.activeAssistantBySession.delete(session.sessionKey);
      }
    }
  }

  private resolvePeerTarget(body: z.infer<typeof PeerCallBodySchema>): {
    groupId: string;
    rawLabel: string;
    targetSessionName: string;
    targetSessionKey: string;
    parentSessionKey?: string;
  } {
    body.targetAgent = this.requireKnownAgent(body.targetAgent);
    if (body.depth >= MAX_PEER_DEPTH) {
      throw new Error(
        `Peer delegation depth limit (${MAX_PEER_DEPTH}) reached. Summarize your current findings instead of nesting further calls.`,
      );
    }

    const callerSessionRecord = this.pool.getSession(body.callerSession);
    const explicitOrCallerGroupId = body.groupId || callerSessionRecord?.groupId;
    const groupId =
      explicitOrCallerGroupId && this.groups.has(explicitOrCallerGroupId)
        ? explicitOrCallerGroupId
        : this.defaultGroupId;
    const rawLabel = (body.session ?? `peer-${body.targetAgent}`).replace(/^.*__sub__/, "");

    const targetSessionName = explicitOrCallerGroupId
      ? `${groupId}__sub__${rawLabel}`
      : body.session ?? `${groupId}__sub__${rawLabel}`;
    const targetSessionKey = buildSessionKey(body.targetAgent, targetSessionName);

    if (body.callerAgent === body.targetAgent && body.callerSession === targetSessionKey) {
      throw new Error(`Agent "${body.callerAgent}" cannot call itself on the same session (${targetSessionKey}).`);
    }

    return {
      groupId,
      rawLabel,
      targetSessionName,
      targetSessionKey,
      parentSessionKey: callerSessionRecord?.sessionKey,
    };
  }

  dispatchPeerTask(rawBody: unknown, want?: { sections?: string[]; results?: string[] }): TaskRecord {
    const body = PeerCallBodySchema.parse(rawBody);
    const target = this.resolvePeerTarget(body);
    // Every delegated session starts from the task's shared context: the common section,
    // whatever this call asked for, and an index of the rest.
    const contextPrefix =
      this.buildSubSessionRecap(target.targetSessionKey) + this.taskContext.buildPrefix(target.groupId, want);
    const group = this.groups.get(target.groupId)!;
    const taskId = `task-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const task: TaskRecord = {
      taskId,
      groupId: target.groupId,
      callerAgent: body.callerAgent,
      callerSession: body.callerSession,
      targetAgent: body.targetAgent,
      targetSessionKey: target.targetSessionKey,
      prompt: body.prompt,
      status: "running",
      isolateWorktree: body.isolateWorktree,
      outputText: "",
      createdAt: now,
      updatedAt: now,
    };
    this.updateTask(task);

    const streamKey = `sub:${target.targetSessionKey}`;
    this.upsertMessage({
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: target.groupId,
      streamKey,
      sessionKey: target.targetSessionKey,
      role: "caller",
      senderLabel: body.callerAgent === "user" ? "你" : `${body.callerAgent} 委派`,
      agent: body.callerAgent === "user" ? undefined : body.callerAgent,
      text: body.prompt,
      thoughtText: "",
      toolCalls: [],
      status: "done",
      timestamp: now,
      completedAt: now,
    });

    const assistantMsg: ChatMessageRecord = {
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: target.groupId,
      streamKey,
      sessionKey: target.targetSessionKey,
      role: "assistant",
      senderLabel: body.targetAgent,
      agent: body.targetAgent,
      text: "",
      thoughtText: "",
      toolCalls: [],
      status: "streaming",
      timestamp: Date.now(),
    };
    this.activeAssistantBySession.set(target.targetSessionKey, assistantMsg);
    this.upsertMessage(assistantMsg);

    void this.pool
      .runTurn({
        agent: body.targetAgent,
        sessionName: target.targetSessionName,
        baseCwd: body.cwd ?? group.cwd,
        prompt: `${contextPrefix}${body.prompt}`,
        rawUserPrompt: body.prompt,
        handoffTokens: contextPrefix ? estimateTokens(contextPrefix) : 0,
        injectSharedResources: true,
        isolateWorktree: body.isolateWorktree,
        callDepth: body.depth + 1,
        injectPeerMcp: body.depth + 1 < MAX_PEER_DEPTH,
        groupId: target.groupId,
        role: "sub",
        label: target.rawLabel,
        parentSessionKey: target.parentSessionKey,
        model: body.model,
        effort: body.effort,
      })
      .then((res) => {
        task.outputText = res.outputText;
        task.worktreePath = res.isWorktree ? res.effectiveCwd : undefined;
        task.branch = res.branch;
        task.workspaceSummary = summarizeWorkspaceChanges(res.effectiveCwd);
        if (res.stopReason === "cancelled") {
          this.settleInterruptedTask(task);
        } else {
          task.status = "completed";
          task.completedAt = Date.now();
          this.updateTask(task);
        }

        assistantMsg.status = res.stopReason === "cancelled" ? "cancelled" : "done";
        if (!assistantMsg.text && res.outputText) {
          assistantMsg.text = res.outputText;
        }
        assistantMsg.usage = res.usage;
        assistantMsg.injectedTokens = res.injectedTokens;
        assistantMsg.completedAt = Date.now();
        this.upsertMessage(assistantMsg);

        this.recordTurnTelemetry({
          groupId: target.groupId,
          sessionKey: res.sessionKey,
          role: "sub",
          agent: body.targetAgent,
          handoffTokens: 0,
          injectedTokens: res.injectedTokens,
          usage: res.usage,
        });
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("SESSION_CANCELLED_BY_USER")) {
          this.settleInterruptedTask(task);

          assistantMsg.status = "cancelled";
          assistantMsg.completedAt = Date.now();
          this.upsertMessage(assistantMsg);
          return;
        }
        task.status = "failed";
        task.error = errMsg;
        task.completedAt = Date.now();
        this.updateTask(task);

        assistantMsg.status = "error";
        assistantMsg.text = assistantMsg.text
          ? `${assistantMsg.text}\n\n[Error] ${errMsg}`
          : `[Error] ${errMsg}`;
        assistantMsg.completedAt = Date.now();
        this.upsertMessage(assistantMsg);
      })
      .finally(() => {
        if (this.activeAssistantBySession.get(target.targetSessionKey)?.messageId === assistantMsg.messageId) {
          this.activeAssistantBySession.delete(target.targetSessionKey);
        }
      });

    return { ...task };
  }

  async waitForTask(taskId: string, waitSeconds: number): Promise<TaskRecord | undefined> {
    const current = this.tasks.get(taskId);
    if (!current) {
      return undefined;
    }
    if (
      waitSeconds <= 0 ||
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return { ...current };
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitSeconds * 1000);
      timer.unref();
      const waiters = this.taskWaiters.get(taskId) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.taskWaiters.set(taskId, waiters);
    });

    const latest = this.tasks.get(taskId);
    return latest ? { ...latest } : undefined;
  }

  async askPeer(rawBody: unknown): Promise<TaskRecord> {
    const task = this.dispatchPeerTask(rawBody);
    // The caller is waiting right here; it needs no separate report.
    this.selfServedTaskIds.add(task.taskId);
    const done = await this.waitForTask(task.taskId, 300);
    if (!done) {
      throw new Error(`Task ${task.taskId} disappeared`);
    }
    if (done.status === "failed") {
      throw new Error(done.error ?? "Peer task failed");
    }
    return done;
  }

  private getUiAssetPath(fileName: string): string {
    const srcPath = path.join(PROJECT_ROOT, "src", "ui", fileName);
    if (fs.existsSync(srcPath)) {
      return srcPath;
    }
    return path.join(PROJECT_ROOT, "dist", "ui", fileName);
  }

  /**
   * The hub can start processes, so its API must only answer its own UI and local tools.
   * - Host must be this machine's loopback name: a page that points its own domain at
   *   127.0.0.1 (DNS rebinding) is refused.
   * - A request that changes anything must not come from another web origin: browsers attach
   *   Origin to cross-site POSTs, so a page the user happens to visit cannot drive the hub.
   *   Local tools (the MCP bridge, curl, scripts) send no Origin and are allowed.
   */
  /** Changes whenever any icon file is replaced; used as a cache-busting query value. */
  private getIconVersion(): string {
    let newest = 0;
    for (const name of Object.keys(UI_ICON_FILES)) {
      try {
        newest = Math.max(newest, Math.floor(fs.statSync(this.getUiAssetPath(name)).mtimeMs));
      } catch {
        // a missing icon simply does not contribute
      }
    }
    return newest.toString(36);
  }

  private isRequestAllowed(req: IncomingMessage, method: string): boolean {
    const allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      return false;
    }
    const origin = req.headers.origin;
    if (method !== "GET" && method !== "HEAD" && origin !== undefined) {
      const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
      if (!allowedOrigins.has(String(origin).toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", this.url || "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (!this.isRequestAllowed(req, method)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Request origin not allowed" }));
      return;
    }

    try {
      if (method === "GET" && pathname === "/") {
        // Icon URLs carry a version taken from the files, so a replaced icon is fetched again
        // instead of being served from the browser's (and the app window profile's) cache.
        const html = fs
          .readFileSync(this.getUiAssetPath("index.html"), "utf8")
          .replace(/(\/ui\/icon[\w.-]*\.(?:png|ico))(?=")/g, `$1?v=${this.getIconVersion()}`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname.startsWith("/artifacts/")) {
        const artifactId = decodeURIComponent(pathname.slice("/artifacts/".length));
        const artifact = this.artifacts.get(artifactId);
        if (!artifact) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Artifact not found: ${artifactId}`);
          return;
        }
        const theme = reqUrl.searchParams.get("theme") || undefined;
        const skin = reqUrl.searchParams.get("skin") || undefined;
        const locale = matchLocale(reqUrl.searchParams.get("lang") ?? undefined) ?? getLocale();
        const html = withLocale(locale, () => buildArtifactHtmlDocument(artifact, { theme, skin }));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "sandbox allow-scripts",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && /^\/ui\/([a-z0-9_-]+\.(js|css))$/i.test(pathname)) {
        const fileName = pathname.slice("/ui/".length);
        const assetPath = this.getUiAssetPath(fileName);
        if (!fs.existsSync(assetPath)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Not found: ${pathname}`);
          return;
        }
        const isCss = fileName.toLowerCase().endsWith(".css");
        const content = fs.readFileSync(assetPath, "utf8");
        res.writeHead(200, {
          "Content-Type": `${isCss ? "text/css" : "application/javascript"}; charset=utf-8`,
          "Cache-Control": "no-store",
        });
        res.end(content);
        return;
      }

      if (method === "GET" && pathname.startsWith("/uploads/")) {
        const fileName = decodeURIComponent(pathname.slice("/uploads/".length));
        const match = /^img-[a-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/i.exec(fileName);
        if (!match) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Image not found");
          return;
        }
        const filePath = path.join(UPLOADS_DIR, fileName);
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Image not found");
          return;
        }
        const ext = match[1].toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const buf = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=86400, immutable",
        });
        res.end(buf);
        return;
      }

      if (method === "GET" && pathname === "/ui/vendor/mermaid.min.js") {
        const file = path.join(PROJECT_ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js");
        if (!fs.existsSync(file)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("mermaid is not installed");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(fs.readFileSync(file));
        return;
      }

      if (method === "GET" && pathname.startsWith("/ui/icon")) {
        const fileName = pathname.slice("/ui/".length);
        if (fileName === "icon.svg") {
          // Kept for older references: an SVG wrapper around the raster icon.
          const png = fs.readFileSync(this.getUiAssetPath("icon-192.png")).toString("base64");
          res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
          res.end(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,${png}"/></svg>`,
          );
          return;
        }
        const mime = UI_ICON_FILES[fileName];
        if (!mime) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        // Versioned URLs make long caching safe; an unversioned request must revalidate.
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": reqUrl.searchParams.has("v") ? "public, max-age=604800" : "no-cache",
        });
        res.end(fs.readFileSync(this.getUiAssetPath(fileName)));
        return;
      }

      if (method === "GET" && pathname === "/manifest.webmanifest") {
        const manifest = {
          name: "RTM",
          short_name: "RTM",
          description: "Round Table Meeting: a multi-agent collaborative workbench on ACP",
          start_url: "/",
          display: "standalone",
          background_color: "#f7f8f9",
          theme_color: "#f7f8f9",
          icons: [
            { src: `/ui/icon-192.png?v=${this.getIconVersion()}`, sizes: "192x192", type: "image/png" },
            { src: `/ui/icon-512.png?v=${this.getIconVersion()}`, sizes: "512x512", type: "image/png" },
          ],
        };
        res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(manifest, null, 2));
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        const groupId = reqUrl.searchParams.get("groupId") || undefined;
        sendJson(res, 200, {
          ok: true,
          url: this.url,
          port: this.port,
          desktopMode: this.desktopMode,
          memory: this.memory.get(),
          baseCwd: this.baseCwd,
          defaultGroupId: this.defaultGroupId,
          leadAgent: this.getLeadAgent(groupId),
          taskGroups: this.listGroups(),
          permissionMode: this.pool.getPermissionMode(),
          adapters: this.registry.getHealthList(false),
          allAgents: this.registry.getHealthList(true),
          sessions: this.pool.listSessions(),
          agents: this.registry.listEnabledIds(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/ports/check") {
        const portParam = Number(reqUrl.searchParams.get("port"));
        const check = await checkPortAvailable(portParam);
        sendJson(res, 200, { ok: true, port: portParam, ...check });
        return;
      }

      if (method === "GET" && pathname === "/api/ports/suggest") {
        const preferredParam = Number(reqUrl.searchParams.get("preferred") || "4317");
        const suggested = await findAvailablePort(preferredParam);
        sendJson(res, 200, { ok: true, port: suggested });
        return;
      }

      if (method === "POST" && pathname === "/api/workspace/pick-directory") {
        const body = WorkspacePickSchema.parse(await readJsonBody(req));
        const result = await pickNativeDirectory(body.initialDir || this.baseCwd);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/workspace/cwd") {
        const body = WorkspaceCwdSchema.parse(await readJsonBody(req));
        const result = this.setWorkspaceCwd(body.cwd, body.groupId);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/system/shutdown") {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => {
          if (this.onAutoExit) {
            this.onAutoExit();
          } else {
            void this.stop().finally(() => process.exit(0));
          }
        }, 120);
        return;
      }

      if (method === "GET" && pathname === "/api/board") {
        sendJson(res, 200, {
          ok: true,
          cards: this.listBoardCards(),
          parallel: clampBoardParallel(this.settings.boardParallel),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/board/publish") {
        const body = PublishBoardBodySchema.parse(await readJsonBody(req));
        const groups = this.publishBoardTasks(body);
        sendJson(res, 200, { ok: true, groups });
        return;
      }

      if (method === "POST" && pathname === "/api/board/report") {
        const body = ReportBoardBodySchema.parse(await readJsonBody(req));
        const board = this.reportBoardTask(body);
        sendJson(res, 200, { ok: true, board });
        return;
      }

      if (method === "POST" && pathname === "/api/board/action") {
        const body = BoardActionBodySchema.parse(await readJsonBody(req));
        const group = await this.actOnBoardTask(body);
        sendJson(res, 200, { ok: true, group });
        return;
      }

      if (method === "GET" && pathname === "/api/groups") {
        sendJson(res, 200, {
          ok: true,
          defaultGroupId: this.defaultGroupId,
          groups: this.listGroups(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/groups/export") {
        const gid = reqUrl.searchParams.get("groupId")?.trim() || this.defaultGroupId;
        const exported = this.exportGroupMarkdown(gid);
        if (reqUrl.searchParams.get("format") === "json") {
          sendJson(res, 200, { ok: true, groupId: gid, ...exported });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Language": getLocale(),
          Vary: "Accept-Language",
          "Content-Disposition": `attachment; filename="rtm-export.md"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
          "Cache-Control": "no-store",
        });
        res.end(exported.markdown, "utf8");
        return;
      }

      if (method === "POST" && pathname === "/api/groups") {
        const body = CreateGroupBodySchema.parse(await readJsonBody(req));
        const group = this.createGroup(body);
        sendJson(res, 200, { ok: true, group });
        return;
      }

      if (method === "POST" && pathname === "/api/groups/update") {
        const body = UpdateGroupBodySchema.parse(await readJsonBody(req));
        const group = this.updateGroup(body);
        sendJson(res, 200, { ok: true, group });
        return;
      }

      if (method === "POST" && pathname === "/api/groups/model") {
        const body = GroupModelBodySchema.parse(await readJsonBody(req));
        const gid = body.groupId || this.defaultGroupId;
        const result = await this.setGroupModel(gid, {
          agent: body.agent,
          model: body.model,
          effort: body.effort,
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/groups/delete") {
        const body = DeleteGroupBodySchema.parse(await readJsonBody(req));
        await this.deleteGroup(body.groupId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/lead") {
        const body = LeadBodySchema.parse(await readJsonBody(req));
        const group = this.setGroupLeadAgent(body.groupId ?? this.defaultGroupId, body.agent);
        sendJson(res, 200, { ok: true, groupId: group.groupId, leadAgent: group.leadAgent });
        return;
      }

      if (method === "POST" && pathname === "/api/lead/handoff") {
        const body = LeadHandoffSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, ...this.requestLeadHandoff(body) });
        return;
      }

      if (method === "POST" && pathname === "/api/chat") {
        const body = ChatBodySchema.parse(await readJsonBody(req));
        const result = await this.runLeadChat(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/sessions/chat") {
        const body = SessionChatBodySchema.parse(await readJsonBody(req));
        const result = await this.runSubSessionChat(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/sessions/warm") {
        const body = WarmSessionBodySchema.parse(await readJsonBody(req));
        sendJson(res, 200, this.warmLeadSession(body.groupId));
        return;
      }

      if (method === "POST" && pathname === "/api/sessions/model") {
        const body = SessionModelBodySchema.parse(await readJsonBody(req));
        const session = await this.pool.setSessionModel(body.sessionKey, body.model, body.effort);
        sendJson(res, 200, { ok: true, session });
        return;
      }

      if (method === "POST" && pathname === "/api/peer/ask") {
        const body = await readJsonBody(req);
        const result = await this.askPeer(body);
        sendJson(res, 200, { ok: true, task: result });
        return;
      }

      if (method === "POST" && pathname === "/api/peer/dispatch") {
        const body = await readJsonBody(req);
        const task = this.dispatchPeerTask(body);
        sendJson(res, 202, { ok: true, task });
        return;
      }

      if (method === "GET" && pathname === "/api/peer/status") {
        const taskId = reqUrl.searchParams.get("taskId");
        const sessionKey = reqUrl.searchParams.get("sessionKey");
        const waitSeconds = Math.min(
          60,
          Math.max(0, Number(reqUrl.searchParams.get("waitSeconds") ?? "0") || 0),
        );

        if (taskId) {
          const task = await this.waitForTask(taskId, waitSeconds);
          if (!task) {
            sendJson(res, 404, { ok: false, error: `Unknown taskId: ${taskId}` });
            return;
          }
          if (task.status === "completed" || task.status === "failed") {
            // The caller has the result now; do not report it a second time.
            this.selfServedTaskIds.add(task.taskId);
          }
          sendJson(res, 200, {
            ok: true,
            task,
            session: this.pool.getSession(task.targetSessionKey),
          });
          return;
        }

        if (sessionKey) {
          const session = this.pool.getSession(sessionKey);
          const relatedTasks = [...this.tasks.values()].filter(
            (t) => t.targetSessionKey === sessionKey,
          );
          sendJson(res, 200, { ok: true, session, tasks: relatedTasks });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          sessions: this.pool.listSessions(),
          tasks: [...this.tasks.values()],
        });
        return;
      }

      if (method === "POST" && pathname === "/api/peer/cancel") {
        const body = CancelBodySchema.parse(await readJsonBody(req));
        if (body.steer) this.steerPending.set(body.sessionKey, Date.now());
        const cancelled = await this.pool.cancelSession(body.sessionKey);
        sendJson(res, 200, { ok: true, cancelled });
        return;
      }

      if (method === "POST" && pathname === "/api/permissions/resolve") {
        const body = PermissionResolveSchema.parse(await readJsonBody(req));
        const resolved = this.pool.resolvePermission(body.requestId, body.optionId);
        sendJson(res, resolved ? 200 : 404, { ok: resolved });
        return;
      }

      if (method === "POST" && pathname === "/api/permissions/mode") {
        const body = PermissionModeBodySchema.parse(await readJsonBody(req));
        this.pool.setPermissionMode(body.mode);
        sendJson(res, 200, { ok: true, permissionMode: this.pool.getPermissionMode() });
        return;
      }

      if (method === "GET" && pathname === "/api/resources") {
        const cwd = this.resolveResourceCwd(
          reqUrl.searchParams.get("cwd") || undefined,
          reqUrl.searchParams.get("groupId") || undefined,
        );
        sendJson(res, 200, {
          ok: true,
          cwd,
          resources: this.resources.discover(cwd),
          budgets: this.resources.getAgentBudgets(cwd),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/resources/content") {
        const id = reqUrl.searchParams.get("id") || undefined;
        const skillName = reqUrl.searchParams.get("skill") || undefined;
        const cwd = this.resolveResourceCwd(
          reqUrl.searchParams.get("cwd") || undefined,
          reqUrl.searchParams.get("groupId") || undefined,
        );
        const result = this.resources.readResourceContent({ id, skillName, cwd });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/toggle") {
        const body = ResourceToggleSchema.parse(await readJsonBody(req));
        const cwd = this.resolveResourceCwd(body.cwd, body.groupId);
        this.resources.setResourceEnabled(body.id, body.enabled, cwd, body.agent?.trim().toLowerCase() || undefined);
        const resources = this.resources.discover(cwd);
        const budgets = this.resources.getAgentBudgets(cwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, cwd, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/rules") {
        const body = ResourceSaveRuleSchema.parse(await readJsonBody(req));
        const cwd = this.resolveResourceCwd(body.cwd, body.groupId);
        const item = this.resources.saveHubRule({ ...body, cwd });
        const resources = this.resources.discover(cwd);
        const budgets = this.resources.getAgentBudgets(cwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, cwd, item, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/rules/delete") {
        const body = ResourceDeleteRuleSchema.parse(await readJsonBody(req));
        const cwd = this.resolveResourceCwd(body.cwd, body.groupId);
        const deleted = this.resources.deleteHubRule(body.id, cwd);
        const resources = this.resources.discover(cwd);
        const budgets = this.resources.getAgentBudgets(cwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, cwd, deleted, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/sync-project") {
        const body = ResourceSyncSchema.parse(await readJsonBody(req));
        const cwd = this.resolveResourceCwd(body.cwd, body.groupId);
        const updatedFiles = this.resources.syncProjectRuleFiles(cwd);
        const budgets = this.resources.getAgentBudgets(cwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, cwd, updatedFiles });
        return;
      }

      if (method === "GET" && pathname === "/api/workspace/files") {
        const cwd = this.resolveResourceCwd(
          reqUrl.searchParams.get("cwd") || undefined,
          reqUrl.searchParams.get("groupId") || undefined,
        );
        const q = reqUrl.searchParams.get("q") || "";
        const files = this.listWorkspaceFiles(cwd, q);
        sendJson(res, 200, { ok: true, cwd, files });
        return;
      }

      if (method === "GET" && pathname === "/api/worktrees/diff") {
        const sessionKey = reqUrl.searchParams.get("sessionKey")?.trim();
        if (!sessionKey) {
          throw new Error(t("missingSessionkeyParameter"));
        }
        const resolved = this.resolveSessionWorktreeTarget(sessionKey);
        const inspection = inspectWorktreeChanges(resolved.baseCwd, resolved.worktreePath);
        sendJson(res, 200, {
          ok: true,
          sessionKey,
          worktreePath: resolved.worktreePath,
          baseCwd: resolved.baseCwd,
          ...inspection,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/worktrees/merge") {
        const body = WorktreeMergeBodySchema.parse(await readJsonBody(req));
        const resolved = this.resolveSessionWorktreeTarget(body.sessionKey);
        if (resolved.session?.status === "busy" || resolved.session?.status === "starting") {
          throw new Error(t("thisSubsessionIsRunningStopItOr"));
        }
        const mergeResult = mergeSessionWorktree(resolved.baseCwd, resolved.worktreePath);
        let cleaned = false;
        if (body.cleanup) {
          await this.cleanupSessionWorktree(body.sessionKey, resolved.baseCwd, resolved.worktreePath);
          cleaned = true;
        }
        sendJson(res, 200, { ok: true, cleaned, ...mergeResult });
        return;
      }

      if (method === "POST" && pathname === "/api/worktrees/discard") {
        const body = WorktreeDiscardBodySchema.parse(await readJsonBody(req));
        const resolved = this.resolveSessionWorktreeTarget(body.sessionKey);
        if (resolved.session?.status === "busy" || resolved.session?.status === "starting") {
          throw new Error(t("stopThisSubsessionBeforeDiscardingItsWorktree"));
        }
        await this.cleanupSessionWorktree(body.sessionKey, resolved.baseCwd, resolved.worktreePath);
        sendJson(res, 200, { ok: true, discarded: true });
        return;
      }

      if (method === "GET" && pathname === "/api/telemetry") {
        sendJson(res, 200, {
          ok: true,
          telemetry: this.getTelemetrySnapshot(),
          sessions: this.pool.listSessions(),
          budgets: this.resources.getAgentBudgets(this.baseCwd),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/artifacts") {
        sendJson(res, 200, {
          ok: true,
          artifacts: this.listArtifacts(),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/artifacts") {
        const result = this.createArtifact(await readJsonBody(req));
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "GET" && pathname === "/api/questions") {
        sendJson(res, 200, {
          ok: true,
          questions: this.listPendingQuestions(),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/questions/ask") {
        const result = await this.askUserQuestion(await readJsonBody(req));
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/questions/resolve") {
        const result = this.resolveUserQuestion(await readJsonBody(req));
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "GET" && pathname === "/api/models") {
        const agentParam = reqUrl.searchParams.get("agent")?.trim();
        const refresh =
          reqUrl.searchParams.get("refresh") === "1" ||
          reqUrl.searchParams.get("refresh") === "true";
        if (agentParam) {
          const validAgent = this.requireKnownAgent(agentParam);
          const catalog = await this.registry.discoverModels(validAgent, this.baseCwd, refresh);
          this.broadcast({
            type: "models_updated",
            agent: validAgent,
            catalog,
            timestamp: Date.now(),
          });
          sendJson(res, 200, {
            ok: true,
            agent: validAgent,
            catalog: this.registry.applyConfiguredModels(catalog),
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          modelCatalogs: this.registry.getAllModelCatalogs(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/agents") {
        sendJson(res, 200, {
          ok: true,
          agents: this.registry.getHealthList(true),
          definitions: this.registry.listDefinitions(),
          defaultLead: this.getDefaultLead(),
          configuredDefaultLead: this.registry.getDefaultLead(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/context") {
        const groupId = this.resolveGroupId(reqUrl.searchParams.get("groupId"));
        const key = reqUrl.searchParams.get("key");
        if (key) {
          const section = this.taskContext.getSection(groupId, key);
          if (!section) {
            const known = this.taskContext.get(groupId).sections.map((s) => s.key);
            throw new Error(t("noSectionNamedAvailableSections", key, known.join("、") || t("none")));
          }
          sendJson(res, 200, { ok: true, section });
          return;
        }
        sendJson(res, 200, { ok: true, context: this.taskContext.get(groupId) });
        return;
      }

      if (method === "POST" && pathname === "/api/context") {
        const body = ContextPutSchema.parse(await readJsonBody(req));
        // Sub-sessions only read: otherwise two of them could overwrite each other's context.
        if ((body.depth ?? 0) > 0) {
          throw new Error(t("onlyTheLeadSessionCanEditShared"));
        }
        const groupId = this.resolveGroupId(body.groupId);
        const updatedBy = body.updatedBy && this.registry.isKnownAgent(body.updatedBy) ? body.updatedBy : "user";
        sendJson(res, 200, {
          ok: true,
          context: this.taskContext.put(groupId, { key: body.key, content: body.content, summary: body.summary, updatedBy }),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/context/replace") {
        const body = ContextReplaceSchema.parse(await readJsonBody(req));
        const groupId = this.resolveGroupId(body.groupId);
        const updatedBy = body.updatedBy && this.registry.isKnownAgent(body.updatedBy) ? body.updatedBy : "user";
        sendJson(res, 200, {
          ok: true,
          context: this.taskContext.replaceAuthored(groupId, { common: body.common, sections: body.sections, updatedBy }),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/projects") {
        sendJson(res, 200, { ok: true, projects: this.listProjects() });
        return;
      }

      if (method === "GET" && pathname === "/api/progress") {
        const groupId = reqUrl.searchParams.get("groupId") || this.defaultGroupId;
        sendJson(res, 200, { ok: true, progress: this.getProgress(groupId) ?? null });
        return;
      }

      if (method === "POST" && pathname === "/api/progress") {
        const body = ProgressUpdateSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, progress: this.updateProgress(body) });
        return;
      }

      if (method === "GET" && pathname === "/api/workflows") {
        const groupId = reqUrl.searchParams.get("groupId") || this.defaultGroupId;
        sendJson(res, 200, { ok: true, workflow: this.workflows.get(groupId) });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/save") {
        const body = WorkflowSaveSchema.parse(await readJsonBody(req));
        const workflowGroupId = body.groupId?.trim() || this.defaultGroupId;
        if (!this.groups.has(workflowGroupId)) {
          throw new Error(`Unknown task group: ${workflowGroupId}`);
        }
        const proposedBy =
          body.proposedBy && this.registry.isKnownAgent(body.proposedBy) ? body.proposedBy : "user";
        // A draft that brings its own context replaces the hand-written sections with it.
        if (body.sharedContext !== undefined || body.sections !== undefined) {
          const current = this.taskContext.get(workflowGroupId);
          this.taskContext.replaceAuthored(workflowGroupId, {
            common:
              body.sharedContext ?? current.sections.find((s) => s.kind === "common")?.content,
            sections:
              body.sections ??
              current.sections.filter((s) => s.kind === "section").map((s) => ({
                key: s.key,
                summary: s.summary,
                content: s.content,
              })),
            updatedBy: proposedBy,
          });
        }
        sendJson(res, 200, {
          ok: true,
          workflow: this.workflows.save(workflowGroupId, body.steps, proposedBy),
          context: this.taskContext.get(workflowGroupId),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/run") {
        const body = WorkflowGroupSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, workflow: this.workflows.run(body.groupId) });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/retry") {
        const body = WorkflowGroupSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, workflow: this.workflows.retryFailed(body.groupId) });
        return;
      }

      if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
        const body = method === "POST" ? ((await readJsonBody(req)) as Record<string, unknown>) : {};
        const groupId = (method === "GET" ? reqUrl.searchParams.get("groupId") : (body.groupId as string | undefined)) || undefined;
        const cwd = (groupId && this.groups.get(groupId)?.cwd) || this.baseCwd;
        const reply = () => sendJson(res, 200, { ok: true, cwd, servers: this.mcpServers.list(cwd) });
        if (method === "GET" && pathname === "/api/mcp") {
          reply();
          return;
        }
        if (method === "POST" && pathname === "/api/mcp/state") {
          const input = z
            .object({
              id: z.string().min(1),
              enabled: z.boolean().optional(),
              roles: z.array(z.enum(["lead", "sub"])).optional(),
              agent: z.string().optional(),
              agentEnabled: z.boolean().optional(),
            })
            .parse(body);
          this.mcpServers.setState(input.id, { ...input, agent: input.agent?.trim().toLowerCase() || undefined });
          reply();
          return;
        }
        if (method === "POST" && pathname === "/api/mcp/save") {
          const input = z
            .object({
              server: z.object({
                name: z.string().min(1),
                transport: z.enum(["stdio", "http"]),
                command: z.string().optional(),
                args: z.array(z.string()).optional(),
                env: z.record(z.string(), z.string()).optional(),
                url: z.string().optional(),
                headers: z.record(z.string(), z.string()).optional(),
              }),
            })
            .parse(body);
          this.mcpServers.save(input.server);
          reply();
          return;
        }
        if (method === "POST" && pathname === "/api/mcp/delete") {
          this.mcpServers.delete(z.object({ name: z.string().min(1) }).parse(body).name);
          reply();
          return;
        }
        if (method === "POST" && pathname === "/api/mcp/trust") {
          this.mcpServers.setProjectTrust(cwd, z.object({ trusted: z.boolean() }).parse(body).trusted);
          reply();
          return;
        }
      }

      if (method === "GET" && pathname === "/api/workflows/templates") {
        sendJson(res, 200, { ok: true, templates: this.workflowTemplates.list() });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/templates/save") {
        const body = z.object({ groupId: z.string().min(1), name: z.string().min(1) }).parse(await readJsonBody(req));
        const templates = this.workflowTemplates.save(body.name, this.workflows.get(body.groupId).steps);
        sendJson(res, 200, { ok: true, templates });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/templates/apply") {
        const body = z.object({ groupId: z.string().min(1), name: z.string().min(1) }).parse(await readJsonBody(req));
        const template = this.workflowTemplates.get(body.name);
        if (!template) throw new Error(t("noTemplateNamed", body.name));
        sendJson(res, 200, { ok: true, workflow: this.workflows.save(body.groupId, template.steps, "user") });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/templates/delete") {
        const body = z.object({ name: z.string().min(1) }).parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, templates: this.workflowTemplates.delete(body.name) });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/continue") {
        const body = z
          .object({
            groupId: z.string().min(1),
            depth: z.number().optional(),
            guidance: z.array(z.object({ stepId: z.string().min(1), text: z.string() })).optional(),
            skip: z.array(z.object({ stepId: z.string().min(1), reason: z.string().optional() })).optional(),
          })
          .parse(await readJsonBody(req));
        if ((body.depth ?? 0) > 0) throw new Error("Only the lead of the task can decide how a workflow goes on.");
        sendJson(res, 200, { ok: true, workflow: this.workflows.continueAfterFailure(body.groupId, body) });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/resume") {
        const body = WorkflowGroupSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, workflow: this.workflows.resume(body.groupId) });
        return;
      }

      if (method === "POST" && pathname === "/api/workflows/cancel") {
        const body = WorkflowGroupSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, workflow: this.workflows.cancel(body.groupId) });
        return;
      }

      if (method === "GET" && pathname === "/api/settings") {
        sendJson(res, 200, { ok: true, settings: this.getSettings() });
        return;
      }

      if (method === "POST" && pathname === "/api/settings") {
        const input = z
          .object({
            autoTitle: z.boolean().optional(),
            workflowParallel: z.number().optional(),
            idleSubSessionMinutes: z.number().optional(),
            boardParallel: z.number().optional(),
            idleLeadMinutes: z.number().optional(),
          })
          .parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, settings: this.updateSettings(input) });
        return;
      }

      if (method === "GET" && pathname === "/api/agents/presets") {
        sendJson(res, 200, { ok: true, presets: this.registry.listPresets() });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/presets/add") {
        const input = AgentIdOnlySchema.parse(await readJsonBody(req));
        const agent = this.registry.addPreset(input.id);
        if (!this.telemetryByAgent[agent.id]) {
          this.telemetryByAgent[agent.id] = createEmptyTotals();
        }
        this.broadcastAgentsUpdated();
        sendJson(res, 200, { ok: true, agent, agents: this.registry.getHealthList(true) });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/default-lead") {
        const input = DefaultLeadSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { ok: true, ...this.setDefaultLead(input.id ?? null) });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/save") {
        const input = AgentSaveSchema.parse(await readJsonBody(req));
        const agent = this.registry.upsertAgent(input);
        if (!this.telemetryByAgent[agent.id]) {
          this.telemetryByAgent[agent.id] = createEmptyTotals();
        }
        for (const group of this.groups.values()) {
          if (group.leadAgent === agent.id) {
            this.syncGroupLeadModelFields(group);
            this.broadcast({ type: "group_updated", group: { ...group }, timestamp: Date.now() });
          }
        }
        this.broadcastAgentsUpdated();
        sendJson(res, 200, {
          ok: true,
          agent,
          agents: this.registry.getHealthList(true),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/toggle") {
        const input = AgentToggleSchema.parse(await readJsonBody(req));
        const agent = this.registry.toggleAgent(input.id, input.enabled);
        this.broadcastAgentsUpdated();
        sendJson(res, 200, {
          ok: true,
          agent,
          agents: this.registry.getHealthList(true),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/delete") {
        const input = AgentIdOnlySchema.parse(await readJsonBody(req));
        const deleted = this.registry.deleteCustomAgent(input.id);
        this.broadcastAgentsUpdated();
        sendJson(res, 200, {
          ok: true,
          deleted,
          agents: this.registry.getHealthList(true),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/login") {
        const input = AgentIdOnlySchema.parse(await readJsonBody(req));
        const def = this.registry.getDefinition(input.id.trim().toLowerCase());
        if (!def) throw new Error(`Unknown agent: ${input.id}`);
        const login = resolveAgentLoginCommand(def.id);
        if (!login) {
          throw new Error(t("unknownAgentSignInCommand", def.label || def.id));
        }
        const commandLine = openTerminalWindow(`RTM - ${def.label || def.id} login`, login.command, login.args);
        sendJson(res, 200, { ok: true, commandLine });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/refresh") {
        await this.registry.refreshHealth();
        this.broadcastAgentsUpdated();
        sendJson(res, 200, { ok: true, agents: this.registry.getHealthList(true) });
        return;
      }

      if (method === "POST" && pathname === "/api/agents/test") {
        const input = AgentIdOnlySchema.parse(await readJsonBody(req));
        const probe = await this.registry.probeHandshake(input.id, this.baseCwd);
        if (probe.modelCatalog && (probe.modelCatalog.models.length > 0 || probe.modelCatalog.effort)) {
          this.broadcast({
            type: "models_updated",
            agent: input.id,
            catalog: probe.modelCatalog,
            timestamp: Date.now(),
          });
        }
        sendJson(res, 200, { ...probe });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
    }
  }

  private scheduleAutoExitCheck(delayMs: number): void {
    if (!this.autoExitOnWindowClose || !this.hadWsClient) {
      return;
    }
    if (this.autoExitTimer) {
      clearTimeout(this.autoExitTimer);
    }
    this.autoExitTimer = setTimeout(() => {
      this.autoExitTimer = undefined;
      if (this.wsClients.size > 0) {
        return;
      }
      const busy = this.pool
        .listSessions()
        .some((s) => s.status === "busy" || s.status === "starting");
      if (busy) {
        this.scheduleAutoExitCheck(2000);
        return;
      }
      if (this.onAutoExit) {
        this.onAutoExit();
      } else {
        void this.stop().finally(() => process.exit(0));
      }
    }, delayMs);
    this.autoExitTimer.unref();
  }

  async start(preferredPort = 4317): Promise<string> {
    const server = http.createServer((req, res) => {
      void withLocale(negotiateLocale(req.headers["accept-language"]), () => this.handleRequest(req, res));
    });
    this.server = server;

    const wss = new WebSocketServer({
      server,
      path: "/ws",
      // Same rule as the HTTP API: only the hub's own page may open the event stream.
      verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
        const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
        const host = String(info.req.headers.host ?? "").toLowerCase();
        if (!hosts.includes(host)) return false;
        return !info.origin || hosts.some((h) => `http://${h}` === String(info.origin).toLowerCase());
      },
    });
    this.wss = wss;
    wss.on("connection", (ws) => {
      this.hadWsClient = true;
      if (this.autoExitTimer) {
        clearTimeout(this.autoExitTimer);
        this.autoExitTimer = undefined;
      }
      this.wsClients.add(ws);
      ws.send(JSON.stringify(this.createSnapshot()));
      ws.on("close", () => {
        this.wsClients.delete(ws);
        if (this.autoExitOnWindowClose && this.hadWsClient && this.wsClients.size === 0) {
          this.scheduleAutoExitCheck(this.autoExitGraceMs);
        }
      });
    });

    const listenOnPort = (portToTry: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : portToTry);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(portToTry, "127.0.0.1");
      });

    let boundPort: number | undefined;
    if (preferredPort === 0) {
      boundPort = await listenOnPort(0);
    } else if (this.strictPort) {
      const check = await checkPortAvailable(preferredPort);
      if (!check.available) {
        throw new Error(
          `Port ${preferredPort} is unavailable (${check.reason ?? "already in use"}).`,
        );
      }
      boundPort = await listenOnPort(preferredPort);
    } else {
      for (let offset = 0; offset < 20; offset++) {
        try {
          boundPort = await listenOnPort(preferredPort + offset);
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EADDRINUSE") {
            throw err;
          }
        }
      }
      if (boundPort === undefined) {
        boundPort = await listenOnPort(0);
      }
    }

    this.port = boundPort;
    this.url = `http://127.0.0.1:${boundPort}`;
    this.pool.setHubUrl(this.url);
    this.memory.start();
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleSubSessions();
      this.sweepIdleLeadSessions();
    }, 60_000);
    this.idleSweepTimer.unref();
    this.pumpBoard();

    if (this.writeRuntimeFile) {
      fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
      const runtimeInfo: RuntimeFileInfo = {
        url: this.url,
        port: this.port,
        pid: process.pid,
        baseCwd: this.baseCwd,
        startedAt: Date.now(),
      };
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtimeInfo, null, 2), "utf8");
    }

    return this.url;
  }

  /** Writes pending state to disk now. For the moments when a normal stop() is not possible. */
  flushState(): void {
    this.stateStore?.flush();
  }

  async stop(): Promise<void> {
    this.memory.stop();
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
    if (this.autoExitTimer) {
      clearTimeout(this.autoExitTimer);
      this.autoExitTimer = undefined;
    }
    for (const [questionId, entry] of this.pendingQuestions.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ cancelled: true, answers: {} });
      this.pendingQuestions.delete(questionId);
    }
    this.permissionGroupByRequestId.clear();
    // Save before the sessions are torn down, so they are recorded as they were.
    this.stateStore?.flush();
    await this.pool.disposeAll();
    for (const ws of this.wsClients) {
      ws.close();
    }
    this.wsClients.clear();
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = undefined;
    }
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (this.writeRuntimeFile && fs.existsSync(RUNTIME_FILE)) {
      try {
        const info = readRuntimeFile();
        if (!info || info.pid === process.pid) {
          fs.unlinkSync(RUNTIME_FILE);
        }
      } catch {
        // ignore
      }
    }
  }
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  type AgentId,
  type ArtifactKind,
  type ArtifactRecord,
  type ChatMessageRecord,
  type HubEvent,
  type PendingUserQuestion,
  type PermissionMode,
  type QuestionField,
  type SessionRecord,
  type SessionUsageTotals,
  type TaskGroup,
  type TaskRecord,
  type TelemetrySnapshot,
  type TurnTelemetryRecord,
  type TurnUsage,
} from "../types.js";
import { openInteractiveWindow } from "../ui/launcher.js";
import { AcpPool, buildSessionKey } from "./acp-pool.js";
import { AgentRegistry } from "./agent-registry.js";
import { ThreadLedger } from "./ledger.js";
import { checkPortAvailable, findAvailablePort, pickNativeDirectory } from "./port-finder.js";
import { PROJECT_ROOT } from "./process-tree.js";
import { SharedResourceManager } from "./resources.js";
import { summarizeWorkspaceChanges } from "./worktree.js";

const MAX_PEER_DEPTH = 3;
const RUNTIME_FILE = path.join(PROJECT_ROOT, ".agent-hub", "runtime.json");

const AgentIdSchema = z.string().trim().min(1);
const PermissionModeSchema = z.enum(["approve-all", "approve-reads", "manual"]);

const LeadBodySchema = z.object({
  agent: AgentIdSchema,
  groupId: z.string().optional(),
});

const ChatBodySchema = z.object({
  groupId: z.string().optional(),
  prompt: z.string().min(1),
  leadAgent: AgentIdSchema.optional(),
  cwd: z.string().optional(),
  session: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const CreateGroupBodySchema = z.object({
  title: z.string().optional(),
  leadAgent: AgentIdSchema.optional(),
  leadModel: z.string().optional(),
  leadEffort: z.string().optional(),
  cwd: z.string().optional(),
});

const UpdateGroupBodySchema = z.object({
  groupId: z.string().min(1),
  title: z.string().optional(),
  leadAgent: AgentIdSchema.optional(),
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

const SessionChatBodySchema = z.object({
  sessionKey: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
});

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

const CancelBodySchema = z.object({
  sessionKey: z.string().min(1),
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
});

const ResourceSaveRuleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "global"]),
  content: z.string().min(1),
});

const ResourceDeleteRuleSchema = z.object({
  id: z.string().min(1),
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
});

const AgentToggleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

const AgentIdOnlySchema = z.object({
  id: z.string().min(1),
});

const WorkspaceCwdSchema = z.object({
  cwd: z.string().min(1),
  groupId: z.string().optional(),
});

const WorkspacePickSchema = z.object({
  initialDir: z.string().optional(),
});

const DESKTOP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#151514"/>
  <path d="M21 48 L32 16 L43 48 M25.5 36.5 H38.5" stroke="#f3f2ec" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="49" cy="15" r="5" fill="#0d7148"/>
</svg>`;

function buildArtifactHtmlDocument(artifact: ArtifactRecord): string {
  const safeTitle = artifact.title.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );
  let bodyMarkup = artifact.content;
  const trimmed = artifact.content.trim();
  if (artifact.kind === "svg" && !/<svg[\s>]/i.test(trimmed)) {
    bodyMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">${artifact.content}</svg>`;
  } else if (artifact.kind === "mermaid") {
    bodyMarkup = `<pre class="mermaid">${trimmed.replace(/</g, "&lt;")}</pre>
    <p style="font-size:12px;color:var(--muted);margin-top:8px;">Mermaid 源码视图（离线环境不依赖外部 CDN）：</p>`;
  }

  // If the HTML already defines a full <html> document, inject auto-height reporter cleanly before </body>
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
    return trimmed.includes("</body>")
      ? trimmed.replace("</body>", `${resizeScript}\n</body>`)
      : `${trimmed}\n${resizeScript}`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #f3f2ec;
      --card: #faf9f5;
      --ink: #151514;
      --muted: #56564f;
      --line: #c4c2b6;
      --accent: #0d7148;
      --background: #f3f2ec;
      --foreground: #151514;
      --border: #c4c2b6;
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
    pre.mermaid {
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    return "新任务";
  }
  return firstLine.length > 26 ? `${firstLine.slice(0, 26)}…` : firstLine;
}

function cloneMessage(msg: ChatMessageRecord): ChatMessageRecord {
  return {
    ...msg,
    toolCalls: msg.toolCalls.map((t) => ({ ...t })),
  };
}

export class AgentHubServer {
  private _baseCwd: string;
  get baseCwd(): string {
    return this._baseCwd;
  }
  readonly pool = new AcpPool();
  readonly registry: AgentRegistry;
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
    for (const def of this.registry.listDefinitions()) {
      this.telemetryByAgent[def.id] = createEmptyTotals();
    }
    if (options.permissionMode) {
      this.pool.setPermissionMode(options.permissionMode);
    }

    const now = Date.now();
    const initialGroup: TaskGroup = {
      groupId: this.defaultGroupId,
      title: "任务 1",
      leadAgent: options.defaultLead ?? "claude",
      agentModels: {},
      agentEfforts: {},
      cwd: this.baseCwd,
      createdAt: now,
      updatedAt: now,
    };
    this.syncGroupLeadModelFields(initialGroup);
    this.groups.set(initialGroup.groupId, initialGroup);
    this.ledgers.set(initialGroup.groupId, new ThreadLedger());

    this.pool.on("hub_event", (event: HubEvent) => {
      if (event.type === "agent_chunk") {
        const active = this.activeAssistantBySession.get(event.sessionKey);
        if (active) {
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
          const existingTool = active.toolCalls.find((t) => t.toolCallId === event.toolCallId);
          if (existingTool) {
            existingTool.title = event.title || existingTool.title;
            if (event.kind) existingTool.kind = event.kind;
            if (event.status) existingTool.status = event.status;
            if (event.rawInput !== undefined) existingTool.rawInput = event.rawInput;
            existingTool.timestamp = event.timestamp;
          } else {
            active.toolCalls.push({
              toolCallId: event.toolCallId,
              title: event.title,
              kind: event.kind,
              status: event.status,
              rawInput: event.rawInput,
              timestamp: event.timestamp,
            });
          }
          event.messageId = active.messageId;
          event.streamKey = active.streamKey;
          event.groupId = active.groupId;
        }
      }
      this.broadcast(event);
    });
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
    return group?.leadAgent ?? "claude";
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
  }): TaskGroup {
    const now = Date.now();
    this.groupCounter += 1;
    const rawTitle = input?.title?.trim();
    const leadAgent = input?.leadAgent ? this.requireKnownAgent(input.leadAgent) : this.getLeadAgent();
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
      title: rawTitle && rawTitle.length > 0 ? rawTitle : `任务 ${this.groupCounter}`,
      leadAgent,
      agentModels,
      agentEfforts,
      cwd: input?.cwd ? path.resolve(input.cwd) : this.baseCwd,
      createdAt: now,
      updatedAt: now,
    };
    this.syncGroupLeadModelFields(group);
    this.groups.set(group.groupId, group);
    this.ledgers.set(group.groupId, new ThreadLedger());
    this.broadcast({
      type: "group_created",
      group: { ...group },
      timestamp: now,
    });
    return { ...group };
  }

  updateGroup(input: { groupId: string; title?: string; leadAgent?: AgentId }): TaskGroup {
    let group = this.groups.get(input.groupId);
    if (!group) {
      throw new Error(`Unknown task group: ${input.groupId}`);
    }
    const cleanTitle = input.title?.trim();
    if (cleanTitle) {
      group.title = cleanTitle;
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
    group.leadAgent = validAgent;
    this.syncGroupLeadModelFields(group);
    group.updatedAt = now;

    this.upsertMessage({
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId,
      streamKey: `lead:${groupId}`,
      sessionKey: buildSessionKey(validAgent, `${groupId}__lead`),
      role: "system",
      senderLabel: "系统",
      text: `主导会话已切换：${previousLead} → ${validAgent}`,
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
    if (!this.groups.has(groupId)) {
      throw new Error(`Unknown task group: ${groupId}`);
    }
    const sessionsToClose = this.pool.listSessions().filter((s) => s.groupId === groupId);
    await Promise.all(sessionsToClose.map((s) => this.pool.closeSession(s.sessionKey)));

    this.groups.delete(groupId);
    this.ledgers.delete(groupId);
    for (const [msgId, msg] of this.messages.entries()) {
      if (msg.groupId === groupId) {
        this.messages.delete(msgId);
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
      const replacement = this.createGroup({ title: "任务 1" });
      this.defaultGroupId = replacement.groupId;
    } else if (groupId === this.defaultGroupId) {
      const firstRemaining = this.groups.values().next().value as TaskGroup;
      this.defaultGroupId = firstRemaining.groupId;
    }
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

  private broadcast(event: HubEvent): void {
    const payload = JSON.stringify(event);
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
    usage: TurnUsage;
  }): void {
    const addToTotals = (target: SessionUsageTotals, usage: TurnUsage) => {
      target.turns += 1;
      target.inputTokens += usage.inputTokens;
      target.outputTokens += usage.outputTokens;
      target.cachedReadTokens += usage.cachedReadTokens;
      target.cachedWriteTokens += usage.cachedWriteTokens;
      target.thoughtTokens += usage.thoughtTokens;
      target.totalTokens += usage.totalTokens;
      if (typeof usage.costUsd === "number") {
        target.costUsd += usage.costUsd;
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
      injectedRulesTokens: session?.contextBreakdown?.sharedRulesTokens ?? 0,
      injectedSkillsTokens: session?.contextBreakdown?.skillsIndexTokens ?? 0,
      handoffTokens: params.handoffTokens,
      usage: { ...params.usage },
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
      title: input.title?.trim() || `${agent} 需要你确认以下问题`,
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
      },
    );
  }

  resolveUserQuestion(rawInput: unknown): { resolved: boolean; questionId: string } {
    const input = QuestionResolveSchema.parse(rawInput);
    const entry = this.pendingQuestions.get(input.questionId);
    if (!entry) {
      throw new Error(`Unknown or expired question: ${input.questionId}`);
    }
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
    entry.resolve({ cancelled: input.cancelled, answers });
    return { resolved: true, questionId: input.questionId };
  }

  private broadcastAgentsUpdated(): void {
    const now = Date.now();
    this.broadcast({
      type: "agents_updated",
      agents: this.registry.getHealthList(true),
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
      defaultGroupId: this.defaultGroupId,
      leadAgent: this.getLeadAgent(this.defaultGroupId),
      permissionMode: this.pool.getPermissionMode(),
      baseCwd: this.baseCwd,
      taskGroups: this.listGroups(),
      sessions: this.pool.listSessions(),
      tasks: [...this.tasks.values()],
      pendingPermissions: this.pool.getPendingPermissions(),
      pendingQuestions: this.listPendingQuestions(),
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
    group.cwd = resolved;
    group.updatedAt = now;

    if (targetGroupId !== this.defaultGroupId) {
      const defGroup = this.groups.get(this.defaultGroupId);
      if (defGroup) {
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
    }
  }

  async runLeadChat(input: {
    groupId?: string;
    prompt: string;
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

    if (input.leadAgent) {
      this.setGroupLeadAgent(group.groupId, input.leadAgent);
    }

    const lead = group.leadAgent;
    const ledger = this.getOrCreateLedger(group.groupId);
    if (/^(任务\s*\d+|新任务|默认任务)$/.test(group.title) && ledger.getAllTurns().length === 0) {
      group.title = autoTitleFromPrompt(input.prompt);
      group.updatedAt = Date.now();
      this.broadcast({
        type: "group_updated",
        group: { ...group },
        timestamp: group.updatedAt,
      });
    }

    const sessionName = input.session ?? `${group.groupId}__lead`;
    const sessionKey = buildSessionKey(lead, sessionName);
    const streamKey = `lead:${group.groupId}`;
    const leadPromptMeta = ledger.buildLeadPromptWithMeta(lead, input.prompt);

    const now = Date.now();
    this.upsertMessage({
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: group.groupId,
      streamKey,
      sessionKey,
      role: "user",
      senderLabel: "你",
      text: input.prompt,
      thoughtText: "",
      toolCalls: [],
      status: "done",
      timestamp: now,
      completedAt: now,
    });

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
      status: "streaming",
      timestamp: Date.now(),
    };
    this.activeAssistantBySession.set(sessionKey, assistantMsg);
    this.upsertMessage(assistantMsg);

    try {
      const def = this.registry.getDefinition(lead);
      const effectiveModel = input.model?.trim() || group.agentModels?.[lead] || def?.defaultModel;
      const effectiveEffort =
        input.effort?.trim() || group.agentEfforts?.[lead] || def?.defaultEffort;
      const result = await this.pool.runTurn({
        agent: lead,
        sessionName,
        baseCwd: input.cwd ?? group.cwd,
        prompt: leadPromptMeta.prompt,
        rawUserPrompt: input.prompt,
        handoffTokens: leadPromptMeta.handoffTokens,
        injectSharedResources: true,
        isolateWorktree: false,
        callDepth: 0,
        injectPeerMcp: true,
        groupId: group.groupId,
        role: "lead",
        label: "主导会话",
        model: effectiveModel,
        effort: effectiveEffort,
      });

      assistantMsg.status = result.stopReason === "cancelled" ? "cancelled" : "done";
      if (!assistantMsg.text && result.outputText) {
        assistantMsg.text = result.outputText;
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
        usage: result.usage,
      });

      const turn = ledger.recordTurn({
        leadAgent: lead,
        userText: input.prompt,
        assistantSummary: result.outputText,
        peerCallsSummary: result.peerToolsCalled,
      });
      turn.groupId = group.groupId;
      this.broadcast({ type: "ledger_turn", turn: { ...turn }, timestamp: Date.now() });

      return {
        groupId: group.groupId,
        leadAgent: lead,
        sessionKey: result.sessionKey,
        outputText: result.outputText,
        stopReason: result.stopReason,
        peerToolsCalled: result.peerToolsCalled,
      };
    } catch (err) {
      assistantMsg.status = "error";
      const errMsg = err instanceof Error ? err.message : String(err);
      assistantMsg.text = assistantMsg.text
        ? `${assistantMsg.text}\n\n[Error] ${errMsg}`
        : `[Error] ${errMsg}`;
      assistantMsg.completedAt = Date.now();
      this.upsertMessage(assistantMsg);
      throw err;
    } finally {
      if (this.activeAssistantBySession.get(sessionKey)?.messageId === assistantMsg.messageId) {
        this.activeAssistantBySession.delete(sessionKey);
      }
    }
  }

  async runSubSessionChat(input: {
    sessionKey: string;
    prompt: string;
    model?: string;
    effort?: string;
  }): Promise<{
    sessionKey: string;
    groupId: string;
    outputText: string;
    stopReason: string;
  }> {
    const session = this.pool.getSession(input.sessionKey);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionKey}`);
    }

    const streamKey = `sub:${session.sessionKey}`;
    const now = Date.now();
    this.upsertMessage({
      messageId: `msg-${randomUUID().slice(0, 8)}`,
      groupId: session.groupId,
      streamKey,
      sessionKey: session.sessionKey,
      role: "user",
      senderLabel: "你",
      text: input.prompt,
      thoughtText: "",
      toolCalls: [],
      status: "done",
      timestamp: now,
      completedAt: now,
    });

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
        prompt: input.prompt,
        rawUserPrompt: input.prompt,
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
        handoffTokens: 0,
        usage: result.usage,
      });

      return {
        sessionKey: result.sessionKey,
        groupId: session.groupId,
        outputText: result.outputText,
        stopReason: result.stopReason,
      };
    } catch (err) {
      assistantMsg.status = "error";
      const errMsg = err instanceof Error ? err.message : String(err);
      assistantMsg.text = assistantMsg.text
        ? `${assistantMsg.text}\n\n[Error] ${errMsg}`
        : `[Error] ${errMsg}`;
      assistantMsg.completedAt = Date.now();
      this.upsertMessage(assistantMsg);
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

  dispatchPeerTask(rawBody: unknown): TaskRecord {
    const body = PeerCallBodySchema.parse(rawBody);
    const target = this.resolvePeerTarget(body);
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
        prompt: body.prompt,
        rawUserPrompt: body.prompt,
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
        task.status = res.stopReason === "cancelled" ? "cancelled" : "completed";
        task.outputText = res.outputText;
        task.worktreePath = res.isWorktree ? res.effectiveCwd : undefined;
        task.branch = res.branch;
        task.workspaceSummary = summarizeWorkspaceChanges(res.effectiveCwd);
        task.completedAt = Date.now();
        this.updateTask(task);

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
          usage: res.usage,
        });
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", this.url || "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (method === "GET" && pathname === "/") {
        const html = fs.readFileSync(this.getUiAssetPath("index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/ui/styles.css") {
        const css = fs.readFileSync(this.getUiAssetPath("styles.css"), "utf8");
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
        res.end(css);
        return;
      }

      if (method === "GET" && pathname === "/ui/panels.css") {
        const css = fs.readFileSync(this.getUiAssetPath("panels.css"), "utf8");
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
        res.end(css);
        return;
      }

      if (method === "GET" && pathname === "/ui/app.js") {
        const js = fs.readFileSync(this.getUiAssetPath("app.js"), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(js);
        return;
      }

      if (method === "GET" && pathname === "/ui/panels.js") {
        const js = fs.readFileSync(this.getUiAssetPath("panels.js"), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(js);
        return;
      }

      if (method === "GET" && pathname === "/ui/interactive.js") {
        const js = fs.readFileSync(this.getUiAssetPath("interactive.js"), "utf8");
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(js);
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
        const html = buildArtifactHtmlDocument(artifact);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/ui/icon.svg") {
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
        res.end(DESKTOP_ICON_SVG);
        return;
      }

      if (method === "GET" && pathname === "/manifest.webmanifest") {
        const manifest = {
          name: "Agent Hub",
          short_name: "AgentHub",
          description: "Multi-agent collaborative workbench on ACP",
          start_url: "/",
          display: "standalone",
          background_color: "#f3f2ec",
          theme_color: "#f3f2ec",
          icons: [{ src: "/ui/icon.svg", sizes: "any", type: "image/svg+xml" }],
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

      if (method === "GET" && pathname === "/api/groups") {
        sendJson(res, 200, {
          ok: true,
          defaultGroupId: this.defaultGroupId,
          groups: this.listGroups(),
        });
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
        const cwd = reqUrl.searchParams.get("cwd") || this.baseCwd;
        sendJson(res, 200, {
          ok: true,
          resources: this.resources.discover(cwd),
          budgets: this.resources.getAgentBudgets(cwd),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/resources/content") {
        const id = reqUrl.searchParams.get("id") || undefined;
        const skillName = reqUrl.searchParams.get("skill") || undefined;
        const cwd = reqUrl.searchParams.get("cwd") || this.baseCwd;
        const result = this.resources.readResourceContent({ id, skillName, cwd });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/toggle") {
        const body = ResourceToggleSchema.parse(await readJsonBody(req));
        this.resources.setResourceEnabled(body.id, body.enabled);
        const resources = this.resources.discover(this.baseCwd);
        const budgets = this.resources.getAgentBudgets(this.baseCwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/rules") {
        const body = ResourceSaveRuleSchema.parse(await readJsonBody(req));
        const item = this.resources.saveHubRule(body);
        const resources = this.resources.discover(this.baseCwd);
        const budgets = this.resources.getAgentBudgets(this.baseCwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, item, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/rules/delete") {
        const body = ResourceDeleteRuleSchema.parse(await readJsonBody(req));
        const deleted = this.resources.deleteHubRule(body.id);
        const resources = this.resources.discover(this.baseCwd);
        const budgets = this.resources.getAgentBudgets(this.baseCwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, deleted, resources, budgets });
        return;
      }

      if (method === "POST" && pathname === "/api/resources/sync-project") {
        const updatedFiles = this.resources.syncProjectRuleFiles(this.baseCwd);
        const budgets = this.resources.getAgentBudgets(this.baseCwd);
        this.broadcast({ type: "resources_updated", budgets, timestamp: Date.now() });
        sendJson(res, 200, { ok: true, updatedFiles });
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
          sendJson(res, 200, { ok: true, agent: validAgent, catalog });
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
        });
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
      void this.handleRequest(req, res);
    });
    this.server = server;

    const wss = new WebSocketServer({ server, path: "/ws" });
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

  async stop(): Promise<void> {
    if (this.autoExitTimer) {
      clearTimeout(this.autoExitTimer);
      this.autoExitTimer = undefined;
    }
    for (const [questionId, entry] of this.pendingQuestions.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ cancelled: true, answers: {} });
      this.pendingQuestions.delete(questionId);
    }
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

import { t } from "./i18n.js";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentId,
  AgentModelCatalog,
  HubEvent,
  PendingPermission,
  PermissionMode,
  SessionContextBreakdown,
  SessionRecord,
  SessionSlashCommand,
  SessionToolDiff,
  SessionUsageTotals,
  TurnUsage,
} from "../types.js";
import {
  extractModelCatalogFromConfigOptions,
  extractModelCatalogFromNewSession,
} from "./model-catalog.js";
import {
  killProcessTree,
  resolveAdapterCommand,
  resolvePeerMcpLaunch,
} from "./process-tree.js";
import type { AgentRegistry } from "./agent-registry.js";
import {
  buildHubWorkbenchGuide,
  estimateTokens,
  type SharedResourceManager,
} from "./resources.js";
import { ensureSessionWorkspace } from "./worktree.js";
import {
  clipHeadTail,
  compactToolRawInput,
  MAX_TOOL_DIFF_CHARS,
  MAX_TOOL_DIFF_COUNT,
  MAX_TOOL_OUTPUT_CHARS,
} from "./tool-clip.js";

const READ_ONLY_KINDS = new Set(["read", "search", "think"]);

function extractRawOutputText(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null) return undefined;
  if (typeof rawOutput === "string") {
    return rawOutput.trim() ? rawOutput : undefined;
  }
  if (typeof rawOutput !== "object") return undefined;
  const obj = rawOutput as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "text", "content", "message"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(key === "stderr" ? `[stderr]\n${val}` : val);
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  try {
    const serialized = JSON.stringify(rawOutput, null, 2);
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function extractToolOutputs(
  content: unknown,
  rawOutput: unknown,
): { diffs?: SessionToolDiff[]; outputText?: string; outputTruncated?: boolean } {
  const diffs: SessionToolDiff[] = [];
  const textChunks: string[] = [];

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const entry = item as {
        type?: unknown;
        path?: unknown;
        oldText?: unknown;
        newText?: unknown;
        content?: { type?: unknown; text?: unknown };
      };
      if (entry.type === "diff" && typeof entry.path === "string" && typeof entry.newText === "string") {
        if (diffs.length < MAX_TOOL_DIFF_COUNT) {
          const oldClipped =
            typeof entry.oldText === "string" ? clipHeadTail(entry.oldText, MAX_TOOL_DIFF_CHARS) : undefined;
          const newClipped = clipHeadTail(entry.newText, MAX_TOOL_DIFF_CHARS);
          diffs.push({
            path: entry.path,
            oldText: oldClipped?.value,
            newText: newClipped.value,
            truncated: Boolean(oldClipped?.truncated || newClipped.truncated),
          });
        }
      } else if (entry.type === "content" && entry.content?.type === "text" && typeof entry.content.text === "string") {
        if (entry.content.text.trim()) {
          textChunks.push(entry.content.text);
        }
      }
    }
  }

  let rawText = textChunks.length > 0 ? textChunks.join("\n") : extractRawOutputText(rawOutput);
  let outputText: string | undefined;
  let outputTruncated = false;
  if (rawText) {
    const clipped = clipHeadTail(rawText, MAX_TOOL_OUTPUT_CHARS);
    outputText = clipped.value;
    outputTruncated = clipped.truncated;
  }

  return {
    diffs: diffs.length > 0 ? diffs : undefined,
    outputText,
    outputTruncated: outputTruncated || undefined,
  };
}

function createEmptyContextBreakdown(): SessionContextBreakdown {
  return {
    sharedRulesTokens: 0,
    skillsIndexTokens: 0,
    handoffTokens: 0,
    userPromptsTokens: 0,
    agentOutputsTokens: 0,
    injectedRules: [],
    injectedSkillsCount: 0,
    nativeRulesCount: 0,
    nativeSkillsCount: 0,
  };
}

function createEmptyUsageTotals(): SessionUsageTotals {
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

function buildTurnUsage(params: {
  promptResp: acp.PromptResponse | undefined;
  effectivePrompt: string;
  outputText: string;
  thoughtText: string;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  costUsd?: number;
  modelId?: string;
}): TurnUsage {
  const rawResp = params.promptResp as
    | {
        usage?: {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cachedReadTokens?: number;
          cachedWriteTokens?: number;
          thoughtTokens?: number;
        };
        _meta?: {
          quota?: {
            token_count?: {
              totalTokens?: number;
              inputTokens?: number;
              cachedInputTokens?: number;
              cachedWriteTokens?: number;
              outputTokens?: number;
              reasoningOutputTokens?: number;
            };
          };
        };
      }
    | undefined;
  const u = rawResp?.usage;
  const metaQuota = rawResp?._meta?.quota?.token_count;

  if (u && ((u.totalTokens ?? 0) > 0 || (u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0)) {
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const cachedReadTokens = u.cachedReadTokens ?? 0;
    const cachedWriteTokens = u.cachedWriteTokens ?? 0;
    const thoughtTokens = u.thoughtTokens ?? 0;
    const totalTokens =
      u.totalTokens && u.totalTokens > 0
        ? u.totalTokens
        : inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens + thoughtTokens;
    return {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      thoughtTokens,
      totalTokens,
      contextUsedTokens: params.contextUsedTokens,
      contextMaxTokens: params.contextMaxTokens,
      costUsd: params.costUsd,
      modelId: params.modelId,
      isEstimated: false,
    };
  }

  if (
    metaQuota &&
    ((metaQuota.totalTokens ?? 0) > 0 ||
      (metaQuota.inputTokens ?? 0) > 0 ||
      (metaQuota.outputTokens ?? 0) > 0)
  ) {
    const inputTokens = metaQuota.inputTokens ?? 0;
    const outputTokens = metaQuota.outputTokens ?? 0;
    const cachedReadTokens = metaQuota.cachedInputTokens ?? 0;
    const cachedWriteTokens = metaQuota.cachedWriteTokens ?? 0;
    const thoughtTokens = metaQuota.reasoningOutputTokens ?? 0;
    const totalTokens =
      metaQuota.totalTokens && metaQuota.totalTokens > 0
        ? metaQuota.totalTokens
        : inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens + thoughtTokens;
    return {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      thoughtTokens,
      totalTokens,
      contextUsedTokens: params.contextUsedTokens,
      contextMaxTokens: params.contextMaxTokens,
      costUsd: params.costUsd,
      modelId: params.modelId,
      isEstimated: false,
    };
  }

  const inputTokens = estimateTokens(params.effectivePrompt);
  const thoughtTokens = estimateTokens(params.thoughtText);
  const outputTokens = estimateTokens(params.outputText);
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens,
    totalTokens: inputTokens + outputTokens + thoughtTokens,
    contextUsedTokens: params.contextUsedTokens,
    contextMaxTokens: params.contextMaxTokens,
    costUsd: params.costUsd,
    modelId: params.modelId,
    isEstimated: true,
  };
}

export type ElicitationBridgeHandler = (params: {
  sessionKey: string;
  groupId: string;
  agent: AgentId;
  request: acp.CreateElicitationRequest;
}) => Promise<acp.CreateElicitationResponse>;

export interface PromptImageInput {
  name: string;
  mimeType: string;
  data: string;
  localPath: string;
}

interface ManagedSession {
  record: SessionRecord;
  child: ChildProcess;
  conn: acp.ClientConnection;
  activeSession: acp.ActiveSession;
  queue: Promise<void>;
  stderrTail: string[];
  initializeCapabilities?: unknown;
  callDepth: number;
  resourcesInjected: boolean;
  workbenchGuideInjected: boolean;
  /** Tokens already delivered through session/new systemPrompt, reported once on the first turn. */
  pendingSystemInjectedTokens: number;
  modelCatalog?: AgentModelCatalog;
}

interface EnsureSessionOptions {
  agent: AgentId;
  sessionName: string;
  baseCwd: string;
  isolateWorktree: boolean;
  callDepth: number;
  injectPeerMcp: boolean;
  injectSharedResources: boolean;
  groupId?: string;
  role?: "lead" | "sub";
  label?: string;
  parentSessionKey?: string;
  model?: string;
  effort?: string;
}

export type WarmSessionOptions = Omit<
  RunTurnOptions,
  "prompt" | "images" | "rawUserPrompt" | "handoffTokens"
>;

export interface WarmSessionResult {
  sessionKey: string;
  /** Set when nothing was started: the session is already live or still starting. */
  skipped?: "session_exists" | "session_starting";
  /** Settles when the warm start finishes; never rejects. */
  ready?: Promise<boolean>;
}

const DEFAULT_WARM_IDLE_MS = 10 * 60_000;
const MAX_WARM_UNUSED_SESSIONS = 3;

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toEnsureSessionOptions(options: WarmSessionOptions): EnsureSessionOptions {
  return {
    agent: options.agent,
    sessionName: options.sessionName,
    baseCwd: options.baseCwd,
    isolateWorktree: Boolean(options.isolateWorktree),
    callDepth: options.callDepth ?? 0,
    injectPeerMcp: options.injectPeerMcp ?? true,
    injectSharedResources: options.injectSharedResources ?? Boolean(options.role),
    groupId: options.groupId,
    role: options.role,
    label: options.label,
    parentSessionKey: options.parentSessionKey,
    model: options.model,
    effort: options.effort,
  };
}

interface PendingPermissionWaiter {
  info: PendingPermission;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

export interface RunTurnOptions {
  agent: AgentId;
  sessionName: string;
  baseCwd: string;
  prompt: string;
  images?: PromptImageInput[];
  rawUserPrompt?: string;
  handoffTokens?: number;
  injectSharedResources?: boolean;
  isolateWorktree?: boolean;
  callDepth?: number;
  injectPeerMcp?: boolean;
  groupId?: string;
  role?: "lead" | "sub";
  label?: string;
  parentSessionKey?: string;
  model?: string;
  effort?: string;
}

export interface RunTurnResult {
  sessionKey: string;
  effectiveCwd: string;
  isWorktree: boolean;
  branch?: string;
  outputText: string;
  stopReason: string;
  peerToolsCalled: string[];
  usage: TurnUsage;
  injectedTokens: number;
}

export function buildSessionKey(agent: AgentId, sessionName: string): string {
  return `${agent}:${sessionName}`;
}

export class AcpPool extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private startingSessions = new Map<string, Promise<ManagedSession>>();
  private startingChildren = new Map<string, { child: ChildProcess; record: SessionRecord }>();
  private cancelledStarting = new Set<string>();
  private pendingPermissions = new Map<string, PendingPermissionWaiter>();
  private permissionMode: PermissionMode = "approve-all";
  private hubUrl = "";
  private resourceManager?: SharedResourceManager;
  private registry?: AgentRegistry;
  private extraDirsResolver?: (groupId: string) => string[];
  private sharedMcpResolver?: (input: {
    agent: AgentId;
    role: "lead" | "sub";
    cwd: string;
    httpSupported: boolean;
  }) => Array<Record<string, unknown>>;
  private elicitationHandler?: ElicitationBridgeHandler;
  /** Warm starts still in flight that no turn has claimed yet. */
  private warmPending = new Set<string>();
  /** Warmed sessions that never ran a turn: sessionKey -> ready timestamp (insertion order = age). */
  private warmUnused = new Map<string, number>();
  private warmSweepTimer?: NodeJS.Timeout;
  private readonly warmIdleMs = readPositiveIntEnv("AGENT_HUB_WARM_IDLE_MS", DEFAULT_WARM_IDLE_MS);
  private readonly maxWarmUnused = readPositiveIntEnv(
    "AGENT_HUB_WARM_MAX_UNUSED",
    MAX_WARM_UNUSED_SESSIONS,
  );

  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  setResourceManager(rm: SharedResourceManager): void {
    this.resourceManager = rm;
  }

  setAgentRegistry(reg: AgentRegistry): void {
    this.registry = reg;
  }

  setElicitationHandler(handler: ElicitationBridgeHandler): void {
    this.elicitationHandler = handler;
  }

  /** Lets the hub say which other directories a task group's sessions should have access to. */
  /** Supplies the user's shared MCP servers for a new session (see hub/mcp-servers.ts). */
  setSharedMcpResolver(
    resolver: (input: { agent: AgentId; role: "lead" | "sub"; cwd: string; httpSupported: boolean }) => Array<Record<string, unknown>>,
  ): void {
    this.sharedMcpResolver = resolver;
  }

  setExtraDirsResolver(resolver: (groupId: string) => string[]): void {
    this.extraDirsResolver = resolver;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.emitEvent({
      type: "permission_mode_changed",
      permissionMode: mode,
      timestamp: Date.now(),
    });
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s.record }));
  }

  getSession(sessionKey: string): SessionRecord | undefined {
    const entry = this.sessions.get(sessionKey);
    return entry ? { ...entry.record } : undefined;
  }

  getPendingPermissions(): PendingPermission[] {
    return [...this.pendingPermissions.values()].map((w) => ({ ...w.info }));
  }

  resolvePermission(requestId: string, optionId: string | "cancel"): boolean {
    const waiter = this.pendingPermissions.get(requestId);
    if (!waiter) {
      return false;
    }
    this.pendingPermissions.delete(requestId);
    if (optionId === "cancel") {
      waiter.resolve({ outcome: { outcome: "cancelled" } });
    } else {
      waiter.resolve({
        outcome: { outcome: "selected", optionId },
      });
    }
    this.emitEvent({
      type: "permission_resolved",
      requestId,
      outcome: optionId,
      timestamp: Date.now(),
    });
    return true;
  }

  private emitEvent(event: HubEvent): void {
    this.emit("hub_event", event);
  }

  private syncCatalogToManaged(
    managed: ManagedSession,
    catalog: AgentModelCatalog,
    emitEvent = true,
  ): void {
    managed.modelCatalog = catalog;
    managed.record.modelCatalog = catalog;
    if (catalog.currentModelId) {
      managed.record.currentModelId = catalog.currentModelId;
    }
    if (catalog.effort?.currentValue) {
      managed.record.currentEffort = catalog.effort.currentValue;
    }
    if (catalog.models.length > 0 || catalog.effort) {
      this.registry?.updateModelCatalog(catalog);
      if (emitEvent) {
        this.emitEvent({
          type: "models_updated",
          agent: managed.record.agent,
          catalog,
          timestamp: Date.now(),
        });
      }
    }
  }

  private async applySessionSelection(
    managed: ManagedSession,
    desiredModel?: string,
    desiredEffort?: string,
  ): Promise<void> {
    if (!managed.record.acpSessionId) {
      throw new Error(`Session ${managed.record.sessionKey} has no ACP session ID yet.`);
    }

    const modelId = desiredModel?.trim();
    const effort = desiredEffort?.trim();
    let changed = false;

    if (modelId && modelId !== managed.record.currentModelId) {
      const catalog = managed.modelCatalog;
      if (catalog?.modelControl === "config_option" && catalog.modelConfigId) {
        const resp = await managed.conn.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: managed.record.acpSessionId,
          configId: catalog.modelConfigId,
          value: modelId,
        });
        const updated = extractModelCatalogFromConfigOptions(
          managed.record.agent,
          (resp as { configOptions?: unknown } | undefined)?.configOptions,
          catalog,
        );
        if (!updated.currentModelId) {
          updated.currentModelId = modelId;
        }
        this.syncCatalogToManaged(managed, updated, true);
        managed.record.currentModelId = updated.currentModelId ?? modelId;
        changed = true;
      } else if (catalog?.modelControl === "legacy_set_model") {
        await (
          managed.conn.agent as unknown as {
            request: (method: string, params: unknown) => Promise<unknown>;
          }
        ).request("session/set_model", {
          sessionId: managed.record.acpSessionId,
          modelId,
        });
        const updated: AgentModelCatalog = {
          ...catalog,
          currentModelId: modelId,
          updatedAt: Date.now(),
        };
        this.syncCatalogToManaged(managed, updated, true);
        managed.record.currentModelId = modelId;
        changed = true;
      } else {
        const resp = await managed.conn.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: managed.record.acpSessionId,
          configId: "model",
          value: modelId,
        });
        const updated = extractModelCatalogFromConfigOptions(
          managed.record.agent,
          (resp as { configOptions?: unknown } | undefined)?.configOptions,
          catalog,
        );
        if (!updated.currentModelId) {
          updated.currentModelId = modelId;
        }
        this.syncCatalogToManaged(managed, updated, true);
        managed.record.currentModelId = updated.currentModelId ?? modelId;
        changed = true;
      }
    }

    const effortCfg = managed.modelCatalog?.effort;
    if (effort && effortCfg) {
      const validOption =
        effortCfg.options.length === 0 || effortCfg.options.some((o) => o.id === effort);
      if (validOption && effort !== effortCfg.currentValue) {
        const resp = await managed.conn.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: managed.record.acpSessionId,
          configId: effortCfg.configId,
          value: effort,
        });
        const updated = extractModelCatalogFromConfigOptions(
          managed.record.agent,
          (resp as { configOptions?: unknown } | undefined)?.configOptions,
          managed.modelCatalog,
        );
        this.syncCatalogToManaged(managed, updated, true);
        managed.record.currentEffort = updated.effort?.currentValue ?? effort;
        changed = true;
      }
    }

    if (changed) {
      managed.record.updatedAt = Date.now();
      this.emitEvent({
        type: "session_updated",
        session: { ...managed.record },
        timestamp: managed.record.updatedAt,
      });
    }
  }

  /**
   * Switches model and/or thinking effort on a live ACP session via session/set_config_option.
   */
  async setSessionModel(
    sessionKey: string,
    modelId?: string,
    effort?: string,
  ): Promise<SessionRecord> {
    const managed = this.sessions.get(sessionKey);
    if (!managed || managed.child.exitCode !== null || managed.conn.signal.aborted) {
      throw new Error(`Active session not found: ${sessionKey}`);
    }
    const run = managed.queue.then(async () => {
      await this.applySessionSelection(managed, modelId, effort);
      return { ...managed.record };
    });
    managed.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Starts a session ahead of the first user message so that turn skips process spawn + handshake.
   * Options must match what the first runTurn will pass, since the session is reused as created.
   * Returns immediately; a failed warm start is logged and the next runTurn simply starts again.
   */
  warmSession(options: WarmSessionOptions): WarmSessionResult {
    const sessionKey = buildSessionKey(options.agent, options.sessionName);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.record.status !== "closed" && existing.record.status !== "error") {
      return { sessionKey, skipped: "session_exists" };
    }
    if (this.startingSessions.has(sessionKey)) {
      return { sessionKey, skipped: "session_starting" };
    }

    this.warmPending.add(sessionKey);
    this.enforceWarmLimit();
    const ready = this.ensureSession(toEnsureSessionOptions(options)).then(
      () => {
        // Still unclaimed: no turn arrived while starting, so track it for idle reclaim.
        if (this.warmPending.delete(sessionKey)) {
          this.warmUnused.set(sessionKey, Date.now());
          this.enforceWarmLimit();
          this.scheduleWarmSweep();
        }
        return true;
      },
      (err: unknown) => {
        this.warmPending.delete(sessionKey);
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("SESSION_CANCELLED_BY_USER")) {
          console.warn(`[acp-pool] warm start failed for ${sessionKey}: ${message}`);
        }
        return false;
      },
    );
    return { sessionKey, ready };
  }

  /**
   * Drops a warmed session that never ran a turn (ready or still starting).
   * Sessions that have run a turn, or were not created by warmSession, are left alone.
   */
  async discardWarmSession(sessionKey: string): Promise<boolean> {
    if (this.warmUnused.has(sessionKey)) {
      return this.closeSession(sessionKey);
    }
    if (this.warmPending.delete(sessionKey)) {
      // session/new may already have returned while model selection is still running.
      return this.sessions.has(sessionKey)
        ? this.closeSession(sessionKey)
        : this.cancelSession(sessionKey);
    }
    return false;
  }

  /** A turn is about to use this session: it is no longer subject to warm reclaim. */
  private claimWarmSession(sessionKey: string): void {
    this.warmPending.delete(sessionKey);
    this.warmUnused.delete(sessionKey);
  }

  private enforceWarmLimit(): void {
    while (
      this.warmUnused.size > 0 &&
      this.warmUnused.size + this.warmPending.size > this.maxWarmUnused
    ) {
      const oldest = this.warmUnused.keys().next().value as string;
      this.warmUnused.delete(oldest);
      void this.closeSession(oldest);
    }
  }

  private scheduleWarmSweep(): void {
    if (this.warmSweepTimer || this.warmUnused.size === 0) {
      return;
    }
    const interval = Math.max(1_000, Math.min(30_000, Math.floor(this.warmIdleMs / 4)));
    this.warmSweepTimer = setInterval(() => this.sweepWarmSessions(), interval);
    this.warmSweepTimer.unref();
  }

  private sweepWarmSessions(): void {
    const now = Date.now();
    for (const [sessionKey, readyAt] of [...this.warmUnused]) {
      const managed = this.sessions.get(sessionKey);
      if (!managed || managed.record.status === "closed" || managed.record.status === "error") {
        this.warmUnused.delete(sessionKey);
      } else if (now - readyAt >= this.warmIdleMs) {
        void this.closeSession(sessionKey);
      }
    }
    if (this.warmUnused.size === 0) {
      this.stopWarmSweep();
    }
  }

  private stopWarmSweep(): void {
    if (this.warmSweepTimer) {
      clearInterval(this.warmSweepTimer);
      this.warmSweepTimer = undefined;
    }
  }

  private async ensureSession(options: EnsureSessionOptions): Promise<ManagedSession> {
    const sessionKey = buildSessionKey(options.agent, options.sessionName);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.record.status !== "closed" && existing.record.status !== "error") {
      if (options.parentSessionKey && !existing.record.parentSessionKey) {
        existing.record.parentSessionKey = options.parentSessionKey;
      }
      return existing;
    }
    if (existing) {
      await this.closeSession(sessionKey);
    }

    const inflight = this.startingSessions.get(sessionKey);
    if (inflight) {
      return inflight;
    }

    const startPromise = this.createSession(sessionKey, options);
    this.startingSessions.set(sessionKey, startPromise);
    try {
      return await startPromise;
    } finally {
      this.startingSessions.delete(sessionKey);
    }
  }

  /**
   * Builds the text sent as session/new systemPrompt: workbench guide + bridged shared resources.
   * Conditions mirror the first-turn prefix logic in runTurn so both paths inject the same content.
   */
  private buildSystemInjection(
    options: EnsureSessionOptions,
    record: SessionRecord,
  ): {
    text: string;
    injectedTokens: number;
    breakdown: SessionContextBreakdown;
    resources: boolean;
    guide: boolean;
  } {
    const breakdown = createEmptyContextBreakdown();
    let text = "";
    let injectedTokens = 0;
    let resources = false;
    if (options.injectSharedResources && this.resourceManager) {
      const inj = this.resourceManager.buildInjectionForAgent(record.agent, record.effectiveCwd);
      breakdown.sharedRulesTokens = inj.sharedRulesTokens;
      breakdown.skillsIndexTokens = inj.skillsIndexTokens;
      breakdown.injectedRules = inj.injectedRules;
      breakdown.droppedRules = inj.droppedRules;
      breakdown.injectedSkillsCount = inj.injectedSkillsCount;
      breakdown.nativeRulesCount = inj.nativeRulesCount;
      breakdown.nativeSkillsCount = inj.nativeSkillsCount;
      if (inj.promptPrefix) {
        text = inj.promptPrefix;
        injectedTokens += inj.sharedRulesTokens + inj.skillsIndexTokens;
      }
      resources = true;
    }
    if (options.injectPeerMcp) {
      const guide = buildHubWorkbenchGuide(record.role);
      text = `${guide}${text}`;
      injectedTokens += estimateTokens(guide);
    }
    return {
      text: text.trim(),
      injectedTokens,
      breakdown,
      resources,
      guide: options.injectPeerMcp,
    };
  }

  private async createSession(
    sessionKey: string,
    options: EnsureSessionOptions,
  ): Promise<ManagedSession> {
    const workspace = ensureSessionWorkspace(
      options.baseCwd,
      options.sessionName,
      options.isolateWorktree,
    );
    // spawn() reports a missing working directory as "ENOENT <executable>", which reads as if
    // the agent were not installed. Say what is actually wrong.
    if (!fs.existsSync(workspace.effectiveCwd)) {
      throw new Error(
        t("workingDirectoryDoesNotExistChooseAn", workspace.effectiveCwd),
      );
    }
    const resolvedCmd = this.registry
      ? this.registry.resolveCommand(options.agent)
      : resolveAdapterCommand(options.agent);
    const now = Date.now();
    const record: SessionRecord = {
      sessionKey,
      groupId: options.groupId ?? "grp-default",
      role: options.role ?? "lead",
      label: options.label ?? options.sessionName,
      parentSessionKey: options.parentSessionKey,
      agent: options.agent,
      name: options.sessionName,
      baseCwd: workspace.baseCwd,
      effectiveCwd: workspace.effectiveCwd,
      isWorktree: workspace.isWorktree,
      branch: workspace.branch,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };
    this.emitEvent({ type: "session_updated", session: { ...record }, timestamp: now });

    const child = spawn(resolvedCmd.command, resolvedCmd.args, {
      cwd: workspace.effectiveCwd,
      env: { ...process.env, ...resolvedCmd.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    record.pid = child.pid;
    // A command that cannot be started emits 'error' on the child; without a listener that
    // is an uncaught exception and takes the whole hub down.
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once("error", (err) =>
        reject(new Error(`Failed to start "${resolvedCmd.command}": ${err.message}`)),
      );
    });
    spawnFailed.catch(() => {});
    this.startingChildren.set(sessionKey, { child, record });
    this.cancelledStarting.delete(sessionKey);

    const stderrTail: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          stderrTail.push(line);
          if (stderrTail.length > 30) {
            stderrTail.shift();
          }
        }
      }
    });

    if (!child.stdin || !child.stdout) {
      killProcessTree(child.pid);
      throw new Error(`Failed to open stdio pipes for ${options.agent}`);
    }

    const inputWeb = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const outputWeb = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const stream = acp.ndJsonStream(outputWeb, inputWeb);

    const clientApp = acp.client({ name: `agent-hub-${sessionKey}` });
    clientApp.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      return this.handlePermissionRequest(sessionKey, options.agent, params);
    });
    clientApp.onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
      if (!this.elicitationHandler) {
        return { action: "decline" };
      }
      return this.elicitationHandler({
        sessionKey,
        groupId: record.groupId,
        agent: options.agent,
        request: params,
      });
    });

    const conn = clientApp.connect(stream);

    child.once("exit", (code, signal) => {
      const current = this.sessions.get(sessionKey);
      if (current && current.child === child && current.record.status !== "closed") {
        current.record.status = code === 0 ? "closed" : "error";
        current.record.updatedAt = Date.now();
        if (code !== 0) {
          const tail = stderrTail.slice(-5).join(" | ");
          current.record.lastError = `Exited with code=${code} signal=${signal}${tail ? ` (${tail})` : ""}`;
        }
        this.emitEvent({
          type: "session_updated",
          session: { ...current.record },
          timestamp: Date.now(),
        });
      }
    });

    try {
      const initResp = await Promise.race([
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "agent-hub", version: "0.1.0" },
        }),
        spawnFailed,
      ]);

      const sessionCwd = path.resolve(workspace.effectiveCwd);
      // Extra project directories go in session/new when the adapter supports them; for the
      // others the hub mentions them in the first prompt instead.
      const extraDirs = initResp.agentCapabilities?.sessionCapabilities?.additionalDirectories
        ? (this.extraDirsResolver?.(record.groupId) ?? []).filter((dir) => path.resolve(dir) !== sessionCwd)
        : [];
      const startSession = (systemPromptText?: string): Promise<acp.ActiveSession> => {
        const builder =
          systemPromptText || extraDirs.length > 0
            ? conn.agent.buildSession({
                cwd: sessionCwd,
                mcpServers: [],
                ...(extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
                ...(systemPromptText
                  ? {
                      systemPrompt: {
                        mode: "append" as const,
                        content: [{ type: "text" as const, text: systemPromptText }],
                      },
                    }
                  : {}),
              })
            : conn.agent.buildSession(sessionCwd);
        if (options.injectPeerMcp && this.hubUrl) {
          const mcpLaunch = resolvePeerMcpLaunch({
            hubUrl: this.hubUrl,
            callerAgent: options.agent,
            callerSession: sessionKey,
            depth: options.callDepth,
            groupId: record.groupId,
          });
          builder.withMcpServer({
            name: "agent-hub-peers",
            command: mcpLaunch.command,
            args: mcpLaunch.args,
            env: [],
          });
          // Shared servers ride along with the workbench tools; throwaway sessions (no peer
          // MCP) get neither.
          const caps = initResp.agentCapabilities as { mcpCapabilities?: { http?: boolean } } | undefined;
          try {
            for (const server of this.sharedMcpResolver?.({
              agent: options.agent,
              role: record.role,
              cwd: options.baseCwd,
              httpSupported: Boolean(caps?.mcpCapabilities?.http),
            }) ?? []) {
              builder.withMcpServer(server as never);
            }
          } catch {
            // A broken shared-server list must not stop the session from starting.
          }
        }
        return builder.start();
      };

      // Hub rules and the workbench guide go through session/new systemPrompt when the adapter
      // advertises it, keeping the first user message clean (slash commands, prompt caching).
      // Otherwise runTurn prepends them to the first prompt.
      const systemInjection =
        initResp.agentCapabilities?.sessionCapabilities?.systemPrompt &&
        process.env.AGENT_HUB_DISABLE_SYSTEM_PROMPT !== "1"
          ? this.buildSystemInjection(options, record)
          : undefined;

      let activeSession: acp.ActiveSession;
      let viaSystemPrompt = false;
      if (systemInjection?.text) {
        try {
          activeSession = await startSession(systemInjection.text);
          viaSystemPrompt = true;
        } catch (err) {
          if (this.cancelledStarting.has(sessionKey)) {
            throw err;
          }
          stderrTail.push(
            `[system-prompt-fallback] ${err instanceof Error ? err.message : String(err)}`,
          );
          activeSession = await startSession();
        }
      } else {
        activeSession = await startSession();
      }
      if (this.cancelledStarting.has(sessionKey)) {
        throw new Error("SESSION_CANCELLED_BY_USER");
      }
      record.promptInjection = viaSystemPrompt ? "system" : "prefix";
      if (viaSystemPrompt && systemInjection) {
        record.contextBreakdown = systemInjection.breakdown;
      }
      record.acpSessionId = activeSession.sessionId;
      record.status = "idle";
      record.updatedAt = Date.now();

      const managed: ManagedSession = {
        record,
        child,
        conn,
        activeSession,
        queue: Promise.resolve(),
        stderrTail,
        initializeCapabilities: initResp.agentCapabilities,
        callDepth: options.callDepth,
        resourcesInjected: viaSystemPrompt && Boolean(systemInjection?.resources),
        workbenchGuideInjected: viaSystemPrompt && Boolean(systemInjection?.guide),
        pendingSystemInjectedTokens:
          viaSystemPrompt && systemInjection ? systemInjection.injectedTokens : 0,
      };
      this.sessions.set(sessionKey, managed);

      const initialCatalog = extractModelCatalogFromNewSession(
        options.agent,
        activeSession.newSessionResponse,
      );
      this.syncCatalogToManaged(managed, initialCatalog, true);

      const def = this.registry?.getDefinition(options.agent);
      const targetModel = options.model?.trim() || def?.defaultModel?.trim();
      const targetEffort = options.effort?.trim() || def?.defaultEffort?.trim();
      if (targetModel || targetEffort) {
        try {
          await this.applySessionSelection(managed, targetModel, targetEffort);
        } catch (err) {
          stderrTail.push(
            `[model-init-warn] ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (this.cancelledStarting.has(sessionKey)) {
        throw new Error("SESSION_CANCELLED_BY_USER");
      }
      this.startingChildren.delete(sessionKey);
      this.emitEvent({ type: "session_updated", session: { ...record }, timestamp: Date.now() });
      return managed;
    } catch (err) {
      this.startingChildren.delete(sessionKey);
      const wasCancelled =
        this.cancelledStarting.delete(sessionKey) ||
        (err instanceof Error && err.message.includes("SESSION_CANCELLED_BY_USER"));
      if (wasCancelled) {
        this.sessions.delete(sessionKey);
        record.status = "closed";
        record.lastError = undefined;
        record.updatedAt = Date.now();
        this.emitEvent({ type: "session_updated", session: { ...record }, timestamp: Date.now() });
        try {
          conn.close();
        } catch {
          // ignore
        }
        killProcessTree(child.pid);
        throw new Error("SESSION_CANCELLED_BY_USER");
      }
      record.status = "error";
      const tail = stderrTail.slice(-8).join("\n");
      record.lastError = `${err instanceof Error ? err.message : String(err)}${tail ? `\nstderr:\n${tail}` : ""}`;
      record.updatedAt = Date.now();
      this.emitEvent({ type: "session_updated", session: { ...record }, timestamp: Date.now() });
      try {
        conn.close();
      } catch {
        // ignore
      }
      killProcessTree(child.pid);
      throw new Error(`ACP session init failed for ${sessionKey}: ${record.lastError}`);
    }
  }

  private async handlePermissionRequest(
    sessionKey: string,
    agent: AgentId,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const toolKind = params.toolCall.kind ?? "other";
    const allowOption =
      params.options.find((opt) => opt.kind === "allow_once") ??
      params.options.find((opt) => opt.kind === "allow_always") ??
      params.options[0];
    const rejectOption =
      params.options.find((opt) => opt.kind === "reject_once") ??
      params.options.find((opt) => opt.kind === "reject_always");

    if (this.permissionMode === "approve-all" && allowOption) {
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }

    if (this.permissionMode === "approve-reads") {
      if (READ_ONLY_KINDS.has(toolKind) && allowOption) {
        return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
      }
      const titleLower = (params.toolCall.title ?? "").toLowerCase();
      if (titleLower.includes("peer_") && allowOption) {
        return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
      }
      // If headless without interactive UI attached, reject or wait depending on manual queue
    }

    // Manual confirmation path
    const requestId = randomUUID();
    const info: PendingPermission = {
      requestId,
      sessionKey,
      agent,
      toolTitle: params.toolCall.title ?? params.toolCall.toolCallId,
      toolKind,
      rawInput: compactToolRawInput(params.toolCall.rawInput),
      options: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      createdAt: Date.now(),
    };

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, { info, resolve });
      this.emitEvent({
        type: "permission_requested",
        permission: info,
        timestamp: Date.now(),
      });
      // Safety fallback if nobody resolves within 5 minutes
      setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          if (rejectOption) {
            resolve({ outcome: { outcome: "selected", optionId: rejectOption.optionId } });
          } else {
            resolve({ outcome: { outcome: "cancelled" } });
          }
        }
      }, 300_000).unref();
    });
  }

  /**
   * Queues and executes a prompt turn on the target agent session.
   */
  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    this.claimWarmSession(buildSessionKey(options.agent, options.sessionName));
    const managed = await this.ensureSession(toEnsureSessionOptions(options));

    const executeTurn = async (): Promise<RunTurnResult> => {
      const wantModel = options.model?.trim();
      const wantEffort = options.effort?.trim();
      if (
        (wantModel && wantModel !== managed.record.currentModelId) ||
        (wantEffort && wantEffort !== managed.record.currentEffort)
      ) {
        await this.applySessionSelection(managed, wantModel, wantEffort);
      }

      if (!managed.record.contextBreakdown) {
        managed.record.contextBreakdown = createEmptyContextBreakdown();
      }
      if (!managed.record.tokenTotals) {
        managed.record.tokenTotals = createEmptyUsageTotals();
      }

      let effectivePrompt = options.prompt;
      // Rules already sent via systemPrompt still count toward the first turn's injected tokens.
      let turnInjectedTokens =
        (options.handoffTokens ?? 0) + managed.pendingSystemInjectedTokens;
      managed.pendingSystemInjectedTokens = 0;
      const shouldInject = options.injectSharedResources ?? Boolean(options.role);

      if (!managed.resourcesInjected && shouldInject && this.resourceManager) {
        const inj = this.resourceManager.buildInjectionForAgent(
          managed.record.agent,
          managed.record.effectiveCwd,
        );
        managed.record.contextBreakdown.sharedRulesTokens = inj.sharedRulesTokens;
        managed.record.contextBreakdown.skillsIndexTokens = inj.skillsIndexTokens;
        managed.record.contextBreakdown.injectedRules = inj.injectedRules;
        managed.record.contextBreakdown.droppedRules = inj.droppedRules;
        managed.record.contextBreakdown.injectedSkillsCount = inj.injectedSkillsCount;
        managed.record.contextBreakdown.nativeRulesCount = inj.nativeRulesCount;
        managed.record.contextBreakdown.nativeSkillsCount = inj.nativeSkillsCount;
        if (inj.promptPrefix) {
          effectivePrompt = `${inj.promptPrefix}${effectivePrompt}`;
          turnInjectedTokens += inj.sharedRulesTokens + inj.skillsIndexTokens;
        }
        managed.resourcesInjected = true;
      }

      if (!managed.workbenchGuideInjected && (options.injectPeerMcp ?? true)) {
        const guide = buildHubWorkbenchGuide(managed.record.role);
        effectivePrompt = `${guide}${effectivePrompt}`;
        turnInjectedTokens += estimateTokens(guide);
        managed.workbenchGuideInjected = true;
      }

      const attachedImages = options.images ?? [];
      const initCaps = managed.initializeCapabilities as
        | { promptCapabilities?: { image?: boolean } }
        | undefined;
      const supportsNativeImage = Boolean(initCaps?.promptCapabilities?.image);

      let promptPayload: string | acp.ContentBlock[] = effectivePrompt;
      if (attachedImages.length > 0 && supportsNativeImage) {
        const pathHint = attachedImages
          .map((img) => `${img.localPath} (${img.mimeType})`)
          .join(", ");
        const textWithHint = `${effectivePrompt}\n\n[Attached local image file(s): ${pathHint}]`;
        promptPayload = [
          ...attachedImages.map((img) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
          { type: "text" as const, text: textWithHint },
        ];
      } else if (attachedImages.length > 0) {
        const imgLines = attachedImages.map(
          (img) => `- ${img.localPath} (${img.name}, ${img.mimeType})`,
        );
        promptPayload = `${effectivePrompt}\n\n<attached_images>\nThe user attached ${attachedImages.length} local image file(s). Read/inspect these file paths directly:\n${imgLines.join("\n")}\n</attached_images>`;
      }

      managed.record.contextBreakdown.handoffTokens += options.handoffTokens ?? 0;
      managed.record.contextBreakdown.userPromptsTokens += estimateTokens(
        options.rawUserPrompt ?? options.prompt,
      );

      managed.record.status = "busy";
      managed.record.updatedAt = Date.now();
      this.emitEvent({
        type: "session_updated",
        session: { ...managed.record },
        timestamp: Date.now(),
      });

      let outputText = "";
      let thoughtText = "";
      let latestCostUsd: number | undefined;
      let latestModelId: string | undefined;
      const peerToolsCalled: string[] = [];

      const promptPromise = managed.activeSession.prompt(promptPayload);
      // Prevent unhandled rejection if draining loop throws first
      void promptPromise.catch(() => {});

      try {
        let stopReason = "end_turn";
        for (;;) {
          const msg = await managed.activeSession.nextUpdate();
          if (msg.kind === "stop") {
            stopReason = msg.stopReason;
            break;
          }
          const update = msg.update;
          if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "text" && update.content.text) {
              outputText += update.content.text;
              this.emitEvent({
                type: "agent_chunk",
                sessionKey: managed.record.sessionKey,
                groupId: managed.record.groupId,
                agent: managed.record.agent,
                channel: "message",
                text: update.content.text,
                timestamp: Date.now(),
              });
            }
          } else if (update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type === "text" && update.content.text) {
              thoughtText += update.content.text;
              this.emitEvent({
                type: "agent_chunk",
                sessionKey: managed.record.sessionKey,
                groupId: managed.record.groupId,
                agent: managed.record.agent,
                channel: "thought",
                text: update.content.text,
                timestamp: Date.now(),
              });
            }
          } else if (update.sessionUpdate === "tool_call") {
            const title = update.title || update.name || update.toolCallId;
            managed.record.lastTool = title;
            if (title.includes("peer_") || (update.name && update.name.includes("peer_"))) {
              peerToolsCalled.push(update.name || title);
            }
            const extracted = extractToolOutputs(
              (update as { content?: unknown }).content,
              (update as { rawOutput?: unknown }).rawOutput,
            );
            this.emitEvent({
              type: "tool_event",
              sessionKey: managed.record.sessionKey,
              groupId: managed.record.groupId,
              agent: managed.record.agent,
              toolCallId: update.toolCallId,
              title,
              kind: update.kind,
              status: update.status,
              rawInput: compactToolRawInput(update.rawInput),
              locations: update.locations ?? undefined,
              outputText: extracted.outputText,
              outputTruncated: extracted.outputTruncated,
              diffs: extracted.diffs,
              timestamp: Date.now(),
            });
          } else if (update.sessionUpdate === "tool_call_update") {
            const extracted = extractToolOutputs(
              (update as { content?: unknown }).content,
              (update as { rawOutput?: unknown }).rawOutput,
            );
            this.emitEvent({
              type: "tool_event",
              sessionKey: managed.record.sessionKey,
              groupId: managed.record.groupId,
              agent: managed.record.agent,
              toolCallId: update.toolCallId,
              title: update.title || managed.record.lastTool || update.toolCallId,
              kind: update.kind ?? undefined,
              status: update.status ?? undefined,
              rawInput: compactToolRawInput(update.rawInput),
              locations: update.locations ?? undefined,
              outputText: extracted.outputText,
              outputTruncated: extracted.outputTruncated,
              diffs: extracted.diffs,
              timestamp: Date.now(),
            });
          } else if ((update as { sessionUpdate?: string }).sessionUpdate === "available_commands_update") {
            const rawCmds = (
              update as {
                availableCommands?: Array<{
                  name?: unknown;
                  description?: unknown;
                  input?: { hint?: unknown } | null;
                }>;
              }
            ).availableCommands;
            if (Array.isArray(rawCmds)) {
              const parsedCommands: SessionSlashCommand[] = [];
              for (const cmd of rawCmds) {
                if (typeof cmd?.name !== "string") continue;
                const cleanName = cmd.name.trim().replace(/^\/+/, "");
                if (!cleanName) continue;
                parsedCommands.push({
                  name: cleanName,
                  description: typeof cmd.description === "string" ? cmd.description.trim() : "",
                  hint: typeof cmd.input?.hint === "string" && cmd.input.hint.trim() ? cmd.input.hint.trim() : undefined,
                });
                if (parsedCommands.length >= 80) break;
              }
              managed.record.availableCommands = parsedCommands;
              managed.record.updatedAt = Date.now();
              this.emitEvent({
                type: "session_updated",
                session: { ...managed.record },
                timestamp: managed.record.updatedAt,
              });
            }
          } else if (update.sessionUpdate === "plan") {
            // The agent's own plan (TodoWrite, codex plan). Each update carries the full list.
            managed.record.plan = (update.entries ?? []).map((entry) => ({
              content: entry.content,
              status: entry.status,
              priority: entry.priority,
            }));
            managed.record.updatedAt = Date.now();
            this.emitEvent({
              type: "session_updated",
              session: { ...managed.record },
              timestamp: managed.record.updatedAt,
            });
          } else if (update.sessionUpdate === "usage_update") {
            const rawUpdate = update as {
              used?: number;
              size?: number;
              cost?: { amount?: number; currency?: string };
              _meta?: Record<string, unknown>;
            };
            const used = rawUpdate.used;
            const size = rawUpdate.size;
            if (typeof rawUpdate.cost?.amount === "number") {
              latestCostUsd = rawUpdate.cost.amount;
            }
            const metaModel = rawUpdate._meta?.["_claude/model"];
            if (typeof metaModel === "string" && metaModel.trim()) {
              latestModelId = metaModel.trim();
            }
            managed.record.usage = {
              usedTokens: typeof used === "number" ? used : managed.record.usage?.usedTokens,
              maxTokens: typeof size === "number" ? size : managed.record.usage?.maxTokens,
            };
            this.emitEvent({
              type: "session_updated",
              session: { ...managed.record },
              timestamp: Date.now(),
            });
          } else if ((update as { sessionUpdate?: string }).sessionUpdate === "config_option_update") {
            const cfgOpts = (update as { configOptions?: unknown }).configOptions;
            if (Array.isArray(cfgOpts)) {
              const refreshed = extractModelCatalogFromConfigOptions(
                managed.record.agent,
                cfgOpts,
                managed.modelCatalog,
              );
              this.syncCatalogToManaged(managed, refreshed, true);
              managed.record.updatedAt = Date.now();
              this.emitEvent({
                type: "session_updated",
                session: { ...managed.record },
                timestamp: managed.record.updatedAt,
              });
            }
          }
        }

        let promptResp: acp.PromptResponse | undefined;
        try {
          promptResp = await Promise.race([
            promptPromise,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
          ]);
        } catch {
          promptResp = undefined;
        }

        const turnUsage = buildTurnUsage({
          promptResp,
          effectivePrompt,
          outputText,
          thoughtText,
          contextUsedTokens: managed.record.usage?.usedTokens,
          contextMaxTokens: managed.record.usage?.maxTokens,
          costUsd: latestCostUsd,
          modelId: latestModelId ?? managed.record.currentModelId,
        });

        managed.record.contextBreakdown.agentOutputsTokens += estimateTokens(
          outputText + thoughtText,
        );
        const totals = managed.record.tokenTotals;
        totals.turns += 1;
        totals.inputTokens += turnUsage.inputTokens;
        totals.outputTokens += turnUsage.outputTokens;
        totals.cachedReadTokens += turnUsage.cachedReadTokens;
        totals.cachedWriteTokens += turnUsage.cachedWriteTokens;
        totals.thoughtTokens += turnUsage.thoughtTokens;
        totals.totalTokens += turnUsage.totalTokens;
        if (typeof turnUsage.costUsd === "number") {
          totals.costUsd = turnUsage.costUsd;
        }
        if (turnUsage.modelId) {
          totals.modelId = turnUsage.modelId;
        }

        managed.record.status = "idle";
        managed.record.updatedAt = Date.now();
        this.emitEvent({
          type: "session_updated",
          session: { ...managed.record },
          timestamp: Date.now(),
        });

        return {
          sessionKey: managed.record.sessionKey,
          effectiveCwd: managed.record.effectiveCwd,
          isWorktree: managed.record.isWorktree,
          branch: managed.record.branch,
          outputText,
          stopReason,
          peerToolsCalled,
          usage: turnUsage,
          injectedTokens: turnInjectedTokens,
        };
      } catch (err) {
        managed.record.status = "error";
        managed.record.lastError = err instanceof Error ? err.message : String(err);
        managed.record.updatedAt = Date.now();
        this.emitEvent({
          type: "session_updated",
          session: { ...managed.record },
          timestamp: Date.now(),
        });
        throw err;
      }
    };

    const runResultPromise = managed.queue.then(executeTurn, executeTurn);
    managed.queue = runResultPromise.then(
      () => undefined,
      () => undefined,
    );
    return runResultPromise;
  }

  /**
   * Sends a cooperative ACP session/cancel notification to a busy session,
   * or terminates an initializing child process if it is still starting.
   */
  async cancelSession(sessionKey: string): Promise<boolean> {
    const managed = this.sessions.get(sessionKey);
    if (managed && managed.record.acpSessionId) {
      await managed.conn.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: managed.record.acpSessionId,
      });
      return true;
    }
    const starting = this.startingChildren.get(sessionKey);
    if (starting) {
      this.cancelledStarting.add(sessionKey);
      killProcessTree(starting.child.pid);
      return true;
    }
    return false;
  }

  /**
   * Closes a single ACP session and terminates its child process tree.
   */
  async closeSession(sessionKey: string): Promise<boolean> {
    const managed = this.sessions.get(sessionKey);
    if (!managed) {
      return false;
    }
    this.sessions.delete(sessionKey);
    this.warmUnused.delete(sessionKey);
    managed.record.status = "closed";
    managed.record.updatedAt = Date.now();
    try {
      managed.activeSession.dispose();
    } catch {
      // ignore
    }
    try {
      managed.conn.close();
    } catch {
      // ignore
    }
    killProcessTree(managed.child.pid);
    this.emitEvent({
      type: "session_updated",
      session: { ...managed.record },
      timestamp: Date.now(),
    });
    return true;
  }

  async disposeAll(): Promise<void> {
    this.stopWarmSweep();
    this.warmPending.clear();
    // Warm starts may still be mid-handshake; kill them so no adapter process outlives the hub.
    for (const key of [...this.startingChildren.keys()]) {
      await this.cancelSession(key).catch(() => false);
    }
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((key) => this.closeSession(key)));
  }
}

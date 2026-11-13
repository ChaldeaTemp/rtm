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
import { estimateTokens, type SharedResourceManager } from "./resources.js";
import { ensureSessionWorkspace } from "./worktree.js";

const READ_ONLY_KINDS = new Set(["read", "search", "think"]);

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
  modelCatalog?: AgentModelCatalog;
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
  private pendingPermissions = new Map<string, PendingPermissionWaiter>();
  private permissionMode: PermissionMode = "approve-all";
  private hubUrl = "";
  private resourceManager?: SharedResourceManager;
  private registry?: AgentRegistry;

  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  setResourceManager(rm: SharedResourceManager): void {
    this.resourceManager = rm;
  }

  setAgentRegistry(reg: AgentRegistry): void {
    this.registry = reg;
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

  private async ensureSession(options: {
    agent: AgentId;
    sessionName: string;
    baseCwd: string;
    isolateWorktree: boolean;
    callDepth: number;
    injectPeerMcp: boolean;
    groupId?: string;
    role?: "lead" | "sub";
    label?: string;
    parentSessionKey?: string;
    model?: string;
    effort?: string;
  }): Promise<ManagedSession> {
    const sessionKey = buildSessionKey(options.agent, options.sessionName);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.record.status !== "closed" && existing.record.status !== "error") {
      if (options.parentSessionKey && !existing.record.parentSessionKey) {
        existing.record.parentSessionKey = options.parentSessionKey;
      }
      return existing;
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

  private async createSession(
    sessionKey: string,
    options: {
      agent: AgentId;
      sessionName: string;
      baseCwd: string;
      isolateWorktree: boolean;
      callDepth: number;
      injectPeerMcp: boolean;
      groupId?: string;
      role?: "lead" | "sub";
      label?: string;
      parentSessionKey?: string;
      model?: string;
      effort?: string;
    },
  ): Promise<ManagedSession> {
    const workspace = ensureSessionWorkspace(
      options.baseCwd,
      options.sessionName,
      options.isolateWorktree,
    );
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
      const initResp = await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-hub", version: "0.1.0" },
      });

      const builder = conn.agent.buildSession(path.resolve(workspace.effectiveCwd));
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
      }

      const activeSession = await builder.start();
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
        resourcesInjected: false,
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

      this.emitEvent({ type: "session_updated", session: { ...record }, timestamp: Date.now() });
      return managed;
    } catch (err) {
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
      rawInput: params.toolCall.rawInput,
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
    const managed = await this.ensureSession({
      agent: options.agent,
      sessionName: options.sessionName,
      baseCwd: options.baseCwd,
      isolateWorktree: Boolean(options.isolateWorktree),
      callDepth: options.callDepth ?? 0,
      injectPeerMcp: options.injectPeerMcp ?? true,
      groupId: options.groupId,
      role: options.role,
      label: options.label,
      parentSessionKey: options.parentSessionKey,
      model: options.model,
      effort: options.effort,
    });

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
      let turnInjectedTokens = options.handoffTokens ?? 0;
      const shouldInject = options.injectSharedResources ?? Boolean(options.role);

      if (!managed.resourcesInjected && shouldInject && this.resourceManager) {
        const inj = this.resourceManager.buildInjectionForAgent(
          managed.record.agent,
          managed.record.effectiveCwd,
        );
        managed.record.contextBreakdown.sharedRulesTokens = inj.sharedRulesTokens;
        managed.record.contextBreakdown.skillsIndexTokens = inj.skillsIndexTokens;
        managed.record.contextBreakdown.injectedRules = inj.injectedRules;
        managed.record.contextBreakdown.injectedSkillsCount = inj.injectedSkillsCount;
        managed.record.contextBreakdown.nativeRulesCount = inj.nativeRulesCount;
        managed.record.contextBreakdown.nativeSkillsCount = inj.nativeSkillsCount;
        if (inj.promptPrefix) {
          effectivePrompt = `${inj.promptPrefix}${effectivePrompt}`;
          turnInjectedTokens += inj.sharedRulesTokens + inj.skillsIndexTokens;
        }
        managed.resourcesInjected = true;
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

      const promptPromise = managed.activeSession.prompt(effectivePrompt);
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
            this.emitEvent({
              type: "tool_event",
              sessionKey: managed.record.sessionKey,
              groupId: managed.record.groupId,
              agent: managed.record.agent,
              toolCallId: update.toolCallId,
              title,
              kind: update.kind,
              status: update.status,
              rawInput: update.rawInput,
              timestamp: Date.now(),
            });
          } else if (update.sessionUpdate === "tool_call_update") {
            this.emitEvent({
              type: "tool_event",
              sessionKey: managed.record.sessionKey,
              groupId: managed.record.groupId,
              agent: managed.record.agent,
              toolCallId: update.toolCallId,
              title: update.title || managed.record.lastTool || update.toolCallId,
              kind: update.kind ?? undefined,
              status: update.status ?? undefined,
              rawInput: update.rawInput,
              timestamp: Date.now(),
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
   * Sends a cooperative ACP session/cancel notification to a busy session.
   */
  async cancelSession(sessionKey: string): Promise<boolean> {
    const managed = this.sessions.get(sessionKey);
    if (!managed || !managed.record.acpSessionId) {
      return false;
    }
    await managed.conn.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: managed.record.acpSessionId,
    });
    return true;
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
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((key) => this.closeSession(key)));
  }
}

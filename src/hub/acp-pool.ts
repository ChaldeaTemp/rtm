import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentId,
  HubEvent,
  PendingPermission,
  PermissionMode,
  SessionRecord,
} from "../types.js";
import {
  killProcessTree,
  resolveAdapterCommand,
  resolvePeerMcpLaunch,
} from "./process-tree.js";
import { ensureSessionWorkspace } from "./worktree.js";

const READ_ONLY_KINDS = new Set(["read", "search", "think"]);

interface ManagedSession {
  record: SessionRecord;
  child: ChildProcess;
  conn: acp.ClientConnection;
  activeSession: acp.ActiveSession;
  queue: Promise<void>;
  stderrTail: string[];
  initializeCapabilities?: unknown;
  callDepth: number;
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
  isolateWorktree?: boolean;
  callDepth?: number;
  injectPeerMcp?: boolean;
}

export interface RunTurnResult {
  sessionKey: string;
  effectiveCwd: string;
  isWorktree: boolean;
  branch?: string;
  outputText: string;
  stopReason: string;
  peerToolsCalled: string[];
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

  setHubUrl(url: string): void {
    this.hubUrl = url;
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

  private async ensureSession(options: {
    agent: AgentId;
    sessionName: string;
    baseCwd: string;
    isolateWorktree: boolean;
    callDepth: number;
    injectPeerMcp: boolean;
  }): Promise<ManagedSession> {
    const sessionKey = buildSessionKey(options.agent, options.sessionName);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.record.status !== "closed" && existing.record.status !== "error") {
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
    },
  ): Promise<ManagedSession> {
    const workspace = ensureSessionWorkspace(
      options.baseCwd,
      options.sessionName,
      options.isolateWorktree,
    );
    const resolvedCmd = resolveAdapterCommand(options.agent);
    const now = Date.now();
    const record: SessionRecord = {
      sessionKey,
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
      };
      this.sessions.set(sessionKey, managed);
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
    });

    const executeTurn = async (): Promise<RunTurnResult> => {
      managed.record.status = "busy";
      managed.record.updatedAt = Date.now();
      this.emitEvent({
        type: "session_updated",
        session: { ...managed.record },
        timestamp: Date.now(),
      });

      let outputText = "";
      const peerToolsCalled: string[] = [];

      const promptPromise = managed.activeSession.prompt(options.prompt);
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
                agent: managed.record.agent,
                channel: "message",
                text: update.content.text,
                timestamp: Date.now(),
              });
            }
          } else if (update.sessionUpdate === "agent_thought_chunk") {
            if (update.content.type === "text" && update.content.text) {
              this.emitEvent({
                type: "agent_chunk",
                sessionKey: managed.record.sessionKey,
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
              agent: managed.record.agent,
              toolCallId: update.toolCallId,
              title: update.title || managed.record.lastTool || update.toolCallId,
              kind: update.kind ?? undefined,
              status: update.status ?? undefined,
              rawInput: update.rawInput,
              timestamp: Date.now(),
            });
          } else if (update.sessionUpdate === "usage_update") {
            const used = (update as { used?: number }).used;
            const size = (update as { size?: number }).size;
            managed.record.usage = {
              usedTokens: typeof used === "number" ? used : managed.record.usage?.usedTokens,
              maxTokens: typeof size === "number" ? size : managed.record.usage?.maxTokens,
            };
            this.emitEvent({
              type: "session_updated",
              session: { ...managed.record },
              timestamp: Date.now(),
            });
          }
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

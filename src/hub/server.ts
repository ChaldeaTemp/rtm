import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  ALL_AGENTS,
  type AgentId,
  type HubEvent,
  type PermissionMode,
  type TaskRecord,
} from "../types.js";
import { AcpPool, buildSessionKey } from "./acp-pool.js";
import { ThreadLedger } from "./ledger.js";
import { checkAdaptersHealth, PROJECT_ROOT } from "./process-tree.js";
import { summarizeWorkspaceChanges } from "./worktree.js";

const MAX_PEER_DEPTH = 3;
const RUNTIME_FILE = path.join(PROJECT_ROOT, ".agent-hub", "runtime.json");

const AgentIdSchema = z.enum(["claude", "codex", "agy"]);
const PermissionModeSchema = z.enum(["approve-all", "approve-reads", "manual"]);

const LeadBodySchema = z.object({
  agent: AgentIdSchema,
});

const ChatBodySchema = z.object({
  prompt: z.string().min(1),
  leadAgent: AgentIdSchema.optional(),
  cwd: z.string().optional(),
  session: z.string().optional(),
});

const PeerCallBodySchema = z.object({
  targetAgent: AgentIdSchema,
  prompt: z.string().min(1),
  session: z.string().optional(),
  cwd: z.string().optional(),
  isolateWorktree: z.boolean().optional().default(false),
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

export interface HubServerOptions {
  baseCwd: string;
  port?: number;
  defaultLead?: AgentId;
  permissionMode?: PermissionMode;
  writeRuntimeFile?: boolean;
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

export class AgentHubServer {
  readonly baseCwd: string;
  readonly pool = new AcpPool();
  readonly ledger = new ThreadLedger();
  private leadAgent: AgentId;
  private tasks = new Map<string, TaskRecord>();
  private taskWaiters = new Map<string, Array<() => void>>();
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private wsClients = new Set<WebSocket>();
  private url = "";
  private port = 0;
  private writeRuntimeFile: boolean;

  constructor(options: HubServerOptions) {
    this.baseCwd = path.resolve(options.baseCwd);
    this.leadAgent = options.defaultLead ?? "claude";
    this.writeRuntimeFile = options.writeRuntimeFile ?? true;
    if (options.permissionMode) {
      this.pool.setPermissionMode(options.permissionMode);
    }

    this.pool.on("hub_event", (event: HubEvent) => {
      this.broadcast(event);
    });
  }

  getUrl(): string {
    return this.url;
  }

  getPort(): number {
    return this.port;
  }

  getLeadAgent(): AgentId {
    return this.leadAgent;
  }

  setLeadAgent(agent: AgentId): void {
    if (this.leadAgent === agent) {
      return;
    }
    const previousLead = this.leadAgent;
    this.leadAgent = agent;
    this.broadcast({
      type: "lead_changed",
      leadAgent: agent,
      previousLead,
      timestamp: Date.now(),
    });
  }

  private broadcast(event: HubEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  private createSnapshot(): HubEvent {
    return {
      type: "snapshot",
      leadAgent: this.leadAgent,
      permissionMode: this.pool.getPermissionMode(),
      baseCwd: this.baseCwd,
      sessions: this.pool.listSessions(),
      tasks: [...this.tasks.values()],
      pendingPermissions: this.pool.getPendingPermissions(),
      ledger: this.ledger.getAllTurns(),
    };
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
    prompt: string;
    leadAgent?: AgentId;
    cwd?: string;
    session?: string;
  }): Promise<{
    leadAgent: AgentId;
    sessionKey: string;
    outputText: string;
    stopReason: string;
    peerToolsCalled: string[];
  }> {
    if (input.leadAgent) {
      this.setLeadAgent(input.leadAgent);
    }
    const lead = this.leadAgent;
    const effectivePrompt = this.ledger.buildLeadPrompt(lead, input.prompt);
    const result = await this.pool.runTurn({
      agent: lead,
      sessionName: input.session ?? "main",
      baseCwd: input.cwd ?? this.baseCwd,
      prompt: effectivePrompt,
      isolateWorktree: false,
      callDepth: 0,
      injectPeerMcp: true,
    });

    const turn = this.ledger.recordTurn({
      leadAgent: lead,
      userText: input.prompt,
      assistantSummary: result.outputText,
      peerCallsSummary: result.peerToolsCalled,
    });
    this.broadcast({ type: "ledger_turn", turn, timestamp: Date.now() });

    return {
      leadAgent: lead,
      sessionKey: result.sessionKey,
      outputText: result.outputText,
      stopReason: result.stopReason,
      peerToolsCalled: result.peerToolsCalled,
    };
  }

  private validatePeerCall(body: z.infer<typeof PeerCallBodySchema>): string {
    if (body.depth >= MAX_PEER_DEPTH) {
      throw new Error(
        `Peer delegation depth limit (${MAX_PEER_DEPTH}) reached. Summarize your current findings instead of nesting further calls.`,
      );
    }
    const targetSessionName = body.session ?? `peer-${body.targetAgent}`;
    const targetSessionKey = buildSessionKey(body.targetAgent, targetSessionName);
    if (body.callerAgent === body.targetAgent && body.callerSession === targetSessionKey) {
      throw new Error(`Agent "${body.callerAgent}" cannot call itself on the same session (${targetSessionKey}).`);
    }
    return targetSessionName;
  }

  dispatchPeerTask(rawBody: unknown): TaskRecord {
    const body = PeerCallBodySchema.parse(rawBody);
    const targetSessionName = this.validatePeerCall(body);
    const targetSessionKey = buildSessionKey(body.targetAgent, targetSessionName);
    const taskId = `task-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const task: TaskRecord = {
      taskId,
      callerAgent: body.callerAgent,
      callerSession: body.callerSession,
      targetAgent: body.targetAgent,
      targetSessionKey,
      prompt: body.prompt,
      status: "running",
      isolateWorktree: body.isolateWorktree,
      outputText: "",
      createdAt: now,
      updatedAt: now,
    };
    this.updateTask(task);

    void this.pool
      .runTurn({
        agent: body.targetAgent,
        sessionName: targetSessionName,
        baseCwd: body.cwd ?? this.baseCwd,
        prompt: body.prompt,
        isolateWorktree: body.isolateWorktree,
        callDepth: body.depth + 1,
        injectPeerMcp: body.depth + 1 < MAX_PEER_DEPTH,
      })
      .then((res) => {
        task.status = res.stopReason === "cancelled" ? "cancelled" : "completed";
        task.outputText = res.outputText;
        task.worktreePath = res.isWorktree ? res.effectiveCwd : undefined;
        task.branch = res.branch;
        task.workspaceSummary = summarizeWorkspaceChanges(res.effectiveCwd);
        task.completedAt = Date.now();
        this.updateTask(task);
      })
      .catch((err) => {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = Date.now();
        this.updateTask(task);
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

  private getUiHtmlPath(): string {
    const srcHtml = path.join(PROJECT_ROOT, "src", "ui", "index.html");
    if (fs.existsSync(srcHtml)) {
      return srcHtml;
    }
    return path.join(PROJECT_ROOT, "dist", "ui", "index.html");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", this.url || "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (method === "GET" && pathname === "/") {
        const htmlPath = this.getUiHtmlPath();
        const html = fs.readFileSync(htmlPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          url: this.url,
          baseCwd: this.baseCwd,
          leadAgent: this.leadAgent,
          permissionMode: this.pool.getPermissionMode(),
          adapters: checkAdaptersHealth(),
          sessions: this.pool.listSessions(),
          agents: ALL_AGENTS,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/lead") {
        const body = LeadBodySchema.parse(await readJsonBody(req));
        this.setLeadAgent(body.agent);
        sendJson(res, 200, { ok: true, leadAgent: this.leadAgent });
        return;
      }

      if (method === "POST" && pathname === "/api/chat") {
        const body = ChatBodySchema.parse(await readJsonBody(req));
        const result = await this.runLeadChat(body);
        sendJson(res, 200, { ok: true, ...result });
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

      sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message });
    }
  }

  async start(preferredPort = 4317): Promise<string> {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;

    const wss = new WebSocketServer({ server, path: "/ws" });
    this.wss = wss;
    wss.on("connection", (ws) => {
      this.wsClients.add(ws);
      ws.send(JSON.stringify(this.createSnapshot()));
      ws.on("close", () => {
        this.wsClients.delete(ws);
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

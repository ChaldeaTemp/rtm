export type AgentId = "claude" | "codex" | "agy";

export const ALL_AGENTS: readonly AgentId[] = ["claude", "codex", "agy"] as const;

export type PermissionMode = "approve-all" | "approve-reads" | "manual";

export type SessionStatus = "starting" | "idle" | "busy" | "error" | "closed";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AdapterHealth {
  agent: AgentId;
  available: boolean;
  authReady: boolean;
  authHint?: string;
  command: string[];
  reason?: string;
}

export interface SessionRecord {
  sessionKey: string;
  agent: AgentId;
  name: string;
  baseCwd: string;
  effectiveCwd: string;
  isWorktree: boolean;
  branch?: string;
  acpSessionId?: string;
  status: SessionStatus;
  pid?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  lastTool?: string;
  usage?: {
    usedTokens?: number;
    maxTokens?: number;
  };
}

export interface TaskRecord {
  taskId: string;
  callerAgent: AgentId | "user";
  callerSession: string;
  targetAgent: AgentId;
  targetSessionKey: string;
  prompt: string;
  status: TaskStatus;
  isolateWorktree: boolean;
  worktreePath?: string;
  branch?: string;
  workspaceSummary?: string;
  outputText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface PendingPermission {
  requestId: string;
  sessionKey: string;
  agent: AgentId;
  toolTitle: string;
  toolKind?: string;
  rawInput?: unknown;
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
  createdAt: number;
}

export interface LedgerTurn {
  turnId: number;
  timestamp: number;
  leadAgent: AgentId;
  userText: string;
  assistantSummary: string;
  peerCallsSummary: string[];
}

export type HubEvent =
  | {
      type: "snapshot";
      leadAgent: AgentId;
      permissionMode: PermissionMode;
      baseCwd: string;
      sessions: SessionRecord[];
      tasks: TaskRecord[];
      pendingPermissions: PendingPermission[];
      ledger: LedgerTurn[];
    }
  | {
      type: "lead_changed";
      leadAgent: AgentId;
      previousLead: AgentId;
      timestamp: number;
    }
  | {
      type: "permission_mode_changed";
      permissionMode: PermissionMode;
      timestamp: number;
    }
  | {
      type: "session_updated";
      session: SessionRecord;
      timestamp: number;
    }
  | {
      type: "agent_chunk";
      sessionKey: string;
      agent: AgentId;
      channel: "message" | "thought";
      text: string;
      timestamp: number;
    }
  | {
      type: "tool_event";
      sessionKey: string;
      agent: AgentId;
      toolCallId: string;
      title: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      timestamp: number;
    }
  | {
      type: "task_updated";
      task: TaskRecord;
      timestamp: number;
    }
  | {
      type: "permission_requested";
      permission: PendingPermission;
      timestamp: number;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      outcome: string;
      timestamp: number;
    }
  | {
      type: "ledger_turn";
      turn: LedgerTurn;
      timestamp: number;
    };

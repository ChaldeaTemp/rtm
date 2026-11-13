export type BuiltinAgentId = "claude" | "codex" | "agy" | "opencode" | "kimi";

export type AgentId = string;

export const ALL_AGENTS: readonly AgentId[] = ["claude", "codex", "agy", "opencode", "kimi"] as const;

export interface ModelOptionItem {
  id: string;
  name: string;
  description?: string;
}

export interface EffortConfigState {
  configId: string;
  name: string;
  currentValue: string;
  options: ModelOptionItem[];
}

export interface AgentModelCatalog {
  agent: AgentId;
  modelControl?: "config_option" | "legacy_set_model";
  modelConfigId?: string;
  currentModelId?: string;
  models: ModelOptionItem[];
  effort?: EffortConfigState;
  updatedAt: number;
}

export interface AgentDefinition {
  id: AgentId;
  label: string;
  color: string;
  darkColor?: string;
  description?: string;
  enabled: boolean;
  builtin: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  defaultModel?: string;
  defaultEffort?: string;
  nativeProjectRuleFiles?: string[];
  nativeGlobalSkillDirs?: string[];
}

export type PermissionMode = "approve-all" | "approve-reads" | "manual";

export type SessionStatus = "starting" | "idle" | "busy" | "error" | "closed";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ResourceKind = "rule" | "skill";

export type ResourceScope = "project" | "global";

export interface SharedResourceItem {
  id: string;
  kind: ResourceKind;
  scope: ResourceScope;
  name: string;
  description: string;
  origin: string;
  primaryPath: string;
  sources: string[];
  nativeAgents: AgentId[];
  bridgedAgents: AgentId[];
  enabled: boolean;
  fullTokens: number;
  indexTokens: number;
  updatedAt: number;
}

export interface AgentResourceBudget {
  agent: AgentId;
  nativeRules: number;
  bridgedRules: number;
  nativeSkills: number;
  bridgedSkills: number;
  rulesTokens: number;
  skillsIndexTokens: number;
  firstTurnInjectionTokens: number;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  costUsd?: number;
  modelId?: string;
  isEstimated: boolean;
}

export interface InjectedItemSummary {
  id: string;
  name: string;
  kind: ResourceKind;
  scope: ResourceScope;
  tokens: number;
}

export interface SessionContextBreakdown {
  sharedRulesTokens: number;
  skillsIndexTokens: number;
  handoffTokens: number;
  userPromptsTokens: number;
  agentOutputsTokens: number;
  injectedRules: InjectedItemSummary[];
  injectedSkillsCount: number;
  nativeRulesCount: number;
  nativeSkillsCount: number;
}

export interface SessionUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
  modelId?: string;
}

export interface TurnTelemetryRecord {
  turnSeq: number;
  timestamp: number;
  groupId: string;
  groupTitle?: string;
  sessionKey: string;
  role: "lead" | "sub";
  agent: AgentId;
  injectedRulesTokens: number;
  injectedSkillsTokens: number;
  handoffTokens: number;
  usage: TurnUsage;
}

export interface TelemetrySnapshot {
  generatedAt: number;
  totals: SessionUsageTotals;
  byAgent: Record<string, SessionUsageTotals>;
  recentTurns: TurnTelemetryRecord[];
}

export interface AdapterHealth {
  agent: AgentId;
  label: string;
  color: string;
  darkColor?: string;
  description?: string;
  builtin: boolean;
  enabled: boolean;
  available: boolean;
  authReady: boolean;
  authHint?: string;
  command: string[];
  customCommand?: string;
  customArgs?: string[];
  defaultModel?: string;
  defaultEffort?: string;
  modelCatalog?: AgentModelCatalog;
  reason?: string;
}

export type ArtifactKind = "html" | "svg" | "mermaid";

export interface ArtifactRecord {
  artifactId: string;
  groupId: string;
  sessionKey: string;
  messageId?: string;
  agent: AgentId;
  title: string;
  kind: ArtifactKind;
  content: string;
  height: number;
  createdAt: number;
}

export interface QuestionField {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
  placeholder?: string;
}

export interface PendingUserQuestion {
  questionId: string;
  groupId: string;
  sessionKey: string;
  agent: AgentId;
  title: string;
  fields: QuestionField[];
  createdAt: number;
}

export interface TaskGroup {
  groupId: string;
  title: string;
  leadAgent: AgentId;
  leadModel?: string;
  leadEffort?: string;
  agentModels?: Record<string, string>;
  agentEfforts?: Record<string, string>;
  cwd: string;
  archived?: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  sessionKey: string;
  groupId: string;
  role: "lead" | "sub";
  label: string;
  parentSessionKey?: string;
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
  currentModelId?: string;
  currentEffort?: string;
  modelCatalog?: AgentModelCatalog;
  usage?: {
    usedTokens?: number;
    maxTokens?: number;
  };
  contextBreakdown?: SessionContextBreakdown;
  tokenTotals?: SessionUsageTotals;
}

export interface TaskRecord {
  taskId: string;
  groupId: string;
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
  groupId?: string;
  timestamp: number;
  leadAgent: AgentId;
  userText: string;
  assistantSummary: string;
  peerCallsSummary: string[];
}

export interface SessionToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  timestamp: number;
}

export interface ChatMessageRecord {
  messageId: string;
  groupId: string;
  streamKey: string;
  sessionKey: string;
  role: "user" | "caller" | "assistant" | "system";
  senderLabel: string;
  agent?: AgentId;
  text: string;
  thoughtText: string;
  toolCalls: SessionToolCall[];
  status: "streaming" | "done" | "error" | "cancelled";
  timestamp: number;
  completedAt?: number;
  usage?: TurnUsage;
  injectedTokens?: number;
  artifactIds?: string[];
}

export type HubEvent =
  | {
      type: "snapshot";
      defaultGroupId: string;
      leadAgent: AgentId;
      permissionMode: PermissionMode;
      baseCwd: string;
      agents: AdapterHealth[];
      taskGroups: TaskGroup[];
      sessions: SessionRecord[];
      tasks: TaskRecord[];
      pendingPermissions: PendingPermission[];
      pendingQuestions: PendingUserQuestion[];
      artifacts: ArtifactRecord[];
      ledger: LedgerTurn[];
      messages: ChatMessageRecord[];
      telemetry: TelemetrySnapshot;
      resourceBudgets: AgentResourceBudget[];
      modelCatalogs: Record<string, AgentModelCatalog>;
      desktopMode?: boolean;
      port?: number;
    }
  | {
      type: "workspace_changed";
      baseCwd: string;
      group: TaskGroup;
      timestamp: number;
    }
  | {
      type: "models_updated";
      agent: AgentId;
      catalog: AgentModelCatalog;
      timestamp: number;
    }
  | {
      type: "lead_changed";
      leadAgent: AgentId;
      previousLead: AgentId;
      timestamp: number;
    }
  | {
      type: "group_created";
      group: TaskGroup;
      timestamp: number;
    }
  | {
      type: "group_updated";
      group: TaskGroup;
      timestamp: number;
    }
  | {
      type: "group_deleted";
      groupId: string;
      timestamp: number;
    }
  | {
      type: "group_lead_changed";
      groupId: string;
      leadAgent: AgentId;
      previousLead: AgentId;
      timestamp: number;
    }
  | {
      type: "message_upserted";
      message: ChatMessageRecord;
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
      groupId?: string;
      streamKey?: string;
      messageId?: string;
      agent: AgentId;
      channel: "message" | "thought";
      text: string;
      timestamp: number;
    }
  | {
      type: "tool_event";
      sessionKey: string;
      groupId?: string;
      streamKey?: string;
      messageId?: string;
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
    }
  | {
      type: "telemetry_updated";
      telemetry: TelemetrySnapshot;
      timestamp: number;
    }
  | {
      type: "resources_updated";
      budgets: AgentResourceBudget[];
      timestamp: number;
    }
  | {
      type: "agents_updated";
      agents: AdapterHealth[];
      timestamp: number;
    }
  | {
      type: "artifact_created";
      artifact: ArtifactRecord;
      timestamp: number;
    }
  | {
      type: "question_requested";
      question: PendingUserQuestion;
      timestamp: number;
    }
  | {
      type: "question_resolved";
      questionId: string;
      answers: Record<string, unknown>;
      cancelled: boolean;
      timestamp: number;
    };

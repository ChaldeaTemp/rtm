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
  /** Model ids offered in the model picker; empty or unset means everything the CLI reports. */
  models?: string[];
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
  /** Agents this item is switched off for while it stays on for the others. */
  disabledAgents: AgentId[];
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
  /** Names of bridged rules left out because the rule budget was exhausted. */
  droppedRules?: string[];
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
  /** Bridged rules left out of the injection because the rule budget was exhausted. */
  droppedRules?: InjectedItemSummary[];
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
  /** Turns whose token counts were estimated because the adapter reported no usage. */
  estimatedTurns?: number;
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
  /** Configured allow-list of model ids (see AgentDefinition.models). */
  models?: string[];
  /** Every model id the CLI reported, before the allow-list is applied. */
  discoveredModelIds?: string[];
  env?: Record<string, string>;
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
  /** Other directories the task works in, besides cwd. */
  extraDirs?: string[];
  archived?: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSlashCommand {
  name: string;
  description: string;
  hint?: string;
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
  /** Why a closed session is closed: "idle" = put to sleep by the hub, wakes on the next message. */
  closedReason?: "idle";
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
  /** The agent's own current plan, when it reports one. */
  plan?: SessionPlanEntry[];
  /** Slash commands advertised by the adapter for this session. */
  availableCommands?: SessionSlashCommand[];
  /** How hub rules / workbench guide reach the agent: session/new systemPrompt or first-turn prompt prefix. */
  promptInjection?: "system" | "prefix";
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

export interface SessionToolDiff {
  path: string;
  oldText?: string;
  newText: string;
  truncated?: boolean;
}

export interface SessionToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  /** Files the tool call touches, as reported by the adapter. */
  locations?: Array<{ path: string; line?: number | null }>;
  outputText?: string;
  outputTruncated?: boolean;
  diffs?: SessionToolDiff[];
  timestamp: number;
  completedAt?: number;
}

export type ChatMessagePart =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string };

export interface ChatImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  sizeBytes: number;
}

/** A non-image file the user attached; the agent reads it from localPath. */
export interface ChatFileAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  localPath: string;
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
  /** Chronological interleaving of thought, text and tool call references when available. */
  parts?: ChatMessagePart[];
  status: "streaming" | "done" | "error" | "cancelled";
  timestamp: number;
  completedAt?: number;
  usage?: TurnUsage;
  injectedTokens?: number;
  artifactIds?: string[];
  images?: ChatImageAttachment[];
  files?: ChatFileAttachment[];
}

export type ProgressItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface ProgressItem {
  title: string;
  status: ProgressItemStatus;
  /** Short remark: what is left, why it is blocked, where the result is. */
  note?: string;
}

/**
 * A task group's goal and where it stands, kept up to date by the agents themselves through
 * the `progress_update` MCP tool so the user does not have to ask.
 */
export interface TaskProgress {
  groupId: string;
  goal?: string;
  /** One or two sentences on the current state. */
  summary?: string;
  items: ProgressItem[];
  updatedBy?: AgentId | "user";
  updatedAt: number;
}

/** One entry of an agent's own plan (ACP `plan` update: TodoWrite, codex plans). */
export interface SessionPlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface TaskContextSection {
  /** "common", a section name, or "result:<stepId>". */
  key: string;
  kind: "common" | "section" | "result";
  /** One line saying what the section holds; shown in the index sub-sessions get. */
  summary?: string;
  content: string;
  /** The content was longer than the limit and has been shortened. */
  truncated?: boolean;
  updatedBy?: AgentId | "user";
  updatedAt: number;
}

/** A task's shared context: background written once and handed to sub-sessions in parts. */
export interface TaskContext {
  groupId: string;
  sections: TaskContextSection[];
}

export type WorkflowStepStatus =
  | "draft"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

/** What a client or the lead agent sends when drafting a workflow. */
export interface WorkflowStepInput {
  id?: string;
  name?: string;
  agent: string;
  prompt: string;
  dependsOn?: string[];
  isolateWorktree?: boolean;
  /** Context sections this step needs besides the common one. */
  contextRefs?: string[];
  /** Acceptance gate; an empty agent means none. */
  review?: { agent?: string; criteria?: string; maxRounds?: number } | null;
}

export interface WorkflowStep {
  id: string;
  name: string;
  agent: AgentId;
  prompt: string;
  /** Ids of the steps that must finish first; their output is appended to this step's prompt. */
  dependsOn: string[];
  isolateWorktree?: boolean;
  /** Context sections this step needs besides the common one. */
  contextRefs?: string[];
  /**
   * Acceptance gate: when the step's agent is done, `agent` reviews the work. A rejection goes
   * back to the step's agent with the reviewer's findings, up to `maxRounds` reviews in all.
   */
  review?: { agent: AgentId; criteria?: string; maxRounds: number };
  /** While a gated step runs: whether its agent is working or the reviewer is reviewing. */
  phase?: "work" | "review";
  /** Which review round the step is in (1 = first attempt). */
  round?: number;
  /** The reviewer's last reply. */
  reviewNotes?: string;
  reviewSessionKey?: string;
  status: WorkflowStepStatus;
  taskId?: string;
  sessionKey?: string;
  output?: string;
  error?: string;
}

/** A task group's workflow: sub-session steps drafted first, then published. */
export interface WorkflowRecord {
  groupId: string;
  status: "draft" | "running" | "completed" | "failed";
  steps: WorkflowStep[];
  proposedBy?: AgentId | "user";
  updatedAt: number;
}

/** A directory tasks run in. Derived from the tasks themselves plus recently used ones. */
export interface ProjectInfo {
  path: string;
  name: string;
  activeTasks: number;
  archivedTasks: number;
  lastUsedAt: number;
}

/** User preferences kept by the hub (shared by every window). */
export interface HubSettings {
  /** After a task's first turn, ask the lead agent for a short title. */
  autoTitle: boolean;
  /** How many workflow steps may run at the same time (1-8). Each one is a set of agent processes. */
  workflowParallel?: number;
  /** Minutes a sub-session may sit idle before its agent processes are released; 0 = never. */
  idleSubSessionMinutes?: number;
  /** Directories used recently, newest first; offered when creating a task. */
  recentProjects?: Array<{ path: string; lastUsedAt: number }>;
}

export type MemoryLevel = "ok" | "low" | "critical";

export interface MemoryStatus {
  level: MemoryLevel;
  /** Memory that can still be committed, in MB; undefined where it is not measured. */
  availableMB?: number;
  totalMB?: number;
  sampledAt: number;
}

export type HubEvent =
  | { type: "memory_status"; memory: MemoryStatus; timestamp: number }
  | {
      type: "snapshot";
      memory?: MemoryStatus;
      defaultGroupId: string;
      settings?: HubSettings;
      workflows?: WorkflowRecord[];
      progress?: TaskProgress[];
      contexts?: TaskContext[];
      projects?: ProjectInfo[];
      /** Lead used for new task groups (--lead, persisted setting, or first ready agent). */
      defaultLead?: AgentId;
      /** The persisted setting only; undefined means automatic. */
      configuredDefaultLead?: AgentId;
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
      type: "context_updated";
      context: TaskContext;
      timestamp: number;
    }
  | {
      type: "projects_updated";
      projects: ProjectInfo[];
      timestamp: number;
    }
  | {
      type: "progress_updated";
      progress: TaskProgress;
      timestamp: number;
    }
  | {
      type: "workflow_updated";
      workflow: WorkflowRecord;
      timestamp: number;
    }
  | {
      type: "settings_updated";
      settings: HubSettings;
      timestamp: number;
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
      type: "message_deleted";
      groupId: string;
      streamKey: string;
      messageId: string;
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
      locations?: Array<{ path: string; line?: number | null }>;
      outputText?: string;
      outputTruncated?: boolean;
      diffs?: SessionToolDiff[];
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
      defaultLead?: AgentId;
      configuredDefaultLead?: AgentId;
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

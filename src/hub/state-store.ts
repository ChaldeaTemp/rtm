import fs from "node:fs";
import path from "node:path";
import type {
  ArtifactRecord,
  ChatMessageRecord,
  LedgerTurn,
  SessionRecord,
  SessionUsageTotals,
  TaskGroup,
  TaskRecord,
  TurnTelemetryRecord,
  TaskContext,
  TaskProgress,
  WorkflowRecord,
} from "../types.js";

/** Bump when the shape changes in a way old files cannot be read with. */
const STATE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 800;
/** Messages are the bulk of the file; the oldest are dropped past this many. */
const MAX_PERSISTED_MESSAGES = 4000;

/** Everything the hub needs to come back after a restart with its tasks and history. */
export interface PersistedHubState {
  version: number;
  savedAt: number;
  defaultGroupId: string;
  groupCounter: number;
  groups: TaskGroup[];
  ledgers: Array<{ groupId: string; turns: LedgerTurn[]; nextTurnId: number }>;
  messages: ChatMessageRecord[];
  tasks: TaskRecord[];
  artifacts: ArtifactRecord[];
  workflows: WorkflowRecord[];
  progress?: TaskProgress[];
  contexts?: TaskContext[];
  /** Sessions as last seen. They are not running after a restart; kept so history stays reachable. */
  sessions: SessionRecord[];
  telemetry: {
    turnSeq: number;
    totals: SessionUsageTotals;
    byAgent: Record<string, SessionUsageTotals>;
    recentTurns: TurnTelemetryRecord[];
  };
}

/**
 * Writes the hub state to one JSON file. Saves are debounced, and written through a temp
 * file plus rename so a crash mid-write cannot leave a truncated file behind.
 */
export class HubStateStore {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWritten = "";

  constructor(
    private readonly filePath: string,
    private readonly collect: () => Omit<PersistedHubState, "version" | "savedAt">,
  ) {}

  load(): PersistedHubState | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedHubState;
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.groups)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Called after any change; many calls in a row cost one write. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Writes now. Used on shutdown, where a pending debounce would be lost. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      const state = this.collect();
      const messages =
        state.messages.length > MAX_PERSISTED_MESSAGES
          ? state.messages.slice(-MAX_PERSISTED_MESSAGES)
          : state.messages;
      const body = JSON.stringify({ ...state, messages });
      // savedAt is left out of the comparison so an idle hub does not rewrite the file.
      if (body === this.lastWritten) return;
      const payload = JSON.stringify({ version: STATE_VERSION, savedAt: Date.now(), ...state, messages });
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, this.filePath);
      this.lastWritten = body;
    } catch {
      // Persistence is best effort; the hub keeps running on its in-memory state.
    }
  }
}

import type { AgentId, LedgerTurn } from "../types.js";
import { estimateTokens } from "./resources.js";

const MAX_SUMMARY_CHARS = 800;
/** Upper bound for one handoff block; older turns are shortened to one line, then dropped. */
const MAX_HANDOFF_CHARS = 12_000;
const BRIEF_TURN_CHARS = 160;

/** Keeps the start and the end: conclusions tend to sit at the end of a long answer. */
function clip(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = Math.ceil(maxChars * 0.6);
  const tail = maxChars - head;
  return `${normalized.slice(0, head)} ... [truncated] ... ${normalized.slice(-tail)}`;
}

/**
 * Maintains the main conversation ledger and generates incremental handoff context
 * whenever the user switches the lead agent mid-thread.
 */
export class ThreadLedger {
  private turns: LedgerTurn[] = [];
  private nextTurnId = 1;
  private lastSyncedTurnByAgent = new Map<AgentId, number>();

  getAllTurns(): LedgerTurn[] {
    return [...this.turns];
  }

  /** What is needed to rebuild the ledger after a restart. */
  exportState(): { turns: LedgerTurn[]; nextTurnId: number } {
    return { turns: this.turns.map((t) => ({ ...t })), nextTurnId: this.nextTurnId };
  }

  /**
   * Rebuilds a ledger from saved turns. Nothing is marked as synced: every session is new
   * after a restart, so the next turn hands the history to whichever agent leads.
   */
  static fromState(state: { turns: LedgerTurn[]; nextTurnId: number }): ThreadLedger {
    const ledger = new ThreadLedger();
    ledger.turns = state.turns.map((t) => ({ ...t, peerCallsSummary: [...(t.peerCallsSummary ?? [])] }));
    ledger.nextTurnId = Math.max(state.nextTurnId || 1, ...ledger.turns.map((t) => t.turnId + 1), 1);
    return ledger;
  }

  recordTurn(input: {
    leadAgent: AgentId;
    userText: string;
    assistantSummary: string;
    peerCallsSummary?: string[];
  }): LedgerTurn {
    const turn: LedgerTurn = {
      turnId: this.nextTurnId++,
      timestamp: Date.now(),
      leadAgent: input.leadAgent,
      userText: clip(input.userText, 600),
      assistantSummary: clip(input.assistantSummary, MAX_SUMMARY_CHARS),
      peerCallsSummary: (input.peerCallsSummary ?? []).map((item) => clip(item, 240)),
    };
    this.turns.push(turn);
    this.lastSyncedTurnByAgent.set(input.leadAgent, turn.turnId);
    return turn;
  }

  /**
   * Prepends unsynced prior turns to the user prompt when switching to a different lead agent,
   * returning both the combined prompt and the estimated handoff token size.
   */
  buildLeadPromptWithMeta(
    targetLead: AgentId,
    userText: string,
  ): { prompt: string; handoffTokens: number; missedTurnsCount: number } {
    const lastSynced = this.lastSyncedTurnByAgent.get(targetLead) ?? 0;
    const missedTurns = this.turns.filter((turn) => turn.turnId > lastSynced);
    if (missedTurns.length === 0) {
      return { prompt: userText, handoffTokens: 0, missedTurnsCount: 0 };
    }

    // Not marked as synced here: recordTurn() does that once the turn has actually succeeded,
    // so a failed or cancelled first turn gets the same handoff again on retry.
    const fullLine = (turn: LedgerTurn): string => {
      const peerNote =
        turn.peerCallsSummary.length > 0
          ? `\n  Peer delegations: ${turn.peerCallsSummary.join(" | ")}`
          : "";
      return `[Turn ${turn.turnId} | Lead: ${turn.leadAgent}]\nUser: ${turn.userText}\nLead Response Summary: ${turn.assistantSummary}${peerNote}`;
    };
    const briefLine = (turn: LedgerTurn): string =>
      `[Turn ${turn.turnId} | Lead: ${turn.leadAgent}] User: ${turn.userText.slice(0, BRIEF_TURN_CHARS)}`;

    // Newest turns in full while they fit; older ones as one line each; the rest only counted.
    const historyLines: string[] = [];
    let used = 0;
    let omitted = 0;
    let fullAllowed = true;
    for (let i = missedTurns.length - 1; i >= 0; i--) {
      const turn = missedTurns[i]!;
      const full = fullLine(turn);
      if (fullAllowed && (used + full.length <= MAX_HANDOFF_CHARS * 0.8 || historyLines.length === 0)) {
        historyLines.unshift(full);
        used += full.length;
        continue;
      }
      fullAllowed = false;
      const brief = briefLine(turn);
      if (used + brief.length <= MAX_HANDOFF_CHARS) {
        historyLines.unshift(brief);
        used += brief.length;
      } else {
        omitted += 1;
      }
    }
    if (omitted > 0) {
      historyLines.unshift(`[${omitted} earlier turn(s) omitted to keep the handoff short]`);
    }

    const handoffBlock = [
      "<handoff_context>",
      "You are now the Lead Agent for this main thread. Below are the recent turns handled before handoff:",
      historyLines.join("\n\n"),
      "</handoff_context>",
    ].join("\n");

    return {
      prompt: `${handoffBlock}\n\n${userText}`,
      handoffTokens: estimateTokens(handoffBlock),
      missedTurnsCount: missedTurns.length,
    };
  }

  /**
   * Forgets what an agent has seen. Called when its session had to be recreated, so the new
   * session gets the history again instead of starting blank.
   */
  forgetAgent(agent: AgentId): void {
    this.lastSyncedTurnByAgent.delete(agent);
  }

  /**
   * Prepends unsynced prior turns to the user prompt when switching to a different lead agent.
   */
  buildLeadPrompt(targetLead: AgentId, userText: string): string {
    return this.buildLeadPromptWithMeta(targetLead, userText).prompt;
  }
}

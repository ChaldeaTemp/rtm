import type { AgentId, LedgerTurn } from "../types.js";

const MAX_SUMMARY_CHARS = 800;

function clip(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}... [truncated]`;
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
   * Prepends unsynced prior turns to the user prompt when switching to a different lead agent.
   */
  buildLeadPrompt(targetLead: AgentId, userText: string): string {
    const lastSynced = this.lastSyncedTurnByAgent.get(targetLead) ?? 0;
    const missedTurns = this.turns.filter((turn) => turn.turnId > lastSynced);
    if (missedTurns.length === 0) {
      return userText;
    }

    const latestTurnId = missedTurns[missedTurns.length - 1]!.turnId;
    this.lastSyncedTurnByAgent.set(targetLead, latestTurnId);

    const historyLines = missedTurns.map((turn) => {
      const peerNote =
        turn.peerCallsSummary.length > 0
          ? `\n  Peer delegations: ${turn.peerCallsSummary.join(" | ")}`
          : "";
      return `[Turn ${turn.turnId} | Lead: ${turn.leadAgent}]\nUser: ${turn.userText}\nLead Response Summary: ${turn.assistantSummary}${peerNote}`;
    });

    return [
      "<handoff_context>",
      "You are now the Lead Agent for this main thread. Below are the recent turns handled before handoff:",
      historyLines.join("\n\n"),
      "</handoff_context>",
      "",
      userText,
    ].join("\n");
  }
}

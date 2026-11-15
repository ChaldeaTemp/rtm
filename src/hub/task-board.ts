import fs from "node:fs";
import path from "node:path";
import type { BoardDeliverable, TaskBoardInfo } from "../types.js";

export type BoardAction = "confirm" | "reject" | "cancel" | "retry" | "resume";

const BOARD_REPORT_INSTRUCTIONS =
  '\n\n<task_board>\nThis task was published on the task board. When the work is finished, call the `task_report` tool with outcome "delivered", a short summary, and every deliverable (files as paths relative to the working directory). If the task cannot be done, call `task_report` with outcome "failed" and the reason. Do not end without calling it: the board only frees this task\'s slot when you report.\n</task_board>';

const BOARD_REJECT_PREFIX = "<rejected>\nThe user sent your previous delivery back. Their note: ";
const BOARD_REJECT_SUFFIX = "\n</rejected>\n\n";

export function buildBoardPrompt(brief: string, rejectNote?: string): string {
  const prefix = rejectNote ? `${BOARD_REJECT_PREFIX}${rejectNote}${BOARD_REJECT_SUFFIX}` : "";
  return `${prefix}${brief}${BOARD_REPORT_INSTRUCTIONS}`;
}

export function readLegacyBoardDispatch(text: string, brief: string): { rejectNote?: string } | undefined {
  const plainPrompt = buildBoardPrompt(brief);
  if (text === plainPrompt) return {};
  const rejectedSuffix = BOARD_REJECT_SUFFIX + plainPrompt;
  if (text.startsWith(BOARD_REJECT_PREFIX) && text.endsWith(rejectedSuffix)) {
    return { rejectNote: text.slice(BOARD_REJECT_PREFIX.length, -rejectedSuffix.length) };
  }
  return undefined;
}

export const DEFAULT_BOARD_PARALLEL = 2;

export function clampBoardParallel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_BOARD_PARALLEL;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return DEFAULT_BOARD_PARALLEL;
  if (rounded > 8) return 8;
  return rounded;
}

export function clampIdleLeadMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  const rounded = Math.floor(value);
  if (rounded < 0) return 0;
  if (rounded > 240) return 240;
  return rounded;
}

export function occupiesSlot(board: TaskBoardInfo | undefined, waiting: boolean): boolean {
  if (!board) return false;
  return board.status === "running" && !waiting;
}

export function pickToStart(
  groups: Array<{ groupId: string; archived?: boolean; board?: TaskBoardInfo }>,
  waitingIds: ReadonlySet<string>,
  parallel: number,
): string[] {
  let occupied = 0;
  for (const g of groups) {
    if (!g.archived && occupiesSlot(g.board, waitingIds.has(g.groupId))) {
      occupied += 1;
    }
  }
  const available = Math.max(0, parallel - occupied);
  if (available === 0) return [];

  const queued = groups
    .filter((g) => !g.archived && g.board?.status === "queued")
    .sort((a, b) => a.board!.queuedAt - b.board!.queuedAt);

  return queued.slice(0, available).map((g) => g.groupId);
}

function clearExecutionFields(board: TaskBoardInfo): TaskBoardInfo {
  const next: TaskBoardInfo = { ...board };
  delete next.summary;
  delete next.deliverables;
  delete next.failReason;
  delete next.startedAt;
  delete next.deliveredAt;
  delete next.closedAt;
  delete next.interrupted;
  delete next.stalled;
  return next;
}

export function applyBoardAction(
  board: TaskBoardInfo,
  action: BoardAction,
  ctx: { now: number; note?: string; earliestQueuedAt?: number },
): TaskBoardInfo {
  switch (action) {
    case "confirm": {
      if (board.status !== "delivered") {
        throw new Error(`Cannot confirm task in status ${board.status}`);
      }
      return {
        ...board,
        status: "done",
        closedAt: ctx.now,
      };
    }
    case "reject": {
      if (board.status !== "delivered") {
        throw new Error(`Cannot reject task in status ${board.status}`);
      }
      if (!ctx.note || !ctx.note.trim()) {
        throw new Error("Reject action requires a non-empty note");
      }
      const next = clearExecutionFields(board);
      next.status = "queued";
      next.queuedAt = ctx.earliestQueuedAt !== undefined ? ctx.earliestQueuedAt - 1 : ctx.now;
      next.rejectCount = board.rejectCount + 1;
      next.rejectNote = ctx.note;
      return next;
    }
    case "cancel": {
      if (board.status !== "queued" && board.status !== "running") {
        throw new Error(`Cannot cancel task in status ${board.status}`);
      }
      return {
        ...board,
        status: "failed",
        failReason: "cancelled by user",
        closedAt: ctx.now,
      };
    }
    case "retry": {
      if (board.status !== "failed") {
        throw new Error(`Cannot retry task in status ${board.status}`);
      }
      const next = clearExecutionFields(board);
      next.status = "queued";
      next.queuedAt = ctx.now;
      return next;
    }
    case "resume": {
      if (board.status !== "running" || !board.interrupted) {
        throw new Error(`Cannot resume task in status ${board.status}`);
      }
      const next: TaskBoardInfo = { ...board };
      delete next.interrupted;
      return next;
    }
    default: {
      throw new Error(`Unknown board action: ${String(action)}`);
    }
  }
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function resolveDeliverableFile(file: string, roots: string[]): string | undefined {
  for (const root of roots) {
    const rootAbs = path.resolve(root);
    const candidate = path.resolve(rootAbs, file);
    if (!isInside(rootAbs, candidate)) continue;
    try {
      const realFile = fs.realpathSync(candidate);
      if (isInside(fs.realpathSync(rootAbs), realFile) && fs.statSync(realFile).isFile()) {
        return realFile;
      }
    } catch {
      // The file or an allowed directory may have been moved or removed.
    }
  }
  return undefined;
}

export function missingDeliverables(deliverables: BoardDeliverable[], roots: string[]): string[] {
  return deliverables
    .filter((item) => item.kind === "file" && !resolveDeliverableFile(item.path || "", roots))
    .map((item) => item.path?.trim() ? item.path : "(no path)");
}

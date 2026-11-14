import path from "node:path";
import type { BoardDeliverable, TaskBoardInfo } from "../types.js";

export type BoardAction = "confirm" | "reject" | "cancel" | "retry" | "resume";

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

export function missingDeliverables(
  deliverables: BoardDeliverable[],
  roots: string[],
  exists: (absPath: string) => boolean,
): string[] {
  const missing: string[] = [];
  for (const item of deliverables) {
    if (item.kind !== "file") continue;
    if (!item.path || !item.path.trim()) {
      missing.push("(no path)");
      continue;
    }
    let found = false;
    for (const root of roots) {
      const rootAbs = path.resolve(root);
      const resolved = path.resolve(rootAbs, item.path);
      const rel = path.relative(rootAbs, resolved);
      if (
        rel !== "" &&
        rel !== "." &&
        rel !== ".." &&
        !rel.startsWith(".." + path.sep) &&
        !rel.startsWith("../") &&
        !path.isAbsolute(rel) &&
        exists(resolved)
      ) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push(item.path);
    }
  }
  return missing;
}

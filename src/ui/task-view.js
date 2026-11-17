// Shared selection rules: an archived task is only opened by an explicit user action.
export function isPlaceholderGroup(group, state) {
  return group.groupId === "grp-default" && group.defaultTitleNumber === 1 &&
    !group.archived && !group.board && !state.workflows?.has(group.groupId) &&
    ![...state.messagesByStream.values()].some((items) => items.some((m) => m.groupId === group.groupId)) &&
    ![...state.sessions.values()].some((s) => s.groupId === group.groupId);
}

export function visibleTaskGroups(state) {
  return [...state.taskGroups.values()].filter((group) => !isPlaceholderGroup(group, state));
}

export function nextActiveGroupId(state) {
  return visibleTaskGroups(state).find((group) => !group.archived)?.groupId || "";
}

export function boardStatus(group, cards) {
  const card = cards.find((item) => item.groupId === group.groupId);
  const board = card?.board || group.board;
  if (!board) return "";
  return board.status === "running" && (card ? card.waiting : board.interrupted || board.stalled)
    ? "waiting" : board.status;
}

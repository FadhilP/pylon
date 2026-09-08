export const MAX_UNSEEN_COMPLETIONS = 200;

export function validCompletionSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function validCompletionSessionIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_UNSEEN_COMPLETIONS &&
    value.every(validCompletionSessionId) &&
    new Set(value).size === value.length
  );
}

export function completionRecord(sessionIds: string[]): Record<string, true> {
  return Object.fromEntries(sessionIds.map(sessionId => [sessionId, true])) as Record<string, true>;
}

export function recordCompletion(
  current: Record<string, true>,
  selectedSessionId: string | undefined,
  status: { sessionId: string; completed?: unknown },
): Record<string, true> {
  if (
    !validCompletionSessionId(status.sessionId) ||
    status.completed !== true ||
    selectedSessionId === status.sessionId
  )
    return current;
  const next = { ...current };
  delete next[status.sessionId];
  Object.defineProperty(next, status.sessionId, { value: true, enumerable: true, configurable: true, writable: true });
  while (Object.keys(next).length > MAX_UNSEEN_COMPLETIONS) delete next[Object.keys(next)[0]!];
  return next;
}

export function showSessionRuntimeState(state: string, completed: boolean): boolean {
  return completed || state !== "sleeping";
}

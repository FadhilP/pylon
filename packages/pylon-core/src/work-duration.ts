export const WORK_DURATION_ENTRY_TYPE = "pylon-work-duration";
export const MAX_WORK_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ENTRY_BYTES = 1_024;

export interface PersistedWorkDuration {
  version: 1;
  assistantEntryId: string;
  durationMs: number;
}

export function parseWorkDuration(value: unknown): PersistedWorkDuration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ENTRY_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1
    || typeof raw.assistantEntryId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.assistantEntryId)
    || !Number.isSafeInteger(raw.durationMs)
    || Number(raw.durationMs) < 0
    || Number(raw.durationMs) > MAX_WORK_DURATION_MS) return undefined;
  return {
    version: 1,
    assistantEntryId: raw.assistantEntryId,
    durationMs: Number(raw.durationMs),
  };
}

export function appendWorkDuration(
  session: { appendCustomEntry(customType: string, data?: unknown): string },
  assistantEntryId: string,
  durationMs: number,
): boolean {
  const duration = parseWorkDuration({ version: 1, assistantEntryId, durationMs });
  if (!duration) return false;
  session.appendCustomEntry(WORK_DURATION_ENTRY_TYPE, duration);
  return true;
}

export function activeAssistantEntryIds(branch: unknown[]): Set<string> {
  return new Set(branch.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const message = entry.message as Record<string, unknown> | undefined;
    return entry.type === "message" && message?.role === "assistant" && typeof entry.id === "string"
      ? [entry.id]
      : [];
  }));
}

export function readPersistedWorkDurations(
  session: { getBranch(): unknown[]; getEntries(): unknown[] },
): Map<string, number> {
  const activeAssistants = activeAssistantEntryIds(session.getBranch());
  const durations = new Map<string, number>();
  for (const value of session.getEntries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== WORK_DURATION_ENTRY_TYPE) continue;
    const duration = parseWorkDuration(entry.data);
    if (!duration || !activeAssistants.has(duration.assistantEntryId)) continue;
    durations.set(duration.assistantEntryId, duration.durationMs);
  }
  return durations;
}

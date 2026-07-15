export const RUN_ENTRY_TYPE = "pylon-run";
export const HANDOFF_ENTRY_TYPE = "pi-continuity-handoff";
export type RunRole = "planner" | "executor" | "reviewer";
export type RunEntry = {
  version: 1;
  runId: string;
  timelineId?: string;
  role: RunRole;
  parentSessionId?: string;
  createdAt: string;
};

export function isRunEntry(value: any): value is RunEntry {
  return Boolean(
    value?.version === 1 &&
      typeof value.runId === "string" &&
      value.runId.length > 0 &&
      (value.timelineId === undefined ||
        (typeof value.timelineId === "string" && value.timelineId.length > 0)) &&
      ["planner", "executor", "reviewer"].includes(value.role) &&
      (value.parentSessionId === undefined ||
        typeof value.parentSessionId === "string") &&
      typeof value.createdAt === "string",
  );
}

export const runTimelineId = (run: RunEntry) => run.timelineId ?? run.runId;

export function findRunEntry(entries: readonly any[]): RunEntry | undefined {
  const entry = [...entries]
    .reverse()
    .find(
      (item) =>
        item.type === "custom" &&
        item.customType === RUN_ENTRY_TYPE &&
        isRunEntry(item.data),
    );
  return entry?.data;
}

import type { StateQLHistoryEntryReadModel, StateQLSnapshot } from "../../shared/protocol/snapshots.js";

export type StateQLActivityFilter = "all" | "read" | "write" | "error";
export type StateQLActivityTag = Exclude<StateQLActivityFilter, "all">;
export type StateQLActivityTone = "success" | "danger" | "neutral" | "active";
type StateQLResult = StateQLSnapshot["recent_results"][number];
type StateQLOperation = StateQLSnapshot["recent_operations"][number];

export interface StateQLActivityItem {
  id: string;
  source: "history" | "metadata";
  command: string;
  sql?: string;
  target?: string;
  actorId?: string;
  origin?: StateQLHistoryEntryReadModel["origin"];
  handle?: string;
  timestamp?: string;
  executed: boolean;
  cached: boolean;
  success: boolean;
  errorCode?: string;
  result?: StateQLResult;
  operation?: StateQLOperation;
  tags: StateQLActivityTag[];
}

const READ_COMMANDS = new Set([
  "query",
  "mongo.query",
  "filter",
  "show",
  "rows",
  "count",
  "columns",
  "inspect",
  "plan",
  "mongo.plan",
]);
const WRITE_COMMANDS = new Set(["exec", "mongo.exec", "apply", "transaction.commit", "transaction.rollback"]);
const FAILED_OPERATION_STATES = new Set(["failed", "outcome_unknown"]);

/** Keep infrastructure activity available for diagnostics without crowding statements. */
export function isInternalStateQLActivity(item: Pick<StateQLActivityItem, "command">): boolean {
  return item.command.startsWith("profile.") || item.command.startsWith("inspect.") ||
    item.command.startsWith("objects.") || ["inspect", "rows", "show", "count", "columns", "history", "status", "doctor", "transaction.status"].includes(item.command);
}

function tagsFor(
  entry: StateQLHistoryEntryReadModel | undefined,
  result?: StateQLResult,
  operation?: StateQLOperation,
): StateQLActivityTag[] {
  const tags: StateQLActivityTag[] = [];
  if (result || (entry && (READ_COMMANDS.has(entry.command) || entry.command.startsWith("inspect."))))
    tags.push("read");
  if (operation || (entry && WRITE_COMMANDS.has(entry.command))) tags.push("write");
  if ((entry && !entry.success) || (operation && FAILED_OPERATION_STATES.has(operation.status))) tags.push("error");
  return tags;
}

export function buildStateQLActivity(snapshot: StateQLSnapshot): StateQLActivityItem[] {
  const results = new Map(snapshot.recent_results.map(result => [result.handle, result]));
  const operations = new Map(snapshot.recent_operations.map(operation => [operation.handle, operation]));
  const referenced = new Set<string>();
  const history = snapshot.history.map((entry): StateQLActivityItem => {
    const handle = entry.handle ?? undefined;
    if (handle) referenced.add(handle);
    const result = handle ? results.get(handle) : undefined;
    const operation = handle ? operations.get(handle) : undefined;
    return {
      id: `history:${entry.command_id}`,
      source: "history",
      command: entry.command,
      sql: entry.sql ?? undefined,
      target: entry.target ?? undefined,
      actorId: entry.actor_id,
      origin: entry.origin,
      handle,
      timestamp: entry.timestamp,
      executed: entry.executed,
      cached: entry.cached,
      success: entry.success,
      errorCode: entry.error_code ?? undefined,
      result,
      operation,
      tags: tagsFor(entry, result, operation),
    };
  });

  const handles = new Set([...results.keys(), ...operations.keys()]);
  const metadata = [...handles]
    .filter(handle => !referenced.has(handle))
    .map((handle): StateQLActivityItem => {
      const result = results.get(handle);
      const operation = operations.get(handle);
      return {
        id: `metadata:${handle}`,
        source: "metadata",
        command: result ? "result" : "operation",
        actorId: operation?.actor_id,
        handle,
        executed: false,
        cached: false,
        success: !operation || !FAILED_OPERATION_STATES.has(operation.status),
        result,
        operation,
        tags: tagsFor(undefined, result, operation),
      };
    });

  return [...history, ...metadata];
}

export function stateqlActivityStatus(item: StateQLActivityItem): { label: string; tone: StateQLActivityTone } {
  if (item.source === "history" && !item.success) return { label: item.errorCode ?? "failed", tone: "danger" };
  if (item.operation)
    return {
      label: item.operation.status,
      tone:
        item.operation.status === "committed"
          ? "success"
          : item.operation.status === "failed" || item.operation.status === "outcome_unknown"
            ? "danger"
            : "neutral",
    };
  if (item.source === "metadata" && item.result) return { label: "materialized", tone: "neutral" };
  if (item.cached) return { label: "cached", tone: "neutral" };
  if (item.executed) return { label: "executed", tone: "success" };
  return { label: item.success ? "ok" : "failed", tone: item.success ? "success" : "danger" };
}

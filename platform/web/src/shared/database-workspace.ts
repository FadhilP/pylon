import { PROTOCOL_VERSION } from "./protocol/envelope.ts";
import type { StateQLCommandInput, StateQLCommandResult } from "./protocol/snapshots.ts";

export type DatabaseDriver = "sqlite" | "postgres" | "mysql" | "mongodb";
export interface DatabaseQuery {
  id: string;
  title: string;
  text: string;
  driver: DatabaseDriver;
  saved: boolean;
}
export interface DatabaseDraft {
  version: 1;
  scope: string;
  sessionId: string;
  tabs: DatabaseQuery[];
  active: string;
  height: number;
  updatedAt: number;
}
export interface DatabaseResult {
  result_id: string;
  rows: number;
  columns: Array<{ name: string; type: string }>;
  cached: boolean;
  storage: { expires_at?: string; mode: string };
}
export const DATABASE_DRAFTS_KEY = "pylon-database-drafts-v1";
export const databaseBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const databaseRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 65_536;

export function isDatabaseResult(value: unknown): value is DatabaseResult {
  return databaseRecord(value) && text(value.result_id) && integer(value.rows) &&
    Array.isArray(value.columns) && value.columns.length <= 100 && value.columns.every(column =>
      databaseRecord(column) && text(column.name) && text(column.type)) &&
    typeof value.cached === "boolean" && databaseRecord(value.storage) && text(value.storage.mode) &&
    text(value.storage.expires_at) && Number.isFinite(Date.parse(value.storage.expires_at));
}

function validCommandData(command: StateQLCommandInput["command"], value: unknown): boolean {
  if (!databaseRecord(value)) return false;
  switch (command) {
    case "query": case "mongo.query": case "table.read": return isDatabaseResult(value);
    case "plan": case "mongo.plan": case "table.plan":
      return text(value.plan_id) && text(value.owner_actor_id) && text(value.state_version) &&
        text(value.expires_at) && Number.isFinite(Date.parse(value.expires_at)) &&
        Array.isArray(value.required_overrides) && value.required_overrides.every(text);
    case "exec": case "mongo.exec": case "receipt":
      return text(value.operation_id) && text(value.status) && typeof value.committed === "boolean";
    case "apply": return text(value.operation_id) && text(value.status);
    case "profile.list":
      return Array.isArray(value.profiles) && value.profiles.every(profile => databaseRecord(profile) &&
        text(profile.profile) && typeof profile.read_only === "boolean");
    case "transaction.begin": case "transaction.status":
      return text(value.transaction_id) && text(value.owner_actor_id) && text(value.state) &&
        integer(value.statements) && integer(value.pending_writes) && typeof value.age_ms === "number";
    case "transaction.commit": return text(value.transaction_id) && text(value.state) && integer(value.statements_executed);
    case "transaction.rollback": return text(value.transaction_id) && text(value.state) && integer(value.discarded_statements);
    case "inspect": return ["tables", "collections", "columns", "indexes", "constraints", "primary_key"].some(key => key in value) || text(value.table) || text(value.collection);
    default: return true;
  }
}

export function isDatabaseCommandResult(value: unknown, command: StateQLCommandInput["command"]): value is StateQLCommandResult {
  if (!databaseRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || !integer(value.sessionGeneration) ||
    !text(value.actor_id) || value.command !== command || databaseBytes(value) > 256 * 1024) return false;
  if (value.status === "declined") return !Object.hasOwn(value, "response");
  const response = value.response;
  if (value.status !== "completed" || !databaseRecord(response) || !text(response.command_id) ||
    !text(response.session_id) || !databaseRecord(response.meta) ||
    typeof response.meta.duration_ms !== "number" || !Number.isFinite(response.meta.duration_ms) || response.meta.duration_ms < 0) return false;
  if (response.ok === false) return databaseRecord(response.error) && text(response.error.code) && text(response.error.message) &&
    typeof response.error.executed === "boolean" && typeof response.error.retryable === "boolean";
  return response.ok === true && Array.isArray(response.warnings) && response.warnings.every(warning =>
    databaseRecord(warning) && text(warning.code) && text(warning.message)) && validCommandData(command, response.data);
}

export function readDatabaseDrafts(storage: Pick<Storage, "getItem">): DatabaseDraft[] {
  try {
    const raw = storage.getItem(DATABASE_DRAFTS_KEY);
    if (!raw || new TextEncoder().encode(raw).length > 1024 * 1024) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is DatabaseDraft => {
      if (!databaseRecord(value) || value.version !== 1 || !text(value.scope) || !text(value.sessionId) ||
        !Array.isArray(value.tabs) || value.tabs.length > 20 || databaseBytes(value) > 256 * 1024 ||
        !text(value.active) || typeof value.height !== "number" || !Number.isFinite(value.height) ||
        !integer(value.updatedAt)) return false;
      const ids = new Set<string>();
      for (const tab of value.tabs) {
        if (!databaseRecord(tab) || !text(tab.id) || !tab.id || tab.id === "history" || ids.has(tab.id) ||
          !text(tab.title) || tab.title.length > 100 || !text(tab.text) || databaseBytes(tab.text) > 64 * 1024 ||
          !["sqlite", "postgres", "mysql", "mongodb"].includes(String(tab.driver)) || tab.saved !== true) return false;
        ids.add(tab.id);
      }
      return value.active === "history" || ids.has(value.active);
    }).map(value => ({ version: 1, scope: value.scope, sessionId: value.sessionId, active: value.active,
      height: Math.max(120, Math.min(600, value.height)), updatedAt: value.updatedAt,
      tabs: value.tabs.map(({ id, title, text, driver }) => ({ id, title, text, driver, saved: true })),
    }));
  } catch { return []; }
}

export function saveDatabaseDraft(storage: Pick<Storage, "getItem" | "setItem">, draft: DatabaseDraft): void {
  // Persist an allowlist, never the live tab object (params/results/plans are transient).
  const tabs = draft.tabs.filter(tab => tab.saved).map(({ id, title, text, driver }) => ({ id, title, text, driver, saved: true }));
  const safe: DatabaseDraft = { version: 1, scope: draft.scope, sessionId: draft.sessionId, tabs,
    active: tabs.some(tab => tab.id === draft.active) ? draft.active : "history", height: draft.height, updatedAt: Date.now() };
  if (databaseBytes(safe) > 256 * 1024 || tabs.length > 20 || tabs.some(tab => databaseBytes(tab.text) > 64 * 1024))
    throw new Error("Saved queries exceed the browser storage limit. Keep some tabs unsaved.");
  const retained = readDatabaseDrafts(storage).filter(item => item.scope !== draft.scope).sort((a, b) => b.updatedAt - a.updatedAt);
  const next = tabs.length ? [safe, ...retained] : retained;
  while (databaseBytes(next) > 1024 * 1024) next.pop();
  storage.setItem(DATABASE_DRAFTS_KEY, JSON.stringify(next));
}

export function clearDatabaseDrafts(storage: Pick<Storage, "getItem" | "setItem">, sessionId: string, scope?: string): void {
  storage.setItem(DATABASE_DRAFTS_KEY, JSON.stringify(readDatabaseDrafts(storage).filter(draft =>
    scope ? draft.scope !== scope : draft.sessionId !== sessionId)));
}

export function databaseCell(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

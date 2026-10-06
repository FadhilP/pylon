import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import { STATEQL_GLOBAL_UI_ACTOR } from "../../shared/protocol/snapshots.ts";
import type { HeliosBrowserResult, HeliosPageIdentity } from "../../shared/protocol/helios.ts";
import type { HeliosAndroidToolingResult } from "../../shared/protocol/helios-android-tooling.ts";
import type {
  PapercutListPage,
  PapercutStatusReadModel,
  StateQLCommandInput,
  StateQLCommandResult,
  StateQLCommandResponseReadModel,
  StateQLRowsPage,
  StateQLSnapshot,
  StateQLWorkspace,
} from "../../shared/protocol/snapshots.ts";
import { isPapercutListPage, isStateQLRowsPage, isStateQLSnapshot } from "../../shared/protocol/validation.ts";

/** Validates and bounds what StateQL, Papercut, and Helios packages return to the web runtime. */

const MAX_HELIOS_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_HELIOS_FRAME_BASE64 = Math.ceil(MAX_HELIOS_FRAME_BYTES / 3) * 4;

function heliosPage(value: unknown): HeliosPageIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (
    !Number.isInteger(page.index) ||
    (page.index as number) < 0 ||
    (page.index as number) > 100 ||
    typeof page.title !== "string" ||
    page.title.length > 500 ||
    typeof page.url !== "string" ||
    page.url.length > 4096
  )
    return undefined;
  return { index: page.index as number, title: page.title, url: page.url };
}

export function stateqlResult(
  value: unknown,
  sessionId: string,
  sessionGeneration: number,
  workspace: StateQLWorkspace,
): StateQLSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("StateQL returned an invalid snapshot");
  const raw = value as Record<string, any>;
  const closed = raw.session?.status === "closed";
  const candidate = {
    ...raw,
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    workspace,
    history: Array.isArray(raw.history)
      ? raw.history.map((item: any) => ({
          ...item,
          origin: ["legacy", "user", "model", "system", "api"].includes(String(item?.origin)) ? item.origin : "legacy",
        }))
      : raw.history,
    ...(closed ? { connection: null, transaction: null } : {}),
  };
  const actorId = workspace === "global" ? STATEQL_GLOBAL_UI_ACTOR : sessionId;
  if (!isStateQLSnapshot(candidate) || candidate.actor_id !== actorId || candidate.workspace !== workspace)
    throw new Error("StateQL returned an invalid snapshot");
  const snapshot = candidate as StateQLSnapshot;
  const result: StateQLSnapshot = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    workspace,
    session: { session_id: snapshot.session.session_id, name: snapshot.session.name, status: snapshot.session.status },
    actor_id: snapshot.actor_id,
    connection: snapshot.connection
      ? {
          connection_id: snapshot.connection.connection_id,
          ...(snapshot.connection.alias !== undefined ? { alias: snapshot.connection.alias } : {}),
          name: snapshot.connection.name,
          status: snapshot.connection.status,
          driver: snapshot.connection.driver,
          database: snapshot.connection.database,
          read_only: snapshot.connection.read_only,
        }
      : null,
    transaction: snapshot.transaction
      ? {
          transaction_id: snapshot.transaction.transaction_id,
          owner_actor_id: snapshot.transaction.owner_actor_id,
          state: snapshot.transaction.state,
        }
      : null,
    state_version: snapshot.state_version,
    state_confidence: snapshot.state_confidence,
    recent_results: snapshot.recent_results.map(item => ({ alias: item.alias, handle: item.handle, rows: item.rows })),
    recent_operations: snapshot.recent_operations.map(item => ({
      handle: item.handle,
      actor_id: item.actor_id,
      type: item.type,
      affected_rows: item.affected_rows,
      status: item.status,
    })),
    history: snapshot.history.map(item => ({
      command_id: item.command_id,
      timestamp: item.timestamp,
      session_id: item.session_id,
      actor_id: item.actor_id,
      origin: item.origin,
      command: item.command,
      sql: item.sql,
      ...(item.target ? { target: item.target } : {}),
      handle: item.handle,
      executed: item.executed,
      cached: item.cached,
      success: item.success,
      error_code: item.error_code,
    })),
  };
  // ponytail: reject escape-heavy aggregate payloads instead of budgeting for the protocol's theoretical JSON worst case.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024)
    throw new Error("StateQL returned an oversized snapshot");
  return result;
}

const MAX_STATEQL_ROWS_BYTES = 256 * 1024;

function stateqlJsonValue(value: unknown, depth: number, budget: { bytes: number }): unknown {
  if (depth > 6) throw new Error("StateQL returned invalid rows");
  budget.bytes++;
  if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    budget.bytes += Buffer.byteLength(String(value), "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 64 * 1024) throw new Error("StateQL returned invalid rows");
    budget.bytes += Buffer.byteLength(value, "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("StateQL returned invalid rows");
    return value.map(item => stateqlJsonValue(item, depth + 1, budget));
  }
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("StateQL returned invalid rows");
  }
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("StateQL returned invalid rows");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of entries) {
    if (key.length > 500) throw new Error("StateQL returned invalid rows");
    budget.bytes += Buffer.byteLength(key, "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    result[key] = stateqlJsonValue(item, depth + 1, budget);
  }
  return result;
}

export function stateqlRowsResult(
  value: unknown,
  handle: string,
  offset: number,
  limit: number,
  actorId: string,
  sessionGeneration: number,
  workspace: StateQLWorkspace,
): StateQLRowsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("StateQL returned invalid rows");
  const raw = value as Record<string, unknown>;
  if (raw.result_id !== handle || raw.offset !== offset || raw.limit !== limit || !Array.isArray(raw.rows)) {
    throw new Error("StateQL returned invalid rows");
  }
  const budget = { bytes: 0 };
  const rows = raw.rows.map(row => stateqlJsonValue(row, 0, budget));
  const candidate = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    workspace,
    actor_id: actorId,
    handle,
    ...(Array.isArray(raw.columns)
      ? {
          columns: stateqlJsonValue(raw.columns, 0, budget),
          full_values: true,
          row_tokens: stateqlJsonValue(raw.row_tokens ?? rows.map(() => null), 0, budget),
          writable_columns: stateqlJsonValue(raw.writable_columns ?? [], 0, budget),
          ...(typeof raw.editing_reason === "string" ? { editing_reason: raw.editing_reason.slice(0, 500) } : {}),
        }
      : {}),
    offset: raw.offset,
    limit: raw.limit,
    rows,
    returned: raw.returned,
    total: raw.total,
    truncated: raw.truncated,
    next_offset: raw.next_offset,
  };
  if (!isStateQLRowsPage(candidate)) throw new Error("StateQL returned invalid rows");
  const page = candidate as StateQLRowsPage;
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_STATEQL_ROWS_BYTES)
    throw new Error("StateQL returned oversized rows");
  return page;
}

export function stateqlCommandResult(
  value: unknown,
  input: StateQLCommandInput,
  actorId: string,
  sessionGeneration: number,
  workspace: StateQLWorkspace,
): StateQLCommandResult {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    workspace,
    actor_id: actorId,
    command: input.command,
  } as const;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).declined === true
  )
    return { ...base, status: "declined" };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("StateQL returned an invalid command response");
  const raw = value as Record<string, any>;
  if (
    typeof raw.ok !== "boolean" ||
    typeof raw.command_id !== "string" ||
    !raw.command_id ||
    raw.command_id.length > 128 ||
    typeof raw.session_id !== "string" ||
    !raw.session_id ||
    raw.session_id.length > 128 ||
    !raw.meta ||
    typeof raw.meta !== "object" ||
    !Number.isFinite(raw.meta.duration_ms) ||
    raw.meta.duration_ms < 0
  )
    throw new Error("StateQL returned an invalid command response");
  const meta = {
    duration_ms: raw.meta.duration_ms,
    ...(typeof raw.meta.state_version === "string" && raw.meta.state_version.length <= 128
      ? { state_version: raw.meta.state_version }
      : {}),
    ...(typeof raw.meta.state_confidence === "string" && raw.meta.state_confidence.length <= 100
      ? { state_confidence: raw.meta.state_confidence }
      : {}),
  };
  let response: StateQLCommandResponseReadModel;
  if (raw.ok) {
    if (
      !Array.isArray(raw.warnings) ||
      raw.warnings.length > 100 ||
      !raw.warnings.every(
        (warning: unknown) =>
          Boolean(warning) &&
          typeof warning === "object" &&
          !Array.isArray(warning) &&
          typeof (warning as any).code === "string" &&
          (warning as any).code.length <= 100 &&
          typeof (warning as any).message === "string" &&
          (warning as any).message.length <= 2_000,
      )
    )
      throw new Error("StateQL returned an invalid command response");
    response = {
      ok: true,
      command_id: raw.command_id,
      session_id: raw.session_id,
      data: stateqlJsonValue(raw.data, 0, { bytes: 0 }),
      warnings: raw.warnings.map((warning: any) => ({ code: warning.code, message: warning.message })),
      meta,
    };
  } else {
    const error = raw.error;
    if (
      !error ||
      typeof error !== "object" ||
      typeof error.code !== "string" ||
      !error.code ||
      error.code.length > 100 ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean" ||
      typeof error.executed !== "boolean" ||
      (error.suggested_action !== undefined && typeof error.suggested_action !== "string")
    )
      throw new Error("StateQL returned an invalid command response");
    const redact = (text: string) =>
      text
        .slice(0, 2_000)
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@")
        .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=***");
    response = {
      ok: false,
      command_id: raw.command_id,
      session_id: raw.session_id,
      error: {
        code: error.code,
        message: redact(error.message),
        retryable: error.retryable,
        executed: error.executed,
        ...(typeof error.suggested_action === "string" ? { suggested_action: redact(error.suggested_action) } : {}),
      },
      meta,
    };
  }
  const result: StateQLCommandResult = { ...base, status: "completed", response };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_STATEQL_ROWS_BYTES)
    throw new Error("StateQL returned an oversized command response");
  return result;
}

export function papercutListResult(
  value: unknown,
  status: PapercutStatusReadModel | "all",
  query: string,
  offset: number,
  limit: number,
  sessionId: string,
  sessionGeneration: number,
  sanitize: (value: string) => string,
): PapercutListPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Papercut returned an invalid list");
  const raw = value as Record<string, any>;
  if (
    raw.version !== 1 ||
    raw.sessionId !== sessionId ||
    raw.status !== status ||
    raw.query !== query ||
    raw.offset !== offset ||
    raw.limit !== limit ||
    !Array.isArray(raw.records)
  )
    throw new Error("Papercut returned an invalid list");
  const candidate = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    revision: raw.revision,
    status,
    query,
    offset,
    limit,
    total: raw.total,
    records: raw.records,
    nextOffset:
      Number.isSafeInteger(raw.total) && offset + raw.records.length < raw.total ? offset + raw.records.length : null,
  };
  if (!isPapercutListPage(candidate)) throw new Error("Papercut returned an invalid list");
  const source = candidate as PapercutListPage;
  const result: PapercutListPage = {
    ...source,
    records: source.records.map(record => ({
      ...record,
      message: sanitize(record.message),
      ...(record.resolution !== undefined ? { resolution: sanitize(record.resolution) } : {}),
      ...(record.dismissal !== undefined ? { dismissal: sanitize(record.dismissal) } : {}),
    })),
  };
  if (!isPapercutListPage(result)) throw new Error("Papercut returned an invalid list");
  return result;
}

export function heliosAndroidToolingResult(value: unknown, sessionGeneration: number): HeliosAndroidToolingResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Helios returned an invalid Android tooling response");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["state", "appiumVersion", "driverVersion", "message"]);
  const version = (item: unknown) => typeof item === "string" && /^[0-9A-Za-z.+-]{1,50}$/.test(item);
  if (
    Object.keys(raw).some(key => !allowed.has(key)) ||
    typeof raw.state !== "string" ||
    !["missing", "ready", "invalid", "busy"].includes(raw.state) ||
    !version(raw.appiumVersion) ||
    !version(raw.driverVersion) ||
    (raw.message !== undefined &&
      (typeof raw.message !== "string" ||
        !raw.message ||
        raw.message.length > 300 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(raw.message)))
  ) {
    throw new Error("Helios returned an invalid Android tooling response");
  }
  return {
    version: 1,
    sessionGeneration,
    state: raw.state as HeliosAndroidToolingResult["state"],
    appiumVersion: raw.appiumVersion as string,
    driverVersion: raw.driverVersion as string,
    ...(raw.message === undefined ? {} : { message: raw.message as string }),
  };
}

export function heliosResult(value: unknown, sessionGeneration: number): HeliosBrowserResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Helios returned an invalid embedded browser response");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.active !== "boolean" || typeof raw.controlled !== "boolean")
    throw new Error("Helios returned an invalid embedded browser response");
  const ownership = ["owned", "cdp-attached", "extension-attached"].includes(String(raw.ownership))
    ? (raw.ownership as HeliosBrowserResult["ownership"])
    : undefined;
  const state = ["starting", "ready", "cleanup-required", "closing", "closed"].includes(String(raw.state))
    ? (raw.state as HeliosBrowserResult["state"])
    : undefined;
  const page = raw.page === undefined ? undefined : heliosPage(raw.page);
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.slice(0, 101).map(heliosPage) : undefined;
  if ((raw.page !== undefined && !page) || tabs?.some(tab => !tab))
    throw new Error("Helios returned invalid page metadata");
  let frame: HeliosBrowserResult["frame"];
  if (raw.frame !== undefined) {
    const image =
      raw.frame && typeof raw.frame === "object" && !Array.isArray(raw.frame)
        ? (raw.frame as Record<string, unknown>)
        : undefined;
    if (
      image?.mimeType !== "image/png" ||
      typeof image.data !== "string" ||
      !image.data ||
      image.data.length > MAX_HELIOS_FRAME_BASE64 ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    )
      throw new Error("Helios returned an invalid embedded browser frame");
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    if ((image.data.length / 4) * 3 - padding > MAX_HELIOS_FRAME_BYTES)
      throw new Error("Helios returned an oversized embedded browser frame");
    frame = { mimeType: "image/png", data: image.data };
  }
  return {
    version: 1,
    sessionGeneration,
    active: raw.active,
    controlled: raw.controlled,
    ...(ownership ? { ownership } : {}),
    ...(state ? { state } : {}),
    ...(page ? { page } : {}),
    ...(tabs ? { tabs: tabs as HeliosPageIdentity[] } : {}),
    ...(frame ? { frame } : {}),
  };
}

import { randomBytes, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  StateQL,
  type BatchCommand,
  type CredentialRequest,
  type Response,
  type StateQLActorOptions,
  type StateQLSnapshot,
} from "@fadhilp/stateql";
import { Type, type Static } from "typebox";
import { parseStateQLPanelCommand, type StateQLPanelCommand } from "../src/stateql-command.ts";

const COMMANDS = [
  "connect",
  "disconnect",
  "status",
  "profile.add",
  "profile.list",
  "profile.show",
  "profile.remove",
  "session.summary",
  "query",
  "filter",
  "exec",
  "mongo.query",
  "mongo.exec",
  "mongo.plan",
  "show",
  "rows",
  "count",
  "columns",
  "alias.set",
  "inspect",
  "transaction.begin",
  "transaction.status",
  "transaction.commit",
  "transaction.rollback",
  "plan",
  "apply",
  "history",
  "receipt",
  "doctor",
  "capabilities",
] as const;

const toolSchema = Type.Object(
  {
    command: StringEnum(COMMANDS, { description: "StateQL command" }),
    target: Type.Optional(
      Type.String({
        description:
          "connect/profile.add only: SQLite path or credential-free PostgreSQL/MySQL URL. In Pylon Web, a server URL with username but no password opens a masked password dialog. URL file options such as sslrootcert must use a native absolute path visible to the host process (for example, a percent-encoded C:/... path on Windows), not a shell-only /tmp path.",
        maxLength: 4096,
      }),
    ),
    sql: Type.Optional(Type.String({ description: "query/exec/plan only: one SQL statement", maxLength: 100_000 })),
    where: Type.Optional(Type.String({ description: "filter only: SQL predicate", maxLength: 20_000 })),
    handle: Type.Optional(
      Type.String({
        description:
          "show/rows/count/columns/alias.set/transaction.status/transaction.commit/transaction.rollback/apply/receipt only",
        maxLength: 200,
      }),
    ),
    name: Type.Optional(
      Type.String({ description: "connect/profile.add/profile.show/profile.remove/alias.set only", maxLength: 200 }),
    ),
    as: Type.Optional(Type.String({ description: "query/filter/mongo.query only: result alias", maxLength: 200 })),
    kind: Type.Optional(
      StringEnum(["schema", "table", "columns", "indexes", "constraints"] as const, { description: "inspect only" }),
    ),
    table: Type.Optional(Type.String({ description: "inspect only: optional qualified table name", maxLength: 500 })),
    mongo: Type.Optional(
      Type.Any({ description: "mongo.query/mongo.exec/mongo.plan only: bounded MongoDB native command" }),
    ),
    params: Type.Optional(
      Type.Any({ description: "query/filter/exec/plan only: positional JSON array or named JSON object" }),
    ),
    cache: Type.Optional(StringEnum(["auto", "bypass", "require"] as const, { description: "query/mongo.query only" })),
    read_only: Type.Optional(Type.Boolean({ description: "connect/profile.add only" })),
    secret_env: Type.Optional(
      Type.String({
        description:
          "connect/profile.add only: environment variable whose value is the complete PostgreSQL/MySQL URL or explicit sqlite:<path> source; use instead of target",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        maxLength: 200,
      }),
    ),
    profile: Type.Optional(Type.String({ description: "connect only: saved profile name", maxLength: 200 })),
    replay: Type.Optional(Type.Boolean({ description: "exec/mongo.exec only" })),
    idempotency_key: Type.Optional(Type.String({ description: "exec/mongo.exec only", maxLength: 500 })),
    allow_unbounded: Type.Optional(Type.Boolean({ description: "exec/plan/mongo.exec/mongo.plan only" })),
    allow_destructive: Type.Optional(Type.Boolean({ description: "exec/plan/mongo.exec/mongo.plan only" })),
    offset: Type.Optional(
      Type.Integer({
        description:
          "rows only: zero-based start; when the complete truncated query preview is present, continue from preview_count instead of refetching offset 0",
        minimum: 0,
        maximum: 10_000,
      }),
    ),
    limit: Type.Optional(Type.Integer({ description: "rows/history only", minimum: 1, maximum: 100 })),
    history_origin: Type.Optional(
      StringEnum(["legacy", "user", "model", "system", "api"] as const, {
        description: "history retrieval origin filter; does not change attribution",
      }),
    ),
    isolation: Type.Optional(Type.String({ description: "transaction.begin only", maxLength: 50 })),
    timeout_ms: Type.Optional(
      Type.Integer({
        description: "connect/query/exec/inspect/transaction.commit/plan/apply/mongo.query/mongo.exec/mongo.plan only",
        minimum: 1,
        maximum: 2_147_483_647,
      }),
    ),
  },
  { additionalProperties: false },
);

export type StateQLToolInput = Static<typeof toolSchema>;

type RuntimeStateQL = Pick<StateQL, "close" | "executeCommand" | "snapshot">;
type Factory = (options: StateQLActorOptions) => RuntimeStateQL;

interface Runtime {
  actorId: string;
  controller: AbortController;
  stateql: RuntimeStateQL;
}

interface StateQLPasswordTarget {
  driver: "postgres" | "mysql" | "mongodb";
  username: string;
  hostname: string;
  port: number;
  database: string;
}

interface StateQLCredentialHost {
  requestStateQLCredential(request: CredentialRequest): Promise<string | undefined>;
  requestStateQLPassword?(
    request: CredentialRequest,
    target: StateQLPasswordTarget,
    options?: { timeoutMs: number; remember?: { reference: string; target: string } },
  ): Promise<string | undefined>;
  invalidateStateQLPassword?(request: CredentialRequest, target: StateQLPasswordTarget): void;
  invalidateStateQLCredential?(request: CredentialRequest): void;
  hasStateQLCredential?(reference: string, target?: string): Promise<boolean>;
  forgetStateQLCredential?(reference: string): Promise<boolean>;
}

function credentialHost(value: unknown): StateQLCredentialHost | undefined {
  if (!value || typeof value !== "object") return undefined;
  return typeof (value as Partial<StateQLCredentialHost>).requestStateQLCredential === "function"
    ? (value as StateQLCredentialHost)
    : undefined;
}

interface SnapshotRequest {
  version: 1;
  sessionId: string;
  historyLimit?: number;
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<StateQLSnapshot>): void;
}

interface RowsRequest {
  version: 1;
  sessionId: string;
  handle: string;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
}

interface PanelCommandRequest {
  version: 1;
  sessionId: string;
  command: unknown;
  signal?: AbortSignal;
  ui: unknown;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
}
interface StateQLCommandUi extends StateQLCredentialHost {
  confirm(title: string, message: string, options?: { timeout: number }): Promise<boolean>;
  setStatus?(key: string, text: string | undefined): void;
}
function commandUi(value: unknown): StateQLCommandUi | undefined {
  const host = credentialHost(value);
  return host && typeof (value as Partial<StateQLCommandUi>).confirm === "function"
    ? (value as StateQLCommandUi)
    : undefined;
}

function abortSignal(value: unknown): value is AbortSignal | undefined {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === "object" &&
      typeof (value as AbortSignal).aborted === "boolean" &&
      typeof (value as AbortSignal).addEventListener === "function")
  );
}

const fields: Record<StateQLToolInput["command"], readonly (keyof StateQLToolInput)[]> = {
  connect: ["target", "name", "read_only", "secret_env", "profile", "timeout_ms"],
  disconnect: [],
  status: [],
  "profile.add": ["name", "target", "read_only", "secret_env"],
  "profile.list": [],
  "profile.show": ["name"],
  "profile.remove": ["name"],
  "session.summary": [],
  query: ["sql", "params", "cache", "as", "timeout_ms"],
  filter: ["handle", "where", "params", "as"],
  exec: ["sql", "params", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "mongo.query": ["mongo", "cache", "as", "timeout_ms"],
  "mongo.exec": ["mongo", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  show: ["handle"],
  rows: ["handle", "offset", "limit"],
  count: ["handle"],
  columns: ["handle"],
  "alias.set": ["name", "handle"],
  inspect: ["kind", "table", "timeout_ms"],
  "transaction.begin": ["isolation"],
  "transaction.status": ["handle"],
  "transaction.commit": ["handle", "timeout_ms"],
  "transaction.rollback": ["handle"],
  plan: ["sql", "params", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "mongo.plan": ["mongo", "allow_unbounded", "allow_destructive", "timeout_ms"],
  apply: ["handle", "timeout_ms"],
  history: ["limit", "history_origin"],
  receipt: ["handle"],
  doctor: [],
  capabilities: [],
};

const required: Partial<Record<StateQLToolInput["command"], readonly (keyof StateQLToolInput)[]>> = {
  "profile.add": ["name"],
  "profile.show": ["name"],
  "profile.remove": ["name"],
  query: ["sql"],
  filter: ["handle", "where"],
  exec: ["sql"],
  "mongo.query": ["mongo"],
  "mongo.exec": ["mongo"],
  show: ["handle"],
  rows: ["handle"],
  count: ["handle"],
  columns: ["handle"],
  "alias.set": ["name", "handle"],
  inspect: ["kind"],
  plan: ["sql"],
  "mongo.plan": ["mongo"],
  apply: ["handle"],
  receipt: ["handle"],
};

const CONFIRMED_COMMANDS = new Set<StateQLToolInput["command"]>([
  "connect",
  "profile.add",
  "profile.remove",
  "exec",
  "mongo.exec",
  "apply",
  "transaction.commit",
  "transaction.rollback",
]);
const MAX_PARAMS_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 40 * 1024;
const BROKERED_REFERENCE_PREFIX = "PYLON_STATEQL_BROKERED_";
const ENDPOINT_QUERY_KEYS = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
  "user",
  "username",
  "password",
  "socketpath",
]);

const PANEL_COMMANDS = new Set<StateQLPanelCommand["command"]>([
  "status",
  "profile.list",
  "profile.show",
  "profile.add",
  "profile.remove",
  "connect",
  "disconnect",
  "query",
  "history",
  "inspect",
  "exec",
  "plan",
  "apply",
  "mongo.query",
  "mongo.exec",
  "mongo.plan",
  "transaction.begin",
  "transaction.status",
  "transaction.commit",
  "transaction.rollback",
  "receipt",
]);

function validJsonPayload(value: unknown, depth = 0, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 64 * 1024;
  if (depth >= 6 || typeof value !== "object" || value === undefined || ancestors.has(value)) return false;
  if (!Array.isArray(value) && (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  if (items.length > 100) return false;
  ancestors.add(value);
  const valid = items.every(item => validJsonPayload(item, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

function boundedJson(value: unknown, label: string): void {
  if ((!Array.isArray(value) && !record(value)) || !validJsonPayload(value)) {
    throw new Error(`${label} must contain bounded JSON values`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_PARAMS_BYTES) {
    throw new Error(`${label} cannot exceed ${formatSize(MAX_PARAMS_BYTES)}`);
  }
}
function validateInput(input: StateQLToolInput): BatchCommand & StateQLToolInput {
  if (PANEL_COMMANDS.has(input.command as StateQLPanelCommand["command"])) {
    const parsed = parseStateQLPanelCommand(input, { maxTimeoutMs: 2_147_483_647 });
    if (!parsed) {
      const allowed = new Set(["command", ...(fields[input.command] ?? [])]);
      const unexpected = Object.keys(input).find(
        key => input[key as keyof StateQLToolInput] !== undefined && !allowed.has(key as keyof StateQLToolInput),
      );
      if (input.command === "connect" && input.target !== undefined && input.secret_env !== undefined) {
        throw new Error(
          "connect accepts either target or secret_env; secret_env must contain a complete database URL or explicit sqlite:<path> source",
        );
      }
      if (unexpected) throw new Error(`${input.command} does not accept ${unexpected}`);
      if (input.params !== undefined) boundedJson(input.params, "params");
      if (input.command.startsWith("mongo.")) throw new Error(`${input.command} has an invalid MongoDB command`);
      throw new Error(`${input.command} has invalid input`);
    }
    return parsed as BatchCommand & StateQLToolInput;
  }
  const commandFields = fields[input.command];
  if (!commandFields) throw new Error(`Unknown StateQL command ${String(input.command)}`);
  const allowed = new Set<keyof StateQLToolInput>(["command", ...commandFields]);
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !allowed.has(key as keyof StateQLToolInput))
      throw new Error(`${input.command} does not accept ${key}`);
  for (const key of required[input.command] ?? [])
    if (input[key] === undefined || input[key] === "") throw new Error(`${input.command} requires ${String(key)}`);
  const limits: Partial<Record<keyof StateQLToolInput, number>> = {
    target: 4096,
    sql: 100_000,
    where: 20_000,
    handle: 200,
    name: 200,
    as: 200,
    kind: 50,
    table: 500,
    secret_env: 200,
    profile: 200,
    idempotency_key: 500,
    isolation: 50,
  };
  for (const [key, maximum] of Object.entries(limits)) {
    const value = input[key as keyof StateQLToolInput];
    if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > maximum!))
      throw new Error(`${input.command} has invalid ${key}`);
  }
  for (const key of ["read_only", "replay", "allow_unbounded", "allow_destructive"] as const)
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(`${input.command} has invalid ${key}`);
  if (input.command === "connect" || input.command === "profile.add") {
    if (input.command === "connect" && input.target !== undefined && input.secret_env !== undefined)
      throw new Error(
        "connect accepts either target or secret_env; secret_env must contain a complete database URL or explicit sqlite:<path> source",
      );
    const sources = [input.target, input.secret_env, ...(input.command === "connect" ? [input.profile] : [])].filter(
      value => value !== undefined,
    );
    if (sources.length !== 1) throw new Error(`${input.command} accepts exactly one connection source`);
    if (input.secret_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(input.secret_env))
      throw new Error("secret_env is invalid");
  }
  if (["query", "exec", "plan"].includes(input.command) && typeof input.sql !== "string")
    throw new Error(`${input.command} requires sql`);
  if (input.command === "filter" && (typeof input.handle !== "string" || typeof input.where !== "string"))
    throw new Error("filter requires handle and where");
  if (input.kind !== undefined && !["schema", "table", "columns", "indexes", "constraints"].includes(input.kind))
    throw new Error("inspect has invalid kind");
  if (
    input.isolation !== undefined &&
    !/^(?:serializable|repeatable[ _-]+read|read[ _-]+committed|read[ _-]+uncommitted|snapshot)$/iu.test(
      input.isolation.trim(),
    )
  )
    throw new Error("transaction.begin has invalid isolation");
  if (
    input.history_origin !== undefined &&
    !["legacy", "user", "model", "system", "api"].includes(input.history_origin)
  )
    throw new Error("history has invalid history_origin");
  for (const key of ["timeout_ms", "offset", "limit"] as const) {
    const value = input[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) ||
        value < 0 ||
        value > (key === "limit" ? 100 : key === "offset" ? 10_000 : 2_147_483_647))
    )
      throw new Error(`${input.command} has invalid ${key}`);
    if ((key === "timeout_ms" || key === "limit") && value === 0) throw new Error(`${key} must be positive`);
  }
  if (input.cache !== undefined && !["auto", "bypass", "require"].includes(input.cache))
    throw new Error("cache is invalid");
  if (input.params !== undefined) boundedJson(input.params, "params");
  return input as BatchCommand & StateQLToolInput;
}

function panelCommand(value: unknown): StateQLPanelCommand | undefined {
  return parseStateQLPanelCommand(value);
}

interface BrokeredTarget {
  source: string;
  prompt: StateQLPasswordTarget;
}

interface RuntimeBrokeredTarget extends BrokeredTarget {
  actorId: string;
  passwordTimeoutMs: number;
  stateqlSessionId?: string;
  request?: CredentialRequest;
}

function brokeredTarget(value: string): BrokeredTarget | undefined {
  try {
    const url = new URL(value);
    const driver: StateQLPasswordTarget["driver"] | undefined =
      url.protocol === "postgres:" || url.protocol === "postgresql:"
        ? "postgres"
        : url.protocol === "mysql:"
          ? "mysql"
          : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
            ? "mongodb"
            : undefined;
    if (!driver || !url.username || url.password || !url.hostname || url.hash) return undefined;
    if ([...url.searchParams.keys()].some(key => ENDPOINT_QUERY_KEYS.has(key.toLowerCase()))) return undefined;
    const defaultPort = driver === "postgres" ? "5432" : driver === "mysql" ? "3306" : "27017";
    const port = Number(url.port || defaultPort);
    const database = url.pathname.replace(/^\//u, "");
    const prompt = {
      driver,
      username: decodeURIComponent(url.username),
      hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
      port,
      database,
    };
    return { source: value, prompt };
  } catch {
    return undefined;
  }
}

function brokeredReference(): string {
  return `${BROKERED_REFERENCE_PREFIX}${randomBytes(24).toString("hex").toUpperCase()}`;
}

function durableReference(): string {
  return `pylon:stateql:v1:${randomUUID()}`;
}

function insecureTls(target: string | undefined): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const sslMode = url.searchParams.getAll("sslmode").at(-1)?.toLowerCase();
    const libpqCompat = url.searchParams.getAll("uselibpqcompat").at(-1)?.toLowerCase() === "true";
    return (
      sslMode === "disable" ||
      sslMode === "no-verify" ||
      (libpqCompat && (sslMode === undefined || ["prefer", "require", "verify-ca"].includes(sslMode))) ||
      url.searchParams.get("ssl")?.toLowerCase() === "false" ||
      url.searchParams.get("rejectUnauthorized")?.toLowerCase() === "false"
    );
  } catch {
    return false;
  }
}

function confirmationText(input: StateQLToolInput, brokered = false): string {
  switch (input.command) {
    case "connect": {
      const source = input.profile
        ? `profile “${input.profile}”`
        : input.secret_env
          ? `environment variable ${input.secret_env}, which must contain a complete PostgreSQL/MySQL URL or explicit sqlite:<path> source`
          : brokered
            ? "the provided passwordless target using its securely brokered password approval"
            : "the provided target";
      const tlsWarning = insecureTls(input.target)
        ? " Warning: this target weakens or disables TLS certificate or hostname verification."
        : "";
      return `Connect StateQL using ${source} in ${input.read_only === false ? "read-write" : "read-only"} mode? Queries may expose database content to the selected model provider.${tlsWarning}`;
    }
    case "profile.add":
      return `Save StateQL profile “${input.name ?? ""}” in ${input.read_only === false ? "read-write" : "read-only"} mode? Credential values are not stored.`;
    case "profile.remove":
      return `Remove StateQL profile “${input.name ?? ""}”? Existing database data is not changed.`;
    case "exec": {
      const overrides = [
        input.replay && "replay",
        input.allow_unbounded && "unbounded mutation",
        input.allow_destructive && "destructive operation",
      ].filter(Boolean);
      return `Execute a database write${overrides.length ? ` with ${overrides.join(", ")} override${overrides.length === 1 ? "" : "s"}` : ""}? StateQL duplicate and read-only safeguards remain authoritative. Parameters and results may be retained in Pi history.`;
    }
    case "mongo.exec":
      return `Execute MongoDB ${input.mongo && typeof input.mongo === "object" && "operation" in input.mongo ? String((input.mongo as { operation?: unknown }).operation) : "write"}? StateQL mutation and read-only safeguards remain authoritative.`;
    case "apply":
      return `Apply StateQL write plan “${input.handle ?? ""}”? The stored authorization flags and state checks remain authoritative.`;
    case "transaction.commit":
      return `Commit the active StateQL transaction and execute its staged writes?`;
    case "transaction.rollback":
      return `Roll back the active StateQL transaction and discard its staged writes?`;
    default:
      return "Allow this StateQL operation?";
  }
}

function fit(value: string, maxBytes: number): string {
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return output;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tabularRows(value: unknown, declaredColumns?: string[]): { columns: string[]; rows: unknown[][] } | undefined {
  if (!Array.isArray(value) || !value.every(record)) return undefined;
  const columns = declaredColumns ? [...declaredColumns] : [...new Set(value.flatMap(row => Object.keys(row)))];
  if (
    new Set(columns).size !== columns.length ||
    !value.every(row => {
      const keys = Object.keys(row);
      return (
        keys.length === columns.length &&
        columns.every(column => Object.hasOwn(row, column) && row[column] !== undefined)
      );
    })
  )
    return undefined;
  return { columns, rows: value.map(row => columns.map(column => row[column])) };
}

function modelResponse(response: Response<unknown>, command: StateQLToolInput["command"]): Response<unknown> {
  if (!response.ok || !record(response.data)) return response;
  const data = response.data;
  if (
    (command === "query" || command === "filter" || command === "mongo.query") &&
    Array.isArray(data.columns) &&
    data.columns.every(column => record(column) && typeof column.name === "string" && typeof column.type === "string")
  ) {
    const columnMetadata = data.columns as Array<{ name: string; type: string }>;
    const table = tabularRows(
      data.preview,
      columnMetadata.map(column => column.name),
    );
    if (table)
      return {
        ...response,
        data: {
          ...data,
          columns: table.columns,
          column_types: columnMetadata.map(column => column.type),
          preview: table.rows,
        },
      };
  }
  if (command === "rows") {
    const table = tabularRows(data.rows);
    if (table) return { ...response, data: { ...data, columns: table.columns, rows: table.rows } };
  }
  return response;
}

function boundedResponse(
  response: Response<unknown>,
  command: StateQLToolInput["command"],
): { text: string; truncated: boolean } {
  const output = JSON.stringify(modelResponse(response, command), null, 2);
  const result = truncateHead(output, { maxLines: 1_000, maxBytes: MAX_OUTPUT_BYTES });
  if (!result.truncated) return { text: result.content, truncated: false };
  const notice = `\n\n[StateQL output truncated at ${formatSize(MAX_OUTPUT_BYTES)}. Request a smaller rows limit or narrower query.]`;
  return {
    text: `${fit(result.content, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8"))}${notice}`,
    truncated: true,
  };
}

function boundedError(value: string, maxBytes = 2_000): string {
  const redacted = value
    .trim()
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@")
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=***");
  return fit(redacted, maxBytes);
}

function safeFailure(response: Extract<Response<unknown>, { ok: false }>): Error {
  return new Error(`StateQL ${response.error.code}: ${boundedError(response.error.message)}`);
}

function passwordAuthenticationFailed(response: Extract<Response<unknown>, { ok: false }>): boolean {
  return (
    response.error.code === "CONNECTION_FAILED" &&
    /password authentication failed|sasl[^\n]*password|password[^\n]*authentication failed|access denied for user/iu.test(
      response.error.message,
    )
  );
}

function sessionId(ctx: any): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (typeof id !== "string" || !id || id.length > 128)
    throw new Error("StateQL requires a stable Pi session identity");
  return id;
}

export default function stateqlExtension(pi: ExtensionAPI, options: { createStateQL?: Factory } = {}) {
  const createStateQL: Factory = options.createStateQL ?? (value => StateQL.forActor(value));
  let runtime: Runtime | undefined;
  let activeCredentialHost: StateQLCredentialHost | undefined;
  const brokeredTargets = new Map<string, RuntimeBrokeredTarget>();
  let stopping = false;
  let approvalTiming: { guardEnabled: boolean; timeoutSeconds: number | null } = {
    guardEnabled: false,
    timeoutSeconds: null,
  };
  let tail: Promise<void> = Promise.resolve();

  const exclusive = <T>(action: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(action, action);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const open = (actorId: string): Runtime => {
    const controller = new AbortController();
    return {
      actorId,
      controller,
      stateql: createStateQL({
        actor: actorId,
        signal: controller.signal,
        credentialResolver: async request => {
          if (request.reference.startsWith(BROKERED_REFERENCE_PREFIX)) {
            const target = brokeredTargets.get(request.reference);
            if (
              !target ||
              target.actorId !== request.actorId ||
              (target.stateqlSessionId && target.stateqlSessionId !== request.session.id)
            )
              return undefined;
            target.stateqlSessionId ??= request.session.id;
            target.request = { ...request, signal: undefined };
            const password = await activeCredentialHost?.requestStateQLPassword?.(request, target.prompt, {
              timeoutMs: target.passwordTimeoutMs,
            });
            if (password === undefined) return undefined;
            const source = new URL(target.source);
            source.password = encodeURIComponent(password);
            return source.toString();
          }
          const configured = process.env[request.reference];
          if (configured !== undefined) return configured;
          return activeCredentialHost?.requestStateQLCredential(request);
        },
      }),
    };
  };
  const replaceAborted = (active: Runtime): void => {
    if (runtime !== active || !active.controller.signal.aborted || stopping) return;
    active.stateql.close();
    runtime = open(active.actorId);
  };
  const current = (actorId?: string): Runtime => {
    if (!runtime || stopping || (actorId && runtime.actorId !== actorId))
      throw new Error("StateQL is unavailable for this Pi session");
    return runtime;
  };

  const disposePolicy = pi.events.on("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2 || typeof event.sessionId !== "string" || event.sessionId !== runtime?.actorId) return;
    const timeoutSeconds = event.dialogTimeouts?.guard;
    approvalTiming =
      typeof event.guardEnabled === "boolean" &&
      (timeoutSeconds === null ||
        (typeof timeoutSeconds === "number" &&
          Number.isInteger(timeoutSeconds) &&
          timeoutSeconds >= 15 &&
          timeoutSeconds <= 86_400))
        ? { guardEnabled: event.guardEnabled, timeoutSeconds }
        : { guardEnabled: false, timeoutSeconds: null };
  });

  const disposeSnapshot = pi.events.on("pylon:stateql-snapshot-request", (value: unknown) => {
    const request = value && typeof value === "object" ? (value as Partial<SnapshotRequest>) : undefined;
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      request.sessionId !== runtime?.actorId ||
      typeof request.claim !== "function" ||
      typeof request.respond !== "function" ||
      !request.claim()
    )
      return;
    const historyLimit = request.historyLimit ?? 50;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) return;
    request.respond(
      Promise.resolve().then(() => {
        if (request.signal?.aborted) throw new Error("StateQL snapshot request cancelled");
        return current(request.sessionId).stateql.snapshot({ historyLimit });
      }),
    );
  });

  const disposeRows = pi.events.on("pylon:stateql-rows-request", (value: unknown) => {
    const request = value && typeof value === "object" ? (value as Partial<RowsRequest>) : undefined;
    // Validate everything before claiming so malformed requests remain available to another owner.
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      request.sessionId !== runtime?.actorId ||
      typeof request.handle !== "string" ||
      !request.handle.trim() ||
      request.handle.length > 200 ||
      typeof request.offset !== "number" ||
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      request.offset > 10_000 ||
      typeof request.limit !== "number" ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      typeof request.claim !== "function" ||
      typeof request.respond !== "function" ||
      !abortSignal(request.signal)
    )
      return;
    if (!request.claim()) return;
    request.respond(
      exclusive(async () => {
        if (request.signal?.aborted) throw new Error("StateQL rows request cancelled");
        const response = await current(request.sessionId).stateql.executeCommand(
          { command: "rows", handle: request.handle, offset: request.offset, limit: request.limit } as BatchCommand,
          { signal: request.signal, origin: "user" },
        );
        if (!response.ok) throw safeFailure(response);
        return response.data;
      }),
    );
  });

  const disposeCommand = pi.events.on("pylon:stateql-command-request", (value: unknown) => {
    const request = value && typeof value === "object" ? (value as Partial<PanelCommandRequest>) : undefined;
    const command = panelCommand(request?.command);
    const ui = commandUi(request?.ui);
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      request.sessionId !== runtime?.actorId ||
      !command ||
      !ui ||
      typeof request.claim !== "function" ||
      typeof request.respond !== "function" ||
      !abortSignal(request.signal)
    )
      return;
    if (!request.claim()) return;
    request.respond(
      (async () => {
        const input =
          command.command === "history" && command.history_origin === undefined
            ? { ...command, history_origin: "user" as const }
            : command;
        const remembers = "remember" in input && input.remember === true;
        const target =
          (input.command === "connect" || input.command === "profile.add") && input.target && ui.requestStateQLPassword
            ? brokeredTarget(input.target)
            : undefined;
        const insecureBrokeredConnect = Boolean(target && insecureTls(target.source));
        const passwordTimeoutMs =
          approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
            ? approvalTiming.timeoutSeconds * 1_000
            : 0;
        if (
          CONFIRMED_COMMANDS.has(input.command as StateQLToolInput["command"]) &&
          (!target || insecureBrokeredConnect)
        ) {
          const title = insecureBrokeredConnect ? "Allow insecure database TLS?" : "Allow StateQL operation?";
          if (
            !(await ui.confirm(title, confirmationText(input as StateQLToolInput, Boolean(target)), {
              timeout: passwordTimeoutMs,
            }))
          ) {
            return { declined: true };
          }
        }
        if (request.signal?.aborted) throw new Error("StateQL command request cancelled");

        const {
          remember: _remember,
          forget_credential: forgetCredential,
          ...stateqlInput
        } = input as StateQLPanelCommand & { remember?: boolean; forget_credential?: boolean };
        let reference: string | undefined;
        let credentialSaved = false;
        let executionCommand = stateqlInput as BatchCommand;
        if (target && remembers) {
          const transientReference = brokeredReference();
          const savedReference = durableReference();
          const snapshot = current(request.sessionId).stateql.snapshot({ historyLimit: 1 });
          const credentialRequest = {
            reference: transientReference,
            actorId: request.sessionId,
            session: { id: snapshot.session.session_id, name: snapshot.session.name },
            operation: "connect",
            access: input.read_only === false ? "write" : "read",
            requestedReadOnly: input.read_only !== false,
            signal: request.signal,
          } as CredentialRequest;
          const password = await ui.requestStateQLPassword?.(credentialRequest, target.prompt, {
            timeoutMs: passwordTimeoutMs,
            remember: { reference: savedReference, target: target.source },
          });
          if (password === undefined) return { declined: true };
          credentialSaved = (await ui.hasStateQLCredential?.(savedReference, target.source)) === true;
          const { target: _target, ...withoutTarget } = stateqlInput as Record<string, unknown>;
          if (credentialSaved) {
            executionCommand = { ...withoutTarget, credential_ref: savedReference } as BatchCommand;
          } else if (input.command === "connect") {
            reference = transientReference;
            executionCommand = { ...withoutTarget, secret_env: reference } as BatchCommand;
            brokeredTargets.set(transientReference, { ...target, actorId: request.sessionId!, passwordTimeoutMs });
          }
        } else if (target && input.command === "connect") {
          const transientReference = brokeredReference();
          reference = transientReference;
          const { target: _target, ...withoutTarget } = stateqlInput as Record<string, unknown>;
          executionCommand = { ...withoutTarget, secret_env: transientReference } as BatchCommand;
          brokeredTargets.set(transientReference, { ...target, actorId: request.sessionId!, passwordTimeoutMs });
        }

        ui.setStatus?.("pi-stateql", `database: ${input.command}`);
        try {
          return await exclusive(async () => {
            if (request.signal?.aborted) throw new Error("StateQL command request cancelled");
            let credentialToForget: string | undefined;
            if (input.command === "profile.remove" && forgetCredential) {
              const shown = await current(request.sessionId).stateql.executeCommand(
                { command: "profile.show", name: input.name },
                { signal: request.signal, origin: "user" },
              );
              if (shown.ok && record(shown.data) && typeof shown.data.credential_ref === "string") {
                credentialToForget = shown.data.credential_ref;
              }
            }
            let response: Response<unknown>;
            activeCredentialHost = ui;
            try {
              response = await current(request.sessionId).stateql.executeCommand(executionCommand, {
                signal: request.signal,
                origin: "user",
              });
            } catch (error) {
              if (reference) brokeredTargets.delete(reference);
              throw error;
            } finally {
              activeCredentialHost = undefined;
            }
            if (reference) {
              const brokered = brokeredTargets.get(reference);
              if (!response.ok && brokered?.request && passwordAuthenticationFailed(response)) {
                ui.invalidateStateQLPassword?.(brokered.request, brokered.prompt);
              }
              brokeredTargets.delete(reference);
            }
            if (response.ok && credentialToForget) await ui.forgetStateQLCredential?.(credentialToForget);
            if (response.ok && remembers && !credentialSaved) {
              response = {
                ...response,
                warnings: [
                  ...response.warnings,
                  {
                    code: "CREDENTIAL_NOT_SAVED",
                    message: "The OS credential vault was unavailable; this connection remains memory-only.",
                  },
                ],
              };
            }
            return response;
          });
        } finally {
          ui.setStatus?.("pi-stateql", undefined);
        }
      })(),
    );
  });

  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond(
      exclusive(async () => {
        const snapshot = current().stateql.snapshot({ historyLimit: 1 });
        const connection = snapshot.connection
          ? `${snapshot.connection.driver} (${snapshot.connection.read_only ? "read-only" : "read-write"})`
          : "none";
        return {
          version: 1,
          owner: "pi-stateql",
          label: "StateQL",
          lines: [
            `Workspace: ${snapshot.session.name} (${snapshot.session.status})`,
            `Actor: ${snapshot.actor_id}`,
            `Connection: ${connection}`,
            `History: ${snapshot.history.length ? "available" : "empty"}`,
          ],
          warning: snapshot.session.status !== "active",
        };
      }),
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    stopping = false;
    approvalTiming = { guardEnabled: false, timeoutSeconds: null };
    brokeredTargets.clear();
    const id = sessionId(ctx);
    await exclusive(() => {
      runtime?.stateql.close();
      runtime = open(id);
    });
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-stateql",
      managedTools: ["stateql"],
      enabledTools: ["stateql"],
      deferredTools: ["stateql"],
      toolUsage: { stateql: "query and safely modify databases with durable result handles" },
    });
  });

  pi.on("session_shutdown", async () => {
    stopping = true;
    brokeredTargets.clear();
    runtime?.controller.abort();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-stateql" });
    disposePolicy();
    disposeSnapshot();
    disposeRows();
    disposeCommand();
    disposeHealth();
    await exclusive(() => {
      runtime?.stateql.close();
      runtime = undefined;
    });
  });

  pi.registerTool({
    name: "stateql",
    label: "StateQL",
    description:
      "Perform user-requested SQLite, PostgreSQL, MySQL, or MongoDB work. Prefer read-only profiles and parameterized SQL or bounded native MongoDB commands. Query output includes normalized parallel-column previews; call rows only when truncated or additional rows are needed. Plan consequential writes when practical and confirm writes, plan application, and transaction completion. Supports schema inspection, MongoDB reads/writes/plans, transactions, receipts, and history; cross-session lifecycle, purge, and arbitrary export are unavailable. Output is capped at 40 KB.",
    promptSnippet: "Query and safely modify databases with durable StateQL result handles",
    promptGuidelines: [
      "Use stateql for user-requested database work; prefer read-only profiles and parameterized SQL with explicit ORDER BY and LIMIT.",
      "For PostgreSQL/MySQL targets, include the username but never a password in target; Pylon Web will request the password through a masked dialog. Use secret_env when the complete source already lives in an environment variable.",
      "Never weaken TLS or certificate verification without explicit user authorization; prefer configuring the database CA certificate with a native host absolute path, not a shell-only path such as /tmp on Windows.",
      "StateQL query output already includes preview rows in model context. Call StateQL rows only when the result is truncated or missing needed rows; when the complete preview is present, continue from preview_count instead of duplicating it from offset 0.",
      "Reuse StateQL result handles with filter, rows, count, and columns instead of rerunning queries.",
      "Use StateQL plan before consequential writes when practical; never set replay, unbounded, or destructive overrides without explicit user authorization.",
      "Use mongo.query for bounded find or aggregate reads and mongo.plan before consequential MongoDB writes; use mongo.exec only with explicit user authorization.",
      "Use history_origin=user to filter Database panel history retrieval without changing the command origin.",
      "Use doctor to diagnose StateQL storage integrity or STATE_CORRUPTED failures; purge remains unavailable.",
    ],
    parameters: toolSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input: StateQLToolInput, signal, onUpdate, ctx) {
      const command = validateInput(input);
      const id = sessionId(ctx);
      const host = credentialHost(ctx.ui);
      const target =
        command.command === "connect" && command.target && host?.requestStateQLPassword
          ? brokeredTarget(command.target)
          : undefined;
      const insecureBrokeredConnect = Boolean(target && insecureTls(input.target));
      const passwordTimeoutMs =
        approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
          ? approvalTiming.timeoutSeconds * 1_000
          : 0;
      const requiresConfirmation = CONFIRMED_COMMANDS.has(command.command) && (!target || insecureBrokeredConnect);
      if (requiresConfirmation) {
        if (!ctx.hasUI) throw new Error(`${input.command} requires interactive confirmation`);
        const title = insecureBrokeredConnect ? "Allow insecure database TLS?" : "Allow StateQL operation?";
        if (!(await ctx.ui.confirm(title, confirmationText(input, Boolean(target)), { timeout: passwordTimeoutMs }))) {
          return {
            content: [{ type: "text" as const, text: "User declined the StateQL operation; nothing was executed." }],
            details: { command: input.command, declined: true },
          };
        }
      }
      let reference: string | undefined;
      let executionCommand = command;
      if (target) {
        reference = brokeredReference();
        const { target: _target, ...withoutTarget } = command;
        executionCommand = { ...withoutTarget, secret_env: reference } as BatchCommand & StateQLToolInput;
        brokeredTargets.set(reference, { ...target, actorId: id, passwordTimeoutMs });
      }
      onUpdate?.({
        content: [{ type: "text" as const, text: `Running StateQL ${input.command}...` }],
        details: { command: input.command },
      });
      if (ctx.hasUI) ctx.ui.setStatus?.("pi-stateql", `database: ${input.command}`);
      try {
        return await exclusive(async () => {
          const active = current(id);
          if (signal?.aborted) throw new Error("StateQL operation cancelled");
          let response: Response<unknown>;
          activeCredentialHost = host;
          try {
            response = await active.stateql.executeCommand(executionCommand, { signal, origin: "model" });
          } catch (error) {
            if (reference) brokeredTargets.delete(reference);
            throw error;
          } finally {
            activeCredentialHost = undefined;
          }
          if (!response.ok) {
            if (reference) {
              const brokered = brokeredTargets.get(reference);
              if (brokered?.request && passwordAuthenticationFailed(response)) {
                host?.invalidateStateQLPassword?.(brokered.request, brokered.prompt);
              }
              brokeredTargets.delete(reference);
            }
            throw safeFailure(response);
          }
          const output = boundedResponse(response, input.command);
          return {
            content: [{ type: "text" as const, text: output.text }],
            details: {
              command: input.command,
              commandId: response.command_id,
              sessionId: response.session_id,
              truncated: output.truncated,
            },
          };
        });
      } finally {
        if (ctx.hasUI) ctx.ui.setStatus?.("pi-stateql", undefined);
      }
    },
  });
}

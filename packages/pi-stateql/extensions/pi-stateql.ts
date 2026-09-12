import { createHash, randomBytes, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  StateQL,
  type BatchCommand,
  type CatalogObjectKind,
  type CredentialRequest,
  type Response,
  type StateQLActorOptions,
  type StateQLSnapshot,
} from "@fadhilp/stateql";
import { Type, type Static } from "typebox";
import { parseStateQLPanelCommand, type StateQLPanelCommand } from "../src/stateql-command.ts";
import {
  insecureTls,
  materializeConnectionTarget,
  runConnectionSetup,
  type SetupPasswordOptions,
} from "../src/connection-setup.ts";

const COMMANDS = [
  "workspace.select",
  "workspace.status",
  "connect",
  "disconnect",
  "status",
  "profile.add",
  "profile.update",
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
  "redis.query",
  "redis.exec",
  "redis.plan",
  "objects.list",
  "object.describe",
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
    workspace: Type.Optional(
      StringEnum(["session", "global"] as const, {
        description: "StateQL workspace; defaults to the current selection, initially session",
      }),
    ),
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
      Type.String({
        description: "connect/profile.add/profile.update/profile.show/profile.remove/alias.set only",
        maxLength: 200,
      }),
    ),
    as: Type.Optional(Type.String({ description: "query/filter/mongo.query only: result alias", maxLength: 200 })),
    kind: Type.Optional(
      StringEnum(
        [
          "schema",
          "table",
          "columns",
          "indexes",
          "constraints",
          "view",
          "collection",
          "function",
          "trigger",
          "enum",
          "key",
        ] as const,
        { description: "inspect or objects.list only" },
      ),
    ),
    schema: Type.Optional(Type.String({ description: "objects.list/object.describe only", maxLength: 500 })),
    search: Type.Optional(Type.String({ description: "objects.list only", maxLength: 200 })),
    object: Type.Optional(Type.Any({ description: "object.describe only" })),
    redis: Type.Optional(Type.Any({ description: "redis.query/redis.exec/redis.plan only" })),
    table: Type.Optional(Type.String({ description: "inspect only: optional qualified table name", maxLength: 500 })),
    mongo: Type.Optional(
      Type.Any({ description: "mongo.query/mongo.exec/mongo.plan only: bounded MongoDB native command" }),
    ),
    params: Type.Optional(
      Type.Any({ description: "query/filter/exec/plan only: positional JSON array or named JSON object" }),
    ),
    cache: Type.Optional(StringEnum(["auto", "bypass", "require"] as const, { description: "query/mongo.query only" })),
    read_only: Type.Optional(Type.Boolean({ description: "connect/profile.add/profile.update only" })),
    secret_env: Type.Optional(
      Type.String({
        description:
          "connect/profile.add/profile.update only: environment variable whose value is the complete PostgreSQL/MySQL URL or explicit sqlite:<path> source; use instead of target",
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
      Type.Union(
        [Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.String({ pattern: "^[0-9]{1,32}$", maxLength: 32 })],
        { description: "rows/history offset or objects.list Redis cursor" },
      ),
    ),
    limit: Type.Optional(Type.Integer({ description: "rows/history only", minimum: 1, maximum: 100 })),
    history_origin: Type.Optional(
      StringEnum(["legacy", "user", "model", "system", "api"] as const, {
        description: "history retrieval origin filter; does not change attribution",
      }),
    ),
    history_category: Type.Optional(StringEnum(["statement", "introspection", "management"] as const)),
    history_internal: Type.Optional(Type.Boolean()),
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

type StateQLCommandContext = { signal?: AbortSignal; origin?: "user" | "model" | "system" };
type RuntimeStateQL = {
  close(): void | Promise<void>;
  executeCommand(command: BatchCommand, context?: StateQLCommandContext): Promise<Response<unknown>>;
  snapshot(options?: {
    historyLimit?: number;
    historyCategory?: "statement" | "introspection" | "management";
    historyInternal?: boolean;
  }): StateQLSnapshot;
  readMaterialized?: StateQL["readMaterialized"];
  readTable?: StateQL["readTable"];
  serializeResult?: StateQL["serializeResult"];
  planTableUpdate?: StateQL["planTableUpdate"];
  planTableUpdates?: StateQL["planTableUpdates"];
  listObjects?: StateQL["listObjects"];
  describeObject?: StateQL["describeObject"];
};
type Factory = (options: StateQLActorOptions) => RuntimeStateQL;
type WorkspaceFactory = (options: StateQLActorOptions & { workspace: string }) => RuntimeStateQL;
type WorkspaceName = "session" | "global";

interface Runtime {
  actorId: string;
  piActorId: string;
  workspace: WorkspaceName;
  controller: AbortController;
  stateql: RuntimeStateQL;
}

interface StateQLPasswordTarget {
  driver: "postgres" | "mysql" | "mongodb" | "redis";
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
    options?: SetupPasswordOptions,
  ): Promise<string | undefined>;
  invalidateStateQLPassword?(request: CredentialRequest, target: StateQLPasswordTarget): void;
  invalidateStateQLCredential?(request: CredentialRequest): void;
  hasStateQLCredential?(reference: string, target?: string): Promise<boolean>;
  forgetStateQLCredential?(reference: string): Promise<boolean>;
  rememberStateQLPassword?(reference: string, target: string, password: string, signal?: AbortSignal): Promise<boolean>;
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
  workspace?: WorkspaceName;
  historyLimit?: number;
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<StateQLSnapshot>): void;
}

interface RowsRequest {
  version: 1;
  sessionId: string;
  workspace?: WorkspaceName;
  handle: string;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
}

interface PanelCommandRequest {
  expectedConnectionId?: string | null;
  operationId?: string;
  version: 1;
  sessionId: string;
  workspace?: WorkspaceName;
  command: unknown;
  signal?: AbortSignal;
  ui: unknown;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
}
interface StateQLCommandUi extends StateQLCredentialHost {
  confirm(title: string, message: string, options?: { timeout: number; signal?: AbortSignal }): Promise<boolean>;
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
  "workspace.select": ["workspace"],
  "workspace.status": [],
  connect: ["target", "name", "read_only", "secret_env", "profile", "timeout_ms"],
  disconnect: [],
  status: [],
  "profile.add": ["name", "target", "read_only", "secret_env"],
  "profile.update": ["name", "target", "read_only", "secret_env"],
  "profile.list": [],
  "profile.show": ["name"],
  "profile.remove": ["name"],
  "session.summary": [],
  query: ["sql", "params", "cache", "as", "timeout_ms"],
  filter: ["handle", "where", "params", "as"],
  exec: ["sql", "params", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "mongo.query": ["mongo", "cache", "as", "timeout_ms"],
  "mongo.exec": ["mongo", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "redis.query": ["redis", "cache", "as", "timeout_ms"],
  "redis.exec": ["redis", "replay", "idempotency_key", "timeout_ms"],
  "redis.plan": ["redis", "timeout_ms"],
  "objects.list": ["kind", "schema", "search", "offset", "limit", "timeout_ms"],
  "object.describe": ["object", "timeout_ms"],
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
  history: ["limit", "offset", "history_origin", "history_category", "history_internal"],
  receipt: ["handle"],
  doctor: [],
  capabilities: [],
};

const required: Partial<Record<StateQLToolInput["command"], readonly (keyof StateQLToolInput)[]>> = {
  "profile.add": ["name"],
  "profile.show": ["name"],
  "profile.update": ["name"],
  "profile.remove": ["name"],
  query: ["sql"],
  filter: ["handle", "where"],
  exec: ["sql"],
  "mongo.query": ["mongo"],
  "mongo.exec": ["mongo"],
  "redis.query": ["redis"],
  "redis.exec": ["redis"],
  "redis.plan": ["redis"],
  "object.describe": ["object"],
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
  "profile.update",
  "profile.remove",
  "exec",
  "mongo.exec",
  "redis.exec",
  "apply",
  "transaction.commit",
  "transaction.rollback",
]);
const PANEL_DIRECT_WRITE_COMMANDS = new Set<StateQLToolInput["command"]>([
  "exec",
  "mongo.exec",
  "redis.exec",
  "apply",
  "transaction.commit",
  "transaction.rollback",
]);
const MAX_PARAMS_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 40 * 1024;
const BROKERED_REFERENCE_PREFIX = "PYLON_STATEQL_BROKERED_";
// Keep StateQL's safety deadline beyond Pylon's longest finite credential dialog (24 hours).
const CREDENTIAL_RESOLUTION_TIMEOUT_MS = 24 * 60 * 60_000 + 60_000;
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
  "profile.update",
  "profile.remove",
  "connect",
  "disconnect",
  "query",
  "table.plan",
  "table.plan.batch",
  "table.read",
  "objects.list",
  "object.describe",
  "redis.query",
  "redis.exec",
  "redis.plan",
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
function validateInput(input: StateQLToolInput): StateQLToolInput {
  if (input.workspace !== undefined && input.workspace !== "session" && input.workspace !== "global")
    throw new Error("workspace must be session or global");
  if (input.command === "workspace.select") {
    if (input.workspace === undefined) throw new Error("workspace.select requires workspace");
    for (const [key, value] of Object.entries(input))
      if (value !== undefined && key !== "command" && key !== "workspace") throw new Error(`workspace.select does not accept ${key}`);
    return input;
  }
  if (input.command === "workspace.status") {
    for (const [key, value] of Object.entries(input))
      if (value !== undefined && key !== "command") throw new Error(`workspace.status does not accept ${key}`);
    return input;
  }
  if (PANEL_COMMANDS.has(input.command as StateQLPanelCommand["command"])) {
    const { workspace, ...stateqlInput } = input;
    const parsed = parseStateQLPanelCommand(stateqlInput, { maxTimeoutMs: 2_147_483_647 });
    if (!parsed) {
      const allowed = new Set(["command", "workspace", ...(fields[input.command] ?? [])]);
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
    return { ...parsed, ...(workspace ? { workspace } : {}) } as StateQLToolInput;
  }
  const commandFields = fields[input.command];
  if (!commandFields) throw new Error(`Unknown StateQL command ${String(input.command)}`);
  const allowed = new Set<keyof StateQLToolInput>(["command", "workspace", ...commandFields]);
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
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
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

interface ProfileBrokeredConnect {
  target: BrokeredTarget;
  name?: string;
  readOnly?: boolean;
  profileMetadata?: string;
  passwordReference?: string;
  fromProfile: boolean;
}

function brokeredTarget(value: string): BrokeredTarget | undefined {
  const source = materializeConnectionTarget(value);
  try {
    const url = new URL(source);
    const driver: StateQLPasswordTarget["driver"] | undefined =
      url.protocol === "postgres:" || url.protocol === "postgresql:"
        ? "postgres"
        : url.protocol === "mysql:"
          ? "mysql"
          : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
            ? "mongodb"
            : url.protocol === "redis:" || url.protocol === "rediss:"
              ? "redis"
              : undefined;
    if (!driver || url.password || !url.hostname || url.hash || (driver !== "redis" && !url.username)) return undefined;
    if ([...url.searchParams.keys()].some(key => ENDPOINT_QUERY_KEYS.has(key.toLowerCase()))) return undefined;
    const defaultPort =
      driver === "postgres" ? "5432" : driver === "mysql" ? "3306" : driver === "redis" ? "6379" : "27017";
    const port = Number(url.port || defaultPort);
    const database = url.pathname.replace(/^\//u, "");
    const prompt = {
      driver,
      username: url.username ? decodeURIComponent(url.username) : "default",
      hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
      port,
      database,
    };
    return { source, prompt };
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

function confirmationText(input: StateQLToolInput, brokered = false, effectiveTarget?: string): string {
  switch (input.command) {
    case "connect": {
      const source = input.profile
        ? `profile “${input.profile}”`
        : input.secret_env
          ? `environment variable ${input.secret_env}, which must contain a complete PostgreSQL/MySQL URL or explicit sqlite:<path> source`
          : brokered
            ? "the provided passwordless target using its securely brokered password approval"
            : "the provided target";
      const tlsWarning = insecureTls(effectiveTarget ?? input.target)
        ? " Warning: this target weakens or disables TLS certificate or hostname verification."
        : "";
      return `Connect StateQL using ${source} in ${input.read_only === false ? "read-write" : "read-only"} mode? Queries may expose database content to the selected model provider.${tlsWarning}`;
    }
    case "profile.add":
      return `Save StateQL profile “${input.name ?? ""}” in ${input.read_only === false ? "read-write" : "read-only"} mode? Credential values are not stored.`;
    case "profile.update":
      return `Update StateQL profile “${input.name ?? ""}”? Existing credential references are kept unless you replace the connection source.`;
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

function workspaceConfirmationText(
  workspace: WorkspaceName,
  input: StateQLToolInput,
  brokered = false,
  effectiveTarget?: string,
): string {
  return `${confirmationText(input, brokered, effectiveTarget)}\n\nWorkspace: ${workspace}.`;
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
  workspace: WorkspaceName,
  selectedWorkspace?: WorkspaceName,
): { text: string; truncated: boolean } {
  const output = JSON.stringify(
    { ...modelResponse(response, command), workspace, ...(selectedWorkspace && selectedWorkspace !== workspace ? { selected_workspace: selectedWorkspace } : {}) },
    null,
    2,
  );
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

const GLOBAL_WORKSPACE = "pylon:stateql:global:v1";
const GLOBAL_UI_ACTOR = "pylon:stateql:global:ui:v1";
function globalAgentActor(session: string): string {
  return `pylon:stateql:global:agent:${createHash("sha256").update(session).digest("hex").slice(0, 32)}`;
}
function workspaceName(value: unknown): WorkspaceName | undefined {
  return value === undefined || value === "session" ? "session" : value === "global" ? "global" : undefined;
}
function workspaceLabel(workspace: WorkspaceName): string {
  return `workspace: ${workspace}`;
}

export default function stateqlExtension(
  pi: ExtensionAPI,
  options: { createStateQL?: Factory; createWorkspaceStateQL?: WorkspaceFactory } = {},
) {
  const createStateQL: Factory = options.createStateQL ?? (value => StateQL.forActor(value));
  let runtime: Runtime | undefined;
  let globalAgentRuntime: Runtime | undefined;
  let globalUiRuntime: Runtime | undefined;
  let selectedWorkspace: WorkspaceName = "session";
  let activeCredentialHost: StateQLCredentialHost | undefined;
  const activePasswordResolution: {
    value?: { request: CredentialRequest; target: StateQLPasswordTarget };
  } = {};
  const takeActivePasswordResolution = (): typeof activePasswordResolution.value => {
    const value = activePasswordResolution.value;
    activePasswordResolution.value = undefined;
    return value;
  };
  const brokeredTargets = new Map<string, RuntimeBrokeredTarget>();
  const retainBrokeredConnection = (reference?: string) => {
    for (const key of brokeredTargets.keys()) if (key !== reference) brokeredTargets.delete(key);
  };
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
  let setupPassword:
    { reference: string; target: string; value: string; actorId: string; sessionId: string } | undefined;
  const open = (actorId: string, piActorId: string, workspace: WorkspaceName): Runtime => {
    const controller = new AbortController();
    const hostRequest = (request: CredentialRequest): CredentialRequest => ({ ...request, actorId: piActorId });
    const stateqlOptions: StateQLActorOptions = {
      actor: actorId,
      credentialTimeoutMs: CREDENTIAL_RESOLUTION_TIMEOUT_MS,
      signal: controller.signal,
      credentialResolver: async request => {
        // StateQL must authenticate its own actor before Pylon receives the originating Pi identity.
        if (request.actorId !== actorId) return undefined;
        if (request.source === "password_ref") {
          if (
            setupPassword &&
            request.reference === setupPassword.reference &&
            request.target === setupPassword.target &&
            request.actorId === setupPassword.actorId &&
            request.session.id === setupPassword.sessionId
          )
            return setupPassword.value;
          const target = typeof request.target === "string" ? brokeredTarget(request.target) : undefined;
          if (!target) return undefined;
          const host = activeCredentialHost;
          if (!host?.requestStateQLPassword) return undefined;
          const credential = hostRequest(request);
          const password = await host.requestStateQLPassword(credential, target.prompt, {
            timeoutMs:
              approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null ? approvalTiming.timeoutSeconds * 1000 : 0,
            savedPassword: { reference: request.reference, target: target.source },
          });
          if (password !== undefined) activePasswordResolution.value = { request: credential, target: target.prompt };
          return password;
        }
        if (request.reference.startsWith(BROKERED_REFERENCE_PREFIX)) {
          const target = brokeredTargets.get(request.reference);
          if (!target || target.actorId !== request.actorId || (target.stateqlSessionId && target.stateqlSessionId !== request.session.id))
            return undefined;
          target.stateqlSessionId ??= request.session.id;
          const credential = hostRequest(request);
          target.request = { ...credential, signal: undefined };
          const password = await activeCredentialHost?.requestStateQLPassword?.(credential, target.prompt, {
            timeoutMs: target.passwordTimeoutMs,
          });
          if (password === undefined) return undefined;
          const source = new URL(target.source);
          source.password = encodeURIComponent(password);
          return source.toString();
        }
        const configured = process.env[request.reference];
        if (configured !== undefined) return configured;
        return activeCredentialHost?.requestStateQLCredential(hostRequest(request));
      },
    };
    let stateql: RuntimeStateQL;
    if (workspace === "session") stateql = createStateQL(stateqlOptions);
    else {
      const factory =
        options.createWorkspaceStateQL ??
        (StateQL as typeof StateQL & { forWorkspace?: WorkspaceFactory }).forWorkspace;
      if (typeof factory !== "function")
        throw new Error("StateQL global workspace requires a runtime exposing StateQL.forWorkspace; upgrade @fadhilp/stateql.");
      stateql = factory({ ...stateqlOptions, workspace: GLOBAL_WORKSPACE });
    }
    return { actorId, piActorId, workspace, controller, stateql };
  };
  const current = (piActorId?: string, workspace: WorkspaceName = "session", ui = false): Runtime => {
    if (!runtime || stopping || (piActorId && runtime.piActorId !== piActorId))
      throw new Error(`StateQL is unavailable for this Pi session (${workspaceLabel(workspace)})`);
    if (workspace === "session") return runtime;
    const active = ui ? globalUiRuntime : globalAgentRuntime;
    if (active) return active;
    const opened = open(ui ? GLOBAL_UI_ACTOR : globalAgentActor(runtime.piActorId), runtime.piActorId, "global");
    if (ui) globalUiRuntime = opened;
    else globalAgentRuntime = opened;
    return opened;
  };

  const resolveProfileBrokeredConnect = async (
    actorId: string,
    input: StateQLToolInput | StateQLPanelCommand,
    host: StateQLCredentialHost | undefined,
    signal: AbortSignal | undefined,
    origin: "user" | "model",
    workspace: WorkspaceName = "session",
    ui = false,
  ): Promise<ProfileBrokeredConnect | undefined> => {
    if (input.command !== "connect" || !host?.requestStateQLPassword) return undefined;
    if (input.target) {
      const target = brokeredTarget(input.target);
      return target ? { target, fromProfile: false } : undefined;
    }
    if (!input.profile) return undefined;
    return exclusive(async () => {
      if (signal?.aborted) throw new Error(`StateQL ${origin === "user" ? "command request" : "operation"} cancelled`);
      const shown = await current(actorId, workspace, ui).stateql.executeCommand(
        { command: "profile.show", name: input.profile } as BatchCommand,
        { signal, origin },
      );
      if (!shown.ok) throw safeFailure(shown);
      if (signal?.aborted) throw new Error(`StateQL ${origin === "user" ? "command request" : "operation"} cancelled`);
      if (!record(shown.data)) return undefined;
      const data = shown.data;
      const sourceCount = [data.target, data.secret_env, data.credential_ref].filter(value => typeof value === "string").length;
      if (sourceCount !== 1 || typeof data.target !== "string") return undefined;
      const target = brokeredTarget(data.target);
      if (!target) return undefined;
      return {
        target,
        name: input.profile,
        readOnly: typeof data.read_only === "boolean" ? data.read_only : undefined,
        profileMetadata: input.profile,
        ...(typeof data.password_ref === "string" ? { passwordReference: data.password_ref } : {}),
        fromProfile: true,
      };
    });
  };
  const brokeredConnectCommand = (
    input: BatchCommand,
    reference: string,
    profile: ProfileBrokeredConnect | undefined,
    source: "secret_env" | "credential_ref" = "secret_env",
  ): BatchCommand => {
    const { target: _target, ...withoutTarget } = input;
    if (!profile) return { ...withoutTarget, [source]: reference } as BatchCommand;
    const { profile: _profile, ...withoutProfile } = withoutTarget;
    return {
      ...withoutProfile,
      ...(input.name === undefined && profile.name !== undefined ? { name: profile.name } : {}),
      ...(input.read_only === undefined && profile.readOnly !== undefined ? { read_only: profile.readOnly } : {}),
      [source]: reference,
    } as BatchCommand;
  };
  const savedPasswordProfileConnectCommand = (
    input: BatchCommand,
    profile: ProfileBrokeredConnect & { passwordReference: string },
  ): BatchCommand => {
    const { profile: _profile, target: _target, ...withoutSource } = input;
    return {
      ...withoutSource,
      target: profile.target.source,
      password_ref: profile.passwordReference,
      ...(input.name === undefined && profile.name !== undefined ? { name: profile.name } : {}),
      ...(input.read_only === undefined && profile.readOnly !== undefined ? { read_only: profile.readOnly } : {}),
    } as BatchCommand;
  };
  const restoreProfileMetadata = (response: Response<unknown>, profile: ProfileBrokeredConnect | undefined) => {
    if (!profile?.fromProfile || !response.ok || !record(response.data)) return response;
    return { ...response, data: { ...response.data, profile: profile.profileMetadata } };
  };

  const disposePolicy = pi.events.on("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2 || typeof event.sessionId !== "string" || event.sessionId !== runtime?.piActorId) return;
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
    const workspace = workspaceName(request?.workspace);
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      workspace === undefined ||
      request.sessionId !== runtime?.piActorId ||
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
        return current(request.sessionId, workspace, true).stateql.snapshot({ historyLimit, historyInternal: false });
      }),
    );
  });

  const disposeRows = pi.events.on("pylon:stateql-rows-request", (value: unknown) => {
    const request = value && typeof value === "object" ? (value as Partial<RowsRequest>) : undefined;
    const workspace = workspaceName(request?.workspace);
    // Validate everything before claiming so malformed requests remain available to another owner.
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      workspace === undefined ||
      request.sessionId !== runtime?.piActorId ||
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
        const stateql = current(request.sessionId, workspace, true).stateql;
        if (stateql.readMaterialized) {
          try {
            return stateql.readMaterialized(request.handle!, {
              offset: request.offset,
              limit: request.limit,
              signal: request.signal,
            });
          } catch (cause) {
            const error = cause as { details?: { code?: string }; message?: string };
            throw new Error(`${error.details?.code ?? "RESULT_READ_FAILED"}: ${error.message ?? "Result unavailable"}`);
          }
        }
        const response = await stateql.executeCommand(
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
    const command = parseStateQLPanelCommand(request?.command);
    const workspace = workspaceName(request?.workspace);
    const ui = commandUi(request?.ui);
    if (
      request?.version !== 1 ||
      typeof request.sessionId !== "string" ||
      workspace === undefined ||
      request.sessionId !== runtime?.piActorId ||
      !command ||
      !ui ||
      typeof request.claim !== "function" ||
      typeof request.respond !== "function" ||
      !abortSignal(request.signal)
    )
      return;
    if (!request.claim()) return;
    const expectedConnectionId =
      request.expectedConnectionId === undefined
        ? (current(request.sessionId, workspace, true).stateql.snapshot({ historyLimit: 1 }).connection?.connection_id ?? null)
        : request.expectedConnectionId;
    const checkConnection = () => {
      const connectionId =
        current(request.sessionId, workspace, true).stateql.snapshot({ historyLimit: 1 }).connection?.connection_id ?? null;
      if (connectionId !== expectedConnectionId)
        throw new Error("Database connection changed; review and submit again.");
    };
    if (command.command === "connection.setup") {
      request.respond(
        exclusive(async () => {
          if ((StateQL as typeof StateQL & { passwordReferenceVersion?: number }).passwordReferenceVersion !== 1)
            throw new Error(
              "Database setup requires the updated StateQL password-reference runtime. Rebuild the linked StateQL package and restart Pylon; do not downgrade a state home containing password references.",
            );
          const stateql = current(request.sessionId, workspace, true).stateql;
          const execute = async (input: BatchCommand) => {
            activeCredentialHost = ui;
            try {
              return await stateql.executeCommand(input, { signal: request.signal, origin: "user" });
            } finally {
              activeCredentialHost = undefined;
            }
          };
          return runConnectionSetup(command, {
            snapshot: () => stateql.snapshot({ historyLimit: 1 }),
            execute,
            ui,
            actorId: request.sessionId!,
            operationId: request.operationId ?? randomUUID(),
            signal: request.signal,
            timeoutMs:
              approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
                ? approvalTiming.timeoutSeconds * 1000
                : 0,
            checkConnection,
            connect: async (input, reference, password) => {
              if (reference && password !== undefined && typeof input.target === "string")
                setupPassword = {
                  reference,
                  target: input.target,
                  value: password,
                  actorId: current(request.sessionId, workspace, true).actorId,
                  sessionId: stateql.snapshot({ historyLimit: 1 }).session.session_id,
                };
              try {
                return await execute(input);
              } finally {
                setupPassword = undefined;
              }
            },
          });
        }),
      );
      return;
    }
    request.respond(
      (async () => {
        checkConnection();
        const input = command;
        const remembers = "remember" in input && input.remember === true;
        const profileBrokered = await resolveProfileBrokeredConnect(
          request.sessionId!,
          input,
          ui,
          request.signal,
          "user",
          workspace,
          true,
        );
        checkConnection();
        const target =
          profileBrokered?.target ??
          ((input.command === "profile.add" || input.command === "profile.update") &&
          input.target &&
          ui.requestStateQLPassword
            ? brokeredTarget(input.target)
            : undefined);
        const insecureBrokeredConnect = Boolean(target && insecureTls(target.source));
        const passwordTimeoutMs =
          approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
            ? approvalTiming.timeoutSeconds * 1_000
            : 0;
        if (
          CONFIRMED_COMMANDS.has(input.command as StateQLToolInput["command"]) &&
          !PANEL_DIRECT_WRITE_COMMANDS.has(input.command as StateQLToolInput["command"]) &&
          (!(target && (input.command === "connect" || remembers) && !profileBrokered?.fromProfile) ||
            insecureBrokeredConnect)
        ) {
          const title = insecureBrokeredConnect ? "Allow insecure database TLS?" : "Allow StateQL operation?";
          if (
            !(await ui.confirm(title, workspaceConfirmationText(workspace, input as StateQLToolInput, Boolean(target), target?.source), {
              timeout: passwordTimeoutMs,
              ...(request.signal ? { signal: request.signal } : {}),
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
        if (input.command === "connect" && profileBrokered?.passwordReference) {
          executionCommand = savedPasswordProfileConnectCommand(
            stateqlInput as BatchCommand,
            profileBrokered as ProfileBrokeredConnect & { passwordReference: string },
          );
        } else if (target && remembers) {
          const transientReference = brokeredReference();
          const savedReference = durableReference();
          const snapshot = current(request.sessionId, workspace, true).stateql.snapshot({ historyLimit: 1 });
          const effectiveReadOnly = input.read_only ?? profileBrokered?.readOnly;
          const credentialRequest = {
            reference: transientReference,
            actorId: request.sessionId,
            session: { id: snapshot.session.session_id, name: snapshot.session.name },
            operation: "connect",
            access: effectiveReadOnly === false ? "write" : "read",
            requestedReadOnly: effectiveReadOnly !== false,
            signal: request.signal,
          } as CredentialRequest;
          checkConnection();
          const password = await ui.requestStateQLPassword?.(credentialRequest, target.prompt, {
            timeoutMs: passwordTimeoutMs,
            remember: { reference: savedReference, target: target.source },
          });
          if (password === undefined) return { declined: true };
          credentialSaved = (await ui.hasStateQLCredential?.(savedReference, target.source)) === true;
          const withoutCredential = stateqlInput as BatchCommand;
          if (credentialSaved) {
            executionCommand = brokeredConnectCommand(
              withoutCredential,
              savedReference,
              profileBrokered,
              "credential_ref",
            );
          } else if (input.command === "connect") {
            reference = transientReference;
            executionCommand = brokeredConnectCommand(withoutCredential, transientReference, profileBrokered);
            brokeredTargets.set(transientReference, { ...target, actorId: current(request.sessionId, workspace, true).actorId, passwordTimeoutMs });
          }
        } else if (target && input.command === "connect") {
          const transientReference = brokeredReference();
          reference = transientReference;
          executionCommand = brokeredConnectCommand(stateqlInput as BatchCommand, transientReference, profileBrokered);
          brokeredTargets.set(transientReference, { ...target, actorId: current(request.sessionId, workspace, true).actorId, passwordTimeoutMs });
        }

        ui.setStatus?.("pi-stateql", `database: ${input.command}`);
        try {
          return await exclusive(async () => {
            if (request.signal?.aborted) throw new Error("StateQL command request cancelled");
            checkConnection();
            let credentialToForget: string | undefined;
            if (input.command === "profile.remove" && forgetCredential) {
              const shown = await current(request.sessionId, workspace, true).stateql.executeCommand(
                { command: "profile.show", name: input.name },
                { signal: request.signal, origin: "user" },
              );
              if (shown.ok && record(shown.data)) {
                const reference = shown.data.password_ref ?? shown.data.credential_ref;
                if (typeof reference === "string") credentialToForget = reference;
              }
            }
            let response: Response<unknown>;
            activePasswordResolution.value = undefined;
            activeCredentialHost = ui;
            try {
              const stateql = current(request.sessionId, workspace, true).stateql;
              if (input.command === "table.plan") {
                if (!stateql.planTableUpdate) throw new Error("Row edits require the current StateQL package.");
                response = await stateql.planTableUpdate(input.row_token, input.changes, {
                  signal: request.signal,
                  timeoutMs: input.timeout_ms,
                  origin: "user",
                });
              } else if (input.command === "table.plan.batch") {
                if (!stateql.planTableUpdates) throw new Error("Batch row edits require the current StateQL package.");
                response = await stateql.planTableUpdates(input.updates, {
                  signal: request.signal,
                  timeoutMs: input.timeout_ms,
                  origin: "user",
                });
              } else if (input.command === "table.read") {
                if (!stateql.readTable) throw new Error("Table reads require the current StateQL package.");
                response = await stateql.readTable(input.table, input.limit, {
                  signal: request.signal,
                  timeoutMs: input.timeout_ms,
                  origin: "user",
                });
              } else if (input.command === "objects.list") {
                if (!stateql.listObjects) throw new Error("Catalog discovery requires the current StateQL package.");
                response = await stateql.listObjects(
                  {
                    kind: input.kind,
                    schema: input.schema,
                    search: input.search,
                    offset: input.offset,
                    limit: input.limit,
                  },
                  { signal: request.signal, timeoutMs: input.timeout_ms },
                );
              } else if (input.command === "object.describe") {
                if (!stateql.describeObject)
                  throw new Error("Object descriptions require the current StateQL package.");
                response = await stateql.describeObject(input.object, {
                  signal: request.signal,
                  timeoutMs: input.timeout_ms,
                });
              } else {
                const commandInput = { ...executionCommand };
                if (commandInput.command === "inspect") delete (commandInput as { offset?: number }).offset;
                response = await stateql.executeCommand(commandInput as BatchCommand, {
                  signal: request.signal,
                  origin: "user",
                });
                if (input.command === "inspect" && input.kind === "schema" && response.ok && record(response.data)) {
                  const field = Array.isArray(response.data.tables) ? "tables" : "collections";
                  const items = response.data[field];
                  if (Array.isArray(items)) {
                    const offset = input.offset ?? 0;
                    response = {
                      ...response,
                      data: {
                        ...response.data,
                        [field]: items.slice(offset, offset + 100),
                        total: items.length,
                        next_offset: offset + 100 < items.length ? offset + 100 : null,
                      },
                    };
                  }
                }
              }
            } catch (error) {
              if (reference) brokeredTargets.delete(reference);
              activePasswordResolution.value = undefined;
              throw error;
            } finally {
              activeCredentialHost = undefined;
            }
            const passwordResolution = takeActivePasswordResolution();
            if (!response.ok && passwordResolution && passwordAuthenticationFailed(response)) {
              ui.invalidateStateQLPassword?.(passwordResolution.request, passwordResolution.target);
              ui.invalidateStateQLCredential?.(passwordResolution.request);
            }
            if (reference && !response.ok) {
              const brokered = brokeredTargets.get(reference);
              if (brokered?.request && passwordAuthenticationFailed(response)) {
                ui.invalidateStateQLPassword?.(brokered.request, brokered.prompt);
              }
              brokeredTargets.delete(reference);
            }
            if (response.ok && input.command === "connect") retainBrokeredConnection(reference);
            if (response.ok && input.command === "disconnect") brokeredTargets.clear();
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
            response = restoreProfileMetadata(response, profileBrokered);
            return response;
          });
        } finally {
          ui.setStatus?.("pi-stateql", undefined);
        }
      })(),
    );
  });

  const disposeExport = pi.events.on("pylon:stateql-export-request", (value: unknown) => {
    const request = value as {
      version?: number;
      sessionId?: string;
      workspace?: WorkspaceName;
      handle?: string;
      format?: "json" | "jsonl" | "csv";
      signal?: AbortSignal;
      claim?: () => boolean;
      respond?: (value: Promise<unknown>) => void;
    };
    const workspace = workspaceName(request?.workspace);
    if (
      !request ||
      request.version !== 1 ||
      workspace === undefined ||
      request.sessionId !== runtime?.piActorId ||
      typeof request.handle !== "string" ||
      !request.handle ||
      request.handle.length > 200 ||
      !["json", "jsonl", "csv"].includes(request.format ?? "") ||
      !abortSignal(request.signal) ||
      typeof request.claim !== "function" ||
      typeof request.respond !== "function" ||
      !request.claim()
    )
      return;
    request.respond(
      exclusive(async () => {
        request.signal?.throwIfAborted();
        const stateql = current(request.sessionId, workspace, true).stateql;
        if (!stateql.serializeResult) throw new Error("Exports require the current StateQL package.");
        const response = await stateql.serializeResult(request.handle!, request.format!, request.signal, "user");
        if (!response.ok) throw safeFailure(response);
        return response.data;
      }),
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

  const closeRuntimes = async () => {
    const opened = [runtime, globalAgentRuntime, globalUiRuntime].filter((value): value is Runtime => Boolean(value));
    for (const active of opened) active.controller.abort();
    await Promise.all(opened.map(active => active.stateql.close()));
    runtime = undefined;
    globalAgentRuntime = undefined;
    globalUiRuntime = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    stopping = false;
    selectedWorkspace = "session";
    approvalTiming = { guardEnabled: false, timeoutSeconds: null };
    brokeredTargets.clear();
    const id = sessionId(ctx);
    await exclusive(async () => {
      await closeRuntimes();
      runtime = open(id, id, "session");
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
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-stateql" });
    disposePolicy();
    disposeSnapshot();
    disposeRows();
    disposeCommand();
    disposeExport();
    disposeHealth();
    await exclusive(closeRuntimes);
  });

  pi.registerTool({
    name: "stateql",
    label: "StateQL",
    description:
      "Perform user-requested SQLite, PostgreSQL, MySQL, MongoDB, or Redis work in the private session workspace or shared global workspace. Prefer read-only profiles and parameterized SQL or bounded native commands. Query output includes normalized parallel-column previews; call rows only when truncated or additional rows are needed. Plan consequential writes when practical and confirm writes, plan application, and transaction completion. Cross-session lifecycle, purge, and arbitrary export are unavailable. Output is capped at 40 KB.",
    promptSnippet: "Query and safely modify databases with durable StateQL result handles",
    promptGuidelines: [
      "Use stateql for user-requested database work; prefer read-only profiles and parameterized SQL with explicit ORDER BY and LIMIT.",
      "Use workspace.select once to choose session or global scope for later calls; an explicit workspace on one call overrides that selection without changing it.",
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
      if (command.command === "workspace.select") {
        if (selectedWorkspace !== command.workspace) {
          const selected = current(id, selectedWorkspace);
          const transaction = selected.stateql.snapshot({ historyLimit: 1 }).transaction;
          if (transaction?.owner_actor_id === selected.actorId)
            throw new Error(`[${workspaceLabel(selectedWorkspace)}] Commit or roll back the active transaction before switching workspaces.`);
        }
        selectedWorkspace = command.workspace!;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ workspace: selectedWorkspace }, null, 2) }],
          details: { command: command.command, workspace: selectedWorkspace },
        };
      }
      if (command.command === "workspace.status") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ workspace: selectedWorkspace }, null, 2) }],
          details: { command: command.command, workspace: selectedWorkspace },
        };
      }
      const workspace = command.workspace ?? selectedWorkspace;
      const active = current(id, workspace);
      const host = credentialHost(ctx.ui);
      let profileBrokered: ProfileBrokeredConnect | undefined;
      try {
        profileBrokered = await resolveProfileBrokeredConnect(id, command, host, signal, "model", workspace);
      } catch (error) {
        throw new Error(`[${workspaceLabel(workspace)}] ${error instanceof Error ? error.message : String(error)}`);
      }
      const target = profileBrokered?.target;
      const insecureBrokeredConnect = Boolean(target && insecureTls(target.source));
      const passwordTimeoutMs =
        approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
          ? approvalTiming.timeoutSeconds * 1_000
          : 0;
      const requiresConfirmation =
        CONFIRMED_COMMANDS.has(command.command) && (!target || profileBrokered?.fromProfile || insecureBrokeredConnect);
      if (requiresConfirmation) {
        if (!ctx.hasUI) throw new Error(`[${workspaceLabel(workspace)}] ${input.command} requires interactive confirmation`);
        const title = insecureBrokeredConnect ? "Allow insecure database TLS?" : "Allow StateQL operation?";
        if (
          !(await ctx.ui.confirm(title, workspaceConfirmationText(workspace, input, Boolean(target), target?.source), {
            timeout: passwordTimeoutMs,
            ...(signal ? { signal } : {}),
          }))
        ) {
          return {
            content: [{ type: "text" as const, text: `User declined the StateQL operation; nothing was executed (${workspaceLabel(workspace)}).` }],
            details: { command: input.command, declined: true, workspace },
          };
        }
      }
      let reference: string | undefined;
      let executionCommand = command as BatchCommand & StateQLToolInput;
      if (target && command.command === "connect" && profileBrokered?.passwordReference) {
        executionCommand = savedPasswordProfileConnectCommand(
          command as BatchCommand,
          profileBrokered as ProfileBrokeredConnect & { passwordReference: string },
        ) as BatchCommand & StateQLToolInput;
      } else if (target) {
        reference = brokeredReference();
        executionCommand = brokeredConnectCommand(command as BatchCommand, reference, profileBrokered) as BatchCommand & StateQLToolInput;
        brokeredTargets.set(reference, { ...target, actorId: active.actorId, passwordTimeoutMs });
      }
      onUpdate?.({
        content: [{ type: "text" as const, text: `Running StateQL ${input.command} (${workspaceLabel(workspace)})...` }],
        details: { command: input.command, workspace },
      });
      if (ctx.hasUI) ctx.ui.setStatus?.("pi-stateql", `database: ${input.command}`);
      try {
        return await exclusive(async () => {
          // Resolve before the exclusive operation so a global runtime is never mistaken for the private actor.
          if (active !== current(id, workspace)) throw new Error(`[${workspaceLabel(workspace)}] StateQL runtime changed`);
          if (signal?.aborted) throw new Error("StateQL operation cancelled");
          let response: Response<unknown>;
          activePasswordResolution.value = undefined;
          activeCredentialHost = host;
          try {
            if (command.command === "objects.list") {
              if (!active.stateql.listObjects)
                throw new Error("Catalog discovery requires the current StateQL package.");
              response = await active.stateql.listObjects(
                {
                  kind: command.kind as CatalogObjectKind | undefined,
                  schema: command.schema,
                  search: command.search,
                  offset: command.offset,
                  limit: command.limit,
                },
                { signal, timeoutMs: command.timeout_ms },
              );
            } else if (command.command === "object.describe") {
              if (!active.stateql.describeObject)
                throw new Error("Object descriptions require the current StateQL package.");
              response = await active.stateql.describeObject(command.object, { signal, timeoutMs: command.timeout_ms });
            } else {
              const { workspace: _workspace, ...stateqlCommand } = executionCommand;
              response = await active.stateql.executeCommand(stateqlCommand as BatchCommand, { signal, origin: "model" });
            }
          } catch (error) {
            if (reference) brokeredTargets.delete(reference);
            activePasswordResolution.value = undefined;
            throw new Error(`[${workspaceLabel(workspace)}] ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            activeCredentialHost = undefined;
          }
          const passwordResolution = takeActivePasswordResolution();
          if (!response.ok && passwordResolution && passwordAuthenticationFailed(response)) {
            host?.invalidateStateQLPassword?.(passwordResolution.request, passwordResolution.target);
            host?.invalidateStateQLCredential?.(passwordResolution.request);
          }
          if (!response.ok) {
            if (reference) {
              const brokered = brokeredTargets.get(reference);
              if (brokered?.request && passwordAuthenticationFailed(response)) {
                host?.invalidateStateQLPassword?.(brokered.request, brokered.prompt);
              }
              brokeredTargets.delete(reference);
            }
            throw new Error(`[${workspaceLabel(workspace)}] ${safeFailure(response).message}`);
          }
          if (command.command === "connect") retainBrokeredConnection(reference);
          if (command.command === "disconnect") brokeredTargets.clear();
          response = restoreProfileMetadata(response, profileBrokered);
          const output = boundedResponse(response, input.command, workspace, selectedWorkspace);
          return {
            content: [{ type: "text" as const, text: output.text }],
            details: {
              command: input.command,
              workspace,
              ...(selectedWorkspace !== workspace ? { selectedWorkspace } : {}),
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

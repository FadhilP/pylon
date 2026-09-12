export type StateQLCommandOrigin = "legacy" | "user" | "model" | "system" | "api";

export type StateQLMongoCommand =
  | { operation: "find"; collection: string; filter?: Record<string, unknown>; options?: Record<string, unknown> }
  | {
      operation: "aggregate";
      collection: string;
      pipeline: Array<Record<string, unknown>>;
      options?: Record<string, unknown>;
    }
  | { operation: "insertOne"; collection: string; document: Record<string, unknown>; options?: Record<string, never> }
  | {
      operation: "insertMany";
      collection: string;
      documents: Array<Record<string, unknown>>;
      options?: { ordered?: boolean };
    }
  | {
      operation: "updateOne" | "updateMany";
      collection: string;
      filter: Record<string, unknown>;
      update: Record<string, unknown> | Array<Record<string, unknown>>;
      options?: Record<string, unknown>;
    }
  | {
      operation: "replaceOne";
      collection: string;
      filter: Record<string, unknown>;
      replacement: Record<string, unknown>;
      options?: Record<string, unknown>;
    }
  | {
      operation: "deleteOne" | "deleteMany";
      collection: string;
      filter: Record<string, unknown>;
      options?: Record<string, unknown>;
    };

export type StateQLRedisCommand = { command: string; args?: string[] };
export type StateQLCatalogKind = "table" | "view" | "collection" | "function" | "trigger" | "enum" | "key";
export type StateQLCatalogObject = { kind: StateQLCatalogKind; schema?: string; name: string; identity?: string };

export type StateQLPanelCommand =
  | { command: "status" | "profile.list" | "disconnect" }
  | {
      command: "table.plan";
      row_token: string;
      changes: { set?: Record<string, unknown>; unset?: string[] };
      timeout_ms?: number;
    }
  | {
      command: "table.plan.batch";
      updates: Array<{ row_token: string; changes: { set?: Record<string, unknown>; unset?: string[] } }>;
      timeout_ms?: number;
    }
  | {
      command: "objects.list";
      kind?: StateQLCatalogKind;
      schema?: string;
      search?: string;
      offset?: number | string;
      limit?: number;
      timeout_ms?: number;
    }
  | { command: "object.describe"; object: StateQLCatalogObject; timeout_ms?: number }
  | { command: "table.read"; table: { schema?: string; name: string }; limit?: number; timeout_ms?: number }
  | { command: "profile.show"; name: string }
  | { command: "profile.remove"; name: string; forget_credential?: boolean }
  | {
      command: "profile.add";
      name: string;
      target?: string;
      secret_env?: string;
      read_only?: boolean;
      remember?: boolean;
    }
  | {
      command: "profile.update";
      name: string;
      target?: string;
      secret_env?: string;
      read_only?: boolean;
      remember?: boolean;
    }
  | {
      command: "connect";
      target?: string;
      secret_env?: string;
      profile?: string;
      name?: string;
      read_only?: boolean;
      remember?: boolean;
      timeout_ms?: number;
    }
  | {
      /** Panel-only atomic setup; intentionally absent from the model tool contract. */
      command: "connection.setup";
      action: "connect" | "save" | "save-connect";
      target?: string;
      secret_env?: string;
      profile?: string;
      name?: string;
      update?: boolean;
      read_only?: boolean;
      remember?: boolean;
      password_provided?: boolean;
      timeout_ms?: number;
    }
  | {
      command: "query";
      sql: string;
      params?: unknown[] | Record<string, unknown>;
      cache?: "auto" | "bypass" | "require";
      as?: string;
      timeout_ms?: number;
    }
  | {
      command: "exec";
      sql: string;
      params?: unknown[] | Record<string, unknown>;
      replay?: boolean;
      idempotency_key?: string;
      allow_unbounded?: boolean;
      allow_destructive?: boolean;
      timeout_ms?: number;
    }
  | {
      command: "plan";
      sql: string;
      params?: unknown[] | Record<string, unknown>;
      allow_unbounded?: boolean;
      allow_destructive?: boolean;
      timeout_ms?: number;
    }
  | {
      command: "mongo.query";
      mongo: Extract<StateQLMongoCommand, { operation: "find" | "aggregate" }>;
      cache?: "auto" | "bypass" | "require";
      as?: string;
      timeout_ms?: number;
    }
  | {
      command: "mongo.exec";
      mongo: Exclude<StateQLMongoCommand, { operation: "find" | "aggregate" }>;
      replay?: boolean;
      idempotency_key?: string;
      allow_unbounded?: boolean;
      allow_destructive?: boolean;
      timeout_ms?: number;
    }
  | {
      command: "mongo.plan";
      mongo: Exclude<StateQLMongoCommand, { operation: "find" | "aggregate" }>;
      allow_unbounded?: boolean;
      allow_destructive?: boolean;
      timeout_ms?: number;
    }
  | {
      command: "redis.query";
      redis: StateQLRedisCommand;
      cache?: "auto" | "bypass" | "require";
      as?: string;
      timeout_ms?: number;
    }
  | {
      command: "redis.exec";
      redis: StateQLRedisCommand;
      replay?: boolean;
      idempotency_key?: string;
      timeout_ms?: number;
    }
  | { command: "redis.plan"; redis: StateQLRedisCommand; timeout_ms?: number }
  | {
      command: "inspect";
      offset?: number;
      kind: "schema" | "table" | "columns" | "indexes" | "constraints";
      table?: string;
      timeout_ms?: number;
    }
  | { command: "transaction.begin"; isolation?: string }
  | { command: "transaction.status" | "transaction.rollback"; handle?: string }
  | { command: "transaction.commit"; handle?: string; timeout_ms?: number }
  | { command: "apply"; handle: string; timeout_ms?: number }
  | { command: "receipt"; handle: string }
  | {
      command: "history";
      limit?: number;
      offset?: number;
      history_origin?: StateQLCommandOrigin;
      history_category?: "statement" | "introspection" | "management";
      history_internal?: boolean;
    };

const MAX_JSON_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_ITEMS = 100;
const MAX_JSON_STRING = 64 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const HISTORY_ORIGINS = new Set<StateQLCommandOrigin>(["legacy", "user", "model", "system", "api"]);
const INSPECTION_KINDS = new Set(["schema", "table", "columns", "indexes", "constraints"]);
const CACHE_POLICIES = new Set(["auto", "bypass", "require"]);
const FORBIDDEN_MONGO_OPERATORS = new Set(["$out", "$merge", "$changeStream", "$where", "$function", "$accumulator"]);
const UPDATE_PIPELINE_STAGES = new Set(["$addFields", "$set", "$project", "$unset", "$replaceRoot", "$replaceWith"]);
const READ_OPERATIONS = new Set(["find", "aggregate"]);
const CATALOG_KINDS = new Set<StateQLCatalogKind>([
  "table",
  "view",
  "collection",
  "function",
  "trigger",
  "enum",
  "key",
]);
const HISTORY_CATEGORIES = new Set(["statement", "introspection", "management"]);
const REDIS_DISALLOWED_COMMANDS = new Set([
  "EVAL",
  "EVALSHA",
  "EVAL_RO",
  "EVALSHA_RO",
  "SCRIPT",
  "FUNCTION",
  "FCALL",
  "FCALL_RO",
  "ACL",
  "CONFIG",
  "MODULE",
  "SHUTDOWN",
  "DEBUG",
  "MONITOR",
  "CLIENT",
  "COMMAND",
  "INFO",
  "FLUSHALL",
  "FLUSHDB",
  "KEYS",
  "RENAME",
  "RENAMENX",
  "MOVE",
  "MIGRATE",
  "RESTORE",
]);
const WRITE_OPERATIONS = new Set([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
]);

const ALLOWED_FIELDS: Record<StateQLPanelCommand["command"], readonly string[]> = {
  status: [],
  "table.read": ["table", "limit", "timeout_ms"],
  "table.plan": ["row_token", "changes", "timeout_ms"],
  "table.plan.batch": ["updates", "timeout_ms"],
  "objects.list": ["kind", "schema", "search", "offset", "limit", "timeout_ms"],
  "object.describe": ["object", "timeout_ms"],
  "profile.list": [],
  "profile.show": ["name"],
  "profile.add": ["name", "target", "secret_env", "read_only", "remember"],
  "profile.update": ["name", "target", "secret_env", "read_only", "remember"],
  "profile.remove": ["name", "forget_credential"],
  connect: ["target", "secret_env", "profile", "name", "read_only", "remember", "timeout_ms"],
  "connection.setup": [
    "action",
    "target",
    "secret_env",
    "profile",
    "name",
    "update",
    "read_only",
    "remember",
    "password_provided",
    "timeout_ms",
  ],
  disconnect: [],
  query: ["sql", "params", "cache", "as", "timeout_ms"],
  exec: ["sql", "params", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  plan: ["sql", "params", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "mongo.query": ["mongo", "cache", "as", "timeout_ms"],
  "mongo.exec": ["mongo", "replay", "idempotency_key", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "mongo.plan": ["mongo", "allow_unbounded", "allow_destructive", "timeout_ms"],
  "redis.query": ["redis", "cache", "as", "timeout_ms"],
  "redis.exec": ["redis", "replay", "idempotency_key", "timeout_ms"],
  "redis.plan": ["redis", "timeout_ms"],
  inspect: ["kind", "table", "timeout_ms", "offset"],
  "transaction.begin": ["isolation"],
  "transaction.status": ["handle"],
  "transaction.commit": ["handle", "timeout_ms"],
  "transaction.rollback": ["handle"],
  apply: ["handle", "timeout_ms"],
  receipt: ["handle"],
  history: ["limit", "offset", "history_origin", "history_category", "history_internal"],
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedSql(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function positiveInteger(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function optionalTimeout(value: unknown, maximum: number): boolean {
  return value === undefined || positiveInteger(value, maximum);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedJson(value: unknown, depth = 0, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_JSON_STRING;
  if (depth >= MAX_JSON_DEPTH || typeof value !== "object" || value === undefined || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !plainRecord(value)) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  if (items.length > MAX_JSON_ITEMS) return false;
  if (!Array.isArray(value) && Object.keys(value).some(key => key.length > 500)) return false;
  ancestors.add(value);
  const valid = items.every(item => boundedJson(item, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

function jsonBytes(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}

function boundedJsonContainer(value: unknown): boolean {
  return (
    (Array.isArray(value) || plainRecord(value)) &&
    boundedJson(value) &&
    (jsonBytes(value) ?? Infinity) <= MAX_JSON_BYTES
  );
}

function safeMongoJson(value: unknown): boolean {
  if (!boundedJson(value)) return false;
  if (Array.isArray(value)) return value.every(safeMongoJson);
  if (!plainRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => !FORBIDDEN_MONGO_OPERATORS.has(key) && safeMongoJson(child));
}

function mongoDocument(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) && safeMongoJson(value);
}

function optionalMongoDocument(value: unknown): boolean {
  return value === undefined || mongoDocument(value);
}

function mongoCollection(value: unknown): value is string {
  return boundedString(value, 500) && !value.includes("$") && !value.startsWith("system.");
}

function mongoSort(value: unknown): boolean {
  if (mongoDocument(value)) return true;
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        Array.isArray(item) && item.length === 2 && boundedString(item[0], 500) && (item[1] === 1 || item[1] === -1),
    )
  );
}

function mongoHint(value: unknown): boolean {
  return value === undefined || boundedString(value, 500) || mongoDocument(value);
}

function mongoCollation(value: unknown): boolean {
  return value === undefined || mongoDocument(value);
}

function findOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!plainRecord(value) || !safeMongoJson(value)) return false;
  if (!hasOnlyKeys(value, ["projection", "sort", "skip", "limit", "hint", "collation"])) return false;
  if (!optionalMongoDocument(value.projection)) return false;
  if (value.sort !== undefined && !mongoSort(value.sort)) return false;
  if (value.skip !== undefined && (!Number.isSafeInteger(value.skip) || (value.skip as number) < 0)) return false;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 0)) return false;
  return mongoHint(value.hint) && mongoCollation(value.collation);
}

function aggregateOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!plainRecord(value) || !safeMongoJson(value)) return false;
  if (!hasOnlyKeys(value, ["allowDiskUse", "hint", "collation"])) return false;
  if (value.allowDiskUse !== undefined && typeof value.allowDiskUse !== "boolean") return false;
  return mongoHint(value.hint) && mongoCollation(value.collation);
}

function emptyMongoOptions(value: unknown): boolean {
  return value === undefined || (plainRecord(value) && Object.keys(value).length === 0);
}

function mutationOptions(value: unknown, allowUpsert: boolean, allowOrdered = false): boolean {
  if (value === undefined) return true;
  if (!plainRecord(value) || !safeMongoJson(value)) return false;
  const keys = allowOrdered ? ["ordered"] : allowUpsert ? ["upsert", "hint", "collation"] : ["hint", "collation"];
  if (!hasOnlyKeys(value, keys)) return false;
  if (value.upsert !== undefined && typeof value.upsert !== "boolean") return false;
  if (value.ordered !== undefined && typeof value.ordered !== "boolean") return false;
  return mongoHint(value.hint) && mongoCollation(value.collation);
}

function updatePipeline(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(stage => {
      if (!mongoDocument(stage) || Object.keys(stage).length !== 1) return false;
      return UPDATE_PIPELINE_STAGES.has(Object.keys(stage)[0]!);
    })
  );
}

function updateDocument(value: unknown): boolean {
  return mongoDocument(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key.startsWith("$"));
}

function mongoCommandShape(value: Record<string, unknown>, operation: string): boolean {
  switch (operation) {
    case "find":
      return (
        hasOnlyKeys(value, ["operation", "collection", "filter", "options"]) &&
        optionalMongoDocument(value.filter) &&
        findOptions(value.options)
      );
    case "aggregate":
      return (
        hasOnlyKeys(value, ["operation", "collection", "pipeline", "options"]) &&
        Array.isArray(value.pipeline) &&
        value.pipeline.every(stage => mongoDocument(stage) && Object.keys(stage).length === 1) &&
        aggregateOptions(value.options)
      );
    case "insertOne":
      return (
        hasOnlyKeys(value, ["operation", "collection", "document", "options"]) &&
        mongoDocument(value.document) &&
        emptyMongoOptions(value.options)
      );
    case "insertMany":
      return (
        hasOnlyKeys(value, ["operation", "collection", "documents", "options"]) &&
        Array.isArray(value.documents) &&
        value.documents.length > 0 &&
        value.documents.every(mongoDocument) &&
        mutationOptions(value.options, false, true)
      );
    case "updateOne":
    case "updateMany":
      return (
        hasOnlyKeys(value, ["operation", "collection", "filter", "update", "options"]) &&
        mongoDocument(value.filter) &&
        (updateDocument(value.update) || updatePipeline(value.update)) &&
        mutationOptions(value.options, true)
      );
    case "replaceOne":
      return (
        hasOnlyKeys(value, ["operation", "collection", "filter", "replacement", "options"]) &&
        mongoDocument(value.filter) &&
        mongoDocument(value.replacement) &&
        Object.keys(value.replacement).every(key => !key.startsWith("$")) &&
        mutationOptions(value.options, true)
      );
    case "deleteOne":
    case "deleteMany":
      return (
        hasOnlyKeys(value, ["operation", "collection", "filter", "options"]) &&
        mongoDocument(value.filter) &&
        mutationOptions(value.options, false)
      );
    default:
      return false;
  }
}

export function parseStateQLMongoCommand(value: unknown, write: boolean): StateQLMongoCommand | undefined {
  if (!plainRecord(value) || !safeMongoJson(value) || !mongoCollection(value.collection)) return undefined;
  if (typeof value.operation !== "string") return undefined;
  if (!(write ? WRITE_OPERATIONS : READ_OPERATIONS).has(value.operation)) return undefined;
  if ((jsonBytes(value) ?? Infinity) > MAX_JSON_BYTES || !mongoCommandShape(value, value.operation)) return undefined;
  return JSON.parse(JSON.stringify(value)) as StateQLMongoCommand;
}

function commandBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => optionalBoolean(value[key]));
}

function params(value: unknown): boolean {
  return value === undefined || boundedJsonContainer(value);
}

function tableChanges(value: unknown): boolean {
  if (!plainRecord(value) || !hasOnlyKeys(value, ["set", "unset"])) return false;
  const set = value.set;
  const unset = value.unset;
  if (set === undefined && unset === undefined) return false;
  if (
    set !== undefined &&
    (!plainRecord(set) || !params(set) || Object.keys(set).some(name => !boundedString(name, 500)))
  )
    return false;
  if (
    unset !== undefined &&
    (!Array.isArray(unset) ||
      unset.length > 100 ||
      !unset.every(name => boundedString(name, 500)) ||
      new Set(unset).size !== unset.length)
  )
    return false;
  return !unset || !set || !unset.some(name => Object.hasOwn(set, name));
}

function redisCommand(value: unknown): value is StateQLRedisCommand {
  if (!plainRecord(value) || !hasOnlyKeys(value, ["command", "args"]) || !boundedString(value.command, 100))
    return false;
  const command = value.command.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(command) || REDIS_DISALLOWED_COMMANDS.has(command)) return false;
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.length > 100 ||
      !value.args.every(
        arg => typeof arg === "string" && arg.length <= 64 * 1024 && !/[\u0000-\u001f\u007f]/u.test(arg),
      ))
  )
    return false;
  const args = value.args ?? [];
  const cursor = command === "SCAN" ? args[0] : ["HSCAN", "SSCAN", "ZSCAN"].includes(command) ? args[1] : undefined;
  return cursor === undefined || /^\d{1,32}$/u.test(cursor);
}

function sqlCommand(value: Record<string, unknown>, timeout: number, write: boolean): boolean {
  if (!boundedSql(value.sql, 100_000) || !params(value.params) || !optionalTimeout(value.timeout_ms, timeout))
    return false;
  if (
    !commandBooleans(
      value,
      write ? ["replay", "allow_unbounded", "allow_destructive"] : ["allow_unbounded", "allow_destructive"],
    )
  )
    return false;
  return !write || optionalString(value.idempotency_key, 500);
}

function connectionSources(value: Record<string, unknown>, includeProfile: boolean): boolean {
  const sources = [value.target, value.secret_env, includeProfile ? value.profile : undefined].filter(
    item => item !== undefined,
  );
  if (sources.length !== 1) return false;
  if (!optionalString(value.target, 4_096) || !optionalString(value.secret_env, 200)) return false;
  if (value.secret_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.secret_env as string)) return false;
  return !includeProfile || optionalString(value.profile, 200);
}

function commandShape(value: Record<string, unknown>, maxTimeoutMs: number): boolean {
  switch (value.command) {
    case "table.plan":
      return (
        boundedString(value.row_token, 200) &&
        tableChanges(value.changes) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "table.plan.batch":
      return (
        Array.isArray(value.updates) &&
        value.updates.length >= 1 &&
        value.updates.length <= 100 &&
        boundedJsonContainer(value.updates) &&
        value.updates.every(
          update =>
            plainRecord(update) &&
            hasOnlyKeys(update, ["row_token", "changes"]) &&
            boundedString(update.row_token, 200) &&
            tableChanges(update.changes),
        ) &&
        new Set(value.updates.map(update => (update as Record<string, unknown>).row_token)).size ===
          value.updates.length &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "objects.list":
      return (
        (value.kind === undefined ||
          (typeof value.kind === "string" && CATALOG_KINDS.has(value.kind as StateQLCatalogKind))) &&
        optionalString(value.schema, 500) &&
        optionalString(value.search, 200) &&
        (value.offset === undefined ||
          (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 1_000_000) ||
          (typeof value.offset === "string" && /^\d{1,32}$/u.test(value.offset))) &&
        (value.limit === undefined || positiveInteger(value.limit, 100)) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "object.describe":
      return (
        plainRecord(value.object) &&
        hasOnlyKeys(value.object, ["kind", "schema", "name", "identity"]) &&
        typeof value.object.kind === "string" &&
        CATALOG_KINDS.has(value.object.kind as StateQLCatalogKind) &&
        boundedString(value.object.name, 500) &&
        optionalString(value.object.schema, 500) &&
        optionalString(value.object.identity, 500) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "table.read":
      return (
        plainRecord(value.table) &&
        hasOnlyKeys(value.table, ["schema", "name"]) &&
        boundedString(value.table.name, 500) &&
        optionalString(value.table.schema, 500) &&
        (value.limit === undefined || positiveInteger(value.limit, 10_000)) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "status":
    case "profile.list":
    case "disconnect":
      return true;
    case "profile.show":
      return boundedString(value.name, 200);
    case "profile.remove":
      return boundedString(value.name, 200) && optionalBoolean(value.forget_credential);
    case "profile.add":
      return (
        boundedString(value.name, 200) &&
        connectionSources(value, false) &&
        optionalBoolean(value.read_only) &&
        optionalBoolean(value.remember) &&
        (value.remember !== true || value.target !== undefined)
      );
    case "profile.update": {
      const hasSource = value.target !== undefined || value.secret_env !== undefined;
      return (
        boundedString(value.name, 200) &&
        (!hasSource || connectionSources(value, false)) &&
        optionalBoolean(value.read_only) &&
        optionalBoolean(value.remember) &&
        (value.remember !== true || value.target !== undefined) &&
        (hasSource || value.read_only !== undefined)
      );
    }
    case "connect":
      return (
        connectionSources(value, true) &&
        optionalString(value.name, 200) &&
        optionalBoolean(value.read_only) &&
        optionalBoolean(value.remember) &&
        (value.remember !== true || value.target !== undefined) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "connection.setup":
      return (
        (value.action === "connect" || value.action === "save" || value.action === "save-connect") &&
        connectionSources(value, true) &&
        optionalString(value.name, 200) &&
        optionalBoolean(value.update) &&
        optionalBoolean(value.read_only) &&
        optionalBoolean(value.remember) &&
        optionalBoolean(value.password_provided) &&
        (value.remember !== true || value.target !== undefined) &&
        (value.action === "connect" || boundedString(value.name, 200)) &&
        (value.update !== true || boundedString(value.name, 200)) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "query":
      return (
        boundedSql(value.sql, 100_000) &&
        params(value.params) &&
        optionalString(value.as, 200) &&
        (value.cache === undefined || (typeof value.cache === "string" && CACHE_POLICIES.has(value.cache))) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "exec":
      return sqlCommand(value, maxTimeoutMs, true);
    case "plan":
      return sqlCommand(value, maxTimeoutMs, false);
    case "mongo.query":
      return (
        Boolean(parseStateQLMongoCommand(value.mongo, false)) &&
        optionalString(value.as, 200) &&
        (value.cache === undefined || (typeof value.cache === "string" && CACHE_POLICIES.has(value.cache))) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "mongo.exec":
      return (
        Boolean(parseStateQLMongoCommand(value.mongo, true)) &&
        commandBooleans(value, ["replay", "allow_unbounded", "allow_destructive"]) &&
        optionalString(value.idempotency_key, 500) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "mongo.plan":
      return (
        Boolean(parseStateQLMongoCommand(value.mongo, true)) &&
        commandBooleans(value, ["allow_unbounded", "allow_destructive"]) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "redis.query":
      return (
        redisCommand(value.redis) &&
        optionalString(value.as, 200) &&
        (value.cache === undefined || (typeof value.cache === "string" && CACHE_POLICIES.has(value.cache))) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "redis.exec":
      return (
        redisCommand(value.redis) &&
        commandBooleans(value, ["replay"]) &&
        optionalString(value.idempotency_key, 500) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "redis.plan":
      return redisCommand(value.redis) && optionalTimeout(value.timeout_ms, maxTimeoutMs);

    case "inspect":
      return (
        typeof value.kind === "string" &&
        INSPECTION_KINDS.has(value.kind) &&
        (value.offset === undefined ||
          (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 100_000)) &&
        optionalString(value.table, 500) &&
        optionalTimeout(value.timeout_ms, maxTimeoutMs)
      );
    case "transaction.begin":
      return (
        value.isolation === undefined ||
        (boundedString(value.isolation, 50) &&
          /^(?:serializable|repeatable[ _-]+read|read[ _-]+committed|read[ _-]+uncommitted|snapshot)$/iu.test(
            value.isolation.trim(),
          ))
      );
    case "transaction.status":
    case "transaction.rollback":
      return optionalString(value.handle, 200);
    case "transaction.commit":
      return optionalString(value.handle, 200) && optionalTimeout(value.timeout_ms, maxTimeoutMs);
    case "apply":
      return boundedString(value.handle, 200) && optionalTimeout(value.timeout_ms, maxTimeoutMs);
    case "receipt":
      return boundedString(value.handle, 200);
    case "history":
      return (
        (value.limit === undefined || positiveInteger(value.limit, 100)) &&
        (value.offset === undefined ||
          (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 1_000_000)) &&
        (value.history_origin === undefined ||
          (typeof value.history_origin === "string" &&
            HISTORY_ORIGINS.has(value.history_origin as StateQLCommandOrigin))) &&
        (value.history_category === undefined ||
          (typeof value.history_category === "string" && HISTORY_CATEGORIES.has(value.history_category))) &&
        optionalBoolean(value.history_internal)
      );
    default:
      return false;
  }
}

export function parseStateQLPanelCommand(
  value: unknown,
  options: { maxTimeoutMs?: number } = {},
): StateQLPanelCommand | undefined {
  if (!plainRecord(value) || typeof value.command !== "string") return undefined;
  const allowed = ALLOWED_FIELDS[value.command as StateQLPanelCommand["command"]];
  if (!allowed || !hasOnlyKeys(value, ["command", ...allowed])) return undefined;
  const maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
  if (!positiveInteger(maxTimeoutMs, MAX_TIMEOUT_MS) || !commandShape(value, maxTimeoutMs)) return undefined;
  return JSON.parse(JSON.stringify(value)) as StateQLPanelCommand;
}

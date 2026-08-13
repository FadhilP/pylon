import { randomBytes } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StateQL, type BatchCommand, type CredentialRequest, type Response, type StateQLActorOptions, type StateQLSnapshot } from "@fadhilp/stateql";
import { Type, type Static } from "typebox";

const COMMANDS = [
  "connect", "disconnect", "status",
  "profile.add", "profile.list", "profile.show", "profile.remove",
  "session.summary",
  "query", "filter", "exec", "show", "rows", "count", "columns", "alias.set", "inspect",
  "transaction.begin", "transaction.status", "transaction.commit", "transaction.rollback",
  "plan", "apply", "history", "receipt", "doctor", "capabilities",
] as const;

const toolSchema = Type.Object({
  command: StringEnum(COMMANDS, { description: "StateQL command" }),
  target: Type.Optional(Type.String({ description: "connect/profile.add only: SQLite path or credential-free PostgreSQL/MySQL URL. In Pylon Web, a server URL with username but no password opens a masked password dialog. URL file options such as sslrootcert must use a native absolute path visible to the host process (for example, a percent-encoded C:/... path on Windows), not a shell-only /tmp path.", maxLength: 4096 })),
  sql: Type.Optional(Type.String({ description: "query/exec/plan only: one SQL statement", maxLength: 100_000 })),
  where: Type.Optional(Type.String({ description: "filter only: SQL predicate", maxLength: 20_000 })),
  handle: Type.Optional(Type.String({ description: "show/rows/count/columns/alias.set/transaction.status/transaction.commit/transaction.rollback/apply/receipt only", maxLength: 200 })),
  name: Type.Optional(Type.String({ description: "connect/profile.add/profile.show/profile.remove/alias.set only", maxLength: 200 })),
  as: Type.Optional(Type.String({ description: "query/filter only: result alias", maxLength: 200 })),
  kind: Type.Optional(StringEnum(["schema", "table", "columns", "indexes", "constraints"] as const, { description: "inspect only" })),
  table: Type.Optional(Type.String({ description: "inspect only: optional qualified table name", maxLength: 500 })),
  params: Type.Optional(Type.Any({ description: "query/filter/exec/plan only: positional JSON array or named JSON object" })),
  cache: Type.Optional(StringEnum(["auto", "bypass", "require"] as const, { description: "query only" })),
  read_only: Type.Optional(Type.Boolean({ description: "connect/profile.add only" })),
  secret_env: Type.Optional(Type.String({ description: "connect/profile.add only: environment variable whose value is the complete PostgreSQL/MySQL URL or explicit sqlite:<path> source; use instead of target", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 200 })),
  profile: Type.Optional(Type.String({ description: "connect only: saved profile name", maxLength: 200 })),
  replay: Type.Optional(Type.Boolean({ description: "exec only" })),
  idempotency_key: Type.Optional(Type.String({ description: "exec only", maxLength: 500 })),
  allow_unbounded: Type.Optional(Type.Boolean({ description: "exec/plan only" })),
  allow_destructive: Type.Optional(Type.Boolean({ description: "exec/plan only" })),
  offset: Type.Optional(Type.Integer({ description: "rows only: zero-based start; when the complete truncated query preview is present, continue from preview_count instead of refetching offset 0", minimum: 0, maximum: 10_000 })),
  limit: Type.Optional(Type.Integer({ description: "rows/history only", minimum: 1, maximum: 100 })),
  isolation: Type.Optional(Type.String({ description: "transaction.begin only", maxLength: 50 })),
  timeout_ms: Type.Optional(Type.Integer({ description: "connect/query/exec/inspect/transaction.commit/plan/apply only", minimum: 1, maximum: 2_147_483_647 })),
}, { additionalProperties: false });

export type StateQLToolInput = Static<typeof toolSchema>;

type RuntimeStateQL = Pick<StateQL, "close" | "executeCommand" | "snapshot">;
type Factory = (options: StateQLActorOptions) => RuntimeStateQL;

interface Runtime {
  actorId: string;
  controller: AbortController;
  stateql: RuntimeStateQL;
}

interface StateQLPasswordTarget {
  driver: "postgres" | "mysql";
  username: string;
  hostname: string;
  port: number;
  database: string;
}

interface StateQLCredentialHost {
  requestStateQLCredential(request: CredentialRequest): Promise<string | undefined>;
  requestStateQLPassword?(request: CredentialRequest, target: StateQLPasswordTarget, options?: { timeoutMs: number }): Promise<string | undefined>;
  invalidateStateQLPassword?(request: CredentialRequest, target: StateQLPasswordTarget): void;
}

function credentialHost(value: unknown): StateQLCredentialHost | undefined {
  if (!value || typeof value !== "object") return undefined;
  return typeof (value as Partial<StateQLCredentialHost>).requestStateQLCredential === "function"
    ? value as StateQLCredentialHost
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

function abortSignal(value: unknown): value is AbortSignal | undefined {
  return value === undefined || Boolean(value) && typeof value === "object"
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
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
  apply: ["handle", "timeout_ms"],
  history: ["limit"],
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
  show: ["handle"],
  rows: ["handle"],
  count: ["handle"],
  columns: ["handle"],
  "alias.set": ["name", "handle"],
  inspect: ["kind"],
  plan: ["sql"],
  apply: ["handle"],
  receipt: ["handle"],
};

const CONFIRMED_COMMANDS = new Set<StateQLToolInput["command"]>([
  "connect", "profile.add", "profile.remove", "exec", "apply",
  "transaction.commit", "transaction.rollback",
]);
const MAX_PARAMS_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 40 * 1024;
const BROKERED_REFERENCE_PREFIX = "PYLON_STATEQL_BROKERED_";
const ENDPOINT_QUERY_KEYS = new Set(["host", "hostaddr", "port", "database", "dbname", "user", "username", "password", "socketpath"]);

function validateInput(input: StateQLToolInput): BatchCommand & StateQLToolInput {
  const allowed = new Set<keyof StateQLToolInput>(["command", ...fields[input.command]]);
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !allowed.has(key as keyof StateQLToolInput)) {
      throw new Error(`${input.command} does not accept ${key}`);
    }
  }
  for (const key of required[input.command] ?? []) {
    if (input[key] === undefined || input[key] === "") throw new Error(`${input.command} requires ${String(key)}`);
  }
  if (input.command === "connect" && input.target !== undefined && input.secret_env !== undefined) {
    throw new Error("connect accepts either target or secret_env; secret_env must contain a complete database URL or explicit sqlite:<path> source");
  }
  if (input.params !== undefined) {
    if (!Array.isArray(input.params) && (!input.params || typeof input.params !== "object")) {
      throw new Error("params must be a JSON array or object");
    }
    let encoded: string;
    try { encoded = JSON.stringify(input.params); }
    catch { throw new Error("params must be JSON-serializable"); }
    if (Buffer.byteLength(encoded, "utf8") > MAX_PARAMS_BYTES) throw new Error(`params cannot exceed ${formatSize(MAX_PARAMS_BYTES)}`);
  }
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

function brokeredTarget(value: string): BrokeredTarget | undefined {
  try {
    const url = new URL(value);
    const driver: StateQLPasswordTarget["driver"] | undefined = url.protocol === "postgres:" || url.protocol === "postgresql:" ? "postgres"
      : url.protocol === "mysql:" ? "mysql"
        : undefined;
    if (!driver || !url.username || url.password || !url.hostname || url.hash) return undefined;
    if ([...url.searchParams.keys()].some((key) => ENDPOINT_QUERY_KEYS.has(key.toLowerCase()))) return undefined;
    const port = Number(url.port || (driver === "postgres" ? "5432" : "3306"));
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

function insecureTls(target: string | undefined): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const sslMode = url.searchParams.getAll("sslmode").at(-1)?.toLowerCase();
    const libpqCompat = url.searchParams.getAll("uselibpqcompat").at(-1)?.toLowerCase() === "true";
    return sslMode === "disable" || sslMode === "no-verify"
      || libpqCompat && (sslMode === undefined || ["prefer", "require", "verify-ca"].includes(sslMode))
      || url.searchParams.get("ssl")?.toLowerCase() === "false"
      || url.searchParams.get("rejectUnauthorized")?.toLowerCase() === "false";
  } catch {
    return false;
  }
}

function confirmationText(input: StateQLToolInput, brokered = false): string {
  switch (input.command) {
    case "connect": {
      const source = input.profile ? `profile “${input.profile}”`
        : input.secret_env ? `environment variable ${input.secret_env}, which must contain a complete PostgreSQL/MySQL URL or explicit sqlite:<path> source`
          : brokered ? "the provided passwordless target using its securely brokered password approval"
            : "the provided target";
      const tlsWarning = insecureTls(input.target) ? " Warning: this target weakens or disables TLS certificate or hostname verification." : "";
      return `Connect StateQL using ${source} in ${input.read_only === false ? "read-write" : "read-only"} mode? Queries may expose database content to the selected model provider.${tlsWarning}`;
    }
    case "profile.add": return `Save StateQL profile “${input.name ?? ""}” in ${input.read_only === false ? "read-write" : "read-only"} mode? Credential values are not stored.`;
    case "profile.remove": return `Remove StateQL profile “${input.name ?? ""}”? Existing database data is not changed.`;
    case "exec": {
      const overrides = [input.replay && "replay", input.allow_unbounded && "unbounded mutation", input.allow_destructive && "destructive operation"].filter(Boolean);
      return `Execute a database write${overrides.length ? ` with ${overrides.join(", ")} override${overrides.length === 1 ? "" : "s"}` : ""}? StateQL duplicate and read-only safeguards remain authoritative. Parameters and results may be retained in Pi history.`;
    }
    case "apply": return `Apply StateQL write plan “${input.handle ?? ""}”? The stored authorization flags and state checks remain authoritative.`;
    case "transaction.commit": return `Commit the active StateQL transaction and execute its staged writes?`;
    case "transaction.rollback": return `Roll back the active StateQL transaction and discard its staged writes?`;
    default: return "Allow this StateQL operation?";
  }
}

function fit(value: string, maxBytes: number): string {
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return output;
}

function boundedResponse(response: Response<unknown>): { text: string; truncated: boolean } {
  const output = JSON.stringify(response, null, 2);
  const result = truncateHead(output, { maxLines: 1_000, maxBytes: MAX_OUTPUT_BYTES });
  if (!result.truncated) return { text: result.content, truncated: false };
  const notice = `\n\n[StateQL output truncated at ${formatSize(MAX_OUTPUT_BYTES)}. Request a smaller rows limit or narrower query.]`;
  return {
    text: `${fit(result.content, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8"))}${notice}`,
    truncated: true,
  };
}

function boundedError(value: string, maxBytes = 2_000): string {
  const redacted = value.trim()
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@")
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=***");
  return fit(redacted, maxBytes);
}

function safeFailure(response: Extract<Response<unknown>, { ok: false }>): Error {
  return new Error(`StateQL ${response.error.code}: ${boundedError(response.error.message)}`);
}

function passwordAuthenticationFailed(response: Extract<Response<unknown>, { ok: false }>): boolean {
  return response.error.code === "CONNECTION_FAILED"
    && /password authentication failed|sasl[^\n]*password|password[^\n]*authentication failed|access denied for user/iu.test(response.error.message);
}

function sessionId(ctx: any): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (typeof id !== "string" || !id || id.length > 128) throw new Error("StateQL requires a stable Pi session identity");
  return id;
}

export default function stateqlExtension(pi: ExtensionAPI, options: { createStateQL?: Factory } = {}) {
  const createStateQL: Factory = options.createStateQL ?? ((value) => StateQL.forActor(value));
  let runtime: Runtime | undefined;
  let activeCredentialHost: StateQLCredentialHost | undefined;
  const brokeredTargets = new Map<string, RuntimeBrokeredTarget>();
  let stopping = false;
  let approvalTiming: { guardEnabled: boolean; timeoutSeconds: number | null } = { guardEnabled: false, timeoutSeconds: null };
  let tail: Promise<void> = Promise.resolve();

  const exclusive = <T>(action: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(action, action);
    tail = result.then(() => undefined, () => undefined);
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
        credentialResolver: async (request) => {
          if (request.reference.startsWith(BROKERED_REFERENCE_PREFIX)) {
            const target = brokeredTargets.get(request.reference);
            if (!target || target.actorId !== request.actorId
              || target.stateqlSessionId && target.stateqlSessionId !== request.session.id) return undefined;
            target.stateqlSessionId ??= request.session.id;
            target.request = { ...request, signal: undefined };
            const password = await activeCredentialHost?.requestStateQLPassword?.(request, target.prompt, { timeoutMs: target.passwordTimeoutMs });
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
    if (!runtime || stopping || actorId && runtime.actorId !== actorId) throw new Error("StateQL is unavailable for this Pi session");
    return runtime;
  };

  const disposePolicy = pi.events.on("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2 || typeof event.sessionId !== "string" || event.sessionId !== runtime?.actorId) return;
    const timeoutSeconds = event.dialogTimeouts?.guard;
    approvalTiming = typeof event.guardEnabled === "boolean"
      && (timeoutSeconds === null || typeof timeoutSeconds === "number" && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 15 && timeoutSeconds <= 86_400)
      ? { guardEnabled: event.guardEnabled, timeoutSeconds }
      : { guardEnabled: false, timeoutSeconds: null };
  });

  const disposeSnapshot = pi.events.on("pylon:stateql-snapshot-request", (value: unknown) => {
    const request = value && typeof value === "object" ? value as Partial<SnapshotRequest> : undefined;
    if (request?.version !== 1 || typeof request.sessionId !== "string" || request.sessionId !== runtime?.actorId
      || typeof request.claim !== "function" || typeof request.respond !== "function" || !request.claim()) return;
    const historyLimit = request.historyLimit ?? 50;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) return;
    request.respond(Promise.resolve().then(() => {
      if (request.signal?.aborted) throw new Error("StateQL snapshot request cancelled");
      return current(request.sessionId).stateql.snapshot({ historyLimit });
    }));
  });

  const disposeRows = pi.events.on("pylon:stateql-rows-request", (value: unknown) => {
    const request = value && typeof value === "object" ? value as Partial<RowsRequest> : undefined;
    // Validate everything before claiming so malformed requests remain available to another owner.
    if (request?.version !== 1 || typeof request.sessionId !== "string" || request.sessionId !== runtime?.actorId
      || typeof request.handle !== "string" || !request.handle.trim() || request.handle.length > 200
      || typeof request.offset !== "number" || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 10_000
      || typeof request.limit !== "number" || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
      || typeof request.claim !== "function" || typeof request.respond !== "function" || !abortSignal(request.signal)) return;
    if (!request.claim()) return;
    request.respond(exclusive(async () => {
      if (request.signal?.aborted) throw new Error("StateQL rows request cancelled");
      const response = await current(request.sessionId).stateql.executeCommand({
        command: "rows",
        handle: request.handle,
        offset: request.offset,
        limit: request.limit,
      } as BatchCommand);
      if (!response.ok) throw safeFailure(response);
      return response.data;
    }));
  });

  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond(exclusive(async () => {
      const snapshot = current().stateql.snapshot({ historyLimit: 1 });
      const connection = snapshot.connection
        ? `${snapshot.connection.driver} (${snapshot.connection.read_only ? "read-only" : "read-write"})`
        : "none";
      return {
        version: 1,
        owner: "pi-stateql",
        label: "StateQL",
        lines: [`Workspace: ${snapshot.session.name} (${snapshot.session.status})`, `Actor: ${snapshot.actor_id}`, `Connection: ${connection}`, `History: ${snapshot.history.length ? "available" : "empty"}`],
        warning: snapshot.session.status !== "active",
      };
    }));
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
    disposeHealth();
    await exclusive(() => {
      runtime?.stateql.close();
      runtime = undefined;
    });
  });

  pi.registerTool({
    name: "stateql",
    label: "StateQL",
    description: "Perform user-requested SQLite, PostgreSQL, or MySQL work. Prefer read-only profiles and parameterized SQL with explicit ORDER BY and LIMIT. Query output already includes a preview in model context; call rows only when truncated or additional rows are needed. When the complete preview is present, continue from preview_count rather than repeating offset 0. For PostgreSQL/MySQL, never put passwords in target: use Pylon's masked prompt or secret_env for a complete source already stored in an environment variable. Never weaken TLS verification or set replay, unbounded, or destructive overrides without explicit user authorization. Plan consequential writes when practical; use doctor for storage-integrity failures. Supports schemas, confirmed writes, transactions, receipts, and history; cross-session lifecycle, purge, and arbitrary export are unavailable. Output is capped at 40 KB.",
    promptSnippet: "Query and safely modify databases with durable StateQL result handles",
    promptGuidelines: [
      "Use stateql for user-requested database work; prefer read-only profiles and parameterized SQL with explicit ORDER BY and LIMIT.",
      "For PostgreSQL/MySQL targets, include the username but never a password in target; Pylon Web will request the password through a masked dialog. Use secret_env when the complete source already lives in an environment variable.",
      "Never weaken TLS or certificate verification without explicit user authorization; prefer configuring the database CA certificate with a native host absolute path, not a shell-only path such as /tmp on Windows.",
      "StateQL query output already includes preview rows in model context. Call StateQL rows only when the result is truncated or missing needed rows; when the complete preview is present, continue from preview_count instead of duplicating it from offset 0.",
      "Reuse StateQL result handles with filter, rows, count, and columns instead of rerunning queries.",
      "Use StateQL plan before consequential writes when practical; never set replay, unbounded, or destructive overrides without explicit user authorization.",
      "Use doctor to diagnose StateQL storage integrity or STATE_CORRUPTED failures; purge remains unavailable.",
    ],
    parameters: toolSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input: StateQLToolInput, signal, onUpdate, ctx) {
      const command = validateInput(input);
      const id = sessionId(ctx);
      const host = credentialHost(ctx.ui);
      const target = command.command === "connect" && command.target && host?.requestStateQLPassword
        ? brokeredTarget(command.target)
        : undefined;
      const insecureBrokeredConnect = Boolean(target && insecureTls(input.target));
      const passwordTimeoutMs = approvalTiming.guardEnabled && approvalTiming.timeoutSeconds !== null
        ? approvalTiming.timeoutSeconds * 1_000
        : 0;
      const requiresConfirmation = CONFIRMED_COMMANDS.has(command.command)
        && (!target || insecureBrokeredConnect);
      if (requiresConfirmation) {
        if (!ctx.hasUI) throw new Error(`${input.command} requires interactive confirmation`);
        const title = insecureBrokeredConnect ? "Allow insecure database TLS?" : "Allow StateQL operation?";
        if (!await ctx.ui.confirm(title, confirmationText(input, Boolean(target)), { timeout: passwordTimeoutMs })) {
          return { content: [{ type: "text" as const, text: "User declined the StateQL operation; nothing was executed." }], details: { command: input.command, declined: true } };
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
      onUpdate?.({ content: [{ type: "text" as const, text: `Running StateQL ${input.command}...` }], details: { command: input.command } });
      if (ctx.hasUI) ctx.ui.setStatus?.("pi-stateql", `database: ${input.command}`);
      try {
        return await exclusive(async () => {
          const active = current(id);
          if (signal?.aborted) throw new Error("StateQL operation cancelled");
          const abort = () => active.controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          let response: Response<unknown>;
          activeCredentialHost = host;
          try { response = await active.stateql.executeCommand(executionCommand); }
          catch (error) {
            if (reference) brokeredTargets.delete(reference);
            throw error;
          } finally {
            activeCredentialHost = undefined;
            signal?.removeEventListener("abort", abort);
            replaceAborted(active);
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
          const output = boundedResponse(response);
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

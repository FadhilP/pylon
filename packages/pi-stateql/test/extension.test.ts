import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StateQL,
  type BatchCommand,
  type CredentialRequest,
  type StateQLActorOptions,
  type StateQLSnapshot,
} from "@fadhilp/stateql";
import stateqlExtension from "../extensions/pi-stateql.ts";

const credentialRequest: CredentialRequest = {
  reference: "APP_DATABASE_URL",
  actorId: "pi-session",
  session: { id: "s_1", name: "shared-workspace" },
  operation: "query",
  access: "read",
  connection: { id: "c_1", name: "app", driver: "postgres", database: "app", readOnly: true },
};

const baseSnapshot: StateQLSnapshot = {
  session: { session_id: "s_1", name: "shared-workspace", status: "active" },
  actor_id: "pi-session",
  connection: null,
  transaction: null,
  state_version: null,
  state_confidence: null,
  recent_results: [],
  recent_operations: [],
  history: [],
};

class FakeStateQL {
  closed = false;
  commands: BatchCommand[] = [];
  snapshotCalls: number[] = [];
  executeImpl?: (command: BatchCommand) => Promise<any>;
  readonly options: StateQLActorOptions;

  constructor(options: StateQLActorOptions) {
    this.options = options;
  }

  close() {
    this.closed = true;
  }
  snapshot(options: { historyLimit?: number } = {}) {
    this.snapshotCalls.push(options.historyLimit ?? 50);
    return structuredClone(baseSnapshot);
  }
  async executeCommand(command: BatchCommand) {
    this.commands.push(command);
    if (this.executeImpl) return this.executeImpl(command);
    return {
      ok: true,
      command_id: "cmd_1",
      session_id: "s_1",
      data: { command: command.command },
      warnings: [],
      meta: { duration_ms: 1 },
    };
  }
}

function harness(real = false) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const events = new Map<string, Function[]>();
  const emitted: Array<{ name: string; value: any }> = [];
  const instances: FakeStateQL[] = [];
  const pi = {
    events: {
      on(name: string, handler: Function) {
        events.set(name, [...(events.get(name) ?? []), handler]);
        return () =>
          events.set(
            name,
            (events.get(name) ?? []).filter(item => item !== handler),
          );
      },
      emit(name: string, value: unknown) {
        emitted.push({ name, value });
        for (const handler of events.get(name) ?? []) handler(value);
      },
    },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
  if (real) stateqlExtension(pi as any);
  else
    stateqlExtension(pi as any, {
      createStateQL(options) {
        const stateql = new FakeStateQL(options);
        instances.push(stateql);
        return stateql;
      },
    });
  return { tools, handlers, events, emitted, instances };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: {
      async confirm() {
        return true;
      },
      setStatus() {},
    },
    ...overrides,
  };
}

async function start(value = harness()) {
  await value.handlers.get("session_start")![0]({}, context());
  return value;
}

async function persistedText(root: string): Promise<string> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(await readFile(path, "utf8"));
    }
  };
  await visit(root);
  return output.join("\n");
}

test("composes environment and active Pylon credential resolution without retaining the host", async () => {
  const value = await start();
  const resolver = value.instances[0].options.credentialResolver!;
  const sentinel = "postgres://private:sentinel@localhost/app";
  const previous = process.env.APP_DATABASE_URL;
  let hostCalls = 0;
  const ui = {
    async confirm() {
      return true;
    },
    setStatus() {},
    async requestStateQLCredential(request: CredentialRequest) {
      hostCalls++;
      assert.deepEqual(request, credentialRequest);
      return sentinel;
    },
  };
  value.instances[0].executeImpl = async () => {
    assert.equal(await resolver(credentialRequest), sentinel);
    return { ok: true, command_id: "cmd_secret", session_id: "s_1", data: {}, warnings: [], meta: { duration_ms: 1 } };
  };
  try {
    delete process.env.APP_DATABASE_URL;
    const updates: unknown[] = [];
    const result = await value.tools
      .get("stateql")
      .execute(
        "credential",
        { command: "query", sql: "SELECT 1" },
        undefined,
        (update: unknown) => updates.push(update),
        context({ ui }),
      );
    assert.equal(hostCalls, 1);
    assert.equal(JSON.stringify({ result, updates }).includes(sentinel), false);
    assert.equal(await resolver(credentialRequest), undefined);

    process.env.APP_DATABASE_URL = sentinel;
    assert.equal(await resolver(credentialRequest), sentinel);
    process.env.APP_DATABASE_URL = "";
    assert.equal(await resolver(credentialRequest), "");
    assert.equal(hostCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = previous;
  }
});

test("Pylon Web password-brokers username-only server targets without leaking the password", async () => {
  const value = await start();
  const tool = value.tools.get("stateql");
  const target = "postgresql://postgres@db.example.com:5432/app?sslmode=require";
  const password = "p%@:/# Ü";
  const envSentinel = "postgresql://postgres:wrong@evil.example.com/app";
  let confirmations = 0;
  let passwordRequests = 0;
  let passwordOptions: unknown;
  let internalReference = "";
  const ui = {
    async confirm() {
      confirmations++;
      return true;
    },
    setStatus() {},
    async requestStateQLCredential() {
      throw new Error("full source prompt should not run");
    },
    async requestStateQLPassword(request: CredentialRequest, metadata: Record<string, unknown>, options: unknown) {
      passwordRequests++;
      passwordOptions = options;
      internalReference = request.reference;
      assert.match(request.reference, /^PYLON_STATEQL_BROKERED_[A-F0-9]{48}$/);
      assert.deepEqual(metadata, {
        driver: "postgres",
        username: "postgres",
        hostname: "db.example.com",
        port: 5432,
        database: "app",
      });
      return password;
    },
  };
  value.instances[0].executeImpl = async command => {
    assert.equal(command.command, "connect");
    assert.equal(command.target, undefined);
    assert.match(String(command.secret_env), /^PYLON_STATEQL_BROKERED_/);
    process.env[String(command.secret_env)] = envSentinel;
    const request: CredentialRequest = {
      reference: String(command.secret_env),
      actorId: "pi-session",
      session: { id: "s_1", name: "workspace" },
      operation: "connect",
      access: "read",
      requestedReadOnly: true,
    };
    const resolved = await value.instances[0].options.credentialResolver!(request);
    const url = new URL(String(resolved));
    assert.equal(url.username, "postgres");
    assert.equal(decodeURIComponent(url.password), password);
    assert.equal(url.hostname, "db.example.com");
    assert.equal(url.pathname, "/app");
    assert.equal(url.searchParams.get("sslmode"), "require");
    return {
      ok: true,
      command_id: "cmd_password",
      session_id: "s_1",
      data: {},
      warnings: [],
      meta: { duration_ms: 1 },
    };
  };
  try {
    value.events.get("pylon:runtime-policy")![0]({
      version: 2,
      sessionId: "pi-session",
      guardEnabled: true,
      dialogTimeouts: { guard: 90, clarify: 60 },
    });
    const result = await tool.execute(
      "password",
      { command: "connect", target, read_only: true },
      undefined,
      undefined,
      context({ ui }),
    );
    assert.equal(passwordRequests, 1);
    assert.deepEqual(passwordOptions, { timeoutMs: 90_000 });
    assert.equal(confirmations, 0);
    assert.equal(JSON.stringify({ result, commands: value.instances[0].commands }).includes(password), false);
    assert.equal(JSON.stringify({ result, commands: value.instances[0].commands }).includes(envSentinel), false);
  } finally {
    if (internalReference) delete process.env[internalReference];
  }
});

test("Pylon requires insecure TLS approval before releasing the brokered password", async () => {
  const value = await start();
  const order: string[] = [];
  let confirmation = "";
  const ui = {
    async confirm(title: string, message: string) {
      order.push("confirm");
      confirmation = `${title} ${message}`;
      return true;
    },
    setStatus() {},
    async requestStateQLCredential() {
      throw new Error("full source prompt should not run");
    },
    async requestStateQLPassword() {
      order.push("password");
      return "private";
    },
  };
  value.instances[0].executeImpl = async command => {
    await value.instances[0].options.credentialResolver!({
      reference: String(command.secret_env),
      actorId: "pi-session",
      session: { id: "s_1", name: "workspace" },
      operation: "connect",
      access: "read",
      requestedReadOnly: true,
    });
    return {
      ok: true,
      command_id: "cmd_insecure",
      session_id: "s_1",
      data: {},
      warnings: [],
      meta: { duration_ms: 1 },
    };
  };
  const targets = [
    "postgresql://postgres@db.example.com/app?sslmode=no-verify",
    "postgresql://postgres@db.example.com/app?sslmode=require&sslmode=no-verify",
    "postgresql://postgres@db.example.com/app?sslmode=prefer&uselibpqcompat=true",
    "postgresql://postgres@db.example.com/app?sslmode=require&uselibpqcompat=true",
    "postgresql://postgres@db.example.com/app?sslmode=verify-ca&uselibpqcompat=true",
    "postgresql://postgres@db.example.com/app?uselibpqcompat=true",
  ];
  for (const [index, target] of targets.entries()) {
    await value.tools
      .get("stateql")
      .execute(
        `insecure-${index}`,
        { command: "connect", target, read_only: true },
        undefined,
        undefined,
        context({ ui }),
      );
  }
  assert.deepEqual(
    order,
    targets.flatMap(() => ["confirm", "password"]),
  );
  assert.match(confirmation, /Allow insecure database TLS/);
  assert.match(confirmation, /weakens or disables TLS certificate or hostname verification/);
});

test("Pylon invalidates brokered PostgreSQL and MySQL passwords after authentication failure", async () => {
  const value = await start();
  const failures = [
    "password authentication failed for user",
    "Access denied for user 'app'@'host' (using password: YES)",
  ];
  let invalidations = 0;
  const ui = {
    async confirm() {
      throw new Error("normal brokered connect should not confirm twice");
    },
    setStatus() {},
    async requestStateQLCredential() {
      throw new Error("full source prompt should not run");
    },
    async requestStateQLPassword() {
      return "wrong";
    },
    invalidateStateQLPassword(request: CredentialRequest) {
      invalidations++;
      assert.match(request.reference, /^PYLON_STATEQL_BROKERED_/);
    },
  };
  value.instances[0].executeImpl = async command => {
    await value.instances[0].options.credentialResolver!({
      reference: String(command.secret_env),
      actorId: "pi-session",
      session: { id: "s_1", name: "workspace" },
      operation: "connect",
      access: "read",
      requestedReadOnly: true,
    });
    return {
      ok: false,
      command_id: "cmd_auth",
      session_id: "s_1",
      error: { code: "CONNECTION_FAILED", message: failures.shift()!, retryable: true, executed: false },
      meta: { duration_ms: 1 },
    };
  };
  for (const [callId, target] of [
    ["postgres-auth", "postgresql://postgres@db.example.com/app"],
    ["mysql-auth", "mysql://app@db.example.com/app"],
  ]) {
    await assert.rejects(
      value.tools
        .get("stateql")
        .execute(callId, { command: "connect", target, read_only: true }, undefined, undefined, context({ ui })),
      /password authentication failed|Access denied for user/,
    );
  }
  assert.equal(invalidations, 2);
});

test("regular Pi leaves username-only server targets unchanged and warns about insecure TLS", async () => {
  const value = await start();
  const target = "postgresql://postgres@db.example.com/app?sslmode=no-verify";
  let confirmation = "";
  const ui = {
    async confirm(_title: string, message: string) {
      confirmation = message;
      return true;
    },
    setStatus() {},
  };
  await value.tools
    .get("stateql")
    .execute("target", { command: "connect", target }, undefined, undefined, context({ ui }));
  assert.equal(value.instances[0].commands[0].target, target);
  assert.equal(value.instances[0].commands[0].secret_env, undefined);
  assert.match(confirmation, /weakens or disables TLS certificate or hostname verification/);
});

test("unknown internal password references fail closed without environment or full-source fallback", async () => {
  const value = await start();
  const reference = `PYLON_STATEQL_BROKERED_${"A".repeat(48)}`;
  const sentinel = "postgresql://postgres:private@evil.example.com/app";
  let credentialCalls = 0;
  let passwordCalls = 0;
  const ui = {
    async confirm() {
      return true;
    },
    setStatus() {},
    async requestStateQLCredential() {
      credentialCalls++;
      return sentinel;
    },
    async requestStateQLPassword() {
      passwordCalls++;
      return "private";
    },
  };
  value.instances[0].executeImpl = async () => {
    const resolved = await value.instances[0].options.credentialResolver!({
      reference,
      actorId: "pi-session",
      session: { id: "s_1", name: "workspace" },
      operation: "query",
      access: "read",
      connection: { id: "c_1", name: "app", driver: "postgres", database: "app", readOnly: true },
    });
    assert.equal(resolved, undefined);
    return { ok: true, command_id: "cmd_unknown", session_id: "s_1", data: {}, warnings: [], meta: { duration_ms: 1 } };
  };
  try {
    process.env[reference] = sentinel;
    await value.tools
      .get("stateql")
      .execute("unknown", { command: "query", sql: "SELECT 1" }, undefined, undefined, context({ ui }));
    assert.equal(credentialCalls, 0);
    assert.equal(passwordCalls, 0);
  } finally {
    delete process.env[reference];
  }
});

test("missing Pylon credential capability fails closed without prompting or fallback", async () => {
  const value = await start();
  const previous = process.env.APP_DATABASE_URL;
  try {
    delete process.env.APP_DATABASE_URL;
    value.instances[0].executeImpl = async () => {
      assert.equal(await value.instances[0].options.credentialResolver!(credentialRequest), undefined);
      return {
        ok: true,
        command_id: "cmd_missing",
        session_id: "s_1",
        data: {},
        warnings: [],
        meta: { duration_ms: 1 },
      };
    };
    await value.tools
      .get("stateql")
      .execute("missing", { command: "query", sql: "SELECT 1" }, undefined, undefined, context());
  } finally {
    if (previous === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = previous;
  }
});

test("executes reads without confirmation and returns compact details", async () => {
  const value = await start();
  let confirmations = 0;
  const ctx = context({
    ui: {
      async confirm() {
        confirmations += 1;
        return true;
      },
      setStatus() {},
    },
  });
  const result = await value.tools
    .get("stateql")
    .execute(
      "call-1",
      { command: "query", sql: "SELECT id FROM users ORDER BY id LIMIT 5", params: [] },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(confirmations, 0);
  assert.deepEqual(value.instances[0].commands, [
    { command: "query", sql: "SELECT id FROM users ORDER BY id LIMIT 5", params: [] },
  ]);
  assert.equal(result.details.commandId, "cmd_1");
  assert.equal("data" in result.details, false);
  assert.match(result.content[0].text, /"ok": true/);
});

test("formats materialized rows as parallel arrays for model output", async () => {
  const value = await start();
  value.instances[0].executeImpl = async command => ({
    ok: true,
    command_id: "cmd_table",
    session_id: "s_1",
    data:
      command.command === "rows"
        ? {
            result_id: "q_1",
            offset: 0,
            limit: 2,
            rows: [
              { id: 1, name: "Ada" },
              { id: 2, name: "Lin" },
            ],
            returned: 2,
            total: 2,
            truncated: false,
            next_offset: null,
          }
        : {
            result_id: "q_1",
            rows: 2,
            columns: [
              { name: "id", type: "integer" },
              { name: "name", type: "text" },
            ],
            preview: [
              { id: 1, name: "Ada" },
              { id: 2, name: "Lin" },
            ],
            preview_count: 2,
            truncated: false,
            cached: false,
            state_version: "v1",
            storage: { mode: "memory", expires_at: "later" },
          },
    warnings: [],
    meta: { duration_ms: 1 },
  });

  const queryResult = await value.tools
    .get("stateql")
    .execute("query", { command: "query", sql: "SELECT id, name FROM users" }, undefined, undefined, context());
  const queryOutput = JSON.parse(queryResult.content[0].text);
  assert.deepEqual(queryOutput.data.columns, ["id", "name"]);
  assert.deepEqual(queryOutput.data.column_types, ["integer", "text"]);
  assert.deepEqual(queryOutput.data.preview, [
    [1, "Ada"],
    [2, "Lin"],
  ]);
  assert.doesNotMatch(queryResult.content[0].text, /"id"\s*:/);

  const rowsResult = await value.tools
    .get("stateql")
    .execute("rows", { command: "rows", handle: "q_1", offset: 0, limit: 2 }, undefined, undefined, context());
  const rowsOutput = JSON.parse(rowsResult.content[0].text);
  assert.deepEqual(rowsOutput.data.columns, ["id", "name"]);
  assert.deepEqual(rowsOutput.data.rows, [
    [1, "Ada"],
    [2, "Lin"],
  ]);
});

test("snapshot bridge is bounded, actor-scoped, and single-claim", async () => {
  const value = await start();
  const handler = value.events.get("pylon:stateql-snapshot-request")![0];
  let claims = 0;
  let response: Promise<StateQLSnapshot> | undefined;
  const request = {
    version: 1,
    sessionId: "pi-session",
    historyLimit: 25,
    claim() {
      claims += 1;
      return claims === 1;
    },
    respond(result: Promise<StateQLSnapshot>) {
      response = result;
    },
  };
  handler(request);
  handler(request);
  assert.ok(response);
  assert.equal((await response).session.name, "shared-workspace");
  assert.equal((await response).actor_id, "pi-session");
  assert.deepEqual(value.instances[0].snapshotCalls, [25]);
  let foreignResponse = false;
  handler({
    ...request,
    sessionId: "other",
    claim: () => true,
    respond: () => {
      foreignResponse = true;
    },
  });
  assert.equal(foreignResponse, false);
});

test("rows bridge forwards bounded actor-scoped requests and only returns data", async () => {
  const value = await start();
  const handler = value.events.get("pylon:stateql-rows-request")![0];
  let response: Promise<unknown> | undefined;
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: 2,
    limit: 10,
    signal: new AbortController().signal,
    claim: () => true,
    respond(result: Promise<unknown>) {
      response = result;
    },
  });
  assert.ok(response);
  assert.deepEqual(await response, { command: "rows" });
  assert.deepEqual(value.instances[0].commands, [{ command: "rows", handle: "result-1", offset: 2, limit: 10 }]);
  let claimed = false;
  handler({
    version: 1,
    sessionId: "other",
    handle: "result-1",
    offset: 0,
    limit: 1,
    claim: () => (claimed = true),
    respond() {},
  });
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "",
    offset: 0,
    limit: 1,
    claim: () => (claimed = true),
    respond() {},
  });
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: -1,
    limit: 1,
    claim: () => (claimed = true),
    respond() {},
  });
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: 0,
    limit: 101,
    claim: () => (claimed = true),
    respond() {},
  });
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: 0,
    limit: 1,
    signal: {},
    claim: () => (claimed = true),
    respond() {},
  });
  assert.equal(claimed, false);
  const cancelled = new AbortController();
  cancelled.abort();
  let cancelledResponse: Promise<unknown> | undefined;
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: 0,
    limit: 1,
    signal: cancelled.signal,
    claim: () => true,
    respond(result: Promise<unknown>) {
      cancelledResponse = result;
    },
  });
  assert.ok(cancelledResponse);
  await assert.rejects(cancelledResponse, /rows request cancelled/);
  assert.equal(value.instances[0].commands.length, 1);
  value.instances[0].executeImpl = async () => ({ ok: false, error: { code: "ROWS_FAILED", message: "no rows" } });
  let failed: Promise<unknown> | undefined;
  handler({
    version: 1,
    sessionId: "pi-session",
    handle: "result-1",
    offset: 0,
    limit: 1,
    claim: () => true,
    respond(result: Promise<unknown>) {
      failed = result;
    },
  });
  assert.ok(failed);
  await assert.rejects(failed, /StateQL ROWS_FAILED/);
  await value.handlers.get("session_shutdown")![0]();
  assert.equal(value.events.get("pylon:stateql-rows-request")?.length, 0);
});

test("confirmed operations fail closed and declined commands do not execute", async () => {
  const value = await start();
  const tool = value.tools.get("stateql");
  let confirmation = "";
  const declined = await tool.execute(
    "call",
    { command: "exec", sql: "DROP TABLE users", replay: true, allow_destructive: true },
    undefined,
    undefined,
    context({
      ui: {
        async confirm(_title: string, message: string) {
          confirmation = message;
          return false;
        },
        setStatus() {},
      },
    }),
  );
  assert.equal(declined.details.declined, true);
  assert.match(confirmation, /replay, destructive operation overrides/);
  assert.equal(value.instances[0].commands.length, 0);
  await assert.rejects(
    tool.execute("call", { command: "transaction.commit" }, undefined, undefined, context({ hasUI: false })),
    /requires interactive confirmation/,
  );
  assert.equal(value.instances[0].commands.length, 0);
});

test("confirmed operations use the Guard timeout only while Guard is enabled", async () => {
  const value = await start();
  const tool = value.tools.get("stateql");
  const dialogOptions: any[] = [];
  const ctx = context({
    ui: {
      async confirm(_title: string, _message: string, options: unknown) {
        dialogOptions.push(options);
        return false;
      },
      setStatus() {},
    },
  });
  const attempt = async (id: string) => {
    const result = await tool.execute(id, { command: "profile.remove", name: "unused" }, undefined, undefined, ctx);
    assert.equal(result.details.declined, true);
    return dialogOptions.at(-1);
  };

  assert.deepEqual(await attempt("default"), { timeout: 0 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "pi-session",
    guardEnabled: true,
    dialogTimeouts: { guard: 90, clarify: 60 },
  });
  assert.deepEqual(await attempt("enabled"), { timeout: 90_000 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "pi-session",
    guardEnabled: true,
    dialogTimeouts: { guard: null, clarify: 60 },
  });
  assert.deepEqual(await attempt("never"), { timeout: 0 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "pi-session",
    guardEnabled: false,
    dialogTimeouts: { guard: 90, clarify: 60 },
  });
  assert.deepEqual(await attempt("disabled"), { timeout: 0 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "other",
    guardEnabled: true,
    dialogTimeouts: { guard: 90, clarify: 60 },
  });
  assert.deepEqual(await attempt("foreign"), { timeout: 0 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    guardEnabled: true,
    dialogTimeouts: { guard: 90, clarify: 60 },
  });
  assert.deepEqual(await attempt("sessionless"), { timeout: 0 });
  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "pi-session",
    guardEnabled: true,
    dialogTimeouts: { guard: 10, clarify: 60 },
  });
  assert.deepEqual(await attempt("malformed"), { timeout: 0 });

  value.events.get("pylon:runtime-policy")![0]({
    version: 2,
    sessionId: "pi-session",
    guardEnabled: true,
    dialogTimeouts: { guard: 90, clarify: 60 },
  });
  await value.handlers.get("session_start")![0]({}, context());
  assert.deepEqual(await attempt("reset"), { timeout: 0 });
});

test("rejects irrelevant, ambiguous, and oversized inputs before StateQL", async () => {
  const value = await start();
  const tool = value.tools.get("stateql");
  for (const [input, message] of [
    [{ command: "status", sql: "SELECT 1" }, /status does not accept sql/],
    [{ command: "inspect", kind: "columns", table: "items", limit: 10 }, /inspect does not accept limit/],
    [{ command: "query", sql: "SELECT 1", read_only: true }, /query does not accept read_only/],
  ] as const) {
    await assert.rejects(tool.execute("call", input, undefined, undefined, context()), message);
  }
  await assert.rejects(
    tool.execute(
      "call",
      { command: "connect", target: " ", secret_env: "APP_DATABASE_URL" },
      undefined,
      undefined,
      context(),
    ),
    /either target or secret_env.*complete database URL or explicit sqlite:<path> source/,
  );
  await assert.rejects(
    tool.execute(
      "call",
      { command: "query", sql: "SELECT ?", params: ["x".repeat(33 * 1024)] },
      undefined,
      undefined,
      context(),
    ),
    /params cannot exceed/,
  );
  assert.equal(value.instances[0].commands.length, 0);
});

test("failures redact credentials and successful output stays within its advertised cap", async () => {
  const value = await start();
  const tool = value.tools.get("stateql");
  value.instances[0].executeImpl = async () => ({
    ok: false,
    command_id: "cmd_error",
    session_id: "s_1",
    error: {
      code: "CONNECTION_FAILED",
      message: "postgres://user:password@example.com/app password=hunter2",
      retryable: true,
      executed: false,
    },
    meta: { duration_ms: 1 },
  });
  await assert.rejects(
    tool.execute("error", { command: "query", sql: "SELECT 1" }, undefined, undefined, context()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /password@example|hunter2/);
      assert.match(error.message, /postgres:\/\/\*\*\*@example\.com/);
      return true;
    },
  );
  value.instances[0].executeImpl = async () => ({
    ok: true,
    command_id: "cmd_large",
    session_id: "s_1",
    data: { rows: "x".repeat(50 * 1024) },
    warnings: [],
    meta: { duration_ms: 1 },
  });
  const result = await tool.execute("large", { command: "query", sql: "SELECT 1" }, undefined, undefined, context());
  assert.equal(result.details.truncated, true);
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 40 * 1024);
});

test("cancellation aborts, replaces the session instance, and permits the next command", async () => {
  const value = await start();
  value.instances[0].executeImpl = async () =>
    new Promise(resolve => {
      value.instances[0].options.signal!.addEventListener(
        "abort",
        () =>
          resolve({
            ok: false,
            command_id: "cmd_2",
            session_id: "s_1",
            error: { code: "OPERATION_CANCELLED", message: "Operation cancelled", retryable: true, executed: false },
            meta: { duration_ms: 1 },
          }),
        { once: true },
      );
    });
  const controller = new AbortController();
  const running = value.tools
    .get("stateql")
    .execute("call", { command: "query", sql: "SELECT 1" }, controller.signal, undefined, context());
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, /OPERATION_CANCELLED/);
  assert.equal(value.instances.length, 2);
  assert.equal(value.instances[0].closed, true);
  assert.equal(value.instances[1].options.signal?.aborted, false);
  const next = await value.tools
    .get("stateql")
    .execute("next", { command: "query", sql: "SELECT 2" }, undefined, undefined, context());
  assert.equal(next.details.commandId, "cmd_1");
  assert.equal(value.instances[1].commands.length, 1);
});

test("snapshot remains available while database work is running", async () => {
  const value = await start();
  let release!: () => void;
  value.instances[0].executeImpl = async () =>
    new Promise(resolve => {
      release = () =>
        resolve({
          ok: true,
          command_id: "cmd_queued",
          session_id: "s_1",
          data: {},
          warnings: [],
          meta: { duration_ms: 1 },
        });
    });
  const running = value.tools
    .get("stateql")
    .execute("query", { command: "query", sql: "SELECT 1" }, undefined, undefined, context());
  await new Promise(resolve => setImmediate(resolve));
  let snapshot: Promise<StateQLSnapshot> | undefined;
  value.events.get("pylon:stateql-snapshot-request")![0]({
    version: 1,
    sessionId: "pi-session",
    historyLimit: 10,
    signal: new AbortController().signal,
    claim: () => true,
    respond(result: Promise<StateQLSnapshot>) {
      snapshot = result;
    },
  });
  assert.ok(snapshot);
  try {
    const result = await Promise.race([
      snapshot,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("snapshot waited for database work")), 100),
      ),
    ]);
    assert.deepEqual(result, baseSnapshot);
    assert.deepEqual(value.instances[0].snapshotCalls, [10]);
  } finally {
    release();
    await running;
  }
});

test("shutdown aborts work, closes StateQL, and unregisters bridges", async () => {
  const value = await start();
  await value.handlers.get("session_shutdown")![0]({}, context());
  assert.equal(value.instances.at(-1)?.closed, true);
  assert.equal(value.events.get("pylon:runtime-policy")?.length, 0);
  assert.equal(value.events.get("pylon:stateql-snapshot-request")?.length, 0);
  assert.equal(value.events.get("pylon:health-request")?.length, 0);
  assert.equal(value.emitted.at(-1)?.value.kind, "unregister");
});

test(
  "real StateQL credential resolution resumes one connect call without leaking the supplied URL",
  { timeout: 15_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-stateql-credential-"));
    const previousHome = process.env.STQL_HOME;
    const previousCredential = process.env.APP_DATABASE_URL;
    const sentinel = "postgres://private:sentinel-password@127.0.0.1:1/app";
    const value = harness(true);
    let resolveCredential!: (value: string) => void;
    let requests = 0;
    const updates: unknown[] = [];
    const ctx = context({
      ui: {
        async confirm() {
          return true;
        },
        setStatus() {},
        async requestStateQLCredential(request: CredentialRequest) {
          requests++;
          assert.equal(request.actorId, "pi-session");
          assert.equal(request.operation, "connect");
          assert.equal(request.access, "read");
          assert.equal(request.requestedReadOnly, true);
          return new Promise<string>(resolve => {
            resolveCredential = resolve;
          });
        },
      },
    });
    process.env.STQL_HOME = home;
    delete process.env.APP_DATABASE_URL;
    try {
      await value.handlers.get("session_start")![0]({}, ctx);
      const running = value.tools
        .get("stateql")
        .execute(
          "credential-connect",
          { command: "connect", secret_env: "APP_DATABASE_URL", read_only: true, timeout_ms: 1_000 },
          undefined,
          (update: unknown) => updates.push(update),
          ctx,
        );
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests, 1);
      resolveCredential(sentinel);
      await assert.rejects(running, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.message.includes("sentinel-password"), false);
        return true;
      });

      let response: Promise<StateQLSnapshot> | undefined;
      value.events.get("pylon:stateql-snapshot-request")![0]({
        version: 1,
        sessionId: "pi-session",
        historyLimit: 10,
        claim: () => true,
        respond(result: Promise<StateQLSnapshot>) {
          response = result;
        },
      });
      assert.ok(response);
      const snapshot = await response;
      assert.equal(snapshot.connection, null);
      assert.equal(JSON.stringify({ updates, snapshot }).includes(sentinel), false);
      const persisted = await persistedText(home);
      assert.equal(persisted.includes(sentinel), false);
      assert.equal(persisted.includes("sentinel-password"), false);
    } finally {
      await value.handlers.get("session_shutdown")![0]({}, ctx);
      if (previousHome === undefined) delete process.env.STQL_HOME;
      else process.env.STQL_HOME = previousHome;
      if (previousCredential === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = previousCredential;
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("rows bridge cannot read a handle outside the actor's linked workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-stateql-isolated-"));
  const previousHome = process.env.STQL_HOME;
  process.env.STQL_HOME = home;
  const owner = new StateQL({ home, session: "owner-workspace" });
  const value = harness(true);
  const ctx = context();
  try {
    await owner.connect(join(home, "owner.sqlite"), { readOnly: false });
    const result = await owner.query("SELECT 1 AS private_value");
    if (!result.ok) throw new Error(result.error.message);
    const handle = String((result.data as { result_id: string }).result_id);
    owner.close();

    await value.handlers.get("session_start")![0]({}, ctx);
    let response: Promise<unknown> | undefined;
    value.events.get("pylon:stateql-rows-request")![0]({
      version: 1,
      sessionId: "pi-session",
      handle,
      offset: 0,
      limit: 10,
      claim: () => true,
      respond(result: Promise<unknown>) {
        response = result;
      },
    });
    assert.ok(response);
    await assert.rejects(response, /RESULT_NOT_FOUND/);
  } finally {
    await value.handlers.get("session_shutdown")![0]({}, ctx);
    owner.close();
    if (previousHome === undefined) delete process.env.STQL_HOME;
    else process.env.STQL_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("real StateQL integration reuses a linked workspace handle", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-stateql-shared-"));
  const previousHome = process.env.STQL_HOME;
  process.env.STQL_HOME = home;
  const owner = new StateQL({ home, session: "shared-workspace" });
  const database = join(home, "shared.sqlite");
  const value = harness(true);
  const ctx = context();
  try {
    await owner.connect(database, { readOnly: false });
    await owner.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    const result = await owner.query("SELECT id, name FROM users ORDER BY id LIMIT 5");
    if (!result.ok) throw new Error(result.error.message);
    const handle = String((result.data as { result_id: string }).result_id);
    await owner.setAlias("users", handle);
    await owner.linkActor("shared-workspace", "pi-session");
    owner.close();

    await value.handlers.get("session_start")![0]({}, ctx);
    const shown = await value.tools
      .get("stateql")
      .execute("show", { command: "show", handle: "users" }, undefined, undefined, ctx);
    assert.match(shown.content[0].text, new RegExp(handle));

    let response: Promise<StateQLSnapshot> | undefined;
    value.events.get("pylon:stateql-snapshot-request")![0]({
      version: 1,
      sessionId: "pi-session",
      historyLimit: 10,
      claim: () => true,
      respond(result: Promise<StateQLSnapshot>) {
        response = result;
      },
    });
    assert.ok(response);
    assert.equal((await response).session.name, "shared-workspace");
    assert.equal((await response).actor_id, "pi-session");
  } finally {
    await value.handlers.get("session_shutdown")![0]({}, ctx);
    if (previousHome === undefined) delete process.env.STQL_HOME;
    else process.env.STQL_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("real StateQL integration persists commands and exposes bounded SQL snapshot history", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-stateql-integration-"));
  const previousHome = process.env.STQL_HOME;
  process.env.STQL_HOME = home;
  const value = harness(true);
  const ctx = context();
  try {
    await value.handlers.get("session_start")![0]({}, ctx);
    const tool = value.tools.get("stateql");
    const database = join(home, "app.sqlite");
    await tool.execute(
      "connect",
      { command: "connect", target: database, read_only: false },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "create",
      { command: "exec", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)", allow_destructive: true },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "query",
      { command: "query", sql: "SELECT id, name FROM users ORDER BY id LIMIT 5" },
      undefined,
      undefined,
      ctx,
    );
    const doctor = await tool.execute("doctor", { command: "doctor" }, undefined, undefined, ctx);
    assert.match(doctor.content[0].text, /"integrity": "ok"/);
    assert.match(doctor.content[0].text, /"initial_schema_v1"/);

    let response: Promise<StateQLSnapshot> | undefined;
    value.events.get("pylon:stateql-snapshot-request")![0]({
      version: 1,
      sessionId: "pi-session",
      historyLimit: 10,
      claim: () => true,
      respond(result: Promise<StateQLSnapshot>) {
        response = result;
      },
    });
    assert.ok(response);
    const first = await response;
    assert.deepEqual(
      first.history.map(entry => entry.command),
      ["doctor", "query", "exec", "connect"],
    );
    assert.equal(
      first.history.find(entry => entry.command === "query")?.sql,
      "SELECT id, name FROM users ORDER BY id LIMIT 5",
    );
    assert.equal(
      first.history.find(entry => entry.command === "exec")?.sql,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
    );
    assert.equal(first.history.find(entry => entry.command === "doctor")?.sql, null);
    assert.equal(first.history.find(entry => entry.command === "connect")?.sql, null);
    const before = JSON.stringify(first);

    let repeated: Promise<StateQLSnapshot> | undefined;
    value.events.get("pylon:stateql-snapshot-request")![0]({
      version: 1,
      sessionId: "pi-session",
      historyLimit: 10,
      claim: () => true,
      respond(result: Promise<StateQLSnapshot>) {
        repeated = result;
      },
    });
    assert.ok(repeated);
    assert.equal(JSON.stringify(await repeated), before);
  } finally {
    await value.handlers.get("session_shutdown")![0]({}, ctx);
    if (previousHome === undefined) delete process.env.STQL_HOME;
    else process.env.STQL_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateQL } from "@fadhilp/stateql";
import stateqlExtension from "../../../packages/pi-stateql/extensions/pi-stateql.ts";
import { databasePasswordSubmission } from "../src/client/database/database-password-submission.ts";
import { OsStateQLCredentialVault } from "../src/server/database/stateql-credential-vault.ts";
import { RemoteUiBridge, type UiRequest } from "../src/server/runtime/remote-ui-bridge.ts";

// These are driver-boundary integration tests: pg is intercepted before it can open a socket.
const { Client } = createRequire(import.meta.resolve("@fadhilp/stateql"))("pg");
const ACTOR = "setup-browser-session";
const GENERATION = 17;

type AnyRecord = Record<string, any>;

function memoryKeyring(values = new Map<string, string>()) {
  return {
    values,
    entry: (service: string, account: string) => ({
      async setPassword(value: string) {
        values.set(`${service}\0${account}`, value);
      },
      async getPassword() {
        return values.get(`${service}\0${account}`);
      },
      async deleteCredential() {
        return values.delete(`${service}\0${account}`);
      },
    }),
  };
}

function extensionHarness(home: string) {
  const handlers = new Map<string, Function[]>();
  const events = new Map<string, Function[]>();
  const instances: any[] = [];
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
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
        for (const handler of events.get(name) ?? []) handler(value);
      },
    },
    registerTool() {},
  };
  stateqlExtension(pi as any, {
    // Keep StateQL's real actor/session persistence, but isolate its sqlite state per test.
    createStateQL(options: any) {
      const stateql = (StateQL as any).forActor({ ...options, home });
      instances.push(stateql);
      return stateql;
    },
  });
  const context = {
    hasUI: true,
    sessionManager: { getSessionId: () => ACTOR },
    ui: {
      async confirm() {
        return true;
      },
      setStatus() {},
    },
  };
  return {
    instances,
    async start() {
      await handlers.get("session_start")![0]!({}, context);
    },
    async stop() {
      await handlers.get("session_shutdown")?.[0]?.({}, context);
    },
    command(command: AnyRecord, ui: unknown, operationId: string, signal: AbortSignal = new AbortController().signal) {
      let response: Promise<any> | undefined;
      let claimed = false;
      for (const handler of events.get("pylon:stateql-command-request") ?? []) {
        handler({
          version: 1,
          sessionId: ACTOR,
          command,
          ui,
          operationId,
          signal,
          claim() {
            if (claimed) return false;
            claimed = true;
            return true;
          },
          respond(value: Promise<any>) {
            response = value;
          },
        });
      }
      assert.ok(response, "the real stateql extension must claim parser-valid panel commands");
      return response;
    },
    snapshot() {
      let response: Promise<any> | undefined;
      for (const handler of events.get("pylon:stateql-snapshot-request") ?? []) {
        handler({
          version: 1,
          sessionId: ACTOR,
          historyLimit: 30,
          claim: () => true,
          respond(value: Promise<any>) {
            response = value;
          },
        });
      }
      assert.ok(response);
      return response;
    },
  };
}

/** Use the actual browser password-submission helper to answer only secure password dialogs. */
function browserUi(
  vault: OsStateQLCredentialVault,
  passwords: string[],
  options: { confirm?: boolean; formTarget?: string } = {},
) {
  const requests: UiRequest[] = [];
  let bridge!: RemoteUiBridge;
  bridge = new RemoteUiBridge(request => {
    requests.push(structuredClone(request));
    if (request.method === "confirm") {
      queueMicrotask(() =>
        bridge.answer({
          requestId: request.requestId,
          sessionGeneration: GENERATION,
          method: "confirm",
          confirmed: options.confirm ?? true,
        }),
      );
      return;
    }
    if (request.method !== "input" || request.payload.credentialKind !== "password") return;
    const password = passwords.shift();
    assert.notEqual(password, undefined, "a password dialog was not expected");
    const form = databasePasswordSubmission(password!, {
      target:
        options.formTarget ??
        `postgres://${String(request.payload.username)}@${String(request.payload.hostname)}:${String(request.payload.port)}/${String(request.payload.database)}`,
      operationId: String(request.operationId),
      generation: GENERATION,
      readOnly: request.payload.access === "read",
    });
    const readModel = {
      ...request,
      owned: true,
      payload: { ...request.payload, sessionGeneration: request.sessionGeneration },
    } as any;
    void form.answer(readModel, async (_request, body) => {
      bridge.answer({ requestId: request.requestId, sessionGeneration: GENERATION, method: "input", ...body });
    });
  }, 0);
  bridge.setStateQLCredentialVault(vault);
  // The panel handler receives this exact database-scoped, operation-scoped context.
  return { bridge, ui: (operationId: string) => bridge.context(ACTOR, GENERATION, "database", operationId), requests };
}

function passwordRequests(requests: UiRequest[]) {
  return requests.filter(request => request.method === "input" && request.payload.credentialKind === "password");
}

function assertNoSecret(secret: string, value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(secret), false, "secret must not be published in UI/event state");
  assert.equal(text.includes(encodeURIComponent(secret)), false, "encoded secret must not be published either");
}

async function rawFiles(root: string): Promise<Buffer[]> {
  const output: Buffer[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(await readFile(path));
    }
  };
  await visit(root);
  return output;
}

function installPgBoundary(behaviour: (parameters: AnyRecord) => Error | undefined) {
  const original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end };
  const connections: AnyRecord[] = [];
  Client.prototype.connect = async function (this: any) {
    // pg intentionally makes its password non-enumerable; capture it explicitly at the driver boundary.
    const parameters = { ...structuredClone(this.connectionParameters), password: this.connectionParameters.password };
    connections.push(parameters);
    const failure = behaviour(parameters);
    if (failure) throw failure;
  };
  Client.prototype.query = async function (query: any) {
    const text = typeof query === "string" ? query : (query?.text ?? "");
    if (/select/i.test(text))
      return { command: "SELECT", rowCount: 1, rows: [{ answer: 1 }], fields: [{ name: "answer", dataTypeID: 23 }] };
    return { command: "SET", rowCount: 0, rows: [], fields: [] };
  };
  Client.prototype.end = async function () {};
  return {
    connections,
    restore() {
      Client.prototype.connect = original.connect;
      Client.prototype.query = original.query;
      Client.prototype.end = original.end;
    },
  };
}

async function show(harness: ReturnType<typeof extensionHarness>, ui: unknown, name: string) {
  const response = await harness.command({ command: "profile.show", name }, ui, `show-${name}`);
  assert.equal(response.ok, true);
  return response.data as AnyRecord;
}

test("driver-boundary setup saves a password_ref only after real pg connect", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pylon-database-setup-"));
  const ca = join(home, "test-ca.pem");
  const secret = "p%@:/# Ü";
  const keyring = memoryKeyring();
  const vault = new OsStateQLCredentialVault(keyring.entry);
  const target = `postgres://ada@db.example.test:5432/app?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`;
  const ui = browserUi(vault, [secret], { formTarget: target });
  const pg = installPgBoundary(() => undefined);
  const harness = extensionHarness(home);
  try {
    await writeFile(ca, "temporary test CA contents");
    await harness.start();
    const result = await harness.command(
      {
        command: "connection.setup",
        action: "save-connect",
        name: "app",
        target,
        read_only: true,
        remember: true,
        password_provided: true,
      },
      ui.ui("save-connect"),
      "save-connect",
    );
    assert.deepEqual(result.data.setup, { connected: true, saved: true, stage: "complete" });
    assert.equal(passwordRequests(ui.requests).length, 1);
    assert.equal(pg.connections.length, 1);
    assert.equal(pg.connections[0].password, secret);
    assert.equal(pg.connections[0].ssl.ca, "temporary test CA contents");
    assert.notEqual(pg.connections[0].ssl.rejectUnauthorized, false);

    const profile = await show(harness, ui.ui("show-app"), "app");
    assert.equal(profile.target, target);
    assert.equal(typeof profile.password_ref, "string");
    assert.equal(JSON.stringify(profile).includes(secret), false);
    const record = JSON.parse(keyring.values.get(`works.earendil.pylon.stateql\0${profile.password_ref}`) ?? "{}");
    assert.deepEqual(Object.keys(record).sort(), ["fingerprint", "password", "version"]);
    assert.equal(record.version, 2);
    assert.equal(record.password, secret);
    assert.equal(JSON.stringify(record).includes(target), false);

    const query = await harness.command(
      { command: "query", sql: "SELECT 1 AS answer", cache: "bypass" },
      ui.ui("query"),
      "query",
    );
    assert.equal(query.ok, true, "the connected real StateQL instance can resolve a query through pg");
    await harness.command({ command: "disconnect" }, ui.ui("disconnect-app"), "disconnect-app");
    const reconnect = await harness.command(
      { command: "connect", profile: "app" },
      ui.ui("reconnect-app"),
      "reconnect-app",
    );
    assert.equal(reconnect.ok, true);
    assert.equal(
      passwordRequests(ui.requests).length,
      1,
      "a saved profile must resolve its durable vault password without another browser prompt",
    );
    const laterQuery = await harness.command(
      { command: "query", sql: "SELECT 1 AS answer", cache: "bypass" },
      ui.ui("later-query"),
      "later-query",
    );
    assert.equal(laterQuery.ok, true, "later operations must not depend on a deleted transient credential reference");
    const snapshot = await harness.snapshot();
    assertNoSecret(secret, { requests: ui.requests, profile, snapshot, query });
  } finally {
    await harness.stop();
    pg.restore();
    // Check persisted StateQL sqlite/raw state only after close; never inspect user table data.
    const raw = await rawFiles(home);
    assert.equal(
      raw.some(file => file.includes(Buffer.from(secret))),
      false,
    );
    await rm(home, { recursive: true, force: true });
  }
});

test("AWS RDS preset persists portably and reconnects with the packaged verified CA", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pylon-database-rds-ca-"));
  const secret = "rds-password";
  const vault = new OsStateQLCredentialVault(memoryKeyring().entry);
  const target = "postgresql://ada@rds.example.test/app?sslmode=verify-full&pylon_tls_ca=aws-rds";
  const ui = browserUi(vault, [secret], { formTarget: target });
  const pg = installPgBoundary(() => undefined);
  const harness = extensionHarness(home);
  try {
    await harness.start();
    const result = await harness.command(
      {
        command: "connection.setup",
        action: "save-connect",
        name: "rds",
        target,
        read_only: true,
        remember: true,
        password_provided: true,
      },
      ui.ui("save-rds"),
      "save-rds",
    );
    assert.equal(result.ok, true);
    assert.match(pg.connections[0].ssl.ca, /-----BEGIN CERTIFICATE-----/u);
    assert.notEqual(pg.connections[0].ssl.rejectUnauthorized, false);
    const profile = await show(harness, ui.ui("show-rds"), "rds");
    assert.equal(profile.target, target, "the profile keeps the portable preset rather than an install path");
    await harness.command({ command: "disconnect" }, ui.ui("disconnect-rds"), "disconnect-rds");
    const reconnect = await harness.command(
      { command: "connect", profile: "rds" },
      ui.ui("reconnect-rds"),
      "reconnect-rds",
    );
    assert.equal(reconnect.ok, true);
    assert.equal(passwordRequests(ui.requests).length, 1);
    assert.match(pg.connections.at(-1)?.ssl.ca, /-----BEGIN CERTIFICATE-----/u);
    assert.notEqual(pg.connections.at(-1)?.ssl.rejectUnauthorized, false);
  } finally {
    await harness.stop();
    pg.restore();
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "driver-boundary setup rejects TLS downgrade/trust failures and reuses the secure in-memory password",
  { timeout: 20_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pylon-database-tls-"));
    const ca = join(home, "retry-ca.pem");
    const vault = new OsStateQLCredentialVault(memoryKeyring().entry);
    const ui = browserUi(vault, ["retry-secret"]);
    const pg = installPgBoundary(parameters => {
      if (parameters.ssl === false) return new Error("pg_hba.conf requires SSL; no encryption is permitted");
      if (!parameters.ssl?.ca) return new Error("unable to verify the first certificate");
      return undefined;
    });
    const harness = extensionHarness(home);
    const off = "postgres://ada@tls.example.test/app?sslmode=disable";
    const verifiedWithoutCa = "postgres://ada@tls.example.test/app?sslmode=verify-full";
    const verified = `${verifiedWithoutCa}&sslrootcert=${encodeURIComponent(ca)}`;
    try {
      await writeFile(ca, "retry CA");
      await harness.start();
      const noEncryption = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "off",
          target: off,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        ui.ui("tls-off"),
        "tls-off",
      );
      assert.equal(noEncryption.ok, false);
      assert.equal(noEncryption.error.code, "TLS_REQUIRED");
      const noTrust = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "missing-ca",
          target: verifiedWithoutCa,
          read_only: true,
          remember: true,
          password_provided: false,
        },
        ui.ui("tls-missing-ca"),
        "tls-missing-ca",
      );
      assert.equal(noTrust.ok, false);
      assert.equal(noTrust.error.code, "TLS_TRUST_FAILED");
      await assert.rejects(show(harness, ui.ui("show-off"), "off"));
      await assert.rejects(show(harness, ui.ui("show-missing"), "missing-ca"));

      const retry = await harness.command(
        { command: "connection.setup", action: "connect", target: verified, read_only: true, password_provided: false },
        ui.ui("tls-retry"),
        "tls-retry",
      );
      assert.equal(retry.ok, true);
      assert.equal(
        passwordRequests(ui.requests).length,
        1,
        "TLS-only retries reuse the destination-bound memory password",
      );
      assert.equal(pg.connections.at(-1)?.ssl.ca, "retry CA");
      assert.notEqual(pg.connections.at(-1)?.ssl.rejectUnauthorized, false);
      assert.equal(pg.connections[0]?.ssl, false);
    } finally {
      await harness.stop();
      pg.restore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "driver-boundary setup uses only a legacy profile password when explicit TLS overrides it",
  { timeout: 20_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pylon-database-legacy-"));
    const ca = join(home, "override-ca.pem");
    const keyring = memoryKeyring();
    const vault = new OsStateQLCredentialVault(keyring.entry);
    const ui = browserUi(vault, []);
    const pg = installPgBoundary(() => undefined);
    const harness = extensionHarness(home);
    const oldTarget = "postgres://ada@legacy.example.test/app?sslmode=disable";
    const explicit = `postgres://ada@legacy.example.test/app?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`;
    try {
      await writeFile(ca, "override CA");
      await harness.start();
      // Seed a real StateQL profile and an intentionally legacy v1 vault record.
      const reference = "pylon:stateql:v1:11111111-1111-4111-8111-111111111111";
      assert.equal(
        await vault.save(
          reference,
          oldTarget,
          "postgres://ada:legacy-password@legacy.example.test/app?sslmode=disable",
        ),
        true,
      );
      const stateql = harness.instances[0];
      const added = await stateql.executeCommand({
        command: "profile.add",
        name: "legacy",
        credential_ref: reference,
        read_only: true,
      });
      assert.equal(added.ok, true);

      const result = await harness.command(
        {
          command: "connection.setup",
          action: "connect",
          name: "legacy",
          update: true,
          target: explicit,
          read_only: true,
          password_provided: false,
        },
        ui.ui("legacy-override"),
        "legacy-override",
      );
      assert.equal(result.ok, true);
      assert.equal(
        passwordRequests(ui.requests).length,
        0,
        "legacy vault resolution must not expose a password prompt",
      );
      assert.equal(pg.connections.at(-1)?.password, "legacy-password");
      assert.equal(pg.connections.at(-1)?.ssl.ca, "override CA");
      assert.notEqual(pg.connections.at(-1)?.ssl.rejectUnauthorized, false);
      const profile = await show(harness, ui.ui("show-legacy"), "legacy");
      assert.equal(profile.credential_ref, reference, "connect-only leaves the legacy profile reference untouched");
      assert.equal(profile.target, null);
      const environment = "PYLON_SETUP_LEGACY_URL";
      const previousEnvironment = process.env[environment];
      process.env[environment] = "postgres://ada:environment-password@legacy.example.test/app?sslmode=require";
      try {
        const environmentProfile = await stateql.executeCommand({
          command: "profile.add",
          name: "legacy-env",
          secret_env: environment,
          read_only: true,
        });
        assert.equal(environmentProfile.ok, true);
        const environmentConnect = await harness.command(
          { command: "connection.setup", action: "connect", profile: "legacy-env", read_only: true },
          ui.ui("legacy-environment"),
          "legacy-environment",
        );
        assert.equal(environmentConnect.ok, true, "existing secret_env profile sources remain usable");
        assert.equal(pg.connections.at(-1)?.password, "environment-password");
      } finally {
        if (previousEnvironment === undefined) delete process.env[environment];
        else process.env[environment] = previousEnvironment;
      }
    } finally {
      await harness.stop();
      pg.restore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "driver-boundary setup reports save-only failure, rolls back its fresh vault ref, and retries save without reconnecting",
  { timeout: 20_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pylon-database-save-failure-"));
    const keyring = memoryKeyring();
    const vault = new OsStateQLCredentialVault(keyring.entry);
    const ui = browserUi(vault, ["first", "second"]);
    const pg = installPgBoundary(() => undefined);
    const harness = extensionHarness(home);
    const original = "postgres://ada@save.example.test/original?sslmode=require";
    const replacement = "postgres://ada@save.example.test/replacement?sslmode=require";
    try {
      await harness.start();
      const first = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "duplicate",
          target: original,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        ui.ui("initial-save"),
        "initial-save",
      );
      assert.equal(first.ok, true);
      const before = await show(harness, ui.ui("show-before"), "duplicate");
      const vaultEntries = keyring.values.size;

      const failed = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "duplicate",
          target: replacement,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        ui.ui("duplicate-save"),
        "duplicate-save",
      );
      assert.equal(failed.ok, true);
      assert.equal(failed.data.setup.connected, true);
      assert.equal(failed.data.setup.saved, false);
      assert.match(failed.data.setup.error.message, /Connected, but saving failed/);
      assert.equal(
        (await show(harness, ui.ui("show-after"), "duplicate")).target,
        before.target,
        "previous profile is untouched",
      );
      assert.equal(
        keyring.values.size,
        vaultEntries,
        "the newly-created password ref is forgotten after profile save failure",
      );

      const connects = pg.connections.length;
      const saved = await harness.command(
        {
          command: "connection.setup",
          action: "save",
          name: "retry",
          target: replacement,
          read_only: true,
          remember: true,
          password_provided: false,
        },
        ui.ui("retry-save"),
        "retry-save",
      );
      assert.equal(saved.ok, true);
      assert.equal(saved.data.setup.connected, false);
      assert.equal(saved.data.setup.saved, true);
      assert.equal(pg.connections.length, connects, "save retry does not make another driver connection");

      const settingsUi = browserUi(vault, ["must-not-be-submitted"]);
      const beforeSettings = keyring.values.size;
      const settingsOnly = await harness.command(
        {
          command: "connection.setup",
          action: "save",
          name: "untested",
          target: original,
          read_only: true,
          remember: false,
          password_provided: true,
        },
        settingsUi.ui("settings-only"),
        "settings-only",
      );
      assert.equal(settingsOnly.ok, true);
      assert.equal(settingsOnly.data.setup.saved, true);
      assert.equal(pg.connections.length, connects);
      assert.equal(passwordRequests(settingsUi.requests).length, 0);
      assert.equal(keyring.values.size, beforeSettings);
      assert.equal((await show(harness, settingsUi.ui("show-settings"), "untested")).password_ref, null);

      const capability = Object.getOwnPropertyDescriptor(StateQL, "passwordReferenceVersion")!;
      Object.defineProperty(StateQL, "passwordReferenceVersion", { ...capability, value: undefined });
      try {
        await assert.rejects(
          harness.command(
            {
              command: "connection.setup",
              action: "save-connect",
              name: "unsupported",
              target: original,
              read_only: true,
            },
            settingsUi.ui("unsupported"),
            "unsupported",
          ),
          /requires the updated StateQL/,
        );
        assert.equal(pg.connections.length, connects);
        assert.equal(keyring.values.size, beforeSettings);
      } finally {
        Object.defineProperty(StateQL, "passwordReferenceVersion", capability);
      }
    } finally {
      await harness.stop();
      pg.restore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "driver-boundary setup declines without effects and invalidates stale cached/vault authentication",
  { timeout: 20_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pylon-database-auth-"));
    const keyring = memoryKeyring();
    const vault = new OsStateQLCredentialVault(keyring.entry);
    const pg = installPgBoundary(parameters =>
      parameters.password === "bad" ? new Error("password authentication failed for user ada") : undefined,
    );
    const harness = extensionHarness(home);
    const target = "postgres://ada@auth.example.test/app?sslmode=require";
    try {
      await harness.start();
      const cancelled = new AbortController();
      cancelled.abort();
      const cancelledResult = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "aborted",
          target,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        browserUi(vault, []).ui("aborted"),
        "aborted",
        cancelled.signal,
      );
      assert.equal(cancelledResult.ok, false);
      assert.equal(cancelledResult.error.code, "CANCELLED");
      assert.equal(pg.connections.length, 0);
      await assert.rejects(show(harness, browserUi(vault, []).ui("show-aborted"), "aborted"));

      const declinedUi = browserUi(vault, [], { confirm: false });
      const declined = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "cancelled",
          target,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        declinedUi.ui("declined"),
        "declined",
      );
      assert.deepEqual(declined, { declined: true });
      assert.equal(pg.connections.length, 0);
      await assert.rejects(show(harness, declinedUi.ui("show-cancelled"), "cancelled"));

      const initialUi = browserUi(vault, ["good"]);
      const initial = await harness.command(
        {
          command: "connection.setup",
          action: "save-connect",
          name: "auth",
          target,
          read_only: true,
          remember: true,
          password_provided: true,
        },
        initialUi.ui("auth-initial"),
        "auth-initial",
      );
      assert.equal(initial.ok, true);
      const profile = await show(harness, initialUi.ui("show-auth"), "auth");
      await vault.savePassword!(profile.password_ref, target, "bad");

      // A fresh bridge prevents the prior good in-memory value from masking the stale vault value.
      const authUi = browserUi(vault, ["new-good"]);
      const rejected = await harness.command(
        { command: "connect", profile: "auth", read_only: true },
        authUi.ui("auth-rejected"),
        "auth-rejected",
      );
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "CONNECTION_FAILED");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(
        await vault.resolvePassword!(profile.password_ref, target),
        undefined,
        "auth failure invalidates the v2 vault password",
      );

      const repaired = await harness.command(
        {
          command: "connection.setup",
          action: "connect",
          name: "auth",
          update: true,
          target,
          read_only: true,
          password_provided: true,
        },
        authUi.ui("auth-repaired"),
        "auth-repaired",
      );
      assert.equal(repaired.ok, true);
      assert.equal(pg.connections.at(-1)?.password, "new-good");
      assert.equal(passwordRequests(authUi.requests).length, 1);
      assertNoSecret("new-good", { requests: authUi.requests, rejected, repaired });
    } finally {
      await harness.stop();
      pg.restore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

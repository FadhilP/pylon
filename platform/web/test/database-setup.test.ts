import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSetupError, postgresTlsTarget, submitDatabaseSetup } from "../src/client/database/database-setup.ts";
import { materializeConnectionTarget } from "../../../packages/pi-stateql/src/connection-setup.ts";
import type { StateQLCommandInput } from "../src/shared/protocol/snapshots.ts";

const { Client } = createRequire(import.meta.resolve("@fadhilp/stateql"))("pg");
const input: StateQLCommandInput = {
  command: "connection.setup",
  action: "save-connect",
  name: "example",
  target: "postgres://dbuser@localhost/app?sslmode=verify-full",
  read_only: true,
};

test("explicit PostgreSQL TLS removes downgrade switches while preserving saved targets and unrelated options", () => {
  const saved =
    "postgresql://dbuser@localhost/app?sslmode=require&sslmode=no-verify&ssl=0&rejectUnauthorized=false&uselibpqcompat=true&sslnegotiation=direct&application_name=sample";
  assert.equal(postgresTlsTarget(saved, "preserve"), saved);
  const verified = postgresTlsTarget(saved, "verify-full");
  const client = new Client({ connectionString: verified });
  assert.ok(client.connectionParameters.ssl);
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.equal(client.connectionParameters.ssl.checkServerIdentity, undefined);
  assert.equal(client.connectionParameters.application_name, "sample");
  assert.deepEqual(new URL(verified).searchParams.getAll("sslmode"), ["verify-full"]);
  assert.equal(new Client({ connectionString: postgresTlsTarget(saved, "disable") }).connectionParameters.ssl, false);
  const certificateTarget = postgresTlsTarget(
    `${saved}&sslrootcert=%2Fserver%2Fca.pem&sslcert=%2Fserver%2Fclient.pem`,
    "verify-full",
  );
  assert.equal(new URL(certificateTarget).searchParams.get("sslrootcert"), "/server/ca.pem");
  assert.equal(new URL(certificateTarget).searchParams.get("sslcert"), "/server/client.pem");
  assert.equal(postgresTlsTarget("rediss://localhost/0", "verify-full"), "rediss://localhost/0");
});

test("AWS RDS preset materializes the packaged bundle with verified TLS and rejects conflicts", () => {
  const semantic = postgresTlsTarget(
    "postgresql://dbuser@db.example.com/app?sslmode=disable&sslrootcert=old.pem",
    "verify-full",
    "",
    "aws-rds",
  );
  const saved = new URL(semantic);
  assert.equal(saved.searchParams.get("pylon_tls_ca"), "aws-rds");
  assert.equal(saved.searchParams.has("sslrootcert"), false);
  const materialized = materializeConnectionTarget(semantic);
  const effective = new URL(materialized);
  assert.equal(effective.searchParams.has("pylon_tls_ca"), false);
  assert.equal(effective.searchParams.get("sslmode"), "verify-full");
  assert.match(effective.searchParams.get("sslrootcert") ?? "", /global-bundle\.pem$/u);
  const client = new Client({ connectionString: materialized });
  assert.match(client.connectionParameters.ssl.ca, /-----BEGIN CERTIFICATE-----/u);
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.throws(
    () => materializeConnectionTarget(`${semantic}&sslrootcert=other.pem`),
    /cannot be combined/,
  );
  assert.throws(
    () => materializeConnectionTarget(semantic.replace("aws-rds", "unknown")),
    /Unsupported PostgreSQL CA preset/,
  );
});

test("CA path edits reach the driver intact, replace duplicates, and can be cleared without dropping other options", async t => {
  const directory = await mkdtemp(join(tmpdir(), "stateql-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "test CA #1.pem");
  await writeFile(file, "test CA contents");
  const saved =
    "postgres://dbuser@localhost/app?sslmode=no-verify&sslrootcert=old&sslrootcert=older&application_name=test";
  const target = postgresTlsTarget(saved, "verify-full", file);
  const client = new Client({ connectionString: target });
  assert.equal(client.connectionParameters.ssl.ca, "test CA contents");
  assert.notEqual(client.connectionParameters.ssl.rejectUnauthorized, false);
  assert.equal(client.connectionParameters.ssl.checkServerIdentity, undefined);
  assert.equal(client.connectionParameters.application_name, "test");
  assert.deepEqual(new URL(target).searchParams.getAll("sslrootcert"), [file]);
  const cleared = postgresTlsTarget(target, "preserve", "");
  assert.equal(new URL(cleared).searchParams.has("sslrootcert"), false);
  assert.equal(new URL(cleared).searchParams.get("sslmode"), "verify-full");
  assert.throws(
    () => new Client({ connectionString: postgresTlsTarget(target, "verify-full", join(directory, "missing.pem")) }),
    /ENOENT/,
  );
  // Disabled TLS must not even read stale certificate paths retained by an edited profile.
  const disabled = postgresTlsTarget(
    `${target}&sslcert=missing-client.pem&sslkey=missing-key.pem`,
    "disable",
    join(directory, "missing.pem"),
  );
  assert.equal(new Client({ connectionString: disabled }).connectionParameters.ssl, false);
  for (const path of ["bad\u0000path", "bad\npath", "x".repeat(4097)])
    assert.throws(() => postgresTlsTarget(saved, "verify-full", path), /CA certificate file path/);
});

test(
  "verified PostgreSQL connections negotiate TLS and reject a plaintext-only server without fallback",
  { timeout: 5000 },
  async () => {
    const received: Buffer[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      let bytes = 0;
      socket.on("data", chunk => {
        received.push(chunk);
        bytes += chunk.length;
        if (bytes === 8) socket.write("N"); // PostgreSQL SSLRequest refused.
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client({
      connectionString: postgresTlsTarget(`postgres://dbuser@127.0.0.1:${address.port}/app`, "verify-full"),
      connectionTimeoutMillis: 2000,
    });
    try {
      await assert.rejects(client.connect(), /does not support SSL/);
      const packet = Buffer.concat(received);
      assert.equal(packet.length, 8, "must not send a plaintext startup or authentication packet");
      assert.equal(packet.readInt32BE(0), 8);
      assert.equal(packet.readInt32BE(4), 80877103);
    } finally {
      await client.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
);

test("setup submits one atomic command and refreshes profiles after it settles", async () => {
  const commands: StateQLCommandInput[] = [];
  let refreshes = 0;
  let release!: () => void;
  let releaseRefresh!: () => void;
  let complete = false;
  const settled = new Promise<void>(resolve => {
    release = resolve;
  });
  const refreshSettled = new Promise<void>(resolve => {
    releaseRefresh = resolve;
  });
  const operation = submitDatabaseSetup(
    input,
    async command => {
      commands.push(command);
      await settled;
    },
    async () => {
      refreshes++;
      await refreshSettled;
    },
  ).then(() => {
    complete = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands, [input]);
  assert.equal(refreshes, 0, "discovery must not compete for the active command slot");
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(complete, false, "setup completion must wait until the refreshed profile list is applied");
  releaseRefresh();
  await operation;
  assert.equal(complete, true);
});

test("partial setup errors retain the connected state for retry-saving", () => {
  const error = new DatabaseSetupError("Vault write failed", true);
  assert.equal(error.message, "Vault write failed");
  assert.equal(error.connected, true);
});

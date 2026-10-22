import assert from "node:assert/strict";
import test from "node:test";
import { parseStateQLPanelCommand } from "../src/stateql-command.ts";

test("accepts bounded catalog and Redis contracts", () => {
  assert.deepEqual(
    parseStateQLPanelCommand({ command: "objects.list", kind: "table", search: "users", offset: "42", limit: 100 }),
    { command: "objects.list", kind: "table", search: "users", offset: "42", limit: 100 },
  );
  assert.ok(parseStateQLPanelCommand({ command: "object.describe", object: { kind: "key", name: "cache:user" } }));
  assert.ok(
    parseStateQLPanelCommand({ command: "redis.exec", redis: { command: "SET", args: ["cache:user", "value"] } }),
  );
});

test("accepts MongoDB counts, distinct values, explain, and index changes", () => {
  for (const mongo of [
    { operation: "countDocuments", collection: "users", filter: { active: true }, options: { limit: 10 } },
    { operation: "distinct", collection: "users", field: "status", filter: { active: true } },
    { operation: "find", collection: "users", explain: "executionStats" },
  ]) {
    assert.ok(parseStateQLPanelCommand({ command: "mongo.query", mongo }), mongo.operation);
  }
  for (const mongo of [
    { operation: "createIndex", collection: "users", keys: { email: 1 }, options: { unique: true, name: "email_1" } },
    { operation: "dropIndex", collection: "users", index: "email_1" },
  ]) {
    assert.ok(parseStateQLPanelCommand({ command: "mongo.exec", mongo }), mongo.operation);
  }
  for (const mongo of [
    { operation: "countDocuments", collection: "users", options: { sort: { a: 1 } } },
    { operation: "distinct", collection: "users", field: "$status" },
    { operation: "find", collection: "users", explain: "verbose" },
  ]) {
    assert.equal(parseStateQLPanelCommand({ command: "mongo.query", mongo }), undefined, JSON.stringify(mongo));
  }
  for (const mongo of [
    { operation: "createIndex", collection: "users", keys: { email: 2 } },
    { operation: "dropIndex", collection: "users", index: "*" },
    { operation: "dropIndex", collection: "users", index: "_id_" },
  ]) {
    assert.equal(parseStateQLPanelCommand({ command: "mongo.exec", mongo }), undefined, JSON.stringify(mongo));
  }
  assert.ok(parseStateQLPanelCommand({ command: "redis.query", redis: { command: "INFO", args: ["server"] } }));
});

test("accepts multiline SQL while rejecting non-whitespace control characters", () => {
  const sql = `UPDATE public.user_roles SET
role_id = 'admin'::character varying WHERE
id = '20677';`;
  for (const command of ["query", "plan", "exec"] as const) {
    assert.deepEqual(parseStateQLPanelCommand({ command, sql }), { command, sql });
  }
  assert.ok(parseStateQLPanelCommand({ command: "query", sql: "SELECT\t1\r\n" }));
  for (const control of ["\u0000", "\u0007", "\u007f"]) {
    assert.equal(parseStateQLPanelCommand({ command: "exec", sql: `SELECT 1${control}` }), undefined);
  }
  assert.equal(parseStateQLPanelCommand({ command: "profile.show", name: "line\nbreak" }), undefined);
});

test("refuses secret, unsafe, and ambiguous new command inputs", () => {
  assert.equal(parseStateQLPanelCommand({ command: "objects.list", search: "x".repeat(201) }), undefined);
  assert.equal(
    parseStateQLPanelCommand({ command: "redis.exec", redis: { command: "EVAL", args: ["return 1"] } }),
    undefined,
  );
  assert.equal(
    parseStateQLPanelCommand({ command: "redis.query", redis: { command: "SCAN", args: ["x".repeat(33)] } }),
    undefined,
  );
  assert.equal(
    parseStateQLPanelCommand({
      command: "table.plan.batch",
      updates: [{ row_token: "r", changes: { set: { a: 1 }, unset: ["a"] } }],
    }),
    undefined,
  );
  assert.equal(parseStateQLPanelCommand({ command: "profile.update", name: "profile" }), undefined);
  assert.equal(
    parseStateQLPanelCommand({ command: "profile.update", name: "profile", read_only: true, password: "secret" }),
    undefined,
  );
});

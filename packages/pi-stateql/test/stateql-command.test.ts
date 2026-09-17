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

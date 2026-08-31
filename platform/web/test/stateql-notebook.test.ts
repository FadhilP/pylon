import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStateQLActivity,
  filterStateQLActivity,
  selectStateQLActivity,
  stateqlActivityStatus,
} from "../src/shared/stateql-notebook.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { StateQLSnapshot } from "../src/shared/protocol/snapshots.ts";

function snapshot(overrides: Partial<StateQLSnapshot> = {}): StateQLSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    session: { session_id: "session-1", name: "main", status: "active" },
    actor_id: "actor-1",
    connection: null,
    transaction: null,
    state_version: null,
    state_confidence: null,
    recent_results: [],
    recent_operations: [],
    history: [],
    ...overrides,
  };
}

const history = (command_id: string, command: string, handle: string | null, success = true) => ({
  command_id,
  timestamp: `2026-01-01T00:00:0${command_id.slice(-1)}.000Z`,
  session_id: "session-1",
  actor_id: "actor-1",
  origin: "legacy" as const,
  command,
  sql: null,
  handle,
  executed: command === "query" || command === "exec",
  cached: false,
  success,
  error_code: success ? null : "QUERY_FAILED",
});

test("buildStateQLActivity correlates handles without duplicating retained metadata", () => {
  const items = buildStateQLActivity(
    snapshot({
      recent_results: [{ alias: "accounts", handle: "result-1", rows: 3 }],
      recent_operations: [
        { handle: "operation-1", actor_id: "actor-1", type: "UPDATE", affected_rows: 2, status: "committed" },
      ],
      history: [
        { ...history("command-1", "query", "result-1"), sql: "SELECT id, email\nFROM accounts\nORDER BY id" },
        history("command-2", "show", "result-1"),
        history("command-3", "exec", "operation-1"),
      ],
    }),
  );

  assert.equal(items.length, 3);
  assert.equal(items[0]?.result?.alias, "accounts");
  assert.equal(items[0]?.sql, "SELECT id, email\nFROM accounts\nORDER BY id");
  assert.equal(items[1]?.sql, undefined);
  assert.equal(items[1]?.result?.handle, "result-1");
  assert.equal(items[2]?.operation?.status, "committed");
  assert.deepEqual(items[0]?.tags, ["read"]);
  assert.deepEqual(items[2]?.tags, ["write"]);
  assert.equal(
    items.some(item => item.source === "metadata"),
    false,
  );
});

test("classification is allowlisted and failed writes belong to write and error filters", () => {
  const items = buildStateQLActivity(
    snapshot({
      history: [
        history("command-1", "exec", null, false),
        history("command-2", "custom.command", null),
        history("command-3", "inspect", null),
      ],
    }),
  );

  assert.deepEqual(items[0]?.tags, ["write", "error"]);
  assert.deepEqual(items[1]?.tags, []);
  assert.deepEqual(items[2]?.tags, ["read"]);
  assert.deepEqual(
    filterStateQLActivity(items, "write").map(item => item.id),
    ["history:command-1"],
  );
  assert.deepEqual(
    filterStateQLActivity(items, "error").map(item => item.id),
    ["history:command-1"],
  );
  assert.equal(filterStateQLActivity(items, "all").length, 3);

  // No pressed chip is not an empty ledger: it is the whole ledger.
  assert.equal(selectStateQLActivity(items, new Set()).length, 3);
  assert.deepEqual(
    selectStateQLActivity(items, new Set(["read", "write"] as const)).map(item => item.id),
    ["history:command-1", "history:command-3"],
  );
  assert.deepEqual(
    selectStateQLActivity(items, new Set(["write", "error"] as const)).map(item => item.id),
    ["history:command-1"],
  );
});

test("unreferenced colliding metadata becomes one honest activity card", () => {
  const items = buildStateQLActivity(
    snapshot({
      recent_results: [{ alias: null, handle: "shared-1", rows: 8 }],
      recent_operations: [
        { handle: "shared-1", actor_id: "actor-2", type: "DELETE", affected_rows: null, status: "outcome_unknown" },
      ],
    }),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "metadata");
  assert.equal(items[0]?.result?.rows, 8);
  assert.equal(items[0]?.operation?.type, "DELETE");
  assert.deepEqual(items[0]?.tags, ["read", "write", "error"]);
});

test("referenced cross-type collisions stay on one history card", () => {
  const items = buildStateQLActivity(
    snapshot({
      recent_results: [{ alias: "shared", handle: "shared-1", rows: 1 }],
      recent_operations: [
        { handle: "shared-1", actor_id: "actor-1", type: "UPDATE", affected_rows: 1, status: "committed" },
      ],
      history: [history("command-1", "query", "shared-1")],
    }),
  );

  assert.equal(items.length, 1);
  assert.ok(items[0]?.result);
  assert.ok(items[0]?.operation);
  assert.deepEqual(items[0]?.tags, ["read", "write"]);
});

test("failed history overrides committed metadata and unknown states stay neutral", () => {
  const [failed] = buildStateQLActivity(
    snapshot({
      recent_operations: [
        { handle: "operation-1", actor_id: "actor-1", type: "UPDATE", affected_rows: 2, status: "committed" },
      ],
      history: [history("command-1", "exec", "operation-1", false)],
    }),
  );
  const [unknown] = buildStateQLActivity(
    snapshot({
      recent_operations: [
        { handle: "operation-2", actor_id: "actor-1", type: "UPDATE", affected_rows: null, status: "reviewing" },
      ],
    }),
  );

  assert.ok(failed);
  assert.ok(unknown);
  assert.deepEqual(failed.tags, ["write", "error"]);
  assert.deepEqual(stateqlActivityStatus(failed), { label: "QUERY_FAILED", tone: "danger" });
  assert.deepEqual(unknown.tags, ["write"]);
  assert.deepEqual(stateqlActivityStatus(unknown), { label: "reviewing", tone: "neutral" });
});

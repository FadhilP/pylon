import test from "node:test";
import assert from "node:assert/strict";
import { CommandIdempotency } from "../src/server/transport/commands.ts";
import { EventJournal, eventCursor } from "../src/server/transport/event-journal.ts";
import type { WebCommand } from "../src/shared/protocol/commands.ts";

const command: WebCommand = { type: "prompt", commandId: "one", expectedGeneration: 1, message: "hello" };

test("journal uses opaque generation cursors and rejects stale, future, and malformed cursors", () => {
  const journal = new EventJournal(1, "session", 2, 1024 * 1024);
  const first = journal.append("message.start", {});
  const second = journal.append("message.end", {});
  journal.append("message.start", {});
  assert.equal(eventCursor(first), "1:1");
  assert.deepEqual(journal.replay("1:1").events.map((event) => event.sequence), [2, 3]);
  assert.equal(journal.replay("1:0").ok, false, "cursor before evicted event is stale");
  assert.equal(journal.replay("1:4").ok, false, "future cursor is invalid");
  assert.equal(journal.replay("bad").ok, false);
  assert.equal(journal.replay("2:0").ok, false);
  assert.equal(second.sequence, 2);
});

test("oversized events request a clean bootstrap instead of changing payload shape", () => {
  const journal = new EventJournal(1, "session");
  const event = journal.append("message.start", {
    id: "message",
    role: "user",
    text: "x".repeat(64 * 1024),
    streaming: false,
  });

  assert.equal(event.type, "stream.reset-required");
  assert.deepEqual(event.payload, { reason: "message.start exceeded transport limit" });
});

test("idempotency joins in-flight duplicates and rejects commandId reuse with a changed payload", async () => {
  const idempotency = new CommandIdempotency();
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const action = async () => {
    calls++;
    await pending;
    return { commandId: "one", sessionGeneration: 1, accepted: true as const };
  };
  const first = idempotency.execute(command, action);
  const duplicate = idempotency.execute({ ...command }, action);
  assert.strictEqual(first, duplicate);
  release();
  await first;
  await assert.rejects(idempotency.execute({ ...command, message: "changed" }, action), { name: "IdempotencyConflictError" });
  assert.equal(calls, 1);
});

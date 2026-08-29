import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingQueue, type PendingMessageReadModel } from "../src/shared/pending-messages.ts";
import {
  MAX_UNSEEN_COMPLETIONS,
  completionRecord,
  recordCompletion,
  validCompletionSessionIds,
} from "../src/shared/session-completions.ts";

test("pending queue reconciliation preserves delivery and removes restored entries", () => {
  const pending = (commandId: string): PendingMessageReadModel => ({
    id: `pending-${commandId}`,
    commandId,
    sessionId: "session",
    sessionGeneration: 1,
    text: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state: "queued",
  });
  const queued = (commandId: string, state: "queued" | "delivering") => ({
    id: `queue-${commandId}`,
    commandId,
    preview: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state,
  });
  const first = reconcilePendingQueue(
    [pending("one"), pending("two")],
    [queued("one", "queued"), queued("two", "queued")],
    [queued("one", "delivering"), queued("two", "queued")],
    "session",
    1,
  );
  assert.deepEqual(
    first.map(item => [item.commandId, item.state]),
    [
      ["one", "sending"],
      ["two", "queued"],
    ],
  );
  const delivered = reconcilePendingQueue(
    first,
    [queued("one", "delivering"), queued("two", "queued")],
    [queued("two", "queued")],
    "session",
    1,
  );
  assert.deepEqual(
    delivered.map(item => item.commandId),
    ["one", "two"],
  );
  const restored = reconcilePendingQueue(delivered, [queued("two", "queued")], [], "session", 1);
  assert.deepEqual(
    restored.map(item => item.commandId),
    ["one"],
  );
  const rehydrated = reconcilePendingQueue([], [], [queued("three", "queued")], "session", 1);
  assert.equal(rehydrated[0]?.id, "pending-three");
});

test("completed background sessions survive sleeping and bootstrap authoritatively", () => {
  const completed = recordCompletion({}, "selected", { sessionId: "background", completed: true });
  const sleeping = recordCompletion(completed, "selected", { sessionId: "background" });

  assert.deepEqual(sleeping, { background: true });
  assert.deepEqual(recordCompletion(sleeping, "background", { sessionId: "background", completed: true }), sleeping);
  assert.deepEqual(completionRecord(["from-server"]), { "from-server": true });
  assert.equal(validCompletionSessionIds(["from-server"]), true);
  assert.equal(validCompletionSessionIds(["duplicate", "duplicate"]), false);
  const special = recordCompletion({}, "selected", { sessionId: "__proto__", completed: true });
  assert.equal(Object.hasOwn(special, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  let bounded: Record<string, true> = {};
  for (let index = 0; index <= MAX_UNSEEN_COMPLETIONS; index++) {
    bounded = recordCompletion(bounded, "selected", { sessionId: `session-${index}`, completed: true });
  }
  assert.equal(Object.keys(bounded).length, MAX_UNSEEN_COMPLETIONS);
  assert.equal(bounded["session-0"], undefined);
  assert.equal(bounded["session-200"], true);
});

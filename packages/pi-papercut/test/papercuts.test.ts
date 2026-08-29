import test from "node:test";
import assert from "node:assert/strict";
import {
  capturePapercut,
  cleanText,
  emptyState,
  listPapercuts,
  mutatePapercut,
  updatePapercuts,
} from "../src/papercuts.ts";

const at = "2026-01-01T00:00:00.000Z";

test("capture is bounded, normalized, metadata-bearing, and conservatively deduplicated", () => {
  const initial = emptyState("/repo", at);
  const first = capturePapercut(
    initial,
    "  Running setup   required an undocumented retry.  ",
    { sessionId: "s1", provider: "openai", model: "gpt" },
    at,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(first.duplicate, false);
  assert.equal(first.record.message, "Running setup required an undocumented retry.");
  assert.deepEqual(first.record.source, { sessionId: "s1", provider: "openai", model: "gpt" });
  const bounded = capturePapercut(initial, "Another friction", { model: `x\u0000${"y".repeat(300)}` }, at);
  assert.equal(bounded.record.source.model?.includes("\u0000"), false);
  assert.equal(bounded.record.source.model?.length, 200);
  assert.equal(initial.records.length, 0, "capture must not mutate its input");

  const repeated = capturePapercut(
    first.state,
    "running SETUP required an undocumented retry.",
    { sessionId: "s2", model: "other" },
    "2026-01-02T00:00:00.000Z",
  );
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.state.records.length, 1);
  assert.equal(repeated.record.occurrences, 2);
  assert.deepEqual(repeated.record.lastSource, { sessionId: "s2", model: "other" });

  assert.throws(() => cleanText("token=super-secret-value", 500, "message"), /possible credential/);
  assert.throws(() => cleanText("x".repeat(501), 500, "message"), /at most 500/);
});

test("lifecycle updates support unique prefixes and atomic batches", () => {
  let state = emptyState("/repo", at);
  state = capturePapercut(state, "First friction", {}, at, "aaaaaaaa-1111-4111-8111-111111111111").state;
  state = capturePapercut(state, "Second friction", {}, at, "bbbbbbbb-2222-4222-8222-222222222222").state;

  const resolved = updatePapercuts(
    state,
    "resolve",
    ["aaaa", "bbbb"],
    "Covered by regression tests.",
    "2026-01-02T00:00:00.000Z",
  );
  assert.deepEqual(
    resolved.records.map(record => record.status),
    ["resolved", "resolved"],
  );
  assert.equal(listPapercuts(resolved.state, "open").length, 0);
  assert.equal(listPapercuts(resolved.state, "resolved").length, 2);
  assert.equal(
    state.records.every(record => record.status === "open"),
    true,
  );

  const reopened = updatePapercuts(resolved.state, "reopen", ["aaaaaaaa"]);
  assert.equal(reopened.records[0].status, "open");
  assert.equal(reopened.records[0].resolution, undefined);

  const before = JSON.stringify(reopened.state);
  assert.throws(
    () => updatePapercuts(reopened.state, "dismiss", ["aaaa", "missing"], "Not actionable"),
    /unknown papercut id/,
  );
  assert.equal(JSON.stringify(reopened.state), before, "failed batches must not mutate state");
  assert.throws(() => updatePapercuts(reopened.state, "resolve", ["aaaa"]), /resolution is required/);
  assert.throws(() => updatePapercuts(reopened.state, "reopen", ["aaaa"], "extra"), /note is not valid/);
});

test("closed records do not suppress a fresh occurrence", () => {
  const captured = capturePapercut(
    emptyState("/repo", at),
    "A stale cache hid changes",
    {},
    at,
    "cccccccc-3333-4333-8333-333333333333",
  );
  const dismissed = updatePapercuts(captured.state, "dismiss", ["cccc"], "Expected platform behavior", at);
  const fresh = capturePapercut(
    dismissed.state,
    "A stale cache hid changes",
    {},
    "2026-01-03T00:00:00.000Z",
    "dddddddd-4444-4444-8444-444444444444",
  );
  assert.equal(fresh.duplicate, false);
  assert.equal(fresh.state.records.length, 2);
});

test("ambiguous prefixes identify the full matching IDs", () => {
  let state = emptyState("/repo", at);
  state = capturePapercut(state, "First", {}, at, "abcd1111-1111-4111-8111-111111111111").state;
  state = capturePapercut(state, "Second", {}, at, "abcd2222-2222-4222-8222-222222222222").state;
  assert.throws(
    () => updatePapercuts(state, "dismiss", ["abcd"]),
    /ambiguous.*abcd1111-1111-4111-8111-111111111111.*abcd2222-2222-4222-8222-222222222222/,
  );
});

test("web mutations edit safely and delete only the expected record revision", () => {
  let state = emptyState("/repo", at);
  state = capturePapercut(state, "First friction", {}, at, "aaaaaaaa-1111-4111-8111-111111111111").state;
  state = capturePapercut(state, "Second friction", {}, at, "bbbbbbbb-2222-4222-8222-222222222222").state;
  const original = state.records[0];
  const editedAt = "2026-01-02T00:00:00.000Z";
  const edited = mutatePapercut(
    state,
    { action: "edit", id: original.id, expectedUpdatedAt: original.updatedAt, message: "  Corrected   friction  " },
    editedAt,
  );
  assert.equal(edited.record?.message, "Corrected friction");
  assert.equal(edited.record?.updatedAt, editedAt);
  assert.equal(edited.record?.createdAt, original.createdAt);
  assert.equal(edited.record?.lastSeenAt, original.lastSeenAt);
  assert.equal(edited.record?.occurrences, original.occurrences);
  assert.equal(state.records[0].message, "First friction", "mutation must not modify its input");

  assert.throws(
    () =>
      mutatePapercut(edited.state, {
        action: "edit",
        id: original.id,
        expectedUpdatedAt: original.updatedAt,
        message: "Stale edit",
      }),
    (error: any) => error?.code === "stale",
  );
  assert.throws(
    () =>
      mutatePapercut(edited.state, {
        action: "edit",
        id: original.id,
        expectedUpdatedAt: editedAt,
        message: "second FRICTION",
      }),
    (error: any) => error?.code === "duplicate",
  );
  assert.throws(
    () =>
      mutatePapercut(edited.state, {
        action: "edit",
        id: original.id,
        expectedUpdatedAt: editedAt,
        message: "token=super-secret-value",
      }),
    (error: any) => error?.code === "invalid",
  );

  const removed = mutatePapercut(
    edited.state,
    { action: "delete", id: original.id, expectedUpdatedAt: editedAt },
    "2026-01-03T00:00:00.000Z",
  );
  assert.deepEqual(
    removed.state.records.map(record => record.id),
    ["bbbbbbbb-2222-4222-8222-222222222222"],
  );
  assert.throws(
    () => mutatePapercut(removed.state, { action: "delete", id: original.id, expectedUpdatedAt: editedAt }),
    (error: any) => error?.code === "stale",
  );
});

test("record limits fail visibly without eviction", () => {
  const sameTimestampState = capturePapercut(
    emptyState("/repo", at),
    "Same timestamp",
    {},
    at,
    "cccccccc-3333-4333-8333-333333333333",
  ).state;
  const sameTimestampRecord = sameTimestampState.records[0];
  const monotonic = mutatePapercut(
    sameTimestampState,
    {
      action: "edit",
      id: sameTimestampRecord.id,
      expectedUpdatedAt: sameTimestampRecord.updatedAt,
      message: "Still monotonic",
    },
    sameTimestampRecord.updatedAt,
  );
  assert.ok(monotonic.record!.updatedAt > sameTimestampRecord.updatedAt);
  const template = capturePapercut(emptyState("/repo", at), "Template", {}, at).record;
  const full = {
    ...emptyState("/repo", at),
    records: Array.from({ length: 1_000 }, (_, index) => ({ ...template, id: `record-${index}` })),
  };
  assert.throws(() => capturePapercut(full, "One too many", {}, at), /storage limit reached/);
  assert.equal(full.records.length, 1_000);
});

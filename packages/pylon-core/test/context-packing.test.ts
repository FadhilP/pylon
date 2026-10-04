import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { packRecentRecords, projectedContextEntries } from "../src/context-packing.ts";

const identity = (record: string) => record.trim();
const pack = (records: string[], maxChars = 1000, maxItems = 10) =>
  packRecentRecords(records, { maxChars, maxItems, identity });

test("the newest records are selected but reading order is restored", () => {
  assert.equal(pack(["one", "two", "three"], 1000, 2), "two\n\nthree");
});

test("duplicates are dropped by identity, keeping the newest occurrence", () => {
  assert.equal(pack(["same", "other", " same "]), "other\n\n same ");
});

test("an oversized record is skipped so older records that still fit survive", () => {
  const packed = pack(["small", "x".repeat(50), "tiny"], 20);
  assert.equal(packed, "small\n\ntiny");
});

test("the separator counts against the budget", () => {
  assert.equal(pack(["aaa", "bbb"], 8), "aaa\n\nbbb");
  assert.equal(pack(["aaa", "bbb"], 7), "bbb", "one separator short leaves only the newest");
});

test("empty identities and non-positive budgets yield nothing", () => {
  assert.equal(pack(["   ", ""]), "");
  assert.equal(pack(["kept"], 0), "");
  assert.equal(pack(["kept"], 1000, 0), "");
});

test("delegated context honors branch-relative edits without losing checkpoint metadata or rewriting history", () => {
  const session = SessionManager.inMemory();
  const omittedId = session.appendMessage({ role: "user", content: "Omitted history", timestamp: 1 });
  const replacedId = session.appendMessage({ role: "user", content: "Original request", timestamp: 2 });
  const customId = session.appendCustomMessageEntry("context-note", "Original note", false);
  const checkpointId = session.appendCustomEntry("pi-prompt-checkpoint", { head: "checkpoint-ref" });
  const originalBranch = session.getBranch();
  session.appendContextEdit(omittedId, null);
  session.appendContextEdit(replacedId, { content: "Updated request" });
  session.appendContextEdit(customId, { content: "Updated note" });

  const entries = projectedContextEntries(session.buildSessionProjection());
  assert.equal(
    entries.some(entry => entry.id === omittedId),
    false,
  );
  const request = entries.find(entry => entry.id === replacedId);
  assert.equal(
    request?.type === "message" && request.message.role === "user" && request.message.content,
    "Updated request",
  );
  const note = entries.find(entry => entry.id === customId);
  assert.equal(note?.type === "custom_message" && note.content, "Updated note");
  assert.deepEqual(
    entries.find(entry => entry.id === checkpointId),
    session.getEntry(checkpointId),
  );
  assert.deepEqual(session.getEntries().slice(0, originalBranch.length), originalBranch);

  session.branch(checkpointId);
  assert.deepEqual(projectedContextEntries(session.buildSessionProjection()), originalBranch);
  const olderCompaction = session.appendCompaction("Older summary", replacedId, 100);
  session.appendCompaction("Current summary", replacedId, 100);
  assert.equal(
    projectedContextEntries(session.buildSessionProjection()).some(entry => entry.id === olderCompaction),
    false,
  );
});

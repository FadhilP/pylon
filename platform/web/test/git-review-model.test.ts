import assert from "node:assert/strict";
import test from "node:test";
import { reconstructConflictText } from "../src/client/workspace/git-review-model.ts";

test("conflict reconstruction uses LF offsets for CRLF input and retains context", () => {
  const text = "before\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\nafter\r\n";
  const normal = text.replace(/\r\n/g, "\n");
  const start = normal.indexOf("<<<<<<<");
  const end = normal.indexOf("after");
  assert.equal(
    reconstructConflictText(text, [{ start, end, ours: "ours\n", theirs: "theirs\n" }], { 0: "both" }),
    "before\nours\ntheirs\nafter\n",
  );
});

test("conflict reconstruction preserves unchanged text and final newline", () => {
  const text = "one\n<<<<<<< x\na\n=======\nb\n>>>>>>> y\ntwo\n";
  const start = text.indexOf("<<<<<<<");
  const end = text.indexOf("two");
  assert.equal(
    reconstructConflictText(text, [{ start, end, ours: "a\n", theirs: "b\n" }], { 0: "theirs" }),
    "one\nb\ntwo\n",
  );
});

test("conflict reconstruction rejects unresolved blocks", () => {
  assert.throws(() => reconstructConflictText("x", [{ start: 0, end: 1, ours: "a", theirs: "b" }], {}), /unresolved/i);
});

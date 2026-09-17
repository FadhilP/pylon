import assert from "node:assert/strict";
import test from "node:test";
import { conflictResolutionBlocks, editableConflictStructureMatches, parseEditableConflictText, prepareEditableConflictText, reconstructConflictText } from "../src/client/workspace/git-review-model.ts";

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


test("editable conflict sides drive only the selected resolution after lengths change", () => {
  const text = [
    "before\n",
    "<<<<<<< HEAD\n",
    "ours edited and longer\n",
    "||||||| base\n",
    "base\n",
    "=======\n",
    "theirs edited\n",
    ">>>>>>> topic\n",
    "between\n",
    "<<<<<<< HEAD\n",
    "second ours\n",
    "=======\n",
    "second theirs changed\n",
    ">>>>>>> topic\n",
    "after\n",
  ].join("");
  const parsed = parseEditableConflictText(text);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0]!.ours, "ours edited and longer\n");
  assert.equal(parsed.blocks[0]!.theirs, "theirs edited\n");
  assert.equal(parsed.blocks[0]!.base, "base\n");
  assert.equal(
    reconstructConflictText(text, parsed.blocks, { 0: "theirs", 1: "ours" }),
    "before\ntheirs edited\nbetween\nsecond ours\nafter\n",
  );
  assert.equal(
    reconstructConflictText(text, parsed.blocks, { 0: "both", 1: "theirs" }),
    "before\nours edited and longer\ntheirs edited\nbetween\nsecond theirs changed\nafter\n",
  );
  assert.ok(parsed.protectedRanges.some(range => text.slice(range.from, range.to) === "base\n"));
  assert.equal(editableConflictStructureMatches(text.replace("ours edited and longer", "custom ours"), parsed.blocks), true);
  assert.equal(editableConflictStructureMatches(text.replace("\nbase\n", "\nchanged base\n"), parsed.blocks), false);
});

test("empty conflict sides remain directly editable without changing an untouched resolution", () => {
  const raw = "before\n<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> topic\nafter\n";
  const prepared = prepareEditableConflictText(raw);
  const parsed = parseEditableConflictText(prepared);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.blocks[0]!.ours, "\u200b\n");
  assert.equal(
    reconstructConflictText(prepared, conflictResolutionBlocks(parsed.blocks), { 0: "ours" }),
    "before\nafter\n",
  );
  const edited = `${prepared.slice(0, parsed.blocks[0]!.oursFrom)}custom${prepared.slice(parsed.blocks[0]!.oursFrom)}`;
  const editedBlocks = parseEditableConflictText(edited).blocks;
  assert.equal(
    reconstructConflictText(edited, conflictResolutionBlocks(editedBlocks), { 0: "ours" }),
    "before\ncustom\nafter\n",
  );
});


test("editable conflict parsing rejects an incomplete marker structure", () => {
  const parsed = parseEditableConflictText("<<<<<<< HEAD\nours\n=======\ntheirs\n");
  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.blocks, []);
  assert.equal(parseEditableConflictText("<<<<<<< HEAD\nours\n<<<<<<< nested\n=======\ntheirs\n>>>>>>> topic\n").valid, false);
});

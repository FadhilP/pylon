import test from "node:test";
import assert from "node:assert/strict";
import { Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { codeEditLimit, protectCodeRanges, selectedCodeLines } from "../src/client/rendering/editable-code-state.ts";

test("editing rejects oversized input and saves' read-only locks without losing selection or undo history", () => {
  const lock = new Compartment();
  let state = EditorState.create({
    doc: "first\n",
    extensions: [history(), codeEditLimit(20), lock.of(EditorState.readOnly.of(false))],
  });
  const dispatch = (transaction: TransactionSpec) => {
    state = state.update(transaction).state;
  };
  dispatch({ changes: { from: 0, to: 5, insert: "😀\tlast" }, selection: { anchor: 3 } });
  assert.equal(state.doc.toString(), "😀\tlast\n");
  dispatch({ changes: { from: 0, insert: "x".repeat(20) } });
  assert.equal(state.doc.toString(), "😀\tlast\n");
  dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(true)) });
  dispatch({ changes: { from: 0, to: state.doc.length, insert: "lost" } });
  assert.equal(state.doc.toString(), "😀\tlast\n");
  dispatch({ selection: { anchor: 0, head: state.doc.length } });
  assert.equal(state.selection.main.to, state.doc.length, "locked text remains selectable for copying");
  dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(false)) });
  const target = () => ({
    state,
    dispatch: (transaction: { state: EditorState }) => {
      state = transaction.state;
    },
  });
  assert.equal(undo(target()), true);
  assert.equal(state.doc.toString(), "first\n");
  assert.equal(redo(target()), true);
  assert.equal(state.doc.toString(), "😀\tlast\n");
});

test("annotation selections exclude the following line at newline boundaries, including the empty final line", () => {
  const { doc } = EditorState.create({ doc: "😀\tone\ntwo\n" });
  assert.deepEqual(selectedCodeLines(doc, 0, doc.line(2).from), { from: 1, to: 1 });
  assert.deepEqual(selectedCodeLines(doc, 0, doc.length), { from: 1, to: 2 });
  assert.deepEqual(selectedCodeLines(doc, doc.length, doc.length), { from: 3, to: 3 });
  assert.deepEqual(selectedCodeLines(EditorState.create().doc, 0, 0), { from: 1, to: 1 });
});


test("protected editor ranges reject structural edits but allow content at their boundaries", () => {
  let state = EditorState.create({
    doc: "ours\n<<<<<<< HEAD\ntheirs\n",
    extensions: [protectCodeRanges(text => {
      const from = text.indexOf("<<<<<<<");
      return [{ from, to: from + "<<<<<<< HEAD\n".length }];
    }, text => text.includes("\n<<<<<<< HEAD\n"))],
  });
  const apply = (spec: TransactionSpec) => { state = state.update(spec).state; };
  const marker = state.doc.toString().indexOf("<<<<<<<");
  apply({ changes: { from: marker + 2, insert: "x" } });
  assert.equal(state.doc.toString(), "ours\n<<<<<<< HEAD\ntheirs\n");
  apply({ changes: { from: marker, insert: "x" } });
  assert.equal(state.doc.toString(), "ours\n<<<<<<< HEAD\ntheirs\n");
  apply({ changes: { from: marker, insert: "edited\n" } });
  assert.equal(state.doc.toString(), "ours\nedited\n<<<<<<< HEAD\ntheirs\n");
  const moved = state.doc.toString().indexOf("<<<<<<<");
  apply({ changes: { from: moved - 1, to: moved, insert: "" } });
  assert.equal(state.doc.toString(), "ours\nedited\n<<<<<<< HEAD\ntheirs\n");
  apply({ changes: { from: moved - 1, to: moved + 1, insert: "" } });
  assert.equal(state.doc.toString(), "ours\nedited\n<<<<<<< HEAD\ntheirs\n");
});

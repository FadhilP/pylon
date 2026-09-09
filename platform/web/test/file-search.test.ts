import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { search, setSearchQuery, getSearchQuery } from "@codemirror/search";
import { fileSearchQuery, findTextMatches } from "../src/shared/workspace/text-search.ts";
import { openFileTab, selectFileTab, setFileTabView, workspaceStateForSession } from "../src/client/workspace/file-workspace-state.ts";

test("project search context reaches file search and matches the current unsaved text, not old snippet offsets", () => {
  const query = { query: "value", caseSensitive: true, wholeWord: true, glob: "*.ts" };
  let tabs = workspaceStateForSession(new Map(), "session");
  tabs = openFileTab(tabs, "file.ts", "current", 2, false, query);
  assert.equal(tabs.selectedLine, 2);
  let state = EditorState.create({ doc: "VALUE values\nvalue", extensions: search() });
  state = state.update({ effects: setSearchQuery.of(fileSearchQuery(tabs.searchQuery)) }).state;
  const matches = () => Array.from({ [Symbol.iterator]: () => getSearchQuery(state).getCursor(state) });
  assert.deepEqual(matches(), [{ from: 13, to: 18, precise: true }]);
  state = state.update({ changes: { from: 0, insert: "draft\n" } }).state;
  const hits = findTextMatches(state.doc.toString(), query);
  assert.deepEqual(hits.hits, [{ line: 3, start: 19, end: 24 }]);
  assert.equal(matches()[0].from, hits.hits[0].start);
  assert.equal(openFileTab(tabs, "other.ts").searchQuery, undefined);
  assert.equal(selectFileTab(tabs, "file.ts").searchQuery, undefined);
  assert.equal(setFileTabView(tabs, "file.ts", "diff").searchQuery, undefined);
  assert.equal(workspaceStateForSession(new Map([["session", tabs]]), "other-session").searchQuery, undefined);
});

test("file matching handles literals, regex flags, UTF-16 offsets, multiline hits and invalid patterns", () => {
  const literal = findTextMatches("😀 Foo foo food\nfoo", { query: "foo", wholeWord: true });
  assert.deepEqual(literal.hits.map(hit => hit.start), [3, 7, 16]);
  assert.deepEqual(literal.ranges.get(1), [{ start: 3, end: 6 }, { start: 7, end: 10 }]);
  assert.equal(findTextMatches("foo Foo food", { query: "foo", caseSensitive: true, wholeWord: true }).hits.length, 1);
  assert.equal(findTextMatches("a.b axb", { query: "a.b" }).hits.length, 1);
  assert.equal(findTextMatches("a.b axb", { query: "a.b", regex: true }).hits.length, 2);
  assert.equal(findTextMatches("line\\nline\nline", { query: "\\n" }).hits.length, 1, "literal queries do not unescape backslashes");
  const multiline = findTextMatches("one\ntwo\n", { query: "one\\ntwo", regex: true });
  assert.deepEqual(multiline.ranges.get(1), [{ start: 0, end: 3 }]);
  assert.deepEqual(multiline.ranges.get(2), [{ start: 0, end: 3 }]);
  assert.equal(findTextMatches("anything", { query: "[", regex: true }).invalidRegex, true);
  assert.equal(findTextMatches("anything", { query: "$", regex: true }).hits.length, 0);
  assert.equal(findTextMatches("anything", { query: "" }).hits.length, 0);
  const bounded = findTextMatches("a ".repeat(10001), { query: "a" });
  assert.equal(bounded.hits.length, 10000);
  assert.equal(bounded.truncated, true);
});

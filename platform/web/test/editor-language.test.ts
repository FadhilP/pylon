import test from "node:test";
import assert from "node:assert/strict";
import { Compartment, EditorState } from "@codemirror/state";
import { CompletionContext, completeFromList, insertCompletionText, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { diagnosticCount, setDiagnostics } from "@codemirror/lint";
import { history, undo } from "@codemirror/commands";
import { editorAssistance, loadEditorLanguage, syntaxDiagnostics } from "../src/client/rendering/editor-language.ts";
import { EditorAnalysisRequests, type EditorAnalysisRequest } from "../src/client/rendering/editor-analysis.ts";

test("syntax hints recognize supported grammar errors without treating types or unknown languages as errors", async () => {
  for (const [path, valid, invalid] of [
    ["file.js", "const value = 1;", "const value = ;"],
    ["file.ts", "const value: string = 1;", "const value: = ;"],
    ["file.tsx", "const view = <div>{value}</div>;", "const view = <div>{</div>;"],
    ["file.jsx", "const view = <div/>;", "const view = <div>"],
    ["file.json", '{"value": [true, null]}', '{"value": }'],
    ["file.py", "def add(a, b):\n    return a + b", "def broken(:"],
    ["file.rs", "fn main() {}", "fn main( {"],
  ]) {
    assert.deepEqual(await syntaxDiagnostics(valid, path), [], path);
    const errors = await syntaxDiagnostics(invalid, path);
    assert.ok(errors.length > 0, path);
    assert.ok(errors.every(error => error.from >= 0 && error.to <= invalid.length && error.from <= error.to));
  }
  assert.deepEqual(await syntaxDiagnostics("def broken(:", "file.unknown"), []);
  assert.deepEqual(await syntaxDiagnostics("", "file.js"), []);
  assert.ok((await syntaxDiagnostics("const = ;\n".repeat(1000), "file.js")).length <= 100);
});

test("completion uses native providers, grammar keywords and isolated document words across languages", async () => {
  const labels = async (path: string, text: string) => {
    const support = await loadEditorLanguage(path);
    const state = EditorState.create({ doc: text, extensions: [editorAssistance(path), support ?? []] });
    const context = new CompletionContext(state, text.length, true);
    const results = await Promise.all(state.languageDataAt<CompletionSource | Completion[]>("autocomplete", text.length)
      .map(source => (Array.isArray(source) ? completeFromList(source) : source)(context)));
    return results.flatMap(result => result?.options.map(option => option.label) ?? []);
  };
  assert.ok((await labels("file.txt", "documentWord\ndoc")).includes("documentWord"));
  assert.ok(!(await labels("file.txt", "differentWord\ndoc")).includes("documentWord"), "no words leak from a previous document");
  assert.ok((await labels("file.js", "fun")).includes("function"));
  assert.ok((await labels("file.json", '{"enabled": tr')).includes("true"));
  for (const [path, text, expected] of [["file.rs", "ret", "return"], ["file.cpp", "nam", "namespace"],
    ["file.py", "def", "def"], ["file.go", "fun", "func"], ["file.cs", "pub", "public"], ["file.sql", "sel", "select"]]) {
    assert.ok((await labels(path, text)).includes(expected), path);
  }
});

test("document fallback removes keyword overlaps without losing native completion or quoted/case-sensitive words", async () => {
  for (const [path, dialect, doc, label] of [
    ["file.ts", undefined, "function example() { return 1; }\nret", "return"],
    ["file.py", undefined, "def example():\n    return 1\nret", "return"],
    ["file.rs", undefined, "fn main() { return; }\nret", "return"],
    ...(["sqlite", "postgres", "mysql"] as const).map(dialect => ["query.sql", dialect, "SELECT id FROM items;\nsel", "select"] as const),
  ] as const) {
    const support = await loadEditorLanguage(path, dialect);
    const state = EditorState.create({ doc, extensions: [editorAssistance(path, { dialect }), support!] });
    const context = new CompletionContext(state, doc.length, true);
    const [fallback, ...sources] = state.languageDataAt<CompletionSource>("autocomplete", context.pos);
    const words = await fallback(context);
    assert.ok(words);
    assert.ok(!words.options.some(option => option.label.toLowerCase() === label), `${path}/${dialect}: no redundant word`);
    const results = await Promise.all(sources.map(source => source(context)));
    const native = results.find(result => result?.options.some(option => option.label === label));
    assert.ok(native, `${path}/${dialect}: retain the language suggestion`);
    const accepted = state.update(insertCompletionText(state, label, native.from, native.to ?? context.pos)).state;
    assert.equal(accepted.doc.toString(), doc.slice(0, doc.lastIndexOf("\n") + 1) + label);
  }
  for (const [path, marked] of [
    ["file.rs", "fn main() { return; } // ret|"],
    ["file.rs", 'fn main() { return; let s = "ret|"; }'],
    ["query.sql", 'SELECT "SELECT" FROM "sel|";'],
    ["query.sql", "SELECT id FROM items; -- sel|"],
    ["query.sql", "SELECT id FROM items; /* sel| */"],
    ["query.sql", "SELECT id FROM items; SELECT 'sel|'"],
    ["query.sql", "SELECT id FROM items; SELECT items.|"],
  ]) {
    const pos = marked.indexOf("|");
    const doc = marked.replace("|", "");
    const state = EditorState.create({ doc, extensions: [editorAssistance(path), (await loadEditorLanguage(path))!] });
    const [fallback] = state.languageDataAt<CompletionSource>("autocomplete", pos);
    const result = await fallback(new CompletionContext(state, pos, true));
    assert.ok(result?.options.some(option => /^(return|SELECT)$/.test(option.label)), marked);
  }
  const doc = "CamelName camelName\ncam";
  const state = EditorState.create({ doc, extensions: [editorAssistance("query.sql"), (await loadEditorLanguage("query.sql"))!] });
  const [fallback] = state.languageDataAt<CompletionSource>("autocomplete", doc.length);
  const result = await fallback(new CompletionContext(state, doc.length, true));
  assert.ok(result?.options.some(option => option.label === "CamelName"));
  assert.ok(result?.options.some(option => option.label === "camelName"));
});

test("loading a grammar invalidates cached document words while continued typing can reuse filtered results", async () => {
  const language = new Compartment();
  const doc = "fn main() { return; }\nret";
  let state = EditorState.create({ doc, extensions: [editorAssistance("file.rs"), language.of([])] });
  const [fallback] = state.languageDataAt<CompletionSource>("autocomplete", doc.length);
  const before = await fallback(new CompletionContext(state, doc.length, true));
  assert.ok(before);
  assert.ok(before.options.some(option => option.label === "return"));
  state = state.update({ effects: language.reconfigure((await loadEditorLanguage("file.rs"))!) }).state;
  assert.ok(typeof before.validFor === "function");
  assert.equal(before.validFor("ret", before.from, doc.length, state), false);
  const after = await fallback(new CompletionContext(state, doc.length, true));
  assert.ok(after);
  assert.ok(!after.options.some(option => option.label === "return"));
  state = state.update({ changes: { from: doc.length, insert: "u" } }).state;
  assert.ok(typeof after.validFor === "function");
  assert.equal(after.validFor("retu", after.from, state.doc.length, state), true);
  state = state.update({ changes: { from: state.doc.length, insert: " " } }).state;
  assert.equal(after.validFor("retu ", after.from, state.doc.length, state), false, "a word boundary forces a fresh query");
});

test("editing clears diagnostics immediately, stale worker results cannot restore them, and undo survives", async () => {
  let state = EditorState.create({ doc: "const value = ;", extensions: [history(), editorAssistance("file.js")] });
  state = state.update(setDiagnostics(state, await syntaxDiagnostics(state.doc.toString(), "file.js"))).state;
  assert.ok(diagnosticCount(state) > 0);
  const sent: EditorAnalysisRequest[] = [];
  const requests = new EditorAnalysisRequests(request => sent.push(request), (_request, result) => {
    state = state.update(setDiagnostics(state, result.diagnostics ?? [])).state;
  });
  const request = () => requests.request({ text: state.doc.toString(), path: "file.js", theme: "github-dark", ranges: [] });
  request();
  state = state.update({ changes: { from: 14, insert: "1" } }).state;
  assert.equal(diagnosticCount(state), 0);
  request();
  requests.receive({ id: sent[0].id, spans: [], diagnostics: await syntaxDiagnostics(sent[0].text, "file.js") });
  assert.equal(diagnosticCount(state), 0);
  requests.receive({ id: sent[1].id, spans: [], diagnostics: [] });
  assert.equal(diagnosticCount(state), 0);
  assert.ok(undo({ state, dispatch: transaction => { state = transaction.state; } }));
  assert.equal(state.doc.toString(), "const value = ;");
  requests.dispose();
});

test("lazy language replacement preserves edits and undo and shares concurrent loads", async () => {
  const language = new Compartment();
  let state = EditorState.create({ doc: "original", extensions: [history(), language.of([])] });
  state = state.update({ changes: { from: 8, insert: " draft" }, selection: { anchor: 14 } }).state;
  const [one, two] = await Promise.all([loadEditorLanguage("file.RS"), loadEditorLanguage("other.rs")]);
  assert.equal(one, two, "a language loads and derives keywords once, not per file");
  state = state.update({ effects: language.reconfigure(one!) }).state;
  assert.equal(state.doc.toString(), "original draft");
  assert.equal(state.selection.main.head, 14);
  assert.ok(undo({ state, dispatch: transaction => { state = transaction.state; } }));
  assert.equal(state.doc.toString(), "original");
});

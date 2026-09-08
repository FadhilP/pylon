import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { IncrementalSyntax, sameGrammarState, visibleSyntax } from "../src/client/rendering/incremental-syntax.ts";
import { syntaxLine, syntaxTokens } from "../src/client/rendering/syntax-highlighting-runtime.ts";
import { EditorAnalysisRequests, type EditorAnalysisRequest } from "../src/client/rendering/editor-analysis.ts";
import { paintedSyntax, paintSyntax, paintedCode, paintCode } from "../src/client/rendering/editable-code-state.ts";
import { SYNTAX_THEMES } from "../src/client/rendering/syntax-highlighting.ts";

const theme = "one-dark-pro";

test("the analysis worker returns preview-equivalent spans and recovers after a rejected request", { timeout: 15_000 }, async () => {
  const url = new URL("../src/client/rendering/editor-analysis.worker.ts", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    globalThis.self = globalThis;
    self.postMessage = result => parentPort.postMessage(result);
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on("message", data => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    });
  `, { eval: true });
  try {
    await once(worker, "message");
    const send = async (request: EditorAnalysisRequest) => {
      const result = once(worker, "message");
      worker.postMessage(request);
      return (await result)[0];
    };
    const text = "const value = 1;\n";
    const input: EditorAnalysisRequest = { id: 1, text, path: "test.ts", theme, indexText: "", ranges: [{ from: 0, to: text.length }] };
    const result = await send(input);
    assert.deepEqual(result.spans, visibleSyntax(text, syntaxTokens(text, "typescript", theme)!, input.ranges));
    assert.equal(result.changes.get(1).kind, "added");
    assert.equal((await send({ ...input, id: 2, text: "x".repeat(1024 * 1024 + 1) })).error, true);
    const next = await send({ ...input, id: 3, text: text.replace("1", "2") });
    assert.equal(next.error, undefined);
    assert.ok(next.spans.length > 0);
  } finally { await worker.terminate(); }
});

test("source notes disappear immediately on edits and cannot be repainted by stale work", () => {
  let state = EditorState.create({ doc: "original", extensions: [paintedCode] });
  const note = { id: "note", from: 1, to: 1 } as any;
  const paint = paintCode.of({ text: "original", notes: [note], blocks: [], gitChanges: new Map([[1, { kind: "added" }]]) });
  state = state.update({ effects: paint }).state;
  assert.equal(state.field(paintedCode).notes.length, 1);
  state = state.update({ changes: { from: 0, insert: "changed " } }).state;
  assert.deepEqual(state.field(paintedCode).notes, []);
  assert.equal(state.field(paintedCode).gitChanges, undefined);
  state = state.update({ effects: paint }).state;
  assert.deepEqual(state.field(paintedCode).notes, []);
});


test("incremental Shiki matches full highlighting across line edits, multiline state, EOF and theme changes", () => {
  for (const [language, source] of [
    ["tsx", 'const view = <div title="😀">hello</div>;\n/* comment\n\ncontinued */\nconst next = `template\n${1 + 2}`;\n'],
    ["markdown", '# Heading\n\n```typescript\nconst value = "one";\n```\n**bold**\n'],
    ["python", '#!/usr/bin/python\nvalue = """first\n\nlast"""\nprint(value)\n'],
    ["bash", '#!/bin/sh\ncat <<EOF\none\n\nEOF\necho "$HOME"\n'],
  ]) {
    const cache = new IncrementalSyntax();
    const versions = [source, source.replace("one", "two"), `/*\n${source}`, source, source.slice(source.indexOf("\n") + 1),
      source.replace(/\n/g, "\r\n"), source.trimEnd(), `${source}\n`, "", "\n", source];
    for (const text of versions) assert.deepEqual(cache.update(text, language, theme), syntaxTokens(text, language, theme), `${language}: ${JSON.stringify(text)}`);
    for (const { id } of SYNTAX_THEMES) assert.deepEqual(cache.update(source, language, id), syntaxTokens(source, language, id));
    // Reusing the same cache for a different grammar must not reuse any previous language's states.
    assert.deepEqual(cache.update(source, "json", theme), syntaxTokens(source, "json", theme));
  }
});

test("local edits reuse the unaffected suffix; missing stack equality safely retokenizes the suffix", () => {
  const source = Array.from({ length: 100 }, (_, i) => `const item${i} = ${i};`).join("\n");
  let calls = 0;
  const tokenize: typeof syntaxLine = (...args) => { calls++; return syntaxLine(...args); };
  const cache = new IncrementalSyntax(tokenize);
  cache.update(source, "typescript", theme);
  calls = 0;
  const edited = source.replace("item10 = 10", "item10 = 11");
  assert.deepEqual(cache.update(edited, "typescript", theme), syntaxTokens(edited, "typescript", theme));
  assert.ok(calls <= 2, `local edit tokenized ${calls} lines`);
  calls = 0;
  cache.update(edited, "typescript", theme);
  assert.equal(calls, 0, "viewport-only work reuses all tokens");
  const fallback = new IncrementalSyntax(tokenize, () => false);
  fallback.update(source, "typescript", theme);
  calls = 0;
  assert.deepEqual(fallback.update(edited, "typescript", theme), syntaxTokens(edited, "typescript", theme));
  assert.equal(calls, 90);
  assert.equal(sameGrammarState(undefined, undefined), false);
  const unknown = { lang: "typescript", theme, getInternalStack: () => { throw new Error("API changed"); } };
  assert.equal(sameGrammarState(unknown as any, unknown as any), false);
});

test("unchanged documents reuse cached line offsets for viewport spans", () => {
  const text = "const first = 1;\nconst second = 2;\n";
  const cache = new IncrementalSyntax();
  const tokens = cache.update(text, "typescript", theme);
  const range = { from: text.indexOf("second"), to: text.length - 1 };
  assert.deepEqual(cache.visible([range]), visibleSyntax(text, tokens, [range]));
  // A repeated worker request has no grammar work and uses the cached offsets.
  assert.equal(cache.update(text, "typescript", theme), tokens);
  assert.deepEqual(cache.visible([range]), visibleSyntax(text, tokens, [range]));
});

test("viewport extraction clips tokens at UTF-16 boundaries without sending the rest of the document", () => {
  const text = 'const emoji = "😀";\r\nconst number = 123;\n';
  const cache = new IncrementalSyntax();
  const tokens = cache.update(text, "typescript", theme);
  const from = text.indexOf("number");
  const to = text.indexOf("123") + 3;
  const spans = visibleSyntax(text, tokens, [{ from, to }]);
  assert.ok(spans.length > 0);
  assert.ok(spans.every(span => span.from >= from && span.to <= to));
  assert.ok(spans.some(span => text.slice(span.from, span.to) === "123"));
  assert.deepEqual(visibleSyntax(text, tokens, []), []);
});

test("typing and undo do not wait for analysis, and only the latest queued document can paint", () => {
  let state = EditorState.create({ doc: "x", extensions: [history(), paintedSyntax] });
  const sent: EditorAnalysisRequest[] = [];
  const accepted: number[] = [];
  const queue = new EditorAnalysisRequests(request => sent.push(request), (request, result) => {
    accepted.push(request.id);
    state = state.update({ effects: paintSyntax.of({ doc: state.doc, spans: result.spans }) }).state;
  });
  const request = () => queue.request({ text: state.doc.toString(), path: "a.ts", theme, ranges: [{ from: 0, to: state.doc.length }] });
  request();
  const obsoleteDoc = state.doc;
  for (let i = 0; i < 75; i++) {
    state = state.update({ changes: { from: state.doc.length, insert: "a" } }).state;
    request();
  }
  assert.equal(state.doc.length, 76, "all keystrokes committed while the first analysis was still running");
  assert.equal(sent.length, 1);
  queue.receive({ id: sent[0].id, spans: [{ from: 0, to: 1, className: "old" }] });
  assert.deepEqual(accepted, []);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, state.doc.toString());
  queue.receive({ id: sent[1].id, spans: [{ from: 0, to: 76, className: "current" }] });
  assert.equal(state.field(paintedSyntax).size, 1);
  state = state.update({ effects: paintSyntax.of({ doc: obsoleteDoc, spans: [] }) }).state;
  assert.equal(state.field(paintedSyntax).size, 1, "a stale paint cannot overwrite current colors");
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), "x", "painting did not replace the document or disrupt edit history");
  request();
  queue.dispose();
  queue.receive({ id: sent.at(-1)!.id, spans: [] });
  assert.equal(accepted.length, 1, "late completions after unmount are ignored");
});

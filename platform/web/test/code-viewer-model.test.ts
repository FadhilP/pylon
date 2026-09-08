import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFilesPatch } from "diff";
import {
  attributedOwner,
  type CodeAttribution,
  diffRows,
  loadDiffContents,
  parseDiff,
  selectedText,
  sourceLines,
  validateDiffContents,
  type CodeLine,
  type DiffRow,
} from "../src/shared/code-viewer-model.ts";
import { loadSyntaxLanguage, setSyntaxTheme, syntaxTokens } from "../src/shared/syntax-highlighting.ts";

const patch = (before: string, after: string, context = 3) =>
  createTwoFilesPatch("a/example.ts", "b/example.ts", before, after, undefined, undefined, { context });
const code = (rows: DiffRow[]) => rows.filter((row): row is CodeLine => row.kind !== "gap" && row.kind !== "note");

test("attribution uses historical source coordinates for deleted and expanded unchanged lines", () => {
  const before = "base\none\nkeep\n";
  const after = "base\ntwo\nkeep\n";
  const [file] = parseDiff(patch(before, after, 0));
  const attribution: CodeAttribution = {
    oldOwners: [null, "one", "older"],
    newOwners: [null, "two", "older"],
    owners: new Map(["one", "two", "older"].map(id => [id, { id, kind: "checkpoint", title: id }])),
    selectable: new Set(["one", "two", "older"]),
  };
  const rows = code(
    diffRows(
      file,
      { 0: { start: 10, end: 10 }, 1: { start: 10, end: 10 } },
      { oldFile: { contents: before }, newFile: { contents: after } },
    ),
  );
  assert.equal(
    attributedOwner(
      rows.find(row => row.kind === "deletion")!,
      attribution,
    )?.id,
    "one",
  );
  assert.equal(
    attributedOwner(
      rows.find(row => row.kind === "addition")!,
      attribution,
    )?.id,
    "two",
  );
  assert.equal(attributedOwner({ kind: "context", text: "keep", newLine: 3, oldLine: 3 }, attribution)?.id, "older");
  assert.equal(attributedOwner({ kind: "context", text: "base", newLine: 1 }, attribution), undefined);
  assert.equal(attributedOwner({ kind: "note", text: "No newline" }, attribution), undefined);
});

test("maps additions, deletions and no-newline markers to actual source lines", () => {
  for (const [before, after] of [
    ["", "new\n"],
    ["old\n", ""],
    ["one\r\ntwo", "one\r\nthree"],
    ["a\n", "a\ninserted\n"],
  ]) {
    const [file] = parseDiff(patch(before, after));
    assert.ok(file);
    const contents = { oldFile: { contents: before }, newFile: { contents: after } };
    validateDiffContents(file, contents);
    const rows = code(diffRows(file, {}, contents));
    for (const row of rows) {
      if (row.oldLine) assert.equal(row.text, sourceLines(before)[row.oldLine - 1]);
      if (row.newLine) assert.equal(row.text, sourceLines(after)[row.newLine - 1]);
    }
    assert.deepEqual(
      rows.filter(row => row.newLine).map(row => row.text),
      sourceLines(after),
    );
    assert.deepEqual(
      rows.filter(row => row.oldLine).map(row => row.text),
      sourceLines(before),
    );
  }
  assert.equal(parseDiff(patch("old", "new"))[0].hunks[0].filter(row => row.kind === "note").length, 2);
});

test("expands context from both ends without duplicating lines or crossing the next hunk", () => {
  const before = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const after = before.replace("line 21\n", "changed 21\n").replace("line 81\n", "changed 81\n");
  const [file] = parseDiff(patch(before, after));
  const contents = { oldFile: { contents: before }, newFile: { contents: after } };
  validateDiffContents(file, contents);
  const initial = diffRows(file);
  assert.deepEqual(
    initial.filter(row => row.kind === "gap").map(row => row.count),
    [17, 53, undefined],
  );
  const partial = diffRows(file, { 1: { start: 15, end: 15 } }, contents);
  const gap = partial.find(row => row.kind === "gap" && row.id === 1);
  assert.ok(gap?.kind === "gap");
  assert.equal(gap.count, 23);
  const expanded = diffRows(
    file,
    { 0: { start: 999, end: 999 }, 1: { start: 999, end: 999 }, 2: { start: 999, end: 999 } },
    contents,
  );
  assert.equal(expanded.filter(row => row.kind === "gap").length, 0);
  assert.deepEqual(
    code(expanded)
      .filter(row => row.newLine)
      .map(row => row.text),
    sourceLines(after),
  );
  assert.deepEqual(
    code(expanded)
      .filter(row => row.oldLine)
      .map(row => row.text),
    sourceLines(before),
  );
});

test("rejects stale, unavailable and inconsistent context, including changes outside the hunks", () => {
  const available = { revision: "r1", state: "available", text: "old\n" };
  assert.deepEqual(loadDiffContents({ revision: "r1", base: available, current: available }).oldFile.contents, "old\n");
  assert.throws(() => loadDiffContents({ revision: "r2", base: available, current: available }), /Workspace changed/);
  assert.throws(
    () => loadDiffContents({ revision: "r1", base: { ...available, state: "oversized" }, current: available }),
    /unavailable/,
  );
  const before = "same\nold\ntail\n";
  const after = "same\nnew\ntail\n";
  const [file] = parseDiff(patch(before, after, 0));
  for (const text of [
    "same\nother\ntail\n",
    "changed\nnew\ntail\n",
    "same\nnew\nchanged\n",
    "same\nnew\ntail\n\n",
    "same\nnew\ntail",
  ]) {
    assert.throws(
      () => validateDiffContents(file, { oldFile: { contents: before }, newFile: { contents: text } }),
      /Workspace changed/,
    );
  }
});

test("preserves Git paths and metadata in multi-file patches, including quoted UTF-8", () => {
  const text = [
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/old name.ts b/new name.ts",
    "similarity index 100%",
    "rename from old name.ts",
    "rename to new name.ts",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/empty b/empty",
    "new file mode 100644",
    "index 0000000..e69de29",
    "diff --git a/icon.png b/icon.png",
    "index 1111111..2222222 100644",
    "Binary files a/icon.png and b/icon.png differ",
    "",
  ].join("\n");
  const files = parseDiff(text);
  assert.deepEqual(
    files.map(file => file.path),
    ["café.ts", "new name.ts", "run.sh", "empty", "icon.png"],
  );
  assert.equal(files[1].oldPath, "old name.ts");
  assert.equal(files[1].patch.isRename, true);
  assert.equal(files[2].patch.newMode, "100755");
  assert.equal(files[3].patch.isCreate, true);
  assert.equal(files[4].patch.isBinary, true);
});

test("falls back for incomplete patches instead of fabricating source coordinates", () => {
  assert.deepEqual(parseDiff("plain text"), []);
  assert.deepEqual(parseDiff("--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n+new\n"), []);
});

test("compares changed words without losing Unicode or spending unbounded work on minified lines", () => {
  const [file] = parseDiff(patch('const x = "😀 old";\n', 'const x = "😀 new";\n'));
  const removed = file.hunks[0].find(row => row.kind === "deletion")!;
  const added = file.hunks[0].find(row => row.kind === "addition")!;
  assert.equal(removed.changes?.map(range => removed.text.slice(range.start, range.end)).join(""), "old");
  assert.equal(added.changes?.map(range => added.text.slice(range.start, range.end)).join(""), "new");
  const [long] = parseDiff(patch("a".repeat(20_000), "b".repeat(20_000)));
  assert.equal(long.hunks[0][0].text.length, 20_000);
  assert.equal(long.hunks[0][0].changes, undefined);
});

test("copies selected source across virtualized rows without gutters, headers or context controls", () => {
  const [file] = parseDiff(patch("a\nold\nz\n", "a\nnew\nz\n"));
  const rows = [{ kind: "header", text: "example.ts" }, ...diffRows(file)];
  assert.equal(selectedText(rows, 999, 0), "a\nold\nnew\nz");
});

test("loads additional source grammars while preserving original text and sharing Markdown's theme", async () => {
  await loadSyntaxLanguage("rust");
  const source = 'let name = "<script>😀";';
  setSyntaxTheme("one-dark-pro");
  const dark = syntaxTokens(source, "rust");
  assert.equal(dark[0].map(token => token.content).join(""), source);
  assert.ok(dark[0].some(token => token.className));
  setSyntaxTheme("github-light");
  assert.notDeepEqual(syntaxTokens(source, "rust"), dark);
  await loadSyntaxLanguage("not-a-real-language");
  assert.equal(syntaxTokens(source, "not-a-real-language")[0][0].content, source);
});

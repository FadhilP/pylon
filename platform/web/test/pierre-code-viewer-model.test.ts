import assert from "node:assert/strict";
import test from "node:test";
import { createPierreDiffItems, createPierreLoadedDiffFiles } from "../src/shared/pierre-code-viewer-model.ts";
test("maps matching workspace revisions into full diff context", () => {
  const loaded = createPierreLoadedDiffFiles({
    path: "src/example.ts",
    revision: "revision-4",
    base: { revision: "revision-4", state: "available", text: "old\n" },
    current: { revision: "revision-4", state: "available", text: "new\n" },
  });
  assert.deepEqual(loaded, {
    oldFile: { name: "src/example.ts", contents: "old\n", cacheKey: "revision-4:src/example.ts:base" },
    newFile: { name: "src/example.ts", contents: "new\n", cacheKey: "revision-4:src/example.ts:current" },
  });
  assert.throws(
    () =>
      createPierreLoadedDiffFiles({
        path: "src/example.ts",
        revision: "revision-4",
        base: { revision: "revision-3", state: "available", text: "old\n" },
        current: { revision: "revision-4", state: "available", text: "new\n" },
      }),
    /Workspace changed/,
  );
  assert.throws(
    () =>
      createPierreLoadedDiffFiles({
        path: "src/example.ts",
        revision: "revision-4",
        base: { revision: "revision-4", state: "oversized" },
        current: { revision: "revision-4", state: "available", text: "new\n" },
      }),
    /unavailable/,
  );
});

test("keeps every file path when parsing a multi-file turn diff", () => {
  const items = createPierreDiffItems({
    id: "turn:entry-7",
    revision: "entry-7",
    text: [
      "diff --git a/src/first.ts b/src/first.ts",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -1 +1 @@",
      "-first",
      "+updated first",
      "diff --git a/docs/second.md b/docs/second.md",
      "--- a/docs/second.md",
      "+++ b/docs/second.md",
      "@@ -1 +1 @@",
      "-second",
      "+updated second",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    items.map(item => (item.type === "diff" ? item.fileDiff.name : undefined)),
    ["src/first.ts", "docs/second.md"],
  );
});

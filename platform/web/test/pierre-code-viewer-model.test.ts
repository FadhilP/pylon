import assert from "node:assert/strict";
import test from "node:test";
import { createPierreCodeViewItem, createPierreLoadedDiffFiles } from "../src/shared/pierre-code-viewer-model.ts";

test("maps files and unified patches into Pierre CodeView items", () => {
  const file = createPierreCodeViewItem({
    mode: "file",
    id: "selected",
    path: "src/example.ts",
    text: "export const value = 1;\n",
    revision: "revision-1",
  });
  assert.equal(file?.type, "file");
  if (file?.type === "file") {
    assert.equal(file.file.name, "src/example.ts");
    assert.equal(file.file.cacheKey, "revision-1:src/example.ts");
  }

  const diff = createPierreCodeViewItem({
    mode: "diff",
    id: "selected",
    path: "src/example.ts",
    revision: "revision-2",
    text: [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n"),
  });
  assert.equal(diff?.type, "diff");
  assert.equal(createPierreCodeViewItem({
    mode: "diff",
    id: "selected",
    path: "src/example.ts",
    text: "not a patch",
    revision: "revision-3",
  }), undefined);
});

test("maps matching workspace revisions into full diff context", () => {
  const loaded = createPierreLoadedDiffFiles({
    path: "src/example.ts",
    revision: "revision-4",
    base: { revision: "revision-4", state: "available", text: "old\n" },
    current: { revision: "revision-4", state: "available", text: "new\n" },
  });
  assert.deepEqual(loaded, {
    oldFile: {
      name: "src/example.ts",
      contents: "old\n",
      cacheKey: "revision-4:src/example.ts:base",
    },
    newFile: {
      name: "src/example.ts",
      contents: "new\n",
      cacheKey: "revision-4:src/example.ts:current",
    },
  });
  assert.throws(() => createPierreLoadedDiffFiles({
    path: "src/example.ts",
    revision: "revision-4",
    base: { revision: "revision-3", state: "available", text: "old\n" },
    current: { revision: "revision-4", state: "available", text: "new\n" },
  }), /Workspace changed/);
  assert.throws(() => createPierreLoadedDiffFiles({
    path: "src/example.ts",
    revision: "revision-4",
    base: { revision: "revision-4", state: "oversized" },
    current: { revision: "revision-4", state: "available", text: "new\n" },
  }), /unavailable/);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { searchWorkspace } from "../src/server/workspace/workspace-search.ts";
import type { WorkspaceSearchQuery, WorkspaceSearchResult } from "../src/shared/workspace/workspace-search.ts";

const has = (name: string) => !spawnSync(name, ["--version"]).error;
const engines = ["rg", "grep"] as const;
async function fixture(t: { after: (fn: () => Promise<void>) => void }, data: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-search-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(data)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  return cwd;
}

for (const engine of engines) {
  test(
    `${engine}: searches literals, case, words, globs and changed-file scope without interpreting filenames`,
    { skip: !has(engine) },
    async t => {
      const data = {
        "src/a.ts": "é😀 needle NEEDLE needles\nliteral.*\n",
        "src/b.txt": "needle\n",
        "-": "needle\n",
        "space name.ts": "needle\n",
      };
      const cwd = await fixture(t, data);
      const files = Object.keys(data).map(path => ({
        path,
        ...(path === "src/a.ts" ? { status: "modified" as const } : {}),
      }));
      const run = (input: WorkspaceSearchQuery) =>
        searchWorkspace({
          cwd,
          files,
          generation: 7,
          input,
          inventoryTruncated: false,
          signal: new AbortController().signal,
          executables: { rg: engine === "rg" ? "rg" : "pylon-rg-not-installed", grep: "grep" },
        });
      const all = await run({ query: "needle" });
      assert.equal(all.engine, engine);
      assert.deepEqual(new Set(all.files.map(file => file.path)), new Set(Object.keys(data)));
      const filtered = await run({
        query: "NEEDLE",
        caseSensitive: true,
        wholeWord: true,
        glob: "*.ts",
        touched: true,
      });
      assert.deepEqual(
        filtered.files.map(file => file.path),
        ["src/a.ts"],
      );
      assert.equal(filtered.files[0].matches[0].line, 1);
      if (engine === "rg") {
        const match = filtered.files[0].matches[0];
        assert.deepEqual(
          match.ranges.map(range => match.text.slice(range.start, range.end)),
          ["NEEDLE"],
        );
        const words = (await run({ query: "needle", wholeWord: true })).files.find(file => file.path === "src/a.ts")!
          .matches[0];
        assert.deepEqual(
          words.ranges.map(range => words.text.slice(range.start, range.end)),
          ["needle", "NEEDLE"],
        );
      }
      assert.equal((await run({ query: "literal.*" })).files[0].matches[0].line, 2);
      assert.equal((await run({ query: "^literal", regex: true })).files[0].matches[0].line, 2);
      await assert.rejects(run({ query: "[", regex: true }), /Search failed/);
    },
  );
}

test(
  "bounded search reports per-file/global caps and preserves earlier streamed results",
  { skip: !has("rg") },
  async t => {
    const data = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [`file-${index}.txt`, "hit\n".repeat(index === 0 ? 25 : 1)]),
    );
    const cwd = await fixture(t, data);
    const updates: WorkspaceSearchResult[] = [];
    const result = await searchWorkspace({
      cwd,
      files: Object.keys(data).map(path => ({ path })),
      generation: 1,
      input: { query: "hit" },
      inventoryTruncated: true,
      signal: new AbortController().signal,
      onUpdate: value => {
        updates.push(structuredClone(value));
      },
    });
    assert.equal(result.files.length, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.inventoryTruncated, true);
    assert.equal(result.files.find(file => file.path === "file-0.txt")?.matches.length, 20);
    assert.equal(result.files.find(file => file.path === "file-0.txt")?.capped, true);
    assert.ok(updates.length > 1);
    assert.deepEqual(result.files.slice(0, updates[0].files.length), updates[0].files);
  },
);

test("scope rejects escapes, links and oversized files even with grep fallback", { skip: !has("grep") }, async t => {
  const cwd = await fixture(t, { "ok.txt": "hit", "large.txt": "hit".repeat(180_000), "private/inside.txt": "hit" });
  const outside = await fixture(t, { "secret.txt": "hit" });
  await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  const result = await searchWorkspace({
    cwd,
    files: ["ok.txt", "large.txt", "../secret.txt", "linked/secret.txt"].map(path => ({ path })),
    generation: 1,
    input: { query: "hit" },
    inventoryTruncated: false,
    signal: new AbortController().signal,
    executables: { rg: "pylon-rg-not-installed", grep: "grep" },
  });
  assert.deepEqual(
    result.files.map(file => file.path),
    ["ok.txt"],
  );
  assert.equal(result.skipped, 3);
});

test(
  "cancellation stops subsequent batches and a deadline reports an incomplete search",
  { skip: !has("rg") },
  async t => {
    const cwd = await fixture(t, Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`${index}.txt`, "hit"])));
    const files = Array.from({ length: 70 }, (_, index) => ({ path: `${index}.txt` }));
    const controller = new AbortController();
    let batches = 0;
    await assert.rejects(
      searchWorkspace({
        cwd,
        files,
        generation: 1,
        input: { query: "hit" },
        inventoryTruncated: false,
        signal: controller.signal,
        onUpdate: () => {
          batches++;
          controller.abort(new Error("stopped"));
        },
      }),
      /stopped/,
    );
    assert.equal(batches, 1);
    const expired = await searchWorkspace({
      cwd,
      files,
      generation: 1,
      input: { query: "hit" },
      inventoryTruncated: false,
      signal: new AbortController().signal,
      timeoutMs: 1,
    });
    assert.equal(expired.timedOut, true);
    assert.ok(expired.files.length < files.length);
  },
);

test("missing engines and invalid input do not become no-match results", async t => {
  const cwd = await fixture(t, { "a.txt": "hit" });
  const base = {
    cwd,
    files: [{ path: "a.txt" }],
    generation: 1,
    inventoryTruncated: false,
    signal: new AbortController().signal,
    executables: { rg: "pylon-rg-not-installed", grep: "pylon-grep-not-installed" },
  };
  await assert.rejects(searchWorkspace({ ...base, input: { query: "hit" } }), /neither ripgrep nor grep/);
  await assert.rejects(searchWorkspace({ ...base, input: { query: "a\nb" } }), /Invalid workspace search/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(searchWorkspace({ ...base, signal: controller.signal, input: { query: "hit" } }), /cancelled/);
});

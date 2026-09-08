import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { applyPatch, parsePatch } from "diff";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FileHistoryReader, carryHistoryOwners } from "../src/server/pi/file-history.ts";
import type { FileHistoryContext, HistoryTree } from "pylon-core/src/file-history.ts";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pylon-file-history-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "History Author");
  await git("config", "user.email", "history@example.test");
  await git("config", "core.autocrlf", "false");
  await writeFile(join(root, "old name.txt"), "baseline\nkeep\n");
  await git("add", ".");
  await git("commit", "-qm", "Create file");
  const origin = await git("rev-parse", "HEAD");
  const commonDir = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const tree = async (): Promise<HistoryTree> => ({
    path: "",
    tree: await git("write-tree"),
    head: await git("rev-parse", "HEAD"),
    commonDir,
  });
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, git, tree, origin, cleanup };
}

test("session versions preserve dirty baseline, EOF bytes and deleted-line attribution without modifying Git", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\npreexisting\n");
    await f.git("add", ".");
    const baseline = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "baseline\nturn one\nkeep\npreexisting\n");
    await f.git("add", ".");
    const first = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\npreexisting\nturn two");
    await f.git("add", ".");
    const second = await f.tree();
    const context: FileHistoryContext = {
      sessionId: "s",
      baseline,
      partial: false,
      checkpoints: [
        { id: "s:one", title: "First turn", createdAt: "2026-01-01", verification: "passed", snapshot: first },
        { id: "s:two", title: "Second turn", createdAt: "2026-01-02", verification: "unverified", snapshot: second },
      ],
    };
    const reader = new FileHistoryReader();
    const input = { cwd: f.root, sessionId: "s", context };
    const before = await f.git("status", "--porcelain=v1");
    const refs = await f.git("show-ref");
    const objects = await f.git("count-objects", "-v");
    const file = await reader.read({ ...input, query: { path: "old name.txt", scope: "session", selected: "s:two" } });
    assert.equal(file.content?.text, "baseline\nkeep\npreexisting\nturn two");
    assert.deepEqual(file.content?.newOwners, [null, null, null, "s:two"]);
    const change = await reader.read({
      ...input,
      query: { path: "old name.txt", scope: "session", selected: "s:two", view: "change" },
    });
    assert.deepEqual(change.content?.oldOwners, [null, "s:one", null, null]);
    assert.match(change.content?.text ?? "", /-turn one/);
    const all = await reader.read({ ...input, query: { path: "old name.txt", scope: "all", selected: "s:two" } });
    assert.deepEqual(all.content?.newOwners, [`git:${f.origin}`, `git:${f.origin}`, null, "s:two"]);
    assert.equal(await f.git("status", "--porcelain=v1"), before);
    assert.equal(await f.git("show-ref"), refs);
    assert.equal(await f.git("count-objects", "-v"), objects);
    await assert.rejects(
      reader.read({ ...input, query: { path: "old name.txt", scope: "session", selected: "s:other-branch" } }),
      /unavailable/,
    );
  } finally {
    await f.cleanup();
  }
});

test("Git history follows committed renames and loads original content and authors", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "folder"));
    await rename(join(f.root, "old name.txt"), join(f.root, "folder", "new name.txt"));
    await f.git("add", "-A");
    await f.git("commit", "-qm", "Move file");
    const moved = await f.git("rev-parse", "HEAD");
    await writeFile(join(f.root, "folder", "new name.txt"), "baseline\nkeep\nlast\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Add line");
    const reader = new FileHistoryReader();
    const input = { cwd: f.root, sessionId: "s" };
    const list = await reader.read({ ...input, query: { path: "folder/new name.txt", scope: "all", limit: 1 } });
    assert.equal(list.stops.length, 1);
    assert.equal(list.hasMore, true);
    const file = await reader.read({
      ...input,
      query: { path: "folder/new name.txt", scope: "all", selected: `git:${f.origin}` },
    });
    assert.equal(file.stops[0].path, "old name.txt");
    assert.equal(file.content?.text, "baseline\nkeep\n");
    assert.deepEqual(file.content?.newOwners, [`git:${f.origin}`, `git:${f.origin}`]);
    assert.equal(file.content?.owners[0].author, "History Author");
    const change = await reader.read({
      ...input,
      query: { path: "folder/new name.txt", scope: "all", selected: `git:${moved}`, view: "change" },
    });
    assert.equal(change.content?.before, change.content?.after);
    assert.equal(applyPatch(change.content!.before!, parsePatch(change.content!.text!)[0]), change.content!.after);
    await writeFile(join(f.root, "old name.txt"), "a completely different file\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Reuse old path");
    const originalDiff = await reader.read({
      ...input,
      query: { path: "folder/new name.txt", scope: "all", selected: `git:${f.origin}`, view: "diff" },
    });
    const patches = parsePatch(originalDiff.content!.text!);
    assert.equal(patches.length, 1);
    assert.equal(originalDiff.content!.before, "");
    assert.equal(originalDiff.content!.after, file.content!.text);
    assert.equal(applyPatch(originalDiff.content!.before!, patches[0]), file.content!.text);
    assert.deepEqual(originalDiff.content!.newOwners, file.content!.newOwners);
  } finally {
    await f.cleanup();
  }
});

test("Git Diff shows the selected commit's change despite newer commits and a dirty session baseline", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nselected\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Selected change");
    const selected = await f.git("rev-parse", "HEAD");
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nselected\nnewer\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Newer change");
    const latest = await f.git("rev-parse", "HEAD");
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nselected\nnewer\npreexisting\n");
    await f.git("add", ".");
    const baseline = await f.tree();
    const reader = new FileHistoryReader();
    const input = { cwd: f.root, sessionId: "s", baselineTree: baseline.tree };
    const query = { path: "old name.txt", scope: "all" as const, selected: `git:${selected}` };
    const file = await reader.read({ ...input, query });
    const diff = await reader.read({ ...input, query: { ...query, view: "diff" } });
    assert.equal(diff.content?.before, "baseline\nkeep\n");
    assert.equal(diff.content?.after, file.content?.text);
    assert.equal(applyPatch(diff.content!.before!, parsePatch(diff.content!.text!)[0]), file.content!.text);
    assert.deepEqual(diff.content?.oldOwners, [`git:${f.origin}`, `git:${f.origin}`]);
    assert.deepEqual(diff.content?.newOwners, file.content?.newOwners);
    assert.deepEqual(diff.content?.newOwners, [`git:${f.origin}`, `git:${f.origin}`, `git:${selected}`]);
    const change = await reader.read({ ...input, query: { ...query, view: "change" } });
    assert.deepEqual(change.content, diff.content);
    // Visiting a different stop must not change the cached selected-commit diff.
    await reader.read({ ...input, query: { ...query, selected: `git:${latest}`, view: "diff" } });
    assert.deepEqual(await reader.read({ ...input, query: { ...query, view: "diff" } }), diff);
  } finally {
    await f.cleanup();
  }
});

test("history refuses unsafe paths and another session's context", async () => {
  const reader = new FileHistoryReader();
  for (const path of ["../secret", "C:/secret", "/secret", "dir\\secret", "file\0suffix", "file\nname", "a//b"])
    await assert.rejects(
      reader.read({ cwd: ".", sessionId: "s", query: { path, scope: "all" } }),
      /Invalid history path/,
    );
  await assert.rejects(
    reader.read({
      cwd: ".",
      sessionId: "s",
      context: { sessionId: "other", checkpoints: [], partial: false },
      query: { path: "file", scope: "all" },
    }),
    /owner/,
  );
  assert.throws(
    () => carryHistoryOwners({ text: "a\n", ids: [null], owners: [], complete: true }, "b\n", "", "x"),
    /patch/,
  );
});

test("synthetic baselines remain separate from project commits and preexisting edits have no false author", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\ndirty before session\n");
    await f.git("add", ".");
    const baseline = await f.tree();
    const commit = await f.git("commit-tree", baseline.tree, "-p", f.origin, "-m", "Pylon session baseline");
    const reader = new FileHistoryReader();
    const result = await reader.read({
      cwd: f.root,
      sessionId: "s",
      baselineTree: baseline.tree,
      baselineCommit: commit,
      query: { path: "old name.txt", scope: "all", selected: "baseline" },
    });
    assert.deepEqual(
      result.stops.map(stop => stop.id),
      [`git:${f.origin}`],
    );
    assert.deepEqual(result.content?.newOwners, [`git:${f.origin}`, `git:${f.origin}`, null]);
    await assert.rejects(
      reader.read({
        cwd: f.root,
        sessionId: "s",
        baselineTree: baseline.head,
        baselineCommit: commit,
        query: { path: "old name.txt", scope: "all" },
      }),
      /Invalid registered/,
    );
  } finally {
    await f.cleanup();
  }
});

test("deletion, empty recreation, CRLF, BOM, binary and oversized versions remain bounded and byte-correct", async () => {
  const f = await fixture();
  try {
    const baseline = await f.tree();
    const context: FileHistoryContext = { sessionId: "s", baseline, partial: false, checkpoints: [] };
    const states = [
      undefined,
      "",
      "\ufefffirst\r\nsecond",
      "\ufefffirst\r\nchanged\r\n",
      Buffer.from([0, 1, 2]),
      "x".repeat(1024 * 1024 + 1),
    ];
    for (const [index, text] of states.entries()) {
      if (text === undefined) await rm(join(f.root, "old name.txt"));
      else await writeFile(join(f.root, "old name.txt"), text);
      await f.git("add", "-A");
      context.checkpoints.push({
        id: `s:c${index}`,
        title: "Change",
        createdAt: String(index),
        verification: "unverified",
        snapshot: await f.tree(),
      });
    }
    const reader = new FileHistoryReader();
    const read = (index: number, view: "file" | "change" = "file") =>
      reader.read({
        cwd: f.root,
        sessionId: "s",
        context,
        query: { path: "old name.txt", scope: "session", selected: `s:c${index}`, view },
      });
    assert.equal((await read(0)).content?.state, "deleted");
    assert.equal((await read(1)).content?.text, "");
    const crlf = await read(3);
    assert.equal(crlf.content?.text, states[3]);
    assert.deepEqual(crlf.content?.newOwners, ["s:c2", "s:c3"]);
    const change = await read(3, "change");
    assert.equal(
      applyPatch(change.content!.before!, parsePatch(change.content!.text!)[0], { autoConvertLineEndings: false }),
      states[3],
    );
    assert.equal((await read(4)).content?.state, "binary");
    assert.equal((await read(5)).content?.state, "oversized");
  } finally {
    await f.cleanup();
  }
});

test("gaps and truncated checkpoint windows never attribute earlier changes to a later turn", async () => {
  const f = await fixture();
  try {
    const baseline = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "older omitted work\n");
    await f.git("add", ".");
    const seed = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "older omitted work\nnew work\n");
    await f.git("add", ".");
    const latest = await f.tree();
    const context: FileHistoryContext = {
      sessionId: "s",
      baseline,
      seed,
      partial: true,
      checkpoints: [{ id: "s:last", title: "Last", createdAt: "1", verification: "unverified", snapshot: latest }],
    };
    const reader = new FileHistoryReader();
    const query = { path: "old name.txt", scope: "session" as const, selected: "s:last" };
    const result = await reader.read({ cwd: f.root, sessionId: "s", context, query });
    assert.deepEqual(result.content?.newOwners, [null, "s:last"]);
    assert.equal(result.content?.attributionComplete, false);
    context.seed = { ...seed, tree: "1".repeat(40) };
    const gap = await reader.read({ cwd: f.root, sessionId: "s", context, query });
    assert.deepEqual(gap.content?.newOwners, [null, null]);
    assert.equal(gap.content?.text, "older omitted work\nnew work\n");
    assert.equal(gap.content?.attributionComplete, false);
    const legacy: FileHistoryContext = {
      sessionId: "s",
      partial: false,
      checkpoints: [
        { id: "s:old", title: "Old capture", createdAt: "0", verification: "unverified", snapshot: seed },
        context.checkpoints[0],
      ],
    };
    const old = await reader.read({ cwd: f.root, sessionId: "s", context: legacy, query });
    assert.deepEqual(old.content?.newOwners, [null, "s:last"]);
    assert.equal(old.partial, true);
  } finally {
    await f.cleanup();
  }
});

test("200 checkpoints batch object reads, skip unchanged diffs, share concurrent requests and isolate cancellation", async () => {
  const f = await fixture();
  const original = childProcess.execFile;
  try {
    const baseline = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nfirst\n");
    await f.git("add", ".");
    const first = await f.tree();
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nfirst\nlast\n");
    await f.git("add", ".");
    const last = await f.tree();
    const context: FileHistoryContext = {
      sessionId: "s",
      baseline,
      partial: false,
      checkpoints: Array.from({ length: 200 }, (_, i) => ({
        id: `s:c${i}`,
        title: "Change",
        createdAt: String(i),
        verification: "unverified",
        snapshot: i === 199 ? last : first,
      })),
    };
    const calls: string[][] = [];
    childProcess.execFile = ((...args: any[]) => {
      calls.push(args[1]);
      return Reflect.apply(original, childProcess, args);
    }) as typeof execFile;
    syncBuiltinESMExports();
    const reader = new FileHistoryReader();
    const input = {
      cwd: f.root,
      sessionId: "s",
      context,
      query: { path: "old name.txt", scope: "session" as const, selected: "s:c199" },
    };
    const controller = new AbortController();
    const one = reader.read(input, controller.signal);
    const two = reader.read(input);
    controller.abort();
    await assert.rejects(one, /abort/i);
    const result = await two;
    assert.deepEqual(result.content?.newOwners, [null, null, "s:c0", "s:c199"]);
    assert.equal(calls.filter(args => args.includes("diff")).length, 2);
    assert.equal(calls.filter(args => args.includes("--batch")).length, 1);
    assert.equal(calls.filter(args => args.some(arg => arg.startsWith("--batch-check"))).length, 1);
    calls.length = 0;
    assert.deepEqual(await reader.read(input), result);
    assert.equal(calls.filter(args => args.includes("diff") || args.includes("cat-file")).length, 0);
    const cancelled = new AbortController();
    const abandoned = reader.read({ ...input, query: { ...input.query, selected: "s:c0" } }, cancelled.signal);
    cancelled.abort();
    await assert.rejects(abandoned, /abort/i);
    // The sole consumer's process has been reaped and its work slot is immediately reusable.
    assert.deepEqual(await reader.read(input), result);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test("first-parent history and blame attribute a merged change at its integration point", async () => {
  const f = await fixture();
  try {
    const main = await f.git("symbolic-ref", "--short", "HEAD");
    await f.git("checkout", "-qb", "feature");
    await writeFile(join(f.root, "old name.txt"), "baseline\nkeep\nfeature work\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Feature change");
    const feature = await f.git("rev-parse", "HEAD");
    await f.git("checkout", "-q", main);
    await writeFile(join(f.root, "other.txt"), "unrelated\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "Main work");
    await f.git("merge", "--no-ff", "feature", "-m", "Integrate feature");
    const merge = await f.git("rev-parse", "HEAD");
    const result = await new FileHistoryReader().read({
      cwd: f.root,
      sessionId: "s",
      query: { path: "old name.txt", scope: "all", selected: `git:${merge}` },
    });
    assert.equal(
      result.stops.some(stop => stop.id === `git:${feature}`),
      false,
    );
    assert.deepEqual(result.content?.newOwners, [`git:${f.origin}`, `git:${f.origin}`, `git:${merge}`]);
  } finally {
    await f.cleanup();
  }
});

test("nested repository history reads its own snapshots and fails closed on incompatible ownership", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "nested");
    await mkdir(root);
    const child = (...args: string[]) => f.git("-C", root, ...args);
    await child("init", "-q");
    await child("config", "user.name", "Child Author");
    await child("config", "user.email", "child@example.test");
    await writeFile(join(root, "value.txt"), "child baseline\n");
    await child("add", ".");
    await child("commit", "-qm", "Child start");
    const head = await child("rev-parse", "HEAD");
    const commonDir = await child("rev-parse", "--path-format=absolute", "--git-common-dir");
    const baseline = {
      ...(await f.tree()),
      repositories: [{ path: "nested", head, commonDir, tree: await child("write-tree") }],
    };
    await writeFile(join(root, "value.txt"), "child baseline\nturn\n");
    await child("add", ".");
    const snapshot = {
      ...baseline,
      repositories: [{ path: "nested", head, commonDir, tree: await child("write-tree") }],
    };
    const context: FileHistoryContext = {
      sessionId: "s",
      baseline,
      partial: false,
      checkpoints: [{ id: "s:child", title: "Child edit", createdAt: "1", verification: "unverified", snapshot }],
    };
    const reader = new FileHistoryReader();
    const query = { path: "nested/value.txt", scope: "all" as const, selected: "s:child" };
    const result = await reader.read({ cwd: f.root, sessionId: "s", context, query });
    assert.equal(result.content?.text, "child baseline\nturn\n");
    assert.deepEqual(result.content?.newOwners, [`git:${head}`, "s:child"]);
    assert.equal(result.stops[0].id, `git:${head}`);
    context.checkpoints[0].snapshot = {
      ...snapshot,
      repositories: [{ ...snapshot.repositories[0], commonDir: f.root }],
    };
    const unavailable = await reader.read({ cwd: f.root, sessionId: "s", context, query });
    assert.equal(unavailable.content?.state, "unavailable");
  } finally {
    await f.cleanup();
  }
});

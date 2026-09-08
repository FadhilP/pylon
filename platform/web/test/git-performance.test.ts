import assert from "node:assert/strict";
import test from "node:test";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitState, readGitDetail, runGitAction } from "../src/server/workspace/git.ts";
import { GitReadPool } from "../src/server/workspace/git-reads.ts";

const exec = promisify(cp.execFile);
async function fixture(count = 20) {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-git-perf-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await git("config", "core.autocrlf", "false");
  const paths = Array.from({ length: count }, (_, i) => `file-${i}.txt`);
  await Promise.all(paths.map(path => writeFile(join(cwd, path), "before\n")));
  await git("add", ".");
  await git("commit", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  await Promise.all(paths.map(path => writeFile(join(cwd, path), "after\n")));
  return {
    cwd,
    git,
    paths,
    base,
    close: () => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
async function observe<T>(run: () => Promise<T>, fail?: string) {
  const original = cp.spawn;
  const calls: string[][] = [];
  cp.spawn = ((command: string, args: string[], options: any) => {
    if (command === "git") {
      calls.push(args);
      if (fail && args.includes(fail)) return original(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return original(command, args, options);
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  try {
    return { result: await run(), calls };
  } finally {
    cp.spawn = original;
    syncBuiltinESMExports();
  }
}
const commands = (calls: string[][], command: string) => calls.filter(args => args.includes(command));

test("bulk staging batches validation, does no history/diff display work, and preserves saved content", async () => {
  const f = await fixture();
  try {
    const initial = await readGitState(f.cwd);
    await f.git("update-ref", "refs/pi-timeline/unrelated", f.base);
    const one = await observe(() =>
      runGitAction(f.cwd, { action: "stage", expectedRevision: initial.revision!, paths: [f.paths[0]] }),
    );
    await runGitAction(f.cwd, {
      action: "unstage",
      expectedRevision: (await readGitState(f.cwd)).revision!,
      paths: [f.paths[0]],
      confirmed: true,
    });
    const revision = (await readGitState(f.cwd)).revision!;
    const bulk = await observe(() =>
      runGitAction(f.cwd, { action: "stage", expectedRevision: revision, paths: f.paths }),
    );
    assert.ok(bulk.calls.length <= one.calls.length + 2, "process count must not grow per selected file");
    for (const command of ["ls-files", "ls-tree", "check-attr", "add"])
      assert.equal(commands(bulk.calls, command).length, 1, command);
    assert.equal(commands(bulk.calls, "log").length, 0);
    assert.equal(commands(bulk.calls, "diff").length, 0);
    assert.equal((await f.git("diff", "--cached", "--name-only")).split("\n").length, f.paths.length);
    assert.equal(await f.git("diff", "--name-only"), "");
    const staged = await readGitState(f.cwd);
    await writeFile(join(f.cwd, f.paths[0]), "external change\n");
    await assert.rejects(
      runGitAction(f.cwd, { action: "unstage", expectedRevision: staged.revision!, paths: f.paths, confirmed: true }),
      /changed|refresh/i,
    );
  } finally {
    await f.close();
  }
});

test("failed batch inspection cannot authorize staging or destructive discard", async () => {
  const f = await fixture(2);
  try {
    const revision = (await readGitState(f.cwd)).revision!;
    for (const failure of ["ls-files", "check-attr"]) {
      await assert.rejects(
        observe(() => runGitAction(f.cwd, { action: "stage", expectedRevision: revision, paths: f.paths }), failure),
      );
      await assert.rejects(
        observe(
          () =>
            runGitAction(f.cwd, {
              action: "discard",
              expectedRevision: revision,
              paths: f.paths,
              scope: "all",
              confirmed: true,
            }),
          failure,
        ),
      );
    }
    assert.equal(await f.git("diff", "--cached", "--name-only"), "");
    assert.equal((await f.git("diff", "--name-only")).split("\n").length, 2);
  } finally {
    await f.close();
  }
});

test("historical detail hydrates only the selected file, caches blobs but rechecks attributes and authorization", async () => {
  const f = await fixture();
  try {
    await f.git("add", ".");
    await f.git("commit", "-m", "twenty files");
    const oid = await f.git("rev-parse", "HEAD");
    const query = { kind: "commit" as const, oid, path: f.paths[7] };
    const first = await observe(() => readGitDetail(f.cwd, query));
    assert.equal(first.result.files.length, f.paths.length);
    assert.deepEqual(
      first.result.files.filter(file => file.afterText !== undefined).map(file => file.path),
      [query.path],
    );
    assert.equal(first.result.files.find(file => file.path === query.path)?.afterText, "after\n");
    assert.ok(commands(first.calls, "cat-file").length <= 3, "no per-changeset-file blob reads");
    const again = await observe(() => readGitDetail(f.cwd, query));
    assert.equal(again.calls.filter(args => args.includes("cat-file") && args.includes("blob")).length, 0);
    assert.equal(again.result.unifiedDiff, first.result.unifiedDiff);
    await writeFile(join(f.cwd, ".gitattributes"), `${query.path} binary\n`);
    const binary = await readGitDetail(f.cwd, query);
    assert.match(binary.unifiedDiff, /Binary files|GIT binary patch/);
    assert.notEqual(binary.revision, first.result.revision);
    await rm(join(f.cwd, ".gitattributes"));
    const originalBlob = await f.git("rev-parse", `${oid}:${query.path}`);
    await writeFile(join(f.cwd, "replacement.txt"), "replacement\n");
    const replacementBlob = await f.git("hash-object", "-w", "replacement.txt");
    await f.git("replace", originalBlob, replacementBlob);
    assert.equal(
      (await readGitDetail(f.cwd, query)).files.find(file => file.path === query.path)?.afterText,
      "replacement\n",
    );
    await f.git("replace", "-d", originalBlob);
    await f.git("update-ref", "refs/pi-timeline/keep", oid);
    await f.git("reset", "--hard", f.base);
    await assert.rejects(readGitDetail(f.cwd, query), /reachable/);
  } finally {
    await f.close();
  }
});

test("Git read sharing isolates cancellation, never caches mutable state, and bounds output/deadline", async () => {
  const f = await fixture(2);
  const pool = new GitReadPool();
  try {
    let loads = 0;
    const load = () => {
      loads++;
      return readGitState(f.cwd);
    };
    const controller = new AbortController();
    const one = pool.read(f.cwd, "state", load, controller.signal);
    const two = pool.read(f.cwd, "state", load);
    controller.abort();
    await assert.rejects(one, /abort|cancel/i);
    const before = await two;
    assert.equal(loads, 1);
    assert.equal(before.available, true);
    await writeFile(join(f.cwd, f.paths[0]), "new bytes\n");
    const after = await pool.read(f.cwd, "state", load);
    assert.equal(loads, 2);
    assert.notEqual(after.revision, before.revision);
    const tiny = new GitReadPool(12_000, 1);
    await assert.rejects(tiny.read(f.cwd, "state", load), /limit|exceeded/i);
    await tiny.dispose();
    const expired = new GitReadPool(1);
    await assert.rejects(expired.read(f.cwd, "state", load), /deadline|abort|limit/i);
    await expired.dispose();
    const sole = new AbortController();
    const cancelled = pool.read(f.cwd, "state", load, sole.signal);
    sole.abort();
    await assert.rejects(cancelled, /abort|cancel/i);
    assert.equal(
      (await pool.read(f.cwd, "state", load)).available,
      true,
      "last consumer releases its slot after reaping",
    );
  } finally {
    await pool.dispose();
    await f.close();
  }
});

test("invalidating in-flight Git reads prevents a post-mutation reader joining an older observation", async () => {
  const pool = new GitReadPool();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  try {
    const before = pool.read(".", "state", async () => {
      await gate;
      return "old";
    });
    pool.invalidate();
    const after = pool.read(".", "state", async () => "new");
    assert.equal(await after, "new");
    release();
    assert.equal(await before, "old");
  } finally {
    release();
    await pool.dispose();
  }
});


test("changing an older stash invalidates approval even when the stash tip is unchanged", async () => {
  const f = await fixture(1);
  try {
    await f.git("stash", "push", "-m", "older");
    await writeFile(join(f.cwd, f.paths[0]), "newer\n");
    await f.git("stash", "push", "-m", "newer");
    const before = await readGitState(f.cwd), top = before.stashes[0];
    await f.git("stash", "drop", "stash@{1}");
    assert.equal((await readGitState(f.cwd)).stashes[0].oid, top.oid);
    await assert.rejects(runGitAction(f.cwd, { action: "stashDrop", expectedRevision: before.revision!, oid: top.oid, selector: top.selector, confirmed: true }), /changed|refresh/i);
    assert.equal((await readGitState(f.cwd)).stashes.length, 1);
  } finally { await f.close(); }
});

test("batched remote configuration preserves case-sensitive dotted branch and remote subsections", async () => {
  const f = await fixture(1), remote = `${f.cwd}-remote`;
  try {
    await f.git("branch", "-m", "Main.Topic");
    await f.git("init", "--bare", remote);
    await f.git("remote", "add", "Up.Stream", remote);
    await f.git("config", "branch.main.topic.remote", "wrong-remote");
    await f.git("push", "-u", "Up.Stream", "HEAD:refs/heads/Main.Topic");
    const before = await readGitState(f.cwd);
    await runGitAction(f.cwd, { action: "push", expectedRevision: before.revision!, confirmed: true });
    assert.equal((await exec("git", ["rev-parse", "refs/heads/Main.Topic"], { cwd: remote })).stdout.trim(), f.base);
  } finally { await f.close(); await rm(remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

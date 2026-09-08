import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readGitDetail, readGitState, runGitAction } from "../src/server/workspace/git.ts";
import { reconstructConflictText } from "../src/client/workspace/git-review-model.ts";
const cleanup = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const run = promisify(execFile);
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "pylon-git-workspace-"));
  const git = (...args: string[]) => run("git", args, { cwd });
  await git("init");
  await git("config", "core.autocrlf", "false");
  await git("config", "user.name", "Test User");
  await git("config", "user.email", "test@example.test");
  return { cwd, git };
}
async function state(cwd: string) {
  const value = await readGitState(cwd);
  assert.equal(value.available, true);
  assert.ok(value.revision);
  return value as typeof value & { revision: string };
}

test("partial staging and commit preserve unstaged work, and stale actions are rejected", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "one\n");
    await writeFile(join(cwd, "b.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "two\n");
    await writeFile(join(cwd, "b.txt"), "two\n");
    const first = await state(cwd);
    await runGitAction(cwd, { action: "stage", expectedRevision: first.revision, paths: ["a.txt"] });
    const staged = await state(cwd);
    await runGitAction(cwd, { action: "commit", expectedRevision: staged.revision, message: "only a" });
    assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "two\n");
    await assert.rejects(
      runGitAction(cwd, { action: "stage", expectedRevision: first.revision, paths: ["b.txt"] }),
      /changed/i,
    );
  } finally {
    await cleanup(cwd);
  }
});

test("range diff includes the oldest commit, including a root commit", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "root.txt"), "root\n");
    await git("add", ".");
    await git("commit", "-m", "root");
    const oldest = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(cwd, "later.txt"), "later\n");
    await git("add", ".");
    await git("commit", "-m", "later");
    const newest = (await git("rev-parse", "HEAD")).stdout.trim();
    const detail = await readGitDetail(cwd, { kind: "range", oldest, newest });
    assert.equal(detail.selectedPath, "later.txt");
    assert.match(detail.unifiedDiff, /later\.txt/);
    const selected = await readGitDetail(cwd, { kind: "range", oldest, newest, path: "root.txt" });
    assert.equal(selected.selectedPath, "root.txt");
    assert.match(selected.unifiedDiff, /root\.txt/);
  } finally {
    await cleanup(cwd);
  }
});

test("stash pop/drop require the currently selected stash identity", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "stash one\n");
    let current = await state(cwd);
    await runGitAction(cwd, {
      action: "stash",
      expectedRevision: current.revision,
      includeUntracked: false,
      message: "one",
      confirmed: true,
    });
    current = await state(cwd);
    const selected = current.stashes[0]!;
    await writeFile(join(cwd, "a.txt"), "stash two\n");
    current = await state(cwd);
    await runGitAction(cwd, {
      action: "stash",
      expectedRevision: current.revision,
      includeUntracked: false,
      message: "two",
      confirmed: true,
    });
    current = await state(cwd);
    await assert.rejects(
      runGitAction(cwd, {
        action: "stashDrop",
        expectedRevision: current.revision,
        oid: selected.oid,
        selector: selected.selector,
        confirmed: true,
      }),
      /stash changed/i,
    );
  } finally {
    await cleanup(cwd);
  }
});

test("text conflict resolution stages the saved result and can continue a cherry-pick", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    const baseBranch = (await git("branch", "--show-current")).stdout.trim();
    await git("checkout", "-b", "topic");
    await writeFile(join(cwd, "a.txt"), "topic\n");
    await git("commit", "-am", "topic");
    const topic = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", baseBranch);
    await writeFile(join(cwd, "a.txt"), "main\n");
    await git("commit", "-am", "main");
    await assert.rejects(git("cherry-pick", topic));
    const current = await state(cwd);
    assert.equal(current.operation?.kind, "cherry-pick");
    const detail = await readGitDetail(cwd, { kind: "conflict", path: "a.txt" });
    await runGitAction(cwd, {
      action: "resolve",
      expectedRevision: current.revision,
      path: "a.txt",
      expectedVersion: detail.conflict!.version,
      text: "resolved\n",
      confirmed: true,
    });
    const after = await state(cwd);
    await runGitAction(cwd, {
      action: "continue",
      expectedRevision: after.revision,
      operation: "cherry-pick",
      confirmed: true,
    });
    assert.equal((await readFile(join(cwd, "a.txt"), "utf8")).replaceAll("\r\n", "\n"), "resolved\n");
  } finally {
    await cleanup(cwd);
  }
});

test("rebase abort rejects changed operation metadata before restoring the original branch", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    const baseBranch = (await git("branch", "--show-current")).stdout.trim();
    await git("checkout", "-b", "topic");
    await writeFile(join(cwd, "a.txt"), "topic\n");
    await git("commit", "-am", "topic");
    await git("checkout", baseBranch);
    await writeFile(join(cwd, "a.txt"), "main\n");
    await git("commit", "-am", "main");
    await git("checkout", "topic");
    await assert.rejects(git("rebase", baseBranch));
    const current = await state(cwd);
    assert.equal(current.operation?.kind, "rebase");
    assert.ok(current.operation?.step);
    assert.ok(current.operation?.total);
    assert.ok(current.operation?.onto);
    const originalHeadPath = join(cwd, ".git", "rebase-merge", "orig-head");
    const originalHead = await readFile(originalHeadPath);
    await writeFile(originalHeadPath, `${current.operation!.onto}\n`);
    await assert.rejects(
      runGitAction(cwd, { action: "abort", expectedRevision: current.revision, operation: "rebase", confirmed: true }),
      /changed|stale/i,
    );
    assert.equal((await state(cwd)).operation?.kind, "rebase");
    await writeFile(originalHeadPath, originalHead);
    await runGitAction(cwd, {
      action: "abort",
      expectedRevision: current.revision,
      operation: "rebase",
      confirmed: true,
    });
    assert.equal((await state(cwd)).operation, undefined);
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "topic");
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "topic\n");
  } finally {
    await cleanup(cwd);
  }
});

test("Git paths cannot escape the repository", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    const current = await state(cwd);
    await assert.rejects(
      runGitAction(cwd, { action: "stage", expectedRevision: current.revision, paths: ["../outside"] } as any),
      /Invalid Git action|path/i,
    );
  } finally {
    await cleanup(cwd);
  }
});

test("NUL-delimited logs, refs, stashes, and every detail query retain multiple records", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "one");
    await writeFile(join(cwd, "a.txt"), "two\n");
    await git("commit", "-am", "two");
    await writeFile(join(cwd, "b.txt"), "three\n");
    await git("add", "b.txt");
    await git("commit", "-m", "three");
    await git("branch", "older", "HEAD~1");
    await git("branch", "another");
    for (const value of ["stash one\n", "stash two\n", "stash three\n"]) {
      await writeFile(join(cwd, "a.txt"), value);
      await git("stash", "push", "-m", value.trim());
    }
    const current = await state(cwd);
    assert.ok(current.history.length >= 3);
    assert.ok(current.branches.length >= 3);
    assert.equal(current.stashes.length, 3);
    const commit = await readGitDetail(cwd, { kind: "commit", oid: current.history[0]!.oid });
    assert.ok(commit.files.length > 0);
    assert.ok(commit.files.some(file => file.afterText !== undefined));
    const history = await readGitDetail(cwd, { kind: "history", ref: `refs/heads/${current.branch}` });
    assert.ok(history.commits && history.commits.length >= 3);
    const stash = await readGitDetail(cwd, { kind: "stash", oid: current.stashes[0]!.oid });
    assert.ok(stash.files.length > 0);
    await writeFile(join(cwd, "untracked.txt"), "untracked content\n");
    const file = await readGitDetail(cwd, { kind: "file", path: "untracked.txt", stage: "unstaged" });
    assert.equal(file.files[0]!.afterText, "untracked content\n");
    assert.match(file.unifiedDiff, /untracked content/);
  } finally {
    await cleanup(cwd);
  }
});

test("unborn unstage and discard-all operate on only the selected staged addition", async () => {
  const { cwd } = await repository();
  try {
    await writeFile(join(cwd, "new.txt"), "new\n");
    let current = await state(cwd);
    await runGitAction(cwd, { action: "stage", expectedRevision: current.revision, paths: ["new.txt"] });
    current = await state(cwd);
    await runGitAction(cwd, {
      action: "unstage",
      expectedRevision: current.revision,
      paths: ["new.txt"],
      confirmed: true,
    });
    assert.equal((await readGitState(cwd)).files[0]!.indexStatus, "?");
    current = await state(cwd);
    await runGitAction(cwd, { action: "stage", expectedRevision: current.revision, paths: ["new.txt"] });
    current = await state(cwd);
    await runGitAction(cwd, {
      action: "discard",
      expectedRevision: current.revision,
      paths: ["new.txt"],
      scope: "all",
      confirmed: true,
    });
    await assert.rejects(readFile(join(cwd, "new.txt")));
  } finally {
    await cleanup(cwd);
  }
});

test("stale bytes and literal discard protect unstaged work even when porcelain status is unchanged", async () => {
  const { cwd, git } = await repository();
  try {
    for (const path of ["odd[1].txt", "odd1.txt"]) await writeFile(join(cwd, path), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    for (const path of ["odd[1].txt", "odd1.txt"]) await writeFile(join(cwd, path), "changed\n");
    const before = await state(cwd);
    await writeFile(join(cwd, "odd[1].txt"), "newer\n");
    await assert.rejects(
      runGitAction(cwd, {
        action: "discard",
        paths: ["odd[1].txt"],
        scope: "working",
        expectedRevision: before.revision,
        confirmed: true,
      }),
      /changed/,
    );
    await runGitAction(cwd, {
      action: "discard",
      paths: ["odd[1].txt"],
      scope: "working",
      expectedRevision: (await state(cwd)).revision,
      confirmed: true,
    });
    assert.equal((await readFile(join(cwd, "odd[1].txt"), "utf8")).trim(), "base");
    assert.equal((await readFile(join(cwd, "odd1.txt"), "utf8")).trim(), "changed");
  } finally {
    await cleanup(cwd);
  }
});

test("stash detail includes untracked content and pop removes only the applied entry", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await writeFile(join(cwd, "new.txt"), "shelved\n");
    await runGitAction(cwd, {
      action: "stash",
      includeUntracked: true,
      expectedRevision: (await state(cwd)).revision,
      confirmed: true,
    });
    const current = await state(cwd),
      stash = current.stashes[0];
    const detail = await readGitDetail(cwd, { kind: "stash", oid: stash.oid });
    assert.equal(detail.files.find(file => file.path === "new.txt")?.afterText, "shelved\n");
    await runGitAction(cwd, {
      action: "stashPop",
      expectedRevision: current.revision,
      selector: stash.selector,
      oid: stash.oid,
      confirmed: true,
    });
    assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "shelved\n");
    assert.equal((await state(cwd)).stashes.length, 0);
  } finally {
    await cleanup(cwd);
  }
});

test("incremental merge choices preserve context, missing final newline and identical-to-HEAD resolution", async () => {
  const { cwd, git } = await repository();
  try {
    await git("config", "core.autocrlf", "false");
    await git("config", "merge.conflictStyle", "diff3");
    for (const path of ["a.txt", "b.txt"]) await writeFile(join(cwd, path), "context\nbase");
    await git("add", ".");
    await git("commit", "-m", "base");
    const branch = (await git("branch", "--show-current")).stdout.trim();
    await git("checkout", "-b", "topic");
    for (const path of ["a.txt", "b.txt"]) await writeFile(join(cwd, path), "context\ntopic");
    await git("commit", "-am", "topic");
    await git("checkout", branch);
    for (const path of ["a.txt", "b.txt"]) await writeFile(join(cwd, path), "context\nours");
    await git("commit", "-am", "ours");
    await assert.rejects(
      runGitAction(cwd, {
        action: "merge",
        target: "refs/heads/topic",
        expectedRevision: (await state(cwd)).revision,
        confirmed: true,
      }),
    );
    for (const path of ["a.txt", "b.txt"]) {
      const detail = await readGitDetail(cwd, { kind: "conflict", path });
      const conflict = detail.conflict!;
      assert.ok(conflict.blocks[0].base);
      const text = reconstructConflictText(conflict.text, conflict.blocks, { 0: "ours" });
      assert.equal(text, "context\nours");
      await runGitAction(cwd, {
        action: "resolve",
        path,
        text,
        expectedVersion: conflict.version,
        expectedRevision: detail.revision!,
        confirmed: true,
      });
      assert.equal((await git("ls-files", "-u", "--", path)).stdout, "");
    }
    await runGitAction(cwd, {
      action: "continue",
      operation: "merge",
      expectedRevision: (await state(cwd)).revision,
      confirmed: true,
    });
    assert.equal((await state(cwd)).operation, undefined);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "context\nours");
  } finally {
    await cleanup(cwd);
  }
});

test("linked-worktree upstream config and detached HEAD changes invalidate reviewed actions", async () => {
  const { cwd, git } = await repository();
  const linked = `${cwd}-linked`;
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("worktree", "add", "-b", "linked", linked);
    const before = await state(linked);
    await git("config", "branch.linked.remote", "changed");
    assert.notEqual((await state(linked)).revision, before.revision);
    await assert.rejects(
      runGitAction(linked, {
        action: "createBranch",
        name: "not-created",
        expectedRevision: before.revision,
        confirmed: true,
      }),
      /changed/,
    );
    const attached = await state(cwd);
    await git("checkout", "--detach");
    assert.notEqual((await state(cwd)).revision, attached.revision);
  } finally {
    await cleanup(linked);
    await cleanup(cwd);
  }
});

test("unmerged stash conflicts remain resolvable without inventing a sequencer", async () => {
  const { cwd, git } = await repository();
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "shelved\n");
    await git("stash");
    await writeFile(join(cwd, "a.txt"), "committed\n");
    await git("commit", "-am", "new base");
    const before = await state(cwd),
      stash = before.stashes[0];
    await assert.rejects(
      runGitAction(cwd, {
        action: "stashPop",
        oid: stash.oid,
        selector: stash.selector,
        expectedRevision: before.revision,
        confirmed: true,
      }),
      /conflict/,
    );
    const conflicted = await state(cwd);
    assert.equal(conflicted.operation?.kind, "conflict");
    assert.equal(conflicted.stashes[0].oid, stash.oid);
    const detail = await readGitDetail(cwd, { kind: "conflict", path: "a.txt" });
    await runGitAction(cwd, {
      action: "resolve",
      path: "a.txt",
      text: "resolved\n",
      expectedVersion: detail.conflict!.version,
      expectedRevision: detail.revision!,
      confirmed: true,
    });
    assert.equal((await state(cwd)).operation, undefined);
    assert.equal((await git("show", ":a.txt")).stdout.trim(), "resolved");
  } finally {
    await cleanup(cwd);
  }
});

test("Git mutations refuse parent repositories and linked paths without reading outside content", async () => {
  const { cwd, git } = await repository();
  const outside = await mkdtemp(join(tmpdir(), "pylon-git-outside-"));
  try {
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await mkdir(join(cwd, "child"));
    const child = await readGitState(join(cwd, "child"));
    await assert.rejects(
      runGitAction(join(cwd, "child"), { action: "init", expectedRevision: child.revision!, confirmed: true }),
      /root|subfolder/,
    );
    await writeFile(join(outside, "private.txt"), "outside-only-content");
    await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
    const current = await readGitState(cwd);
    assert.equal(JSON.stringify(current).includes("outside-only-content"), false);
    await assert.rejects(
      readGitDetail(cwd, { kind: "file", path: "linked/private.txt", stage: "unstaged" }),
      /link|unsafe|inspection/i,
    );
    assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "outside-only-content");
  } finally {
    await cleanup(cwd);
    await cleanup(outside);
  }
});

test("remote actions fetch, push and fast-forward explicitly and refuse mirror configuration", async () => {
  const { cwd, git } = await repository();
  const remote = `${cwd}-remote`,
    peer = `${cwd}-peer`;
  try {
    await git("init", "--bare", remote);
    await writeFile(join(cwd, "a.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    const branch = (await git("branch", "--show-current")).stdout.trim();
    await git("remote", "add", "origin", remote);
    await git("push", "-u", "origin", branch);
    await writeFile(join(cwd, "a.txt"), "local\n");
    await git("commit", "-am", "local");
    await runGitAction(cwd, { action: "push", expectedRevision: (await state(cwd)).revision, confirmed: true });
    await git("clone", "--branch", branch, remote, peer);
    const peerGit = (...args: string[]) => run("git", args, { cwd: peer });
    await peerGit("config", "user.name", "Peer");
    await peerGit("config", "user.email", "peer@example.test");
    await writeFile(join(peer, "peer.txt"), "remote work\n");
    await peerGit("add", ".");
    await peerGit("commit", "-m", "peer");
    await peerGit("push");
    await runGitAction(cwd, { action: "fetch", expectedRevision: (await state(cwd)).revision, confirmed: true });
    assert.equal((await state(cwd)).behind, 1);
    await git("config", "pull.rebase", "true");
    await runGitAction(cwd, { action: "pull", expectedRevision: (await state(cwd)).revision, confirmed: true });
    assert.equal((await readFile(join(cwd, "peer.txt"), "utf8")).trim(), "remote work");
    await git("config", "remote.origin.mirror", "1");
    await assert.rejects(
      runGitAction(cwd, { action: "push", expectedRevision: (await state(cwd)).revision, confirmed: true }),
      /mirror|unsafe/i,
    );
  } finally {
    await cleanup(peer);
    await cleanup(remote);
    await cleanup(cwd);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCheckoutState,
  createSessionWorktree,
  createWorktreeSummary,
  diffWorkspaceFile,
  listWorkspaceFiles,
  parseWorktreeSummary,
  readWorkspaceFile,
  recreateSessionWorktree,
  removeSessionWorktree,
  restoreCheckoutState,
  readPersistedWorktreeSummaries,
  worktreeDiff,
  worktreeSnapshot,
} from "../src/worktree.ts";

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

test("worktree diff reports only changes made after a dirty baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-diff-"));
  await mkdir(join(root, "src"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "pylon@test.local"]);
    await git(root, ["config", "user.name", "Pylon"]);
    await writeFile(join(root, "src", "tracked.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);

    await writeFile(join(root, "src", "tracked.txt"), "pre-existing\n");
    const before = await worktreeSnapshot(root);
    await writeFile(join(root, "src", "tracked.txt"), "pre-existing\nturn\n");
    await writeFile(join(root, "src", "added.txt"), "new\n");
    const after = await worktreeSnapshot(root);
    assert.ok(before && after);

    const files = await worktreeDiff(before, after);
    assert.deepEqual(files, [
      { path: "src/added.txt", additions: 1, deletions: 0 },
      { path: "src/tracked.txt", additions: 1, deletions: 0 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted summaries are sanitized and bounded", () => {
  const summary = createWorktreeSummary("assistant-1", [
    { path: "src/valid.ts", additions: 4, deletions: 2 },
    { path: "../secret", additions: 1, deletions: 0 },
    { path: "assets/image.png", binary: true },
    ...Array.from({ length: 120 }, (_, index) => ({
      path: `generated/${index}-${"界".repeat(490)}.ts`,
      additions: 1,
      deletions: 0,
    })),
  ]);
  assert.ok(summary);
  assert.deepEqual(summary.files.slice(0, 2), [
    { path: "src/valid.ts", additions: 4, deletions: 2 },
    { path: "assets/image.png", binary: true },
  ]);
  assert.ok(summary.files.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= 64 * 1024);
  assert.equal(createWorktreeSummary("../assistant", []), undefined);
});

test("persisted summaries are validated and follow the active branch", () => {
  const valid = {
    version: 1,
    assistantEntryId: "assistant-1",
    files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
  };
  assert.deepEqual(parseWorktreeSummary(valid), valid);
  assert.equal(parseWorktreeSummary({ ...valid, files: [{ path: "../secret", additions: 1, deletions: 0 }] }), undefined);

  const session = {
    getBranch: () => [{ type: "message", id: "assistant-1", message: { role: "assistant" } }],
    getEntries: () => [
      { type: "custom", customType: "pylon-worktree-summary", data: valid },
      { type: "custom", customType: "pylon-worktree-summary", data: { ...valid, files: [{ path: "../secret", additions: 1, deletions: 0 }] } },
    ],
  };
  assert.deepEqual(readPersistedWorktreeSummaries(session).get("assistant-1"), valid.files);
  assert.equal(readPersistedWorktreeSummaries({ ...session, getBranch: () => [] }).size, 0);
});

test("session worktrees isolate a dirty baseline and expose bounded files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-session-worktree-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-owned-worktrees-"));
  const target = join(owned, "session-one");
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "pylon@test.local"]);
    await git(root, ["config", "user.name", "Pylon"]);
    await writeFile(join(root, "tracked.txt"), "committed\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    await writeFile(join(root, "tracked.txt"), "dirty baseline\n");
    await writeFile(join(root, "untracked.txt"), "also baseline\n");

    const worktree = await createSessionWorktree(root, target, owned, "session-one");
    assert.equal((await readFile(join(target, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "dirty baseline\n");
    assert.equal((await readFile(join(target, "untracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "also baseline\n");
    await writeFile(join(target, "tracked.txt"), "dirty baseline\nagent\n");
    await writeFile(join(target, "new.txt"), "new\n");

    const page = await listWorkspaceFiles({ cwd: target, baselineTree: worktree.baselineTree });
    assert.equal(page.totalCount, 3);
    assert.equal(page.truncated, false);
    assert.deepEqual(page.files.filter((file) => file.status), [
      { path: "new.txt", status: "added", additions: 1, deletions: 0 },
      { path: "tracked.txt", status: "modified", additions: 1, deletions: 0 },
    ]);
    assert.equal((await readWorkspaceFile({ cwd: target, path: "tracked.txt", baselineTree: worktree.baselineTree })).text?.replaceAll("\r\n", "\n"),
      "dirty baseline\nagent\n");
    assert.match((await diffWorkspaceFile({
      cwd: target,
      path: "tracked.txt",
      baselineTree: worktree.baselineTree,
    })).text ?? "", /^\+agent$/m);
    await assert.rejects(() => readWorkspaceFile({ cwd: target, path: "../secret", baselineTree: worktree.baselineTree }));

    await removeSessionWorktree(root, worktree, owned);
    await assert.rejects(() => stat(target));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("concurrent session worktrees never mix file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-concurrent-worktrees-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-owned-worktrees-"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "pylon@test.local"]);
    await git(root, ["config", "user.name", "Pylon"]);
    await writeFile(join(root, "shared.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const first = await createSessionWorktree(root, join(owned, "session-first"), owned, "session-first");
    const second = await createSessionWorktree(root, join(owned, "session-second"), owned, "session-second");
    await writeFile(join(first.root, "first.txt"), "first\n");
    await writeFile(join(second.root, "second.txt"), "second\n");

    const [firstFiles, secondFiles] = await Promise.all([
      listWorkspaceFiles({ cwd: first.root, baselineTree: first.baselineTree }),
      listWorkspaceFiles({ cwd: second.root, baselineTree: second.baselineTree }),
    ]);
    assert.deepEqual(firstFiles.files.filter((file) => file.status).map((file) => file.path), ["first.txt"]);
    assert.deepEqual(secondFiles.files.filter((file) => file.status).map((file) => file.path), ["second.txt"]);

    await removeSessionWorktree(root, first, owned);
    await removeSessionWorktree(root, second, owned);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("session state moves to the project checkout and back without merging", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-worktree-handoff-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-owned-worktrees-"));
  const target = join(owned, "session-move");
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "pylon@test.local"]);
    await git(root, ["config", "user.name", "Pylon"]);
    await writeFile(join(root, "file.txt"), "project\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const worktree = await createSessionWorktree(root, target, owned, "session-move");
    await writeFile(join(worktree.root, "file.txt"), "session\n");

    const parked = await captureCheckoutState(root);
    const session = await captureCheckoutState(worktree.root);
    await removeSessionWorktree(root, worktree, owned, false);
    await restoreCheckoutState(root, session);
    assert.equal((await readFile(join(root, "file.txt"), "utf8")).trim(), "session");

    const moved = await captureCheckoutState(root);
    await restoreCheckoutState(root, parked);
    const recreated = await recreateSessionWorktree(root, target, owned, worktree.branch, worktree.commonDir);
    await restoreCheckoutState(recreated, moved);
    assert.equal((await readFile(join(root, "file.txt"), "utf8")).trim(), "project");
    assert.equal((await readFile(join(recreated, "file.txt"), "utf8")).trim(), "session");
    await removeSessionWorktree(root, worktree, owned);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

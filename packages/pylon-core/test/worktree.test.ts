import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDiff, worktreeSnapshot } from "../src/worktree.ts";

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

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLocalGitBranches, switchLocalGitBranch } from "../src/worktree.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, windowsHide: true },
      (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message))) : resolve(String(stdout).trim())),
    ),
  );
}

const commitIdentity = {
  GIT_AUTHOR_NAME: "Pylon Test",
  GIT_AUTHOR_EMAIL: "pylon@test.local",
  GIT_COMMITTER_NAME: "Pylon Test",
  GIT_COMMITTER_EMAIL: "pylon@test.local",
};

test("local branches sort by tip activity and checkout fails closed for worktrees and dirty files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-local-branches-"));
  const repository = join(root, "repository");
  const otherWorktree = join(root, "other-worktree");
  await mkdir(repository);
  try {
    await git(repository, ["init", "-q"]);
    await git(repository, ["branch", "-M", "main"]);
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-qm", "base"], {
      ...commitIdentity,
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    });
    await git(repository, ["switch", "-c", "feature"]);
    await writeFile(join(repository, "tracked.txt"), "feature\n");
    await git(repository, ["commit", "-qam", "feature"], {
      ...commitIdentity,
      GIT_AUTHOR_DATE: "2025-02-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-02-01T00:00:00Z",
    });
    await git(repository, ["switch", "main"]);
    await git(repository, ["update-ref", "refs/heads/pylon-session-internal123", "HEAD"]);
    await git(repository, ["update-ref", "refs/heads/pylon/sessions/internal456", "HEAD"]);
    await git(repository, ["update-ref", "refs/heads/pylon-worktree-internal789", "HEAD"]);
    await git(repository, ["update-ref", "refs/heads/pylon-checkout-internal012", "HEAD"]);

    const listed = await listLocalGitBranches(repository);
    assert.deepEqual(listed.branches.map(branch => branch.name), ["feature", "main"]);
    assert.equal(listed.currentBranch, "main");
    assert.equal(listed.branches.find(branch => branch.name === "main")?.current, true);

    await git(repository, ["worktree", "add", "-q", otherWorktree, "feature"]);
    const occupied = await listLocalGitBranches(repository);
    assert.equal(occupied.branches.find(branch => branch.name === "feature")?.checkoutAvailable, false);
    await assert.rejects(() => switchLocalGitBranch(repository, "feature"), /another worktree/i);
    await git(repository, ["worktree", "remove", "--force", otherWorktree]);

    assert.equal(await switchLocalGitBranch(repository, "feature"), "feature");
    assert.equal(await git(repository, ["branch", "--show-current"]), "feature");
    await writeFile(join(repository, "untracked.txt"), "keep\n");
    await assert.rejects(() => switchLocalGitBranch(repository, "main"), /Commit, stash, or discard/);
    assert.equal(await git(repository, ["branch", "--show-current"]), "feature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { captureEvidenceRanges, currentChangedPaths, worktreeFingerprint } from "../src/worktree.ts";
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd, windowsHide: true });
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "continuity-worktree-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "tracked.txt"), "one\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

test("Continuity worktree identity exactly matches Verify's canonical 16-hex algorithm", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "tracked.txt"), "two\n");
    const [head, status] = await Promise.all([
      git(root, "rev-parse", "HEAD"),
      git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    ]);
    const expected = createHash("sha256")
      .update(`${String(head.stdout).trim()}\n${String(status.stdout)}`)
      .digest("hex")
      .slice(0, 16);
    assert.equal(await worktreeFingerprint(root), expected);
    assert.deepEqual([...(await currentChangedPaths(root))!], ["tracked.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown Git state is explicit and sensitive evidence names fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-nongit-"));
  try {
    assert.equal(await currentChangedPaths(root), undefined);
    assert.equal(await worktreeFingerprint(root), undefined);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "secrets.json"), '{"token":"definitely-secret-value"}\n');
    await assert.rejects(captureEvidenceRanges(root, [{ path: "nested/secrets.json", start: 1, end: 1 }]), /sensitive/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

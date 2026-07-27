import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeSummary,
  parseWorktreeSummary,
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

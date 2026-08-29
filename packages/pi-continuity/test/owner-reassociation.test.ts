import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { findMovedProjectOwner, reassociateOwnerNotes } from "../src/owner-reassociation.ts";
import { projectContext } from "../src/worktree.ts";
import type { NotebookNote } from "../src/memory.ts";
import type { Workspace } from "../src/workspace.ts";

const exec = promisify(execFile);
const note = (owner: string, trigger: string, commits: string[] = []): NotebookNote => ({
  id: randomUUID(),
  scope: "project",
  owner,
  trigger,
  guidance: "Keep the boundary.",
  authority: commits.length ? "project_contract" : "imported",
  origin: commits.length ? "agent" : "migration",
  sourceRefs: commits.map((captureCommit, index) => ({
    type: "repository" as const,
    path: `src/${index}.ts`,
    excerptSha256: String(index).repeat(64),
    captureCommit,
  })),
  disposition: "archival",
  enforcementAuthority: "context_only",
  revision: 1,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
});

test("owner reassociation revises moved notes and backs current-owner collisions out of the result", () => {
  const oldMove = note("old", "move"),
    oldMoveDuplicate = note("old", "move"),
    oldSame = note("old", "same"),
    currentSame = note("current", "same");
  const result = reassociateOwnerNotes(
    "old",
    "current",
    [oldMove, oldMoveDuplicate, oldSame, currentSame],
    "2025-02-01T00:00:00Z",
  );
  assert.equal(result.notes.filter(item => item.owner === "current").length, 3);
  assert.equal(
    result.notes.some(item => item.owner === "old"),
    false,
  );
  assert.deepEqual(
    result.moved.map(item => item.id),
    [oldMove.id, oldMoveDuplicate.id],
  );
  assert.deepEqual(
    result.suppressed.map(item => item.id),
    [oldSame.id],
  );
  assert.equal(result.notes.find(item => item.id === oldMove.id)?.revision, 2);
});

test("moved owner detection requires stale missing homes and two commits from exactly one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-v6-owner-move-")),
    oldPath = join(root, "old"),
    currentPath = join(root, "current");
  try {
    await mkdir(oldPath);
    await exec("git", ["init"], { cwd: oldPath });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: oldPath });
    await exec("git", ["config", "user.name", "Test"], { cwd: oldPath });
    await writeFile(join(oldPath, "one.txt"), "one\n");
    await exec("git", ["add", "."], { cwd: oldPath });
    await exec("git", ["commit", "-m", "one"], { cwd: oldPath });
    const first = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    await writeFile(join(oldPath, "two.txt"), "two\n");
    await exec("git", ["add", "."], { cwd: oldPath });
    await exec("git", ["commit", "-m", "two"], { cwd: oldPath });
    const second = String((await exec("git", ["rev-parse", "HEAD"], { cwd: oldPath })).stdout).trim();
    await exec("git", ["tag", "-a", "same-one", first, "-m", "same one"], { cwd: oldPath });
    await exec("git", ["tag", "-a", "same-two", first, "-m", "same two"], { cwd: oldPath });
    const tagOne = String((await exec("git", ["rev-parse", "same-one"], { cwd: oldPath })).stdout).trim(),
      tagTwo = String((await exec("git", ["rev-parse", "same-two"], { cwd: oldPath })).stdout).trim();
    await rename(oldPath, currentPath);
    const currentOwner = (await projectContext(currentPath, "fallback")).owner;
    const workspace: Workspace = {
      id: "old-workspace",
      canonicalPath: oldPath,
      projectOwner: "old-owner",
      createdAt: "2020-01-01T00:00:00Z",
      lastSeenAt: "2020-01-01T00:00:00Z",
    };
    const notes = [note("old-owner", "boundary", [first, second])];
    assert.equal(await findMovedProjectOwner(currentPath, currentOwner, [workspace], notes), "old-owner");
    assert.equal(
      await findMovedProjectOwner(
        currentPath,
        currentOwner,
        [workspace],
        [note("old-owner", "same commit", [tagOne, tagTwo])],
      ),
      undefined,
      "two tag OIDs peeling to one commit are not independent proof",
    );
    await mkdir(oldPath);
    assert.equal(
      await findMovedProjectOwner(currentPath, currentOwner, [workspace], notes),
      undefined,
      "an existing old home vetoes reassociation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { candidate, compact, type Fact } from "../src/memory.ts";
import {
  findMovedProjectOwner,
  isOwnerReassociationMarker,
  OWNER_REASSOCIATION_GRACE_MS,
  reassociateOwnerRecords,
} from "../src/owner-reassociation.ts";
import { captureEvidence, projectContext } from "../src/worktree.ts";
import type { Workspace } from "../src/workspace.ts";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", ["-C", cwd, ...args]);
const workspace = (path: string, owner: string, age = OWNER_REASSOCIATION_GRACE_MS + 1): Workspace => ({
  id: owner,
  canonicalPath: path,
  projectOwner: owner,
  createdAt: new Date(Date.now() - age).toISOString(),
  lastSeenAt: new Date(Date.now() - age).toISOString(),
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "continuity-owner-move-"));
  const oldPath = join(root, "old"), movedPath = join(root, "moved");
  await git(root, ["init", "-q", oldPath]);
  await git(oldPath, ["config", "user.email", "test@example.invalid"]);
  await git(oldPath, ["config", "user.name", "test"]);
  await writeFile(join(oldPath, "evidence.txt"), "stable\n");
  await git(oldPath, ["add", "."]);
  await git(oldPath, ["commit", "-qm", "first"]);
  const first = String((await git(oldPath, ["rev-parse", "HEAD"])).stdout).trim();
  const evidence = await captureEvidence(oldPath, ["evidence.txt"]);
  const old = await projectContext(oldPath, "old");
  await rename(oldPath, movedPath);
  const moved = await projectContext(movedPath, "moved");
  return { root, oldPath, movedPath, first, evidence, old, moved };
}

test("reassociates one orphaned moved repository using local commit and matching evidence", async () => {
  const repo = await repository();
  try {
    assert.notEqual(repo.old.owner, repo.moved.owner);
    const fact = compact([], [candidate({ key: "workflow.test", text: "Run tests" }, {
      owner: repo.old.owner,
      captureCommit: repo.first,
      evidencePaths: repo.evidence,
    })]).facts;
    assert.equal(await findMovedProjectOwner(
      repo.movedPath,
      repo.moved.owner,
      [workspace(repo.oldPath, repo.old.owner)],
      fact,
      [],
    ), repo.old.owner);

    await mkdir(repo.oldPath);
    assert.equal(await findMovedProjectOwner(
      repo.movedPath,
      repo.moved.owner,
      [workspace(repo.oldPath, repo.old.owner)],
      fact,
      [],
    ), undefined, "a live prior workspace must block reassociation");
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test("requires exact commit object IDs", async () => {
  const repo = await repository();
  try {
    const base = compact([], [candidate({ key: "one", text: "One" }, {
      owner: repo.old.owner,
      captureCommit: repo.first,
      evidencePaths: repo.evidence,
    })]).facts[0]!;
    const blob = String((await git(repo.movedPath, ["hash-object", "evidence.txt"])).stdout).trim();
    await git(repo.movedPath, ["tag", "-a", "memory-test", "-m", "tag"]);
    const tag = String((await git(repo.movedPath, ["rev-parse", "memory-test^{tag}"])).stdout).trim();
    for (const captureCommit of [repo.first.slice(0, 12), `${repo.first}^`, blob, tag]) {
      assert.equal(await findMovedProjectOwner(
        repo.movedPath,
        repo.moved.owner,
        [workspace(repo.oldPath, repo.old.owner)],
        [{ ...base, captureCommit }],
        [],
      ), undefined);
    }
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test("rejects stale evidence, missing commits, recent paths, and ambiguous owners", async () => {
  const repo = await repository();
  try {
    const base = compact([], [candidate({ key: "one", text: "One" }, {
      owner: repo.old.owner,
      captureCommit: repo.first,
      evidencePaths: repo.evidence,
    })]).facts[0]!;
    await writeFile(join(repo.movedPath, "evidence.txt"), "changed\n");
    assert.equal(await findMovedProjectOwner(
      repo.movedPath,
      repo.moved.owner,
      [workspace(repo.oldPath, repo.old.owner)],
      [base],
      [],
    ), undefined);
    assert.equal(await findMovedProjectOwner(
      repo.movedPath,
      repo.moved.owner,
      [workspace(repo.oldPath, repo.old.owner, 1)],
      [{ ...base, captureCommit: "f".repeat(40) }],
      [],
    ), undefined);

    await writeFile(join(repo.movedPath, "second.txt"), "second\n");
    await git(repo.movedPath, ["add", "."]);
    await git(repo.movedPath, ["commit", "-qm", "second"]);
    const second = String((await git(repo.movedPath, ["rev-parse", "HEAD"])).stdout).trim();
    const facts: Fact[] = [
      { ...base, evidencePaths: undefined },
      { ...base, key: "two", captureCommit: second, evidencePaths: undefined },
      { ...base, owner: "other-owner", key: "other-one", evidencePaths: undefined },
      { ...base, owner: "other-owner", key: "other-two", captureCommit: second, evidencePaths: undefined },
    ];
    assert.equal(await findMovedProjectOwner(
      repo.movedPath,
      repo.moved.owner,
      [workspace(repo.oldPath, repo.old.owner), workspace(join(repo.root, "other-missing"), "other-owner")],
      facts,
      [],
    ), undefined, "multiple qualifying owners are ambiguous");
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
});

test("record migration keeps current-owner collisions and backs up old-owner records", () => {
  const oldFact = (key: string, text: string, owner: string): Fact => ({
    key,
    text,
    owner,
    scope: "project",
    kind: "workflow",
    source: "test",
    confidence: 1,
    updatedAt: new Date().toISOString(),
    captureCommit: "a".repeat(40),
  });
  const facts = [oldFact("same", "old", "old"), oldFact("same", "current", "current"), oldFact("moved", "move me", "old")];
  const oldCandidate = candidate({ key: "same", text: "old candidate" }, { owner: "old", captureCommit: "a".repeat(40) });
  const currentCandidate = candidate({ key: "same", text: "current candidate" }, { owner: "current", captureCommit: "a".repeat(40) });
  const moved = reassociateOwnerRecords("old", "current", facts, [oldCandidate, currentCandidate]);
  assert.deepEqual(moved.facts.map((fact) => [fact.owner, fact.key, fact.text]), [
    ["current", "same", "current"],
    ["current", "moved", "move me"],
  ]);
  assert.deepEqual(moved.candidates, [currentCandidate]);
  assert.equal(moved.backup.facts.length, 2);
  assert.equal(moved.backup.candidates.length, 1);
  assert.equal(isOwnerReassociationMarker({
    ...moved.backup,
    version: 1,
    status: "records-moved",
    createdAt: new Date().toISOString(),
  }), true);
});

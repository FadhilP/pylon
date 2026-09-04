import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorWorktreeTurn,
  appendTurnCommit,
  captureCheckoutState,
  claimSessionCheckout,
  createSessionWorktree,
  createWorktreeSummary,
  collectWorkspaceFileDelta,
  diffWorkspaceFile,
  inspectWorkspaceChanges,
  listWorkspaceFiles,
  mergeWorkspaceChanges,
  legacyTurnRefSessionIds,
  migrateLegacyTurnRefs,
  parseWorktreeSummary,
  readWorkspaceFile,
  recreateSessionWorktree,
  removeSessionRef,
  removeSessionBranch,
  removeSessionWorktree,
  removeWorktreeTurnRefs,
  restoreCheckoutState,
  readPersistedWorktreeSummaries,
  turnTreeDiff,
  turnWorktreeDiff,
  turnsBranchForSession,
  worktreeDiff,
  worktreeSnapshot,
} from "../src/worktree.ts";

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, error => (error ? reject(error) : resolve()));
  });
}

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim()),
    );
  });
}

async function initializeRepository(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q"]);
  await appendFile(join(cwd, ".git", "config"), "\n[user]\n\temail = pylon@test.local\n\tname = Pylon\n");
}

test("worktree diff reports only changes made after a dirty baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-diff-"));
  await mkdir(join(root, "src"));
  try {
    await initializeRepository(root);
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

test("worktree snapshots recover after transient path churn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-race-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    await writeFile(join(root, "tracked.txt"), "changed\n");

    const churn = (async () => {
      for (let index = 0; index < 150; index++) {
        await writeFile(join(root, `churn-${index}.txt`), `${index}\n`);
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    })();
    const snapshot = await worktreeSnapshot(root);
    await churn;

    assert.ok(snapshot, "a brief worktree race should not erase the turn snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree snapshots from nested directories include repository-wide changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-nested-snapshot-"));
  const nested = join(root, "src", "nested");
  await mkdir(nested, { recursive: true });
  try {
    await initializeRepository(root);
    await writeFile(join(root, "outside.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);

    const before = await worktreeSnapshot(nested);
    await writeFile(join(root, "outside.txt"), "changed\n");
    const after = await worktreeSnapshot(nested);
    assert.ok(before && after);
    assert.deepEqual(await worktreeDiff(before, after), [{ path: "outside.txt", additions: 1, deletions: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree snapshots treat unusual changed paths literally", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-literal-paths-"));
  const names = ["literal[ab].txt", "old[ab].txt", "delete[ab].txt", "space 界.txt"];
  try {
    await initializeRepository(root);
    for (const name of names) await writeFile(join(root, name), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const before = await worktreeSnapshot(root);

    await writeFile(join(root, names[0]!), "changed\n");
    await rename(join(root, names[1]!), join(root, "new[ab].txt"));
    await unlink(join(root, names[2]!));
    await writeFile(join(root, names[3]!), "changed\n");
    const after = await worktreeSnapshot(root);
    assert.ok(before && after);
    assert.deepEqual(await worktreeDiff(before, after), [
      { path: "delete[ab].txt", additions: 0, deletions: 1 },
      { path: "literal[ab].txt", additions: 1, deletions: 1 },
      { path: "new[ab].txt", additions: 1, deletions: 0 },
      { path: "old[ab].txt", additions: 0, deletions: 1 },
      { path: "space 界.txt", additions: 1, deletions: 1 },
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
  assert.equal(
    parseWorktreeSummary({ ...valid, files: [{ path: "../secret", additions: 1, deletions: 0 }] }),
    undefined,
  );

  const session = {
    getBranch: () => [{ type: "message", id: "assistant-1", message: { role: "assistant" } }],
    getEntries: () => [
      { type: "custom", customType: "pylon-worktree-summary", data: valid },
      {
        type: "custom",
        customType: "pylon-worktree-summary",
        data: { ...valid, files: [{ path: "../secret", additions: 1, deletions: 0 }] },
      },
    ],
  };
  assert.deepEqual(readPersistedWorktreeSummaries(session).get("assistant-1"), valid.files);
  assert.equal(readPersistedWorktreeSummaries({ ...session, getBranch: () => [] }).size, 0);
});

test("turn anchors persist in summaries", () => {
  const anchor = {
    root: "/repo",
    beforeTree: "1".repeat(40),
    afterTree: "2".repeat(40),
    repositories: [{ path: "vendor/lib", beforeTree: "3".repeat(40), afterTree: "4".repeat(40) }],
  };
  const summary = createWorktreeSummary("assistant-anchor", [{ path: "src/a.ts", additions: 1, deletions: 0 }], anchor);
  assert.ok(summary);
  assert.equal(summary.root, anchor.root);
  const parsed = parseWorktreeSummary(summary);
  assert.equal(parsed?.beforeTree, anchor.beforeTree);
  assert.equal(parsed?.afterTree, anchor.afterTree);
  assert.deepEqual(parsed?.repositories, anchor.repositories);
  // Invalid anchors degrade to an unanchored summary rather than dropping files.
  const unanchored = createWorktreeSummary("assistant-anchor", [{ path: "a.ts", additions: 1, deletions: 0 }], {
    ...anchor,
    root: "",
  });
  assert.ok(unanchored);
  assert.equal(unanchored.root, undefined);
  const valid = { version: 1, assistantEntryId: "a-1", files: [{ path: "a.ts", additions: 1, deletions: 0 }] };
  assert.deepEqual(parseWorktreeSummary(valid), valid); // v1 entries without anchors still parse
  assert.equal(
    parseWorktreeSummary({ ...valid, root: "/repo", beforeTree: "z".repeat(40), afterTree: "2".repeat(40) }),
    undefined,
  );
  assert.equal(
    parseWorktreeSummary({
      ...valid,
      root: "/repo",
      beforeTree: "1".repeat(40),
      afterTree: "2".repeat(40),
      repositories: [{ path: "../escape", beforeTree: "3".repeat(40), afterTree: "4".repeat(40) }],
    }),
    undefined,
  );
});

test("turn commits chain on one session branch and diffs stay readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-anchor-"));
  try {
    await git(root, ["init", "-q"]);
    assert.equal(turnsBranchForSession("short"), undefined);
    const branch = turnsBranchForSession("session1234");
    assert.equal(branch, "refs/pylon/turns/session1234");
    await writeFile(join(root, "one.txt"), "one\n");
    const first = await captureCheckoutState(root, true);
    const firstCommit = await appendTurnCommit(root, branch!, first.worktreeTree);
    assert.ok(firstCommit);
    assert.equal(await gitOutput(root, ["branch", "--list", "pylon-session-*"]), "");
    await writeFile(join(root, "one.txt"), "two\n");
    const second = await captureCheckoutState(root, true);
    const secondCommit = await appendTurnCommit(root, branch!, second.worktreeTree);
    assert.ok(secondCommit && secondCommit !== firstCommit);
    // The second commit's parent must be the first (chained history keeps every turn reachable).
    const parentOfSecond = await new Promise<string>((resolve, reject) =>
      execFile(
        "git",
        ["rev-parse", "--verify", `${secondCommit}^`],
        { cwd: root, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
      ),
    );
    assert.equal(parentOfSecond, firstCommit);
    // Re-anchoring an unchanged tip tree is idempotent.
    assert.equal(await appendTurnCommit(root, branch!, second.worktreeTree), secondCommit);
    const diff = await turnTreeDiff(root, first.worktreeTree, second.worktreeTree);
    assert.equal(diff.state, "available");
    assert.ok(diff.text?.includes("+two"));
    await removeSessionRef(root, branch!);
    await assert.rejects(git(root, ["rev-parse", "--verify", branch!]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy turn branches migrate by exact tip and delete only after a compatible copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-anchor-migration-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "legacy\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "legacy"]);
    const legacy = "refs/heads/pylon-session-session5678";
    const hidden = turnsBranchForSession("session5678")!;
    const legacyTip = await gitOutput(root, ["rev-parse", "HEAD"]);
    await git(root, ["update-ref", legacy, legacyTip]);
    const before = await captureCheckoutState(root, true);

    assert.equal(await appendTurnCommit(root, hidden, before.worktreeTree), legacyTip);
    assert.equal(await gitOutput(root, ["rev-parse", hidden]), legacyTip);
    await assert.rejects(git(root, ["rev-parse", "--verify", legacy]));

    await writeFile(join(root, "tracked.txt"), "hidden\n");
    const after = await captureCheckoutState(root, true);
    const hiddenTip = await appendTurnCommit(root, hidden, after.worktreeTree);
    assert.ok(hiddenTip && hiddenTip !== legacyTip);
    assert.equal(await gitOutput(root, ["rev-parse", `${hiddenTip}^`]), legacyTip);

    await git(root, ["commit", "--allow-empty", "-qm", "legacy advanced"]);
    const advancedLegacy = await gitOutput(root, ["rev-parse", "HEAD"]);
    await git(root, ["update-ref", legacy, advancedLegacy, ""]);
    assert.equal(await appendTurnCommit(root, hidden, before.worktreeTree), undefined);
    assert.equal(await gitOutput(root, ["rev-parse", hidden]), hiddenTip);
    assert.equal(await gitOutput(root, ["rev-parse", legacy]), advancedLegacy);

    await removeSessionRef(root, hidden);
    await assert.rejects(git(root, ["rev-parse", "--verify", hidden]));
    assert.equal(await gitOutput(root, ["rev-parse", legacy]), advancedLegacy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy turn migration never deletes a checked-out head", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-anchor-checked-out-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "legacy\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "legacy"]);
    const legacy = "refs/heads/pylon-session-session9012";
    const hidden = turnsBranchForSession("session9012")!;
    await git(root, ["branch", legacy.slice("refs/heads/".length)]);
    await git(root, ["switch", legacy.slice("refs/heads/".length)]);
    const state = await captureCheckoutState(root, true);

    assert.equal(await appendTurnCommit(root, hidden, state.worktreeTree), undefined);
    assert.equal(await gitOutput(root, ["rev-parse", hidden]), await gitOutput(root, ["rev-parse", legacy]));
    assert.equal(await gitOutput(root, ["symbolic-ref", "HEAD"]), legacy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk legacy turn migration is bounded to known, unprotected session refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-anchor-bulk-migration-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "base"]);
    const tip = await gitOutput(root, ["rev-parse", "HEAD"]);
    const legacy = (sessionId: string) => `refs/heads/pylon-session-${sessionId}`;
    for (const sessionId of ["session1111", "session2222", "session3333", "session4444"]) {
      await git(root, ["update-ref", legacy(sessionId), tip]);
    }

    assert.deepEqual(await legacyTurnRefSessionIds(root), [
      "session1111",
      "session2222",
      "session3333",
      "session4444",
    ]);
    assert.deepEqual(
      await migrateLegacyTurnRefs(root, ["session1111", "session2222", "session3333"], [legacy("session3333")]),
      { migrated: 2, skipped: 1 },
    );
    for (const sessionId of ["session1111", "session2222"]) {
      assert.equal(await gitOutput(root, ["rev-parse", turnsBranchForSession(sessionId)!]), tip);
      await assert.rejects(git(root, ["rev-parse", "--verify", legacy(sessionId)]));
    }
    assert.equal(await gitOutput(root, ["rev-parse", legacy("session3333")]), tip);
    assert.equal(await gitOutput(root, ["rev-parse", legacy("session4444")]), tip);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout ownership uses its own branch namespace and restores cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-session-checkout-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "base"]);

    const checkout = await claimSessionCheckout(root, "checkout-one");
    assert.equal(checkout.branch, "refs/heads/pylon-checkout-checkout-one");
    assert.equal(await gitOutput(root, ["symbolic-ref", "HEAD"]), checkout.branch);
    await restoreCheckoutState(root, checkout.parked);
    await removeSessionBranch(root, checkout.branch, checkout.commonDir);
    await assert.rejects(git(root, ["rev-parse", "--verify", checkout.branch]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("session worktrees isolate a dirty baseline and expose bounded files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-session-worktree-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-owned-worktrees-"));
  const target = join(owned, "session-one");
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "committed\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    await git(root, ["branch", "pylon"]);
    await writeFile(join(root, "tracked.txt"), "dirty baseline\n");
    await writeFile(join(root, "untracked.txt"), "also baseline\n");

    const worktree = await createSessionWorktree(root, target, owned, "session-one");
    assert.equal(worktree.branch, "refs/heads/pylon-worktree-session-one");
    assert.equal((await readFile(join(target, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "dirty baseline\n");
    assert.equal((await readFile(join(target, "untracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "also baseline\n");
    await writeFile(join(target, "tracked.txt"), "dirty baseline\nagent\n");
    await writeFile(join(target, "new.txt"), "new\n");

    const page = await listWorkspaceFiles({ cwd: target, baselineTree: worktree.baselineTree });
    assert.equal(page.totalCount, 3);
    assert.equal(page.truncated, false);
    assert.deepEqual(
      page.files.filter(file => file.status),
      [
        { path: "new.txt", status: "added", additions: 1, deletions: 0 },
        { path: "tracked.txt", status: "modified", additions: 1, deletions: 0 },
      ],
    );
    assert.equal(
      (
        await readWorkspaceFile({ cwd: target, path: "tracked.txt", baselineTree: worktree.baselineTree })
      ).text?.replaceAll("\r\n", "\n"),
      "dirty baseline\nagent\n",
    );
    assert.match(
      (await diffWorkspaceFile({ cwd: target, path: "tracked.txt", baselineTree: worktree.baselineTree })).text ?? "",
      /^\+agent$/m,
    );
    await assert.rejects(() =>
      readWorkspaceFile({ cwd: target, path: "../secret", baselineTree: worktree.baselineTree }),
    );

    await removeSessionWorktree(root, worktree, owned);
    await assert.rejects(() => stat(target));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("local workspace files report all uncommitted changes against HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-local-files-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "deleted.txt"), "delete me\n");
    await writeFile(join(root, "staged.txt"), "base\n");
    await writeFile(join(root, "unstaged.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);

    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "staged.txt"), "staged\n");
    await git(root, ["add", "staged.txt"]);
    await writeFile(join(root, "unstaged.txt"), "unstaged\n");
    await writeFile(join(root, "untracked.txt"), "new\n");

    const page = await listWorkspaceFiles({ cwd: root });
    assert.deepEqual(
      page.files.filter(file => file.status).map(({ path, status }) => ({ path, status })),
      [
        { path: "deleted.txt", status: "deleted" },
        { path: "staged.txt", status: "modified" },
        { path: "unstaged.txt", status: "modified" },
        { path: "untracked.txt", status: "added" },
      ],
    );
    assert.equal((await readWorkspaceFile({ cwd: root, path: "staged.txt", view: "base" })).text, "base");
    assert.match((await diffWorkspaceFile({ cwd: root, path: "unstaged.txt" })).text ?? "", /^-base$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only workspace files do not contend for the checkout index lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-locked-index-files-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    await writeFile(join(root, "tracked.txt"), "current\n");
    await writeFile(join(root, ".git", "index.lock"), "");

    const [base, current] = await Promise.all([
      readWorkspaceFile({ cwd: root, path: "tracked.txt", view: "base" }),
      readWorkspaceFile({ cwd: root, path: "tracked.txt", view: "current" }),
    ]);
    assert.equal(base.text, "base");
    assert.equal(current.text, "current\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local workspace files use the empty tree before the first commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-unborn-files-"));
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "first.txt"), "first\n");
    const page = await listWorkspaceFiles({ cwd: root });
    assert.deepEqual(page.files, [{ path: "first.txt", status: "added", additions: 1, deletions: 0 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent session worktrees never mix file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-concurrent-worktrees-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-owned-worktrees-"));
  try {
    await initializeRepository(root);
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
    assert.deepEqual(
      firstFiles.files.filter(file => file.status).map(file => file.path),
      ["first.txt"],
    );
    assert.deepEqual(
      secondFiles.files.filter(file => file.status).map(file => file.path),
      ["second.txt"],
    );

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
    await initializeRepository(root);
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
    await mkdir(target);
    await writeFile(join(target, "orphan.txt"), "stale recovery directory\n");
    const recreated = await recreateSessionWorktree(root, target, owned, worktree.branch, worktree.commonDir);
    await restoreCheckoutState(recreated, moved);
    await assert.rejects(stat(join(recreated, "orphan.txt")));
    assert.equal((await readFile(join(root, "file.txt"), "utf8")).trim(), "project");
    assert.equal((await readFile(join(recreated, "file.txt"), "utf8")).trim(), "session");
    await removeSessionWorktree(root, worktree, owned);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("session changes merge onto a dirty checkout without changing its index", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-apply-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-apply-worktrees-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "shared.txt"), "first\nmiddle\nlast\n");
    await writeFile(join(root, "target.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const worktree = await createSessionWorktree(root, join(owned, "session-apply"), owned, "session-apply");

    await writeFile(join(root, "shared.txt"), "target\nmiddle\nlast\n");
    await writeFile(join(root, "target.txt"), "staged target\n");
    await git(root, ["add", "target.txt"]);
    const target = await captureCheckoutState(root);

    await writeFile(join(worktree.root, "shared.txt"), "first\nmiddle\nsession\n");
    await writeFile(join(worktree.root, "session.txt"), "new\n");
    const source = await captureCheckoutState(worktree.root);
    const result = await mergeWorkspaceChanges(root, worktree.baselineTree, target, source);
    assert.equal(result.state, "applied");
    assert.ok("checkout" in result);
    if (!("checkout" in result)) return;
    assert.equal(result.checkout.indexTree, target.indexTree);
    await restoreCheckoutState(root, result.checkout);
    assert.equal(
      (await readFile(join(root, "shared.txt"), "utf8")).replaceAll("\r\n", "\n"),
      "target\nmiddle\nsession\n",
    );
    assert.equal(await readFile(join(root, "target.txt"), "utf8").then(value => value.trim()), "staged target");
    assert.equal(await readFile(join(root, "session.txt"), "utf8").then(value => value.trim()), "new");
    assert.equal((await captureCheckoutState(root)).indexTree, target.indexTree);

    const repeated = await mergeWorkspaceChanges(root, worktree.baselineTree, await captureCheckoutState(root), source);
    assert.equal(repeated.state, "unchanged");
    await removeSessionWorktree(root, worktree, owned);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("conflicting session changes leave both checkout states untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-apply-conflict-"));
  const owned = await mkdtemp(join(tmpdir(), "pylon-apply-conflict-worktrees-"));
  try {
    await initializeRepository(root);
    await writeFile(join(root, "shared.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const worktree = await createSessionWorktree(root, join(owned, "session-conflict"), owned, "session-conflict");
    await writeFile(join(root, "shared.txt"), "target\n");
    await writeFile(join(worktree.root, "shared.txt"), "session\n");
    const target = await captureCheckoutState(root);
    const source = await captureCheckoutState(worktree.root);

    const result = await mergeWorkspaceChanges(root, worktree.baselineTree, target, source);
    assert.equal(result.state, "conflict");
    assert.deepEqual(result.state === "conflict" && result.conflicts.map(item => item.path), ["shared.txt"]);
    assert.equal((await captureCheckoutState(root)).worktreeTree, target.worktreeTree);
    assert.equal((await captureCheckoutState(worktree.root)).worktreeTree, source.worktreeTree);
    await removeSessionWorktree(root, worktree, owned);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(owned, { recursive: true, force: true });
  }
});

test("registered submodules are inventoried, routed, and aggregate nested state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-submodule-root-"));
  const originRoot = await mkdtemp(join(tmpdir(), "pylon-submodule-origin-"));
  try {
    await initializeRepository(originRoot);
    await writeFile(join(originRoot, "lib.txt"), "lib\n");
    await git(originRoot, ["add", "."]);
    await git(originRoot, ["commit", "-qm", "origin"]);
    const secondOrigin = join(originRoot, "second");
    await mkdir(secondOrigin);
    await initializeRepository(secondOrigin);
    await writeFile(join(secondOrigin, "nested.txt"), "fresh\n");
    await git(secondOrigin, ["add", "."]);
    await git(secondOrigin, ["commit", "-qm", "second"]);
    await git(originRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      secondOrigin.replaceAll("\\", "/"),
      "nested",
    ]);
    await git(originRoot, ["commit", "-qm", "nested submodule"]);

    await initializeRepository(root);
    await writeFile(join(root, "tracked.txt"), "parent\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const addSubmodule = (url: string, path: string) =>
      git(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        url.replaceAll("\\", "/"),
        path.replaceAll("\\", "/"),
      ]);

    // Gitlink entries never surface as leaf files; submodule contents are inventoried flat.
    await addSubmodule(originRoot, join("vendor", "lib"));
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    await git(root, ["commit", "-qm", "submodule"]);
    const submodulePath = join(root, "vendor", "lib");
    // Isolated indexes still share Git's object store, so serialize snapshots on Windows.
    const clean = await listWorkspaceFiles({ cwd: root });
    const cleanChanges = await inspectWorkspaceChanges(root);
    const turnBefore = await worktreeSnapshot(root);
    assert.ok(turnBefore);
    assert.deepEqual(
      clean.files.map(file => [file.path, file.status]),
      [
        [".gitmodules", undefined],
        ["tracked.txt", undefined],
        ["vendor/lib/.gitmodules", undefined],
        ["vendor/lib/lib.txt", undefined],
        ["vendor/lib/nested/nested.txt", undefined],
      ],
    );
    assert.equal(cleanChanges.unapplicableSubmoduleChanges, undefined);

    // Nested dirty and untracked state appears with workspace-relative paths.
    await writeFile(join(submodulePath, "lib.txt"), "lib\ndirty\n");
    await writeFile(join(submodulePath, "extra.txt"), "untracked\n");
    const turnAfter = await worktreeSnapshot(root);
    assert.ok(turnAfter);
    assert.deepEqual(await worktreeDiff(turnBefore, turnAfter), [
      { path: "vendor/lib/extra.txt", additions: 1, deletions: 0 },
      { path: "vendor/lib/lib.txt", additions: 1, deletions: 0 },
    ]);

    const nestedPath = join(submodulePath, "nested", "nested.txt");
    await writeFile(nestedPath, "fresh\nnested turn\n");
    const nestedAfter = await worktreeSnapshot(root);
    assert.ok(nestedAfter);
    assert.deepEqual(await worktreeDiff(turnAfter, nestedAfter), [
      { path: "vendor/lib/nested/nested.txt", additions: 1, deletions: 0 },
    ]);
    const turnBranch = turnsBranchForSession("submodule-turn");
    assert.ok(turnBranch);
    const nestedAnchor = await anchorWorktreeTurn(turnAfter, nestedAfter, turnBranch);
    assert.deepEqual(
      nestedAnchor?.repositories?.map(repository => repository.path),
      ["vendor/lib/nested"],
    );
    const nestedPatch = nestedAnchor && (await turnWorktreeDiff(root, nestedAnchor));
    assert.equal(nestedPatch?.state, "available");
    assert.match(nestedPatch?.state === "available" ? nestedPatch.text : "", /a\/vendor\/lib\/nested\/nested\.txt/);
    assert.match(nestedPatch?.state === "available" ? nestedPatch.text : "", /^\+nested turn$/m);
    await writeFile(nestedPath, "fresh\n");
    await removeWorktreeTurnRefs(root, turnBranch);
    const dirtyChanges = await inspectWorkspaceChanges(root);
    const dirty = await listWorkspaceFiles({ cwd: root });
    const nestedBase = await readWorkspaceFile({ cwd: root, path: "vendor/lib/nested/nested.txt", view: "base" });
    const delta = await collectWorkspaceFileDelta({
      cwd: root,
      paths: ["vendor/lib/lib.txt", "vendor/lib/extra.txt", "vendor/lib/nested/nested.txt"],
    });
    assert.deepEqual(
      dirty.files.map(file => [file.path, file.status]),
      [
        ["vendor/lib/extra.txt", "added"],
        ["vendor/lib/lib.txt", "modified"],
        [".gitmodules", undefined],
        ["tracked.txt", undefined],
        ["vendor/lib/.gitmodules", undefined],
        ["vendor/lib/nested/nested.txt", undefined],
      ],
    );
    assert.equal(dirty.files.find(file => file.path === "vendor/lib/lib.txt")?.additions, 1);
    assert.notEqual(dirty.revision, clean.revision);
    assert.equal(dirtyChanges.unapplicableSubmoduleChanges, true);
    assert.equal(nestedBase.text?.trim(), "fresh");
    assert.equal(delta.reconcileRequired, false);
    assert.deepEqual(
      delta.upserted.map(file => [file.path, file.status]),
      [
        ["vendor/lib/lib.txt", "modified"],
        ["vendor/lib/extra.txt", "added"],
        ["vendor/lib/nested/nested.txt", undefined],
      ],
    );
    await rm(join(submodulePath, "extra.txt"));
    const removed = await collectWorkspaceFileDelta({ cwd: root, paths: ["vendor/lib/extra.txt"] });
    assert.deepEqual(removed.removed, ["vendor/lib/extra.txt"]);

    const currentLib = await readWorkspaceFile({ cwd: root, path: "vendor/lib/lib.txt" });
    const baseLib = await readWorkspaceFile({ cwd: root, path: "vendor/lib/lib.txt", view: "base" });
    const libDiff = await diffWorkspaceFile({ cwd: root, path: "vendor/lib/lib.txt" });
    const baseParent = await readWorkspaceFile({ cwd: root, path: "tracked.txt", view: "base" });
    assert.equal(currentLib.text?.replaceAll("\r\n", "\n"), "lib\ndirty\n");
    assert.equal(baseLib.text?.replaceAll("\r\n", "\n").trim(), "lib");
    assert.match(libDiff.text ?? "", /^\+dirty$/m);
    assert.equal(baseParent.text?.replaceAll("\r\n", "\n").trim(), "parent");
    await addSubmodule(secondOrigin, join("vendor", "newmod"));
    const staged = await listWorkspaceFiles({ cwd: root });
    const stagedBase = await readWorkspaceFile({ cwd: root, path: "vendor/newmod/nested.txt", view: "base" });
    assert.equal(staged.files.find(file => file.path === "vendor/newmod/nested.txt")?.status, "added");
    assert.equal(stagedBase.state, "deleted");

    // A submodule commit with an unchanged tree remains visible as a gitlink-only change.
    const pointerBefore = await worktreeSnapshot(root);
    assert.ok(pointerBefore);
    await git(submodulePath, [
      "-c",
      "user.email=pylon@test.local",
      "-c",
      "user.name=Pylon",
      "commit",
      "--allow-empty",
      "-qm",
      "pointer only",
    ]);
    const pointerAfter = await worktreeSnapshot(root);
    assert.ok(pointerAfter);
    assert.ok((await worktreeDiff(pointerBefore, pointerAfter))?.some(file => file.path === "vendor/lib"));

    // A committed content change is expanded to files and suppresses the parent gitlink patch.
    await writeFile(join(submodulePath, "lib.txt"), "lib\ndirty\ncommitted turn\n");
    await git(submodulePath, ["add", "lib.txt"]);
    await git(submodulePath, [
      "-c",
      "user.email=pylon@test.local",
      "-c",
      "user.name=Pylon",
      "commit",
      "-qm",
      "content turn",
    ]);
    const committedAfter = await worktreeSnapshot(root);
    assert.ok(committedAfter);
    assert.deepEqual(await worktreeDiff(pointerAfter, committedAfter), [
      { path: "vendor/lib/lib.txt", additions: 1, deletions: 0 },
    ]);
    const committedBranch = turnsBranchForSession("submodule-commit-turn");
    assert.ok(committedBranch);
    const committedAnchor = await anchorWorktreeTurn(pointerAfter, committedAfter, committedBranch);
    assert.deepEqual(
      committedAnchor?.repositories?.map(repository => repository.path),
      ["vendor/lib"],
    );
    const committedPatch = committedAnchor && (await turnWorktreeDiff(root, committedAnchor));
    const committedText = committedPatch?.state === "available" ? committedPatch.text : "";
    assert.match(committedText, /a\/vendor\/lib\/lib\.txt/);
    assert.doesNotMatch(committedText, /diff --git a\/vendor\/lib b\/vendor\/lib/);
    await removeWorktreeTurnRefs(root, committedBranch);

    const initializedBeforeRemoval = committedAfter;

    // Uninitialized registered submodules degrade to folder markers without misreading through the parent.
    await rm(submodulePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const uninitializedAfterRemoval = await worktreeSnapshot(root);
    assert.ok(uninitializedAfterRemoval);
    assert.ok(
      (await worktreeDiff(initializedBeforeRemoval, uninitializedAfterRemoval))?.some(
        file => file.path === "vendor/lib",
      ),
    );
    const broken = await listWorkspaceFiles({ cwd: root });
    const brokenCurrent = await readWorkspaceFile({ cwd: root, path: "vendor/lib/lib.txt", view: "current" });
    const brokenDiff = await diffWorkspaceFile({ cwd: root, path: "vendor/lib/lib.txt" });
    assert.equal(broken.files.find(file => file.path === "vendor/lib")?.kind, "submodule");
    assert.ok(!broken.files.some(file => file.path.startsWith("vendor/lib/")));
    assert.equal(brokenCurrent.state, "deleted");
    assert.equal(brokenDiff.text, undefined);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(originRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

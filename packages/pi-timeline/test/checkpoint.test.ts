import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import extension from "../extensions/pi-timeline.ts";
import { capture } from "../src/snapshot.ts";
import { restore } from "../src/restore.ts";

const exec = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-timeline-test-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "timeline@test.local");
  await git("config", "user.name", "timeline-test");
  await writeFile(join(root, ".gitignore"), "ignored.log\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", ".gitignore", "tracked.txt");
  await git("commit", "-qm", "base");
  return { root, git };
}

test("automatic checkpoints skip read-only turns and unchanged bash", async () => {
  const { root } = await repository();
  const entries = [{
    type: "message", id: "user-1",
    message: { role: "user", content: "Inspect then update" },
  }];
  const handlers = new Map<string, Function[]>(), appended: any[] = [];
  const pi: any = {
    events: { on: () => () => {} },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand() {},
    appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
    setSessionName() {},
  };
  extension(pi, undefined, { artifactRoot: join(root, "timeline-artifacts") });
  const ctx: any = {
    cwd: root,
    hasUI: false,
    mode: "json",
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => undefined,
      getSessionId: () => "mutation-aware-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(appended.filter((entry) => entry.customType === "pi-prompt-checkpoint").length, 0);

    await handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "read-only" }, ctx);
    await handlers.get("tool_result")![0]({ toolName: "bash", toolCallId: "read-only" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(appended.filter((entry) => entry.customType === "pi-prompt-checkpoint").length, 0);

    await writeFile(join(root, "tracked.txt"), "changed\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    const checkpoints = appended.filter((entry) => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoints.length, 1);
    await deleteRefs(root, [checkpoints[0].data.worktreeRef, checkpoints[0].data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function deleteRefs(root: string, refs: string[]) {
  for (const ref of refs)
    await exec("git", ["update-ref", "-d", ref], { cwd: root });
}

test("timeline rejects incompatible targets before rollback capture", async () => {
  const { root, git } = await repository();
  try {
    const head = await git("rev-parse", "HEAD"),
      checkpointTime = "2026-02-18T12:34:56.789Z",
      displayedTime = "2026-02-18T12:34:56Z",
      entries = [
        { type: "message", id: "user-1", message: { role: "user", content: "Old prompt" } },
        {
          type: "custom",
          customType: "pi-prompt-checkpoint",
          id: "checkpoint-1",
          data: {
            version: 3,
            kind: "pi-prompt-checkpoint",
            promptEntryId: "user-1",
            ownerSessionId: "test-session",
            continuationEntryId: "user-1",
            createdAt: checkpointTime,
            snapshotId: "old",
            gitRoot: root,
            head: head === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40),
            headRef: "refs/heads/main",
            worktreeRef: "refs/pi-timeline/test/old/worktree",
            indexRef: "refs/pi-timeline/test/old/index",
            worktreeTree: head,
            indexTree: head,
          },
        },
        {
          type: "custom",
          customType: "pi-prompt-checkpoint",
          id: "checkpoint-unsupported",
          data: {
            version: 3,
            kind: "pi-prompt-checkpoint",
            promptEntryId: "user-1",
            ownerSessionId: "test-session",
            continuationEntryId: "user-1",
            createdAt: checkpointTime,
            snapshotId: "unsupported-without-head-ref",
            gitRoot: root,
            head,
            worktreeRef: "refs/pi-timeline/test/unsupported/worktree",
            indexRef: "refs/pi-timeline/test/unsupported/index",
            worktreeTree: head,
            indexTree: head,
          },
        },
      ],
      handlers = new Map<string, Function[]>(),
      commands = new Map<string, any>(),
      notices: string[] = [],
      selections: string[][] = [];
    let appended = 0;
    const pi: any = {
      events: { on: () => () => {} },
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      appendEntry: () => { appended++; },
      setSessionName() {},
    };
    extension(pi, undefined, { artifactRoot: join(root, "timeline-artifacts") });
    const ctx: any = {
      cwd: root,
      hasUI: true,
      mode: "tui",
      waitForIdle: async () => {},
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus() {},
        select: async (_title: string, options: string[]) => {
          selections.push(options);
          return undefined;
        },
      },
      sessionManager: {
        getEntries: () => entries,
        getSessionId: () => "test-session",
        getSessionFile: () => undefined,
      },
    };
    await handlers.get("session_start")![0]({}, ctx);
    await commands.get("timeline").handler("list", ctx);
    assert.match(notices.at(-1)!, new RegExp(`\\[blocked:HEAD\\] ${displayedTime} Old prompt`));
    assert.doesNotMatch(notices.at(-1)!, /branch:unknown|unsupported-without-head-ref|test-session:checkpoint/);
    await commands.get("timeline").handler("", ctx);
    assert.equal(selections.length, 1);
    assert.ok(selections[0]!.every((row) => row.includes(` ${displayedTime} Old prompt`)));
    assert.ok(selections[0]!.every((row) => !row.includes("test-session:checkpoint")));
    await commands.get("timeline").handler("jump test-session:checkpoint-1", ctx);
    assert.equal(appended, 0);
    assert.match(notices.at(-1)!, /HEAD commit differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture completes and restore preserves ignored files", { timeout: 20_000 }, async () => {
  const { root, git } = await repository();
  try {
    await writeFile(join(root, "tracked.txt"), "checkpoint\n");
    await writeFile(join(root, "ordinary.txt"), "ordinary\n");
    await writeFile(join(root, "ignored.log"), "ignored-before\n");
    const snapshot = await capture(root, "test-session");
    assert.match(snapshot.worktreeTree, /^[0-9a-f]{40}$/);
    assert.match(snapshot.headRef!, /^refs\/heads\//);
    assert.equal(
      (await git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"))
        .split(/\r?\n/)
        .filter(Boolean).length,
      2,
    );

    await writeFile(join(root, "tracked.txt"), "later\n");
    await rm(join(root, "ordinary.txt"));
    await writeFile(join(root, "ignored.log"), "ignored-later\n");
    await restore(snapshot);

    assert.equal(
      (await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "checkpoint\n",
    );
    assert.equal(
      (await readFile(join(root, "ordinary.txt"), "utf8")).replace(/\r\n/g, "\n"),
      "ordinary\n",
    );
    assert.equal(await readFile(join(root, "ignored.log"), "utf8"), "ignored-later\n");
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture and restore include initialized gitlinks without .gitmodules", { timeout: 20_000 }, async () => {
  const { root, git } = await repository(), child = join(root, "vendor", "child");
  const childGit = async (...args: string[]) =>
    (await exec("git", args, { cwd: child, windowsHide: true })).stdout.trim();
  try {
    await mkdir(child, { recursive: true });
    await childGit("init", "-q");
    await childGit("config", "user.email", "timeline@test.local");
    await childGit("config", "user.name", "timeline-test");
    await writeFile(join(child, "child.txt"), "base\n");
    await childGit("add", "child.txt");
    await childGit("commit", "-qm", "base");
    await git("add", "vendor/child");
    await git("commit", "-qm", "add nested repository");
    await assert.rejects(access(join(root, ".gitmodules")));

    await writeFile(join(child, "child.txt"), "checkpoint worktree\n");
    await writeFile(join(child, "staged.txt"), "checkpoint index\n");
    await childGit("add", "staged.txt");
    await writeFile(join(child, "staged.txt"), "checkpoint worktree\n");
    await writeFile(join(child, "ordinary.txt"), "checkpoint ordinary\n");
    const ownedRoots: string[] = [], snapshot = await capture(
      root,
      "nested-session",
      async (repositoryRoot) => { ownedRoots.push(repositoryRoot); },
    );
    assert.deepEqual(new Set(ownedRoots), new Set([root, child]));
    assert.equal(snapshot.nested?.length, 1);
    assert.equal(snapshot.nested![0].prefix, "vendor/child");

    await writeFile(join(child, "child.txt"), "later\n");
    await writeFile(join(child, "staged.txt"), "later\n");
    await rm(join(child, "ordinary.txt"));
    await childGit("add", "-A");
    await restore(snapshot);

    assert.equal((await readFile(join(child, "child.txt"), "utf8")).replace(/\r\n/g, "\n"), "checkpoint worktree\n");
    assert.equal((await readFile(join(child, "staged.txt"), "utf8")).replace(/\r\n/g, "\n"), "checkpoint worktree\n");
    assert.equal((await readFile(join(child, "ordinary.txt"), "utf8")).replace(/\r\n/g, "\n"), "checkpoint ordinary\n");
    assert.equal(await childGit("show", ":staged.txt"), "checkpoint index");
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
    await deleteRefs(child, [snapshot.nested![0].worktreeRef, snapshot.nested![0].indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture records detached HEAD", async () => {
  const { root, git } = await repository();
  try {
    await git("checkout", "--detach", "-q");
    const snapshot = await capture(root, "detached-session");
    assert.equal(snapshot.headRef, null);
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore validates objects before mutation", async () => {
  const { root } = await repository();
  try {
    const snapshot = await capture(root, "test-session");
    await writeFile(join(root, "tracked.txt"), "safe\n");
    await assert.rejects(
      restore({ ...snapshot, worktreeTree: "not-an-object" }),
      /Invalid checkpoint object ID/,
    );
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "safe\n");
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import extension from "../extensions/pi-timeline.ts";
import { capture, makePortable } from "../src/snapshot.ts";
import { verificationWorktreeState, type CommandExecutor } from "pylon-core/verification-worktree";
import { restore } from "../src/restore.ts";

const exec = promisify(execFile);
const execute: CommandExecutor = async (command, args, options) => {
  try {
    const result = await exec(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeout,
      windowsHide: true,
    });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error: any) {
    return {
      code: typeof error?.code === "number" ? error.code : null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
    };
  }
};

async function requiredVerificationState(root: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await verificationWorktreeState(execute, root);
    if (state) return state;
    await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
  }
  assert.fail(`Unable to inspect verification worktree state for ${root}`);
}
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-timeline-checkpoint-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-timeline-test-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "timeline@test.local");
  await git("config", "user.name", "timeline-test");
  await writeFile(join(root, ".gitignore"), "ignored.log\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", ".gitignore", "tracked.txt");
  await git("commit", "-qm", "base");
  return { root, git };
}

async function deleteRefs(root: string, refs: string[]) {
  for (const ref of refs) await exec("git", ["update-ref", "-d", ref], { cwd: root });
}

test("Heartbeat completion delays checkpoints and Grunt mutations are captured", async () => {
  const { root } = await repository();
  const entries: any[] = [
    { type: "message", id: "user-1", message: { role: "user", content: "Start background work" } },
  ];
  const handlers = new Map<string, Function[]>(),
    eventHandlers = new Map<string, Set<Function>>(),
    appended: any[] = [];
  const events = {
    on(name: string, handler: Function) {
      const values = eventHandlers.get(name) ?? new Set();
      values.add(handler);
      eventHandlers.set(name, values);
      return () => values.delete(handler);
    },
    async emit(name: string, value: any) {
      await Promise.all([...(eventHandlers.get(name) ?? [])].map(handler => handler(value)));
    },
  };
  const pi: any = {
    events,
    exec: execute,
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
      getSessionId: () => "integration-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await handlers.get("agent_start")![0]({}, ctx);
    await events.emit("pi-heartbeat:job", {
      version: 1,
      id: "foreign-job",
      sessionId: "other-session",
      cwd: root,
      state: "running",
    });
    await events.emit("pi-heartbeat:job", {
      version: 1,
      id: "job-1",
      sessionId: "integration-session",
      cwd: root,
      state: "running",
    });
    await handlers.get("tool_result")![0]({ toolName: "heartbeat_start", toolCallId: "heartbeat" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(appended.filter(entry => entry.customType === "pi-prompt-checkpoint").length, 0);
    await writeFile(join(root, "tracked.txt"), "background\n");
    await events.emit("pi-heartbeat:job", {
      version: 1,
      id: "job-1",
      sessionId: "integration-session",
      cwd: root,
      state: "completed",
    });
    assert.equal(appended.filter(entry => entry.customType === "pi-prompt-checkpoint").length, 1);

    entries.push({ type: "message", id: "user-2", message: { role: "user", content: "Delegate edit" } });
    await handlers.get("input")![0]({ source: "interactive" }, ctx);
    await handlers.get("agent_start")![0]({}, ctx);
    await handlers.get("tool_call")![0]({ toolName: "grunt", toolCallId: "grunt-1" }, ctx);
    await writeFile(join(root, "tracked.txt"), "delegated\n");
    await handlers.get("tool_result")![0]({ toolName: "grunt", toolCallId: "grunt-1" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    let checkpoints = appended.filter(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoints.length, 2);

    entries.push({ type: "message", id: "user-3", message: { role: "user", content: "Handle overlapping edits" } });
    await handlers.get("input")![0]({ source: "interactive" }, ctx);
    await handlers.get("agent_start")![0]({}, ctx);
    await writeFile(join(root, "tracked.txt"), "race-one\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-race" }, ctx);
    const settling = handlers.get("agent_settled")![0]({}, ctx);
    await writeFile(join(root, "tracked.txt"), "race-two\n");
    await handlers.get("tool_result")![0]({ toolName: "edit", toolCallId: "edit-race" }, ctx);
    const shutdown = handlers.get("session_shutdown")![0]();
    await Promise.all([settling, shutdown]);
    checkpoints = appended.filter(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoints.length, 4, "shutdown drains a mutation arriving during capture");
    for (const checkpoint of checkpoints)
      await deleteRefs(root, [checkpoint.data.worktreeRef, checkpoint.data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guard checkpoint requests persist only the bounded source", async () => {
  const { root } = await repository();
  const entries: any[] = [{ type: "message", id: "user-1", message: { role: "user", content: "Approve a change" } }];
  const handlers = new Map<string, Function[]>(),
    eventHandlers = new Map<string, Set<Function>>(),
    appended: any[] = [];
  const events = {
    on(name: string, handler: Function) {
      const values = eventHandlers.get(name) ?? new Set<Function>();
      values.add(handler);
      eventHandlers.set(name, values);
      return () => values.delete(handler);
    },
    async emit(name: string, value: any) {
      await Promise.all([...(eventHandlers.get(name) ?? [])].map(handler => handler(value)));
    },
  };
  const pi: any = {
    events,
    exec: execute,
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
      getSessionId: () => "guard-source-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    let requested: Promise<unknown> | undefined;
    await events.emit("pi-timeline:checkpoint-request", {
      version: 1,
      cwd: root,
      source: "pi-guard",
      reason: "secret guard reason must not be persisted",
      respond: (value: Promise<unknown>) => {
        requested = value;
      },
    });
    await requested;
    const checkpoint = appended.find(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoint.data.source, "pi-guard");
    assert.equal("reason" in checkpoint.data, false);
    let state: any;
    const stateRequest = [...(eventHandlers.get("pi-timeline:state-request") ?? [])][0];
    stateRequest({ version: 4, sessionId: "guard-source-session", respond: (value: any) => (state = value) });
    assert.equal(state.checkpoints[0].source, "pi-guard");
    await deleteRefs(root, [checkpoint.data.worktreeRef, checkpoint.data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline rejects incompatible targets before rollback capture", async () => {
  const { root, git } = await repository();
  try {
    const head = await git("rev-parse", "HEAD"),
      checkpointTime = "2026-02-18T12:34:56.789Z",
      displayedTime = "12:34:56",
      entries = [
        { type: "message", id: "user-1", message: { role: "user", content: "Old prompt" } },
        {
          type: "custom",
          customType: "pi-prompt-checkpoint",
          id: "checkpoint-1",
          data: {
            version: 4,
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
            version: 4,
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
      exec: execute,
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      appendEntry: () => {
        appended++;
      },
      setSessionName() {},
    };
    extension(pi, undefined, { artifactRoot: join(root, "timeline-artifacts") });
    let idleWaits = 0;
    const ctx: any = {
      cwd: root,
      hasUI: true,
      mode: "tui",
      waitForIdle: async () => {
        idleWaits++;
      },
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
    await commands.get("timeline").handler("jump test-session:checkpoint-1", ctx);
    assert.equal(idleWaits, 0, "invalid action does not wait or begin restore work");
    assert.equal(selections.length, 0, "invalid action does not prompt for confirmation");
    assert.equal(appended, 0, "invalid action does not checkpoint");
    await commands.get("timeline").handler("list", ctx);
    assert.match(notices.at(-1)!, new RegExp(`\\[blocked:HEAD\\]\\s+${displayedTime}\\s+Old prompt`));
    assert.doesNotMatch(notices.at(-1)!, /branch:unknown|unsupported-without-head-ref|test-session:checkpoint/);
    await commands.get("timeline").handler("select", ctx);
    assert.equal(selections.length, 1);
    assert.ok(selections[0]!.every(row => new RegExp(`${displayedTime}\\s+Old prompt`).test(row)));
    assert.ok(selections[0]!.every(row => !row.includes("test-session:checkpoint")));
    await commands.get("timeline").handler("restore test-session:checkpoint-1", ctx);
    assert.equal(appended, 0);
    assert.match(notices.at(-1)!, /HEAD commit differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web prompt editing restores the nearest earlier checkpoint and can roll back", async () => {
  const { root } = await repository();
  const artifactRoot = join(root, "timeline-artifacts");
  let checkpoint: Awaited<ReturnType<typeof capture>> | undefined;
  try {
    await writeFile(join(root, "tracked.txt"), "after first turn\n");
    checkpoint = await capture(root, "edit-session");
    await writeFile(join(root, "tracked.txt"), "current work\n");
    const entries = [
      { type: "message", id: "user-1", parentId: null, message: { role: "user", content: "First prompt" } },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: { role: "assistant", content: "First answer" },
      },
      {
        type: "custom",
        customType: "pi-prompt-checkpoint",
        id: "checkpoint-1",
        parentId: "assistant-1",
        data: {
          version: 4,
          kind: "pi-prompt-checkpoint",
          promptEntryId: "user-1",
          ownerSessionId: "edit-session",
          continuationEntryId: "assistant-1",
          createdAt: new Date(0).toISOString(),
          ...checkpoint,
        },
      },
      { type: "message", id: "user-2", parentId: "checkpoint-1", message: { role: "user", content: "Second prompt" } },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        message: { role: "assistant", content: "Second answer" },
      },
    ];
    const sessionHandlers = new Map<string, Function[]>();
    const eventHandlers = new Map<string, Function>();
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const mutations: any[] = [];
    let confirmations = 0;
    let forks = 0;
    const pi: any = {
      events: {
        on: (name: string, handler: Function) => {
          eventHandlers.set(name, handler);
          return () => eventHandlers.delete(name);
        },
        emit(name: string, value: any) {
          if (name === "pi-worktree:mutation") mutations.push(value);
        },
      },
      exec: execute,
      on: (name: string, handler: Function) =>
        sessionHandlers.set(name, [...(sessionHandlers.get(name) ?? []), handler]),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      appendEntry() {},
      setSessionName() {},
    };
    extension(pi, undefined, { artifactRoot });
    const ctx: any = {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      waitForIdle: async () => {},
      sessionManager: {
        getBranch: () => entries,
        getEntries: () => entries,
        getLeafId: () => "assistant-2",
        getSessionFile: () => undefined,
        getSessionId: () => "edit-session",
      },
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus() {},
        confirm: async () => {
          confirmations++;
          return false;
        },
      },
      fork: async (_entryId: string, options: any) => {
        forks++;
        await options.withSession({
          cwd: root,
          sendMessage: async () => {},
          ui: { notify: (message: string) => notices.push(message) },
        });
      },
    };
    await sessionHandlers.get("session_start")![0]({}, ctx);
    let state: any;
    eventHandlers.get("pi-timeline:state-request")!({
      version: 4,
      sessionId: "edit-session",
      respond: (value: unknown) => {
        state = value;
      },
    });
    assert.deepEqual(state.undoPromptEntryIds, ["user-2"]);
    const timelineCheckpointId = state.checkpoints[0].id;

    let operation: Promise<any> | undefined;
    eventHandlers.get("pi-timeline:edit-navigation")!({
      version: 1,
      sessionId: "edit-session",
      targetEntryId: "user-2",
      rollbackFiles: true,
      respond: (value: Promise<any>) => {
        operation = value;
      },
    });
    const transaction = await operation;
    await sessionHandlers.get("session_tree")![0]({}, ctx);
    assert.deepEqual(notices, []);
    await transaction.apply();
    assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "after first turn\n");
    assert.equal(mutations.length, 1);
    assert.deepEqual(
      {
        version: mutations[0].version,
        cwd: mutations[0].cwd,
        changed: mutations[0].changed,
        source: mutations[0].source,
        operation: mutations[0].operation,
      },
      { version: 1, cwd: root, changed: true, source: "pi-timeline", operation: "edit-navigation-restore" },
    );
    await transaction.rollback();
    assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "current work\n");

    let forkAvailability: any;
    eventHandlers.get("pi-timeline:prompt-fork")!({
      version: 1,
      sessionId: "edit-session",
      checkpointId: timelineCheckpointId,
      respond: (value: unknown) => {
        forkAvailability = value;
      },
    });
    assert.deepEqual(forkAvailability, { version: 1, available: true });
    await commands.get("timeline").handler(`fork ${timelineCheckpointId}`, ctx);
    assert.equal(confirmations, 0);
    assert.equal(forks, 1);
  } finally {
    if (checkpoint) await deleteRefs(root, [checkpoint.worktreeRef, checkpoint.indexRef]);
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
      (await git("for-each-ref", "--format=%(refname)", "refs/pi-timeline")).split(/\r?\n/).filter(Boolean).length,
      2,
    );

    await writeFile(join(root, "tracked.txt"), "later\n");
    await rm(join(root, "ordinary.txt"));
    await writeFile(join(root, "ignored.log"), "ignored-later\n");
    await restore(snapshot);

    assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "checkpoint\n");
    assert.equal((await readFile(join(root, "ordinary.txt"), "utf8")).replace(/\r\n/g, "\n"), "ordinary\n");
    assert.equal(await readFile(join(root, "ignored.log"), "utf8"), "ignored-later\n");
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture and restore include initialized gitlinks without .gitmodules", { timeout: 20_000 }, async () => {
  const { root, git } = await repository(),
    child = join(root, "vendor", "child");
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
    const ownedRoots: string[] = [],
      snapshot = await capture(root, "nested-session", async repositoryRoot => {
        ownedRoots.push(repositoryRoot);
      });
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
    await assert.rejects(restore({ ...snapshot, worktreeTree: "not-an-object" }), /Invalid checkpoint object ID/);
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "safe\n");
    await deleteRefs(root, [snapshot.worktreeRef, snapshot.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint titles are generated after capture and survive reload", async () => {
  const { root } = await repository();
  const configPath = join(root, "timeline-config.json");
  const entries: any[] = [
    {
      type: "message",
      id: "user-1",
      message: { role: "user", content: "Please fix the duplicate checkout submission bug" },
    },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", content: "Added an idempotency guard and regression coverage." },
    },
    { type: "session_info", id: "name-1", name: "Existing session name" },
  ];
  const handlers = new Map<string, Function[]>(),
    eventHandlers = new Map<string, Function>(),
    calls: any[] = [];
  let nextEntry = 0;
  const pi: any = {
    events: {
      on: (name: string, handler: Function) => {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      },
      emit() {},
    },
    exec: execute,
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand() {},
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", id: `generated-${++nextEntry}`, customType, data }),
    setSessionName() {},
  };
  await writeFile(
    configPath,
    JSON.stringify({ version: 1, editRollbackDefault: false, useSessionModelForCheckpointTitles: true }),
  );
  extension(
    pi,
    (async (...args: any[]) => {
      calls.push(args);
      return { content: [{ type: "text", text: "Prevent Duplicate Checkout Submissions" }] };
    }) as any,
    { artifactRoot: join(root, "timeline-artifacts"), configPath },
  );
  const ctx: any = {
    cwd: root,
    hasUI: false,
    model: { provider: "test", id: "cheap-title-model" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
      find: () => undefined,
    },
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => undefined,
      getSessionId: () => "checkpoint-title-session",
    },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await writeFile(join(root, "tracked.txt"), "checkout guard\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-1" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    await new Promise<void>(resolve => setImmediate(resolve));

    const checkpoint = entries.find(entry => entry.customType === "pi-prompt-checkpoint");
    const title = entries.find(entry => entry.customType === "pi-checkpoint-title");
    assert.ok(checkpoint);
    assert.ok(title);
    assert.equal(title.data.checkpointEntryId, checkpoint.id);
    assert.equal(title.data.title, "Prevent Duplicate Checkout Submissions");
    assert.equal(calls.length, 1);
    assert.match(calls[0][1].messages[0].content[0].text, /idempotency guard/);
    assert.match(calls[0][1].messages[0].content[0].text, /modified: tracked\.txt/);

    await handlers.get("session_start")![0]({ reason: "reload" }, ctx);
    let snapshot: any;
    eventHandlers.get("pi-timeline:state-request")!({
      version: 4,
      sessionId: "checkpoint-title-session",
      respond: (value: any) => {
        snapshot = value;
      },
    });
    assert.equal(snapshot.checkpoints[0].title, "Prevent Duplicate Checkout Submissions");
    assert.equal(snapshot.checkpoints[0].promptEntryId, "user-1");
    assert.notEqual(snapshot.checkpoints[0].title, "Please fix the duplicate checkout submission bug");
    await deleteRefs(root, [checkpoint.data.worktreeRef, checkpoint.data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

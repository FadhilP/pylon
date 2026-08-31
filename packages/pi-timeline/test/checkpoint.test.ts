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

test("version 4 checkpoints restore across linked worktrees and v3 migrates only at origin", async () => {
  const { root, git } = await repository();
  const linked = `${root}-linked`;
  try {
    await writeFile(join(root, "tracked.txt"), "checkpoint\n");
    const snapshot = await capture(root, "portable-session");
    await git("worktree", "add", "--detach", linked, "HEAD");
    await restore(snapshot, linked);
    assert.equal((await readFile(join(linked, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "checkpoint\n");

    const legacy = {
      ...snapshot,
      commonDir: undefined,
      nested: snapshot.nested?.map(repository => ({ ...repository, commonDir: undefined })),
    };
    const migrated = await makePortable(legacy, root);
    assert.ok(migrated.commonDir);
    await assert.rejects(() => makePortable(legacy, linked), /original checkout/);
  } finally {
    await exec("git", ["worktree", "remove", "--force", linked], { cwd: root, windowsHide: true }).catch(() => {});
    await rm(linked, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic checkpoints skip read-only turns and unchanged bash", async () => {
  const { root } = await repository();
  const entries = [{ type: "message", id: "user-1", message: { role: "user", content: "Inspect then update" } }];
  const handlers = new Map<string, Function[]>(),
    appended: any[] = [];
  const pi: any = {
    events: { on: () => () => {} },
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
      getSessionId: () => "mutation-aware-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(appended.filter(entry => entry.customType === "pi-prompt-checkpoint").length, 0);

    await handlers.get("tool_call")![0]({ toolName: "bash", toolCallId: "read-only" }, ctx);
    await handlers.get("tool_result")![0]({ toolName: "bash", toolCallId: "read-only" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(appended.filter(entry => entry.customType === "pi-prompt-checkpoint").length, 0);

    await writeFile(join(root, "tracked.txt"), "changed\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    const checkpoints = appended.filter(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoints.length, 1);
    await deleteRefs(root, [checkpoints[0].data.worktreeRef, checkpoints[0].data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint capture failures are bounded per prompt and cleared by a successful retry", async () => {
  const { root } = await repository();
  const entries: any[] = [
    { type: "message", id: "user-1", message: { role: "user", content: `Update files in ${root}` } },
  ];
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function>();
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
      entries.push({ type: "custom", id: `entry-${++nextEntry}`, customType, data }),
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
      getSessionId: () => "capture-failure-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  const snapshot = () => {
    let value: any;
    eventHandlers.get("pi-timeline:state-request")!({
      version: 4,
      sessionId: "capture-failure-session",
      respond: (state: any) => {
        value = state;
      },
    });
    return value;
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await writeFile(join(root, ".env"), "SECRET=test\n");

    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-1" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(snapshot().failures.length, 1);
    assert.equal(snapshot().failures[0].promptEntryId, "user-1");
    assert.match(snapshot().failures[0].reason, /Unsafe untracked path: \.env/);
    assert.doesNotMatch(snapshot().failures[0].reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(snapshot().failures.length, 1, "the same prompt has at most one capture failure");

    await rm(join(root, ".env"));
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-2" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(snapshot().failures.length, 0);
    assert.equal(snapshot().checkpoints.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first checkpoint changes use the persisted session-start baseline", async () => {
  const { root } = await repository();
  await writeFile(join(root, "tracked.txt"), "dirty before session\n");
  await writeFile(join(root, "preexisting.txt"), "keep me\n");
  const entries: any[] = [
    { type: "message", id: "user-1", message: { role: "user", content: "Change only this session" } },
    { type: "session_info", id: "name-1", name: "Existing name" },
  ];
  const handlers = new Map<string, Function[]>(),
    eventHandlers = new Map<string, Function>();
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
      entries.push({ type: "custom", id: `entry-${++nextEntry}`, customType, data }),
    setSessionName() {},
  };
  extension(pi, undefined, { artifactRoot: join(root, "timeline-artifacts") });
  const ctx: any = {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => undefined,
      getSessionId: () => "baseline-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await writeFile(join(root, "tracked.txt"), "changed during session\n");
    await writeFile(join(root, "session-only.txt"), "new work\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-1" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);

    const checkpoint = entries.find(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoint.data.version, 6);
    assert.ok(checkpoint.data.baseline);
    assert.equal(checkpoint.data.changes.fileCount, 2);

    const requestFiles = async () => {
      let response: any;
      eventHandlers.get("pi-timeline:files-request")!({
        version: 1,
        sessionId: "baseline-session",
        checkpointId: `baseline-session:${checkpoint.id}`,
        respond: (value: any) => {
          response = value;
        },
      });
      return await response;
    };
    const requestDiff = async () => {
      let response: any;
      eventHandlers.get("pi-timeline:diff-request")!({
        version: 1,
        sessionId: "baseline-session",
        checkpointId: `baseline-session:${checkpoint.id}`,
        path: "tracked.txt",
        respond: (value: any) => {
          response = value;
        },
      });
      return await response;
    };

    assert.deepEqual(
      (await requestFiles()).files.map((file: any) => file.path),
      ["session-only.txt", "tracked.txt"],
    );
    assert.doesNotMatch(JSON.stringify(await requestFiles()), /preexisting\.txt/);
    assert.match((await requestDiff()).text, /-dirty before session/);
    assert.match((await requestDiff()).text, /\+changed during session/);

    await handlers.get("session_start")![0]({ reason: "reload" }, ctx);
    assert.deepEqual(
      (await requestFiles()).files.map((file: any) => file.path),
      ["session-only.txt", "tracked.txt"],
    );
    assert.match((await requestDiff()).text, /-dirty before session/);

    await rm(join(root, "preexisting.txt"));
    await restore(checkpoint.data, root);
    assert.equal((await readFile(join(root, "preexisting.txt"), "utf8")).replaceAll("\r\n", "\n"), "keep me\n");
    await deleteRefs(root, [checkpoint.data.worktreeRef, checkpoint.data.indexRef]);
    await deleteRefs(root, [checkpoint.data.baseline.worktreeRef, checkpoint.data.baseline.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only persistent sessions retire unused baseline refs on quit", async () => {
  const { root, git } = await repository();
  const entries: any[] = [];
  const handlers = new Map<string, Function[]>();
  let nextEntry = 0;
  const pi: any = {
    events: { on: () => () => {}, emit() {} },
    exec: execute,
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand() {},
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", id: `entry-${++nextEntry}`, customType, data }),
    setSessionName() {},
  };
  extension(pi, undefined, { artifactRoot: join(root, "timeline-artifacts") });
  const ctx: any = {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => join(root, "session.jsonl"),
      getSessionId: () => "read-only-persistent-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    assert.equal(
      (await git("for-each-ref", "--format=%(refname)", "refs/pi-timeline")).split(/\r?\n/).filter(Boolean).length,
      2,
    );
    await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    assert.equal(await git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"), "");
    assert.ok(entries.some(entry => entry.customType === "pi-timeline-baseline-retired"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic checkpoints attach matching verification outcomes only", async () => {
  const { root } = await repository();
  const entries: any[] = [{ type: "message", id: "user-1", message: { role: "user", content: "Update and verify" } }];
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
  extension(pi, undefined, { artifactRoot: join(isolatedAgentDir, "timeline-verification-artifacts") });
  const ctx: any = {
    cwd: root,
    hasUI: false,
    mode: "json",
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => undefined,
      getSessionId: () => "verified-session",
    },
    ui: { notify() {}, setStatus() {} },
  };
  try {
    await handlers.get("session_start")![0]({}, ctx);
    await writeFile(join(root, "tracked.txt"), "verified\n");
    await handlers.get("tool_result")![0]({ toolName: "write", toolCallId: "write-1" }, ctx);
    const verifiedState = await requiredVerificationState(root);
    await events.emit("pi-verify:result", {
      version: 1,
      sessionId: "verified-session",
      cwd: root,
      runId: "run-1",
      state: "passed",
      scope: "changed",
      worktreeId: verifiedState.id,
      results: [{ label: "tests" }],
    });
    await handlers.get("agent_settled")![0]({}, ctx);

    entries.push({ type: "message", id: "user-2", message: { role: "user", content: "Change after verify" } });
    await events.emit("pi-verify:result", {
      version: 1,
      sessionId: "verified-session",
      cwd: root,
      runId: "run-2",
      state: "passed",
      scope: "changed",
      worktreeId: verifiedState.id,
      results: [{ label: "tests" }],
    });
    await writeFile(join(root, "tracked.txt"), "changed after verification\n");
    await handlers.get("tool_result")![0]({ toolName: "edit", toolCallId: "edit-1" }, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);

    entries.push({ type: "message", id: "user-3", message: { role: "user", content: "Fail verification" } });
    await writeFile(join(root, "tracked.txt"), "failed verification\n");
    await handlers.get("tool_result")![0]({ toolName: "edit", toolCallId: "edit-2" }, ctx);
    const failedState = await requiredVerificationState(root);
    await events.emit("pi-verify:result", {
      version: 1,
      sessionId: "verified-session",
      cwd: root,
      runId: "run-3",
      state: "failed",
      scope: "changed",
      worktreeId: failedState.id,
      results: [{ label: "tests" }],
    });
    await handlers.get("agent_settled")![0]({}, ctx);

    const checkpoints = appended.filter(entry => entry.customType === "pi-prompt-checkpoint");
    assert.equal(checkpoints[0]?.data.verification?.state, "passed");
    assert.equal(checkpoints[1]?.data.verification, undefined);
    assert.equal(checkpoints[2]?.data.verification?.state, "failed");
    for (const checkpoint of checkpoints)
      await deleteRefs(root, [checkpoint.data.worktreeRef, checkpoint.data.indexRef]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function deleteRefs(root: string, refs: string[]) {
  for (const ref of refs) await exec("git", ["update-ref", "-d", ref], { cwd: root });
}

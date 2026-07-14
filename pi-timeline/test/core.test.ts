import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import extension from "../extensions/pi-timeline.ts";
import { capture } from "../src/snapshot.ts";
import { restore } from "../src/restore.ts";
import { preflight } from "../src/safety.ts";
import { findRunEntry, isRunEntry } from "../src/run.ts";

const exec = promisify(execFile);

function namingHarness(entries: any[], completeTitle: any = async () => ({
  content: [{ type: "text", text: "Semantic Timeline Session" }],
})) {
  const handlers = new Map<string, Function[]>(), names: string[] = [];
  const pi: any = {
    events: { on: () => () => {} },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand() {},
    setSessionName: (name: string) => names.push(name),
  };
  extension(pi, completeTitle);
  const ctx: any = {
    cwd: join(tmpdir(), "pi-timeline-naming-test"),
    hasUI: false,
    model: { provider: "test", id: "title-model" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => undefined,
      getSessionId: () => "naming-test",
    },
  };
  return { handlers, names, ctx };
}

test("settled unnamed session gets a dedicated semantic title", async () => {
  const calls: any[] = [], entries = [
    {
      type: "message", id: "user-1",
      message: { role: "user", content: "Can we add session name to the TUI?" },
    },
    {
      type: "message", id: "assistant-1",
      message: { role: "assistant", content: [{ type: "text", text: "Implemented session naming." }] },
    },
  ];
  const { handlers, names, ctx } = namingHarness(entries, async (...args: any[]) => {
    calls.push(args);
    return { content: [{ type: "text", text: "Persistent TUI Session Names" }] };
  });
  await handlers.get("session_start")![0]({}, ctx);
  await handlers.get("agent_settled")![0]({}, ctx);

  assert.deepEqual(names, ["Persistent TUI Session Names"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].messages[0].content[0].text, /Can we add session name/);
  assert.match(calls[0][1].messages[0].content[0].text, /Implemented session naming/);
  assert.equal(calls[0][2].maxTokens, 32);
  assert.equal(handlers.has("before_agent_start"), false);
  assert.equal(handlers.has("message_end"), false);
});

test("invalid or failed title generation falls back to first prompt", async () => {
  for (const completeTitle of [
    async () => ({ content: [{ type: "text", text: "Too short" }] }),
    async () => { throw new Error("unavailable"); },
  ]) {
    const entries = [{
      type: "message", id: "user-1",
      message: { role: "user", content: "  Add session naming\nwithout noise  " },
    }];
    const { handlers, names, ctx } = namingHarness(entries, completeTitle);
    await handlers.get("session_start")![0]({}, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.deepEqual(names, ["Add session naming without noise"]);
  }
});

test("pending title call is single-flight and manual rename wins", async () => {
  let calls = 0, finish!: (value: any) => void, markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const entries = [{
    type: "message", id: "user-1",
    message: { role: "user", content: "First prompt for naming" },
  }];
  const { handlers, names, ctx } = namingHarness(entries, async () => {
    calls++;
    markStarted();
    return pending;
  });
  await handlers.get("session_start")![0]({}, ctx);
  const settling = handlers.get("agent_settled")![0]({}, ctx);
  await started;
  await handlers.get("agent_settled")![0]({}, ctx);
  assert.equal(calls, 1);
  await handlers.get("session_info_changed")![0]({ name: "Manual title" }, ctx);
  finish({ content: [{ type: "text", text: "Generated Session Title" }] });
  await settling;
  assert.deepEqual(names, []);
});

test("pending title from an old session cannot rename a new session", async () => {
  let finish!: (value: any) => void, markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const entries = [{
    type: "message", id: "user-1",
    message: { role: "user", content: "Name the old session safely" },
  }];
  const { handlers, names, ctx } = namingHarness(entries, async () => {
    markStarted();
    return pending;
  });
  await handlers.get("session_start")![0]({}, ctx);
  const settling = handlers.get("agent_settled")![0]({}, ctx);
  await started;
  const nextCtx = {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getEntries: () => [{ type: "session_info", id: "name-2", name: "New session" }],
      getSessionId: () => "next-session",
    },
  };
  await handlers.get("session_start")![0]({}, nextCtx);
  finish({ content: [{ type: "text", text: "Generated Old Session Title" }] });
  await settling;
  assert.deepEqual(names, []);
});

test("existing or manually cleared session names remain untouched", async () => {
  for (const name of ["Existing name", ""]) {
    let calls = 0;
    const entries = [
      { type: "message", id: "user-1", message: { role: "user", content: "First prompt" } },
      { type: "session_info", id: "name-1", name },
    ];
    const { handlers, names, ctx } = namingHarness(entries, async () => {
      calls++;
      return { content: [{ type: "text", text: "Generated Session Title" }] };
    });
    await handlers.get("session_start")![0]({}, ctx);
    await handlers.get("agent_settled")![0]({}, ctx);
    assert.deepEqual(names, []);
    assert.equal(calls, 0);
  }
});

test("run metadata is optional and latest valid entry wins", () => {
  assert.equal(findRunEntry([]), undefined);
  const planner = {
    version: 1 as const,
    runId: "run-1",
    role: "planner" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const executor = {
    ...planner,
    role: "executor" as const,
    parentSessionId: "planner-session",
  };
  assert.equal(isRunEntry(planner), true);
  assert.deepEqual(
    findRunEntry([
      { type: "custom", customType: "pi-conductor-run", data: planner },
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pi-conductor-run", data: executor },
    ]),
    executor,
  );
});

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

async function deleteRefs(root: string, refs: string[]) {
  for (const ref of refs)
    await exec("git", ["update-ref", "-d", ref], { cwd: root });
}

test("capture completes and restore preserves ignored files", { timeout: 20_000 }, async () => {
  const { root, git } = await repository();
  try {
    await writeFile(join(root, "tracked.txt"), "checkpoint\n");
    await writeFile(join(root, "ordinary.txt"), "ordinary\n");
    await writeFile(join(root, "ignored.log"), "ignored-before\n");
    const snapshot = await capture(root, "test-session");
    assert.match(snapshot.worktreeTree, /^[0-9a-f]{40}$/);
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

test("preflight refuses common untracked credential files", async () => {
  const { root } = await repository();
  try {
    await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=secret\n");
    await assert.rejects(preflight(root), /Unsafe untracked path: \.npmrc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

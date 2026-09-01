import { createHash } from "node:crypto";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  estimateTokens,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { appendToolDuration, appendTurnGitBranch, appendWorkDuration } from "pylon-core/src/work-duration.ts";
import {
  correlatePendingUserMessageStart,
  deferUserMessageEndEntryId,
  deleteSessionFile,
  SessionRuntime,
  terminalAgentError,
} from "../src/server/pi/session-runtime.ts";
import { encodeHistoryCursor } from "../src/server/pi/projections.ts";
import { PROMPT_IMAGE_ATTACHMENT_VERSION, promptFilesMessage } from "../src/server/pi/prompt-attachments.ts";
import { mergeHistoryMessages } from "../src/shared/history-cache.ts";
import type {
  DialogMethod,
  StateQLCredentialHost,
  StateQLCredentialRequest,
  UiRequest,
} from "../src/server/pi/remote-ui-context.ts";
import { runtimeSnapshotValidationIssue } from "../src/shared/protocol/validation.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pylon-runtime-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("pending command IDs correlate only with user message starts", () => {
  const pending = ["same-1", "same-2"];
  const assistant = { type: "message_start", message: { role: "assistant", content: [] } };
  assert.equal(correlatePendingUserMessageStart(assistant, pending), assistant);
  assert.deepEqual(pending, ["same-1", "same-2"]);
  assert.deepEqual(
    correlatePendingUserMessageStart({ type: "message_start", message: { role: "user", content: "same" } }, pending),
    { type: "message_start", message: { role: "user", content: "same" }, clientMessageId: "same-1" },
  );
  assert.equal(
    correlatePendingUserMessageStart({ type: "message_starting", role: "user" }, pending).clientMessageId,
    "same-2",
  );
  assert.deepEqual(pending, []);
});

test("user completion resolves its entry ID after persistence", async () => {
  const session = SessionManager.inMemory();
  const firstEntryId = session.appendMessage({ role: "user", content: "Prompt A", timestamp: Date.now() });
  const latestUserEntryId = () =>
    [...session.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "user")?.id;
  const forwarded: Record<string, unknown>[] = [];
  const deferred = deferUserMessageEndEntryId(
    { type: "message_end", message: { role: "user", content: "Prompt B" } },
    () => true,
    latestUserEntryId,
    payload => forwarded.push(payload),
  );

  assert.equal(deferred, true);
  assert.equal(forwarded.length, 0);
  const secondEntryId = session.appendMessage({ role: "user", content: "Prompt B", timestamp: Date.now() });
  await Promise.resolve();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.entryId, secondEntryId);

  const merged = mergeHistoryMessages(
    [],
    [
      { id: "history-0", entryId: firstEntryId, role: "user", text: "Prompt A", streaming: false },
      { id: "message-1", entryId: String(forwarded[0]?.entryId), role: "user", text: "Prompt B", streaming: false },
    ],
  );
  assert.deepEqual(
    merged.map(message => message.text),
    ["Prompt A", "Prompt B"],
  );

  let resolveCalls = 0;
  assert.equal(
    deferUserMessageEndEntryId(
      { type: "message_end", message: { role: "user", content: "Stale prompt" } },
      () => false,
      () => {
        resolveCalls++;
        return secondEntryId;
      },
      payload => forwarded.push(payload),
    ),
    true,
  );
  await Promise.resolve();
  assert.equal(resolveCalls, 1);
  assert.equal(forwarded.length, 1);

  const unresolved: Record<string, unknown>[] = [];
  assert.equal(
    deferUserMessageEndEntryId(
      { type: "message_end", message: { role: "user", content: "Unpersisted prompt" } },
      () => true,
      () => secondEntryId,
      payload => unresolved.push(payload),
    ),
    true,
  );
  await Promise.resolve();
  assert.equal(unresolved[0]?.entryId, undefined);
  assert.equal(
    deferUserMessageEndEntryId(
      { type: "message_complete", message: { role: "user", content: "Compatibility event" } },
      () => true,
      latestUserEntryId,
      payload => forwarded.push(payload),
    ),
    false,
  );
});

test("agent_settled recovers missed agent_end state and abort does not latch stopping", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-settled-fallback-"));
  const cwd = join(root, "workspace"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const session = (driver as any).runtime.session;

    session._emit({ type: "agent_start" });
    assert.ok((await driver.snapshot()).conversation.workStartedAt);
    session._emit({ type: "agent_settled" });
    let conversation = (await driver.snapshot()).conversation;
    assert.equal(conversation.workStartedAt, undefined);
    assert.equal(conversation.stopping ?? false, false);

    session._emit({ type: "agent_start" });
    assert.ok((await driver.snapshot()).conversation.workStartedAt);
    await driver.abort();
    assert.equal((await driver.snapshot()).conversation.stopping ?? false, false);
    await driver.abort();
    assert.equal((await driver.snapshot()).conversation.stopping ?? false, false);

    session._emit({ type: "agent_settled" });
    conversation = (await driver.snapshot()).conversation;
    assert.equal(conversation.workStartedAt, undefined);
    assert.equal(conversation.stopping ?? false, false);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Continuity compaction continuation preserves timing, suppresses interruption, and honors user abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-compaction-continuation-"));
  const cwd = join(root, "workspace"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  let bus: any;
  const bridge: InlineExtension = {
    name: "compaction-continuation-probe",
    factory(pi) {
      bus = pi.events;
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [bridge] });
  const events: any[] = [];
  const unsubscribe = driver.subscribe(event => events.push(event));

  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const session = (driver as any).runtime.session;
    const lifecycle = (action: string, requestId: string, overrides: Record<string, unknown> = {}) =>
      bus.emit("pi-continuity:compaction-continuation", {
        version: 1,
        action,
        requestId,
        sessionId: handle.sessionId,
        sessionGeneration: 1,
        taskGeneration: 1,
        ...overrides,
      });
    const interruption = (requestId: string) => ({
      role: "assistant",
      content: [{ type: "text", text: "partial internal response" }],
      stopReason: "aborted",
      diagnostics: [
        {
          type: "pi-continuity-compaction-interruption",
          timestamp: Date.now(),
          details: { version: 1, requestId, sessionId: handle.sessionId },
        },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    });

    session._emit({ type: "agent_start" });
    const first = await driver.snapshot();
    const startedAt = first.conversation.workStartedAt;
    const requestId = "compact-success";
    lifecycle("begin", requestId);
    const aborted = interruption(requestId);
    session._emit({ type: "message_start", message: aborted });
    session._emit({ type: "message_end", message: aborted });
    session.sessionManager.appendMessage(aborted);
    session._emit({ type: "agent_end", messages: [aborted] });
    session._emit({ type: "agent_settled" });
    assert.equal((await driver.snapshot()).conversation.workStartedAt, startedAt);
    assert.ok(
      events.some(
        event => event.type === "session.event" && event.payload?.type === "continuity_compaction_interruption",
      ),
    );
    assert.equal(
      events.filter(event => event.type === "session.event" && event.payload?.type === "agent_end").at(-1)?.payload
        .willRetry,
      true,
    );
    lifecycle("begin", "stale-begin", { taskGeneration: 2 });
    assert.equal(
      (driver as any).compactionContinuation.requestId,
      requestId,
      "a stale begin cannot replace the active continuation",
    );

    lifecycle("resume", requestId);
    session._emit({ type: "agent_start" });
    assert.equal((await driver.snapshot()).conversation.workStartedAt, startedAt);
    const done = {
      ...interruption("unused"),
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      diagnostics: [],
    };
    session._emit({ type: "message_end", message: done });
    session.sessionManager.appendMessage(done);
    session._emit({ type: "agent_end", messages: [done] });
    let snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.workStartedAt, undefined);
    assert.deepEqual(
      snapshot.conversation.messages.filter(message => message.role === "assistant").map(message => message.text),
      ["Done"],
    );
    assert.equal(
      session.sessionManager
        .getBranch()
        .some(
          (entry: any) =>
            entry.type === "message" && entry.message === aborted && entry.message.stopReason === "aborted",
        ),
      true,
    );

    session._emit({ type: "agent_start" });
    lifecycle("begin", "user-stop");
    const userAbort = interruption("user-stop");
    session._emit({ type: "message_start", message: userAbort });
    session._emit({ type: "message_end", message: userAbort });
    session.sessionManager.appendMessage(userAbort);
    const terminalEventsBeforeAbort = events.filter(
      event => event.type === "session.event" && event.payload?.type === "agent_end",
    ).length;
    const abortPromise = driver.abort();
    session._emit({ type: "agent_end", messages: [userAbort] });
    session._emit({ type: "agent_settled" });
    await abortPromise;
    snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.workStartedAt, undefined);
    assert.equal(snapshot.conversation.stopping ?? false, false);
    const abortTerminalEvents = events
      .filter(event => event.type === "session.event" && event.payload?.type === "agent_end")
      .slice(terminalEventsBeforeAbort);
    assert.equal(abortTerminalEvents.length, 1, "user abort owns the native terminal event");
    assert.equal(abortTerminalEvents[0]?.payload.stopped, true);
  } finally {
    unsubscribe();
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal agent errors come only from the latest assistant response", () => {
  assert.equal(
    terminalAgentError([
      { role: "assistant", stopReason: "error", errorMessage: " old failure " },
      { role: "assistant", stopReason: "stop" },
    ]),
    undefined,
  );
  assert.equal(
    terminalAgentError([
      { role: "assistant", stopReason: "error", errorMessage: "old failure" },
      { role: "user", content: "new prompt" },
    ]),
    undefined,
  );
  assert.equal(
    terminalAgentError([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "error", errorMessage: "  provider rejected request  " },
    ]),
    "provider rejected request",
  );
  assert.equal(
    terminalAgentError([{ role: "assistant", stopReason: "error", errorMessage: "x".repeat(1_001) }])?.length,
    1_000,
  );
});

test("plan runtime bridge forwards revision-checked approval and feedback actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-plan-bridge-")),
    cwd = join(root, "workspace"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const actions: any[] = [];
  const planBridge: InlineExtension = {
    name: "plan-bridge-probe",
    factory(pi) {
      pi.events.on("pi-continuity:plan-action", (request: any) => {
        actions.push({ ...request, respond: undefined });
        request.respond(
          request.expectedRevision === 9 ? Promise.reject(new Error("plan revision changed")) : Promise.resolve(),
        );
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [planBridge] });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    await driver.continuityPlanAction({
      expectedGeneration: handle.sessionGeneration,
      action: "approve",
      resetContext: true,
      expectedRevision: 2,
    });
    await driver.continuityPlanAction({
      expectedGeneration: handle.sessionGeneration,
      action: "requestChanges",
      feedback: "Clarify it",
      expectedRevision: 3,
    });
    assert.deepEqual(
      actions.map(({ sessionId, expectedGeneration, action, resetContext, feedback, expectedRevision }) => ({
        sessionId,
        expectedGeneration,
        action,
        resetContext,
        feedback,
        expectedRevision,
      })),
      [
        {
          sessionId: handle.sessionId,
          expectedGeneration: handle.sessionGeneration,
          action: "approve",
          resetContext: true,
          feedback: undefined,
          expectedRevision: 2,
        },
        {
          sessionId: handle.sessionId,
          expectedGeneration: handle.sessionGeneration,
          action: "requestChanges",
          resetContext: undefined,
          feedback: "Clarify it",
          expectedRevision: 3,
        },
      ],
    );
    await assert.rejects(
      driver.continuityPlanAction({
        expectedGeneration: handle.sessionGeneration,
        action: "approve",
        resetContext: false,
        expectedRevision: 9,
      }),
      /revision changed/,
    );
    assert.throws(
      () =>
        driver.continuityPlanAction({
          expectedGeneration: handle.sessionGeneration + 1,
          action: "approve",
          resetContext: false,
          expectedRevision: 2,
        }),
      { name: "StaleGenerationError" },
    );
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("memory runtime bridge forwards scoped CAS mutations and maps stale errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-memory-bridge-")),
    cwd = join(root, "workspace"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const mutations: any[] = [];
  const memoryBridge: InlineExtension = {
    name: "memory-bridge-probe",
    factory(pi) {
      pi.events.on("pi-continuity:memory-mutation", (request: any) => {
        mutations.push({ ...request, respond: undefined });
        request.respond(
          request.action === "delete" && request.expectedRevision === 9
            ? Promise.reject(new Error("memory note revision changed"))
            : Promise.resolve(),
        );
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [memoryBridge] });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const userId = "00000000-0000-4000-8000-000000000001",
      projectId = "00000000-0000-4000-8000-000000000002";
    await driver.updateContinuityMemory({
      expectedGeneration: handle.sessionGeneration,
      scope: "user",
      id: userId,
      trigger: "replying",
      guidance: "Keep replies concise.",
      expectedRevision: 2,
    });
    await driver.deleteContinuityMemory({
      expectedGeneration: handle.sessionGeneration,
      scope: "project",
      id: projectId,
      expectedRevision: 3,
    });
    await driver.migrateContinuityMemory({ expectedGeneration: handle.sessionGeneration });
    assert.deepEqual(
      mutations
        .slice(0, 2)
        .map(({ sessionId, expectedGeneration, action, scope, id, expectedRevision, trigger, guidance }) => ({
          sessionId,
          expectedGeneration,
          action,
          scope,
          id,
          expectedRevision,
          trigger,
          guidance,
        })),
      [
        {
          sessionId: handle.sessionId,
          expectedGeneration: handle.sessionGeneration,
          action: "update",
          scope: "user",
          id: userId,
          expectedRevision: 2,
          trigger: "replying",
          guidance: "Keep replies concise.",
        },
        {
          sessionId: handle.sessionId,
          expectedGeneration: handle.sessionGeneration,
          action: "delete",
          scope: "project",
          id: projectId,
          expectedRevision: 3,
          trigger: undefined,
          guidance: undefined,
        },
      ],
    );
    assert.deepEqual(mutations[2], {
      version: 2,
      sessionId: handle.sessionId,
      expectedGeneration: handle.sessionGeneration,
      action: "migrate",
      respond: undefined,
    });
    await assert.rejects(
      driver.deleteContinuityMemory({
        expectedGeneration: handle.sessionGeneration,
        scope: "user",
        id: userId,
        expectedRevision: 9,
      }),
      { name: "StaleMemoryError" },
    );
    assert.throws(() => driver.migrateContinuityMemory({ expectedGeneration: handle.sessionGeneration + 1 }), {
      name: "StaleGenerationError",
    });
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function persistSession(session: SessionManager, name: string): string {
  session.appendSessionInfo(name);
  return session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: name }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

test("runtime publishes usage after a completed message is persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-live-usage-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();
  const events: any[] = [];
  const unsubscribe = driver.subscribe(event => events.push(event));

  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const session = (driver as any).runtime.session;
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Working" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 17,
        output: 12,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 34,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    session._emit({ type: "message_end", message });
    session.sessionManager.appendMessage(message);
    await Promise.resolve();

    const completions = events.filter(
      event =>
        event.type === "session.event" && (event.payload?.type === "message_end" || event.payload?.type === "usage"),
    );
    assert.deepEqual(
      completions.map(event => event.payload.type),
      ["message_end", "usage"],
    );
    const usage = completions[1];
    assert.equal(usage?.sessionGeneration, handle.sessionGeneration);
    assert.equal(usage?.payload.metrics.inputTokens, 17);
    assert.equal(usage?.payload.metrics.outputTokens, 12);
    assert.equal(usage?.payload.metrics.assistantMessages, 1);

    events.length = 0;
    session._emit({ type: "message_end", message });
    (driver as any).gate.beginReplacement();
    session.sessionManager.appendMessage(message);
    await Promise.resolve();
    assert.equal(
      events.some(event => event.type === "session.event" && event.payload?.type === "usage"),
      false,
    );
    (driver as any).gate.cancelReplacement();
  } finally {
    unsubscribe();
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed work metadata survives runtime restart", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-duration-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  const assistantEntryId = persistSession(session, "Timed response");
  appendWorkDuration(session, assistantEntryId, 12_345);
  appendTurnGitBranch(session, assistantEntryId, "feature/persisted-turn");
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot, sessionPath: session.getSessionFile()! });
    const message = (await driver.snapshot()).conversation.messages.find(item => item.entryId === assistantEntryId);
    assert.equal(message?.workDurationMs, 12_345);
    assert.equal(message?.gitBranch, "feature/persisted-turn");
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed tool duration survives runtime restart", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-tool-duration-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "source" }],
    isError: false,
    timestamp: Date.now(),
  });
  appendToolDuration(session, "read-1", 1_250);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot, sessionPath: session.getSessionFile()! });
    const message = (await driver.snapshot()).conversation.messages.find(item => item.tool?.id === "read-1");
    assert.equal(message?.tool?.durationMs, 1_250);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime snapshots retain live delegated agents while the session is not selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-live-delegates-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const session = (driver as any).runtime.session;
    const toolCallId = "spawn-live";
    session._emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect auth" },
    });
    session._emit({
      type: "tool_execution_update",
      toolCallId,
      toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect auth" },
      partialResult: {
        content: [{ type: "text", text: "Private agent is working" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-session" },
          agentName: "Ada",
          startedAt: "2026-07-30T10:00:00.000Z",
          state: "running",
          model: "provider/child",
          durationMs: 1_000,
          usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
          activity: [{ kind: "call", tool: "read", text: '{"path":"auth.ts"}' }],
        },
      },
    });

    const [run] = (await driver.snapshot()).conversation.delegatedRuns;
    assert.equal(run?.id, toolCallId);
    assert.equal(run?.status, "running");
    assert.equal(run?.agentName, "Ada");
    assert.equal(run?.threadId, "child-session");
    assert.equal(run?.modelName, "provider/child");
    assert.equal(run?.activity.length, 1);
    assert.equal(run?.usage?.output, 3);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime accepts only correlated background spawn progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-background-spawn-progress-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const runtime = (driver as any).runtime;
    const session = runtime.session;
    const toolCallId = "spawn-background";
    const childId = "child-session";
    const runId = "run-1";
    const marker = { version: 1, kind: "session", id: childId, path: join(root, "child.jsonl"), cwd };
    session._emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: "spawn_session",
      args: { action: "create", prompt: "Inspect auth", background: true },
    });
    session._emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: "spawn_session",
      isError: false,
      result: {
        content: [{ type: "text", text: "Started" }],
        details: {
          piSpawn: marker,
          runId,
          background: true,
          status: "running",
          state: "running",
          startedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    });
    const progress = (overrides: Record<string, unknown> = {}) => ({
      version: 1,
      parentSessionId: session.sessionId,
      toolCallId,
      kind: "session",
      id: childId,
      runId,
      phase: "update",
      result: {
        content: [],
        details: {
          piSpawn: marker,
          runId,
          background: true,
          status: "running",
          state: "running",
          startedAt: "2026-08-01T10:00:00.000Z",
          partialResponse: "Reading auth…",
          usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
          activityDelta: [{ id: "read-1", kind: "call", tool: "read", text: "{}" }],
        },
      },
      ...overrides,
    });

    (driver as any).eventBus.emit("pylon:spawn-progress", progress({ parentSessionId: "wrong-parent" }));
    let [run] = (await driver.snapshot()).conversation.delegatedRuns;
    assert.equal(run?.response, undefined);
    (driver as any).eventBus.emit("pylon:spawn-progress", progress());
    [run] = (await driver.snapshot()).conversation.delegatedRuns;
    assert.deepEqual(
      { status: run?.status, response: run?.response, output: run?.usage?.output, activity: run?.activity.length },
      { status: "running", response: "Reading auth…", output: 3, activity: 1 },
    );

    (driver as any).eventBus.emit("pylon:spawn-progress", progress({ runId: "stale-run" }));
    assert.equal((await driver.snapshot()).conversation.delegatedRuns[0]?.runId, runId);
    (driver as any).eventBus.emit(
      "pylon:spawn-progress",
      progress({
        phase: "end",
        result: {
          content: [{ type: "text", text: "Done" }],
          details: {
            piSpawn: marker,
            runId,
            background: true,
            status: "completed",
            usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
            sessionUsage: { input: 40, output: 60, cacheRead: 10, cacheWrite: 0, cost: 0.2 },
            activity: [
              { id: "read-1", kind: "call", tool: "read", text: "{}" },
              { id: "read-1", kind: "result", tool: "read", text: "source" },
            ],
          },
        },
      }),
    );
    [run] = (await driver.snapshot()).conversation.delegatedRuns;
    assert.deepEqual(
      {
        status: run?.status,
        response: run?.response,
        sessionOutput: run?.sessionUsage?.output,
        activity: run?.activity.length,
      },
      { status: "completed", response: "Done", sessionOutput: 60, activity: 2 },
    );
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("StateQL snapshot bridge claims one bounded session-scoped response", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-stateql-bridge-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  let requests = 0;
  const probe: InlineExtension = {
    name: "pylon-stateql-probe",
    factory(pi) {
      pi.events.on("pylon:stateql-snapshot-request", (value: any) => {
        if (value?.version !== 1 || !value.claim()) return;
        requests++;
        value.respond(
          Promise.resolve({
            session: { session_id: "s_1", name: "shared-workspace", status: "active", ignored: "value" },
            actor_id: value.sessionId,
            connection: {
              connection_id: "connection-1",
              name: "mongo-app",
              status: "connected",
              driver: "mongodb",
              database: "app",
              read_only: true,
            },
            transaction: null,
            state_version: null,
            state_confidence: null,
            recent_results: [],
            recent_operations: [],
            history: [
              {
                command_id: "cmd_1",
                timestamp: "2026-07-30T10:00:00.000Z",
                session_id: "s_1",
                actor_id: value.sessionId,
                command: "query",
                sql: "SELECT id, email FROM users WHERE id = ?",
                handle: "q_1",
                executed: true,
                cached: false,
                success: true,
                error_code: null,
                ignored: "value",
              },
            ],
            ignored: "value",
          }),
        );
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [probe] });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const snapshot = await driver.stateqlSnapshot(20);
    assert.equal(requests, 1);
    assert.equal(snapshot.sessionGeneration, handle.sessionGeneration);
    assert.equal(snapshot.session.name, "shared-workspace");
    assert.equal(snapshot.actor_id, handle.sessionId);
    assert.equal(snapshot.connection?.driver, "mongodb");
    assert.equal(snapshot.history[0]?.origin, "legacy");
    assert.equal(snapshot.history[0]?.command, "query");
    assert.equal(snapshot.history[0]?.sql, "SELECT id, email FROM users WHERE id = ?");
    assert.equal("ignored" in snapshot, false);
    assert.equal("ignored" in snapshot.session, false);
    assert.equal("ignored" in snapshot.history[0]!, false);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("StateQL rows bridge normalizes a bounded page", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-stateql-rows-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const probe: InlineExtension = {
    name: "pylon-stateql-rows-probe",
    factory(pi) {
      pi.events.on("pylon:stateql-rows-request", (value: any) => {
        if (value?.version !== 1 || !value.claim()) return;
        const rows =
          value.handle === "oversized"
            ? Array.from({ length: 5 }, (_, id) => ({ id, text: "x".repeat(60 * 1024) }))
            : [{ id: 1, nested: [true, null] }];
        value.respond(
          Promise.resolve({
            result_id: value.handle === "wrong-result" ? "other-result" : value.handle,
            offset: value.offset,
            limit: value.limit,
            rows,
            returned: rows.length,
            total: rows.length,
            truncated: false,
            next_offset: null,
            ignored: "value",
          }),
        );
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [probe] });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const page = await driver.stateqlRows("result-1", 0, 10);
    assert.equal(page.sessionGeneration, handle.sessionGeneration);
    assert.equal(page.actor_id, handle.sessionId);
    assert.equal(page.rows[0]?.id, 1);
    assert.equal("ignored" in page, false);
    await assert.rejects(driver.stateqlRows("", 0, 10), /request is invalid/);
    await assert.rejects(driver.stateqlRows("wrong-result", 0, 10), /returned invalid rows/);
    await assert.rejects(driver.stateqlRows("oversized", 0, 10), /returned oversized rows/);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("StateQL command bridge normalizes user commands and propagates cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-stateql-command-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  let requests = 0;
  let cancelled = false;
  const probe: InlineExtension = {
    name: "pylon-stateql-command-probe",
    factory(pi) {
      pi.events.on("pylon:stateql-command-request", (value: any) => {
        if (value?.version !== 1 || !value.claim()) return;
        requests++;
        assert.equal(typeof value.ui.confirm, "function");
        assert.equal(typeof value.ui.requestStateQLCredential, "function");
        value.signal.addEventListener("abort", () => (cancelled = true), { once: true });
        if (value.command.sql === "SELECT cancel") {
          value.respond(new Promise(() => {}));
          return;
        }
        if (value.command.sql === "SELECT error") {
          value.respond(
            Promise.resolve({
              ok: false,
              command_id: "cmd_user_error",
              session_id: "s_1",
              error: {
                code: "CONNECTION_FAILED",
                message: "postgres://private:hunter2@example.com/app password=hunter2",
                retryable: true,
                executed: false,
              },
              meta: { duration_ms: 1 },
            }),
          );
          return;
        }
        value.respond(
          Promise.resolve({
            ok: true,
            command_id: "cmd_user_1",
            session_id: "s_1",
            data: { result_id: "q_1", preview: [{ value: 1 }] },
            warnings: [],
            meta: { duration_ms: 2, state_version: "v1" },
          }),
        );
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [probe] });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
    const result = await driver.stateqlCommand({ command: "query", sql: "SELECT 1", cache: "bypass" });
    assert.equal(result.sessionGeneration, handle.sessionGeneration);
    assert.equal(result.actor_id, handle.sessionId);
    assert.equal(result.status, "completed");
    if (result.status === "completed") {
      assert.equal(result.response.ok, true);
      assert.equal((result.response as any).data.result_id, "q_1");
      assert.equal((result.response as any).data.preview[0].value, 1);
    }
    const failed = await driver.stateqlCommand({ command: "query", sql: "SELECT error" });
    assert.equal(failed.status, "completed");
    assert.equal(JSON.stringify(failed).includes("hunter2"), false);
    assert.match(JSON.stringify(failed), /postgres:\/\/\*\*\*@example\.com/);
    const exec = await driver.stateqlCommand({ command: "exec", sql: "DELETE FROM users" });
    assert.equal(exec.status, "completed");

    const controller = new AbortController();
    const pending = driver.stateqlCommand({ command: "query", sql: "SELECT cancel" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /request cancelled/);
    assert.equal(cancelled, true);
    assert.equal(requests, 4);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Pylon credential host resumes the original command, reuses reads, escalates writes, and clears on replacement",
  { timeout: 45_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pylon-stateql-credential-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const sentinel = "postgres://private:sentinel@localhost/app";
    const observations: Array<string | undefined> = [];
    const probe: InlineExtension = {
      name: "pylon-stateql-credential-probe",
      factory(pi) {
        pi.registerCommand("stateql-credential-probe", {
          handler: async (args, ctx) => {
            const access = args === "write" ? "write" : "read";
            const operation = args === "connect" ? "connect" : access === "write" ? "exec" : "query";
            const request: StateQLCredentialRequest = {
              reference: "APP_DATABASE_URL",
              actorId: ctx.sessionManager.getSessionId(),
              session: { id: "stateql-workspace", name: "workspace" },
              operation,
              access,
              ...(operation === "connect"
                ? { profile: { name: "app" }, requestedReadOnly: true }
                : {
                    connection: {
                      id: "connection-1",
                      name: "app",
                      driver: "postgres",
                      database: "app",
                      readOnly: false,
                    },
                  }),
            };
            const host = ctx.ui as typeof ctx.ui & StateQLCredentialHost;
            observations.push(await host.requestStateQLCredential(request));
          },
        });
      },
    };
    const driver = new SessionRuntime({ extensionFactories: [probe] });
    const events: unknown[] = [];
    const prompts: UiRequest[] = [];
    const unsubscribe = driver.subscribe(event => {
      events.push(JSON.parse(JSON.stringify(event)));
      if (event.type !== "ui.event") return;
      const request = event.payload as UiRequest;
      if (request.payload.context !== "stateql-credential") return;
      prompts.push(structuredClone(request));
      queueMicrotask(
        () =>
          void driver.answerUiRequest({
            requestId: request.requestId,
            sessionGeneration: request.sessionGeneration,
            method: "input",
            value: sentinel,
          }),
      );
    });

    try {
      const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
      await driver.prompt({
        commandId: "credential-connect",
        expectedGeneration: handle.sessionGeneration,
        message: "/stateql-credential-probe connect",
      });
      assert.deepEqual(observations, [sentinel]);
      assert.equal(prompts.length, 1);

      await driver.prompt({
        commandId: "credential-read",
        expectedGeneration: handle.sessionGeneration,
        message: "/stateql-credential-probe read",
      });
      assert.deepEqual(observations, [sentinel, sentinel]);
      assert.equal(prompts.length, 1);

      await driver.prompt({
        commandId: "credential-write",
        expectedGeneration: handle.sessionGeneration,
        message: "/stateql-credential-probe write",
      });
      assert.deepEqual(observations, [sentinel, sentinel, sentinel]);
      assert.equal(prompts.length, 2);
      assert.deepEqual(
        prompts.map(request => request.payload.access),
        ["read", "write"],
      );

      const replacement = await driver.newSession();
      assert.equal(replacement.cancelled, false);
      await driver.prompt({
        commandId: "credential-replaced",
        expectedGeneration: replacement.sessionGeneration,
        message: "/stateql-credential-probe read",
      });
      assert.equal(observations.length, 4);
      assert.equal(prompts.length, 3);

      const snapshot = await driver.snapshot();
      assert.equal(JSON.stringify({ prompts, events, snapshot }).includes(sentinel), false);
      assert.equal(
        snapshot.diagnostics.some(item => item.message.includes(sentinel)),
        false,
      );
    } finally {
      unsubscribe();
      await driver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("public SDK binds RPC UI, aborts, replaces, discovers Pylon, and shuts down", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-phase0-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const failureCwd = join(root, "failure-workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(failureCwd), mkdir(agentDir)]);

  const observations = {
    dialogs: [] as Array<[string, unknown]>,
    starts: 0,
    shutdowns: 0,
    unavailable: 0,
    notifications: 0,
  };
  let cancelNextReplacement = true;
  let cancelRecoverySwitch = false;
  let finishCompact: (() => void) | undefined;
  let factoryCalls = 0;
  let failOnFactoryCall = 0;
  const recoveryCanceller: InlineExtension = {
    name: "pylon-web-recovery-canceller",
    factory(pi) {
      pi.on("session_before_switch", () => {
        if (!cancelRecoverySwitch) return;
        cancelRecoverySwitch = false;
        return { cancel: true };
      });
    },
  };
  const probe: InlineExtension = {
    name: "pylon-web-phase0-probe",
    factory(pi) {
      factoryCalls++;
      if (factoryCalls === failOnFactoryCall) {
        cancelRecoverySwitch = true;
        throw new Error("deliberate replacement failure");
      }
      pi.on("session_start", () => {
        observations.starts++;
      });
      pi.on("session_shutdown", () => {
        observations.shutdowns++;
      });
      pi.on("session_before_switch", async (_event, ctx) => {
        if (!cancelNextReplacement) return;
        cancelNextReplacement = false;
        if (!(await ctx.ui.confirm("Cancel replacement?", "Test cancellation"))) return { cancel: true };
      });
      pi.registerCommand("phase0-probe", {
        handler: async (_args, ctx) => {
          observations.dialogs.push(["select", await ctx.ui.select("Choose", ["A", "B"])]);
          observations.dialogs.push(["confirm", await ctx.ui.confirm("Confirm", "Proceed?")]);
          observations.dialogs.push(["input", await ctx.ui.input("Input")]);
          observations.dialogs.push(["editor", await ctx.ui.editor("Editor", "before")]);
          ctx.abort();
        },
      });
      pi.registerCommand("phase4-implicit-replace", {
        handler: async (_args, ctx) => {
          await ctx.waitForIdle();
          await ctx.newSession();
        },
      });
      pi.registerCommand("phase0-notify", {
        handler: async (_args, ctx) => {
          ctx.ui.notify("Command result", "info");
        },
      });
      pi.registerCommand("compact", {
        handler: async (args, ctx) => {
          if (args.trim() === "fail") {
            ctx.ui.notify("Compaction failure detail", "error");
            return;
          }
          await new Promise<void>(resolve => {
            finishCompact = resolve;
          });
        },
      });
      pi.registerCommand("phase0-empty", { handler: async () => {} });
      pi.registerCommand("phase0-wait", {
        handler: async (_args, ctx) => {
          await ctx.ui.input("Wait for cancellation");
        },
      });
    },
  };

  const driver = new SessionRuntime({ extensionFactories: [recoveryCanceller, probe], onShutdownRequested: () => {} });
  const unsubscribe = driver.subscribe(event => {
    if (event.type === "session.unavailable") observations.unavailable++;
    if (event.type !== "ui.event") return;
    const request = event.payload as UiRequest;
    if (request.method === "notify") observations.notifications++;
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    if (request.payload.title === "Wait for cancellation") return;
    const method = request.method as DialogMethod;
    queueMicrotask(() => {
      const base = { requestId: request.requestId, sessionGeneration: request.sessionGeneration, method };
      if (method === "confirm") {
        const title = request.payload.title;
        void driver.answerUiRequest({ ...base, method, confirmed: title === "Cancel replacement?" ? false : true });
      } else if (method === "select") void driver.answerUiRequest({ ...base, method, value: "B" });
      else void driver.answerUiRequest({ ...base, method, value: method === "input" ? "typed" : "edited" });
    });
  });

  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root });
    const foreignParent = SessionManager.create(otherCwd);
    persistSession(foreignParent, "Foreign parent");
    const failureParent = SessionManager.create(failureCwd);
    persistSession(failureParent, "Failure parent");
    assert.equal(handle.sessionGeneration, 1);
    assert.equal((await driver.snapshot()).ready, true);

    const accepted = await driver.prompt({
      commandId: "phase0-command",
      expectedGeneration: 1,
      message: "/phase0-probe",
    });
    assert.equal(accepted.accepted, true);
    assert.deepEqual(observations.dialogs, [
      ["select", "B"],
      ["confirm", true],
      ["input", "typed"],
      ["editor", "edited"],
    ]);

    await driver.abort();

    await driver.prompt({ commandId: "notify-command", expectedGeneration: 1, message: "/phase0-notify" });
    assert.equal((await driver.snapshot()).commandResult?.output, "Command result");
    assert.equal(observations.notifications, 0);
    driver.dismissCommandResult("notify-command", 1);
    assert.equal((await driver.snapshot()).commandResult, undefined);

    const commandNames = (await driver.snapshot()).sessionControls.commands?.map(command => command.name) ?? [];
    assert.ok(commandNames.includes("compact:2"), JSON.stringify(commandNames));
    const compacting = driver.prompt({ commandId: "compact-command", expectedGeneration: 1, message: "/compact:2" });
    assert.equal((await driver.snapshot()).commandResult, undefined);
    assert.ok(finishCompact);
    finishCompact();
    await compacting;
    assert.equal((await driver.snapshot()).commandResult, undefined);
    await driver.prompt({ commandId: "empty-command", expectedGeneration: 1, message: "/phase0-empty" });
    assert.equal((await driver.snapshot()).commandResult?.command, "phase0-empty");
    driver.dismissCommandResult("empty-command", 1);
    await driver.prompt({ commandId: "compact-failure", expectedGeneration: 1, message: "/compact:2 fail" });
    assert.deepEqual((await driver.snapshot()).commandResult, {
      id: "compact-failure",
      command: "compact:2",
      output: "Compaction failure detail",
      severity: "error",
      occurredAt: (await driver.snapshot()).commandResult?.occurredAt,
    });
    driver.dismissCommandResult("compact-failure", 1);

    let resolvePending!: () => void;
    const pendingUi = new Promise<void>(resolve => {
      resolvePending = resolve;
    });
    const stopPending = driver.subscribe(event => {
      if (event.type === "ui.event" && (event.payload as UiRequest).payload.title === "Wait for cancellation")
        resolvePending();
    });
    const waiting = driver.prompt({ commandId: "wait-command", expectedGeneration: 1, message: "/phase0-wait" });
    await pendingUi;
    await driver.abort();
    await waiting;
    stopPending();
    assert.equal(driver.runtimeState(), "idle");

    const cancelled = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.sessionGeneration, 1);
    assert.equal((await driver.snapshot()).ready, true);

    const replacement = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(replacement.cancelled, false);
    assert.equal(replacement.sessionGeneration, 3);
    assert.notEqual(replacement.sessionId, handle.sessionId);
    assert.equal(observations.starts, 3);
    assert.equal(observations.shutdowns, 2);
    const replacedSnapshot = await driver.snapshot();
    assert.equal(replacedSnapshot.cwdLabel, "other-workspace");

    const sameProject = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(sameProject.cancelled, false);
    assert.equal(sameProject.sessionGeneration, 4);
    assert.equal(observations.starts, 4);
    assert.equal(observations.shutdowns, 3);

    const implicitReplacement = new Promise<void>(resolve => {
      const stop = driver.subscribe(event => {
        if (event.type !== "session.replaced" || event.sessionGeneration !== 5) return;
        stop();
        resolve();
      });
    });
    await driver.prompt({
      commandId: "implicit-replacement",
      expectedGeneration: 4,
      message: "/phase4-implicit-replace",
    });
    await implicitReplacement;
    const implicitSnapshot = await driver.snapshot();
    assert.equal(implicitSnapshot.sessionGeneration, 5);
    assert.equal(implicitSnapshot.ready, true);
    assert.equal(observations.starts, 5);
    assert.equal(observations.shutdowns, 4);

    await assert.rejects(driver.steer({ commandId: "stale", expectedGeneration: 1, message: "ignored" }), {
      name: "StaleGenerationError",
    });

    failOnFactoryCall = factoryCalls + 2;
    const packageFailure = await driver.newSession({ parentSessionId: failureParent.getSessionId() });
    assert.equal(packageFailure.cancelled, false);
    const failed = await driver.snapshot();
    assert.equal(failed.sessionGeneration, 7);
    assert.equal(failed.cwdLabel, "failure-workspace");
    assert.ok(failed.diagnostics.some(item => item.message.includes("failed to load")));
    assert.equal(failed.ready, true);
    assert.equal(observations.starts, 6);
    assert.equal(observations.shutdowns, 6);
    assert.equal(observations.unavailable, 0);
  } finally {
    unsubscribe();
    await driver.dispose();
    const testSessions = (await SessionManager.listAll()).filter(session => session.cwd.startsWith(root));
    await Promise.all(testSessions.map(session => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(observations.shutdowns, 6);
});

test("repository packages load, toggle, and save settings", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-packages-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  let settingsRefreshObserved = false;
  const settingsRefreshProbe: InlineExtension = {
    name: "package-settings-refresh-probe",
    factory(pi) {
      const dispose = pi.events.on("pylon:package-settings-changed", () => {
        settingsRefreshObserved = true;
      });
      pi.on("session_shutdown", dispose);
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [settingsRefreshProbe] });

  try {
    await driver.start({ cwd, agentDir, repositoryRoot });
    const first = await driver.snapshot();
    assert.ok(first.availableTools.includes("search_tools"));
    assert.ok(first.availableTools.includes("continuity_update"));
    assert.ok(first.availableTools.includes("verify"));
    assert.ok(first.availableTools.includes("heartbeat_start"));
    assert.equal(first.operational.continuity.availability, "available");
    assert.equal(first.operational.timeline.availability, "available");
    assert.ok(first.operational.tools.policies.length > 0);
    const initialPackages = await driver.listPackages();
    assert.ok(initialPackages.packages.some(item => item.id === "pi-timeline" && item.active));
    const allThinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    assert.deepEqual(initialPackages.packages.find(item => item.id === "pi-spawn")?.settings, {
      kind: "spawn",
      agentAvailability: "deferred",
      sessionAvailability: "deferred",
      agentThinkingLevels: allThinking,
      spawnTimeoutMs: 0,
      recentThreadLimit: 8,
      recentThreadMaxChars: 800,
      recentThreadTotalChars: 12_000,
    });

    const initialActiveTools = first.activeTools;
    const initialHooks = (await driver.listHookSettings()).settings;
    const futureHooks = {
      sessionStart: { enabled: false, sources: [] },
      beforeAgentStart: {
        enabled: true,
        sources: [
          {
            id: "future",
            name: "Future",
            kind: "text" as const,
            content: "future sessions",
            reinjectOnCompaction: false,
          },
        ],
      },
    };
    await driver.updateHookSettings({ settings: futureHooks });
    assert.deepEqual((await driver.listHookSettings()).settings, futureHooks);
    assert.deepEqual((driver as any).hookInjection.settings, initialHooks);

    await assert.rejects(driver.setPackageEnabled({ packageId: "pylon-core", enabled: false }), /required/);
    const disabled = await driver.setPackageEnabled({ packageId: "pi-timeline", enabled: false });
    assert.equal(disabled.sessionGeneration, 1);
    assert.equal((await driver.snapshot()).operational.timeline.availability, "available");
    assert.ok(
      (await driver.listPackages()).packages.some(item => item.id === "pi-timeline" && !item.enabled && item.active),
    );
    const sieve = (await driver.listPackages()).packages.find(item => item.id === "pi-sieve")?.settings;
    assert.equal(sieve?.kind, "sieve");
    if (sieve?.kind !== "sieve") throw new Error("pi-sieve settings are unavailable");
    const threshold = sieve.threshold === 1_000 ? 2_000 : 1_000;
    const configured = await driver.updatePackageSettings({ packageId: "pi-sieve", settings: { ...sieve, threshold } });
    assert.equal(configured.sessionGeneration, 1);
    assert.deepEqual((await driver.listPackages()).packages.find(item => item.id === "pi-sieve")?.settings, {
      ...sieve,
      threshold,
    });

    const spawnConfigured = await driver.updatePackageSettings({
      packageId: "pi-spawn",
      settings: {
        kind: "spawn",
        agentAvailability: "active",
        sessionAvailability: "deferred",
        agentThinkingLevels: ["low", "high"],
        spawnTimeoutMs: 4_000,
        recentThreadLimit: 4,
        recentThreadMaxChars: 400,
        recentThreadTotalChars: 4_000,
      },
    });
    assert.deepEqual((await driver.listPackages()).packages.find(item => item.id === "pi-spawn")?.settings, {
      kind: "spawn",
      agentAvailability: "active",
      sessionAvailability: "deferred",
      agentThinkingLevels: ["low", "high"],
      spawnTimeoutMs: 4_000,
      recentThreadLimit: 4,
      recentThreadMaxChars: 400,
      recentThreadTotalChars: 4_000,
    });

    const generation = configured.sessionGeneration;
    assert.equal(spawnConfigured.sessionGeneration, generation);
    for (const [packageId, settings] of [
      [
        "pi-advisor",
        {
          kind: "advisor",
          mode: "session",
          maxCalls: 3,
          timeoutMs: 900_000,
          maxCostUsd: 0.5,
          maxOutputTokens: 8_192,
          inputTokenBudget: 32_768,
        },
      ],
      [
        "pi-scout",
        { kind: "scout", mode: "session", webSearch: true, repoTimeoutMs: 900_000, maxCostUsd: 1, webSearchResults: 5 },
      ],
      [
        "pi-grunt",
        {
          kind: "grunt",
          mode: "session",
          executionMode: "dynamic",
          thinkingLevels: ["medium", "high"] as any,
          timeoutMs: 3_600_000,
          maxCostUsd: 2,
          parentContextChars: 0,
          maxTurns: 40,
        },
      ],
    ] as const) {
      const updated = await driver.updatePackageSettings({ packageId, settings });
      assert.equal(updated.sessionGeneration, generation);
      assert.deepEqual((await driver.listPackages()).packages.find(item => item.id === packageId)?.settings, settings);
    }
    const unchangedRuntime = await driver.snapshot();
    assert.deepEqual(unchangedRuntime.activeTools, initialActiveTools);
    assert.equal(unchangedRuntime.operational.sieve.threshold, sieve.threshold);

    const scoutDisabled = await driver.updatePackageSettings({
      packageId: "pi-scout",
      settings: { kind: "scout", mode: "disabled", repoTimeoutMs: 900_000, maxCostUsd: 1, webSearchResults: 5 },
    });
    const gruntDisabled = await driver.updatePackageSettings({
      packageId: "pi-grunt",
      settings: {
        kind: "grunt",
        mode: "disabled",
        executionMode: "dynamic",
        thinkingLevels: ["medium", "high"],
        timeoutMs: 3_600_000,
        maxCostUsd: 2,
        parentContextChars: 0,
        maxTurns: 40,
      },
    });
    assert.equal(scoutDisabled.sessionGeneration, generation);
    assert.equal(gruntDisabled.sessionGeneration, generation);
    assert.deepEqual((await driver.snapshot()).activeTools, initialActiveTools);

    await driver.updatePackageSettings({
      packageId: "pi-grunt",
      settings: {
        kind: "grunt",
        mode: "session",
        executionMode: "direct",
        thinkingLevels: ["low", "high"],
        timeoutMs: 120_000,
        maxCostUsd: 3,
        parentContextChars: 1_200,
        maxTurns: 12,
      },
    });
    assert.deepEqual((await driver.listPackages()).packages.find(item => item.id === "pi-grunt")?.settings, {
      kind: "grunt",
      mode: "session",
      executionMode: "direct",
      thinkingLevels: ["low", "high"],
      timeoutMs: 120_000,
      maxCostUsd: 3,
      parentContextChars: 1_200,
      maxTurns: 12,
    });

    await assert.rejects(
      driver.updatePackageSettings({
        packageId: "pi-advisor",
        settings: {
          kind: "advisor",
          mode: "model",
          model: "missing/model",
          maxCalls: 3,
          timeoutMs: 900_000,
          maxCostUsd: 0.5,
          maxOutputTokens: 8_192,
          inputTokenBudget: 32_768,
        },
      }),
      /unavailable/,
    );
    assert.equal(settingsRefreshObserved, false);

    const next = new SessionRuntime();
    try {
      await next.start({ cwd, agentDir, repositoryRoot, inMemory: true });
      const nextSnapshot = await next.snapshot();
      assert.equal(nextSnapshot.operational.timeline.availability, "unavailable");
      const nextPackages = await next.listPackages();
      assert.ok(nextPackages.packages.some(item => item.id === "pi-timeline" && !item.enabled && !item.active));
      assert.deepEqual(nextPackages.packages.find(item => item.id === "pi-spawn")?.settings, {
        kind: "spawn",
        agentAvailability: "active",
        sessionAvailability: "deferred",
        agentThinkingLevels: ["low", "high"],
        spawnTimeoutMs: 4_000,
        recentThreadLimit: 4,
        recentThreadMaxChars: 400,
        recentThreadTotalChars: 4_000,
      });
      assert.deepEqual((next as any).hookInjection.settings, futureHooks);
    } finally {
      await next.dispose();
    }
  } finally {
    await driver.dispose();
    const testSessions = (await SessionManager.listAll()).filter(session => session.cwd.startsWith(root));
    await Promise.all(testSessions.map(session => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("session deletion only falls back when trash is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-delete-file-"));
  const sessionPath = join(root, "session.jsonl");
  try {
    await writeFile(sessionPath, "session");
    const unavailable = Object.assign(new Error("spawn trash ENOENT"), { code: "ENOENT" });
    await deleteSessionFile(sessionPath, () => ({ status: null, error: unavailable }));
    assert.equal(existsSync(sessionPath), false);

    await writeFile(sessionPath, "session");
    await assert.rejects(
      deleteSessionFile(sessionPath, () => ({ status: 1, stderr: "permission denied" })),
      /permission denied/,
    );
    assert.equal(existsSync(sessionPath), true);

    await assert.rejects(
      deleteSessionFile(sessionPath, () => ({
        status: null,
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      })),
      /timed out/,
    );
    assert.equal(existsSync(sessionPath), true);

    await assert.rejects(
      deleteSessionFile(sessionPath, () => ({ status: 0 })),
      /session file remains/,
    );
    assert.equal(existsSync(sessionPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver deletes only inactive sessions and blocks concurrent lifecycle changes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-delete-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();
  const deletable = SessionManager.create(otherCwd);
  persistSession(deletable, "Deletable session");
  const switchable = SessionManager.create(otherCwd);
  persistSession(switchable, "Switchable session");
  const deletablePath = deletable.getSessionFile()!;
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root });
    await assert.rejects(
      driver.deleteSession({ sessionId: deletable.getSessionId(), expectedGeneration: handle.sessionGeneration + 1 }),
      /stale/i,
    );
    assert.equal(existsSync(deletablePath), true);
    await assert.rejects(
      driver.deleteSession({ sessionId: handle.sessionId, expectedGeneration: handle.sessionGeneration }),
      /currently active/,
    );
    assert.equal((await driver.snapshot()).sessionId, handle.sessionId);

    const duplicateDirectory = join(isolatedAgentDir, "sessions", "duplicate-delete");
    const duplicatePath = join(duplicateDirectory, "duplicate.jsonl");
    await mkdir(duplicateDirectory, { recursive: true });
    await copyFile(deletablePath, duplicatePath);
    await assert.rejects(
      driver.deleteSession({ sessionId: deletable.getSessionId(), expectedGeneration: handle.sessionGeneration }),
      /ambiguous/,
    );
    assert.equal(existsSync(deletablePath), true);
    await rm(duplicateDirectory, { recursive: true, force: true });

    const deletion = driver.deleteSession({
      sessionId: deletable.getSessionId(),
      expectedGeneration: handle.sessionGeneration,
    });
    await assert.rejects(driver.switchSession({ sessionId: switchable.getSessionId() }), /another session operation/);
    await deletion;
    assert.equal(existsSync(deletablePath), false);
    await assert.rejects(
      driver.deleteSession({ sessionId: "missing-session", expectedGeneration: handle.sessionGeneration }),
      /unavailable/,
    );
  } finally {
    await driver.dispose();
    await Promise.all(
      [deletable.getSessionFile(), switchable.getSessionFile()].map(path =>
        path ? rm(path, { force: true }) : undefined,
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("fork validates idle state without rejecting its own lifecycle mutation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-fork-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  const userEntryId = session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Fork from here" }],
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const blocker: InlineExtension = {
    name: "pylon-web-fork-blocker",
    factory(pi) {
      pi.registerCommand("fork-blocker", {
        handler: async (_args, ctx) => {
          await ctx.ui.confirm("Keep open?", "Block lifecycle controls");
        },
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [blocker] });
  let receiveRequest!: (request: UiRequest) => void;
  const pendingRequest = new Promise<UiRequest>(resolve => {
    receiveRequest = resolve;
  });
  const unsubscribe = driver.subscribe(event => {
    if (event.type === "ui.event") receiveRequest(event.payload as UiRequest);
  });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const prompt = driver.prompt({
      commandId: "fork-blocker",
      expectedGeneration: handle.sessionGeneration,
      message: "/fork-blocker",
    });
    const request = await pendingRequest;
    await assert.rejects(
      driver.fork({
        expectedGeneration: handle.sessionGeneration,
        entryId: userEntryId,
        name: "Blocked fork",
        mode: "conversation",
        position: "at",
      }),
      /only change while the session is idle/,
    );
    await driver.answerUiRequest({
      requestId: request.requestId,
      sessionGeneration: request.sessionGeneration,
      method: "confirm",
      confirmed: false,
    });
    await prompt;

    const forked = await driver.fork({
      expectedGeneration: handle.sessionGeneration,
      entryId: userEntryId,
      name: "Forked session",
      mode: "conversation",
      position: "at",
    });
    assert.equal(forked.cancelled, false);
    assert.equal((await driver.snapshot()).sessionName, "Forked session");
    await assert.rejects(
      driver.fork({
        expectedGeneration: handle.sessionGeneration,
        entryId: userEntryId,
        name: "Stale fork",
        mode: "conversation",
      }),
      /stale session generation/,
    );
  } finally {
    unsubscribe();
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("driver starts without a root manifest and still loads required core", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-standalone-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.ready, true);
    const packages = (await driver.listPackages()).packages;
    assert.deepEqual(
      packages.map(item => item.id),
      ["pylon-core"],
    );
    assert.equal(packages[0]?.required, true);
    assert.equal(packages[0]?.active, true);
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter(session => session.cwd.startsWith(root));
    await Promise.all(sessions.map(session => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("existing long sessions keep the latest user turn and every tool result", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-latest-turn-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const session = SessionManager.create(cwd);
  for (let index = 0; index < 30; index++) {
    persistSession(session, `old-${index}`);
  }
  session.appendMessage({ role: "user", content: "Run every check", timestamp: Date.now() });
  for (let index = 0; index < 120; index++) {
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.ts` } }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read",
      content: [{ type: "text", text: `result ${index}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.messages[0]?.role, "user");
    assert.equal(snapshot.conversation.messages[0]?.text, "Run every check");
    assert.equal(snapshot.conversation.messages.length, 242);
    assert.deepEqual(
      snapshot.conversation.messages.filter(message => message.role === "tool").map(message => message.text),
      Array.from({ length: 120 }, (_, index) => `result ${index}`),
    );
    assert.equal(snapshot.conversation.messages.at(-1)?.systemSource, "pylon-session-start-hook");
    assert.equal(snapshot.conversation.historyRemaining, 30);
    assert.equal(runtimeSnapshotValidationIssue(snapshot), undefined);
    const earlier = await driver.conversationHistory({ cursor: snapshot.conversation.historyCursor! });
    assert.deepEqual(
      earlier.messages.map(message => message.text),
      Array.from({ length: 30 }, (_, index) => `old-${index}`),
    );
    const snapshotEntryIds = new Set(snapshot.conversation.messages.map(message => message.entryId));
    assert.equal(
      earlier.messages.some(message => snapshotEntryIds.has(message.entryId)),
      false,
    );
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("driver serves only versioned attachment content from the active branch", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-attachments-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const session = SessionManager.create(cwd);
  const imageEntryId = session.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Review these" },
      {
        type: "image",
        mimeType: "image/png",
        data: "eA==",
        pylonAttachmentVersion: PROMPT_IMAGE_ATTACHMENT_VERSION,
      } as any,
    ],
    timestamp: Date.now(),
  });
  const fileMessage = promptFilesMessage([{ name: "notes.txt", mimeType: "text/plain", text: "hello", size: 5 }]);
  const fileEntryId = session.appendCustomMessageEntry(
    fileMessage.customType,
    fileMessage.content,
    fileMessage.display,
    fileMessage.details,
  );
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    assert.deepEqual(
      snapshot.conversation.messages[0]?.attachments?.map(({ sourceEntryId, kind, name }) => ({
        sourceEntryId,
        kind,
        name,
      })),
      [
        { sourceEntryId: imageEntryId, kind: "image", name: "Image 1" },
        { sourceEntryId: fileEntryId, kind: "file", name: "notes.txt" },
      ],
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /eA==|hello/);
    assert.deepEqual(await driver.conversationAttachment({ sourceEntryId: imageEntryId, index: 0 }), {
      protocolVersion: snapshot.protocolVersion,
      sessionId: snapshot.sessionId,
      sessionGeneration: snapshot.sessionGeneration,
      kind: "image",
      name: "Image 1",
      mimeType: "image/png",
      size: 1,
      data: "eA==",
    });
    const fileAttachment = await driver.conversationAttachment({ sourceEntryId: fileEntryId, index: 0 });
    assert.equal(fileAttachment.kind, "file");
    assert.equal(fileAttachment.kind === "file" ? fileAttachment.text : undefined, "hello");
    await assert.rejects(() => driver.conversationAttachment({ sourceEntryId: imageEntryId, index: 1 }), /unavailable/);
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("driver pages the complete visible branch after compaction", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-history-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const session = SessionManager.create(cwd);
  const messageIds: string[] = [];
  let compactionEntryId = "";
  for (let index = 0; index < 155; index++) {
    messageIds.push(
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `message-${index}` }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    );
    if (index === 134)
      compactionEntryId = session.appendCompaction("## Compact summary", messageIds[120]!, 1_000, {
        type: "pi-continuity-compaction",
        version: 3,
        mode: "generic",
        sourceEntryCount: 135,
        records: [
          { sourceEntryId: "user-source", role: "user", text: "Original request" },
          { sourceEntryId: "failed-source", role: "tool", text: "exact failure", isError: true },
          { sourceEntryId: "assistant-source", role: "assistant", text: "Continued work" },
          { sourceEntryId: "result-source", role: "tool", text: "exact result" },
          { sourceEntryId: "prior-summary", role: "summary", text: "Prior canonical summary" },
        ],
        history: {
          read: [{ path: "src/read.ts", sourceEntryId: "read-source" }],
          modified: [{ path: "src/changed.ts", sourceEntryId: "changed-source" }],
        },
        supplements: [],
      });
  }

  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.messages.length, 100);
    assert.equal(snapshot.conversation.messages[0]?.text, "message-57");
    assert.equal(snapshot.conversation.messages[0]?.entryId, messageIds[57]);
    const compaction = snapshot.conversation.messages.find(message => message.entryId === compactionEntryId);
    assert.equal(compaction?.text, "## Compact summary");
    assert.equal(compaction?.systemSource, "pylon-compaction");
    assert.equal(compaction?.compaction?.sourceEntryCount, 135);
    assert.equal(compaction?.compaction?.contextBeforeTokens, 1_000);
    assert.deepEqual(compaction?.compaction?.display, {
      records: [
        { sourceEntryId: "user-source", role: "user", text: "Original request" },
        { sourceEntryId: "assistant-source", role: "assistant", text: "Continued work" },
      ],
      failedTools: [{ sourceEntryId: "failed-source", text: "exact failure" }],
      toolResults: [{ sourceEntryId: "result-source", text: "exact result" }],
      history: {
        read: [{ path: "src/read.ts", sourceEntryId: "read-source" }],
        modified: [{ path: "src/changed.ts", sourceEntryId: "changed-source" }],
      },
    });
    const expectedContextAfter = buildSessionContext(session.getBranch(), compactionEntryId).messages.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    );
    assert.equal(compaction?.compaction?.contextAfterTokens, expectedContextAfter);
    assert.equal(snapshot.conversation.messages.at(-1)?.systemSource, "pylon-session-start-hook");
    assert.equal(snapshot.conversation.historyRemaining, 57);

    const earlier: string[] = [];
    let cursor = snapshot.conversation.historyCursor;
    while (cursor) {
      const page = await driver.conversationHistory({ cursor });
      earlier.unshift(...page.messages.map(message => message.text));
      cursor = page.nextCursor;
    }
    assert.equal(earlier.length, 57);
    assert.equal(earlier[0], "message-0");
    assert.equal(earlier.at(-1), "message-56");
    const firstPage = await driver.conversationHistory({ cursor: snapshot.conversation.historyCursor! });
    assert.equal(firstPage.messages[0]?.entryId, messageIds[0]);
    const laterPage = await driver.conversationHistory({
      cursor: encodeHistoryCursor(55),
      direction: "after",
      limit: 10,
    });
    assert.equal(laterPage.messages[0]?.text, "message-55");
    assert.equal(laterPage.messages.at(-1)?.text, "message-64");
    const aroundPage = await driver.conversationHistory({
      cursor: encodeHistoryCursor(77),
      direction: "around",
      limit: 10,
    });
    assert.equal(aroundPage.messages[0]?.text, "message-72");
    assert.equal(aroundPage.messages.at(-1)?.text, "message-81");
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("driver projects active-work compaction supplements and history as folded display", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-active-compaction-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  const keptEntryId = session.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
  const supplement = (sourceEntryId: string, role: "user" | "assistant" | "tool", category: string, quote: string) => ({
    sourceEntryId,
    role,
    category,
    quote,
    sourceHash: "a".repeat(64),
    quoteHash: createHash("sha256").update(quote).digest("hex"),
  });
  const compactionEntryId = session.appendCompaction("## Active work summary", keptEntryId, 2_000, {
    type: "pi-continuity-compaction",
    version: 3,
    mode: "active-work",
    runId: "run-id",
    timelineId: "timeline-id",
    sourceEntryCount: 42,
    history: {
      read: [{ path: "src/read.ts", sourceEntryId: "read-source" }],
      modified: [{ path: "src/changed.ts", sourceEntryId: "changed-source" }],
    },
    supplements: [
      supplement("user-source", "user", "constraint", "Preserve behavior"),
      supplement("assistant-source", "assistant", "outcome", "Implemented the route"),
      supplement("failed-source", "tool", "error", "permission denied"),
      supplement("result-source", "tool", "outcome", "all checks passed"),
    ],
  });

  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "After compaction" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    const compaction = snapshot.conversation.messages.find(message => message.entryId === compactionEntryId);
    assert.equal(compaction?.text, "## Active work summary");
    assert.deepEqual(compaction?.compaction?.display, {
      records: [
        { sourceEntryId: "user-source", role: "user", text: "Preserve behavior" },
        { sourceEntryId: "assistant-source", role: "assistant", text: "Implemented the route" },
      ],
      failedTools: [{ sourceEntryId: "failed-source", text: "permission denied" }],
      toolResults: [{ sourceEntryId: "result-source", text: "all checks passed" }],
      history: {
        read: [{ path: "src/read.ts", sourceEntryId: "read-source" }],
        modified: [{ path: "src/changed.ts", sourceEntryId: "changed-source" }],
      },
    });
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

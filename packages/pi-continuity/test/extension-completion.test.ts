import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/pi-continuity.ts";
import { saveConfig } from "../src/config.ts";
import {
  archivalActivationDraft,
  emptyMemoryState,
  isMemoryState,
  isNotebookNote,
  isReviewRecord,
  serverNoteId,
  serverReviewId,
  sha256,
  type NotebookNote,
  type ReviewRecord,
} from "../src/memory.ts";
import type { ActivationDraft } from "../src/memory-activation.ts";
import { writeJsonAtomic } from "../src/storage.ts";
import { projectContext, worktreeFingerprint } from "../src/worktree.ts";

const exec = promisify(execFile);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "continuity-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(isolatedAgentDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for asynchronous extension action");
}

const generatedWriteDraft = (): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["before_tool_call"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "edit" },
      { fact: "file.path", op: "matchesGlob", value: "src/generated/**" },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil: "task_complete", rearmOn: ["context_compacted"] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "edit", "file.path": "src/source/client.ts" } }],
  },
});
const formatCommandDraft = (): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["before_tool_call", "after_tool_result"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "bash" },
      { fact: "tool.command", op: "startsWith", value: "dart format" },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil: "event_complete", rearmOn: [] },
  examples: {
    positive: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "dart format lib" } }],
    hardNegative: [{ event: "before_tool_call", facts: { "tool.name": "bash", "tool.command": "echo dart format" } }],
  },
});
const activatedNote = (overrides: Partial<NotebookNote> = {}): NotebookNote => ({
  id: serverNoteId(),
  scope: "user",
  owner: "default",
  trigger: "editing generated files",
  guidance: "Edit the generator instead.",
  authority: "user_instruction",
  origin: "agent",
  sourceRefs: [{ type: "direct_user_edit" }],
  disposition: "eligible_advisory",
  enforcementAuthority: "warning",
  activationDraft: generatedWriteDraft(),
  rawProposal: { trigger: "editing generated files", guidance: "Edit the generator instead." },
  rewriteCharacter: "format_only",
  revision: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

function runtime(initialActive = ["read", "edit", "continuity_update"]) {
  let active = [...initialActive];
  let thinking = "medium";
  let selectedModel: any;
  let modelSelections = 0;
  const appended: Array<{ customType: string; data: any }> = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const sent: string[] = [];
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: any }> = [];
  let sendHook: ((message: string) => void) | undefined;
  let appendFailure: Error | undefined;
  let sendFailure: Error | undefined;
  const pi: any = {
    events: {
      emit: (channel: string, value: unknown) => {
        emitted.push({ channel, value });
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
      on: (channel: string, listener: (value: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => {
      active = [...next];
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: any) => {
      if (appendFailure) {
        const error = appendFailure;
        appendFailure = undefined;
        throw error;
      }
      appended.push({ customType, data });
    },
    setModel: async (model: any) => {
      selectedModel = model;
      modelSelections++;
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (next: string) => {
      thinking = next;
    },
    sendUserMessage: (message: string) => {
      sent.push(message);
      sendHook?.(message);
    },
    sendMessage: (message: any, options: any) => {
      if (sendFailure) {
        const error = sendFailure;
        sendFailure = undefined;
        throw error;
      }
      customMessages.push({ message, options });
    },
  };
  extension(pi);
  return {
    handlers,
    tools,
    commands,
    appended,
    customMessages,
    sent,
    emitted,
    selectedModel: () => selectedModel,
    modelSelections: () => modelSelections,
    thinking: () => thinking,
    active: () => [...active],
    loadAgain: () => extension(pi),
    onSendUserMessage: (hook: (message: string) => void) => {
      sendHook = hook;
    },
    failNextAppend: (error = new Error("append failed")) => {
      appendFailure = error;
    },
    failNextSend: (error = new Error("send failed")) => {
      sendFailure = error;
    },
    emit: (channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
}

test("issues clear on their owning lifecycle transitions", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-issue-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verify-issue-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute(
      "plan",
      { action: "set_plan", goal: "Change", todos: ["Ship", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    const context = async () => (await app.handlers.get("context")?.[0]({ messages: [] }, ctx)).messages.at(-1).content;

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "failed",
      runId: "failed",
      results: [{ command: "npm test", code: 1 }],
    });
    assert.match(await context(), /Verification failed/);

    await tool.execute(
      "manual",
      { action: "state", latestFailure: "Manual blocker", nextAction: "Wait for user" },
      undefined,
      undefined,
      ctx,
    );
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "passed",
      runId: "passed",
      results: [],
    });
    assert.match(await context(), /Blocked: Manual blocker/);
    assert.match(await context(), /Next: Wait for user/);

    await tool.execute(
      "advance",
      { action: "todo", todoId: "todo_1", status: "done", nextTodoId: "todo_2" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(await context(), /Manual blocker|Wait for user/);

    await tool.execute(
      "manual-again",
      { action: "state", latestFailure: "Superseded blocker", nextAction: "Old next action" },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "replace-plan",
      { action: "set_plan", goal: "Finish", todos: ["Finish", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(await context(), /Superseded blocker|Old next action/);
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "failed",
      runId: "failed-again",
      results: [],
    });
    assert.match(await context(), /Verification failed/);
    await tool.execute(
      "progress-after-verification-failure",
      { action: "todo", todoId: "todo_1", status: "done", nextTodoId: "todo_2" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(await context(), /Verification failed/);
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "clean",
      runId: "clean",
      results: [],
    });
    assert.doesNotMatch(await context(), /Verification failed/);

    app.emit("pi-heartbeat:job", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "failed",
      id: "job-1",
      todoId: "todo_2",
    });
    assert.match(await context(), /Background job job-1 failed/);
    app.emit("pi-heartbeat:job", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "completed",
      id: "job-1",
      todoId: "todo_2",
    });
    assert.doesNotMatch(await context(), /Background job job-1 failed/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("clean Verify requires a tool-only acknowledgement before automatic completion", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-acknowledgement-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verify-acknowledgement-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    const finalMessage = {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
    };
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "failed",
      runId: "failed",
      results: [],
    });
    let rejected = await tool.execute(
      "failed-ack",
      { action: "state", allowUnverified: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rejected.content[0].text, /requires a current clean or no_checks/);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "clean",
      runId: "clean",
      results: [],
    });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    rejected = await tool.execute(
      "bad-ack",
      { action: "todo", todoId: "todo_1", status: "done", allowUnverified: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rejected.content[0].text, /allowUnverified requires action "state"/);

    const acknowledged = await tool.execute(
      "ack",
      { action: "state", allowUnverified: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(acknowledged.content[0].text, /Continuity state updated/);
    assert.equal(acknowledged.terminate, undefined);

    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit-after-ack", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit-after-ack", input: {} }, ctx);
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "no_checks",
      runId: "no-checks",
      results: [],
    });
    await tool.execute("ack-again", { action: "state", allowUnverified: true }, undefined, undefined, ctx);
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.equal(context, undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("completion may acknowledge an unavailable Verify in the same call", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-complete-ack-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verify-complete-ack-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit", input: {} }, ctx);
    const finalMessage = {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
    };
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);

    const blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "clean",
      runId: "clean",
      results: [],
    });
    const completed = await tool.execute(
      "complete-ack",
      { action: "state", completion: true, allowUnverified: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(completed.content[0].text, /Work completed/);
    assert.equal(completed.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("passing Verify completes a sole remaining verification todo", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verification-todo-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verification-todo", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute(
      "plan",
      { action: "set_plan", goal: "Ship", todos: ["Implement change", "Run final verification"] },
      undefined,
      undefined,
      ctx,
    );
    await tool.execute(
      "done",
      { action: "todo", todoId: "todo_1", status: "done", nextTodoId: "todo_2" },
      undefined,
      undefined,
      ctx,
    );
    for (const handler of app.handlers.get("tool_call") ?? []) await handler({ toolName: "edit", input: {} }, ctx);

    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "passed",
      runId: "passed",
      results: [],
    });
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.doesNotMatch(context.messages.at(-1).content, /Todo todo_2/);

    await app.handlers.get("message_end")?.[0]?.(
      { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } },
      ctx,
    );
    assert.equal(await app.handlers.get("context")?.[0]({ messages: [] }, ctx), undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("settlement waits for the single post-Verify final response", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-response-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verify-response", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? []) await handler({ toolName: "edit", input: {} }, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "passed",
      runId: "passed",
      results: [],
    });
    await app.handlers.get("agent_settled")?.[0]?.({}, ctx);
    const completed = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /^Work completed/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("circuit breaker aborts the third identical call within 30 seconds", async () => {
  const tool = runtime().tools.get("continuity_update");
  let aborts = 0;
  const ctx = {
    abort: () => {
      aborts++;
    },
  };
  const params = { action: "state", completion: true };
  const first = await tool.execute("call-1", params, undefined, undefined, ctx);
  const second = await tool.execute("call-2", params, undefined, undefined, ctx);
  const third = await tool.execute("call-3", params, undefined, undefined, ctx);
  assert.equal(first.terminate, undefined);
  assert.equal(second.terminate, undefined);
  assert.equal(third.terminate, true);
  assert.equal(third.details.circuitBreaker, true);
  assert.match(third.content[0].text, /3 identical calls within 30 seconds/);
  assert.equal(aborts, 1);
});

test("circuit breaker ignores distinct or expired calls", async () => {
  const oldNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const tool = runtime().tools.get("continuity_update");
    let aborts = 0;
    const ctx = {
      abort: () => {
        aborts++;
      },
    };
    await tool.execute("call-1", { action: "state", currentTodoId: "todo_1" }, undefined, undefined, ctx);
    await tool.execute("call-2", { action: "state", currentTodoId: "todo_2" }, undefined, undefined, ctx);
    await tool.execute("call-3", { action: "state", currentTodoId: "todo_3" }, undefined, undefined, ctx);
    const repeated = { action: "state", completion: true };
    await tool.execute("call-4", repeated, undefined, undefined, ctx);
    await tool.execute("call-5", repeated, undefined, undefined, ctx);
    now += 30_001;
    const expired = await tool.execute("call-6", repeated, undefined, undefined, ctx);
    assert.equal(expired.terminate, undefined);
    assert.equal(aborts, 0);
  } finally {
    Date.now = oldNow;
  }
});

test("set_plan accepts ordinary workingSet paths, canonicalizes invented IDs, and preserves credential rejection", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-todos-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "todo-session" },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    const result = await app.tools.get("continuity_update").execute(
      "call",
      {
        action: "set_plan",
        goal: "Ship change",
        planSummary: "Implement safely, then run checks",
        constraints: [" Keep API stable ", "  "],
        workingSet: [
          `${"LongDescriptive".repeat(5)}Validator.java`,
          "platform/web/src/shared/protocol/helios-android-tooling.ts",
          String.raw`platform\web\src\shared\protocol\helios-android-tooling.ts`,
        ],
        planTodos: [
          { id: "todo_1", text: "Implement" },
          { id: "todo_1", text: "Verify" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /Executing task list stored/);
    assert.equal(result.details, undefined);
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Current todo_1 \[in_progress\]: Implement/);
    assert.match(context.messages.at(-1).content, /Todo todo_2 \[pending\]: Verify/);

    const beforeUnsafe = context.messages.at(-1).content;
    for (const unsafePath of [
      `packages/${["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("")}/config.ts`,
      `packages/${"A".repeat(49)}0/config.ts`,
    ]) {
      await assert.rejects(
        app.tools
          .get("continuity_update")
          .execute(
            "unsafe-path",
            {
              action: "set_plan",
              goal: "Unsafe replacement",
              workingSet: [unsafePath],
              planTodos: [{ text: "Replace" }],
            },
            undefined,
            undefined,
            ctx,
          ),
        /candidate rejected: possible credential/,
      );
      const restored = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
      assert.equal(restored.messages.at(-1).content, beforeUnsafe);
    }

    const advanced = await app.tools
      .get("continuity_update")
      .execute(
        "advance",
        { action: "todo", todoId: "todo_1", status: "done", nextTodoId: "todo_2" },
        undefined,
        undefined,
        ctx,
      );
    assert.match(advanced.content[0].text, /state updated/i);
    const advancedContext = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(advancedContext.messages.at(-1).content, /Current todo_2 \[in_progress\]: Verify/);
    assert.match(advancedContext.messages.at(-1).content, /Done: 1/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("bulk todo completion is atomic and preserves the single-todo API", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-bulk-todos-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "bulk-todos-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute(
      "plan",
      { action: "set_plan", goal: "Ship", todos: ["Inspect", "Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );

    const snapshot = async () =>
      (await app.handlers.get("context")?.[0]({ messages: [] }, ctx)).messages.at(-1).content;
    const before = await snapshot();
    for (const invalid of [
      { action: "todo", todoIds: ["todo_1", "todo_1"], status: "done" },
      { action: "todo", todoIds: ["todo_1", "missing"], status: "done" },
      { action: "todo", todoIds: ["todo_1"], status: "in_progress" },
      { action: "todo", todoIds: ["todo_2"], status: "done", nextTodoId: "todo_1" },
      { action: "todo", todoIds: ["todo_1", "todo_2"], status: "done", nextTodoId: "todo_2" },
    ]) {
      const rejected = await tool.execute("invalid", invalid, undefined, undefined, ctx);
      assert.match(rejected.content[0].text, /Unknown or invalid todo transition/);
      assert.equal(await snapshot(), before, "failed bulk validation must not mutate work");
    }

    const continuityRoot = join(root, "agent", "pi-continuity");
    const workspaces = JSON.parse(await readFile(join(continuityRoot, "workspaces.json"), "utf8"));
    const workspaceId = workspaces.find((item: any) => item.canonicalPath === cwd).id;
    const workPath = join(continuityRoot, "workspaces", workspaceId, "sessions", "bulk-todos-session.json");
    const durableBefore = await readFile(workPath, "utf8");
    await assert.rejects(
      tool.execute(
        "unsafe",
        {
          action: "todo",
          todoIds: ["todo_1", "todo_2"],
          status: "done",
          nextTodoId: "todo_3",
          latestFailure: ["token", "unsafe-placeholder"].join("="),
        },
        undefined,
        undefined,
        ctx,
      ),
      /candidate rejected: possible credential/,
    );
    assert.equal(await snapshot(), before, "failed persistence must restore in-memory work");
    assert.equal(await readFile(workPath, "utf8"), durableBefore, "failed persistence must not change durable work");

    const completed = await tool.execute(
      "bulk",
      {
        action: "todo",
        todoIds: ["todo_1", "todo_2"],
        status: "done",
        nextTodoId: "todo_3",
        latestFailure: "",
        nextAction: "Verify the result",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(completed.content[0].text, /state updated/i);
    const after = await snapshot();
    assert.match(after, /Current todo_3 \[in_progress\]: Verify/);
    assert.match(after, /Done: 2/);
    assert.match(after, /Next: Verify the result/);

    // Existing callers retain the single todoId transition shape.
    const single = await tool.execute(
      "single",
      { action: "todo", todoId: "todo_3", status: "done" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(single.content[0].text, /state updated/i);
    assert.match(await snapshot(), /Done: 3/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("execution clarification is isolated, blocking, and cancellable", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-clarify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let leafContent: any[] = [];
  let aborts = 0;
  let selection: string | undefined;
  let customAnswer = "";
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    abort: () => {
      aborts++;
    },
    sessionManager: {
      getSessionId: () => "clarify-session",
      getEntries: () => [],
      getLeafEntry: () => ({ type: "message", message: { role: "assistant", content: leafContent } }),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => selection,
      input: async () => customAnswer,
      editor: async () => customAnswer,
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);

    const clarifyCall = {
      type: "toolCall",
      id: "clarify",
      name: "continuity_update",
      arguments: { action: "clarify" },
    };
    const editCall = { type: "toolCall", id: "edit", name: "edit", arguments: {} };
    leafContent = [clarifyCall, editCall];
    for (const event of [
      { toolName: "continuity_update", toolCallId: "clarify", input: { action: "clarify" } },
      { toolName: "edit", toolCallId: "edit", input: {} },
    ]) {
      for (const guard of app.handlers.get("tool_call") ?? [])
        assert.match((await guard(event, ctx)).reason, /only tool call.*safe checkpoint/i);
    }

    leafContent = [clarifyCall];
    const params = {
      action: "clarify",
      question: "Which implementation?",
      options: [{ label: "Small" }, { label: "Full", description: "Broader change" }],
    };
    for (const guard of app.handlers.get("tool_call") ?? [])
      assert.equal(
        await guard({ toolName: "continuity_update", toolCallId: "clarify", input: params }, ctx),
        undefined,
      );
    const prose = await tool.execute("clarify", params, undefined, undefined, ctx);
    assert.match(prose.content[0].text, /Ask user in prose and wait/);
    assert.match(prose.content[0].text, /1\. Small/);
    assert.match(prose.content[0].text, /2\. Full — Broader change/);
    assert.equal(prose.terminate, undefined);
    for (const guard of app.handlers.get("tool_call") ?? [])
      assert.match(
        (await guard({ toolName: "read", toolCallId: "read", input: {} }, ctx)).reason,
        /Ask the pending clarification in prose and stop/i,
      );
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    await app.handlers.get("message_end")?.[0]?.(
      {
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Which implementation?" }] },
      },
      ctx,
    );
    const pendingContext = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(pendingContext.messages.at(-1).content, /Work: executing/);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    ctx.hasUI = true;
    ctx.mode = "tui";
    selection = undefined;
    const cancelled = await tool.execute(
      "cancel",
      { ...params, question: "Continue or stop?" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(cancelled.content[0].text, /Execution stopped/);
    assert.equal(cancelled.terminate, true);
    assert.equal(aborts, 1);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    selection = "Small";
    const answered = await tool.execute("answer", { ...params, question: "Pick scope?" }, undefined, undefined, ctx);
    assert.match(
      answered.content[0].text,
      /^Small\n\nThe user answered the clarification\. Continue the current task now without waiting for another user message\.$/,
    );
    assert.deepEqual(answered.details.clarification, { question: "Pick scope?", answer: "Small" });
    selection = "Full — Broader change";
    const secondAnswer = await tool.execute(
      "second-answer",
      { ...params, question: "Pick deployment scope?" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      secondAnswer.content[0].text,
      /^Full — Broader change\n\nThe user answered the clarification\. Continue the current task now without waiting for another user message\.$/,
    );
    assert.deepEqual(secondAnswer.details.clarification, {
      question: "Pick deployment scope?",
      answer: "Full — Broader change",
    });

    selection = "Write a different answer…";
    customAnswer = "Only API changes";
    const custom = await tool.execute(
      "custom-answer",
      { ...params, question: "Any constraints?" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      custom.content[0].text,
      /^Only API changes\n\nThe user answered the clarification\. Continue the current task now without waiting for another user message\.$/,
    );
    assert.deepEqual(custom.details.clarification, { question: "Any constraints?", answer: "Only API changes" });
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("standalone and bulk clarification use the effective timeout without creating work", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-standalone-clarify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const app = runtime();
  const selectionOptions: Array<{ timeout?: number } | undefined> = [];
  const questionnaireOptions: Array<{ timeout?: number } | undefined> = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "rpc",
    abort: () => assert.fail("standalone clarification must not abort"),
    sessionManager: {
      getSessionId: () => "standalone-clarify-session",
      getEntries: () => [],
      getLeafEntry: () => ({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "clarify", name: "continuity_update", arguments: { action: "clarify" } }],
        },
      }),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (_title: string, _choices: string[], options?: { timeout?: number }) => {
        selectionOptions.push(options);
        return "Small";
      },
      input: async () => "Custom",
      questionnaire: async (questions: unknown[], options?: { timeout?: number }) => {
        questionnaireOptions.push(options);
        return questions.length === 1 ? ["Small"] : ["Small", "Later"];
      },
    },
  };
  try {
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    app.emit("pylon:runtime-policy", { version: 2, dialogTimeouts: { guard: 60, clarify: 120 } });
    const tool = app.tools.get("continuity_update");
    const single = await tool.execute(
      "single",
      { action: "clarify", question: "Scope?", options: [{ label: "Small" }, { label: "Large" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      single.content[0].text,
      /^Small\n\nThe user answered the clarification\. Continue the current task now without waiting for another user message\.$/,
    );
    assert.deepEqual(selectionOptions, []);

    const bulk = await tool.execute(
      "bulk",
      {
        action: "clarify",
        questions: [
          { question: "Scope?", options: [{ label: "Small" }, { label: "Large" }] },
          { question: "Deploy?", options: [{ label: "Now" }, { label: "Later" }] },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(bulk.content[0].text, /1\. Scope\?/);
    assert.match(
      bulk.content[0].text,
      /The user answered the clarifications\. Continue the current task now without waiting for another user message\.$/,
    );
    assert.deepEqual(questionnaireOptions, [{ timeout: 120_000 }, { timeout: 120_000 }]);
    assert.equal(
      app.appended.some(entry => entry.customType.includes("run")),
      false,
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("read-only execution completion skips Verify", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-read-only-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "read-only-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    await tool.execute("call", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "cancelled",
      runId: "old-run",
      results: [],
    });
    const completed = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /Work completed.*No further continuity updates needed/);
    assert.equal(completed.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("shell tools require Verify only when the Git worktree changes", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-bash-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["config", "user.email", "continuity@test.local"], { cwd });
  await exec("git", ["config", "user.name", "continuity-test"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await exec("git", ["add", "tracked.txt"], { cwd });
  await exec("git", ["commit", "-qm", "base"], { cwd });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const context = (sessionId: string): any => ({
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });
  try {
    for (const [sessionId, mutate, toolName] of [
      ["read-only-bash", false, "bash"],
      ["changed-bash", true, "bash"],
      ["read-only-grunt", false, "grunt"],
      ["changed-grunt", true, "grunt"],
    ] as const) {
      const app = runtime(),
        ctx = context(sessionId);
      for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
      const tool = app.tools.get("continuity_update");
      await tool.execute(
        "plan",
        { action: "set_plan", goal: "Run command", todos: ["Finish"] },
        undefined,
        undefined,
        ctx,
      );
      for (const handler of app.handlers.get("tool_call") ?? [])
        await handler({ toolName, toolCallId: `${toolName}-${sessionId}`, input: { command: "test" } }, ctx);
      if (mutate) await writeFile(join(cwd, "tracked.txt"), "changed\n");
      for (const handler of app.handlers.get("tool_result") ?? [])
        await handler(
          {
            toolName,
            toolCallId: `${toolName}-${sessionId}`,
            input: { command: "test" },
            content: [],
            details: {},
            isError: false,
          },
          ctx,
        );
      await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
      const result = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
      assert.match(result.content[0].text, mutate ? /Cannot complete until/ : /Work completed/);
      if (mutate) {
        await exec("git", ["checkout", "--", "tracked.txt"], { cwd });
      }
    }
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

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

test("blocked Guard calls stay read-only and Timeline restore messages invalidate Verify", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-integrations-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "integration-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Ship", todos: ["Finish"] }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "blocked-edit" }, ctx);
    app.emit("pi-guard:decision", { version: 1, cwd, decision: "blocked", toolCallId: "blocked-edit" });
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "blocked-edit", isError: true }, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    let result = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Work completed/);

    await tool.execute("plan-2", { action: "set_plan", goal: "Restore", todos: ["Finish"] }, undefined, undefined, ctx);
    await tool.execute("done-2", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    const contextHandler = app.handlers.get("context")![0];
    contextHandler(
      {
        messages: [
          {
            role: "custom",
            customType: "pi-worktree-mutation",
            content: "restored",
            details: { version: 1, cwd, changed: true, source: "pi-timeline", mutationId: "restore-1" },
          },
        ],
      },
      ctx,
    );
    result = await tool.execute("complete-2", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Cannot complete until/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("execution completion requires a qualifying Verify result after mutation", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "verify-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);
    const updated = await tool.execute(
      "call",
      { action: "todo", todoId: "todo_1", status: "done" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(updated.terminate, undefined);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit" }, ctx);
    for (const handler of app.handlers.get("tool_result") ?? [])
      await handler({ toolName: "edit", toolCallId: "edit" }, ctx);
    const blocked = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);
    assert.equal(blocked.terminate, undefined);
    app.emit("pi-verify:result", {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd,
      state: "passed",
      runId: "run",
      results: [],
    });
    const completed = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /Work completed.*No further continuity updates needed/);
    assert.equal(completed.terminate, true);
    const repeated = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(repeated.content[0].text, /already completed.*No further continuity updates needed/);
    assert.equal(repeated.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("subsequent plan inherits timeline lineage from a fresh executor session", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-lineage-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const previousRun = {
    version: 1,
    runId: "first-plan",
    timelineId: "first-plan",
    role: "executor",
    parentSessionId: "planner-session",
    createdAt: new Date().toISOString(),
  };
  const entries = [{ type: "custom", customType: "pylon-run", data: previousRun }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model: { provider: "provider", id: "executor" },
    sessionManager: { getSessionId: () => "fresh-executor-session", getEntries: () => entries },
    isIdle: () => true,
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Plan another change", ctx);

    const nextRun = app.appended.find(entry => entry.customType === "pylon-run" && entry.data.role === "planner")?.data;
    assert.ok(nextRun);
    assert.notEqual(nextRun.runId, previousRun.runId);
    assert.equal(nextRun.timelineId, previousRun.runId);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("explicit plan resets model context without replacing the visible session", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-handoff-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const models = new Map([
    ["provider/base", { provider: "provider", id: "base" }],
    ["provider/planner", { provider: "provider", id: "planner" }],
    ["provider/executor", { provider: "provider", id: "executor" }],
  ]);
  let newSessions = 0;
  let planningRun: Promise<void> | undefined;
  let app: ReturnType<typeof runtime>;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model: models.get("provider/base"),
    modelRegistry: {
      find: (provider: string, id: string) => models.get(`${provider}/${id}`),
      hasConfiguredAuth: () => true,
      getAvailable: () => [...models.values()],
    },
    sessionManager: {
      getSessionId: () => "planner-session",
      getSessionFile: () => join(root, "planner.jsonl"),
      getEntries: () => [],
    },
    isIdle: () => !planningRun,
    waitForIdle: async () => {
      await planningRun;
    },
    newSession: async () => {
      newSessions++;
      return { cancelled: false };
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => "Approve — reset context",
      editor: async () => "",
    },
  };
  try {
    app = runtime();
    app.onSendUserMessage(message => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        await app.tools
          .get("continuity_update")
          .execute(
            "call",
            {
              action: "set_plan",
              goal: "Ship change",
              planSummary: "Implement then verify",
              todos: ["Implement", "Verify"],
            },
            undefined,
            undefined,
            ctx,
          );
        for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
        planningRun = undefined;
      })();
    });
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    await app.commands.get("continuity").handler("planner provider/planner:high", ctx);
    await app.commands.get("continuity").handler("executor provider/executor:low", ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await planningRun;
    await waitFor(() => app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
    assert.equal(newSessions, 0);
    assert.equal(app.selectedModel()?.id, "executor");
    assert.equal(app.thinking(), "low");
    assert.ok(!app.sent.some(message => message.startsWith("/plan ")));
    const executorRun = [...app.appended]
      .reverse()
      .find(entry => entry.customType === "pylon-run" && entry.data.role === "executor")?.data;
    assert.ok(executorRun);
    assert.equal(executorRun.timelineId, executorRun.runId);
    const boundary = app.customMessages[0]!;
    assert.equal(boundary.message.customType, "pi-continuity-handoff");
    assert.equal(boundary.message.details.timelineId, executorRun.timelineId);
    assert.equal(boundary.message.display, false);
    assert.equal(boundary.options.triggerTurn, false);
    assert.match(boundary.message.content, /Earlier messages remain visible but are excluded/);
    assert.match(boundary.message.content, /Plan: Implement then verify/);
    const kickoff = app.customMessages.find(entry => entry.message.customType === "pi-continuity-execution");
    assert.ok(kickoff);
    assert.equal(kickoff.options.triggerTurn, true);
    assert.equal(kickoff.message.details.approvalToken, executorRun.approvalToken);
    assert.equal(kickoff.message.content, "Execute the approved Continuity plan now.");
    const context = app.handlers.get("context")![0];
    const filtered = await context({
      messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: [{ type: "text", text: "old response" }] },
        { role: "custom", ...boundary.message },
        { role: "custom", customType: "pi-continuity-memory", content: "stale memory", display: false },
        { role: "user", content: "executor prompt" },
      ],
    });
    assert.equal(
      filtered.messages.some((message: any) => message.content === "old prompt"),
      false,
    );
    assert.equal(
      filtered.messages.some((message: any) => message.content === "stale memory"),
      false,
    );
    assert.equal(
      filtered.messages.some((message: any) => message.content === "executor prompt"),
      true,
    );
    assert.equal(filtered.messages[0].customType, "pi-continuity-handoff");

    for (const details of [
      undefined,
      { ...boundary.message.details, version: 2 },
      { ...boundary.message.details, runId: "other-run" },
      { ...boundary.message.details, timelineId: "other-timeline" },
    ]) {
      const unfiltered = await context({
        messages: [
          { role: "user", content: "keep old prompt" },
          { role: "custom", customType: "pi-continuity-handoff", details },
          { role: "user", content: "keep executor prompt" },
        ],
      });
      assert.equal(
        unfiltered.messages.some((message: any) => message.content === "keep old prompt"),
        true,
      );
    }

    await app.commands.get("plan").handler("cancel", ctx);
    const cancelledMessages = [
      { role: "user", content: "keep cancelled prompt" },
      { role: "custom", ...boundary.message },
    ];
    const cancelled = await context({ messages: cancelledMessages });
    assert.equal(
      (cancelled?.messages ?? cancelledMessages).some((message: any) => message.content === "keep cancelled prompt"),
      true,
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("child reload preserves progress instead of replaying the handoff snapshot", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-child-reload-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const now = new Date().toISOString();
  const handoffWork = {
    schemaVersion: 1,
    mode: "executing",
    goal: "Ship change",
    approved: true,
    constraints: ["Keep compatibility"],
    planSummary: "Implement then verify",
    todos: [{ id: "todo_1", text: "Implement", status: "pending", updatedAt: now }],
    runId: "run-child",
    createdAt: now,
    updatedAt: now,
  };
  const model = { provider: "provider", id: "executor" };
  const entries = [
    {
      type: "custom",
      customType: "pi-continuity-handoff",
      data: { version: 1, work: handoffWork, model, thinking: "low" },
    },
  ];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "child-session", getEntries: () => entries },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    const sessionStart = app.handlers.get("session_start")![0];
    await sessionStart({ reason: "startup" }, ctx);
    assert.equal(app.modelSelections(), 1);
    const leaseDirectory = join(root, "agent", "pi-continuity", "session-artifacts");
    const initialLeases = await readdir(leaseDirectory);
    assert.equal(initialLeases.length, 1);

    await app.tools
      .get("continuity_update")
      .execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    await sessionStart({ reason: "reload" }, ctx);

    assert.deepEqual(await readdir(leaseDirectory), initialLeases, "reload keeps the same lease continuously");
    assert.equal(app.modelSelections(), 1);
    const context = await app.handlers.get("context")![0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Done: 1/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("task widget resets after settlement but survives mid-turn steering", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-widget-reset-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const widgets: unknown[] = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => "widget-reset-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: (_name: string, value: unknown) => widgets.push(value) },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    const renderWidget = (widget: any) =>
      widget({}, { fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~${text}~` })
        .render(1_000)
        .map((line: string) => line.trimEnd());
    await tool.execute(
      "call",
      { action: "set_plan", goal: "First task", todos: ["Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● Implement", "○ Verify"]);

    await tool.execute(
      "call",
      { action: "todo", todoId: "todo_1", nextTodoId: "todo_2", status: "done" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● ~Implement~", "● Verify"]);
    const shown = widgets.length;

    for (const handler of app.handlers.get("input") ?? [])
      await handler({ text: "Adjust it", source: "interactive", streamingBehavior: "steer" }, ctx);
    assert.equal(widgets.length, shown);

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    assert.equal(widgets.at(-1), undefined);

    await tool.execute(
      "call",
      { action: "set_plan", goal: "Second task", todos: ["Verify"] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● Verify"]);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("TUI approval waits for the scheduled planner response before showing choices", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-selector-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let selections = 0;
  let approvalTitle = "";
  let structuredPlan = "";
  let planningRun: Promise<void> | undefined;
  let app: ReturnType<typeof runtime>;
  const model = { provider: "provider", id: "base" };
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: { getSessionId: () => "selector-session", getEntries: () => [] },
    isIdle: () => !planningRun,
    waitForIdle: async () => {
      await planningRun;
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (title: string) => {
        approvalTitle = title;
        selections++;
        return "Approve — continue current session";
      },
      editor: async () => "",
    },
  };
  try {
    app = runtime();
    app.onSendUserMessage(message => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        assert.equal(selections, 0);
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        const result = await app.tools
          .get("continuity_update")
          .execute(
            "call",
            {
              action: "set_plan",
              goal: "Ship change",
              planSummary: "Implement then verify",
              todos: ["Implement", "Verify"],
            },
            undefined,
            undefined,
            ctx,
          );
        structuredPlan = result.details.plan;
        for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
        planningRun = undefined;
      })();
    });
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await planningRun;
    await waitFor(() => app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
    assert.equal(selections, 1);
    assert.equal(approvalTitle, "Plan ready — review structured plan above");
    assert.match(structuredPlan, /^Plan\n\nGoal\nShip change/);
    assert.deepEqual(app.sent, [
      "Plan this task without modifying project files. Use continuity_update set_plan; put the approach in planSummary, concrete paths/symbols in workingSet, unresolved assumptions or gaps in assumptions, and completion checks in acceptanceCriteria. Keep todos outcome-level: Ship change",
    ]);
    const executorRun = [...app.appended]
      .reverse()
      .find(entry => entry.customType === "pylon-run" && entry.data.role === "executor")?.data;
    assert.ok(executorRun?.runId);
    assert.ok(executorRun?.timelineId);
    assert.ok(!app.sent.some(message => message.startsWith("/plan ")));
    assert.equal(app.customMessages.filter(entry => entry.message.customType === "pi-continuity-execution").length, 1);
    const context = await app.handlers.get("context")?.[0](
      { messages: [{ role: "user", content: "Keep this context" }] },
      ctx,
    );
    assert.equal(context.messages[0].content, "Keep this context");
    assert.match(context.messages.at(-1).content, /Work: executing/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("dismissed TUI approval is offered again on the next settlement", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-dismissed-approval-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let selections = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: { getSessionId: () => "dismissed-approval-session", getEntries: () => [] },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => (++selections === 1 ? undefined : "Approve — continue current session"),
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement then verify", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => selections === 1);
    for (let attempt = 0; attempt < 20 && selections < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    }
    assert.equal(selections, 2);
    await waitFor(() => app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("unavailable executor leaves TUI approval pending", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-unavailable-executor-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let executorAvailable = false;
  let selections = 0;
  const notifications: string[] = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        executorAvailable && provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: { getSessionId: () => "unavailable-executor-session", getEntries: () => [] },
    isIdle: () => true,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return "Approve — continue current session";
      },
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement then verify", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => notifications.includes("Executor model unavailable."));
    assert.equal(selections, 1);
    assert.ok(!app.active().includes("edit"));

    executorAvailable = true;
    for (let attempt = 0; attempt < 20 && selections < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    }
    assert.equal(selections, 2);
    await waitFor(() => app.active().includes("edit"));
    assert.ok(app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("approval survives a clarification turn and normalizes missing plan summary", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-replan-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let selections = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: { getSessionId: () => "replan-session", getEntries: () => [] },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return selections === 1 ? "Request changes" : "Approve — continue current session";
      },
      editor: async () => "Keep the same steps but clarify wording",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    assert.equal(selections, 0);

    const rejected = await app.tools
      .get("continuity_update")
      .execute("empty", { action: "set_plan", goal: "Ship change", todos: [] }, undefined, undefined, ctx);
    assert.match(rejected.content[0].text, /At least one non-empty todo/);

    await app.tools
      .get("continuity_update")
      .execute(
        "final",
        { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
        undefined,
        undefined,
        ctx,
      );
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => selections === 1);
    await waitFor(() => app.sent.some(message => message.startsWith("Plan changes requested for revision 1:")));

    await app.tools
      .get("continuity_update")
      .execute(
        "revised",
        { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
        undefined,
        undefined,
        ctx,
      );
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(
      () =>
        app.active().includes("edit") &&
        app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"),
    );

    assert.equal(selections, 2);
    assert.ok(app.active().includes("edit"));
    assert.ok(app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Plan anchor: Implement; Verify/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("RPC settlement presents plan review and keeps Plan mode status until approval", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-rpc-plan-review-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  const statuses: Array<string | undefined> = [];
  let selections = 0;
  let editors = 0;
  const selectOptions: unknown[] = [];
  const editorOptions: unknown[] = [];
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "rpc",
    model,
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-review-session", getEntries: () => [] },
    ui: {
      notify: () => {},
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      setWidget: () => {},
      select: async (_title: string, _choices: string[], options: unknown) => {
        selectOptions.push(options);
        return ++selections === 1 ? "Request changes" : "Approve — reset context";
      },
      editor: async (_title: string, _prefill: string, options: unknown) => {
        editorOptions.push(options);
        editors++;
        return "Clarify the implementation boundary.";
      },
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => app.sent.some(message => message.startsWith("Plan changes requested for revision 1:")));
    assert.equal(selections, 1);
    assert.equal(editors, 1);
    assert.deepEqual(selectOptions, [{ timeout: 0 }]);
    assert.deepEqual(editorOptions, [{ timeout: 0 }]);
    assert.equal(statuses.at(-1), "Plan mode");

    await app.tools
      .get("continuity_update")
      .execute(
        "revised",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement safely", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));

    assert.equal(selections, 2);
    assert.deepEqual(selectOptions, [{ timeout: 0 }, { timeout: 0 }]);
    assert.equal(statuses.at(-1), undefined);
    const kickoff = app.customMessages.find(entry => entry.message.customType === "pi-continuity-execution");
    assert.equal(kickoff?.message.content, "Execute the approved Continuity plan now.");
    assert.ok(app.customMessages.some(entry => entry.message.customType === "pi-continuity-handoff"));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Inspector feedback makes an open RPC approval dialog stale without requeueing it", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-rpc-plan-race-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let resolveChoice: ((choice: string | undefined) => void) | undefined;
  let selections = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "rpc",
    model,
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-race-session", getEntries: () => [] },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return new Promise<string | undefined>(resolve => {
          resolveChoice = resolve;
        });
      },
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await waitFor(() => selections === 1 && Boolean(resolveChoice));

    let action: Promise<unknown> | undefined;
    app.emit("pi-continuity:plan-action", {
      version: 1,
      sessionId: "rpc-plan-race-session",
      expectedGeneration: 1,
      expectedRevision: 1,
      action: "requestChanges",
      feedback: "Use the narrower boundary.",
      respond: (value: unknown | Promise<unknown>) => {
        action = Promise.resolve(value);
      },
    });
    await action;
    resolveChoice!("Approve — continue current session");
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(selections, 1);
    assert.equal(
      app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"),
      false,
    );
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC plan actions persist feedback, preserve todo IDs, and approve the reviewed revision", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-plan-action-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "rpc",
    model,
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => "rpc-plan-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        {
          action: "set_plan",
          goal: "Ship change",
          planSummary: "Update the boundary",
          workingSet: ["src/index.ts"],
          assumptions: ["The API remains stable."],
          acceptanceCriteria: ["Focused tests pass."],
          todos: ["Implement", "Review"],
        },
        undefined,
        undefined,
        ctx,
      );

    const state = () => {
      let snapshot: any;
      app.emit("pi-continuity:state-request", {
        version: 4,
        sessionId: "rpc-plan-session",
        respond: (value: any) => {
          snapshot = value;
        },
      });
      return snapshot;
    };
    const action = (request: Record<string, unknown>) => {
      let result: Promise<unknown> | undefined;
      app.emit("pi-continuity:plan-action", {
        version: 1,
        sessionId: "rpc-plan-session",
        expectedGeneration: 1,
        ...request,
        respond: (value: unknown | Promise<unknown>) => {
          result = Promise.resolve(value);
        },
      });
      assert.ok(result);
      return result;
    };
    const initial = state().work;
    assert.deepEqual(initial.handoff.workingSet, ["src/index.ts"]);
    await action({ action: "requestChanges", expectedRevision: 1, feedback: "Clarify the implementation step." });
    assert.equal(state().work.revisionFeedback.text, "Clarify the implementation step.");
    await assert.rejects(action({ action: "approve", resetContext: false, expectedRevision: 1 }), /requested changes/i);
    await assert.rejects(action({ action: "approve", resetContext: false, expectedRevision: 2 }), /revision changed/i);

    await app.tools.get("continuity_update").execute(
      "revised",
      {
        action: "set_plan",
        goal: "Ship change",
        planSummary: "Update the boundary safely",
        planTodos: [
          { id: initial.todos[0].id, text: "Implement safely" },
          { id: initial.todos[1].id, text: "Review" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const revised = state().work;
    assert.equal(revised.planRevision, 2);
    assert.equal(revised.todos[0].id, initial.todos[0].id);
    assert.equal(revised.revisionFeedback, undefined);

    await Promise.all([
      action({ action: "approve", resetContext: false, expectedRevision: 2 }),
      action({ action: "approve", resetContext: false, expectedRevision: 2 }),
    ]);
    assert.equal(app.customMessages.filter(entry => entry.message.customType === "pi-continuity-execution").length, 1);
    assert.equal(
      app.appended.filter(entry => entry.customType === "pylon-run" && entry.data.role === "executor").length,
      1,
    );
    assert.equal(state().work.approvalPending, true);
    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    assert.equal(state().work.approvalPending, false);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted approval reconciles forward once on reload", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-approval-recovery-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const model = { provider: "provider", id: "base" };
  let app: ReturnType<typeof runtime>;
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    isIdle: () => true,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "approval-recovery-session",
      getEntries: () => [
        ...(app?.appended ?? []).map(entry => ({ type: "custom", ...entry })),
        ...(app?.customMessages ?? []).map(entry => ({ type: "custom_message", ...entry.message })),
      ],
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, select: async () => undefined },
  };
  try {
    app = runtime();
    const sessionStart = app.handlers.get("session_start")![0];
    await sessionStart({}, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await app.tools
      .get("continuity_update")
      .execute(
        "plan",
        { action: "set_plan", goal: "Ship change", planSummary: "Implement", todos: ["Implement"] },
        undefined,
        undefined,
        ctx,
      );

    app.failNextAppend();
    await assert.rejects(app.commands.get("plan").handler("approve-current", ctx), /append failed/);
    assert.equal(
      app.appended.filter(entry => entry.customType === "pylon-run" && entry.data.role === "executor").length,
      0,
    );

    await sessionStart({ reason: "reload" }, ctx);
    await waitFor(() => app.customMessages.some(entry => entry.message.customType === "pi-continuity-execution"));
    const token = app.appended.find(entry => entry.customType === "pylon-run" && entry.data.role === "executor")?.data
      .approvalToken;
    assert.ok(token);
    assert.equal(app.appended.filter(entry => entry.data?.approvalToken === token).length, 1);
    assert.equal(app.customMessages.filter(entry => entry.message.details?.approvalToken === token).length, 1);

    await sessionStart({ reason: "reload" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(app.appended.filter(entry => entry.data?.approvalToken === token).length, 1);
    assert.equal(app.customMessages.filter(entry => entry.message.details?.approvalToken === token).length, 1);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

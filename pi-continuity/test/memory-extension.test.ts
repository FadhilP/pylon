import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../extensions/pi-continuity.ts";

function runtime() {
  let active = ["read", "edit", "continuity_update"];
  let thinking = "medium";
  let selectedModel: any;
  let modelSelections = 0;
  const appended: Array<{ customType: string; data: any }> = [];
  const sent: string[] = [];
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let sendHook: ((message: string) => void) | undefined;
  const pi: any = {
    events: {
      emit: (channel: string, value: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(value);
      },
      on: (channel: string, listener: (value: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener); listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => { active = [...next]; },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
    setModel: async (model: any) => {
      selectedModel = model;
      modelSelections++;
      return true;
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (next: string) => { thinking = next; },
    sendUserMessage: (message: string) => {
      sent.push(message);
      sendHook?.(message);
    },
  };
  extension(pi);
  return {
    handlers,
    tools,
    commands,
    appended,
    sent,
    selectedModel: () => selectedModel,
    modelSelections: () => modelSelections,
    thinking: () => thinking,
    onSendUserMessage: (hook: (message: string) => void) => { sendHook = hook; },
    emit: (channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
}

test("completion guidance keeps final responses tool-free", () => {
  const app = runtime();
  const guidance = app.tools.get("continuity_update").promptGuidelines.join("\n");
  assert.match(guidance, /tool-only assistant turns/i);
  assert.match(guidance, /final user-facing response with no tool calls/i);
  assert.match(guidance, /Continuity completes automatically/i);
  assert.match(guidance, /skip Verify for read-only work/i);
  assert.match(guidance, /blocking user decision/i);
  assert.match(guidance, /sole tool call at a safe checkpoint/i);
  assert.match(guidance, /never re-ask an answered question without new evidence/i);
});

test("completion requires response text before its tool call", async () => {
  const app = runtime();
  const guard = app.handlers.get("tool_call")?.[0];
  const event = {
    toolName: "continuity_update",
    toolCallId: "complete",
    input: { action: "state", completion: true },
  };
  const check = (content: any[]) => guard?.(event, {
    sessionManager: {
      getLeafEntry: () => ({
        type: "message",
        message: { role: "assistant", content },
      }),
    },
  });

  assert.match((await check([
    { type: "toolCall", id: "complete", name: "continuity_update" },
  ])).reason, /Write the final user-facing response first/);
  assert.match((await check([
    { type: "text", text: "  " },
    { type: "toolCall", id: "complete", name: "continuity_update" },
  ])).reason, /Write the final user-facing response first/);
  assert.match((await check([
    { type: "toolCall", id: "complete", name: "continuity_update" },
    { type: "text", text: "Done" },
  ])).reason, /Write the final user-facing response first/);
  assert.match((await check([
    { type: "text", text: "Done" },
    { type: "toolCall", id: "other", name: "continuity_update" },
  ])).reason, /Write the final user-facing response first/);
  assert.equal(await check([
    { type: "text", text: "Done" },
    { type: "toolCall", id: "complete", name: "continuity_update" },
  ]), undefined);
});

test("text-only final response automatically completes ready work", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-auto-complete-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "auto-complete-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    const messageEnd = app.handlers.get("message_end")?.[0];

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "toolUse",
      content: [
        { type: "text", text: "Not final" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ],
    } }, ctx);
    let context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Not final" }],
    } }, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);

    await messageEnd?.({ message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } }, ctx);
    context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.equal(context, undefined);
    const repeated = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(repeated.content[0].text, /already completed/i);
    assert.equal(repeated.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("automatic completion waits for required verification", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-auto-verify-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "auto-verify-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", { action: "set_plan", goal: "Change", todos: ["Ship"] }, undefined, undefined, ctx);
    await tool.execute("done", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit", input: {} }, ctx);
    const finalMessage = { message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }],
    } };
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    let blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);

    app.emit("pi-verify:result", { version: 1, cwd, state: "passed", runId: "run", results: [] });
    await app.handlers.get("message_end")?.[0]?.(finalMessage, ctx);
    blocked = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /already completed/i);
    assert.equal(blocked.terminate, true);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("TUI keeps ordinary continuity updates hidden but shows terminal outcomes", () => {
  const tool = runtime().tools.get("continuity_update");
  const theme = { fg: (_color: string, text: string) => text };
  const render = (text: string) => tool.renderResult(
    { content: [{ type: "text", text }] },
    {},
    theme,
  ).render(80).join("\n");
  assert.equal(render("Continuity state updated."), "");
  assert.match(render("Work completed. No further continuity updates needed."), /Task completed/);
  assert.match(render("Continuity circuit breaker stopped 3 identical calls within 30 seconds."), /loop stopped/);
});

test("circuit breaker aborts the third identical call within 30 seconds", async () => {
  const tool = runtime().tools.get("continuity_update");
  let aborts = 0;
  const ctx = { abort: () => { aborts++; } };
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
    const ctx = { abort: () => { aborts++; } };
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

test("set_plan creates executing todos without explicit plan mode", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-todos-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "todo-session" },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    const result = await app.tools.get("continuity_update").execute(
      "call", {
        action: "set_plan",
        goal: "Ship change",
        todos: ["Implement", "Verify"],
      }, undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /Executing task list stored/);
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Todo todo_1 \[pending\]: Implement/);
    assert.match(context.messages.at(-1).content, /Todo todo_2 \[pending\]: Verify/);
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
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    abort: () => { aborts++; },
    sessionManager: {
      getSessionId: () => "clarify-session",
      getEntries: () => [],
      getLeafEntry: () => ({
        type: "message",
        message: { role: "assistant", content: leafContent },
      }),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => selection,
      editor: async () => "",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", {
      action: "set_plan", goal: "Ship", todos: ["Implement"],
    }, undefined, undefined, ctx);

    const clarifyCall = {
      type: "toolCall", id: "clarify", name: "continuity_update",
      arguments: { action: "clarify" },
    };
    const editCall = {
      type: "toolCall", id: "edit", name: "edit", arguments: {},
    };
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
      assert.equal(await guard({ toolName: "continuity_update", toolCallId: "clarify", input: params }, ctx), undefined);
    const prose = await tool.execute("clarify", params, undefined, undefined, ctx);
    assert.match(prose.content[0].text, /Ask user in prose and wait/);
    assert.match(prose.content[0].text, /1\. Small/);
    assert.match(prose.content[0].text, /2\. Full — Broader change/);
    assert.equal(prose.terminate, undefined);
    for (const guard of app.handlers.get("tool_call") ?? [])
      assert.match((await guard({ toolName: "read", toolCallId: "read", input: {} }, ctx)).reason, /Ask the pending clarification in prose and stop/i);
    await tool.execute("done", {
      action: "todo", todoId: "todo_1", status: "done",
    }, undefined, undefined, ctx);
    await app.handlers.get("message_end")?.[0]?.({ message: {
      role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Which implementation?" }],
    } }, ctx);
    const pendingContext = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(pendingContext.messages.at(-1).content, /Work: executing/);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    ctx.hasUI = true;
    ctx.mode = "tui";
    selection = undefined;
    const cancelled = await tool.execute("cancel", {
      ...params, question: "Continue or stop?",
    }, undefined, undefined, ctx);
    assert.match(cancelled.content[0].text, /Execution stopped/);
    assert.equal(cancelled.terminate, true);
    assert.equal(aborts, 1);

    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    selection = "Small";
    const answered = await tool.execute("answer", {
      ...params, question: "Pick scope?",
    }, undefined, undefined, ctx);
    assert.equal(answered.content[0].text, "Small");
    selection = "Full — Broader change";
    const secondAnswer = await tool.execute("second-answer", {
      ...params, question: "Pick deployment scope?",
    }, undefined, undefined, ctx);
    assert.equal(secondAnswer.content[0].text, "Full — Broader change");
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
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "read-only-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Inspect", todos: ["Answer"] }, undefined, undefined, ctx);
    await tool.execute("call", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    app.emit("pi-verify:result", { version: 1, cwd, state: "cancelled", runId: "old-run", results: [] });
    const completed = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /Work completed.*No further continuity updates needed/);
    assert.equal(completed.terminate, true);
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
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "verify-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", { action: "set_plan", goal: "Ship", todos: ["Implement"] }, undefined, undefined, ctx);
    const updated = await tool.execute("call", { action: "todo", todoId: "todo_1", status: "done" }, undefined, undefined, ctx);
    assert.equal(updated.terminate, undefined);
    for (const handler of app.handlers.get("tool_call") ?? [])
      await handler({ toolName: "edit" }, ctx);
    const blocked = await tool.execute("call", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(blocked.content[0].text, /Cannot complete until/);
    assert.equal(blocked.terminate, undefined);
    app.emit("pi-verify:result", { version: 1, cwd, state: "passed", runId: "run", results: [] });
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

test("explicit plan selects planner and hands approved work to executor session", async () => {
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
  const childEntries: Array<{ type: string; value: any }> = [];
  let kickoff = "";
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
    waitForIdle: async () => { await planningRun; },
    newSession: async ({ setup, withSession }: any) => {
      await setup({
        appendModelChange: (provider: string, id: string) =>
          childEntries.push({ type: "model", value: { provider, id } }),
        appendThinkingLevelChange: (value: string) =>
          childEntries.push({ type: "thinking", value }),
        appendCustomEntry: (type: string, value: any) =>
          childEntries.push({ type, value }),
      });
      await withSession({
        ...ctx,
        model: models.get("provider/executor"),
        sendUserMessage: async (text: string) => { kickoff = text; },
      });
      return { cancelled: false };
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => "Approve — fresh executor session",
      editor: async () => "",
    },
  };
  try {
    app = runtime();
    app.onSendUserMessage((message) => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        await app.tools.get("continuity_update").execute(
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
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("continuity").handler(
      "planner provider/planner:high",
      ctx,
    );
    await app.commands.get("continuity").handler(
      "executor provider/executor:low",
      ctx,
    );
    await app.commands.get("plan").handler("Ship change", ctx);
    assert.equal(app.selectedModel()?.id, "planner");
    assert.equal(app.thinking(), "high");
    assert.ok(!app.sent.some((message) => message.startsWith("/plan ")));
    assert.deepEqual(childEntries[0], {
      type: "model",
      value: { provider: "provider", id: "executor" },
    });
    assert.deepEqual(childEntries.map((entry) => entry.type), [
      "model",
      "thinking",
      "pi-conductor-run",
      "pi-continuity-handoff",
    ]);
    assert.equal(
      kickoff,
      "Inspect the current workspace and validate the approved plan's assumptions before editing. Execute the plan, track todos, and run fresh verification.",
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
  const entries = [{
    type: "custom",
    customType: "pi-continuity-handoff",
    data: { version: 1, work: handoffWork, model, thinking: "low" },
  }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "child-session",
      getEntries: () => entries,
    },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    const sessionStart = app.handlers.get("session_start")![0];
    await sessionStart({ reason: "startup" }, ctx);
    assert.equal(app.modelSelections(), 1);

    await app.tools.get("continuity_update").execute(
      "done",
      { action: "todo", todoId: "todo_1", status: "done" },
      undefined,
      undefined,
      ctx,
    );
    await sessionStart({ reason: "reload" }, ctx);

    assert.equal(app.modelSelections(), 1);
    const context = await app.handlers.get("context")![0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Todo todo_1 \[done\]: Implement/);
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
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: (_name: string, value: unknown) => widgets.push(value),
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("call", {
      action: "set_plan",
      goal: "First task",
      todos: ["Implement"],
    }, undefined, undefined, ctx);
    const shown = widgets.length;
    assert.deepEqual(widgets.at(-1), ["Tasks", "○ Implement"]);

    for (const handler of app.handlers.get("input") ?? [])
      await handler({ text: "Adjust it", source: "interactive", streamingBehavior: "steer" }, ctx);
    assert.equal(widgets.length, shown);

    for (const handler of app.handlers.get("agent_settled") ?? []) await handler({}, ctx);
    for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
    assert.equal(widgets.at(-1), undefined);

    await tool.execute("call", {
      action: "set_plan",
      goal: "Second task",
      todos: ["Verify"],
    }, undefined, undefined, ctx);
    assert.deepEqual(widgets.at(-1), ["Tasks", "○ Verify"]);
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
  let planningRun: Promise<void> | undefined;
  let app: ReturnType<typeof runtime>;
  const model = { provider: "provider", id: "base" };
  const ctx: any = {
    cwd,
    hasUI: true,
    mode: "tui",
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "selector-session",
      getEntries: () => [],
    },
    isIdle: () => !planningRun,
    waitForIdle: async () => { await planningRun; },
    ui: {
      notify: () => {},
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
    app = runtime();
    app.onSendUserMessage((message) => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        assert.equal(selections, 0);
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        await app.tools.get("continuity_update").execute(
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
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    assert.equal(selections, 1);
    assert.deepEqual(app.sent, [
      "Plan this task without modifying project files: Ship change",
      "Execute approved stored plan in current session. Track and verify todos.",
    ]);
    assert.ok(!app.sent.some((message) => message.startsWith("/plan ")));
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("memory candidates survive manual and turn-end compact into model context", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "memory-session" },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const first = runtime();
    for (const handler of first.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    const result = await first.tools.get("continuity_update").execute(
      "call", {
        action: "memory_candidate",
        key: "workflow.verify",
        kind: "workflow",
        text: "Run npm test before release",
        source: "project instructions",
        confidence: 1,
        memoryAction: "add",
      }, undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /stored/);
    await first.commands.get("memory").handler("compact", ctx);
    await first.tools.get("continuity_update").execute(
      "call", {
        action: "memory_candidate",
        key: "workflow.lint",
        kind: "workflow",
        text: "Run npm run check before release",
        source: "project instructions",
        confidence: 1,
        memoryAction: "add",
      }, undefined, undefined, ctx,
    );
    for (const handler of first.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);

    const second = runtime();
    for (const handler of second.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    for (const handler of second.handlers.get("input") ?? [])
      await handler({ source: "user", text: "verify lint release check" }, ctx);
    const context = await second.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Memory workflow\.verify: Run npm test before release/);
    assert.match(context.messages.at(-1).content, /Memory workflow\.lint: Run npm run check before release/);
    await second.commands.get("memory").handler("forget workflow.verify", ctx);
    const afterForget = await second.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.doesNotMatch(afterForget.messages.at(-1).content, /workflow\.verify/);
    assert.match(afterForget.messages.at(-1).content, /workflow\.lint/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

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
  const appended: Array<{ customType: string; data: any }> = [];
  const sent: string[] = [];
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
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
    setModel: async (model: any) => { selectedModel = model; return true; },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (next: string) => { thinking = next; },
    sendUserMessage: (message: string) => { sent.push(message); },
  };
  extension(pi);
  return {
    handlers,
    tools,
    commands,
    appended,
    sent,
    selectedModel: () => selectedModel,
    thinking: () => thinking,
    emit: (channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
}

test("completion guidance makes a successful update terminal", () => {
  const app = runtime();
  const guidance = app.tools.get("continuity_update").promptGuidelines.join("\n");
  assert.match(guidance, /write the final user-facing response in the same assistant message/i);
  assert.match(guidance, /completion true alone as the final tool call/i);
  assert.match(guidance, /terminates the turn/i);
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

test("execution completion requires a qualifying Verify result", async () => {
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
    waitForIdle: async () => {
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
    },
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
    assert.ok(childEntries.some((entry) => entry.type === "pi-conductor-run"));
    assert.ok(childEntries.some((entry) => entry.type === "pi-continuity-handoff"));
    assert.match(kickoff, /Execute approved stored plan/);
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

test("TUI current-session approval runs command logic without exposing a slash prompt", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-selector-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let selections = 0;
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
    waitForIdle: async () => {
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
    },
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

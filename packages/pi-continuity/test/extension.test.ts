import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import extension from "../extensions/pi-continuity.ts";

const exec = promisify(execFile);

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for asynchronous extension action");
}

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
    active: () => [...active],
    loadAgain: () => extension(pi),
    onSendUserMessage: (hook: (message: string) => void) => { sendHook = hook; },
    emit: (channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
  };
}

test("continuity and memory guidance stay dedicated", () => {
  const app = runtime();
  const continuity = app.tools.get("continuity_update");
  const memory = app.tools.get("memory");
  const guidance = continuity.promptGuidelines.join("\n");
  const memoryGuidance = memory.promptGuidelines.join("\n");
  assert.match(continuity.promptSnippet, /planning.*todo\/state.*clarification/i);
  assert.match(guidance, /set_plan selectively/i);
  assert.match(guidance, /Straightforward read-only work and one-shot local fixes may skip it/i);
  assert.match(guidance, /2–4 outcome-level todos/i);
  assert.match(guidance, /Nonterminal todo updates may be alongside the next independent useful tool/i);
  assert.match(guidance, /Verification is a gate, not a separate todo by default/i);
  assert.match(guidance, /keep verification out of new todo lists/i);
  assert.match(guidance, /bulk-complete finished implementation todos/i);
  assert.match(guidance, /existing final todo that includes verification/i);
  assert.match(guidance, /run Verify first, then mark that todo done in a tool-only turn/i);
  assert.match(guidance, /exactly one evidence-aware final response/i);
  assert.doesNotMatch(guidance, /verification follows below/i);
  assert.match(guidance, /Continuity completes automatically/i);
  assert.match(guidance, /skip Verify for read-only work/i);
  assert.match(guidance, /blocking user decision/i);
  assert.match(guidance, /sole tool call at a safe checkpoint/i);
  assert.match(guidance, /never re-ask an answered question without new evidence/i);
  assert.match(guidance, /one concrete decision in plain language/i);
  assert.match(guidance, /recommended option first/i);
  assert.match(guidance, /During explicit planning, Continuity owns plan presentation/i);
  assert.match(guidance, /internal execution task list only/i);
  assert.match(guidance, /put compact actionable anchors in planSummary/i);
  assert.doesNotMatch(guidance, /memory|durable/i);
  assert.deepEqual(continuity.parameters.properties.action.enum, ["clarify", "set_plan", "todo", "state"]);
  for (const field of ["key", "kind", "text", "source", "confidence", "scope", "evidencePaths"])
    assert.equal(continuity.parameters.properties[field], undefined);
  assert.equal(continuity.parameters.properties.todoIds.maxItems, 12);
  assert.equal(memory.label, "Memory");
  assert.equal(memory.executionMode, "sequential");
  assert.match(JSON.stringify(memory.parameters), /list.*add.*replace.*remove/);
  assert.match(memory.promptSnippet, /durable memory/i);
  assert.match(memoryGuidance, /one pre-final durable-memory assessment/i);
  assert.match(memoryGuidance, /if no candidate is valid, do nothing/i);
  assert.match(memoryGuidance, /memory list when an existing key is unknown or duplicate risk/i);
  assert.match(memoryGuidance, /named stable keys for commands and conventions/i);
  assert.match(memoryGuidance, /Never save .*secrets/i);
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

test("settlement waits for the single post-Verify final response", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-verify-response-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json",
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
    app.emit("pi-verify:result", { version: 1, cwd, state: "passed", runId: "passed", results: [] });
    await app.handlers.get("agent_settled")?.[0]?.({}, ctx);
    const completed = await tool.execute("complete", { action: "state", completion: true }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /^Work completed/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("TUI keeps routine updates hidden but shows memory and terminal outcomes", () => {
  const app = runtime();
  const tool = app.tools.get("continuity_update");
  const memory = app.tools.get("memory");
  const theme = { fg: (_color: string, text: string) => text };
  const render = (text: string, details?: any) => tool.renderResult(
    { content: [{ type: "text", text }], details },
    {},
    theme,
  ).render(80).map((line: string) => line.trimEnd()).join("\n");
  const renderMemory = (text: string, details?: any) => memory.renderResult(
    { content: [{ type: "text", text }], details },
    {},
    theme,
  ).render(80).map((line: string) => line.trimEnd()).join("\n");
  assert.equal(render("Continuity state updated."), "");
  assert.match(render("Work completed. No further continuity updates needed."), /Task completed/);
  assert.match(render("Continuity circuit breaker stopped 3 identical calls within 30 seconds."), /loop stopped/);
  assert.equal(
    render("Small", { clarification: { question: "Pick scope?", answer: "Small" } }),
    "? Pick scope?\nSmall",
  );
  assert.match(
    renderMemory("Memory candidate add queued: project/workflow.test.", {
      memoryCandidate: { action: "add", scope: "project", key: "workflow.test" },
    }),
    /Memory candidate add: project\/workflow\.test/,
  );
  assert.match(
    renderMemory("memory remove requires nonempty source/reason evidence", { memoryError: true }),
    /memory remove requires/i,
  );
  assert.match(
    renderMemory("Stored facts:\n- project/workflow.test: Run tests", { memoryList: true }),
    /project\/workflow\.test: Run tests/,
  );
});

test("memory list is owner-safe, settles candidates, and status uses durable facts", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-list-"));
  const firstCwd = join(root, "first"), secondCwd = join(root, "second");
  await mkdir(firstCwd); await mkdir(secondCwd);
  await exec("git", ["init", "-q", firstCwd]);
  await exec("git", ["init", "-q", secondCwd]);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const notifications: string[] = [];
  const context = (cwd: string, sessionId: string): any => ({
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
  });
  const first = context(firstCwd, "first"), second = context(secondCwd, "second");
  try {
    const app = runtime(), start = app.handlers.get("session_start")![0], settled = app.handlers.get("agent_settled")![0];
    await start({}, first);
    const tool = app.tools.get("memory");
    for (const params of [
      { action: "add", scope: "user", key: "preference.reply", text: "Use concise replies" },
      { action: "add", key: "workflow.first", text: "Run the first command" },
    ]) await tool.execute("candidate", params, undefined, undefined, first);
    await settled({}, first);

    await start({}, second);
    await tool.execute("foreign", {
      action: "add", key: "workflow.second", text: "Do not expose this project",
    }, undefined, undefined, second);
    await settled({}, second);

    await start({}, first);
    await tool.execute("pending", {
      action: "add", key: "workflow.pending", text: "Pending command",
    }, undefined, undefined, first);
    let listed = await tool.execute("list", { action: "list" }, undefined, undefined, first);
    assert.match(listed.content[0].text, /user\/preference\.reply \[unchecked: user memory\]: Use concise replies/);
    assert.match(listed.content[0].text, /project\/workflow\.first \[unchecked: no project provenance\]: Run the first command/);
    assert.match(listed.content[0].text, /project\/workflow\.pending \[add\]: Pending command/);
    assert.doesNotMatch(listed.content[0].text, /workflow\.second/);
    assert.equal(listed.details.memoryList, true);
    await settled({}, first);
    listed = await tool.execute("list-after-settle", { action: "list" }, undefined, undefined, first);
    assert.doesNotMatch(listed.content[0].text, /Pending candidates:/);

    await writeFile(join(firstCwd, "guide.txt"), "before\n");
    await tool.execute("evidence", {
      action: "add", key: "workflow.evidence", text: "Guide is current",
      source: "guide.txt", evidencePaths: ["guide.txt"],
    }, undefined, undefined, first);
    await settled({}, first);
    await writeFile(join(firstCwd, "guide.txt"), "after\n");
    await app.handlers.get("input")![0]({ source: "user", text: "guide is current" }, first);
    await app.handlers.get("before_agent_start")![0]({}, first);
    listed = await tool.execute("list-suspect", { action: "list" }, undefined, undefined, first);
    assert.match(listed.content[0].text, /project\/workflow\.evidence \[suspect: captured evidence changed or is unavailable\]: Guide is current/);
    await app.commands.get("memory").handler("status", first);
    assert.match(notifications.at(-1)!, /4 current-owner stored facts, 3 visible/);
    assert.match(notifications.at(-1)!, /0 current-owner pending candidates .*normally compacted at settlement/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
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
        planSummary: "Implement safely, then run checks",
        constraints: [" Keep API stable ", "  "],
        todos: ["Implement", "Verify"],
      }, undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /Executing task list stored/);
    assert.equal(result.details, undefined);
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Work: executing/);
    assert.match(context.messages.at(-1).content, /Current todo_1 \[in_progress\]: Implement/);
    assert.match(context.messages.at(-1).content, /Todo todo_2 \[pending\]: Verify/);

    const advanced = await app.tools.get("continuity_update").execute(
      "advance", {
        action: "todo",
        todoId: "todo_1",
        status: "done",
        nextTodoId: "todo_2",
      }, undefined, undefined, ctx,
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
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => "bulk-todos-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    const tool = app.tools.get("continuity_update");
    await tool.execute("plan", {
      action: "set_plan", goal: "Ship", todos: ["Inspect", "Implement", "Verify"],
    }, undefined, undefined, ctx);

    const snapshot = async () => (await app.handlers.get("context")?.[0]({ messages: [] }, ctx))
      .messages.at(-1).content;
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

    const completed = await tool.execute("bulk", {
      action: "todo", todoIds: ["todo_1", "todo_2"], status: "done", nextTodoId: "todo_3",
      latestFailure: "", nextAction: "Verify the result",
    }, undefined, undefined, ctx);
    assert.match(completed.content[0].text, /state updated/i);
    const after = await snapshot();
    assert.match(after, /Current todo_3 \[in_progress\]: Verify/);
    assert.match(after, /Done: 2/);
    assert.match(after, /Next: Verify the result/);

    // Existing callers retain the single todoId transition shape.
    const single = await tool.execute("single", {
      action: "todo", todoId: "todo_3", status: "done",
    }, undefined, undefined, ctx);
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
      editor: async () => customAnswer,
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
    assert.deepEqual(answered.details.clarification, {
      question: "Pick scope?", answer: "Small",
    });
    selection = "Full — Broader change";
    const secondAnswer = await tool.execute("second-answer", {
      ...params, question: "Pick deployment scope?",
    }, undefined, undefined, ctx);
    assert.equal(secondAnswer.content[0].text, "Full — Broader change");
    assert.deepEqual(secondAnswer.details.clarification, {
      question: "Pick deployment scope?", answer: "Full — Broader change",
    });

    selection = "Write a different answer…";
    customAnswer = "Only API changes";
    const custom = await tool.execute("custom-answer", {
      ...params, question: "Any constraints?",
    }, undefined, undefined, ctx);
    assert.equal(custom.content[0].text, "Only API changes");
    assert.deepEqual(custom.details.clarification, {
      question: "Any constraints?", answer: "Only API changes",
    });
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

test("bash requires Verify only when its Git worktree changes", async () => {
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
    cwd, hasUI: false, mode: "json",
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  });
  try {
    for (const [sessionId, mutate] of [["read-only", false], ["changed", true]] as const) {
      const app = runtime(), ctx = context(sessionId);
      for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
      const tool = app.tools.get("continuity_update");
      await tool.execute("plan", { action: "set_plan", goal: "Run command", todos: ["Finish"] }, undefined, undefined, ctx);
      for (const handler of app.handlers.get("tool_call") ?? [])
        await handler({ toolName: "bash", toolCallId: `bash-${sessionId}`, input: { command: "test" } }, ctx);
      if (mutate) await writeFile(join(cwd, "tracked.txt"), "changed\n");
      for (const handler of app.handlers.get("tool_result") ?? [])
        await handler({ toolName: "bash", toolCallId: `bash-${sessionId}`, input: { command: "test" }, content: [], details: {}, isError: false }, ctx);
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

test("subsequent plan inherits timeline lineage from a fresh executor session", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-lineage-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const previousRun = {
    version: 1,
    runId: "first-plan",
    role: "executor",
    parentSessionId: "planner-session",
    createdAt: new Date().toISOString(),
  };
  const entries = [{
    type: "custom",
    customType: "pylon-run",
    data: previousRun,
  }];
  const ctx: any = {
    cwd,
    hasUI: false,
    mode: "json",
    model: { provider: "provider", id: "executor" },
    sessionManager: {
      getSessionId: () => "fresh-executor-session",
      getEntries: () => entries,
    },
    isIdle: () => true,
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Plan another change", ctx);

    const nextRun = app.appended.find((entry) =>
      entry.customType === "pylon-run" && entry.data.role === "planner"
    )?.data;
    assert.ok(nextRun);
    assert.notEqual(nextRun.runId, previousRun.runId);
    assert.equal(nextRun.timelineId, previousRun.runId);
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
    await planningRun;
    await waitFor(() => childEntries.length > 0);
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
      "pylon-run",
      "pi-continuity-handoff",
    ]);
    const childRun = childEntries[2]!.value;
    const childWork = childEntries[3]!.value.work;
    assert.equal(childRun.timelineId, childRun.runId);
    assert.equal(childWork.timelineId, childRun.timelineId);
    assert.equal(
      kickoff,
      "Inspect the current workspace and validate the approved plan's assumptions before editing. Treat paths, symbols, and line ranges in the approved plan as the working set: check them with narrow reads, and call Scout only when repository state changed, anchors are missing, or an unresolved gap requires broader tracing. Execute the plan, track todos, and run fresh verification.",
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
    const renderWidget = (widget: any) => widget({}, {
      fg: (_color: string, text: string) => text,
      strikethrough: (text: string) => `~${text}~`,
    }).render(1_000).map((line: string) => line.trimEnd());
    await tool.execute("call", {
      action: "set_plan",
      goal: "First task",
      todos: ["Implement", "Verify"],
    }, undefined, undefined, ctx);
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● Implement", "○ Verify"]);

    await tool.execute("call", {
      action: "todo",
      todoId: "todo_1",
      nextTodoId: "todo_2",
      status: "done",
    }, undefined, undefined, ctx);
    assert.deepEqual(renderWidget(widgets.at(-1)), ["Tasks", "● ~Implement~", "● Verify"]);
    const shown = widgets.length;

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
    app.onSendUserMessage((message) => {
      if (!message.startsWith("Plan this task")) return;
      planningRun = (async () => {
        await Promise.resolve();
        assert.equal(selections, 0);
        for (const handler of app.handlers.get("agent_start") ?? []) await handler({}, ctx);
        const result = await app.tools.get("continuity_update").execute(
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
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);
    await planningRun;
    await waitFor(() => app.sent.length === 2);
    assert.equal(selections, 1);
    assert.equal(approvalTitle, "Plan ready — review structured plan above");
    assert.match(structuredPlan, /^Plan\n\nGoal\nShip change/);
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
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
    },
    sessionManager: {
      getSessionId: () => "replan-session",
      getEntries: () => [],
    },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => {
        selections++;
        return selections === 1
          ? "Request changes"
          : "Approve — continue current session";
      },
      editor: async () => "Keep the same steps but clarify wording",
    },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await app.commands.get("plan").handler("Ship change", ctx);

    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    assert.equal(selections, 0);

    const rejected = await app.tools.get("continuity_update").execute(
      "empty",
      { action: "set_plan", goal: "Ship change", todos: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rejected.content[0].text, /At least one non-empty todo/);

    await app.tools.get("continuity_update").execute(
      "final",
      { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    await waitFor(() => selections === 1);
    assert.ok(app.sent.some((message) => message.startsWith("Plan changes requested:")));

    await app.tools.get("continuity_update").execute(
      "revised",
      { action: "set_plan", goal: "Ship change", todos: ["Implement", "Verify"] },
      undefined,
      undefined,
      ctx,
    );
    for (const handler of app.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);
    await waitFor(() =>
      app.active().includes("edit") &&
      app.sent.includes("Execute approved stored plan in current session. Track and verify todos."),
    );

    assert.equal(selections, 2);
    assert.ok(app.active().includes("edit"));
    assert.ok(app.sent.includes("Execute approved stored plan in current session. Track and verify todos."));
    const context = await app.handlers.get("context")?.[0]({ messages: [] }, ctx);
    assert.match(context.messages.at(-1).content, /Plan anchor: Implement; Verify/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("plan mode permits memory list but blocks memory mutations", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-plan-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const ctx: any = {
    cwd, hasUI: false, mode: "json", isIdle: () => true,
    sessionManager: { getSessionId: () => "memory-plan-session", getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  };
  try {
    const app = runtime();
    for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
    await app.commands.get("plan").handler("Inspect memory", ctx);
    assert.ok(app.active().includes("memory"));
    const guard = app.handlers.get("tool_call")![0];
    assert.equal(await guard({ toolName: "memory", input: { action: "list" } }, ctx), undefined);
    assert.match((await guard({ toolName: "memory", input: { action: "add" } }, ctx)).reason, /Memory mutations are blocked.*list only/i);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("duplicate continuity instance does not register stale planning handlers", () => {
  const app = runtime();
  const starts = app.handlers.get("agent_start")?.length;
  const calls = app.handlers.get("tool_call")?.length;
  app.loadAgain();
  assert.equal(app.handlers.get("agent_start")?.length, starts);
  assert.equal(app.handlers.get("tool_call")?.length, calls);
});

test("memory candidates survive manual and turn-end compact into model context", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "continuity-extension-memory-"));
  const cwd = join(root, "repo"), agent = join(root, "agent"), notifications: string[] = [],
    legacy = join(agent, "pi-continuity", "memory-v3");
  await mkdir(cwd);
  await exec("git", ["init", "-q", cwd]);
  await exec("git", ["-C", cwd, "config", "user.email", "test@example.invalid"]);
  await exec("git", ["-C", cwd, "config", "user.name", "test"]);
  await writeFile(join(cwd, "README.md"), "project\n");
  await exec("git", ["-C", cwd, "add", "."]);
  await exec("git", ["-C", cwd, "commit", "-qm", "base"]);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "memory.json"), "legacy");
  process.env.PI_CODING_AGENT_DIR = agent;
  const ctx: any = {
    cwd, hasUI: true, mode: "json",
    sessionManager: { getSessionId: () => "memory-session" },
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => true,
      setStatus: () => {}, setWidget: () => {},
    },
  };
  try {
    const first = runtime();
    for (const handler of first.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    await first.commands.get("memory").handler("backups", ctx);
    assert.match(notifications.at(-1)!, /memory-v3\.reset-unsupported-/);
    const result = await first.tools.get("memory").execute(
      "call", {
        action: "add",
        key: "workflow.verify",
        kind: "workflow",
        text: "Run npm test before release",
        source: "project instructions",
        confidence: 1,
      }, undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /queued: project\/workflow\.verify/);
    await first.commands.get("memory").handler("compact", ctx);
    await first.tools.get("memory").execute(
      "call", {
        action: "add",
        key: "workflow.lint",
        kind: "workflow",
        text: "Run npm run check before release",
        source: "project instructions",
        confidence: 1,
      }, undefined, undefined, ctx,
    );
    for (const handler of first.handlers.get("agent_settled") ?? [])
      await handler({}, ctx);

    const second = runtime();
    for (const handler of second.handlers.get("session_start") ?? [])
      await handler({ reason: "startup" }, ctx);
    for (const handler of second.handlers.get("input") ?? [])
      await handler({ source: "user", text: "verify lint release check" }, ctx);
    assert.equal(
      await second.handlers.get("context")?.[0]({ messages: [] }, ctx),
      undefined,
    );
    const memory = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.match(memory.message.content, /Memory workflow\.verify: Run npm test before release/);
    assert.match(memory.message.content, /Memory workflow\.lint: Run npm run check before release/);
    await second.commands.get("memory").handler("off", ctx);
    assert.equal(await second.handlers.get("before_agent_start")?.[0]({}, ctx), undefined);
    await second.tools.get("memory").execute(
      "call", { action: "add", key: "workflow.toggle", text: "Verify lint release check remains stored" },
      undefined, undefined, ctx,
    );
    await second.commands.get("memory").handler("compact", ctx);
    assert.equal(await second.handlers.get("before_agent_start")?.[0]({}, ctx), undefined);
    await second.commands.get("memory").handler("on", ctx);
    const afterEnable = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.match(afterEnable.message.content, /workflow\.toggle/);

    await writeFile(join(cwd, "guide.txt"), "current\n");
    await second.tools.get("memory").execute(
      "call", {
        action: "add", key: "workflow.evidence",
        text: "Verify lint release check obsolete command text", source: "guide.txt",
        evidencePaths: ["guide.txt"],
      }, undefined, undefined, ctx,
    );
    await second.commands.get("memory").handler("compact", ctx);
    await writeFile(join(cwd, "guide.txt"), "changed\n");
    const suspectContext = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.match(suspectContext.message.content, /Memory workflow\.evidence \[suspect\]/);
    assert.doesNotMatch(suspectContext.message.content, /obsolete command text/);
    await second.commands.get("memory").handler("show", ctx);
    assert.match(notifications.at(-1)!, /workflow\.evidence \[suspect:/);
    await second.commands.get("memory").handler("forget suspect", ctx);
    assert.match(notifications.at(-1)!, /Forgot 1 suspect memory fact/);
    const afterSuspectCleanup = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.doesNotMatch(afterSuspectCleanup.message.content, /workflow\.evidence/);

    const rejectedRemove = await second.tools.get("memory").execute(
      "call", { action: "remove", key: "workflow.lint" },
      undefined, undefined, ctx,
    );
    assert.match(rejectedRemove.content[0].text, /source\/reason/);
    assert.equal(rejectedRemove.details.memoryError, true);
    await second.tools.get("memory").execute(
      "call", { action: "remove", key: "workflow.lint", source: "package.json no longer defines this command" },
      undefined, undefined, ctx,
    );
    await second.commands.get("memory").handler("compact", ctx);
    const afterModelCleanup = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.doesNotMatch(afterModelCleanup.message.content, /workflow\.lint/);

    await second.commands.get("memory").handler("forget workflow.verify", ctx);
    const afterForget = await second.handlers.get("before_agent_start")?.[0]({}, ctx);
    assert.doesNotMatch(afterForget.message.content, /workflow\.verify/);
    const gitDir = join(cwd, ".git"), unavailableGit = join(cwd, ".git-unavailable");
    await rename(gitDir, unavailableGit);
    try {
      const third = runtime();
      for (const handler of third.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
      for (const handler of third.handlers.get("input") ?? [])
        await handler({ source: "user", text: "verify lint release check" }, ctx);
      const unavailable = await third.handlers.get("before_agent_start")?.[0]({}, ctx);
      assert.match(unavailable.message.content, /workflow\.toggle \[unverifiable\]/);
    } finally { await rename(unavailableGit, gitDir); }
    await second.commands.get("memory").handler("owners", ctx);
    const owner = notifications.at(-1)!.split(/\s/)[0]!;
    assert.match(owner, /^[a-f0-9-]+$/);
    await second.commands.get("memory").handler(`forget owner ${owner}`, ctx);
    assert.equal(await second.handlers.get("before_agent_start")?.[0]({}, ctx), undefined);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

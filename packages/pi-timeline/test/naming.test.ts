import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-timeline.ts";

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

test("fresh Continuity executor kickoff triggers automatic session naming", async () => {
  const calls: any[] = [];
  const kickoff = "Inspect the current workspace and validate the approved plan's assumptions before editing. Execute the plan, track todos, and run fresh verification.";
  const entries = [
    { type: "model_change", id: "model-1", provider: "provider", modelId: "executor" },
    { type: "thinking_level_change", id: "thinking-1", thinkingLevel: "low" },
    { type: "custom", id: "run-1", customType: "pi-conductor-run", data: { version: 1 } },
    { type: "custom", id: "handoff-1", customType: "pi-continuity-handoff", data: { version: 1 } },
    { type: "message", id: "user-1", message: { role: "user", content: kickoff } },
    { type: "message", id: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "Validated plan assumptions." }] } },
  ];
  const { handlers, names, ctx } = namingHarness(entries, async (...args: any[]) => {
    calls.push(args);
    return { content: [{ type: "text", text: "Execute Approved Continuity Plan" }] };
  });

  await handlers.get("session_start")![0]({ reason: "new" }, ctx);
  await handlers.get("agent_settled")![0]({}, ctx);

  assert.deepEqual(names, ["Execute Approved Continuity Plan"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].messages[0].content[0].text, /Inspect the current workspace/);
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


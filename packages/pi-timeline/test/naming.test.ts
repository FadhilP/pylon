import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-timeline.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-timeline-naming-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

function namingHarness(
  entries: any[],
  completeTitle: any = async () => ({ content: [{ type: "text", text: "Semantic Timeline Session" }] }),
  configPath?: string,
) {
  const handlers = new Map<string, Function[]>(),
    names: string[] = [],
    telemetry: any[] = [];
  const pi: any = {
    events: {
      on: () => () => {},
      emit: (channel: string, value: unknown) => {
        if (channel === "pylon:telemetry") telemetry.push(value);
      },
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand() {},
    setSessionName: (name: string) => names.push(name),
  };
  const artifactRoot = join(tmpdir(), `pi-timeline-naming-${randomUUID()}`);
  extension(pi, completeTitle, { artifactRoot, configPath });
  const ctx: any = {
    cwd: join(tmpdir(), "pi-timeline-naming-test"),
    hasUI: false,
    model: { provider: "test", id: "title-model" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
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
  return { handlers, names, telemetry, ctx, artifactRoot };
}

async function settleTurn(handlers: Map<string, Function[]>, ctx: any) {
  await handlers.get("agent_settled")![0]({}, ctx);
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("same-session start keeps one continuous artifact lease", async () => {
  const { handlers, ctx, artifactRoot } = namingHarness([]);
  try {
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const initial = await readdir(join(artifactRoot, "session-artifacts"));
    await handlers.get("session_start")![0]({ reason: "reload" }, ctx);
    assert.deepEqual(await readdir(join(artifactRoot, "session-artifacts")), initial);
    await handlers.get("session_shutdown")![0]({}, ctx);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("settled unnamed session launches a background semantic title call", async () => {
  const calls: any[] = [],
    entries = [
      { type: "message", id: "user-1", message: { role: "user", content: "Can we add session name to the TUI?" } },
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: [{ type: "text", text: "Implemented session naming." }] },
      },
    ];
  const { handlers, names, telemetry, ctx } = namingHarness(entries, async (...args: any[]) => {
    calls.push(args);
    return {
      content: [{ type: "text", text: "Persistent TUI Session Names" }],
      usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, cost: { total: 0.002 } },
    };
  });
  await handlers.get("session_start")![0]({}, ctx);
  await settleTurn(handlers, ctx);

  assert.deepEqual(names, ["Persistent TUI Session Names"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].messages[0].content[0].text, /Can we add session name/);
  assert.match(calls[0][1].messages[0].content[0].text, /Implemented session naming/);
  assert.equal(calls[0][2].maxTokens, 32);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].version, 2);
  assert.equal(telemetry[0].provider, "test");
  assert.equal(telemetry[0].model, "title-model");
  assert.deepEqual(telemetry[0].usage, { turns: 1, input: 12, output: 3, cacheRead: 4, cacheWrite: 0, cost: 0.002 });
  assert.equal(telemetry[0].context.request.characters, 35);
  assert.equal(telemetry[0].context.result.characters, 27);
  assert.match(telemetry[0].context.request.hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(telemetry[0]).includes("Can we add session name"), false);
  assert.equal(handlers.has("before_agent_start"), false);
  assert.equal(handlers.has("message_end"), false);
});

test("session-start title settings are used by title calls", async () => {
  const path = join(isolatedAgentDir, `title-settings-${randomUUID()}.json`);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      editRollbackDefault: false,
      titleTimeoutMs: 12_345,
      titleMaxTokens: 77,
      titleChangedFiles: 40,
      gitTimeoutMs: 200_000,
    }),
  );
  const entries = [{ type: "message", id: "user-1", message: { role: "user", content: "Name this session" } }];
  let options: any;
  const { handlers, ctx, names } = namingHarness(
    entries,
    async (_model: any, _prompt: any, value: any) => {
      options = value;
      return { content: [{ type: "text", text: "Configured Session Title" }] };
    },
    path,
  );
  await handlers.get("session_start")![0]({}, ctx);
  await settleTurn(handlers, ctx);
  assert.deepEqual(names, ["Configured Session Title"]);
  assert.equal(options.timeoutMs, 12_345);
  assert.equal(options.maxTokens, 77);
});

test("explicit checkpoint title model also names the session", async () => {
  const path = join(isolatedAgentDir, `title-model-${randomUUID()}.json`);
  await writeFile(
    path,
    JSON.stringify({ version: 1, editRollbackDefault: false, checkpointTitleModel: "cheap/provider-model" }),
  );
  const calls: any[] = [];
  const entries = [
    { type: "message", id: "user-1", message: { role: "user", content: "Use one naming model everywhere" } },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", content: "Configured shared Timeline naming." },
    },
  ];
  const { handlers, names, ctx } = namingHarness(
    entries,
    async (model: any) => {
      calls.push(model);
      return { content: [{ type: "text", text: "Shared Timeline Naming Model" }] };
    },
    path,
  );

  await handlers.get("session_start")![0]({}, ctx);
  await settleTurn(handlers, ctx);

  assert.deepEqual(calls, [{ provider: "cheap", id: "provider-model" }]);
  assert.deepEqual(names, ["Shared Timeline Naming Model"]);
});

test("fresh Continuity executor kickoff triggers automatic session naming", async () => {
  const calls: any[] = [];
  const kickoff =
    "Inspect the current workspace and validate the approved plan's assumptions before editing. Execute the plan, track todos, and run fresh verification.";
  const entries = [
    { type: "model_change", id: "model-1", provider: "provider", modelId: "executor" },
    { type: "thinking_level_change", id: "thinking-1", thinkingLevel: "low" },
    { type: "custom", id: "run-1", customType: "pylon-run", data: { version: 1 } },
    { type: "custom", id: "handoff-1", customType: "pi-continuity-handoff", data: { version: 1 } },
    { type: "message", id: "user-1", message: { role: "user", content: kickoff } },
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", content: [{ type: "text", text: "Validated plan assumptions." }] },
    },
  ];
  const { handlers, names, ctx } = namingHarness(entries, async (...args: any[]) => {
    calls.push(args);
    return { content: [{ type: "text", text: "Execute Approved Continuity Plan" }] };
  });

  await handlers.get("session_start")![0]({ reason: "new" }, ctx);
  await settleTurn(handlers, ctx);

  assert.deepEqual(names, ["Execute Approved Continuity Plan"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].messages[0].content[0].text, /Inspect the current workspace/);
});

test("invalid or failed title generation falls back to first prompt", async () => {
  for (const completeTitle of [
    async () => ({ content: [{ type: "text", text: "Too short" }] }),
    async () => {
      throw new Error("unavailable");
    },
  ]) {
    const entries = [
      { type: "message", id: "user-1", message: { role: "user", content: "  Add session naming\nwithout noise  " } },
    ];
    const { handlers, names, ctx } = namingHarness(entries, completeTitle);
    await handlers.get("session_start")![0]({}, ctx);
    await settleTurn(handlers, ctx);
    assert.deepEqual(names, ["Add session naming without noise"]);
  }
});

test("pending title call is single-flight and manual rename wins", async () => {
  let calls = 0,
    finish!: (value: any) => void,
    markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const entries = [{ type: "message", id: "user-1", message: { role: "user", content: "First prompt for naming" } }];
  const { handlers, names, ctx } = namingHarness(entries, async () => {
    calls++;
    markStarted();
    return pending;
  });
  await handlers.get("session_start")![0]({}, ctx);
  const settling = handlers.get("agent_settled")![0]({}, ctx);
  await started;
  assert.equal(
    await Promise.race([
      settling.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
    ]),
    true,
  );
  await handlers.get("agent_settled")![0]({}, ctx);
  assert.equal(calls, 1);
  await handlers.get("session_info_changed")![0]({ name: "Manual title" }, ctx);
  finish({ content: [{ type: "text", text: "Generated Session Title" }] });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(names, []);
});

test("pending title from an old session cannot rename a new session", async () => {
  let finish!: (value: any) => void, markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const entries = [
    { type: "message", id: "user-1", message: { role: "user", content: "Name the old session safely" } },
  ];
  const { handlers, names, ctx } = namingHarness(entries, async () => {
    markStarted();
    return pending;
  });
  await handlers.get("session_start")![0]({}, ctx);
  await handlers.get("agent_settled")![0]({}, ctx);
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
  await new Promise<void>(resolve => setImmediate(resolve));
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
    await settleTurn(handlers, ctx);
    assert.deepEqual(names, []);
    assert.equal(calls, 0);
  }
});

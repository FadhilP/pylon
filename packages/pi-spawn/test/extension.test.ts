import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import spawnExtension from "../extensions/pi-spawn.ts";
import { configPath, saveConfig, type SpawnConfig } from "../src/config.ts";
import {
  RECENT_THREAD_MAX_TOTAL_CHARS,
  SESSION_MARKER,
  privateAgentDir,
} from "../src/sessions.ts";
import type { SpawnRun } from "../src/runner.ts";

const completed = (text: string): SpawnRun => ({
  text,
  model: "fake/model",
  thinking: "high",
  stopReason: "stop",
  stderr: "",
  durationMs: 5,
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1 },
  sessionUsage: {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    cost: 1,
  },
  turns: 1,
  truncated: false,
  activity: [],
});

function persistSession(manager: SessionManager) {
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake",
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

function persist(parent: SessionManager, toolName: string, result: any) {
  parent.appendMessage({
    role: "toolResult",
    toolCallId: `${toolName}-${Date.now()}`,
    toolName,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  });
}

async function fixture(
  runOverride?: (args: string[], options: any) => Promise<SpawnRun>,
  availability?: Omit<SpawnConfig, "version">,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-spawn-extension-"));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  if (availability)
    await saveConfig({ version: 1, ...availability }, configPath(agentDir));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parent = SessionManager.create(cwd);
  persistSession(parent);
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const emitted: Array<{ name: string; value: any }> = [];
  const busHandlers = new Map<string, Function[]>();
  const calls: Array<{
    args: string[];
    cwd: string;
    prompt: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const sentMessages: any[] = [];
  const pi: any = {
    events: {
      emit: (name: string, value: any) => {
        emitted.push({ name, value });
        for (const handler of busHandlers.get(name) ?? []) handler(value);
      },
      on: (name: string, handler: Function) => {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
        return () =>
          busHandlers.set(
            name,
            (busHandlers.get(name) ?? []).filter((item) => item !== handler),
          );
      },
    },
    on: (name: string, handler: Function) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendMessage: (message: any) => sentMessages.push(message),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  const run: any = async (args: string[], options: any) => {
    calls.push({
      args,
      cwd: options.cwd,
      prompt: options.prompt,
      env: options.env,
    });
    if (runOverride) return runOverride(args, options);
    const result = completed(`reply:${options.prompt}`);
    options.onState?.({ model: result.model, thinking: result.thinking });
    options.onUsage?.(result.usage);
    return result;
  };
  await spawnExtension(pi, run, agentDir);
  const models = [
    { provider: "fake", id: "model" },
    { provider: "custom", id: "model" },
    { provider: "blocked", id: "model" },
  ];
  const configuredModels = new Set(["fake/model", "custom/model"]);
  const ctx: any = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      hasConfiguredAuth: (model: any) =>
        configuredModels.has(`${model.provider}/${model.id}`),
    },
    scopedModels: [],
    thinkingLevel: "high",
    sessionManager: parent,
  };
  return {
    root,
    cwd,
    agentDir,
    parent,
    tools,
    handlers,
    busHandlers,
    emitted,
    calls,
    sentMessages,
    ctx,
    models,
    configuredModels,
    restore: () => {
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}

test("configured model and thinking allowlists constrain new children and defaults", async () => {
  const f = await fixture(undefined, {
    agentAvailability: "deferred",
    sessionAvailability: "deferred",
    models: ["custom/model"],
    agentThinkingLevels: ["low"],
  });
  try {
    for (const handler of f.handlers.get("session_start") ?? [])
      await handler({}, f.ctx);
    assert.deepEqual(
      f.tools.get("spawn_agent").parameters.properties.model.enum,
      ["custom/model"],
    );
    assert.deepEqual(
      f.tools.get("spawn_session").parameters.properties.model.enum,
      ["custom/model"],
    );
    assert.deepEqual(
      f.tools.get("spawn_agent").parameters.properties.thinking.enum,
      ["low"],
    );

    await f.tools
      .get("spawn_agent")
      .execute(
        "create",
        { action: "create", prompt: "eligible agent" },
        undefined,
        undefined,
        f.ctx,
      );
    assert.equal(
      f.calls[0].args[f.calls[0].args.indexOf("--model") + 1],
      "custom/model",
    );
    assert.equal(
      f.calls[0].args[f.calls[0].args.indexOf("--thinking") + 1],
      "low",
    );

    const modelRejected = await f.tools.get("spawn_session").execute(
      "create",
      {
        action: "create",
        prompt: "blocked model",
        model: "fake/model",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(modelRejected.details.failureCode, "model_unavailable");
    const thinkingRejected = await f.tools.get("spawn_agent").execute(
      "create",
      {
        action: "create",
        prompt: "blocked thinking",
        thinking: "high",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(thinkingRejected.details.failureCode, "invalid");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("explicit models are revalidated before a child is created", async () => {
  const f = await fixture();
  try {
    for (const handler of f.handlers.get("session_start") ?? [])
      await handler({}, f.ctx);
    assert.deepEqual(
      f.tools.get("spawn_agent").parameters.properties.model.enum,
      ["fake/model", "custom/model"],
    );
    f.configuredModels.delete("custom/model");

    for (const name of ["spawn_agent", "spawn_session"]) {
      const rejected = await f.tools.get(name).execute(
        "create",
        {
          action: "create",
          prompt: "do not start",
          model: "custom/model",
        },
        undefined,
        undefined,
        f.ctx,
      );
      assert.equal(rejected.details.failureCode, "model_unavailable");
      assert.match(rejected.content[0].text, /Available models: fake\/model/);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("explicit models honor scope changes after schema registration", async () => {
  const f = await fixture();
  try {
    for (const handler of f.handlers.get("session_start") ?? [])
      await handler({}, f.ctx);
    assert.deepEqual(
      f.tools.get("spawn_session").parameters.properties.model.enum,
      ["fake/model", "custom/model"],
    );
    f.ctx.scopedModels = [{ model: f.models[0] }];

    for (const name of ["spawn_agent", "spawn_session"]) {
      const rejected = await f.tools.get(name).execute(
        "create",
        {
          action: "create",
          prompt: "out of scope",
          model: "custom/model",
        },
        undefined,
        undefined,
        f.ctx,
      );
      assert.equal(rejected.details.failureCode, "model_unavailable");
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("running spawn updates expose the selected model", async () => {
  const f = await fixture();
  try {
    for (const name of ["spawn_agent", "spawn_session"]) {
      const updates: any[] = [];
      const result = await f.tools.get(name).execute(
        "create",
        {
          action: "create",
          prompt: "report model",
        },
        undefined,
        (update: any) => updates.push(update),
        f.ctx,
      );
      assert.equal(updates[0]?.details.state, "running");
      assert.equal(updates[0]?.details.model, "fake/model");
      assert.equal(
        updates.find((update) =>
          update.content?.[0]?.text.endsWith("runtime ready"),
        )?.details.thinking,
        "high",
      );
      assert.deepEqual(
        updates.find((update) => update.details?.usage)?.details.usage,
        {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          cost: 0.1,
        },
      );
      assert.equal(result.details.thinking, "high");
      assert.deepEqual(result.details.sessionUsage, {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: 1,
      });
      assert.deepEqual(result.usage, {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      });
    }
  } finally {
    f.restore();
  }
});

test("synchronous mode remains the default and waits for completion", async () => {
  let release!: () => void;
  const f = await fixture(
    () =>
      new Promise<SpawnRun>((resolve) => {
        release = () => resolve(completed("waited"));
      }),
  );
  try {
    let settled = false;
    const pending = f.tools
      .get("spawn_agent")
      .execute(
        "create",
        {
          action: "create",
          prompt: "wait by default",
        },
        undefined,
        undefined,
        f.ctx,
      )
      .then((result: any) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    const result = await pending;
    assert.equal(result.details.status, "completed");
    assert.match(result.content[0].text, /waited/);
  } finally {
    f.restore();
  }
});

test("background agent runs stream correlated progress, report status, and preserve thread locking", async () => {
  let release!: () => void;
  let childOptions: any;
  const f = await fixture(
    (_args, options) =>
      new Promise<SpawnRun>((resolve) => {
        childOptions = options;
        release = () => resolve(completed(`done:${options.prompt}`));
      }),
  );
  try {
    const tool = f.tools.get("spawn_agent");
    const started = await tool.execute(
      "spawn-call",
      {
        action: "create",
        prompt: "work independently",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(started.details.status, "running");
    assert.equal(started.details.background, true);
    const id = started.details.piSpawn.id;
    const runId = started.details.runId;
    persist(f.parent, "spawn_agent", started);

    const activity = { id: "read-1", kind: "call", tool: "read", text: "{}" };
    childOptions.onActivity(activity, [activity]);
    childOptions.onText("Partial reply");
    childOptions.onUsage({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.1,
    });
    const progress = f.emitted
      .filter((event) => event.name === "pylon:spawn-progress")
      .map((event) => event.value);
    assert.ok(progress.length >= 4);
    assert.ok(
      progress.every(
        (event) =>
          event.parentSessionId === f.parent.getSessionId() &&
          event.toolCallId === "spawn-call" &&
          event.id === id &&
          event.runId === runId &&
          event.phase === "update",
      ),
    );
    assert.equal(
      progress.find((event) => event.result.details?.partialResponse)?.result
        .details.partialResponse,
      "Partial reply",
    );
    assert.equal(
      progress.find((event) => event.result.details?.activityDelta)?.result
        .details.activityDelta[0].id,
      "read-1",
    );

    const running = await tool.execute(
      "status",
      { action: "status", id, runId },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(running.details.status, "running");
    const busy = await tool.execute(
      "continue",
      {
        action: "continue",
        id,
        prompt: "overlap",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(busy.details.failureCode, "busy");

    const context = (f.handlers.get("context") ?? [])[0]?.({ messages: [] });
    assert.match(context.messages.at(-1).content, new RegExp(runId));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const terminal = [...f.emitted]
      .reverse()
      .find((event) => event.name === "pylon:spawn-progress")?.value;
    assert.equal(terminal.phase, "end");
    assert.equal(terminal.result.details.status, "completed");
    const completedRun = await tool.execute(
      "status",
      { action: "status", id, runId },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(completedRun.details.status, "completed");
    assert.match(completedRun.content[0].text, /done:work independently/);
    const consumed = await tool.execute(
      "status",
      { action: "status", id, runId },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(consumed.details.failureCode, "not_found");
  } finally {
    f.restore();
  }
});

test("a completed background result can only be collected once concurrently", async () => {
  const f = await fixture(async () => completed("once"));
  try {
    const tool = f.tools.get("spawn_agent");
    const started = await tool.execute(
      "create",
      {
        action: "create",
        prompt: "one result",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    const id = started.details.piSpawn.id;
    const runId = started.details.runId;
    persist(f.parent, "spawn_agent", started);
    await new Promise((resolve) => setImmediate(resolve));
    const results = await Promise.all([
      tool.execute(
        "cancel-1",
        { action: "cancel", id, runId },
        undefined,
        undefined,
        f.ctx,
      ),
      tool.execute(
        "cancel-2",
        { action: "cancel", id, runId },
        undefined,
        undefined,
        f.ctx,
      ),
    ]);
    assert.equal(
      results.filter((result: any) => result.details.status === "completed")
        .length,
      1,
    );
    assert.equal(
      results.filter(
        (result: any) => result.details.failureCode === "not_found",
      ).length,
      1,
    );
  } finally {
    f.restore();
  }
});

test("session shutdown aborts and awaits background runs", async () => {
  let aborted = false;
  const f = await fixture(
    async (_args, options) =>
      new Promise<SpawnRun>((resolve) => {
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve({
              ...completed("shutdown"),
              error: "Spawned thread turn was aborted.",
            });
          },
          { once: true },
        );
      }),
  );
  try {
    const started = await f.tools.get("spawn_session").execute(
      "create",
      {
        action: "create",
        prompt: "shutdown",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(started.details.status, "running");
    for (const handler of f.handlers.get("session_shutdown") ?? [])
      await handler({}, f.ctx);
    assert.equal(aborted, true);
    const rejected = await f.tools.get("spawn_session").execute(
      "create-again",
      {
        action: "create",
        prompt: "too late",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(rejected.details.failureCode, "shutting_down");
  } finally {
    f.restore();
  }
});

test("background session cancellation aborts the run and background UI fails closed", async () => {
  let uiResponse: any;
  const f = await fixture(async (_args, options) => {
    uiResponse = await options.onUiRequest(
      { id: "confirm", method: "confirm", title: "Guard", message: "Allow?" },
      new AbortController().signal,
    );
    return await new Promise<SpawnRun>((resolve) => {
      options.signal.addEventListener(
        "abort",
        () =>
          resolve({
            ...completed("cancelled"),
            error: "Spawned thread turn was aborted.",
          }),
        { once: true },
      );
    });
  });
  try {
    f.ctx.hasUI = true;
    f.ctx.ui = { confirm: async () => true };
    const tool = f.tools.get("spawn_session");
    const started = await tool.execute(
      "create",
      {
        action: "create",
        prompt: "cancel me",
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    const id = started.details.piSpawn.id;
    const runId = started.details.runId;
    persist(f.parent, "spawn_session", started);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(uiResponse, { confirmed: false });
    const cancelled = await tool.execute(
      "cancel",
      { action: "cancel", id, runId },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(cancelled.details.status, "cancelled");
  } finally {
    f.restore();
  }
});

test("spawn activity progress sends correlated deltas and returns the complete invocation", async () => {
  const f = await fixture(async (_args, options) => {
    const activity: any[] = [];
    for (let index = 0; index < 125; index++) {
      for (const kind of ["call", "result"] as const) {
        const item = {
          id: `call-${index}`,
          kind,
          tool: "read",
          text: String(index),
          ...(kind === "call"
            ? { startedAt: "2026-01-01T00:00:00.000Z" }
            : { durationMs: index * 10 }),
        };
        activity.push(item);
        options.onActivity?.(item, activity);
      }
    }
    return { ...completed("done"), activity };
  });
  try {
    const updates: any[] = [];
    const result = await f.tools.get("spawn_agent").execute(
      "create",
      {
        action: "create",
        prompt: "many tools",
      },
      undefined,
      (update: any) => updates.push(update),
      f.ctx,
    );
    const activityUpdates = updates.filter(
      (update) => update.details?.activityDelta,
    );
    assert.equal(activityUpdates.length, 250);
    assert.ok(
      activityUpdates.every(
        (update) =>
          update.details.activity === undefined &&
          update.details.activityDelta.length === 1,
      ),
    );
    assert.equal(result.details.activity.length, 250);
    assert.equal(result.details.activity[0].id, "call-0");
    assert.equal(result.details.activity.at(-1).id, "call-124");
    assert.equal(
      result.details.activity[0].startedAt,
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(result.details.activity.at(-1).durationMs, 1_240);
  } finally {
    f.restore();
  }
});

test("spawned RPC dialogs use the invoking parent UI and identify their origin", async () => {
  const dialogs: any[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async (_args, options) => {
    const controller = new AbortController();
    assert.deepEqual(
      await options.onUiRequest(
        {
          id: "select-1",
          method: "select",
          title: "Scope?",
          options: ["Small", "Large"],
          timeout: 5000,
        },
        controller.signal,
      ),
      { value: "Small" },
    );
    assert.deepEqual(
      await options.onUiRequest(
        {
          id: "confirm-1",
          method: "confirm",
          title: "Guard",
          message: "Allow command?",
        },
        controller.signal,
      ),
      { confirmed: true },
    );
    assert.deepEqual(
      await options.onUiRequest(
        {
          id: "input-1",
          method: "input",
          title: "Custom answer",
          placeholder: "Type here",
        },
        controller.signal,
      ),
      { value: "Other" },
    );
    assert.deepEqual(
      await options.onUiRequest(
        {
          id: "editor-1",
          method: "editor",
          title: "Edit",
          prefill: "draft",
        },
        controller.signal,
      ),
      { cancelled: true },
    );
    return completed("done");
  });
  try {
    f.ctx.hasUI = true;
    f.ctx.ui = {
      select: async (title: string, options: string[], dialogOptions: any) => {
        dialogs.push({ method: "select", title, options, dialogOptions });
        return "Small";
      },
      confirm: async (title: string, message: string, dialogOptions: any) => {
        dialogs.push({ method: "confirm", title, message, dialogOptions });
        return true;
      },
      input: async (title: string, placeholder: string, dialogOptions: any) => {
        dialogs.push({ method: "input", title, placeholder, dialogOptions });
        return "Other";
      },
    };
    const result = await f.tools.get("spawn_session").execute(
      "create",
      {
        action: "create",
        prompt: "ask the user",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(result.details.status, "completed");
    assert.deepEqual(
      dialogs.map(({ method }) => method),
      ["select", "confirm", "input"],
    );
    assert.ok(
      dialogs.every(({ title }) => /^Session [A-Za-z-]+: /.test(title)),
    );
    assert.deepEqual(dialogs[0].options, ["Small", "Large"]);
    assert.equal(dialogs[0].dialogOptions.timeout, 5000);
    assert.ok(
      dialogs.every(
        ({ dialogOptions }) => dialogOptions.signal instanceof AbortSignal,
      ),
    );
  } finally {
    f.restore();
  }
});

test("spawned RPC dialogs cancel when the invoking parent has no UI", async () => {
  const f = await fixture(async (_args, options) => {
    assert.deepEqual(
      await options.onUiRequest(
        {
          id: "confirm-1",
          method: "confirm",
          title: "Guard",
          message: "Allow command?",
        },
        new AbortController().signal,
      ),
      { confirmed: false },
    );
    return completed("done");
  });
  try {
    f.ctx.hasUI = false;
    const result = await f.tools.get("spawn_agent").execute(
      "create",
      {
        action: "create",
        prompt: "ask the user",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(result.details.status, "completed");
  } finally {
    f.restore();
  }
});

test("private agents stay outside the normal session index and preserve creation policy", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const created = await tool.execute(
      "create",
      {
        action: "create",
        prompt: "inspect auth",
        name: "Auth agent",
        systemPrompt: "private system",
        tools: [],
        disableSpecialists: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    const id = created.details.piSpawn.id;
    assert.match(created.content[0].text, /reply:inspect auth/);
    assert.match(created.details.agentName, /^[A-Za-z-]+$/);
    assert.doesNotMatch(created.details.agentName, /^(Agent|Thread)-/);
    assert.ok(
      !(await SessionManager.list(f.cwd)).some((session) => session.id === id),
    );
    assert.ok(
      (
        await SessionManager.list(
          f.cwd,
          privateAgentDir(f.parent.getSessionId(), f.agentDir),
        )
      ).some((session) => session.id === id),
    );
    assert.deepEqual(f.calls[0].args.slice(0, 4), [
      "--mode",
      "rpc",
      "--session",
      f.calls[0].args[3],
    ]);
    assert.ok(f.calls[0].args.includes("--system-prompt"));
    assert.ok(f.calls[0].args.includes("private system"));
    assert.ok(f.calls[0].args.includes("--no-tools"));
    assert.match(
      f.calls[0].args[f.calls[0].args.indexOf("--exclude-tools") + 1],
      /advisor/,
    );
    assert.match(
      f.calls[0].args[f.calls[0].args.indexOf("--exclude-tools") + 1],
      /spawn_session/,
    );

    persist(f.parent, "spawn_agent", created);
    const continued = await tool.execute(
      "continue",
      { action: "continue", id, prompt: "go deeper" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(continued.content[0].text, /reply:go deeper/);
    assert.equal(continued.details.agentName, created.details.agentName);
    assert.ok(f.calls[1].args.includes("private system"));
    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(listed.content[0].text, new RegExp(id));

    const invalid = await tool.execute(
      "invalid",
      { action: "continue", id, prompt: "x", systemPrompt: "changed" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(invalid.details.failureCode, "invalid");
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test("private agent recent inspects the authorized transcript without prompting the child", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const created = await tool.execute(
      "create",
      { action: "create", prompt: "inspect auth" },
      undefined,
      undefined,
      f.ctx,
    );
    const id = created.details.piSpawn.id;
    persist(f.parent, "spawn_agent", created);
    const child = SessionManager.open(created.details.piSpawn.path);
    child.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "review the token" },
        { type: "image", data: "ignored", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    } as any);
    child.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "secret.txt" },
        },
        { type: "text", text: "x".repeat(200) },
      ],
      api: "fake",
      provider: "fake",
      model: "fake",
      usage: {},
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);

    const recent = await tool.execute(
      "recent",
      { action: "recent", id, limit: 2, maxChars: 80 },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(recent.details.action, "recent");
    assert.equal(recent.details.returned, 2);
    assert.equal(recent.details.available, 2);
    assert.equal(recent.details.truncated, true);
    assert.match(
      recent.content[0].text,
      /\[user\][\s\S]*review the token[\s\S]*\[image\]/,
    );
    assert.match(
      recent.content[0].text,
      /\[assistant\][\s\S]*tool calls: read/,
    );
    assert.doesNotMatch(
      recent.content[0].text,
      /private reasoning|secret\.txt/,
    );

    for (let index = 0; index < 20; index++)
      child.appendMessage({
        role: "user",
        content: `${index}:${"y".repeat(2_000)}`,
        timestamp: Date.now(),
      } as any);
    const bounded = await tool.execute(
      "bounded-recent",
      { action: "recent", id, limit: 50, maxChars: 2_000 },
      undefined,
      undefined,
      f.ctx,
    );
    assert.ok(bounded.content[0].text.length <= RECENT_THREAD_MAX_TOTAL_CHARS);
    assert.equal(bounded.details.truncated, true);

    const invalid = await tool.execute(
      "invalid-recent",
      { action: "recent", id, prompt: "do work" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(invalid.details.failureCode, "invalid");
    const outOfRange = await tool.execute(
      "invalid-limit",
      { action: "recent", id, limit: 51 },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(outOfRange.details.failureCode, "invalid");

    const otherParent = SessionManager.create(f.cwd);
    const unavailable = await tool.execute(
      "foreign-recent",
      { action: "recent", id },
      undefined,
      undefined,
      { ...f.ctx, sessionManager: otherParent },
    );
    assert.equal(unavailable.details.failureCode, "not_found");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("spawned sessions use standard storage and preserve their chosen model", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const created = await tool.execute(
      "create",
      { action: "create", prompt: "new thread", name: "Visible thread" },
      undefined,
      undefined,
      f.ctx,
    );
    const id = created.details.piSpawn.id;
    const listedNative = await SessionManager.list(f.cwd);
    const info = listedNative.find((session) => session.id === id);
    assert.ok(info);
    assert.equal(info.name, "Visible thread");
    assert.equal(info.parentSessionPath, f.parent.getSessionFile());
    assert.deepEqual(f.calls[0].args, [
      "--mode",
      "rpc",
      "--session",
      info.path,
      "--model",
      "fake/model",
    ]);
    assert.equal(f.calls[0].env.PI_SPAWN_CHILD, "session");

    persist(f.parent, "spawn_session", created);
    const continued = await tool.execute(
      "continue",
      { action: "continue", id, prompt: "second turn" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(continued.content[0].text, /reply:second turn/);
    assert.deepEqual(f.calls[1].args, [
      "--mode",
      "rpc",
      "--session",
      info.path,
      "--model",
      "fake/model",
    ]);
    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(listed.content[0].text, new RegExp(id));
  } finally {
    f.restore();
  }
});

test("spawned sessions snapshot Pylon hooks and apply before-agent-start context", async () => {
  const f = await fixture();
  const previousChild = process.env.PI_SPAWN_CHILD;
  try {
    f.busHandlers.set("pylon:spawn-hooks-request", [
      (request: any) =>
        request.provide({
          sessionStart: {
            customType: "pylon-session-start-hook",
            content: "SESSION HOOK",
          },
          sessionCompact: {
            customType: "pylon-session-start-hook",
            content: "COMPACTION HOOK",
          },
          beforeAgentStart: "BEFORE HOOK",
        }),
    ]);
    const created = await f.tools.get("spawn_session").execute(
      "create",
      {
        action: "create",
        prompt: "hooked child",
        name: "Hooked child",
        model: "custom/model",
      },
      undefined,
      undefined,
      f.ctx,
    );
    const child = (await SessionManager.list(f.cwd)).find(
      (session) => session.id === created.details.piSpawn.id,
    )!;
    assert.deepEqual(f.calls[0].args, [
      "--mode",
      "rpc",
      "--session",
      child.path,
      "--model",
      "custom/model",
    ]);
    const manager = SessionManager.open(child.path);
    assert.equal(
      manager.getEntries().filter((entry) => entry.type === "custom_message")
        .length,
      0,
    );

    process.env.PI_SPAWN_CHILD = "session";
    const childContext = { sessionManager: manager };
    (f.handlers.get("session_start") ?? [])[0]?.({}, childContext);
    assert.deepEqual(f.sentMessages, [
      {
        customType: "pylon-session-start-hook",
        content: "SESSION HOOK",
        display: false,
      },
    ]);
    const compact = (f.handlers.get("session_compact") ?? [])[0];
    assert.ok(compact);
    compact({ compactionEntry: { id: "compact-1" } }, childContext);
    assert.deepEqual(f.sentMessages.at(-1), {
      customType: "pylon-session-start-hook",
      content: "COMPACTION HOOK",
      display: false,
      details: { version: 1, compactionEntryId: "compact-1" },
    });
    manager.appendCustomMessageEntry(
      "pylon-session-start-hook",
      "COMPACTION HOOK",
      false,
      { version: 1, compactionEntryId: "compact-1" },
    );
    compact({ compactionEntry: { id: "compact-1" } }, childContext);
    assert.equal(f.sentMessages.length, 2);
    const before = (f.handlers.get("before_agent_start") ?? [])[0];
    assert.ok(before);
    assert.equal(
      before({ systemPrompt: "BASE" }, childContext).systemPrompt,
      "BASE\n\nBEFORE HOOK",
    );
  } finally {
    if (previousChild === undefined) delete process.env.PI_SPAWN_CHILD;
    else process.env.PI_SPAWN_CHILD = previousChild;
    f.restore();
  }
});

test("existing project sessions can be adopted, prompted, listed, and continued", async () => {
  const f = await fixture();
  try {
    const existing = SessionManager.create(f.cwd);
    persistSession(existing);
    const originalLeaf = existing.getLeafId();
    const path = existing.getSessionFile()!;
    const tool = f.tools.get("spawn_session");

    const adopted = await tool.execute(
      "adopt",
      { action: "adopt", id: existing.getSessionId(), prompt: "resume this" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(adopted.content[0].text, /reply:resume this/);
    assert.deepEqual(f.calls[0].args, ["--mode", "rpc", "--session", path]);
    const markers = SessionManager.open(path)
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === SESSION_MARKER,
      );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].parentId, originalLeaf);

    persist(f.parent, "spawn_session", adopted);
    const listed = await tool.execute(
      "list",
      { action: "list" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(listed.content[0].text, new RegExp(existing.getSessionId()));
    const continued = await tool.execute(
      "continue",
      { action: "continue", id: existing.getSessionId(), prompt: "again" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(continued.content[0].text, /reply:again/);
  } finally {
    f.restore();
  }
});

test("adoption requires an exact session ID from the selected project", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const local = SessionManager.create(f.cwd);
    persistSession(local);
    const partial = await tool.execute(
      "partial",
      { action: "adopt", id: local.getSessionId().slice(0, 8), prompt: "no" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(partial.details.failureCode, "not_found");

    const otherCwd = join(f.root, "other-repo");
    await mkdir(otherCwd);
    const other = SessionManager.create(otherCwd);
    persistSession(other);
    const omittedProject = await tool.execute(
      "cross-project",
      { action: "adopt", id: other.getSessionId(), prompt: "no" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(omittedProject.details.failureCode, "not_found");
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("sessions can be created, adopted, listed, and continued across projects", async () => {
  const f = await fixture();
  try {
    const otherCwd = join(f.root, "other-repo");
    await mkdir(otherCwd);
    const tool = f.tools.get("spawn_session");

    const created = await tool.execute(
      "create-other",
      {
        action: "create",
        project: relative(f.cwd, otherCwd),
        prompt: "work elsewhere",
        name: "Other project",
      },
      undefined,
      undefined,
      f.ctx,
    );
    const createdId = created.details.piSpawn.id;
    const createdInfo = (await SessionManager.list(otherCwd)).find(
      (session) => session.id === createdId,
    );
    assert.ok(createdInfo);
    assert.equal(f.calls[0].cwd, otherCwd);

    persist(f.parent, "spawn_session", created);
    const continued = await tool.execute(
      "continue-other",
      { action: "continue", id: createdId, prompt: "keep going" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(continued.content[0].text, /reply:keep going/);
    assert.equal(f.calls[1].cwd, otherCwd);
    const listed = await tool.execute(
      "list-other",
      { action: "list" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(listed.content[0].text, new RegExp(createdId));

    const existing = SessionManager.create(otherCwd);
    persistSession(existing);
    const adopted = await tool.execute(
      "adopt-other",
      {
        action: "adopt",
        project: otherCwd,
        id: existing.getSessionId(),
        prompt: "resume elsewhere",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(adopted.content[0].text, /reply:resume elsewhere/);
    assert.equal(f.calls[2].cwd, otherCwd);
  } finally {
    f.restore();
  }
});

test("cross-project targets must be existing directories and are create/adopt only", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const missing = await tool.execute(
      "missing",
      {
        action: "create",
        project: join(f.root, "missing"),
        prompt: "no",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(missing.details.failureCode, "invalid_project");

    const file = join(f.root, "file.txt");
    await writeFile(file, "not a project");
    const notDirectory = await tool.execute(
      "file",
      {
        action: "create",
        project: file,
        prompt: "no",
      },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(notDirectory.details.failureCode, "invalid_project");

    const invalidContinue = await tool.execute(
      "continue-project",
      {
        action: "continue",
        project: f.cwd,
        id: "id",
        prompt: "no",
      },
      undefined,
      undefined,
      f.ctx,
    );
    const invalidList = await tool.execute(
      "list-project",
      { action: "list", project: f.cwd },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(invalidContinue.details.failureCode, "invalid");
    assert.equal(invalidList.details.failureCode, "invalid");
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("adoption rejects the parent and foreign or conflicting ownership", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const self = await tool.execute(
      "self",
      { action: "adopt", id: f.parent.getSessionId(), prompt: "no" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(self.details.failureCode, "invalid");

    const foreign = SessionManager.create(f.cwd);
    foreign.appendCustomEntry(SESSION_MARKER, {
      version: 1,
      ownerSessionId: "other",
      ownerSessionFile: "other.jsonl",
      createdAt: new Date().toISOString(),
    });
    persistSession(foreign);
    const rejected = await tool.execute(
      "foreign",
      { action: "adopt", id: foreign.getSessionId(), prompt: "no" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(rejected.details.failureCode, "owned");
    assert.equal(rejected.details.piSpawn, undefined);

    const conflicting = SessionManager.create(f.cwd);
    conflicting.appendCustomEntry(SESSION_MARKER, {
      version: 1,
      ownerSessionId: f.parent.getSessionId(),
      ownerSessionFile: f.parent.getSessionFile(),
      createdAt: new Date().toISOString(),
    });
    conflicting.appendCustomEntry(SESSION_MARKER, { version: 2 });
    persistSession(conflicting);
    const malformed = await tool.execute(
      "conflicting",
      { action: "adopt", id: conflicting.getSessionId(), prompt: "no" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(malformed.details.failureCode, "owned");
    assert.equal(malformed.details.piSpawn, undefined);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("a claimed session remains branch-authorized when its RPC turn fails", async () => {
  const f = await fixture(async () => {
    throw new Error("rpc failed");
  });
  try {
    const existing = SessionManager.create(f.cwd);
    persistSession(existing);
    const tool = f.tools.get("spawn_session");
    const adopted = await tool.execute(
      "adopt",
      { action: "adopt", id: existing.getSessionId(), prompt: "resume" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(adopted.details.failureCode, "runner_error");
    assert.equal(adopted.details.piSpawn.id, existing.getSessionId());
    const markers = SessionManager.open(existing.getSessionFile()!)
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === SESSION_MARKER,
      );
    assert.equal(markers.length, 1);
  } finally {
    f.restore();
  }
});

test("same-owner adoption restores branch access without duplicating ownership", async () => {
  const f = await fixture();
  try {
    const existing = SessionManager.create(f.cwd);
    existing.appendCustomEntry(SESSION_MARKER, {
      version: 1,
      ownerSessionId: f.parent.getSessionId(),
      ownerSessionFile: f.parent.getSessionFile(),
      createdAt: new Date().toISOString(),
    });
    persistSession(existing);
    const tool = f.tools.get("spawn_session");
    const adopted = await tool.execute(
      "adopt",
      { action: "adopt", id: existing.getSessionId(), prompt: "restore" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(adopted.content[0].text, /reply:restore/);
    const markers = SessionManager.open(existing.getSessionFile()!)
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === SESSION_MARKER,
      );
    assert.equal(markers.length, 1);
  } finally {
    f.restore();
  }
});

test("excluded tools are rejected and progress callback failures cannot orphan a child", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const invalid = await tool.execute(
      "invalid",
      { action: "create", prompt: "x", tools: ["spawn_session"] },
      undefined,
      undefined,
      f.ctx,
    );
    assert.equal(invalid.details.failureCode, "invalid");
    assert.equal(f.calls.length, 0);

    const created = await tool.execute(
      "create",
      { action: "create", prompt: "safe" },
      undefined,
      () => {
        throw new Error("render failed");
      },
      f.ctx,
    );
    assert.match(created.content[0].text, /reply:safe/);
    assert.ok(created.details.piSpawn.id);
  } finally {
    f.restore();
  }
});

test("child IDs are inaccessible from another parent branch owner", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const created = await tool.execute(
      "create",
      { action: "create", prompt: "private" },
      undefined,
      undefined,
      f.ctx,
    );
    const id = created.details.piSpawn.id;
    const otherParent = SessionManager.create(f.cwd);
    const unavailable = await tool.execute(
      "continue",
      { action: "continue", id, prompt: "steal" },
      undefined,
      undefined,
      { ...f.ctx, sessionManager: otherParent },
    );
    assert.equal(unavailable.details.failureCode, "not_found");
  } finally {
    f.restore();
  }
});

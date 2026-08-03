import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import spawnExtension from "../extensions/pi-spawn.ts";
import { SESSION_MARKER, privateAgentDir } from "../src/sessions.ts";
import type { SpawnRun } from "../src/runner.ts";

const completed = (text: string): SpawnRun => ({
  text, model: "fake/model", stopReason: "stop", stderr: "", durationMs: 5,
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: .1 },
  turns: 1, truncated: false, activity: [],
});

function persistSession(manager: SessionManager) {
  manager.appendMessage({
    role: "assistant", content: [], api: "fake", provider: "fake", model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
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

async function fixture(runOverride?: (args: string[], options: any) => Promise<SpawnRun>) {
  const root = await mkdtemp(join(tmpdir(), "pi-spawn-extension-"));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parent = SessionManager.create(cwd);
  persistSession(parent);
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const emitted: Array<{ name: string; value: any }> = [];
  const busHandlers = new Map<string, Function[]>();
  const calls: Array<{ args: string[]; prompt: string; env: NodeJS.ProcessEnv }> = [];
  const sentMessages: any[] = [];
  const pi: any = {
    events: {
      emit: (name: string, value: any) => {
        emitted.push({ name, value });
        for (const handler of busHandlers.get(name) ?? []) handler(value);
      },
      on: (name: string, handler: Function) => {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
        return () => busHandlers.set(name, (busHandlers.get(name) ?? []).filter((item) => item !== handler));
      },
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendMessage: (message: any) => sentMessages.push(message),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  const run: any = async (args: string[], options: any) => {
    calls.push({ args, prompt: options.prompt, env: options.env });
    if (runOverride) return runOverride(args, options);
    const result = completed(`reply:${options.prompt}`);
    options.onUsage?.(result.usage);
    return result;
  };
  spawnExtension(pi, run, agentDir);
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
      hasConfiguredAuth: (model: any) => configuredModels.has(`${model.provider}/${model.id}`),
    },
    scopedModels: [],
    thinkingLevel: "high",
    sessionManager: parent,
  };
  return {
    root, cwd, agentDir, parent, tools, handlers, busHandlers, emitted, calls, sentMessages, ctx, models, configuredModels,
    restore: () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}

test("extension registers exactly the private-agent and standard-session tools", async () => {
  const f = await fixture();
  try {
    assert.deepEqual([...f.tools.keys()].sort(), ["spawn_agent", "spawn_session"]);
    assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.action.enum, ["create", "continue", "list"]);
    assert.deepEqual(f.tools.get("spawn_session").parameters.properties.action.enum, ["create", "adopt", "continue", "list"]);
    assert.equal(f.tools.get("spawn_session").parameters.properties.path, undefined);
    assert.equal(f.tools.get("spawn_session").parameters.properties.systemPrompt, undefined);
    assert.ok(f.tools.get("spawn_session").parameters.properties.model);
    assert.ok(f.tools.get("spawn_agent").parameters.properties.systemPrompt);
    assert.equal(f.tools.get("spawn_agent").promptSnippet, undefined);
    assert.equal(f.tools.get("spawn_agent").promptGuidelines, undefined);
    assert.equal(f.tools.get("spawn_session").promptSnippet, undefined);
    assert.equal(f.tools.get("spawn_session").promptGuidelines, undefined);
    assert.match(f.tools.get("spawn_agent").description, /Creation policy is immutable/);
    assert.match(f.tools.get("spawn_session").description, /Adopt only when the user explicitly asks/);
  } finally { f.restore(); }
});

test("spawn tools advertise deferred discovery without disabling standalone use", async () => {
  const f = await fixture();
  try {
    for (const handler of f.handlers.get("session_start") ?? []) await handler({}, f.ctx);
    const policy = f.emitted.find(({ name, value }) => name === "pylon:tool-policy" && value.kind === "register")?.value;
    assert.deepEqual(policy, {
      version: 1,
      kind: "register",
      owner: "pi-spawn",
      managedTools: ["spawn_agent", "spawn_session"],
      enabledTools: ["spawn_agent", "spawn_session"],
      deferredTools: ["spawn_agent", "spawn_session"],
      deferredToolUsage: {
        spawn_agent: "create or continue private customized subagent conversations",
        spawn_session: "create, adopt, or continue inspectable Pi sessions",
      },
    });
    assert.deepEqual([...f.tools.keys()].sort(), ["spawn_agent", "spawn_session"]);

    for (const handler of f.handlers.get("session_shutdown") ?? []) await handler({}, f.ctx);
    assert.deepEqual(f.emitted.at(-1), {
      name: "pylon:tool-policy",
      value: { version: 1, kind: "unregister", owner: "pi-spawn" },
    });
  } finally { f.restore(); }
});

test("spawn model choices include only authenticated models in session scope", async () => {
  const f = await fixture();
  try {
    f.ctx.scopedModels = [
      { model: f.models[0] },
      { model: f.models[2] },
      { model: f.models[0] },
    ];
    for (const handler of f.handlers.get("session_start") ?? []) await handler({}, f.ctx);
    assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, ["fake/model"]);
    assert.deepEqual(f.tools.get("spawn_session").parameters.properties.model.enum, ["fake/model"]);

    f.ctx.scopedModels = [{ model: f.models[2] }];
    for (const handler of f.handlers.get("session_start") ?? []) await handler({}, f.ctx);
    assert.equal(f.tools.get("spawn_agent").parameters.properties.model, undefined);
    assert.equal(f.tools.get("spawn_session").parameters.properties.model, undefined);
  } finally { f.restore(); }
});

test("explicit models are revalidated before a child is created", async () => {
  const f = await fixture();
  try {
    for (const handler of f.handlers.get("session_start") ?? []) await handler({}, f.ctx);
    assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, ["fake/model", "custom/model"]);
    f.configuredModels.delete("custom/model");

    for (const name of ["spawn_agent", "spawn_session"]) {
      const rejected = await f.tools.get(name).execute("create", {
        action: "create", prompt: "do not start", model: "custom/model",
      }, undefined, undefined, f.ctx);
      assert.equal(rejected.details.failureCode, "model_unavailable");
      assert.match(rejected.content[0].text, /Available models: fake\/model/);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("explicit models honor scope changes after schema registration", async () => {
  const f = await fixture();
  try {
    for (const handler of f.handlers.get("session_start") ?? []) await handler({}, f.ctx);
    assert.deepEqual(f.tools.get("spawn_session").parameters.properties.model.enum, ["fake/model", "custom/model"]);
    f.ctx.scopedModels = [{ model: f.models[0] }];

    for (const name of ["spawn_agent", "spawn_session"]) {
      const rejected = await f.tools.get(name).execute("create", {
        action: "create", prompt: "out of scope", model: "custom/model",
      }, undefined, undefined, f.ctx);
      assert.equal(rejected.details.failureCode, "model_unavailable");
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("running spawn updates expose the selected model", async () => {
  const f = await fixture();
  try {
    for (const name of ["spawn_agent", "spawn_session"]) {
      const updates: any[] = [];
      await f.tools.get(name).execute("create", {
        action: "create", prompt: "report model",
      }, undefined, (update: any) => updates.push(update), f.ctx);
      assert.equal(updates[0]?.details.state, "running");
      assert.equal(updates[0]?.details.model, "fake/model");
      assert.deepEqual(updates.find((update) => update.details?.usage)?.details.usage, {
        input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1,
      });
    }
  } finally { f.restore(); }
});

test("private agents stay outside the normal session index and preserve creation policy", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const created = await tool.execute("create", {
      action: "create", prompt: "inspect auth", name: "Auth agent",
      systemPrompt: "private system", tools: [], disableSpecialists: true,
    }, undefined, undefined, f.ctx);
    const id = created.details.piSpawn.id;
    assert.match(created.content[0].text, /reply:inspect auth/);
    assert.match(created.details.agentName, /^[A-Za-z-]+$/);
    assert.doesNotMatch(created.details.agentName, /^(Agent|Thread)-/);
    assert.ok(!(await SessionManager.list(f.cwd)).some((session) => session.id === id));
    assert.ok((await SessionManager.list(f.cwd, privateAgentDir(f.parent.getSessionId(), f.agentDir))).some((session) => session.id === id));
    assert.deepEqual(f.calls[0].args.slice(0, 4), ["--mode", "rpc", "--session", f.calls[0].args[3]]);
    assert.ok(f.calls[0].args.includes("--system-prompt"));
    assert.ok(f.calls[0].args.includes("private system"));
    assert.ok(f.calls[0].args.includes("--no-tools"));
    assert.match(f.calls[0].args[f.calls[0].args.indexOf("--exclude-tools") + 1], /advisor/);
    assert.match(f.calls[0].args[f.calls[0].args.indexOf("--exclude-tools") + 1], /spawn_session/);

    persist(f.parent, "spawn_agent", created);
    const continued = await tool.execute("continue", { action: "continue", id, prompt: "go deeper" }, undefined, undefined, f.ctx);
    assert.match(continued.content[0].text, /reply:go deeper/);
    assert.equal(continued.details.agentName, created.details.agentName);
    assert.ok(f.calls[1].args.includes("private system"));
    const listed = await tool.execute("list", { action: "list" }, undefined, undefined, f.ctx);
    assert.match(listed.content[0].text, new RegExp(id));

    const invalid = await tool.execute("invalid", { action: "continue", id, prompt: "x", systemPrompt: "changed" }, undefined, undefined, f.ctx);
    assert.equal(invalid.details.failureCode, "invalid");
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test("spawned sessions use standard storage and preserve their chosen model", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const created = await tool.execute("create", { action: "create", prompt: "new thread", name: "Visible thread" }, undefined, undefined, f.ctx);
    const id = created.details.piSpawn.id;
    const listedNative = await SessionManager.list(f.cwd);
    const info = listedNative.find((session) => session.id === id);
    assert.ok(info);
    assert.equal(info.name, "Visible thread");
    assert.equal(info.parentSessionPath, f.parent.getSessionFile());
    assert.deepEqual(f.calls[0].args, ["--mode", "rpc", "--session", info.path, "--model", "fake/model"]);
    assert.equal(f.calls[0].env.PI_SPAWN_CHILD, "session");

    persist(f.parent, "spawn_session", created);
    const continued = await tool.execute("continue", { action: "continue", id, prompt: "second turn" }, undefined, undefined, f.ctx);
    assert.match(continued.content[0].text, /reply:second turn/);
    assert.deepEqual(f.calls[1].args, ["--mode", "rpc", "--session", info.path, "--model", "fake/model"]);
    const listed = await tool.execute("list", { action: "list" }, undefined, undefined, f.ctx);
    assert.match(listed.content[0].text, new RegExp(id));
  } finally { f.restore(); }
});

test("spawned sessions snapshot Pylon hooks and apply before-agent-start context", async () => {
  const f = await fixture();
  const previousChild = process.env.PI_SPAWN_CHILD;
  try {
    f.busHandlers.set("pylon:spawn-hooks-request", [(request: any) => request.provide({
      sessionStart: { customType: "pylon-session-start-hook", content: "SESSION HOOK" },
      beforeAgentStart: "BEFORE HOOK",
    })]);
    const created = await f.tools.get("spawn_session").execute("create", {
      action: "create", prompt: "hooked child", name: "Hooked child", model: "custom/model",
    }, undefined, undefined, f.ctx);
    const child = (await SessionManager.list(f.cwd)).find((session) => session.id === created.details.piSpawn.id)!;
    assert.deepEqual(f.calls[0].args, ["--mode", "rpc", "--session", child.path, "--model", "custom/model"]);
    const manager = SessionManager.open(child.path);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom_message").length, 0);

    process.env.PI_SPAWN_CHILD = "session";
    const childContext = { sessionManager: manager };
    (f.handlers.get("session_start") ?? [])[0]?.({}, childContext);
    assert.deepEqual(f.sentMessages, [{ customType: "pylon-session-start-hook", content: "SESSION HOOK", display: false }]);
    const before = (f.handlers.get("before_agent_start") ?? [])[0];
    assert.ok(before);
    assert.equal(before({ systemPrompt: "BASE" }, childContext).systemPrompt, "BASE\n\nBEFORE HOOK");
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

    const adopted = await tool.execute("adopt", { action: "adopt", id: existing.getSessionId(), prompt: "resume this" }, undefined, undefined, f.ctx);
    assert.match(adopted.content[0].text, /reply:resume this/);
    assert.deepEqual(f.calls[0].args, ["--mode", "rpc", "--session", path]);
    const markers = SessionManager.open(path).getEntries().filter((entry) => entry.type === "custom" && entry.customType === SESSION_MARKER);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].parentId, originalLeaf);

    persist(f.parent, "spawn_session", adopted);
    const listed = await tool.execute("list", { action: "list" }, undefined, undefined, f.ctx);
    assert.match(listed.content[0].text, new RegExp(existing.getSessionId()));
    const continued = await tool.execute("continue", { action: "continue", id: existing.getSessionId(), prompt: "again" }, undefined, undefined, f.ctx);
    assert.match(continued.content[0].text, /reply:again/);
  } finally { f.restore(); }
});

test("adoption requires an exact session ID from the current project", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const local = SessionManager.create(f.cwd);
    persistSession(local);
    const partial = await tool.execute("partial", { action: "adopt", id: local.getSessionId().slice(0, 8), prompt: "no" }, undefined, undefined, f.ctx);
    assert.equal(partial.details.failureCode, "not_found");

    const otherCwd = join(f.root, "other-repo");
    await mkdir(otherCwd);
    const other = SessionManager.create(otherCwd);
    persistSession(other);
    const crossProject = await tool.execute("cross-project", { action: "adopt", id: other.getSessionId(), prompt: "no" }, undefined, undefined, f.ctx);
    assert.equal(crossProject.details.failureCode, "not_found");
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("adoption rejects the parent and foreign or conflicting ownership", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_session");
    const self = await tool.execute("self", { action: "adopt", id: f.parent.getSessionId(), prompt: "no" }, undefined, undefined, f.ctx);
    assert.equal(self.details.failureCode, "invalid");

    const foreign = SessionManager.create(f.cwd);
    foreign.appendCustomEntry(SESSION_MARKER, {
      version: 1, ownerSessionId: "other", ownerSessionFile: "other.jsonl", createdAt: new Date().toISOString(),
    });
    persistSession(foreign);
    const rejected = await tool.execute("foreign", { action: "adopt", id: foreign.getSessionId(), prompt: "no" }, undefined, undefined, f.ctx);
    assert.equal(rejected.details.failureCode, "owned");
    assert.equal(rejected.details.piSpawn, undefined);

    const conflicting = SessionManager.create(f.cwd);
    conflicting.appendCustomEntry(SESSION_MARKER, {
      version: 1, ownerSessionId: f.parent.getSessionId(), ownerSessionFile: f.parent.getSessionFile(), createdAt: new Date().toISOString(),
    });
    conflicting.appendCustomEntry(SESSION_MARKER, { version: 2 });
    persistSession(conflicting);
    const malformed = await tool.execute("conflicting", { action: "adopt", id: conflicting.getSessionId(), prompt: "no" }, undefined, undefined, f.ctx);
    assert.equal(malformed.details.failureCode, "owned");
    assert.equal(malformed.details.piSpawn, undefined);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("a claimed session remains branch-authorized when its RPC turn fails", async () => {
  const f = await fixture(async () => { throw new Error("rpc failed"); });
  try {
    const existing = SessionManager.create(f.cwd);
    persistSession(existing);
    const tool = f.tools.get("spawn_session");
    const adopted = await tool.execute("adopt", { action: "adopt", id: existing.getSessionId(), prompt: "resume" }, undefined, undefined, f.ctx);
    assert.equal(adopted.details.failureCode, "runner_error");
    assert.equal(adopted.details.piSpawn.id, existing.getSessionId());
    const markers = SessionManager.open(existing.getSessionFile()!).getEntries().filter((entry) => entry.type === "custom" && entry.customType === SESSION_MARKER);
    assert.equal(markers.length, 1);
  } finally { f.restore(); }
});

test("same-owner adoption restores branch access without duplicating ownership", async () => {
  const f = await fixture();
  try {
    const existing = SessionManager.create(f.cwd);
    existing.appendCustomEntry(SESSION_MARKER, {
      version: 1, ownerSessionId: f.parent.getSessionId(), ownerSessionFile: f.parent.getSessionFile(), createdAt: new Date().toISOString(),
    });
    persistSession(existing);
    const tool = f.tools.get("spawn_session");
    const adopted = await tool.execute("adopt", { action: "adopt", id: existing.getSessionId(), prompt: "restore" }, undefined, undefined, f.ctx);
    assert.match(adopted.content[0].text, /reply:restore/);
    const markers = SessionManager.open(existing.getSessionFile()!).getEntries().filter((entry) => entry.type === "custom" && entry.customType === SESSION_MARKER);
    assert.equal(markers.length, 1);
  } finally { f.restore(); }
});

test("excluded tools are rejected and progress callback failures cannot orphan a child", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const invalid = await tool.execute("invalid", { action: "create", prompt: "x", tools: ["spawn_session"] }, undefined, undefined, f.ctx);
    assert.equal(invalid.details.failureCode, "invalid");
    assert.equal(f.calls.length, 0);

    const created = await tool.execute("create", { action: "create", prompt: "safe" }, undefined, () => { throw new Error("render failed"); }, f.ctx);
    assert.match(created.content[0].text, /reply:safe/);
    assert.ok(created.details.piSpawn.id);
  } finally { f.restore(); }
});

test("child IDs are inaccessible from another parent branch owner", async () => {
  const f = await fixture();
  try {
    const tool = f.tools.get("spawn_agent");
    const created = await tool.execute("create", { action: "create", prompt: "private" }, undefined, undefined, f.ctx);
    const id = created.details.piSpawn.id;
    const otherParent = SessionManager.create(f.cwd);
    const unavailable = await tool.execute("continue", { action: "continue", id, prompt: "steal" }, undefined, undefined, { ...f.ctx, sessionManager: otherParent });
    assert.equal(unavailable.details.failureCode, "not_found");
  } finally { f.restore(); }
});

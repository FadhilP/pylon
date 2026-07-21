import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import extension from "../extensions/pylon-core.ts";

const exec = promisify(execFile);

class Bus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  on(channel: string, handler: (value: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler); this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel: string, value: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
  count(channel: string) { return this.handlers.get(channel)?.size ?? 0; }
}

function harness() {
  const events = new Bus();
  let active = ["read", "edit", "advisor", "repo_scout"],
    failReconcile = false;
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    events,
    getActiveTools: () => [...active],
    getAllTools: () => ["read", "edit", "write", "advisor", "repo_scout", "continuity_update"]
      .map((name) => ({ name })),
    setActiveTools: (tools: string[]) => {
      if (failReconcile) throw Error("forced reconcile failure");
      active = [...tools];
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    exec: async (command: string) => ({ code: command === "git" ? 0 : 1, stdout: "", stderr: "" }),
  };
  extension(pi as any);
  return {
    events,
    handlers,
    commands,
    entries,
    active: () => active,
    fail: (value: boolean) => { failReconcile = value; },
  };
}

test("extension validates, unregisters, diagnoses, and cleans listener", async () => {
  const runtime = harness();
  let acknowledged = false;
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-advisor",
    managedTools: ["advisor"], enabledTools: ["advisor"],
    acknowledge: () => { acknowledged = true; },
  });
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: ["continuity_update"], enabledTools: ["continuity_update"],
    allowOnly: ["read", "advisor", "continuity_update"],
  });
  runtime.events.emit("pylon:tool-policy", { version: 99 });
  runtime.events.emit("pi-guard:decision", {
    version: 1, decision: "blocked", reason: "destructive Git command", blocked: 1, confirmed: 0,
  });
  assert.equal(acknowledged, true);
  assert.deepEqual(new Set(runtime.active()), new Set(["read", "advisor", "continuity_update"]));
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-continuity",
  });
  assert.deepEqual(new Set(runtime.active()), new Set(["read", "edit", "repo_scout", "advisor"]));
  let diagnostic = "";
  await runtime.commands.get("pylon").handler("", { ui: { notify: (text: string) => { diagnostic = text; } } });
  assert.match(diagnostic, /Effective:/);
  assert.match(diagnostic, /Rejected: 1/);
  assert.match(diagnostic, /Guard authority: blocked: destructive Git command/);
  runtime.events.on("pylon:health-request", (request: any) => request.respond(Promise.resolve({
    version: 1, owner: "pi-helios", label: "Helios", lines: ["CLI: ready", "Browser sessions: 0"], warning: false,
  })));
  await runtime.commands.get("pylon").handler("doctor", {
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /Pylon doctor/);
  assert.match(diagnostic, /Node: .*compatible/);
  assert.match(diagnostic, /Pi API: compatible/);
  assert.match(diagnostic, /Policy protocol: v1/);
  assert.match(diagnostic, /Git: available/);
  assert.match(diagnostic, /ripgrep: missing \(optional\)/);
  assert.match(diagnostic, /Tool surfaces:/);
  assert.match(diagnostic, /Advisor: registered/);
  assert.match(diagnostic, /Package health:\nHelios:\n  CLI: ready/);
  for (const handler of runtime.handlers.get("session_shutdown") ?? []) handler();
  assert.equal(runtime.events.count("pylon:tool-policy"), 0);
  assert.equal(runtime.events.count("pi-guard:decision"), 0);
});

test("shared worktree observer fingerprints one shell tool batch per turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-worktree-observer-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "pylon@test.local"], { cwd: root });
  await exec("git", ["config", "user.name", "pylon-test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "base\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "base"], { cwd: root });

  const runtime = harness();
  let capability: any;
  runtime.events.emit("pylon:worktree-observer-request", {
    version: 1,
    respond: (value: any) => { capability = value; },
  });
  assert.deepEqual(capability, { version: 1, owner: "pylon-core" });
  const changes: any[] = [];
  runtime.events.on("pylon:worktree-change", (event) => changes.push(event));
  const ctx = { cwd: root };
  const toolCall = runtime.handlers.get("tool_call")![0];
  await Promise.all([
    toolCall({ toolName: "bash", toolCallId: "one" }, ctx),
    toolCall({ toolName: "bash", toolCallId: "two" }, ctx),
  ]);
  await writeFile(join(root, "tracked.txt"), "changed\n");
  await runtime.handlers.get("turn_end")![0]({}, ctx);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].changed, true);
  assert.equal(changes[0].known, true);
  assert.deepEqual(changes[0].toolCallIds, ["one", "two"]);
});

test("doctor reports quarantined state and unavailable configured models", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pylon-doctor-"));
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await mkdir(join(root, "pi-advisor"), { recursive: true });
    await mkdir(join(root, "pi-scout"), { recursive: true });
    await mkdir(join(root, "pi-grunt"), { recursive: true });
    await writeFile(join(root, "pi-advisor", "config.json"), JSON.stringify({ version: 1, advisorModel: "openai/test-model" }));
    await writeFile(join(root, "pi-grunt", "config.json"), JSON.stringify({ version: 1, model: "openai/worker-model" }));
    await writeFile(join(root, "pi-scout", "config.json.corrupt-test"), "bad");
    const runtime = harness();
    let diagnostic = "";
    let severity = "";
    await runtime.commands.get("pylon").handler("doctor", {
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai" && id === "test-model" ? { provider, id } : undefined,
        hasConfiguredAuth: () => false,
      },
      ui: { notify: (text: string, level: string) => { diagnostic = text; severity = level; } },
    });
    assert.match(diagnostic, /Quarantined state: .*config\.json\.corrupt-test/);
    assert.match(diagnostic, /Advisor: openai\/test-model \(credentials unavailable\)/);
    assert.match(diagnostic, /Grunt: openai\/worker-model \(model unavailable\)/);
    assert.equal(severity, "warning");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("tools command manages baseline while restrictive gates remain authoritative", async () => {
  const runtime = harness();
  let message = "", level = "";
  const ctx = { ui: { notify: (text: string, severity: string) => {
    message = text; level = severity;
  } } };
  for (const handler of runtime.handlers.get("session_start") ?? [])
    await handler({ reason: "startup" }, ctx);

  await runtime.commands.get("pylon").handler("tools disable edit", ctx);
  assert.ok(!runtime.active().includes("edit"));
  await runtime.commands.get("pylon").handler("tools enable edit write", ctx);
  assert.ok(runtime.active().includes("edit"));
  assert.ok(runtime.active().includes("write"));

  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: ["continuity_update"], enabledTools: ["continuity_update"],
    allowOnly: ["read", "continuity_update"],
  });
  await runtime.commands.get("pylon").handler("tools enable edit", ctx);
  assert.ok(!runtime.active().includes("edit"));
  assert.match(message, /Deferred by active gate: edit/);
  assert.equal(level, "warning");
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-continuity",
  });
  assert.ok(runtime.active().includes("edit"));

  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-advisor",
    managedTools: ["advisor"], enabledTools: ["advisor"],
  });
  await runtime.commands.get("pylon").handler("tools disable advisor", ctx);
  assert.match(message, /Policy-managed tools cannot be changed manually: advisor/);
  assert.equal(level, "error");
  await runtime.commands.get("pylon").handler("tools enable missing", ctx);
  assert.match(message, /Unknown tools: missing/);

  await runtime.commands.get("pylon").handler("tools status", ctx);
  assert.match(message, /Baseline:/);
  assert.match(message, /Effective:/);
});

test("discovery capability replaces deferred selections and respects gates", () => {
  const runtime = harness();
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-advisor",
    managedTools: ["advisor"], enabledTools: ["advisor"], deferredTools: ["advisor"],
  });
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-scout",
    managedTools: ["repo_scout"], enabledTools: ["repo_scout"], deferredTools: ["repo_scout"],
  });
  assert.ok(!runtime.active().includes("advisor"));
  assert.ok(!runtime.active().includes("repo_scout"));

  const responses: any[] = [];
  runtime.events.emit("pylon:tool-discovery", { version: 1, respond: (value: any) => responses.push(value) });
  assert.equal(responses.length, 1);
  const capability = responses[0];
  assert.deepEqual(capability.eligible(), ["advisor", "repo_scout"]);
  assert.deepEqual(capability.select(["advisor"]), { selected: ["advisor"], blocked: [] });
  assert.ok(runtime.active().includes("advisor"));
  assert.ok(!runtime.active().includes("repo_scout"));
  capability.select(["repo_scout"]);
  assert.ok(!runtime.active().includes("advisor"));
  assert.ok(runtime.active().includes("repo_scout"));

  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: [], enabledTools: [], allowOnly: ["read"],
  });
  assert.deepEqual(capability.select(["advisor"]), { selected: ["advisor"], blocked: ["advisor"] });
  assert.ok(!runtime.active().includes("advisor"));
  assert.match(capability.select(["missing"]).error, /not eligible/);
  assert.deepEqual(capability.reset(), { selected: [] });
});

test("discovery selection validation and failed reconciliation preserve prior selection", () => {
  const runtime = harness();
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-advisor",
    managedTools: ["advisor"], enabledTools: ["advisor"], deferredTools: ["advisor"],
  });
  const responses: any[] = [];
  runtime.events.emit("pylon:tool-discovery", { version: 1, respond: (value: any) => responses.push(value) });
  const capability = responses[0];
  assert.doesNotThrow(() => capability.select([Symbol("bad")]));
  assert.match(capability.select([Symbol("bad")]).error, /non-empty tool names/);
  capability.select(["advisor"]);
  assert.ok(runtime.active().includes("advisor"));

  runtime.fail(true);
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-advisor",
  });
  runtime.fail(false);
  assert.ok(runtime.active().includes("advisor"));
  assert.deepEqual(capability.eligible(), ["advisor"]);
  assert.deepEqual(capability.select(["advisor"]), { selected: ["advisor"], blocked: [] });
});

test("tokens command rebuilds branch usage and tracks custom tool results", async () => {
  const runtime = harness();
  let report = "";
  const ctx = {
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
        ] } },
        { type: "message", message: {
          role: "toolResult", toolCallId: "read-1", toolName: "read",
          content: [{ type: "text", text: "source" }], isError: false,
        } },
      ],
    },
    ui: { notify: (text: string) => { report = text; } },
  };
  for (const handler of runtime.handlers.get("session_start") ?? [])
    await handler({ reason: "startup" }, ctx);

  for (const handler of runtime.handlers.get("tool_result") ?? []) {
    await handler({
      toolCallId: "custom-1", toolName: "custom_tool", input: { query: "x" },
      content: [{ type: "text", text: "answer" }], isError: false,
    }, ctx);
  }
  await runtime.commands.get("tokens").handler("", ctx);

  assert.match(report, /read: 1 call/);
  assert.match(report, /custom_tool: 1 call/);
  assert.match(report, /Total: 2 calls/);
});

test("validates, deduplicates, persists, and reports direct model telemetry", async () => {
  const runtime = harness();
  const event = {
    version: 1, eventId: "timeline-call-1", package: "pi-timeline", kind: "model_call",
    status: "completed", durationMs: 12,
    usage: { turns: 1, input: 20, output: 4, cacheRead: 5, cacheWrite: 0, cost: 0.01 },
    context: {
      request: { characters: 40, hash: "a".repeat(64) },
      result: { characters: 20, hash: "b".repeat(64) },
    },
  };
  runtime.events.emit("pylon:telemetry", event);
  runtime.events.emit("pylon:telemetry", event);
  runtime.events.emit("pylon:telemetry", { ...event, eventId: "bad id", context: { request: { characters: 40, hash: "raw prompt" } } });
  runtime.events.emit("pylon:telemetry", { ...event, eventId: "timeline-call-2", rawPrompt: "must reject" });

  assert.equal(runtime.entries.length, 1);
  assert.deepEqual(runtime.entries[0], { customType: "pylon-telemetry", data: event });
  let report = "";
  await runtime.commands.get("tokens").handler("", { ui: { notify: (text: string) => { report = text; } } });
  assert.match(report, /pi-timeline: 1 calls/);
  assert.match(report, /Total session model cost: \$0\.0100/);
  assert.doesNotMatch(report, /raw prompt/);
});

test("acknowledges policy only after successful reconcile", () => {
  const runtime = harness();
  let acknowledgements = 0;
  const policy = {
    version: 1,
    kind: "register",
    owner: "pi-test",
    managedTools: ["test_tool"],
    enabledTools: ["test_tool"],
    acknowledge: () => { acknowledgements++; },
  };
  runtime.fail(true);
  runtime.events.emit("pylon:tool-policy", policy);
  assert.equal(acknowledgements, 0);
  runtime.fail(false);
  runtime.events.emit("pylon:tool-policy", policy);
  assert.equal(acknowledgements, 1);
});

test("restores pre-gate tools supplied by an acknowledged policy", () => {
  const runtime = harness();
  runtime.events.emit("pylon:tool-policy", {
    version: 1,
    kind: "register",
    owner: "pi-continuity",
    managedTools: ["continuity_update"],
    enabledTools: ["continuity_update"],
    allowOnly: ["read", "continuity_update"],
  });
  assert.ok(!runtime.active().includes("edit"));
  runtime.events.emit("pylon:tool-policy", {
    version: 1,
    kind: "register",
    owner: "pi-continuity",
    managedTools: ["continuity_update"],
    enabledTools: ["continuity_update"],
    restoreTools: ["read", "edit", "advisor", "repo_scout"],
  });
  assert.ok(runtime.active().includes("edit"));
});

test("restore snapshot does not bypass another active gate", () => {
  const runtime = harness();
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: ["continuity_update"], enabledTools: ["continuity_update"],
    allowOnly: ["read", "continuity_update"],
  });
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-other",
    managedTools: [], enabledTools: [], allowOnly: ["read"],
  });
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: ["continuity_update"], enabledTools: ["continuity_update"],
    restoreTools: ["read", "edit"],
  });
  assert.ok(!runtime.active().includes("edit"));
});

test("rolls back unregister state when reconcile fails", async () => {
  const runtime = harness();
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["test_tool"], enabledTools: ["test_tool"],
  });
  runtime.fail(true);
  runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-test",
  });
  let diagnostic = "";
  await runtime.commands.get("pylon").handler("", {
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /pi-test: enabled/);
  assert.match(diagnostic, /forced reconcile failure/);
});

test("isolates and diagnoses acknowledgement failures", async () => {
  const runtime = harness();
  assert.doesNotThrow(() => runtime.events.emit("pylon:tool-policy", {
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["test_tool"], enabledTools: ["test_tool"],
    acknowledge: () => { throw Error("forced acknowledge failure"); },
  }));
  assert.ok(runtime.active().includes("test_tool"));
  let diagnostic = "";
  await runtime.commands.get("pylon").handler("", {
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /Last acknowledge error: forced acknowledge failure/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-conductor-core.ts";

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
  const pi = {
    events,
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      if (failReconcile) throw Error("forced reconcile failure");
      active = [...tools];
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    exec: async (command: string) => ({ code: command === "git" ? 0 : 1, stdout: "", stderr: "" }),
  };
  extension(pi as any);
  return {
    events,
    handlers,
    commands,
    active: () => active,
    fail: (value: boolean) => { failReconcile = value; },
  };
}

test("extension validates, unregisters, diagnoses, and cleans listener", async () => {
  const runtime = harness();
  let acknowledged = false;
  runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "register", owner: "pi-advisor",
    managedTools: ["advisor"], enabledTools: ["advisor"],
    acknowledge: () => { acknowledged = true; },
  });
  runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "register", owner: "pi-continuity",
    managedTools: ["continuity_update"], enabledTools: ["continuity_update"],
    allowOnly: ["read", "advisor", "continuity_update"],
  });
  runtime.events.emit("pi-conductor:tool-policy", { version: 99 });
  runtime.events.emit("pi-guard:decision", {
    version: 1, decision: "blocked", reason: "destructive Git command", blocked: 1, confirmed: 0,
  });
  assert.equal(acknowledged, true);
  assert.deepEqual(new Set(runtime.active()), new Set(["read", "advisor", "continuity_update"]));
  runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-continuity",
  });
  assert.deepEqual(new Set(runtime.active()), new Set(["read", "edit", "repo_scout", "advisor"]));
  let diagnostic = "";
  await runtime.commands.get("conductor").handler("", { ui: { notify: (text: string) => { diagnostic = text; } } });
  assert.match(diagnostic, /Effective:/);
  assert.match(diagnostic, /Rejected: 1/);
  assert.match(diagnostic, /Guard authority: blocked: destructive Git command/);
  runtime.events.on("pi-conductor:health-request", (request: any) => request.respond(Promise.resolve({
    version: 1, owner: "pi-helios", label: "Helios", lines: ["CLI: ready", "Browser sessions: 0"], warning: false,
  })));
  await runtime.commands.get("conductor").handler("doctor", {
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /Conductor doctor/);
  assert.match(diagnostic, /Node: .*compatible/);
  assert.match(diagnostic, /Pi API: compatible/);
  assert.match(diagnostic, /Policy protocol: v1/);
  assert.match(diagnostic, /Git: available/);
  assert.match(diagnostic, /ripgrep: missing \(optional\)/);
  assert.match(diagnostic, /Tool surfaces:/);
  assert.match(diagnostic, /Advisor: registered/);
  assert.match(diagnostic, /Package health:\nHelios:\n  CLI: ready/);
  for (const handler of runtime.handlers.get("session_shutdown") ?? []) handler();
  assert.equal(runtime.events.count("pi-conductor:tool-policy"), 0);
  assert.equal(runtime.events.count("pi-guard:decision"), 0);
});

test("doctor reports quarantined state and unavailable configured models", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-doctor-"));
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await mkdir(join(root, "pi-advisor"), { recursive: true });
    await mkdir(join(root, "pi-scout"), { recursive: true });
    await writeFile(join(root, "pi-advisor", "config.json"), JSON.stringify({ schemaVersion: 1, advisorModel: "openai/test-model" }));
    await writeFile(join(root, "pi-scout", "config.json.corrupt-test"), "bad");
    const runtime = harness();
    let diagnostic = "";
    let severity = "";
    await runtime.commands.get("conductor").handler("doctor", {
      modelRegistry: {
        find: (provider: string, id: string) => provider === "openai" && id === "test-model" ? { provider, id } : undefined,
        hasConfiguredAuth: () => false,
      },
      ui: { notify: (text: string, level: string) => { diagnostic = text; severity = level; } },
    });
    assert.match(diagnostic, /Quarantined state: .*config\.json\.corrupt-test/);
    assert.match(diagnostic, /Advisor: openai\/test-model \(credentials unavailable\)/);
    assert.equal(severity, "warning");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
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
  runtime.events.emit("pi-conductor:tool-policy", policy);
  assert.equal(acknowledgements, 0);
  runtime.fail(false);
  runtime.events.emit("pi-conductor:tool-policy", policy);
  assert.equal(acknowledgements, 1);
});

test("rolls back unregister state when reconcile fails", async () => {
  const runtime = harness();
  runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["test_tool"], enabledTools: ["test_tool"],
  });
  runtime.fail(true);
  runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "unregister", owner: "pi-test",
  });
  let diagnostic = "";
  await runtime.commands.get("conductor").handler("", {
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /pi-test: enabled/);
  assert.match(diagnostic, /forced reconcile failure/);
});

test("isolates and diagnoses acknowledgement failures", async () => {
  const runtime = harness();
  assert.doesNotThrow(() => runtime.events.emit("pi-conductor:tool-policy", {
    version: 1, kind: "register", owner: "pi-test",
    managedTools: ["test_tool"], enabledTools: ["test_tool"],
    acknowledge: () => { throw Error("forced acknowledge failure"); },
  }));
  assert.ok(runtime.active().includes("test_tool"));
  let diagnostic = "";
  await runtime.commands.get("conductor").handler("", {
    ui: { notify: (text: string) => { diagnostic = text; } },
  });
  assert.match(diagnostic, /Last acknowledge error: forced acknowledge failure/);
});

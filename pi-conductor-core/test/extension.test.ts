import test from "node:test";
import assert from "node:assert/strict";
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
  for (const handler of runtime.handlers.get("session_shutdown") ?? []) handler();
  assert.equal(runtime.events.count("pi-conductor:tool-policy"), 0);
  assert.equal(runtime.events.count("pi-guard:decision"), 0);
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

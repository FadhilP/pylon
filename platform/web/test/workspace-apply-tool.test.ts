import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceApplyTool } from "../src/server/pi/workspace-apply-tool.ts";

const pylonCoreExtensionUrl = new URL("../../../packages/pylon-core/extensions/pylon-core.ts", import.meta.url).href;

class TestBus {
  private handlers = new Map<string, Set<(value: any) => void>>();

  on(event: string, handler: (value: any) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, value: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

function loadTool(bridge: WorkspaceApplyTool) {
  let registered: any;
  let activeTools = ["read"];
  const handlers = new Map<string, () => unknown>();
  const policies: any[] = [];
  const factory = typeof bridge.extension === "function"
    ? bridge.extension
    : bridge.extension.factory;
  factory({
    events: {
      emit(event: string, policy: any) {
        if (event === "pylon:tool-policy") policies.push(policy);
      },
    },
    on(event: string, handler: () => unknown) {
      handlers.set(event, handler);
    },
    registerTool(tool: any) {
      registered = tool;
      activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
  } as any);
  return {
    registered,
    policies,
    activeTools: () => [...activeTools],
    emit: (event: string) => handlers.get(event)?.(),
    beforeAgentStart: () => handlers.get("before_agent_start")?.(),
  };
}

test("workspace apply tool policy fails closed without coordination and unregisters", () => {
  const runtime = loadTool(new WorkspaceApplyTool());
  runtime.emit("session_start");
  assert.match(runtime.registered.description, /only when the user explicitly asks/);
  assert.match(runtime.registered.description, /final workspace-mutating tool call/);
  assert.match(runtime.registered.description, /do not modify workspace files afterward/);
  assert.deepEqual(runtime.policies[0], {
    version: 1,
    kind: "register",
    owner: "pylon-core",
    managedTools: ["apply_session_changes"],
    enabledTools: ["apply_session_changes"],
    deferredTools: ["apply_session_changes"],
    deferredToolUsage: { apply_session_changes: "apply this session's changes to the registered project's current branch after explicit user approval" },
    acknowledge: runtime.policies[0].acknowledge,
  });
  assert.ok(!runtime.activeTools().includes("apply_session_changes"));
  runtime.emit("session_shutdown");
  assert.deepEqual(runtime.policies[1], {
    version: 1,
    kind: "unregister",
    owner: "pylon-core",
  });
});

test("workspace apply tool is discoverable and activates through pylon core", async () => {
  const { default: pylonCoreExtension } = await import(pylonCoreExtensionUrl);
  const events = new TestBus();
  let activeTools = ["read"];
  const tools = new Map<string, any>();
  const coreHandlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const workspaceHandlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const common = {
    events,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [{ name: "read" }, ...tools.values()],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    registerCommand: () => {},
    appendEntry: () => {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  pylonCoreExtension({
    ...common,
    on: (event: string, handler: (...args: any[]) => unknown) =>
      coreHandlers.set(event, [...(coreHandlers.get(event) ?? []), handler]),
  } as any);
  const bridge = new WorkspaceApplyTool();
  const factory = typeof bridge.extension === "function" ? bridge.extension : bridge.extension.factory;
  factory({
    ...common,
    on: (event: string, handler: (...args: any[]) => unknown) =>
      workspaceHandlers.set(event, [...(workspaceHandlers.get(event) ?? []), handler]),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      activeTools.push(tool.name);
    },
  } as any);

  for (const handler of coreHandlers.get("session_start") ?? []) handler({}, { sessionManager: { getBranch: () => [] } });
  for (const handler of workspaceHandlers.get("session_start") ?? []) handler({}, {});
  assert.ok(!activeTools.includes("apply_session_changes"));

  let discovery: any;
  events.emit("pylon:tool-discovery", { version: 1, respond: (value: any) => { discovery = value; } });
  assert.ok(discovery.eligible().includes("apply_session_changes"));
  assert.deepEqual(discovery.catalog().find((entry: any) => entry.name === "apply_session_changes"), {
    name: "apply_session_changes",
    usage: "apply this session's changes to the registered project's current branch after explicit user approval",
  });
  assert.deepEqual(discovery.select(["apply_session_changes"]), {
    selected: ["apply_session_changes"],
    blocked: [],
  });
  assert.ok(activeTools.includes("apply_session_changes"));

  for (const handler of workspaceHandlers.get("session_shutdown") ?? []) handler({}, {});
  assert.ok(!activeTools.includes("apply_session_changes"));
  for (const handler of coreHandlers.get("session_shutdown") ?? []) handler({}, {});
});

test("workspace apply tool fails closed and schedules the approved revision once", async () => {
  const bridge = new WorkspaceApplyTool();
  const { registered, beforeAgentStart } = loadTool(bridge);
  const requests: unknown[] = [];
  bridge.setHandler(async (request) => {
    requests.push(request);
    if (request.type === "inspect") {
      return {
        available: true,
        targetBranch: "main",
        changedCount: 2,
        revision: "revision-1",
        mode: "worktree",
      };
    }
  });

  const noUi = await registered.execute("call", {}, undefined, undefined, { hasUI: false });
  assert.match(noUi.content[0].text, /confirmation UI is unavailable/);
  const approved = await registered.execute("call", {}, undefined, undefined, {
    hasUI: true,
    ui: { confirm: async () => true },
  });
  assert.match(approved.content[0].text, /scheduled after this turn/);
  assert.deepEqual(requests.at(-1), { type: "schedule", revision: "revision-1" });

  bridge.recordResult("Applied to main.");
  assert.deepEqual(beforeAgentStart(), {
    message: {
      customType: "pylon-workspace-apply-result",
      display: false,
      content: "Applied to main.",
    },
  });
  assert.equal(beforeAgentStart(), undefined);
});

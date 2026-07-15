import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import advisor from "../packages/pi-advisor/extensions/pi-advisor.ts";
import pylon from "../packages/pylon-core/extensions/pylon-core.ts";
import continuity from "../packages/pi-continuity/extensions/pi-continuity.ts";
import focus from "../packages/pi-focus/extensions/pi-focus.ts";
import guard from "../packages/pi-guard/extensions/pi-guard.ts";
import grunt from "../packages/pi-grunt/extensions/pi-grunt.ts";
import heartbeat from "../packages/pi-heartbeat/extensions/pi-heartbeat.ts";
import helios from "../packages/pi-helios/extensions/pi-helios.ts";
import searchTools from "../packages/pi-scout/extensions/search-tools.ts";
import scout from "../packages/pi-scout/extensions/pi-scout.ts";
import timeline from "../packages/pi-timeline/extensions/pi-timeline.ts";
import verify from "../packages/pi-verify/extensions/pi-verify.ts";
import { mapLimit } from "../scripts/run-packages-lib.mjs";

test("package runner bounds concurrency and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([30, 5, 20, 1], 2, async (delay) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return delay;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [30, 5, 20, 1]);
});

class Bus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  on(channel: string, handler: (value: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel: string, value: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
  count() {
    return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

test("root bundle loads, starts, wires integrations, and shuts down", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, [
    "./packages/pi-advisor/extensions/pi-advisor.ts",
    "./packages/pylon-core/extensions/pylon-core.ts",
    "./packages/pi-continuity/extensions/pi-continuity.ts",
    "./packages/pi-focus/extensions/pi-focus.ts",
    "./packages/pi-guard/extensions/pi-guard.ts",
    "./packages/pi-grunt/extensions/pi-grunt.ts",
    "./packages/pi-heartbeat/extensions/pi-heartbeat.ts",
    "./packages/pi-helios/extensions/pi-helios.ts",
    "./packages/pi-scout/extensions/search-tools.ts",
    "./packages/pi-scout/extensions/pi-scout.ts",
    "./packages/pi-timeline/extensions/pi-timeline.ts",
    "./packages/pi-verify/extensions/pi-verify.ts",
  ]);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pylon-bundle-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const events = new Bus();
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const renderers = new Map<string, any>();
    let active: string[] = ["read", "edit", "write", "bash"];
    const pi: any = {
      events,
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerEntryRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
      getActiveTools: () => [...new Set(active)],
      setActiveTools: (tools: string[]) => { active = [...tools]; },
      getThinkingLevel: () => "low",
      setThinkingLevel: () => {},
      getSessionName: () => undefined,
      setSessionName: () => {},
      setModel: async () => true,
      appendEntry: () => {},
      sendUserMessage: () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    [advisor, pylon, continuity, focus, guard, grunt, heartbeat, helios, searchTools, scout, timeline, verify]
      .forEach((extension) => extension(pi));

    assert.deepEqual([...commands.keys()].sort(), [
      "advisor", "continuity", "grunt", "guard", "heartbeat", "helios-doctor", "helios-visibility", "memory", "plan", "pylon", "scout", "timeline", "todos", "ui",
    ]);
    assert.deepEqual([...tools.keys()].sort(), [
      "advisor", "continuity_update", "fd", "grunt", "heartbeat_cancel", "heartbeat_start", "heartbeat_status", "helios_browser", "helios_capture", "repo_scout", "rg", "verify", "web_scout",
    ]);
    assert.ok(renderers.has("pi-scout-session"));

    let notification = "";
    const ui = new Proxy({ confirm: async () => false, notify: (text: string) => { notification = text; } }, { get: (target, property) => (target as any)[property] ?? (() => {}) });
    const ctx: any = {
      cwd, hasUI: false, mode: "json", model: undefined, ui,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      sessionManager: {
        getEntries: () => [], getBranch: () => [], getSessionId: () => "bundle-session",
        getSessionFile: () => join(root, "session.jsonl"), getLeafId: () => undefined,
      },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    assert.ok(active.includes("continuity_update"));
    assert.ok(!active.includes("grunt"));
    assert.ok(!active.includes("repo_scout"));
    assert.ok(!active.includes("web_scout"));
    assert.ok(!active.includes("advisor"));
    assert.ok(events.count() > 0);
    await commands.get("pylon").handler("doctor", ctx);
    assert.match(notification, /Package health:/);
    assert.match(notification, /Helios:/);
    assert.match(notification, /Grunt:/);
    assert.match(notification, /Scout:/);
    assert.match(notification, /Web Scout: Helios broker ready/);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
    assert.equal(events.count(), 0);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

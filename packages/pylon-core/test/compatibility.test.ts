import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pylon from "../extensions/pylon-core.ts";
import discover from "../../pi-discover/extensions/pi-discover.ts";
import advisor from "../../pi-advisor/extensions/pi-advisor.ts";
import scout from "../../pi-scout/extensions/pi-scout.ts";
import grunt from "../../pi-grunt/extensions/pi-grunt.ts";
import continuity from "../../pi-continuity/extensions/pi-continuity.ts";

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
}

test("actual Advisor, Grunt, Scout, and Continuity adapters coordinate end to end", async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pylon-compat-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const events = new Bus();
    let active = ["read", "grep", "find", "ls", "edit", "write", "bash"];
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const model = { provider: "provider", id: "base" };
    const scopedModel = { provider: "provider", id: "scoped" };
    const models = new Map([
      ["provider/base", model],
      ["provider/scoped", scopedModel],
    ]);
    const selections: Array<{ title: string; options: string[] }> = [];
    const pi: any = {
      events,
      getActiveTools: () => [...active],
      getAllTools: () => [...tools.values()],
      setActiveTools: (tools: string[]) => {
        active = [...tools];
      },
      getThinkingLevel: () => "low",
      setThinkingLevel: () => {},
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => {
        tools.set(tool.name, tool);
        if (!active.includes(tool.name)) active.push(tool.name);
      },
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerEntryRenderer: () => {},
      appendEntry: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      setModel: async () => true,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    pylon(pi);
    discover(pi);
    advisor(pi);
    grunt(pi);
    scout(pi);
    continuity(pi);
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      model,
      scopedModels: [{ model: scopedModel, thinkingLevel: "high" }],
      modelRegistry: {
        find: (provider: string, id: string) => models.get(`${provider}/${id}`),
        hasConfiguredAuth: () => true,
        getAvailable: () => [model],
      },
      sessionManager: { getSessionId: () => "compat-session" },
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        confirm: async () => true,
        select: async (title: string, options: string[]) => {
          selections.push({ title, options });
          return options[0];
        },
      },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    assert.ok(!active.includes("repo_scout"));
    assert.ok(!active.includes("grunt"));
    assert.ok(active.includes("continuity_update"));
    assert.ok(!active.includes("memory"));
    assert.ok(!active.includes("continuity_recall"));
    assert.ok(!active.includes("advisor"));
    await commands.get("advisor").handler("reset", ctx);
    await commands.get("grunt").handler("reset", ctx);
    await commands.get("scout").handler("reset", ctx);
    assert.ok(active.includes("advisor"));
    assert.ok(!active.includes("grunt"));
    assert.ok(active.includes("repo_scout"));
    assert.ok(!active.includes("web_scout"));

    ctx.mode = "tui";
    await commands.get("advisor").handler("select", ctx);
    await commands.get("grunt").handler("select", ctx);
    await commands.get("scout").handler("select", ctx);
    await commands.get("continuity").handler("select planner", ctx);
    assert.deepEqual(
      selections.filter(({ title }) => title.endsWith("model")),
      [
        { title: "Advisor model", options: ["provider/scoped"] },
        { title: "Grunt worker model", options: ["provider/scoped"] },
        { title: "Scout model", options: ["provider/scoped"] },
        { title: "planner model", options: ["provider/scoped"] },
      ],
    );
    assert.deepEqual(
      selections.filter(({ title }) => title.includes("thinking level")).map(({ title }) => title),
      ["Advisor thinking level", "Scout thinking level", "planner thinking level"],
    );

    selections.length = 0;
    ctx.scopedModels = [];
    await commands.get("advisor").handler("select", ctx);
    await commands.get("grunt").handler("select", ctx);
    await commands.get("scout").handler("select", ctx);
    await commands.get("continuity").handler("select planner", ctx);
    assert.deepEqual(
      selections.filter(({ title }) => title.endsWith("model")),
      [
        { title: "Advisor model", options: ["provider/base"] },
        { title: "Grunt worker model", options: ["provider/base"] },
        { title: "Scout model", options: ["provider/base"] },
        { title: "planner model", options: ["provider/base"] },
      ],
    );
    ctx.mode = "json";

    const capabilities: any[] = [];
    events.emit("pylon:tool-discovery", { version: 1, respond: (value: any) => capabilities.push(value) });
    assert.equal(capabilities.length, 1);
    assert.deepEqual(capabilities[0].eligible(), [
      "code_search",
      "continuity_recall",
      "grunt",
      "index_status",
      "memory",
      "pylon_docs",
      "relationship_graph",
      "search_sessions",
      "session_stats",
      "symbol_search",
      "web_scout",
    ]);
    assert.deepEqual(capabilities[0].catalog(), [
      { name: "code_search", usage: "search indexed source with ranked lexical snippets" },
      { name: "continuity_recall", usage: "recall bounded historical evidence omitted from the active context" },
      { name: "grunt", usage: "delegate a large mechanical implementation slice to an isolated synchronous worker" },
      { name: "index_status", usage: "inspect local repository code-index status" },
      { name: "memory", usage: "inspect durable notes or propose grounded reviewer-gated memory changes" },
      { name: "pylon_docs", usage: "read shipped Pylon and Pylon Web documentation for product-specific questions" },
      { name: "relationship_graph", usage: "map source symbols or tokens to related files and source locations" },
      {
        name: "search_sessions",
        usage: "search within exact historical Pi session IDs or assistant tool calls when explicitly requested",
      },
      {
        name: "session_stats",
        usage: "inspect historical Pi session usage and tool-call statistics when explicitly requested",
      },
      { name: "symbol_search", usage: "search local repository symbols by name, kind, language, or path" },
      { name: "web_scout", usage: "research current public web pages with bounded URL-cited evidence" },
    ]);
    capabilities[0].select(["web_scout"]);
    assert.ok(active.includes("web_scout"));
    await commands.get("plan").handler("start compatibility", ctx);
    assert.ok(active.includes("read"));
    assert.ok(active.includes("repo_scout"));
    assert.ok(!active.includes("edit"));
    await commands.get("scout").handler("disable", ctx);
    assert.ok(!active.includes("repo_scout"));
    await tools
      .get("continuity_update")
      .execute("plan", { action: "set_plan", goal: "compatibility", todos: ["Implement"] }, undefined, undefined, ctx);
    await commands.get("plan").handler("approve-current", ctx);
    assert.ok(active.includes("edit"));
    assert.ok(!active.includes("continuity_recall"));
    assert.ok(!active.includes("memory"));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
    assert.equal(events.handlers.get("pylon:tool-policy")?.size ?? 0, 0);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

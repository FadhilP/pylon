import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import discover, { keywordRankTools, normalizedQuery, rankInactiveTools, relationshipRoles } from "../extensions/pi-discover.ts";
import registerDiscoverChildTools, { DISCOVER_CHILD_MAX_BYTES } from "../src/discover-child-tools.ts";

class Bus {
  handlers = new Map<string, ((value: any) => void)[]>();
  on(name: string, handler: (value: any) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
  }
  emit(name: string, value: any) {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function setup(exec: (...args: any[]) => Promise<any> = async () => ({ code: 0, stdout: "", stderr: "" })) {
  const tools = new Map<string, any>();
  const events = new Bus();
  const lifecycle = new Bus();
  const active = ["read", "rg", "fd", "relationship_graph", "search_tools"];
  let setActiveCalls = 0;
  const pi: any = {
    events,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    getAllTools: () => [
      { name: "read", description: "Read files" },
      { name: "rg", description: "Search repository content" },
      { name: "fd", description: "Find paths" },
      { name: "relationship_graph", description: "Map source relationships" },
      { name: "search_tools", description: "Find inactive tools" },
      { name: "git_history", description: "Search commit history and changes" },
      { name: "web_lookup", description: "Search public web pages" },
      { name: "shell", description: "Run shell commands" },
    ],
    setActiveTools: () => { setActiveCalls++; },
    on: (name: string, handler: (value: any, ctx?: any) => void) => lifecycle.on(name, handler),
    exec,
  };
  discover(pi);
  return { active, events, lifecycle, tools, getSetActiveCalls: () => setActiveCalls };
}

test("host and child entrypoints register their intended discovery tools", () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()], ["rg", "fd", "relationship_graph", "search_tools"]);
  const childTools = new Map<string, any>();
  registerDiscoverChildTools({ registerTool: (tool: any) => childTools.set(tool.name, tool) } as any);
  assert.deepEqual([...childTools.keys()], ["rg", "fd", "relationship_graph"]);
});

test("discover child tools enforce their child-local output cap", async () => {
  const tools = new Map<string, any>();
  registerDiscoverChildTools({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    exec: async () => ({ code: 0, stdout: "x".repeat(DISCOVER_CHILD_MAX_BYTES * 2), stderr: "" }),
  } as any);
  const result = await tools.get("rg").execute(
    "id", { pattern: "x" }, undefined, undefined, { cwd: process.cwd() },
  );
  assert.ok(Buffer.byteLength(result.content[0].text) <= DISCOVER_CHILD_MAX_BYTES);
  assert.match(result.content[0].text, /truncated/i);
});

test("host advertises an install-resolved discover child capability", async () => {
  const { events } = setup();
  const responses: any[] = [];
  events.emit("pi-discover:child-tools-capability", { version: 1, respond: (value: any) => responses.push(value) });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].owner, "pi-discover");
  assert.deepEqual(responses[0].toolNames, ["rg", "fd", "relationship_graph"]);
  assert.match(responses[0].childExtensionPath, /discover-child-tools\.ts$/);
  await access(responses[0].childExtensionPath);
});

test("rg uses argument arrays and supports files mode", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { tools } = setup(async (command, args) => {
    calls.push({ command, args });
    return { stdout: "src/a.ts\nsrc/b.ts\n", stderr: "", code: 0, killed: false };
  });
  const result = await tools.get("rg").execute(
    "id", { pattern: "a;b", path: ".", glob: "*.ts", mode: "files" }, undefined, undefined, { cwd: process.cwd() },
  );
  assert.equal(calls[0].command, "rg");
  assert.ok(calls[0].args.includes("a;b"));
  assert.ok(calls[0].args.includes("--files-with-matches"));
  assert.ok(!calls[0].args.includes("--line-number"));
  assert.deepEqual(result.content[0].text.trimEnd().split(/\r?\n/), ["src/a.ts", "src/b.ts"]);
});

test("fd tries fdfind then directs models to built-in find", async () => {
  const calls: string[] = [];
  const { tools } = setup(async (command) => {
    calls.push(command);
    throw new Error("ENOENT");
  });
  const result = await tools.get("fd").execute("id", {}, undefined, undefined, { cwd: process.cwd() });
  assert.deepEqual(calls, ["fd", "fdfind"]);
  assert.match(result.content[0].text, /use find instead/);
});

function rgMatch(path: string, line: number, text: string) {
  return JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line } });
}

test("relationship role classification remains explicitly heuristic", () => {
  assert.deepEqual(relationshipRoles("run", "export function run() {"), ["possible_definition", "possible_export"]);
  assert.deepEqual(relationshipRoles("run", "import { run } from './task.js';"), ["possible_import"]);
  assert.deepEqual(relationshipRoles("run", "const value = run;"), ["reference"]);
});

test("relationship_graph returns a bounded JSON occurrence graph", async () => {
  let call: any[] = [];
  const stdout = [
    rgMatch("src/a.ts", 2, "export function run() {"),
    rgMatch("src/b.ts", 8, "run();"),
    rgMatch("src/c.ts", 3, "const callback = run;"),
  ].join("\n");
  const { tools } = setup(async (...args) => { call = args; return { code: 0, stdout, stderr: "" }; });
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "run", path: "src", glob: "*.ts", max_results: 2 }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.equal(result.content[0].text.includes("\n"), false);
  assert.equal(call[0], "rg");
  assert.ok(call[1].includes("--json"));
  assert.ok(call[1].includes("--word-regexp"));
  assert.deepEqual(call[1].slice(-2), ["run", "src"]);
  assert.equal(graph.heuristic, true);
  assert.equal(graph.metadata.observedMatchCount, 3);
  assert.equal(graph.metadata.returnedCount, 2);
  assert.equal(graph.metadata.truncated, true);
  assert.deepEqual(graph.nodes.find((node: any) => node.id === "location:src/a.ts:2").roles,
    ["possible_definition", "possible_export"]);
  assert.ok(graph.edges.some((edge: any) => edge.type === "contains"));
  assert.ok(graph.edges.some((edge: any) => edge.type === "mentions"));
});

test("relationship_graph returns a valid empty graph and confines paths", async () => {
  const { tools } = setup(async () => ({ code: 1, stdout: "", stderr: "" }));
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "missing" }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.equal(graph.metadata.observedMatchCount, 0);
  assert.equal(graph.nodes.length, 1);
  await assert.rejects(() => tools.get("relationship_graph").execute(
    "id", { query: "missing", path: "../outside" }, undefined, undefined, { cwd: process.cwd() },
  ), /stay within workspace/);
});

test("relationship_graph deduplicates locations, reports malformed output, and avoids word mode for punctuation", async () => {
  let args: string[] = [];
  const match = rgMatch("src/a.ts", 4, "$run();");
  const { tools } = setup(async (_command, commandArgs) => {
    args = commandArgs;
    return { code: 0, stdout: `${match}\n${match}\nnot-json`, stderr: "" };
  });
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "$run" }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.ok(args.includes("--no-config"));
  assert.ok(!args.includes("--word-regexp"));
  assert.equal(graph.metadata.observedMatchCount, 1);
  assert.equal(graph.metadata.malformedEvents, 1);
  assert.equal(graph.nodes.filter((node: any) => node.kind === "location").length, 1);
});

test("relationship_graph rejects whitespace-only direct execution", async () => {
  const { tools } = setup();
  await assert.rejects(() => tools.get("relationship_graph").execute(
    "id", { query: "   " }, undefined, undefined, { cwd: process.cwd() },
  ), /non-whitespace token/);
});

test("keyword ranking is deterministic and excludes active search tool", () => {
  const tools = [
    { name: "beta_search", description: "web documents" },
    { name: "alpha_search", description: "web documents" },
    { name: "unrelated", description: "nothing" },
  ];
  assert.deepEqual(keywordRankTools(tools, "search web", 3).map((tool) => tool.name), ["alpha_search", "beta_search"]);
  assert.deepEqual(rankInactiveTools([...tools, { name: "search_tools", description: "web search" }], ["beta_search"], "web", 3).map((tool) => tool.name), ["alpha_search"]);
});

test("query normalization and structured metadata outrank description overlap", () => {
  assert.equal(normalizedQuery("  Web, SEARCH web! "), "search web");
  const tools = [
    { name: "browser", description: "miscellaneous" },
    { name: "page_reader", capabilities: ["browser"], description: "read pages" },
    { name: "alpha", description: "browser browser" },
  ];
  assert.deepEqual(keywordRankTools(tools, "BROWSER", 3).map((tool) => tool.name), ["browser", "page_reader", "alpha"]);
  assert.equal(keywordRankTools([
    { name: "zeta", aliases: ["public web"] },
    { name: "alpha", capabilities: ["web public"] },
  ], "Public WEB", 2)[0].name, "alpha");
});

test("search_tools uses exactly one synchronous capability and activates eligible matches", async () => {
  const { events, tools, getSetActiveCalls } = setup();
  const selected: string[][] = [];
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history"],
    select: (names: string[]) => { selected.push(names); return { selected: names }; },
    reset: () => ({ reset: true }),
  }));
  const result = await tools.get("search_tools").execute("id", { query: "search history" }, undefined, undefined, {});
  assert.deepEqual(selected, [["git_history"]]);
  assert.equal(getSetActiveCalls(), 0);
  assert.match(result.content[0].text, /next model turn/i);
  assert.deepEqual(result.details.matches, ["git_history"]);
});

test("search_tools caches normalized searches within a turn", async () => {
  const { events, tools } = setup();
  const selected: string[][] = [];
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history"],
    select: (names: string[]) => { selected.push(names); return { selected: names }; },
    reset: () => ({ selected: [] }),
  }));
  const first = await tools.get("search_tools").execute("id-1", { query: "History SEARCH" }, undefined, undefined, {});
  const second = await tools.get("search_tools").execute("id-2", { query: "search history history" }, undefined, undefined, {});
  assert.equal(first.details.cacheHit, false);
  assert.equal(second.details.cacheHit, true);
  assert.deepEqual(selected, [["git_history"], ["git_history"]]);
});

test("search_tools marks repeated misses and invalidates them on turn end or inventory change", async () => {
  const { active, events, lifecycle, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["shell"], select: () => ({ selected: [] }), reset: () => ({ selected: [] }),
  }));
  const search = () => tools.get("search_tools").execute("id", { query: "browser" }, undefined, undefined, {});
  assert.equal((await search()).details.alreadySearched, false);
  const repeated = await search();
  assert.equal(repeated.details.alreadySearched, true);
  assert.match(repeated.content[0].text, /already searched/i);
  assert.match(repeated.details.missMarker.query, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(repeated.details.missMarker), /browser/);
  lifecycle.emit("turn_end", {});
  assert.equal((await search()).details.alreadySearched, false);
  active.push("other_tool");
  assert.equal((await search()).details.alreadySearched, false);
});

test("discovery health exposes aggregate signals without raw queries", async () => {
  const { events, lifecycle, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history", "shell"],
    select: (names: string[]) => ({ selected: names, blocked: [] }),
    reset: () => ({ selected: [] }),
  }));
  await tools.get("search_tools").execute("id-1", { query: "private history phrase" }, undefined, undefined, {});
  lifecycle.emit("tool_call", { toolName: "git_history" });
  await tools.get("search_tools").execute("id-2", { query: "unmatched browser phrase" }, undefined, undefined, {});
  const reports: any[] = [];
  events.emit("pylon:health-request", { version: 1, respond: (value: any) => reports.push(value) });
  const text = reports[0].lines.join("\n");
  assert.match(text, /git_history=1/);
  assert.match(text, /misses: 1/);
  assert.match(text, /later invoked: git_history=1/);
  assert.doesNotMatch(text, /private|browser phrase/);
});

test("selection reports blocked tools and counts only callable tools as later invoked", async () => {
  const { events, lifecycle, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history", "web_lookup"],
    select: (names: string[]) => ({ selected: names, blocked: ["git_history", "not_requested"] }),
    reset: () => ({ selected: [] }),
  }));
  const result = await tools.get("search_tools").execute("id", { query: "search" }, undefined, undefined, {});
  assert.deepEqual(result.details.selected, ["git_history", "web_lookup"]);
  assert.deepEqual(result.details.blocked, ["git_history"]);
  assert.match(result.content[0].text, /blocked by current policy: git_history/i);
  lifecycle.emit("tool_call", { toolName: "git_history" });
  lifecycle.emit("tool_call", { toolName: "web_lookup" });
  const reports: any[] = [];
  events.emit("pylon:health-request", { version: 1, respond: (value: any) => reports.push(value) });
  assert.match(reports[0].lines.join("\n"), /later invoked: web_lookup=1/);
});

test("search_tools rejects invalid limits", async () => {
  const { events, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history"], select: () => ({ selected: [] }), reset: () => ({ selected: [] }),
  }));
  for (const limit of [0, 7, 1.5]) {
    const result = await tools.get("search_tools").execute("id", { query: "history", limit }, undefined, undefined, {});
    assert.equal(result.details.failureCode, "invalid_limit");
  }
});

test("search_tools does not change tools when Pylon coordination is absent", async () => {
  const { tools, getSetActiveCalls } = setup();
  const result = await tools.get("search_tools").execute("id", { query: "web" }, undefined, undefined, {});
  assert.equal(getSetActiveCalls(), 0);
  assert.match(result.content[0].text, /coordination is unavailable/i);
});

test("selection failures are reported without claiming activation", async () => {
  const { events, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history"],
    select: () => ({ error: "forced failure" }),
    reset: () => ({ selected: [] }),
  }));
  const result = await tools.get("search_tools").execute("id", { query: "history" }, undefined, undefined, {});
  assert.match(result.content[0].text, /activation failed/i);
  assert.equal(result.details.failureCode, "selection_failed");
});

test("successful reset clears repeated-miss state", async () => {
  const { events, tools } = setup();
  let resets = 0;
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => [], select: () => undefined, reset: () => { resets++; return { reset: true }; },
  }));
  const search = () => tools.get("search_tools").execute("search", { query: "browser" }, undefined, undefined, {});
  await search();
  assert.equal((await search()).details.alreadySearched, true);
  const result = await tools.get("search_tools").execute("reset", { action: "reset" }, undefined, undefined, {});
  assert.equal(resets, 1);
  assert.match(result.content[0].text, /reset/i);
  assert.equal((await search()).details.alreadySearched, false);
});

test("failed reset retains repeated-miss state", async () => {
  const { events, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => [], select: () => undefined, reset: () => ({ error: "forced failure" }),
  }));
  const search = () => tools.get("search_tools").execute("search", { query: "browser" }, undefined, undefined, {});
  await search();
  await tools.get("search_tools").execute("reset", { action: "reset" }, undefined, undefined, {});
  assert.equal((await search()).details.alreadySearched, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
import discover, { formatToolDiscoveryGuidance, keywordRankTools, normalizedQuery, rankInactiveTools, relationshipRoles } from "../extensions/pi-discover.ts";
import registerDiscoverChildTools, { DISCOVER_CHILD_MAX_BYTES } from "../src/discover-child-tools.ts";
import { extractSymbols, indexDatabasePath, registerIndexTools, WorkspaceIndex } from "../src/index.ts";
import { registerRelationshipGraph } from "../src/relationship-graph.ts";
import { registerSessionSearch, registerSessionStats, searchSessions, sessionStats, type SessionSource } from "../src/sessions.ts";

class Bus {
  handlers = new Map<string, ((...values: any[]) => any)[]>();
  on(name: string, handler: (...values: any[]) => any) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
  }
  emit(name: string, ...values: any[]) {
    for (const handler of this.handlers.get(name) ?? []) handler(...values);
  }
  async emitAsync(name: string, ...values: any[]) {
    await Promise.all((this.handlers.get(name) ?? []).map((handler) => handler(...values)));
  }
}

function setup(exec: (...args: any[]) => Promise<any> = async () => ({ code: 0, stdout: "", stderr: "" })) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Bus();
  const lifecycle = new Bus();
  const active = ["read", "rg", "fd", "relationship_graph", "symbol_search", "code_search", "index_status", "search_sessions", "session_stats", "search_tools"];
  let setActiveCalls = 0;
  const pi: any = {
    events,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getActiveTools: () => active,
    getAllTools: () => [
      { name: "read", description: "Read files" },
      { name: "rg", description: "Search repository content" },
      { name: "fd", description: "Find paths" },
      { name: "relationship_graph", description: "Map source relationships" },
      { name: "symbol_search", description: "Search indexed symbols" },
      { name: "code_search", description: "Search indexed code" },
      { name: "index_status", description: "Report index status" },
      { name: "search_sessions", description: "Search historical Pi sessions" },
      { name: "session_stats", description: "Inspect historical Pi session statistics" },
      { name: "search_tools", description: "Find inactive tools" },
      { name: "git_history", description: "Search commit history and changes" },
      { name: "web_lookup", description: "Search public web pages" },
      { name: "shell", description: "Run shell commands" },
    ],
    setActiveTools: (names: string[]) => { active.splice(0, active.length, ...names); setActiveCalls++; },
    on: (name: string, handler: (value: any, ctx?: any) => void) => lifecycle.on(name, handler),
    exec,
  };
  discover(pi);
  return { active, commands, events, lifecycle, tools, getSetActiveCalls: () => setActiveCalls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sessionSource(sessions: any[], branches: Record<string, any[]>): SessionSource {
  return {
    async listAll() { return sessions; },
    open(path: string) { return { getBranch: () => branches[path] ?? [] } as any; },
  };
}

test("session search scopes by cwd, excludes the active session, redacts, and accepts an exact session id", async () => {
  const cwd = process.cwd();
  const other = join(cwd, "other-workspace");
  const sessions = [
    { id: "current", path: "current", cwd, modified: new Date("2026-01-03"), allMessagesText: "OAuth current" },
    { id: "same-cwd", path: "same", cwd, modified: new Date("2026-01-02"), allMessagesText: "OAuth decision" },
    { id: "other-cwd", path: "other", cwd: other, modified: new Date("2026-01-01"), allMessagesText: "" },
  ];
  const branches = {
    current: [{ type: "message", message: { role: "user", content: "OAuth current" } }],
    same: [{ type: "message", message: { role: "assistant", content: `OAuth api_key=sk-${"x".repeat(40)}` } }],
    other: [{ type: "message", message: { role: "user", content: "OAuth elsewhere" } }],
  };
  const source = sessionSource(sessions, branches);

  const local = await searchSessions({ query: "OAuth", cwd, currentSessionId: "current" }, source);
  assert.deepEqual(local.matches.map((match) => match.sessionId), ["same-cwd"]);
  assert.ok(local.redactionCount >= 1);
  assert.doesNotMatch(local.matches[0].text, /sk-/);

  const selected = await searchSessions({ query: "OAuth", cwd, currentSessionId: "current", sessionId: "other-cwd", scope: "all" }, source);
  assert.deepEqual(selected.matches.map((match) => match.sessionId), ["other-cwd"]);
  assert.equal(selected.sessionLookup, "found");
  const outside = await searchSessions({ query: "OAuth", cwd, sessionId: "other-cwd" }, source);
  assert.equal(outside.matches.length, 0);
  assert.equal(outside.sessionLookup, "outside_scope");
  assert.equal((await searchSessions({ query: "OAuth", cwd, currentSessionId: "current", sessionId: "current" }, source)).sessionLookup, "active_session");
  assert.equal((await searchSessions({ query: "OAuth", cwd, sessionId: "missing" }, source)).sessionLookup, "not_found");
});

test("session search reports truncation only when session or match limits overflow", async () => {
  const cwd = process.cwd();
  const sessions = Array.from({ length: 201 }, (_, index) => ({
    id: `session-${index}`, path: `session-${index}`, cwd, modified: new Date("2026-01-01"), allMessagesText: "",
  }));
  const emptyBranches = Object.fromEntries(sessions.map((session) => [session.path, []]));
  assert.equal((await searchSessions({ query: "needle", cwd }, sessionSource(sessions.slice(0, 200), emptyBranches))).truncated, false);
  assert.equal((await searchSessions({ query: "needle", cwd }, sessionSource(sessions, emptyBranches))).truncated, true);

  const messages = Array.from({ length: 13 }, (_, index) => ({ type: "message", message: { role: "user", content: `needle ${index}` } }));
  const oneSession = [sessions[0]];
  assert.equal((await searchSessions({ query: "needle", cwd }, sessionSource(oneSession, { "session-0": messages.slice(0, 12) }))).truncated, false);
  const overflow = await searchSessions({ query: "needle", cwd }, sessionSource(oneSession, { "session-0": messages }));
  assert.equal(overflow.matches.length, 12);
  assert.equal(overflow.truncated, true);
});

test("session stats aggregates branch usage and completed tool results without returning content", async () => {
  const cwd = process.cwd();
  const sessions = [
    { id: "target", path: "target", cwd, modified: new Date("2026-01-01"), allMessagesText: "" },
    { id: "current", path: "current", cwd, modified: new Date("2026-01-02"), allMessagesText: "" },
    { id: "other", path: "other", cwd: join(cwd, "other"), modified: new Date("2026-01-03"), allMessagesText: "" },
    { id: "broken", path: "broken", cwd, modified: new Date("2026-01-04"), allMessagesText: "" },
  ];
  const source: SessionSource = {
    async listAll() { return sessions as any; },
    open(path) {
      if (path === "broken") throw new Error("unreadable");
      return { getBranch: () => path === "target" ? [
        { type: "message", message: {
          role: "assistant",
          usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 100, cost: { total: 0.5 } },
          content: [
            { type: "toolCall", id: "advisor-call", name: "advisor", arguments: { request: "private request" } },
            { type: "toolCall", id: "read-call", name: "read", arguments: { path: "private.ts" } },
            { type: "toolCall", id: "pending-call", name: "write", arguments: { path: "private.ts" } },
          ],
        } },
        { type: "message", message: {
          role: "toolResult", toolCallId: "advisor-call", toolName: "advisor",
          content: [{ type: "text", text: "private advice" }], isError: false,
          details: { usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 10, cost: 0.1 } },
        } },
        { type: "message", message: {
          role: "toolResult", toolCallId: "read-call", toolName: "read",
          content: [{ type: "image", data: "private image" }], isError: true,
        } },
      ] : [] } as any;
    },
  };

  const result = await sessionStats({ sessionId: "target", cwd, currentSessionId: "current" }, source);
  assert.equal(result.sessionLookup, "found");
  assert.equal(result.branchScope, "current");
  assert.equal(result.branchEntries, 3);
  assert.deepEqual(result.usage?.main, {
    turns: 1, input: 100, output: 20, cacheRead: 300, cacheWrite: 100, cost: 0.5, cacheReadRate: 0.6,
  });
  assert.deepEqual(result.usage?.children, {
    turns: 1, input: 10, output: 2, cacheRead: 30, cacheWrite: 10, cost: 0.1, cacheReadRate: 0.6,
  });
  assert.deepEqual(result.usage?.total, {
    turns: 2, input: 110, output: 22, cacheRead: 330, cacheWrite: 110, cost: 0.6, cacheReadRate: 0.6,
  });
  assert.deepEqual(result.tools, {
    completedCalls: 2, errors: 1, images: 1, truncated: false,
    byName: [
      { name: "advisor", calls: 1, errors: 0, images: 0 },
      { name: "read", calls: 1, errors: 1, images: 1 },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal((await sessionStats({ sessionId: "missing", cwd }, source)).sessionLookup, "not_found");
  assert.equal((await sessionStats({ sessionId: "current", cwd, currentSessionId: "current" }, source)).sessionLookup, "active_session");
  assert.equal((await sessionStats({ sessionId: "other", cwd }, source)).sessionLookup, "outside_scope");
  const empty = await sessionStats({ sessionId: "other", cwd, scope: "all" }, source);
  assert.equal(empty.sessionLookup, "found");
  assert.equal(empty.usage?.main.cacheReadRate, null);
  assert.equal((await sessionStats({ sessionId: "broken", cwd }, source)).sessionLookup, "unreadable");
});

test("session stats bounds per-tool rows and registered output", async () => {
  const cwd = process.cwd();
  const calls = Array.from({ length: 26 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: `tool-${index}`, arguments: {} }));
  const results = calls.map((call) => ({
    type: "message", message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [], isError: false },
  }));
  const source = sessionSource([
    { id: "target", path: "target", cwd, modified: new Date("2026-01-01"), allMessagesText: "" },
  ], {
    target: [{ type: "message", message: { role: "assistant", content: calls } }, ...results],
  });
  const stats = await sessionStats({ sessionId: "target", cwd }, source);
  assert.equal(stats.tools?.completedCalls, 26);
  assert.equal(stats.tools?.byName.length, 25);
  assert.equal(stats.tools?.truncated, true);

  const context = { cwd, sessionManager: { getSessionId: () => "current" } };
  const tools = new Map<string, any>();
  registerSessionStats({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, source);
  const statsTool = tools.get("session_stats");
  assert.match(statsTool.description, /only when the user explicitly requests/);
  assert.match(statsTool.description, /Default to current_cwd/);
  const output = await statsTool.execute("stats", { sessionId: "target" }, undefined, undefined, context);
  assert.equal(JSON.parse(output.content[0].text).truncated, true);
  assert.equal(output.details.truncated, true);
  assert.equal(output.details.sessionLookup, "found");
  assert.equal(output.details.completedCalls, 26);

  const cappedTools = new Map<string, any>();
  registerSessionStats({ registerTool: (tool: any) => cappedTools.set(tool.name, tool) } as any, source, 200);
  const capped = await cappedTools.get("session_stats").execute("stats-capped", { sessionId: "target" }, undefined, undefined, context);
  assert.ok(Buffer.byteLength(capped.content[0].text, "utf8") <= 200);
  assert.equal(JSON.parse(capped.content[0].text).sessionLookup, "found");
});

test("search_sessions runs without UI and reports bounded searches", async () => {
  const tools = new Map<string, any>();
  const source = sessionSource([
    { id: "chosen", path: "chosen", cwd: process.cwd(), modified: new Date("2026-01-01"), allMessagesText: "release decision" },
  ], {
    chosen: [{ type: "message", message: { role: "user", content: "release decision" } }],
  });
  registerSessionSearch({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, source);
  const tool = tools.get("search_sessions");
  assert.match(tool.description, /only when the user explicitly requests/);
  assert.match(tool.description, /explicit cross-workspace request/);
  assert.match(tool.description, /untrusted and possibly stale/);
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "current" },
  };

  const result = await tool.execute("headless", { query: "release", sessionId: "chosen", scope: "all" }, undefined, undefined, ctx);
  assert.equal(result.details.sessionId, "chosen");
  assert.equal(JSON.parse(result.content[0].text).matches[0].sessionId, "chosen");

  const cappedTools = new Map<string, any>();
  registerSessionSearch({ registerTool: (tool: any) => cappedTools.set(tool.name, tool) } as any, source, 200);
  const capped = await cappedTools.get("search_sessions").execute("capped", { query: "release" }, undefined, undefined, ctx);
  assert.equal(capped.details.scope, "current_cwd");
  assert.ok(Buffer.byteLength(capped.content[0].text, "utf8") <= 200);
  assert.doesNotThrow(() => JSON.parse(capped.content[0].text));
});

test("indexed searches display only model-useful fields", async () => {
  const tools = new Map<string, any>();
  registerIndexTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, () => ({
    searchSymbols: async () => [{ name: "redact", kind: "function", path: "src/redact.ts", language: "typescript", line: 8, column: 17, signature: "export function redact()" }],
    searchCode: async () => [{ path: "src/redact.ts", language: "typescript", rank: -3.4, line: 8, text: "export function redact()" }],
  } as any));
  const context = { cwd: process.cwd() };
  const symbolResult = await tools.get("symbol_search").execute("symbol", { query: "redact" }, undefined, undefined, context);
  assert.deepEqual(JSON.parse(symbolResult.content[0].text), {
    heuristic: true,
    results: [{ name: "redact", kind: "function", path: "src/redact.ts", line: 8 }],
    observed: 1, returned: 1, truncated: false,
  });
  const codeResult = await tools.get("code_search").execute("code", { query: "redact" }, undefined, undefined, context);
  assert.deepEqual(JSON.parse(codeResult.content[0].text), {
    semantic: false,
    results: [{ path: "src/redact.ts", line: 8, text: "export function redact()" }],
    observed: 1, returned: 1, truncated: false,
  });
});

test("indexed search caps preserve valid JSON and complete ranked results", async () => {
  const tools = new Map<string, any>();
  const rows = Array.from({ length: 20 }, (_, index) => ({
    name: `symbol_${index}_${"界".repeat(30)}`, kind: "function", path: `src/file-${index}.ts`, line: index + 1,
  }));
  const symbolRows = Object.assign(rows, { moreAvailable: true });
  const codeRows = Object.assign(rows.map(({ path, line }) => ({ path, line, text: "界".repeat(100) })), { moreAvailable: true });
  registerIndexTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, () => ({
    searchSymbols: async () => symbolRows,
    searchCode: async () => codeRows,
  } as any), 600);
  for (const name of ["symbol_search", "code_search"]) {
    const result = await tools.get(name).execute("id", { query: "symbol", limit: 20 }, undefined, undefined, { cwd: process.cwd() });
    assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 600);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.observed, 20);
    assert.ok(parsed.returned < 20);
    assert.equal(parsed.results.length, parsed.returned);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.moreAvailable, true);
  }
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
  events.emit("pi-discover:child-tools-capability", { version: 2, respond: (value: any) => responses.push(value) });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].version, 2);
  assert.equal(responses[0].owner, "pi-discover");
  assert.deepEqual(responses[0].toolNames, ["rg", "fd", "relationship_graph", "symbol_search", "code_search", "index_status"]);
  assert.match(responses[0].childExtensionPath, /discover-child-tools\.ts$/);
  await access(responses[0].childExtensionPath);
});

test("index database lives under pi-discover and migrates the legacy path", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-discover-agent-"));
  const legacy = join(agentDir, "indexes", "pi-discover.sqlite");
  const expected = join(agentDir, "pi-discover", "index.sqlite");
  const previousPath = process.env.PI_DISCOVER_INDEX_PATH;
  delete process.env.PI_DISCOVER_INDEX_PATH;
  await mkdir(join(agentDir, "indexes"));
  new DatabaseSync(legacy).close();
  try {
    assert.equal(indexDatabasePath(agentDir), expected);
    await access(expected);
    await assert.rejects(access(legacy));
  } finally {
    if (previousPath === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previousPath;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SQLite index migrates schema 1 by purging and rebuilding derived rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-migration-"));
  const sourcePath = join(root, "current.ts");
  const dbPath = join(root, "index.sqlite");
  await writeFile(sourcePath, "export function currentSymbol() {}\n");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, head TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', indexed_at INTEGER);
    CREATE TABLE files (
      id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL,
      content TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
      UNIQUE(repo_id, path)
    );
    INSERT INTO repositories(id,root,head) VALUES (1,'stale-root','stale-head');
    INSERT INTO files(repo_id,path,language,content,hash,size) VALUES (1,'stale.ts','typescript','stale','hash',5);
    PRAGMA user_version=1;
  `);
  legacy.close();
  const executor = async (_command: string, args: string[]) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
    if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (gitArgs[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (gitArgs[0] === "ls-files") return { code: 0, stdout: gitArgs.includes("--stage") ? "" : "current.ts\0", stderr: "" };
    if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected git call: ${gitArgs.join(" ")}`);
  };
  const index = new WorkspaceIndex(root, executor, dbPath);
  try {
    await index.rebuild();
    assert.equal((await index.searchSymbols(root, { query: "currentSymbol" }) as any[])[0].path, "current.ts");
    const migrated = new DatabaseSync(dbPath);
    try {
      assert.equal((migrated.prepare("PRAGMA user_version").get() as any).user_version, 3);
      assert.equal((migrated.prepare("SELECT count(*) AS count FROM workspaces").get() as any).count, 1);
      assert.equal((migrated.prepare("SELECT count(*) AS count FROM files WHERE path='stale.ts'").get() as any).count, 0);
      assert.equal((migrated.prepare("SELECT count(*) AS count FROM files WHERE path='current.ts'").get() as any).count, 1);
    } finally {
      migrated.close();
    }
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol extraction covers common language declarations", () => {
  assert.deepEqual(extractSymbols("export function run() {}\nconst later = async () => 1\nconst typed: Handler = async (value: string): Promise<void> => {}\nclass Worker {\n  async execute(): Promise<void> {}\n}", "typescript").map(({ name, kind }) => ({ name, kind })), [
    { name: "run", kind: "function" }, { name: "later", kind: "function" }, { name: "typed", kind: "function" },
    { name: "Worker", kind: "class" }, { name: "execute", kind: "function" },
  ]);
  assert.deepEqual(extractSymbols("public class Worker {\n  public void run() {}\n}", "java").map(({ name }) => name), ["Worker", "run"]);
  assert.deepEqual(extractSymbols("public class Worker {\n  public async Task Run() => done;\n}", "csharp").map(({ name }) => name), ["Worker", "Run"]);
  assert.deepEqual(extractSymbols("int run(void) { return 0; }", "c").map(({ name }) => name), ["run"]);
  assert.deepEqual(extractSymbols("class Worker:\n    async def execute(self):", "python").map(({ name, kind }) => ({ name, kind })), [
    { name: "Worker", kind: "class" }, { name: "execute", kind: "function" },
  ]);
  assert.deepEqual(extractSymbols("sealed class Worker {}\nenum State { ready }\nmixin Logging {}\nextension Labels on String {}\nextension type UserId(int value) {}\ntypedef Callback = void Function();\nFuture<void> execute() async {}\nString label() => 'ready';", "dart").map(({ name, kind }) => ({ name, kind })), [
    { name: "Worker", kind: "class" }, { name: "State", kind: "enum" }, { name: "Logging", kind: "mixin" },
    { name: "Labels", kind: "extension" }, { name: "UserId", kind: "extension type" }, { name: "Callback", kind: "typedef" },
    { name: "execute", kind: "function" }, { name: "label", kind: "function" },
  ]);
});

test("SQLite index refreshes changed, restored, and deleted files atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-index-"));
  const sourcePath = join(root, "src", "a.ts");
  const dbPath = join(root, "index.sqlite");
  const original = "export function alpha() { return 'authentication middleware'; }\n";
  let status = "";
  await mkdir(join(root, "src"));
  await writeFile(sourcePath, original);
  const exec = async (_command: string, args: string[]) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
    if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (gitArgs[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (gitArgs[0] === "ls-files") {
      if (gitArgs.includes("--stage")) return { code: 0, stdout: "", stderr: "" };
      assert.equal(gitArgs.includes("--full-name"), true);
      return { code: 0, stdout: "src/a.ts\0", stderr: "" };
    }
    if (gitArgs[0] === "status") return { code: 0, stdout: status, stderr: "" };
    throw new Error(`unexpected git call: ${gitArgs.join(" ")}`);
  };
  const index = new WorkspaceIndex(root, exec, dbPath);
  try {
    await index.refresh();
    assert.deepEqual((await index.searchSymbols(root, { query: "alpha" }) as any[]).map((row) => row.name), ["alpha"]);
    assert.equal((await index.searchCode(root, { query: "authentication middleware" }) as any[])[0].path, "src/a.ts");

    await writeFile(sourcePath, "export function beta() { return 'changed token'; }\n");
    status = " M src/a.ts\0";
    await index.refresh();
    assert.deepEqual((await index.searchSymbols(root, { query: "beta" }) as any[]).map((row) => row.name), ["beta"]);

    await writeFile(sourcePath, original);
    status = "";
    await index.refresh();
    assert.deepEqual((await index.searchSymbols(root, { query: "alpha" }) as any[]).map((row) => row.name), ["alpha"]);

    await rm(sourcePath);
    status = " D src/a.ts\0";
    await index.refresh();
    assert.equal((await index.searchSymbols(root, { query: "alpha" }) as any[]).length, 0);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite index prunes workspaces, repositories, and FTS rows for missing directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-discover-prune-"));
  const live = join(parent, "live");
  const stale = join(parent, "stale");
  const dbPath = join(parent, "index.sqlite");
  await Promise.all([mkdir(live), mkdir(stale)]);
  await Promise.all([
    writeFile(join(live, "app.ts"), "export function liveProject() {}\n"),
    writeFile(join(stale, "app.ts"), "export function staleProject() {}\n"),
  ]);
  const executor = async (_command: string, args: string[]) => {
    const cwd = args[1];
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") return { code: 0, stdout: `${cwd}\n`, stderr: "" };
    if (gitArgs[0] === "rev-parse") return { code: 0, stdout: `${cwd === live ? "live" : "stale"}-head\n`, stderr: "" };
    if (gitArgs[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (gitArgs[0] === "ls-files") return { code: 0, stdout: gitArgs.includes("--stage") ? "" : "app.ts\0", stderr: "" };
    if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected git call: ${gitArgs.join(" ")}`);
  };
  const liveIndex = new WorkspaceIndex(live, executor, dbPath);
  const staleIndex = new WorkspaceIndex(stale, executor, dbPath);
  try {
    await liveIndex.refresh();
    await staleIndex.refresh();
    await rm(stale, { recursive: true, force: true });

    assert.deepEqual(await liveIndex.prune(), {
      removedWorkspaces: 1,
      removedRepositories: 1,
      removedFiles: 1,
    });
    const database = new DatabaseSync(dbPath);
    try {
      assert.deepEqual({
        workspaces: Number((database.prepare("SELECT count(*) AS count FROM workspaces").get() as any).count),
        repositories: Number((database.prepare("SELECT count(*) AS count FROM repositories").get() as any).count),
        files: Number((database.prepare("SELECT count(*) AS count FROM files").get() as any).count),
        fts: Number((database.prepare("SELECT count(*) AS count FROM code_fts").get() as any).count),
        symbols: Number((database.prepare("SELECT count(*) AS count FROM symbols").get() as any).count),
      }, { workspaces: 1, repositories: 1, files: 1, fts: 1, symbols: 1 });
    } finally {
      database.close();
    }
    assert.deepEqual((await liveIndex.searchSymbols(live, { query: "liveProject" }) as any[]).map((row) => row.name), ["liveProject"]);
  } finally {
    await Promise.all([liveIndex.close(), staleIndex.close()]);
    await rm(parent, { recursive: true, force: true });
  }
});

test("full refresh tracks dirty files, queries refresh on demand, and code search ignores filename-only hits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-fresh-"));
  const dbPath = join(root, "index.sqlite");
  const sourcePath = join(root, "filenameonly.ts");
  const runGit = (...args: string[]) => execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  const executor = async (command: string, args: string[]) => {
    try {
      const result = await execFileAsync(command, args, { encoding: "utf8" });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
    }
  };
  try {
    await runGit("init", "-q");
    await runGit("config", "user.email", "test@example.com");
    await runGit("config", "user.name", "Test");
    await writeFile(sourcePath, "export function run() {}\nexport function runner() {}\nexport function outrun() {}\n");
    for (let index = 0; index < 12; index++)
      await writeFile(join(root, `shared-${index}.ts`), `export const value${index} = 'shared searchable phrase';\n`);
    await runGit("add", ".");
    await runGit("commit", "-qm", "initial");
    await writeFile(sourcePath, "export function dirtyOnly() { return 'dirty content'; }\n");

    const index = new WorkspaceIndex(root, executor, dbPath);
    try {
      await index.refresh();
      assert.equal((await index.searchSymbols(root, { query: "dirtyOnly" }) as any[]).length, 1);
      await runGit("checkout", "--", "filenameonly.ts");
      assert.deepEqual((await index.searchSymbols(root, { query: "run" }) as any[]).map((row) => row.name), ["run", "runner", "outrun"]);
      assert.equal((await index.searchSymbols(root, { query: "dirtyOnly" }) as any[]).length, 0);
      assert.equal((await index.searchCode(root, { query: "filenameonly" }) as any[]).length, 0);
      const codeResults = await index.searchCode(root, { query: "shared searchable" }) as any;
      assert.equal(codeResults.length, 10);
      assert.equal(codeResults.moreAvailable, true);
      await assert.rejects(() => index.searchSymbols(root, { query: "   " }), /non-whitespace/);
      await assert.rejects(() => index.searchCode(root, { query: "   " }), /non-whitespace/);
    } finally {
      await index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite index deduplicates gitlinks across aggregate and child workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-gitlink-"));
  const child = join(root, "child repo");
  const source = join(child, "nested.ts");
  const dbPath = join(root, "index.sqlite");
  const runGit = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const executor = async (command: string, args: string[]) => {
    try {
      const result = await execFileAsync(command, args, { encoding: "utf8" });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
    }
  };
  const counts = () => {
    const database = new DatabaseSync(dbPath);
    try {
      return {
        repositories: Number((database.prepare("SELECT count(*) AS count FROM repositories").get() as any).count),
        workspaces: Number((database.prepare("SELECT count(*) AS count FROM workspaces").get() as any).count),
        files: Number((database.prepare("SELECT count(*) AS count FROM files").get() as any).count),
        fts: Number((database.prepare("SELECT count(*) AS count FROM code_fts").get() as any).count),
        symbols: Number((database.prepare("SELECT count(*) AS count FROM symbols").get() as any).count),
      };
    } finally {
      database.close();
    }
  };
  await mkdir(child);
  try {
    await runGit(root, "init", "-q");
    await runGit(root, "config", "user.email", "test@example.com");
    await runGit(root, "config", "user.name", "Test");
    await runGit(child, "init", "-q");
    await runGit(child, "config", "user.email", "test@example.com");
    await runGit(child, "config", "user.name", "Test");
    await writeFile(source, "export function nestedAlpha() { return 'shared content'; }\n");
    await runGit(child, "add", ".");
    await runGit(child, "commit", "-qm", "initial child");
    await runGit(root, "add", "child repo");
    await runGit(root, "commit", "-qm", "track gitlink");
    await assert.rejects(access(join(root, ".gitmodules")));

    const aggregateIndex = new WorkspaceIndex(root, executor, dbPath);
    const childIndex = new WorkspaceIndex(child, executor, dbPath);
    try {
      await aggregateIndex.rebuild();
      assert.deepEqual(counts(), { repositories: 2, workspaces: 1, files: 1, fts: 1, symbols: 1 });
      assert.equal((await aggregateIndex.searchSymbols(root, { query: "nestedAlpha", path: "child repo" }) as any[])[0].path, "child repo/nested.ts");
      assert.equal((await aggregateIndex.searchCode(root, { query: "shared content" }) as any[])[0].path, "child repo/nested.ts");

      await childIndex.rebuild();
      assert.deepEqual(counts(), { repositories: 2, workspaces: 2, files: 1, fts: 1, symbols: 1 });
      assert.equal((await childIndex.searchSymbols(child, { query: "nestedAlpha" }) as any[])[0].path, "nested.ts");
      assert.equal((await childIndex.searchCode(child, { query: "shared content" }) as any[])[0].path, "nested.ts");

      const database = new DatabaseSync(dbPath);
      try {
        assert.equal(database.prepare("UPDATE workspaces SET root=? WHERE root=?").run(join(root, "missing"), root).changes, 1);
      } finally {
        database.close();
      }
      assert.deepEqual(await childIndex.prune(), { removedWorkspaces: 1, removedRepositories: 0, removedFiles: 0 });
      assert.deepEqual(counts(), { repositories: 2, workspaces: 1, files: 1, fts: 1, symbols: 1 });
      assert.equal((await childIndex.searchSymbols(child, { query: "nestedAlpha" }) as any[])[0].path, "nested.ts");
      await aggregateIndex.refresh();
      assert.deepEqual(counts(), { repositories: 2, workspaces: 2, files: 1, fts: 1, symbols: 1 });

      await writeFile(source, "export function nestedDirty() { return 'updated shared content'; }\n");
      await childIndex.refresh();
      assert.equal((await aggregateIndex.searchSymbols(root, { query: "nestedDirty" }) as any[])[0].path, "child repo/nested.ts");
      assert.equal((await childIndex.searchSymbols(child, { query: "nestedDirty" }) as any[])[0].path, "nested.ts");
      assert.equal((await aggregateIndex.searchCode(root, { query: "updated shared content" }) as any[])[0].path, "child repo/nested.ts");
      assert.equal((await childIndex.searchCode(child, { query: "updated shared content" }) as any[])[0].path, "nested.ts");
      assert.deepEqual(counts(), { repositories: 2, workspaces: 2, files: 1, fts: 1, symbols: 1 });

      await runGit(child, "add", ".");
      await runGit(child, "commit", "-qm", "change child head");
      await aggregateIndex.refresh();
      await rm(source);
      await runGit(child, "add", ".");
      await runGit(child, "commit", "-qm", "delete child source");
      await aggregateIndex.refresh();
      assert.equal((await aggregateIndex.searchSymbols(root, { query: "nestedDirty" }) as any[]).length, 0);
      assert.equal((await childIndex.searchSymbols(child, { query: "nestedDirty" }) as any[]).length, 0);
      assert.equal(counts().files, 0);

      await writeFile(source, "export function retainedChild() {}\n");
      await runGit(child, "add", ".");
      await runGit(child, "commit", "-qm", "restore child source");
      await childIndex.refresh();
      assert.equal((await aggregateIndex.searchSymbols(root, { query: "retainedChild" }) as any[]).length, 1);
      await runGit(root, "rm", "--cached", "-q", "-f", "child repo");
      await runGit(root, "commit", "-qm", "remove gitlink membership");
      await aggregateIndex.refresh();
      assert.equal((await aggregateIndex.searchSymbols(root, { query: "retainedChild" }) as any[]).length, 0);
      assert.equal((await childIndex.searchSymbols(child, { query: "retainedChild" }) as any[])[0].path, "nested.ts");
      assert.deepEqual(counts(), { repositories: 2, workspaces: 2, files: 1, fts: 1, symbols: 1 });
    } finally {
      await Promise.all([aggregateIndex.close(), childIndex.close()]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite index projects one physical repository through two gitlink prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-alias-"));
  const child = join(root, "physical-child");
  const dbPath = join(root, "index.sqlite");
  await mkdir(child);
  await writeFile(join(child, "nested.ts"), "export function aliasedSymbol() {}\n");
  await symlink(child, join(root, "alias-one"), process.platform === "win32" ? "junction" : "dir");
  await symlink(child, join(root, "alias-two"), process.platform === "win32" ? "junction" : "dir");
  const executor = async (_command: string, args: string[]) => {
    const cwd = args[1];
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") return { code: 0, stdout: `${cwd === root ? root : child}\n`, stderr: "" };
    if (gitArgs[0] === "rev-parse") return { code: 0, stdout: `${cwd === root ? "root-head" : "child-head"}\n`, stderr: "" };
    if (gitArgs[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (gitArgs[0] === "ls-files" && gitArgs.includes("--stage")) {
      const entries = [`160000 ${"a".repeat(40)} 0\talias-one`, `160000 ${"a".repeat(40)} 0\talias-two`];
      return { code: 0, stdout: cwd === root ? `${entries.join("\0")}\0` : "", stderr: "" };
    }
    if (gitArgs[0] === "ls-files") return { code: 0, stdout: cwd === child ? "nested.ts\0" : "", stderr: "" };
    if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected git call: ${cwd} ${gitArgs.join(" ")}`);
  };
  const index = new WorkspaceIndex(root, executor, dbPath);
  try {
    await index.rebuild();
    assert.deepEqual((await index.searchSymbols(root, { query: "aliasedSymbol" }) as any[]).map((row) => row.path), [
      "alias-one/nested.ts", "alias-two/nested.ts",
    ]);
    const database = new DatabaseSync(dbPath);
    try {
      assert.equal((database.prepare("SELECT count(*) AS count FROM files").get() as any).count, 1);
      assert.equal((database.prepare("SELECT count(*) AS count FROM code_fts").get() as any).count, 1);
      assert.equal((database.prepare("SELECT count(*) AS count FROM symbols").get() as any).count, 1);
    } finally {
      database.close();
    }
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("host refreshes its SQLite index after each turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-turn-"));
  const sourcePath = join(root, "app.ts");
  const previousPath = process.env.PI_DISCOVER_INDEX_PATH;
  let status = "";
  await writeFile(sourcePath, "export function beforeTurn() {}\n");
  process.env.PI_DISCOVER_INDEX_PATH = join(root, "index.sqlite");
  const runtime = setup(async (_command, args) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
    if (gitArgs[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (gitArgs[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (gitArgs[0] === "ls-files") return { code: 0, stdout: "app.ts\0", stderr: "" };
    if (gitArgs[0] === "status") return { code: 0, stdout: status, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected git call" };
  });
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd: root,
    waitForIdle: async () => undefined,
    ui: {
      notify: (text: string, level: string) => notifications.push({ text, level }),
      setStatus: () => undefined,
    },
  };
  let policy: any;
  const indexStates: any[] = [];
  runtime.events.on("pylon:tool-policy", (value) => {
    if (value?.kind === "register" && value?.owner === "pi-discover") policy = value;
  });
  runtime.events.on("pi-discover:index-state", (value) => indexStates.push(value));
  try {
    await runtime.lifecycle.emitAsync("session_start", {}, ctx);
    assert.deepEqual(policy.managedTools, [
      "search_tools", "symbol_search", "fd", "rg", "code_search",
      "relationship_graph", "index_status", "search_sessions", "session_stats",
    ]);
    assert.deepEqual(policy.enabledTools, policy.managedTools);
    assert.deepEqual(policy.deferredTools, ["relationship_graph", "index_status", "search_sessions", "session_stats"]);
    assert.deepEqual(policy.deferredToolUsage, {
      relationship_graph: "map source symbols or tokens to related files and source locations",
      index_status: "inspect local repository code-index status",
      search_sessions: "search historical Pi sessions when explicitly requested",
      session_stats: "inspect historical Pi session usage and tool-call statistics when explicitly requested",
    });
    assert.ok(!runtime.active.includes("index_status"));
    assert.ok(!runtime.active.includes("relationship_graph"));
    assert.ok(!runtime.active.includes("search_sessions"));
    assert.ok(!runtime.active.includes("session_stats"));
    await waitFor(() => indexStates.at(-1)?.state === "idle");
    assert.equal(indexStates.at(-1)?.state, "idle");
    assert.equal(indexStates.at(-1)?.files, 1);
    assert.match(indexStates.at(-1)?.indexedAt, /^\d{4}-\d{2}-\d{2}T/);
    let result = await runtime.tools.get("symbol_search").execute("one", { query: "beforeTurn" }, undefined, undefined, ctx);
    assert.equal(JSON.parse(result.content[0].text).results[0].name, "beforeTurn");

    await writeFile(sourcePath, "export function manualRebuild() {}\n");
    await runtime.commands.get("discover-index").handler("rebuild", ctx);
    result = await runtime.tools.get("symbol_search").execute("manual", { query: "manualRebuild" }, undefined, undefined, ctx);
    assert.equal(JSON.parse(result.content[0].text).results[0].name, "manualRebuild");
    assert.match(notifications.at(-1)!.text, /rebuild complete/);

    await new Promise<void>((resolve, reject) => runtime.events.emit("pi-discover:index-action", {
      version: 1,
      action: "rebuild",
      acknowledge() {},
      resolve,
      reject,
    }));
    assert.ok(indexStates.some((state) => state.state === "indexing"));
    assert.equal(indexStates.at(-1)?.state, "idle");

    await writeFile(sourcePath, "export function afterTurn() {}\n");
    status = " M app.ts\0";
    await runtime.lifecycle.emitAsync("turn_end", {}, ctx);
    result = await runtime.tools.get("symbol_search").execute("two", { query: "afterTurn" }, undefined, undefined, ctx);
    assert.equal(JSON.parse(result.content[0].text).results[0].name, "afterTurn");

    await runtime.commands.get("discover-index").handler("status", ctx);
    assert.match(notifications.at(-1)!.text, /index status/);

    await runtime.commands.get("discover-index").handler("prune", ctx);
    assert.match(notifications.at(-1)!.text, /prune complete.*"removedWorkspaces":0/);
  } finally {
    await runtime.lifecycle.emitAsync("session_shutdown", {}, ctx);
    if (previousPath === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic indexing does not block session startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-background-"));
  const previousPath = process.env.PI_DISCOVER_INDEX_PATH;
  process.env.PI_DISCOVER_INDEX_PATH = join(root, "index.sqlite");
  let releaseIndex!: () => void;
  let markStarted!: () => void;
  const release = new Promise<void>((resolve) => { releaseIndex = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = setup(async () => {
    markStarted();
    await release;
    return { code: 1, stdout: "", stderr: "stopped" };
  });
  const ctx = { cwd: root };
  try {
    const startup = runtime.lifecycle.emitAsync("session_start", {}, ctx);
    assert.equal(await Promise.race([
      startup.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]), true);
    await started;
    releaseIndex();
    await runtime.lifecycle.emitAsync("session_shutdown", {}, ctx);
  } finally {
    releaseIndex();
    if (previousPath === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
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
  assert.deepEqual(relationshipRoles("run", "run();"), ["possible_call"]);
});

test("relationship_graph returns a bounded JSON occurrence graph", async () => {
  let call: any[] = [];
  const stdout = [
    rgMatch("src/a.ts", 2, "export function run() {"),
    rgMatch("src/b.ts", 8, "run();"),
    rgMatch("src/c.ts", 3, "const callback = run;"),
  ].join("\n");
  const { tools } = setup(async (...args) => {
    call = args;
    return args[1].includes("--files-with-matches")
      ? { code: 0, stdout: "src/a.ts\0src/b.ts\0src/c.ts\0", stderr: "" }
      : { code: 0, stdout, stderr: "" };
  });
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "run", path: "src", glob: "*.ts", max_results: 2 }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.equal(result.content[0].text.includes("\n"), false);
  assert.equal(call[0], "rg");
  assert.ok(call[1].includes("--json"));
  assert.ok(call[1].includes("--word-regexp"));
  assert.deepEqual(call[1].slice(-4), ["run", "src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(graph.heuristic, true);
  assert.equal(graph.metadata.observedMatchCount, 3);
  assert.equal(graph.metadata.returnedCount, 2);
  assert.equal(graph.metadata.truncated, true);
  assert.equal(graph.files.length, 2);
  assert.deepEqual(graph.files[0], {
    path: "src/a.ts",
    locations: [{ line: 2, text: "export function run() {", roles: ["possible_definition", "possible_export"] }],
  });
  assert.equal(call[1][call[1].indexOf("--max-count") + 1], "2");
  assert.ok(call[1].includes("--max-filesize"));
});

test("relationship_graph preserves parseable grouped shape at small byte caps", async () => {
  const tools = new Map<string, any>();
  registerRelationshipGraph({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    exec: async (_command: string, args: string[]) => args.includes("--files-with-matches")
      ? { code: 0, stdout: "src/long.ts\0", stderr: "" }
      : { code: 0, stdout: rgMatch("src/long.ts", 1, "x".repeat(500)), stderr: "" },
  } as any, 80);
  assert.match(tools.get("relationship_graph").description, /confirm important relationships from source/);
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "x" }, undefined, undefined, { cwd: process.cwd() },
  );
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 80);
  assert.ok(Array.isArray(JSON.parse(result.content[0].text).files));
});

test("relationship_graph returns a valid empty graph and confines paths", async () => {
  const { tools } = setup(async () => ({ code: 1, stdout: "", stderr: "" }));
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "missing" }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.equal(graph.metadata.observedMatchCount, 0);
  assert.deepEqual(graph.files, []);
  await assert.rejects(() => tools.get("relationship_graph").execute(
    "id", { query: "missing", path: "../outside" }, undefined, undefined, { cwd: process.cwd() },
  ), /stay within workspace/);
});

test("relationship_graph deduplicates locations, reports malformed output, and avoids word mode for punctuation", async () => {
  let args: string[] = [];
  const match = rgMatch("src/a.ts", 4, "$run();");
  const { tools } = setup(async (_command, commandArgs) => {
    args = commandArgs;
    return commandArgs.includes("--files-with-matches")
      ? { code: 0, stdout: "src/a.ts\0", stderr: "" }
      : { code: 0, stdout: `${match}\n${match}\nnot-json`, stderr: "" };
  });
  const result = await tools.get("relationship_graph").execute(
    "id", { query: "$run" }, undefined, undefined, { cwd: process.cwd() },
  );
  const graph = JSON.parse(result.content[0].text);
  assert.ok(args.includes("--no-config"));
  assert.ok(!args.includes("--word-regexp"));
  assert.equal(graph.metadata.observedMatchCount, 1);
  assert.equal(graph.metadata.malformedEvents, 1);
  assert.equal(graph.files[0].locations.length, 1);
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

test("discovery guidance lists bounded usages without exposing tool names", () => {
  const entries = [
    { name: "z_tool", usage: "capture a consented application window" },
    { name: "a_tool", usage: "research current public web pages" },
    { name: "duplicate", usage: "research current public web pages" },
    { name: "large", usage: "x".repeat(200) },
  ];
  const guidance = formatToolDiscoveryGuidance(entries, 240, 3)!;
  assert.ok(guidance.length <= 240);
  assert.match(guidance, /research current public web pages/);
  assert.match(guidance, /additional deferred capabilities/i);
  assert.doesNotMatch(guidance, /a_tool|z_tool|duplicate|large/);
  assert.equal((guidance.match(/research current public web pages/g) ?? []).length, 1);
});

test("before_agent_start advertises the current deferred usage catalog", () => {
  const { events, lifecycle } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["web_lookup", "git_history"],
    catalog: () => [
      { name: "web_lookup", usage: "research current public web pages" },
      { name: "git_history", usage: "inspect release provenance" },
    ],
    select: () => ({ selected: [] }),
    reset: () => ({ selected: [] }),
  }));
  const handler = lifecycle.handlers.get("before_agent_start")![0];
  const result = handler({
    systemPrompt: "base prompt",
    systemPromptOptions: { selectedTools: ["read", "search_tools"] },
  });
  assert.match(result.systemPrompt, /Deferred tool discovery/);
  assert.match(result.systemPrompt, /research current public web pages/);
  assert.match(result.systemPrompt, /inspect release provenance/);
  assert.doesNotMatch(result.systemPrompt, /web_lookup|git_history/);
  const repeated = handler({
    systemPrompt: "base prompt",
    systemPromptOptions: { selectedTools: ["read", "search_tools"] },
  });
  assert.equal(repeated.systemPrompt, result.systemPrompt);
  assert.equal((repeated.systemPrompt.match(/Deferred tool discovery/g) ?? []).length, 1);
  assert.equal(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } }), undefined);
  assert.equal(handler({ systemPrompt: "base", systemPromptOptions: {} }), undefined);
});

test("old discovery capability ranks descriptions without generated guidance", async () => {
  const { events, lifecycle, tools } = setup();
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["web_lookup"],
    select: (names: string[]) => ({ selected: names }),
    reset: () => ({ selected: [] }),
  }));
  const handler = lifecycle.handlers.get("before_agent_start")![0];
  assert.equal(handler({
    systemPrompt: "base",
    systemPromptOptions: { selectedTools: ["search_tools"] },
  }), undefined);
  const result = await tools.get("search_tools").execute("id", { query: "public pages" }, undefined, undefined, {});
  assert.deepEqual(result.details.matches, ["web_lookup"]);
});

test("search_tools uses advertised usage and activates eligible matches", async () => {
  const { events, tools, getSetActiveCalls } = setup();
  const selected: string[][] = [];
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["git_history"],
    catalog: () => [{ name: "git_history", usage: "inspect release provenance" }],
    select: (names: string[]) => { selected.push(names); return { selected: names }; },
    reset: () => ({ reset: true }),
  }));
  const result = await tools.get("search_tools").execute("id", { query: "release provenance" }, undefined, undefined, {});
  assert.deepEqual(selected, [["git_history"]]);
  assert.equal(getSetActiveCalls(), 0);
  assert.match(result.content[0].text, /next model turn/i);
  assert.equal((result.content[0].text.match(/git_history/g) ?? []).length, 1);
  assert.doesNotMatch(result.content[0].text, /\{"selected"/);
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
  let usage: string | undefined;
  events.on("pylon:tool-discovery", (request) => request.respond({
    eligible: () => ["shell"],
    catalog: () => [{ name: "shell", usage }],
    select: () => ({ selected: [] }),
    reset: () => ({ selected: [] }),
  }));
  const search = () => tools.get("search_tools").execute("id", { query: "browser" }, undefined, undefined, {});
  assert.equal((await search()).details.alreadySearched, false);
  const repeated = await search();
  assert.equal(repeated.details.alreadySearched, true);
  assert.match(repeated.content[0].text, /already searched/i);
  assert.match(repeated.details.missMarker.query, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(repeated.details.missMarker), /browser/);
  usage = "automate browser pages";
  const changedUsage = await search();
  assert.equal(changedUsage.details.cacheHit, false);
  assert.deepEqual(changedUsage.details.matches, ["shell"]);
  lifecycle.emit("turn_end", {});
  usage = undefined;
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

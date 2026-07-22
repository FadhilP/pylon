import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scout, { startsNewRepoSequence } from "../extensions/pi-scout.ts";
import { saveConfig } from "../src/config.ts";
import type { ScoutRun } from "../src/runner.ts";

class Bus {
  handlers = new Map<string, Set<(value: any) => void>>();
  on(name: string, handler: (value: any) => void) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler); this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name: string, value: any) { for (const handler of this.handlers.get(name) ?? []) handler(value); }
}

async function harness(runRepoScout?: Parameters<typeof scout>[1], enabled = true) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-scout-extension-"));
  if (enabled) await saveConfig({ version: 1, disabled: false });
  const events = new Bus();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  let active: string[] = [];
  const pi: any = {
    events,
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools: () => [...active], setActiveTools: (value: string[]) => { active = value; },
    getThinkingLevel: () => "low",
  };
  scout(pi, runRepoScout);
  return { events, tools, handlers, restore() { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; } };
}

function context(overrides: Record<string, unknown> = {}) {
  const model = { provider: "test", id: "web-model" };
  return {
    cwd: process.cwd(), hasUI: true, mode: "tui", model,
    modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "key" }; } },
    ui: { async confirm() { return false; }, setStatus() {} },
    ...overrides,
  };
}

test("historical findings use one persistent before-agent message", async () => {
  const runtime = await harness();
  try {
    assert.equal(runtime.handlers.has("context"), false);
    assert.equal(runtime.handlers.get("before_agent_start")?.length, 1);
  } finally { runtime.restore(); }
});

test("Repo Scout renders collapsed failures with reason", async () => {
  const runtime = await harness();
  try {
    const tool = runtime.tools.get("repo_scout");
    let failureColor = "";
    const rendered = tool.renderResult({
      content: [{ type: "text", text: "Repo scout failed nonfatally: Scout timed out." }],
      details: { model: "test/model", durationMs: 1_250, failureCode: "child_error" },
    }, { expanded: false }, {
      fg: (color: string, text: string) => { failureColor = color; return text; },
    }).render(1_000).map((line: string) => line.trimEnd()).join("\n");
    assert.equal(failureColor, "error");
    assert.equal(rendered, "Scout failed · test/model · 1s\nRepo scout failed nonfatally: Scout timed out.");
  } finally { runtime.restore(); }
});

test("steering preserves the current repo Scout call sequence", () => {
  assert.equal(startsNewRepoSequence({ source: "interactive", streamingBehavior: "steer" }), false);
  assert.equal(startsNewRepoSequence({ source: "interactive" }), true);
  assert.equal(startsNewRepoSequence({ source: "interactive", streamingBehavior: "followUp" }), true);
});

test("parallel Repo Scout calls are serialized into fresh child sessions; only follow-ups get parent context", async () => {
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const childArgs: string[][] = [];
  const childPrompts: string[] = [];
  const childOptions: any[] = [];
  const run = async (args: string[], options: any): Promise<ScoutRun> => {
    childArgs.push(args);
    childPrompts.push(options.prompt);
    childOptions.push(options);
    calls++;
    if (calls === 1) {
      firstStarted();
      await firstGate;
    }
    return {
      text: `result ${calls}`, stderr: "", durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      turns: [], truncated: false, exitCode: 0, activity: [],
      budgetExceeded: false, finalizationAttempted: false, finalizationSucceeded: false,
      contextTokens: 1,
      cacheReadTokens: 0,
    };
  };
  const runtime = await harness(run);
  const ctx = context({
    hasUI: false,
    sessionManager: {
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Find auth flow" } }],
    },
  });
  try {
    const first = runtime.tools.get("repo_scout").execute("one", { task: "first" }, undefined, undefined, ctx);
    await started;
    const second = runtime.tools.get("repo_scout").execute("two", { task: "second", retryReason: "Need prior request context" }, undefined, undefined, ctx);
    releaseFirst();
    const results = await Promise.all([first, second]);
    const sessionDir = (args: string[]) => args[args.indexOf("--session-dir") + 1];
    assert.equal(calls, 2);
    assert.equal(results[0].details.callNumber, 1);
    assert.equal(results[1].details.callNumber, 2);
    assert.ok(childArgs.every((args) => !args.includes("--continue")));
    assert.ok(childArgs.every((args) => args.includes("--system-prompt")));
    assert.ok(childArgs.every((args) => !args.includes("--append-system-prompt")));
    assert.ok(childArgs.every((args) => args.includes("read,search_excerpt,grep,find,ls")));
    assert.ok(childOptions.every((options) => options.resultMaxBytes === false));
    assert.ok(childOptions.every((options) => options.env.PI_SCOUT_CHILD === "1"));
    assert.notEqual(sessionDir(childArgs[0]), sessionDir(childArgs[1]));
    assert.ok(childArgs.every((args) => args.includes("rpc") && !args.some((arg) => arg.includes("Find auth flow"))));
    assert.doesNotMatch(childPrompts[0], /Find auth flow/);
    assert.match(childPrompts[1], /Find auth flow/);
    assert.match(childPrompts[1], /Prior scout gap requiring follow-up: Need prior request context/);
  } finally { runtime.restore(); }
});

test("Repo Scout reports merged citations, structured claims, and repeated searches", async () => {
  const run = async (): Promise<ScoutRun> => ({
    text: "## Findings\n\n- Shared guard. `src/auth.ts:10-20`",
    stderr: "", durationMs: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    turns: [], truncated: false, exitCode: 0,
    activity: [{ kind: "call", tool: "search_excerpt", text: JSON.stringify({ path: "src", pattern: "guard" }) }],
    omittedEvidence: [{ path: "src/auth.ts", start: 15, end: 25 }, { path: "src/auth.ts", start: 24, end: 30 }],
    budgetExceeded: false, finalizationAttempted: false, finalizationSucceeded: false,
    contextTokens: 1, cacheReadTokens: 0,
  });
  const runtime = await harness(run);
  const ctx = context({ hasUI: false, sessionManager: { buildContextEntries: () => [] } });
  try {
    const first = await runtime.tools.get("repo_scout").execute("one", { task: "map guard" }, undefined, undefined, ctx);
    const second = await runtime.tools.get("repo_scout").execute("two", { task: "map guard", retryReason: "report gap" }, undefined, undefined, ctx);
    assert.deepEqual(first.details.omittedEvidence, [{ path: "src/auth.ts", start: 15, end: 30 }]);
    assert.deepEqual(first.details.structuredClaims, [{
      section: "findings", claim: "Shared guard. `src/auth.ts:10-20`", citations: [{ path: "src/auth.ts", start: 10, end: 20 }],
    }]);
    assert.deepEqual(first.details.duplicateTelemetry, { reportBlocks: 0, reportBytes: 0 });
    assert.deepEqual(first.details.searchTelemetry, { searches: 1, repeatedSearches: 0 });
    assert.deepEqual(second.details.searchTelemetry, { searches: 1, repeatedSearches: 1 });
    runtime.handlers.get("input")?.forEach(handler => handler({ source: "interactive", text: "new request" }));
    const third = await runtime.tools.get("repo_scout").execute("three", { task: "map guard" }, undefined, undefined, ctx);
    assert.deepEqual(third.details.searchTelemetry, { searches: 1, repeatedSearches: 0 });
  } finally { runtime.restore(); }
});

test("Repo Scout conditionally loads pi-discover child tools and fails closed on duplicate providers", async () => {
  const childArgs: string[][] = [];
  const run = async (args: string[]): Promise<ScoutRun> => {
    childArgs.push(args);
    return {
      text: "result", stderr: "", durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      turns: [], truncated: false, exitCode: 0, activity: [], budgetExceeded: false,
      finalizationAttempted: false, finalizationSucceeded: false, contextTokens: 1, cacheReadTokens: 0,
    };
  };
  const runtime = await harness(run);
  const childExtensionPath = join(process.cwd(), "..", "pi-discover", "src", "discover-child-tools.ts");
  const respond = (request: any) => request.respond({
    version: 1,
    owner: "pi-discover",
    childExtensionPath,
    toolNames: ["rg", "fd", "relationship_graph"],
  });
  runtime.events.on("pi-discover:child-tools-capability", respond);
  try {
    await runtime.tools.get("repo_scout").execute("one", { task: "map symbol" }, undefined, undefined, context());
    assert.ok(childArgs[0].includes(childExtensionPath));
    assert.ok(childArgs[0].includes("read,search_excerpt,rg,fd,relationship_graph,grep,find,ls"));
    assert.equal(childArgs[0].filter((arg) => arg === "-e").length, 2);

    runtime.events.on("pi-discover:child-tools-capability", (request) => respond(request));
    await runtime.tools.get("repo_scout").execute("two", { task: "map symbol again" }, undefined, undefined, context());
    assert.ok(!childArgs[1].includes(childExtensionPath));
    assert.ok(childArgs[1].includes("read,search_excerpt,grep,find,ls"));
    assert.equal(childArgs[1].filter((arg) => arg === "-e").length, 1);
  } finally { runtime.restore(); }
});

test("Repo Scout forwards its reported-cost ceiling and exposes budget exhaustion", async () => {
  let maxCostUsd: number | undefined;
  const run = async (_args: string[], options: any): Promise<ScoutRun> => {
    maxCostUsd = options.maxCostUsd;
    return {
      text: "partial", error: "Scout reached reported cost limit ($0.50).", failure: "budget_exceeded",
      stderr: "", durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
      turns: [], truncated: false, exitCode: 1, activity: [], budgetExceeded: true, finalizationAttempted: true, finalizationSucceeded: false, contextTokens: 0, cacheReadTokens: 0,
    };
  };
  const runtime = await harness(run);
  try {
    const result = await runtime.tools.get("repo_scout").execute("id", { task: "find config" }, undefined, undefined, context({
      hasUI: false,
      sessionManager: { buildContextEntries: () => [] },
    }));
    assert.equal(maxCostUsd, 0.5);
    assert.equal(result.details.failureCode, "budget_exceeded");
    assert.equal(result.details.budgetExceeded, true);
    assert.equal(result.details.finalizationAttempted, true);
  } finally { runtime.restore(); }
});

test("Scout registers separate repo and web tools", async () => {
  const runtime = await harness();
  try {
    assert.deepEqual([...runtime.tools.keys()].sort(), ["repo_scout", "web_scout"]);
    const repoTool = runtime.tools.get("repo_scout");
    const repoGuidelines = repoTool.promptGuidelines as string[];
    const repoGuidance = repoGuidelines.join("\n");
    assert.equal(repoGuidelines.length, 3);
    assert.ok(repoGuidance.length < 1_000);
    assert.ok(repoGuidelines.every((guideline) => /repo_scout/i.test(guideline)));
    assert.match(repoGuidance, /before edits needing non-local repository/i);
    assert.match(repoGuidance, /Skip repo_scout for known-file self-contained edits/i);
    assert.match(repoGuidance, /observable action/i);
    assert.match(repoGuidance, /concrete scope anchors/i);
    assert.match(repoGuidance, /required evidence/i);
    assert.match(repoGuidance, /finite stopping boundary/i);
    assert.match(repoGuidance, /callers, config, registries, and tests/i);
    assert.match(repoGuidance, /main model evaluates/i);
    assert.match(repoGuidance, /Reread only for an exact edit, evidence gap\/conflict, or changed state/i);
    assert.match(repoGuidance, /each child session starts fresh/i);
    assert.match(repoGuidance, /otherwise call it before mutation/i);
    assert.doesNotMatch(repoGuidance, /Replace ['"]|Across packages\/a|Within named auth entrypoints/i);
    assert.match(runtime.tools.get("web_scout").description, /fresh temporary Helios browser/);
  } finally { runtime.restore(); }
});

test("Web Scout validates input and requires exactly one Helios capability before grant", async () => {
  const runtime = await harness();
  let grants = 0;
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts",
    async issueGrant() { grants++; return { value: "grant", async revoke() {} }; },
  }));
  try {
    const invalid = await runtime.tools.get("web_scout").execute("invalid", {
      task: "docs", startUrls: ["file:///secret"],
    }, undefined, undefined, context({ hasUI: false }));
    assert.equal(invalid.details.failureCode, "invalid");
    assert.equal(grants, 0);

    const noAuth = await runtime.tools.get("web_scout").execute("no-auth", { task: "docs" }, undefined, undefined, context({
      hasUI: false,
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: false }; } },
    }));
    assert.equal(noAuth.details.failureCode, "unavailable");
    assert.equal(grants, 0);

    const noModel = await runtime.tools.get("web_scout").execute("no-model", { task: "docs" }, undefined, undefined, context({ hasUI: false, model: undefined }));
    assert.equal(noModel.details.failureCode, "unavailable");
    assert.equal(grants, 0);

    runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
      version: 1, owner: "pi-helios", childExtensionPath: "C:/other/web-scout-browser.ts", issueGrant() {},
    }));
    const duplicate = await runtime.tools.get("web_scout").execute("duplicate", { task: "docs" }, undefined, undefined, context({ hasUI: false }));
    assert.equal(duplicate.details.failureCode, "unavailable");
    assert.equal(grants, 0);
  } finally { runtime.restore(); }
});

test("Web Scout launches headless without UI or confirmation and revokes grant", async () => {
  let childArgs: string[] = [];
  const run = async (args: string[]): Promise<ScoutRun> => {
    childArgs = args;
    return {
      text: "cited report", stderr: "", durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      turns: [], truncated: false, exitCode: 0, activity: [], budgetExceeded: false,
      finalizationAttempted: false, finalizationSucceeded: false, contextTokens: 0, cacheReadTokens: 0,
    };
  };
  const runtime = await harness(run);
  let options: any;
  let revoked = 0;
  let confirmations = 0;
  const statuses: Array<string | undefined> = [];
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts",
    async issueGrant(value: any) {
      options = value;
      return { value: "grant", async revoke() { revoked++; } };
    },
  }));
  try {
    const result = await runtime.tools.get("web_scout").execute("id", {
      task: "read current docs", startUrls: ["https://example.com"], maxPages: 2,
    }, undefined, undefined, context({ hasUI: false, ui: {
      async confirm() { confirmations++; return false; }, setStatus() {},
    } }));
    assert.equal(result.content[0].text, "cited report");

    const uiResult = await runtime.tools.get("web_scout").execute("ui", { task: "read current docs", maxPages: 2 }, undefined, undefined, context({ ui: {
      async confirm() { confirmations++; return false; },
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    } }));
    assert.equal(uiResult.content[0].text, "cited report");
    assert.equal(confirmations, 0);
    assert.equal(revoked, 2);
    assert.equal(statuses.at(-1), undefined);
    assert.deepEqual(options, { maxPages: 2, maxActions: 20, headed: false });
    for (const flag of ["--no-extensions", "--no-approve", "--no-builtin-tools", "--no-session"]) assert.ok(childArgs.includes(flag));
    assert.ok(childArgs.includes("scout_browser"));
  } finally { runtime.restore(); }
});

test("Web Scout revokes grant when child launch throws", async () => {
  const runtime = await harness(async () => { throw new Error("child launch failed"); });
  let revoked = 0;
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts",
    async issueGrant() { return { value: "grant", async revoke() { revoked++; } }; },
  }));
  try {
    await assert.rejects(runtime.tools.get("web_scout").execute("id", { task: "docs" }, undefined, undefined, context({ hasUI: false })), /child launch failed/);
    assert.equal(revoked, 1);
  } finally { runtime.restore(); }
});

test("Scout contributes bounded metadata-only Pylon health", async () => {
  const runtime = await harness();
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts", issueGrant() {},
  }));
  try {
    const reports: Promise<any>[] = [];
    runtime.events.emit("pylon:health-request", { version: 1, respond(value: any) { reports.push(Promise.resolve(value)); } });
    const report = await reports[0];
    assert.equal(report.owner, "pi-scout");
    assert.match(report.lines.join("\n"), /Helios broker ready/);
    assert.doesNotMatch(JSON.stringify(report), /apiKey|snapshot|https:\/\//i);
  } finally { runtime.restore(); }
});

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

test("parallel Repo Scout calls are serialized into fresh child sessions with parent context", async () => {
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const childArgs: string[][] = [];
  const childPrompts: string[] = [];
  const run = async (args: string[], options: any): Promise<ScoutRun> => {
    childArgs.push(args);
    childPrompts.push(options.prompt);
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
    const second = runtime.tools.get("repo_scout").execute("two", { task: "second" }, undefined, undefined, ctx);
    releaseFirst();
    const results = await Promise.all([first, second]);
    const sessionDir = (args: string[]) => args[args.indexOf("--session-dir") + 1];
    assert.equal(calls, 2);
    assert.equal(results[0].details.callNumber, 1);
    assert.equal(results[1].details.callNumber, 2);
    assert.ok(childArgs.every((args) => !args.includes("--continue")));
    assert.notEqual(sessionDir(childArgs[0]), sessionDir(childArgs[1]));
    assert.ok(childArgs.every((args) => args.includes("rpc") && !args.some((arg) => arg.includes("Find auth flow"))));
    assert.ok(childPrompts.every((prompt) => prompt.includes("Find auth flow")));
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

test("Scout registers separate repo and web tools; Web Scout fails closed without UI", async () => {
  const runtime = await harness();
  try {
    assert.deepEqual([...runtime.tools.keys()].sort(), ["repo_scout", "web_scout"]);
    const repoGuidance = runtime.tools.get("repo_scout").promptGuidelines.join("\n");
    assert.match(repoGuidance, /bounded read-only orientation pass/i);
    assert.match(repoGuidance, /neither the user request nor current context supplies a concrete path/i);
    assert.match(repoGuidance, /Start the task with concrete reconnaissance work/i);
    assert.match(repoGuidance, /Omit the broad user goal unless it materially constrains search scope or interpretation/i);
    assert.match(repoGuidance, /include only the relevant constraint, not the full request/i);
    assert.match(repoGuidance, /Trace redirectUri from request input through callback validation/i);
    assert.match(repoGuidance, /sufficient for read-only evaluation by default/i);
    assert.match(repoGuidance, /do not reread cited source unless an exact edit needs current text/i);
    assert.match(repoGuidance, /every call receives bounded current parent context/i);
    assert.match(repoGuidance, /Before any follow-up Scout call, do one bounded parent-side gap pass/i);
    assert.match(repoGuidance, /do not make serial Scout calls one finding, file, or question at a time/i);
    assert.match(repoGuidance, /do not call Scout again solely because the user approved implementation/i);
    const result = await runtime.tools.get("web_scout").execute("id", { task: "current docs" }, undefined, undefined, context({ hasUI: false }));
    assert.equal(result.details.failureCode, "confirmation_unavailable");
  } finally { runtime.restore(); }
});

test("Web Scout requires exactly one Helios capability and fresh consent before grant", async () => {
  const runtime = await harness();
  let grants = 0;
  let confirmation = "";
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts",
    async issueGrant() { grants++; return { value: "grant", async revoke() {} }; },
  }));
  try {
    const declined = await runtime.tools.get("web_scout").execute("id", {
      task: "compare current browser docs", startUrls: ["https://example.com/docs"], maxPages: 3,
    }, undefined, undefined, context({ ui: {
      async confirm(_title: string, message: string) { confirmation = message; return false; }, setStatus() {},
    } }));
    assert.equal(declined.details.declined, true);
    assert.equal(grants, 0);
    assert.match(confirmation, /example\.com/);
    assert.match(confirmation, /test\/web-model/);
    assert.match(confirmation, /headless temporary browser/);

    runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
      version: 1, owner: "pi-helios", childExtensionPath: "C:/other/web-scout-browser.ts", issueGrant() {},
    }));
    const duplicate = await runtime.tools.get("web_scout").execute("id", { task: "docs" }, undefined, undefined, context());
    assert.equal(duplicate.details.failureCode, "unavailable");
  } finally { runtime.restore(); }
});

test("Web Scout requests a headless browser after fresh consent", async () => {
  const runtime = await harness();
  let confirmation = "";
  let options: any;
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts",
    async issueGrant(value: any) { options = value; throw new Error("stop after grant"); },
  }));
  try {
    await assert.rejects(runtime.tools.get("web_scout").execute("id", {
      task: "read current docs", startUrls: ["https://example.com"], maxPages: 2,
    }, undefined, undefined, context({ ui: {
      async confirm(_title: string, message: string) { confirmation = message; return true; }, setStatus() {},
    } })), /stop after grant/);
    assert.match(confirmation, /headless temporary browser/);
    assert.deepEqual(options, { maxPages: 2, maxActions: 20, headed: false });
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

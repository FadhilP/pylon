import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import scout, { parentContextForRepoRun, startsNewRepoSession } from "../extensions/pi-scout.ts";

class Bus {
  handlers = new Map<string, Set<(value: any) => void>>();
  on(name: string, handler: (value: any) => void) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler); this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name: string, value: any) { for (const handler of this.handlers.get(name) ?? []) handler(value); }
}

async function harness() {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-scout-extension-"));
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
  scout(pi);
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

test("steering preserves the current repo Scout session", () => {
  assert.equal(startsNewRepoSession({ source: "interactive", streamingBehavior: "steer" }), false);
  assert.equal(startsNewRepoSession({ source: "interactive" }), true);
  assert.equal(startsNewRepoSession({ source: "interactive", streamingBehavior: "followUp" }), true);
});

test("parent context is sent only on the first repo Scout call", () => {
  const entries = [{ type: "message", message: { role: "user", content: "Find auth flow" } }];
  assert.match(parentContextForRepoRun(1, entries), /Find auth flow/);
  assert.equal(parentContextForRepoRun(2, entries), "");
});

test("Scout registers separate repo and web tools; Web Scout fails closed without UI", async () => {
  const runtime = await harness();
  try {
    assert.deepEqual([...runtime.tools.keys()].sort(), ["repo_scout", "web_scout"]);
    const repoGuidance = runtime.tools.get("repo_scout").promptGuidelines.join("\n");
    assert.match(repoGuidance, /bounded read-only orientation pass/i);
    assert.match(repoGuidance, /lack a concrete path, package, symbol, or boundary anchor/i);
    assert.match(repoGuidance, /broad parent context is sent only on the first call/i);
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

test("Scout contributes bounded metadata-only Conductor health", async () => {
  const runtime = await harness();
  runtime.events.on("pi-helios:web-scout-capability", (request) => request.respond({
    version: 1, owner: "pi-helios", childExtensionPath: "C:/bundle/web-scout-browser.ts", issueGrant() {},
  }));
  try {
    const reports: Promise<any>[] = [];
    runtime.events.emit("pi-conductor:health-request", { version: 1, respond(value: any) { reports.push(Promise.resolve(value)); } });
    const report = await reports[0];
    assert.equal(report.owner, "pi-scout");
    assert.match(report.lines.join("\n"), /Helios broker ready/);
    assert.doesNotMatch(JSON.stringify(report), /apiKey|snapshot|https:\/\//i);
  } finally { runtime.restore(); }
});

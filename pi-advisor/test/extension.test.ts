import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import advisor from "../extensions/pi-advisor.ts";
import { saveConfig } from "../src/config.ts";

test("parallel Advisor calls serialize and report running duration", async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-advisor-extension-"));
  await saveConfig({ schemaVersion: 1, advisorModel: "test/model" });
  let tool: any;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const prompts: string[] = [];
  let runningUpdate: any;
  let reportDuration!: () => void;
  const durationReported = new Promise<void>((resolve) => { reportDuration = resolve; });
  const onUpdate = (update: any) => {
    if (update.details?.state === "running" && update.details.durationMs > 0) {
      runningUpdate = update;
      reportDuration();
    }
  };
  const complete = async (_model: any, request: any) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    prompts.push(request.messages[0].content[0].text);
    if (calls === 1) {
      firstStarted();
      await firstGate;
    }
    active--;
    return {
      content: [{ type: "text", text: `advice ${calls}` }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    };
  };
  advisor({
    on: () => {},
    registerTool: (value: any) => { tool = value; },
    registerCommand: () => {},
    events: { emit: () => {} },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any, complete as any);
  const model = { provider: "test", id: "model", contextWindow: 32_000 };
  const ctx = {
    cwd: process.cwd(), hasUI: false, getSystemPrompt: () => "system",
    modelRegistry: {
      find: () => model,
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "key" }; },
    },
    sessionManager: { buildContextEntries: () => [], getSessionId: () => "session" },
  };
  try {
    const first = tool.execute("one", { request: "first" }, undefined, onUpdate, ctx);
    await started;
    await durationReported;
    const second = tool.execute("two", { request: "second" }, undefined, undefined, ctx);
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.equal(runningUpdate.details.state, "running");
    assert.ok(runningUpdate.details.durationMs >= 1_000);
    assert.equal(maxActive, 1);
    assert.equal(calls, 2);
    assert.equal(results[0].details.callNumber, 1);
    assert.equal(results[1].details.callNumber, 2);
    assert.match(prompts[1], /Prior guidance:\n\nadvice 1/);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test("advisor call renders the executor request instead of the user prompt", () => {
  let tool: any;
  const handlers = new Map<string, Function>();
  advisor({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (value: any) => { tool = value; },
    registerCommand: () => {},
    events: { emit: () => {} },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any);

  handlers.get("input")?.({ source: "interactive", text: "original user prompt" });
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = tool.renderCall(
    { request: "  Review   migration\npath risks.  " },
    theme,
    { state: {} },
  ).render(1_000).join("\n");

  assert.match(rendered, /Review migration path risks\./);
  assert.doesNotMatch(rendered, /original user prompt/);

  const collapsed = tool.renderResult({
    content: [{ type: "text", text: "Detailed advice" }],
    details: {
      advisorModel: "test/model",
      durationMs: 1_250,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
      callNumber: 1,
      snapshotEstimatedTokens: 10,
      redactionCount: 0,
      truncated: false,
      cacheRetention: "short",
    },
  }, { expanded: false }, theme).render(1_000).map((line: string) => line.trimEnd()).join("\n");
  assert.equal(collapsed, "Advisor · test/model · 1 input · 2 output · R3 · W4 · $0.5000 · 1.3s");
  assert.doesNotMatch(collapsed, /Detailed advice/);

  assert.ok(tool.parameters.required.includes("request"));
  assert.equal(tool.parameters.properties.request.maxLength, 8_192);
});

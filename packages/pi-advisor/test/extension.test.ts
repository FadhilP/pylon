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
  await saveConfig({ version: 1, advisorModel: "test/model" });
  let tool: any;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const prompts: string[] = [];
  const sessionIds: string[] = [];
  const maxTokens: number[] = [];
  let runningUpdate: any;
  let reportDuration!: () => void;
  const durationReported = new Promise<void>((resolve) => { reportDuration = resolve; });
  const onUpdate = (update: any) => {
    if (update.details?.state === "running" && update.details.durationMs > 0) {
      runningUpdate = update;
      reportDuration();
    }
  };
  const complete = async (_model: any, request: any, options: any) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    prompts.push(request.messages[0].content[0].text);
    sessionIds.push(options.sessionId);
    maxTokens.push(options.maxTokens);
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
  const guidelines = tool.promptGuidelines as string[];
  const guidance = guidelines.join("\n");
  assert.equal(guidelines.length, 3);
  assert.ok(guidelines.every((guideline) => /advisor/i.test(guideline)));
  assert.match(tool.description, /Maximum three authenticated consultations/);
  assert.match(tool.description, /transient provider failures retry/);
  assert.match(guidance, /two advisor consultations by default for consequential work/);
  assert.match(guidance, /Skip advisor for trivial or local work/);
  assert.match(guidance, /after implementation and before final verification/);
  assert.match(guidance, /do not repeat the first request ceremonially/);
  assert.match(guidance, /Reserve a third advisor call for material contradictions, failures, or unresolved risks/);
  assert.match(guidance, /concrete decision, risk, or approach to review/);
  assert.match(guidance, /only the highest-priority cited file ranges/);
  assert.match(guidance, /complete decisive definitions, callers, and checks over broad file slices/);
  assert.match(guidance, /150–300 total evidence lines is a selection signal, not a hard cap/);
  assert.match(guidance, /main model decides, verifies evidence, and performs tools/);
  const model = {
    provider: "test", id: "model", contextWindow: 32_000, maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
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
    assert.deepEqual(sessionIds, ["session:advisor", "session:advisor"]);
    assert.deepEqual(maxTokens, [8_000, 8_000]);
    assert.equal(results[0].details.callNumber, 1);
    assert.equal(results[1].details.callNumber, 2);
    assert.equal(Object.hasOwn(results[0].details, "failureMessage"), false);
    assert.deepEqual(results[0].details.duplicateTelemetry, { records: 0, chars: 0 });
    assert.match(prompts[1], /Prior guidance:\n\nadvice 1/);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test("advisor records bounded redacted failure diagnostics", async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-advisor-failures-"));
  await saveConfig({ version: 1, advisorModel: "test/model" });
  const model = {
    provider: "test", id: "model", contextWindow: 32_000, maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const ctx = {
    cwd: process.cwd(), hasUI: false, getSystemPrompt: () => "system",
    modelRegistry: {
      find: () => model,
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "key" }; },
    },
    sessionManager: { buildContextEntries: () => [], getSessionId: () => "session" },
  };
  const run = async (complete: () => any, onUpdate?: (update: any) => void) => {
    let tool: any;
    advisor({
      on: () => {},
      registerTool: (value: any) => { tool = value; },
      registerCommand: () => {},
      events: { emit: () => {} },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as any, complete as any);
    return tool.execute("failure", { request: "review" }, undefined, onUpdate, ctx);
  };
  try {
    const secret = `sk-${"x".repeat(40)}`;
    const providerError = await run(async () => ({
      content: [],
      stopReason: "error",
      errorMessage: `bad\napi_key=${secret}\u0000\u0085\u2028\u2029${"z".repeat(600)}`,
    }));
    assert.equal(providerError.details.failureCode, "invalid_response");
    assert.match(providerError.content[0].text, /^\[A-[\w-]+ · Advisor\] Advisor failed nonfatally: invalid_response\. /);
    assert.ok(providerError.details.failureMessage.length <= 500);
    assert.doesNotMatch(providerError.details.failureMessage, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.doesNotMatch(providerError.details.failureMessage, new RegExp(secret));
    assert.match(providerError.details.failureMessage, /\[possible credential redacted\]/);

    const bearer = await run(async () => ({
      content: [], stopReason: "error", errorMessage: "authorization: Bearer short-token",
    }));
    assert.equal(bearer.details.failureMessage, "[possible credential redacted]");

    const retryUpdates: any[] = [];
    let transientAttempts = 0;
    const recovered = await run(async () => {
      transientAttempts++;
      return transientAttempts < 3
        ? { content: [], stopReason: "error", errorMessage: "Servers are overloaded" }
        : {
            content: [{ type: "text", text: "recovered advice" }],
            stopReason: "stop",
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          };
    }, (update) => retryUpdates.push(update));
    assert.equal(transientAttempts, 3);
    assert.equal(recovered.details.failureCode, undefined);
    assert.equal(recovered.details.retryAttempts, 2);
    assert.match(recovered.content[0].text, /recovered advice/);
    assert.deepEqual(retryUpdates.filter((update) => update.details?.retryAttempts).map((update) => update.details.retryAttempts), [1, 2]);

    let thrownAttempts = 0;
    const recoveredThrow = await run(async () => {
      thrownAttempts++;
      if (thrownAttempts === 1) throw new Error("service unavailable");
      return {
        content: [{ type: "text", text: "recovered after throw" }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      };
    });
    assert.equal(thrownAttempts, 2);
    assert.equal(recoveredThrow.details.retryAttempts, 1);
    assert.match(recoveredThrow.content[0].text, /recovered after throw/);

    const exhausted = await run(async () => ({
      content: [], stopReason: "error", errorMessage: "Codex servers are currently overloaded",
    }));
    assert.equal(exhausted.details.failureCode, "retryable");
    assert.equal(exhausted.details.retryAttempts, 2);
    assert.equal(exhausted.details.failureMessage, "Codex servers are currently overloaded");
    assert.match(exhausted.content[0].text, /retryable\. Codex servers are currently overloaded/);

    const rateLimit = await run(async () => ({
      content: [], stopReason: "error", errorMessage: "429 rate limit",
    }));
    assert.equal(rateLimit.details.failureCode, "rate_limited");
    assert.equal(rateLimit.details.failureMessage, "429 rate limit");
    assert.equal(rateLimit.details.retryAttempts, 2);

    const thrown = await run(async () => { throw new Error("socket closed"); });
    assert.equal(thrown.details.failureCode, "invalid_response");
    assert.equal(thrown.details.failureMessage, "socket closed");

    const nonError = await run(async () => { throw { private: "value" }; });
    assert.equal(nonError.details.failureMessage, "Advisor request failed without an Error message.");

    const empty = await run(async () => ({ content: [], stopReason: "stop" }));
    assert.equal(empty.details.failureMessage, "Provider returned no text content.");

    const aborted = await run(async () => ({ content: [], stopReason: "aborted" }));
    assert.equal(aborted.details.failureCode, "aborted");
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

  let failureColor = "";
  const failed = tool.renderResult({
    content: [{ type: "text", text: "Advisor failed nonfatally: timeout." }],
    details: {
      advisorModel: "test/model",
      durationMs: 1_250,
      callNumber: 1,
      snapshotEstimatedTokens: 10,
      redactionCount: 0,
      truncated: false,
      cacheRetention: "short",
      failureCode: "timeout",
    },
  }, { expanded: false }, {
    fg: (color: string, text: string) => { failureColor = color; return text; },
  }).render(1_000).map((line: string) => line.trimEnd()).join("\n");
  assert.equal(failureColor, "error");
  assert.equal(failed, "Advisor failed · test/model · 1s\nAdvisor failed nonfatally: timeout.");

  const diagnostic = tool.renderResult({
    content: [{ type: "text", text: "Advisor failed nonfatally: retryable." }],
    details: {
      advisorModel: "test/model",
      durationMs: 500,
      callNumber: 1,
      snapshotEstimatedTokens: 10,
      redactionCount: 0,
      truncated: false,
      cacheRetention: "short",
      failureCode: "retryable",
      failureMessage: "Servers are overloaded",
    },
  }, { expanded: false }, theme).render(1_000).map((line: string) => line.trimEnd()).join("\n");
  assert.match(diagnostic, /Advisor failed nonfatally: retryable\.\nServers are overloaded/);

  assert.ok(tool.parameters.required.includes("request"));
  assert.equal(tool.parameters.properties.request.maxLength, 8_192);
  assert.match(tool.parameters.properties.evidence.description, /150–300 total lines/);
});

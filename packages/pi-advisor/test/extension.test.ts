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
  const started = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const prompts: string[] = [];
  const sessionIds: string[] = [];
  const maxTokens: number[] = [];
  let runningUpdate: any;
  let reportDuration!: () => void;
  const durationReported = new Promise<void>(resolve => {
    reportDuration = resolve;
  });
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
  advisor(
    {
      on: () => {},
      registerTool: (value: any) => {
        tool = value;
      },
      registerCommand: () => {},
      events: { emit: () => {} },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as any,
    complete as any,
  );
  const model = {
    provider: "test",
    id: "model",
    contextWindow: 32_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    getSystemPrompt: () => {
      throw new Error("executor system prompt must not be copied");
    },
    modelRegistry: {
      find: () => model,
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "key" };
      },
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
    provider: "test",
    id: "model",
    contextWindow: 32_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    getSystemPrompt: () => "system",
    modelRegistry: {
      find: () => model,
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "key" };
      },
    },
    sessionManager: { buildContextEntries: () => [], getSessionId: () => "session" },
  };
  const run = async (complete: () => any, onUpdate?: (value: any) => void) => {
    let tool: any;
    advisor(
      {
        on: () => {},
        registerTool: (value: any) => {
          tool = value;
        },
        registerCommand: () => {},
        events: { emit: () => {} },
        getActiveTools: () => [],
        setActiveTools: () => {},
      } as any,
      complete as any,
      async () => true,
    );
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
    assert.match(
      providerError.content[0].text,
      /^\[A-[\w-]+ · Advisor\] Advisor failed nonfatally: invalid_response\.$/,
    );
    assert.ok(providerError.details.failureMessage.length <= 500);
    assert.doesNotMatch(providerError.details.failureMessage, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.doesNotMatch(providerError.details.failureMessage, new RegExp(secret));
    assert.match(providerError.details.failureMessage, /\[possible credential redacted\]/);

    const bearer = await run(async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "authorization: Bearer short-token",
    }));
    assert.equal(bearer.details.failureMessage, "[possible credential redacted]");

    const rateLimit = await run(async () => ({ content: [], stopReason: "error", errorMessage: "429 rate limit" }));
    assert.equal(rateLimit.details.failureCode, "rate_limited");
    assert.equal(rateLimit.details.failureMessage, "429 rate limit");

    const thrown = await run(async () => {
      throw new Error("socket closed");
    });
    assert.equal(thrown.details.failureCode, "provider_unavailable");
    assert.equal(thrown.details.failureMessage, "socket closed");

    const nonError = await run(async () => {
      throw { private: "value" };
    });
    assert.equal(nonError.details.failureMessage, "Advisor request failed without an Error message.");

    const empty = await run(async () => ({ content: [], stopReason: "stop" }));
    assert.equal(empty.details.failureMessage, "Provider returned no text content.");

    const aborted = await run(async () => ({ content: [], stopReason: "aborted" }));
    assert.equal(aborted.details.failureCode, "aborted");

    const observerSafe = await run(
      async () => ({
        content: [{ type: "text", text: "advice" }],
        stopReason: "stop",
        usage: { input: Number.NaN, output: -1, cacheRead: Infinity, cacheWrite: 0, cost: { total: -1 } },
      }),
      update => {
        if (update.details?.usage) throw new Error("render failed");
      },
    );
    assert.equal(observerSafe.details.failureCode, undefined);
    assert.deepEqual(observerSafe.details.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test("Advisor retries transient failures and only successful consultations consume quota", async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-advisor-retry-"));
  await saveConfig({ version: 1, advisorModel: "test/model" });
  let tool: any;
  let providerCalls = 0;
  let mode: "retry" | "fail" | "exhaust" | "paid" | "success" = "retry";
  advisor(
    {
      on: () => {},
      registerTool: (value: any) => {
        tool = value;
      },
      registerCommand: () => {},
      events: { emit: () => {} },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as any,
    (async () => {
      providerCalls++;
      if (mode === "retry" && providerCalls === 1)
        return {
          content: [],
          stopReason: "error",
          errorMessage: "Codex error: An error occurred while processing your request. You can retry your request.",
        };
      if (mode === "fail") return { content: [], stopReason: "error", errorMessage: "invalid request" };
      if (mode === "exhaust" || mode === "paid")
        return {
          content: [],
          stopReason: "error",
          errorMessage: mode === "exhaust" ? "WebSocket error" : "503 model at capacity",
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: mode === "paid" ? 0.1 : 0 } },
        };
      return {
        content: [{ type: "text", text: `advice ${providerCalls}` }],
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      };
    }) as any,
    async () => true,
  );
  const model = {
    provider: "test",
    id: "model",
    contextWindow: 32_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    getSystemPrompt: () => "system",
    modelRegistry: {
      find: () => model,
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "key" };
      },
    },
    sessionManager: { buildContextEntries: () => [], getSessionId: () => "session" },
  };
  try {
    const retried = await tool.execute("retry", { request: "review" }, undefined, undefined, ctx);
    assert.equal(retried.details.callNumber, 1);
    assert.equal(retried.details.attempts, 2);
    assert.equal(providerCalls, 2);

    mode = "fail";
    const failed = await tool.execute("fail", { request: "review" }, undefined, undefined, ctx);
    assert.equal(failed.details.failureCode, "invalid_response");
    assert.equal(failed.details.callNumber, 2);
    assert.equal(failed.details.attempts, 1);

    mode = "exhaust";
    const callsBeforeExhaustion = providerCalls;
    const updates: any[] = [];
    const exhausted = await tool.execute(
      "exhaust",
      { request: "review" },
      undefined,
      (update: any) => updates.push(update),
      ctx,
    );
    assert.equal(providerCalls, callsBeforeExhaustion + 3);
    assert.equal(exhausted.details.failureCode, "provider_unavailable");
    assert.equal(exhausted.details.attempts, 3);
    assert.equal(exhausted.details.usage.input, 3);
    assert.deepEqual(
      [...new Set(updates.flatMap(update => (update.details?.usage ? [update.details.usage.input] : [])))],
      [1, 2, 3],
    );
    assert.equal(exhausted.details.callNumber, 2);

    mode = "paid";
    const callsBeforePaidFailure = providerCalls;
    const paid = await tool.execute("paid", { request: "review" }, undefined, undefined, ctx);
    assert.equal(providerCalls, callsBeforePaidFailure + 1);
    assert.equal(paid.details.usage.cost, 0.1);
    assert.equal(paid.details.callNumber, 2);

    mode = "success";
    const second = await tool.execute("second", { request: "review" }, undefined, undefined, ctx);
    const third = await tool.execute("third", { request: "review" }, undefined, undefined, ctx);
    const blocked = await tool.execute("blocked", { request: "review" }, undefined, undefined, ctx);
    assert.equal(second.details.callNumber, 2);
    assert.equal(third.details.callNumber, 3);
    assert.equal(blocked.details.failureCode, "unavailable");
    assert.match(blocked.content[0].text, /call limit reached/);
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
    registerTool: (value: any) => {
      tool = value;
    },
    registerCommand: () => {},
    events: { emit: () => {} },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any);

  handlers.get("input")?.({ source: "interactive", text: "original user prompt" });
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = tool
    .renderCall({ request: "  Review   migration\npath risks.  " }, theme, { state: {} })
    .render(1_000)
    .join("\n");

  assert.match(rendered, /Review migration path risks\./);
  assert.doesNotMatch(rendered, /original user prompt/);

  const collapsed = tool
    .renderResult(
      {
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
      },
      { expanded: false },
      theme,
    )
    .render(1_000)
    .map((line: string) => line.trimEnd())
    .join("\n");
  assert.equal(collapsed, "Advisor · test/model · 1 input · 2 output · R3 · W4 · $0.5000 · 1.3s");
  assert.doesNotMatch(collapsed, /Detailed advice/);

  let failureColor = "";
  const failed = tool
    .renderResult(
      {
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
      },
      { expanded: false },
      {
        fg: (color: string, text: string) => {
          failureColor = color;
          return text;
        },
      },
    )
    .render(1_000)
    .map((line: string) => line.trimEnd())
    .join("\n");
  assert.equal(failureColor, "error");
  assert.equal(failed, "Advisor failed · test/model · 1s\nAdvisor failed nonfatally: timeout.");

  assert.ok(tool.parameters.required.includes("request"));
  assert.equal(tool.parameters.properties.request.maxLength, 8_192);
  assert.equal(tool.parameters.properties.evidence.maxItems, 8);
  assert.match(tool.parameters.properties.evidence.description, /Usually 3–5 concise, non-overlapping decisive ranges/);
  assert.match(tool.parameters.properties.evidence.description, /use up to 8 only when independently necessary/);
  assert.match(tool.parameters.properties.evidence.description, /150–300 total lines/);
});

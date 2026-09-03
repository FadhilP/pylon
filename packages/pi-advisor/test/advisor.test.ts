import test from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_MAX_OUTPUT_TOKENS, capAdvice } from "../src/advisor.ts";
import { runConsultation } from "../src/consult.ts";
import { isTransientProviderFailure } from "../src/retry.ts";

test("advice cap is explicit", () => {
  const value = capAdvice("a".repeat(33_000));
  assert.equal(value.truncated, true);
  assert.match(value.text, /estimated 8192 tokens/);
  assert.ok(Buffer.byteLength(value.text, "utf8") <= ADVISOR_MAX_OUTPUT_TOKENS * 4);
});

test("advice has no line cap", () => {
  const text = Array.from({ length: 1_024 }, () => "x").join("\n");
  assert.deepEqual(capAdvice(text), { text, truncated: false });
});

test("provider retries match Codex guidance without overriding terminal errors", () => {
  assert.equal(isTransientProviderFailure("You can retry your request."), true);
  assert.equal(isTransientProviderFailure(new Error("WebSocket error")), true);
  assert.equal(isTransientProviderFailure("Usage limit reached. You can retry your request."), false);
});
test("consultation progress cannot mutate accumulated cost parts", async () => {
  const observed: any[] = [];
  const result = await runConsultation({
    complete: (async () => ({
      content: [{ type: "text", text: "Use the narrow migration." }],
      stopReason: "stop",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 4,
        cacheWrite: 1,
        cost: { input: 0.04, output: 0.03, cacheRead: 0.02, cacheWrite: 0.01, total: 0.1 },
      },
    })) as any,
    retryWait: async () => false,
    model: {},
    request: { systemPrompt: "system", messages: [] },
    completeOptions: {},
    signal: new AbortController().signal,
    isTimedOut: () => false,
    onProgress: progress => {
      observed.push(progress.usage);
      progress.usage.input = 999;
      progress.usage.costParts.input = 999;
    },
  });

  assert.equal(result.ok, true);
  assert.notEqual(observed[0], result.usage);
  assert.notEqual(observed[0].costParts, result.usage.costParts);
  assert.deepEqual(result.usage, {
    input: 10,
    output: 2,
    cacheRead: 4,
    cacheWrite: 1,
    cost: 0.1,
    costParts: { input: 0.04, output: 0.03, cacheRead: 0.02, cacheWrite: 0.01 },
  });
});

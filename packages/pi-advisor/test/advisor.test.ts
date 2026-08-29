import test from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_MAX_OUTPUT_TOKENS, capAdvice } from "../src/advisor.ts";
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

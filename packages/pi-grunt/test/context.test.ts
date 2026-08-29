import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerContext, sanitizeFailureMessage } from "../src/context.ts";

test("worker context is bounded, redacted, and omits tool payloads", () => {
  const context = buildWorkerContext([
    {
      type: "message",
      message: { role: "user", content: "Implement parser token=secret-value" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Use existing Parser type" },
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "echo hidden" },
          },
        ],
      },
    },
  ]);
  assert.match(context, /Implement parser/);
  assert.match(context, /Use existing Parser type/);
  assert.match(context, /\[possible credential redacted\]/);
  assert.doesNotMatch(context, /echo hidden/);
  assert.ok(context.length <= 6000);
});

test("Grunt failure diagnostics are redacted, flattened, and bounded", () => {
  const secret = `sk-${"x".repeat(40)}`;
  const message = sanitizeFailureMessage(
    `bad\napi_key=${secret}\u0000\u0085\u2028\u2029${"z".repeat(600)}`,
    "Grunt failed.",
  );
  assert.ok(message.length <= 500);
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.doesNotMatch(message, new RegExp(secret));
  assert.match(message, /\[possible credential redacted\]/);
  assert.equal(
    sanitizeFailureMessage(
      "authorization: Bearer short-token",
      "Grunt failed.",
    ),
    "[possible credential redacted]",
  );
  assert.equal(
    sanitizeFailureMessage({ private: "value" }, "Grunt failed."),
    "Grunt failed.",
  );
});

test("worker context deduplicates before selecting recent complete records", () => {
  const context = buildWorkerContext(
    [
      {
        type: "message",
        message: { role: "user", content: "Keep this constraint" },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Repeated evidence" },
      },
      {
        type: "message",
        message: { role: "assistant", content: "Repeated evidence" },
      },
    ],
    6000,
    2,
  );
  assert.equal(
    context,
    "User: Keep this constraint\n\nMain assistant: Repeated evidence",
  );
});

test("worker context deduplicates normalized line endings but preserves roles", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "same\r\ntext" } },
    { type: "message", message: { role: "user", content: "same\ntext" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same\ntext" }],
      },
    },
  ]);
  assert.equal(context.match(/same/g)?.length, 2);
  assert.match(context, /User:/);
  assert.match(context, /Main assistant:/);
});

test("worker context omits oversized records instead of clipping them", () => {
  const context = buildWorkerContext(
    [
      {
        type: "message",
        message: { role: "user", content: "small complete record" },
      },
      {
        type: "message",
        message: { role: "assistant", content: "x".repeat(100) },
      },
    ],
    40,
  );
  assert.equal(context, "User: small complete record");
});

test("worker context excludes pinned task records and keeps chronological order", () => {
  const context = buildWorkerContext(
    [
      { type: "message", message: { role: "user", content: "Current task" } },
      {
        type: "message",
        message: { role: "assistant", content: "First evidence" },
      },
      {
        type: "message",
        message: { role: "user", content: "Second evidence" },
      },
    ],
    6000,
    10,
    ["Current task"],
  );
  assert.equal(
    context,
    "Main assistant: First evidence\n\nUser: Second evidence",
  );
});

test("worker context keeps long identifiers the worker needs but drops provider keys", () => {
  const commit = "a".repeat(40);
  const key = `AIza${"x".repeat(20)}`;
  const context = buildWorkerContext(
    [
      {
        type: "message",
        message: {
          role: "user",
          content: `Fix the regression introduced in ${commit}`,
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: `Deploy key is ${key}` },
      },
    ],
    6000,
  );
  assert.ok(
    context.includes(commit),
    "a commit hash must reach the worker intact",
  );
  assert.ok(
    !context.includes(key),
    "a provider key must never reach the worker",
  );
});

test("worker context redacts before whole-record budget packing", () => {
  const secret = `token=${"x".repeat(100)}`;
  // The raw record far exceeds this budget; it only fits once redaction has collapsed it.
  const budget = 60;
  const context = buildWorkerContext(
    [{ type: "message", message: { role: "user", content: secret } }],
    budget,
  );
  assert.equal(context, "User: [possible credential redacted]");
  assert.equal(
    buildWorkerContext(
      [{ type: "message", message: { role: "user", content: secret } }],
      budget,
      10,
      [secret],
    ),
    "",
  );
});

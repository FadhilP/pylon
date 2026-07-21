import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerContext } from "../src/context.ts";

test("worker context is bounded, redacted, and omits tool payloads", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "Implement parser token=secret-value" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "Use existing Parser type" },
      { type: "toolCall", name: "bash", arguments: { command: "echo hidden" } },
    ] } },
  ]);
  assert.match(context, /Implement parser/);
  assert.match(context, /Use existing Parser type/);
  assert.match(context, /\[REDACTED\]/);
  assert.doesNotMatch(context, /echo hidden/);
  assert.ok(context.length <= 6000);
});

test("worker context deduplicates before selecting recent complete records", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "Keep this constraint" } },
    { type: "message", message: { role: "assistant", content: "Repeated evidence" } },
    { type: "message", message: { role: "assistant", content: "Repeated evidence" } },
  ], 6000, 2);
  assert.equal(context, "User: Keep this constraint\n\nMain assistant: Repeated evidence");
});

test("worker context deduplicates normalized line endings but preserves roles", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "same\r\ntext" } },
    { type: "message", message: { role: "user", content: "same\ntext" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "same\ntext" }] } },
  ]);
  assert.equal(context.match(/same/g)?.length, 2);
  assert.match(context, /User:/);
  assert.match(context, /Main assistant:/);
});

test("worker context omits oversized records instead of clipping them", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "small complete record" } },
    { type: "message", message: { role: "assistant", content: "x".repeat(100) } },
  ], 40);
  assert.equal(context, "User: small complete record");
});

test("worker context excludes pinned task records and keeps chronological order", () => {
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: "Current task" } },
    { type: "message", message: { role: "assistant", content: "First evidence" } },
    { type: "message", message: { role: "user", content: "Second evidence" } },
  ], 6000, 10, ["Current task"]);
  assert.equal(context, "Main assistant: First evidence\n\nUser: Second evidence");
});

test("worker context redacts before whole-record budget packing", () => {
  const secret = `token=${"x".repeat(100)}`;
  const context = buildWorkerContext([
    { type: "message", message: { role: "user", content: secret } },
  ], 30);
  assert.equal(context, "User: [REDACTED]");
  assert.equal(buildWorkerContext([
    { type: "message", message: { role: "user", content: secret } },
  ], 30, 10, [secret]), "");
});

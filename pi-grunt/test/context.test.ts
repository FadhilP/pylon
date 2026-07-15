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
});

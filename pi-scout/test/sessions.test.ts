import test from "node:test";
import assert from "node:assert/strict";
import { parseSessionIntent } from "../src/sessions.ts";
import { redact } from "../src/redact.ts";
import { capText } from "../src/result.ts";

test("only exact leading session phrase with query matches", () => {
  assert.deepEqual(parseSessionIntent(" Search my Pi sessions for OAuth decision"), { query: "OAuth decision" });
  assert.deepEqual(parseSessionIntent("search my pi session auth"), { query: "auth" });
  assert.equal(parseSessionIntent("Can you search my Pi sessions for auth"), undefined);
  assert.equal(parseSessionIntent("search my pi sessions"), undefined);
});
test("credentials redact and caps state truncation", () => {
  const result = redact("api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456");
  assert.ok(result.count >= 1); assert.ok(!result.text.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(capText("a\nb\nc", 100, 2).truncated, true);
  assert.equal(capText("x\n".repeat(251)).truncated, false);
});

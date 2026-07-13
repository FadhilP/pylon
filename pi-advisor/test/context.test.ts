import test from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_MAX_OUTPUT_TOKENS } from "../src/advisor.ts";
import {
  advisorMaxTokens,
  buildSnapshot,
  serializeMessage,
} from "../src/context.ts";

test("snapshot omits images/thinking and redacts", () => {
  const snapshot = buildSnapshot("system", [{ role: "user", content: [{ type: "text", text: "token=sk-proj-abcdefghijklmnopqrstuvwxyz" }, { type: "image" }] }, { role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }, { type: "text", text: "answer" }] }], 20_000);
  assert.ok(snapshot.text.indexOf("[USER]") < snapshot.text.indexOf("[ASSISTANT]"));
  assert.match(snapshot.text, /image omitted/);
  assert.doesNotMatch(snapshot.text, /secret thought|thinking omitted/);
  assert.ok(!snapshot.text.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("small budget marks truncation and keeps newest user", () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `message-${i} ${"x".repeat(1000)}` }));
  const snapshot = buildSnapshot("system", messages, 9000);
  assert.equal(snapshot.truncated, true);
  assert.match(snapshot.text, /message-29/);
  assert.match(snapshot.text, /omitted/);
});

test("snapshot prioritizes advisor request, evidence, continuity, summaries, user, then assistant", () => {
  const snapshot = buildSnapshot("system", [
    { role: "assistant", content: "assistant judgment" },
    { role: "user", content: "review finding" },
    { role: "custom", customType: "advisor-request", content: "Which approach has less migration risk?" },
    { role: "branchSummary", summary: "branch state" },
    { role: "compactionSummary", summary: "compacted state" },
    { role: "custom", customType: "pi-continuity", content: "durable state" },
    { role: "custom", customType: "advisor-evidence", content: "source evidence" },
  ], 40_000);
  const positions = ["Which approach has less migration risk?", "source evidence", "durable state", "compacted state", "review finding", "assistant judgment"].map(value => snapshot.text.indexOf(value));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("snapshot includes latest bounded verification metadata", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "pi-verify-result", content: "failed: npm test" },
    { role: "user", content: "help recover" },
  ], 20_000);
  assert.match(snapshot.text, /latest-verification/);
  assert.match(snapshot.text, /failed: npm test/);
});

test("snapshot excludes raw tool and bash output", () => {
  const snapshot = buildSnapshot("system", [
    { role: "user", content: "question" },
    { role: "toolResult", toolName: "read", content: "noisy tool output" },
    { role: "bashExecution", command: "build", output: "noisy bash output" },
  ], 20_000);
  assert.doesNotMatch(snapshot.text, /noisy tool output|noisy bash output/);
});

test("latest user request has an 8k-token head-tail cap", () => {
  const snapshot = buildSnapshot("system", [{ role: "user", content: `START-${"alpha ".repeat(7_000)}-MIDDLE-${"omega ".repeat(7_000)}-END` }], 100_000);
  assert.match(snapshot.text, /START-/);
  assert.match(snapshot.text, /-END/);
  assert.doesNotMatch(snapshot.text, /-MIDDLE-/);
  assert.match(snapshot.text, /latest-user-request truncated: middle omitted/);
});

test("snapshot redacts advisor request", () => {
  const snapshot = buildSnapshot(
    "system",
    [{ role: "custom", customType: "advisor-request", content: "Review token=sk-proj-abcdefghijklmnopqrstuvwxyz" }],
    20_000,
  );
  assert.match(snapshot.text, /advisor-request/);
  assert.doesNotMatch(snapshot.text, /abcdefghijklmnopqrstuvwxyz/);
});

test("snapshot includes and redacts high-priority evidence", () => {
  const snapshot = buildSnapshot(
    "system",
    [
      { role: "user", content: "review finding" },
      {
        role: "custom",
        customType: "advisor-evidence",
        content: "<high-priority-evidence>\n1: token=sk-proj-abcdefghijklmnopqrstuvwxyz\n</high-priority-evidence>",
      },
    ],
    20_000,
  );
  assert.match(snapshot.text, /high-priority-evidence/i);
  assert.doesNotMatch(snapshot.text, /abcdefghijklmnopqrstuvwxyz/);
});

test("small model windows reserve bounded input and output", () => {
  const window = 1000;
  const snapshot = buildSnapshot(
    "system",
    [{ role: "user", content: "x".repeat(20_000) }],
    window,
  );
  assert.ok(snapshot.estimatedTokens + advisorMaxTokens(window) + 256 <= window);
  assert.equal(advisorMaxTokens(window), 250);
  assert.equal(advisorMaxTokens(100_000), ADVISOR_MAX_OUTPUT_TOKENS);
});

test("large model windows cap total estimated input at 32k tokens", () => {
  const reservedInputTokens = 1000;
  const snapshot = buildSnapshot(
    "s".repeat(20_000),
    [
      { role: "custom", customType: "advisor-evidence", content: "e".repeat(40_000) },
      { role: "custom", customType: "pi-continuity", content: "c".repeat(20_000) },
      { role: "compactionSummary", summary: "m".repeat(40_000) },
      { role: "user", content: "u".repeat(40_000) },
      { role: "assistant", content: "a".repeat(20_000) },
    ],
    200_000,
    reservedInputTokens,
  );
  assert.ok(snapshot.estimatedTokens + reservedInputTokens <= 32_000);
  assert.equal(snapshot.truncated, true);
});

test("serializeMessage still labels supported session entries", () => {
  assert.match(serializeMessage({ role: "compactionSummary", summary: "state" }), /^\[COMPACTION SUMMARY\]/);
});

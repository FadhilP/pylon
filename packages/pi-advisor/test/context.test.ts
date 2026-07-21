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

test("snapshot deduplicates normalized records before budgeting", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "review" },
    { role: "custom", customType: "advisor-evidence", content: "same evidence\r\n" },
    { role: "custom", customType: "advisor-evidence", content: "same evidence\n" },
  ], 20_000);
  assert.equal(snapshot.text.match(/same evidence/g)?.length, 1);
});

test("snapshot deduplicates exact payloads across sections by priority", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "same text" },
    { role: "custom", customType: "pi-continuity", content: "same text" },
    { role: "user", content: "same text" },
  ], 20_000);
  assert.equal(snapshot.text.match(/same text/g)?.length, 1);
  assert.equal(snapshot.duplicateTelemetry.records, 2);
  assert.ok(snapshot.duplicateTelemetry.chars > 0);
});

test("cross-section identity does not collapse different raw values after redaction", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "token=sk-proj-abcdefghijklmnopqrstuvwxyz-one" },
    { role: "user", content: "token=sk-proj-abcdefghijklmnopqrstuvwxyz-two" },
  ], 20_000);
  assert.equal(snapshot.duplicateTelemetry.records, 0);
  assert.equal(snapshot.sectionAllocations["latest-user-request"].includedRecords, 1);
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

test("snapshot keeps complete advisor and user records without per-section clipping", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: `START-${"alpha ".repeat(2_000)}-MIDDLE-${"omega ".repeat(2_000)}-END` },
    { role: "user", content: `USER-START-${"beta ".repeat(7_000)}-USER-MIDDLE-${"gamma ".repeat(7_000)}-USER-END` },
  ], 100_000);
  assert.match(snapshot.text, /START-/);
  assert.match(snapshot.text, /-MIDDLE-/);
  assert.match(snapshot.text, /-END/);
  assert.match(snapshot.text, /USER-MIDDLE/);
  assert.doesNotMatch(snapshot.text, /truncated: middle omitted/);
});

test("snapshot omits oversized records whole and keeps later records", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "review" },
    { role: "custom", customType: "advisor-evidence", content: `EVIDENCE-START${"x".repeat(30_000)}EVIDENCE-END` },
    { role: "custom", customType: "pi-continuity", content: "small durable state" },
  ], 10_000);
  assert.doesNotMatch(snapshot.text, /EVIDENCE-START|EVIDENCE-END/);
  assert.match(snapshot.text, /small durable state/);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.requiredContextOmitted, false);
  assert.deepEqual(snapshot.sectionAllocations["explicit-evidence"], {
    estimatedTokens: 0,
    includedRecords: 0,
    omittedRecords: 1,
    truncated: true,
  });
  assert.equal(snapshot.sectionAllocations["continuity-state"].includedRecords, 1);
  assert.ok(snapshot.sectionAllocations["continuity-state"].estimatedTokens > 0);
});

test("snapshot ranks evidence and retains omitted anchors", () => {
  const relevant = { path: "src/database.ts", start: 10, end: 20, claim: "database migration safety", revision: "git:new", verification: "tested" };
  const irrelevant = { path: "src/colors.ts", start: 1, end: 5, claim: "color palette" };
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "Review database migration safety" },
    { role: "custom", customType: "advisor-evidence", content: `COLORS-${"color detail ".repeat(90)}-END`, evidenceRef: irrelevant },
    { role: "custom", customType: "advisor-evidence", content: `DATABASE-MIGRATION-${"migration detail ".repeat(75)}-END`, evidenceRef: relevant },
  ], 1_000);
  assert.match(snapshot.text, /DATABASE-MIGRATION/);
  assert.doesNotMatch(snapshot.text, /COLORS-/);
  assert.deepEqual(snapshot.omittedEvidence, [irrelevant]);
  assert.match(snapshot.text, /src\/colors\.ts:1-5/);
});

test("evidence relevance ties prefer newer records", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "review evidence" },
    { role: "custom", customType: "advisor-evidence", content: `OLDER-${"older evidence words ".repeat(65)}`, evidenceRef: { path: "old.ts", start: 1, end: 2 } },
    { role: "custom", customType: "advisor-evidence", content: `NEWER-${"newer evidence words ".repeat(65)}`, evidenceRef: { path: "new.ts", start: 1, end: 2 } },
  ], 1_000);
  assert.match(snapshot.text, /NEWER-/);
  assert.doesNotMatch(snapshot.text, /OLDER-/);
});

test("oversized omission anchors stay inside the snapshot budget", () => {
  const snapshot = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "review" },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "custom", customType: "advisor-evidence", content: "record ".repeat(200),
      evidenceRef: { path: `${"long-path-".repeat(50)}${index}.ts`, start: 1, end: 2 },
    })),
  ], 1_000);
  assert.ok(snapshot.estimatedTokens <= 494);
  assert.equal(snapshot.sectionAllocations["explicit-evidence"].includedRecords, 1);
  assert.equal(snapshot.omittedEvidence.length, 4);
  assert.equal(snapshot.requiredContextOmitted, false);
});

test("snapshot reports required context that cannot fit instead of clipping it", () => {
  const messages = [{ role: "custom", customType: "advisor-request", content: "review" }];
  const oversized = buildSnapshot("system", [
    { role: "custom", customType: "advisor-request", content: "x".repeat(10_000) },
  ], 1_000);
  const reserved = buildSnapshot("system", messages, 10_000, 8_000);
  assert.equal(oversized.text, "");
  assert.equal(oversized.requiredContextOmitted, true);
  assert.equal(reserved.text, "");
  assert.equal(reserved.requiredContextOmitted, true);
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

test("large model windows cap total estimated input at 32,768 tokens", () => {
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
  assert.ok(snapshot.estimatedTokens + reservedInputTokens <= 32_768);
  assert.equal(snapshot.truncated, true);
});

test("serializeMessage still labels supported session entries", () => {
  assert.match(serializeMessage({ role: "compactionSummary", summary: "state" }), /^\[COMPACTION SUMMARY\]/);
});

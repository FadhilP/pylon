import test from "node:test";
import assert from "node:assert/strict";
import {
  createTokenMeter,
  formatTokenMeter,
  meterFromBranch,
  recordToolResult,
} from "../src/token-meter.ts";

const message = (id: string, value: any) => ({ type: "message", id, message: value });

test("rebuilds per-tool usage for built-in and custom calls", () => {
  const meter = meterFromBranch([
    message("assistant", {
      role: "assistant",
      usage: { input: 120, output: 30, cacheRead: 400, cacheWrite: 20 },
      content: [
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-custom", name: "repo_scout", arguments: { task: "trace flow" } },
      ],
    }),
    message("read-result", {
      role: "toolResult", toolCallId: "call-read", toolName: "read",
      content: [{ type: "text", text: "source" }], isError: false,
    }),
    message("custom-result", {
      role: "toolResult", toolCallId: "call-custom", toolName: "repo_scout",
      content: [{ type: "text", text: "finding" }, { type: "image", data: "ignored" }], isError: true,
    }),
  ]);

  assert.deepEqual(meter.byTool.get("read"), {
    calls: 1, argumentChars: JSON.stringify({ path: "a.ts" }).length,
    resultChars: 6, images: 0, errors: 0,
  });
  assert.deepEqual(meter.byTool.get("repo_scout"), {
    calls: 1, argumentChars: JSON.stringify({ task: "trace flow" }).length,
    resultChars: 7, images: 1, errors: 1,
  });
  assert.match(formatTokenMeter(meter), /repo_scout: 1 call/);
  assert.match(formatTokenMeter(meter), /images 1; errors 1/);
  assert.deepEqual(meter.provider, {
    turns: 1, input: 120, output: 30, cacheRead: 400, cacheWrite: 20, cost: 0,
  });
  assert.match(formatTokenMeter(meter), /input = text results, output = serialized arguments/);
  assert.match(formatTokenMeter(meter), /~4 characters\/token/);
  assert.match(formatTokenMeter(meter), /Provider-reported model usage/);
  assert.match(formatTokenMeter(meter), /1 turns; input 120; output 30; cache read 400; cache write 20/);
});

test("counts each completed tool call once across rebuild and events", () => {
  const meter = createTokenMeter();
  const result = {
    toolCallId: "same-id", toolName: "custom_tool", input: { value: 1 },
    content: [{ type: "text", text: "result" }], isError: false,
  };
  recordToolResult(meter, result);
  recordToolResult(meter, result);

  assert.equal(meter.byTool.get("custom_tool")?.calls, 1);
  assert.equal(meter.seenCallIds.size, 1);
});

test("attributes child model usage, context hashes, recalls, verification, and session cost", () => {
  const meter = meterFromBranch([
    message("assistant", {
      role: "assistant",
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.01 } },
      content: [
        { type: "toolCall", id: "advisor-1", name: "advisor", arguments: { request: "review this", evidence: [{ path: "a.ts", start: 1, end: 2 }] } },
        { type: "toolCall", id: "recall-1", name: "sieve_recall", arguments: { toolCallId: "old" } },
      ],
    }),
    message("advisor-result", {
      role: "toolResult", toolCallId: "advisor-1", toolName: "advisor",
      content: [{ type: "text", text: "advice" }], isError: false,
      details: { durationMs: 20, callNumber: 1, usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, cost: 0.25 } },
    }),
    message("recall-result", {
      role: "toolResult", toolCallId: "recall-1", toolName: "sieve_recall",
      content: [{ type: "text", text: "restored" }], isError: false, details: { found: true },
    }),
    { type: "custom", customType: "pi-verify-result", data: { version: 1, runId: "run-1", state: "passed" } },
    { type: "custom", customType: "pi-verify-result", data: { version: 1, runId: "run-1", state: "passed" } },
  ]);

  assert.deepEqual(meter.byPackage.get("pi-advisor"), {
    calls: 1, turns: 1, input: 100, output: 20, cacheRead: 50, cacheWrite: 5,
    cost: 0.25, failures: 0, retries: 0, repeatedCalls: 0, durationMs: 20,
  });
  assert.equal(meter.byContext.get("pi-advisor/request")?.records, 1);
  assert.equal(meter.byContext.get("pi-advisor/request")?.hashes.size, 1);
  assert.equal(meter.quality.sieveRecalls, 1);
  assert.equal(meter.quality.sieveRecalledChars, 8);
  assert.equal(meter.quality.verification.get("passed"), 1);
  const report = formatTokenMeter(meter);
  assert.match(report, /pi-advisor: 1 calls/);
  assert.match(report, /Context sections \(counts and hashes only\)/);
  assert.match(report, /Total session model cost: \$0\.2600/);
  assert.doesNotMatch(report, /review this|a\.ts/);
});

test("detects repeats from complete context tuples, not reused section hashes", () => {
  const contexts = [
    { request: "A", evidence: "X" },
    { request: "B", evidence: "Y" },
    { request: "A", evidence: "Y" },
    { request: "A", evidence: "X" },
  ];
  const entries = contexts.flatMap((input, index) => [
    message(`assistant-${index}`, { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "advisor", arguments: input }] }),
    message(`result-${index}`, {
      role: "toolResult", toolCallId: `call-${index}`, toolName: "advisor", content: [], isError: false,
      details: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    }),
  ]);

  assert.equal(meterFromBranch(entries).byPackage.get("pi-advisor")?.repeatedCalls, 1);
});

test("reports an empty current branch clearly", () => {
  const report = formatTokenMeter(meterFromBranch([]));
  assert.match(report, /No completed tool calls in current session branch/);
  assert.match(report, /0 turns; input 0; output 0/);
});

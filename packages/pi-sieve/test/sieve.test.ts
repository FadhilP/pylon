import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension from "../extensions/pi-sieve.ts";
import { loadConfig } from "../src/config.ts";
import {
  GIANT_ERROR_TAIL_CHARS,
  SIEVE_THRESHOLD,
  activeOmissionMarker,
  giantErrorMarker,
  omissionMarker,
  partialOmissionMarker,
  recalledGiantErrorMarker,
  recalledOmissionMarker,
  createProjectionEpoch,
  retainedProjectionBudget,
  rolloverStableSieveMessages,
  sieveMessages,
  stableSieveMessages,
  staleReadMarker,
} from "../src/sieve.ts";

const textResult = (toolName: string, text: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName,
  content: [{ type: "text", text }],
  ...extra,
});
const user = (content: string) => ({ role: "user", content });
const recalledResult = (sourceToolName: string, text: string, extraDetails: Record<string, unknown> = {}) =>
  textResult("sieve_recall", text, {
    details: { found: true, sourceToolName, sourceIsError: false, ...extraDetails },
  });
const noSkips = {
  recentWindow: 0,
  ineligibleTool: 0,
  error: 0,
  nonTextMixedOrEmptyContent: 0,
  malformedStructuredContent: 0,
  atOrBelowThreshold: 0,
  recoveryUnavailable: 0,
};
const noTransformTypes = {
  ageThreshold: 0, budget: 0, giantError: 0, activeThreshold: 0, staleRead: 0,
  duplicate: 0, errorCap: 0, mixedText: 0,
};

function oldResultAtAge(age: number, text: string, extra: Record<string, unknown> = {}) {
  return sieveMessages([user("before"), textResult("bash", text, extra), ...Array.from({ length: age }, (_, index) => user(`after-${index}`))], 4_000);
}

function rankedSearchText(kind: "symbol" | "code", count = 20) {
  const key = kind === "symbol" ? "heuristic" : "semantic";
  return JSON.stringify({
    [key]: kind === "symbol",
    results: Array.from({ length: count }, (_, index) => ({
      path: `src/result-${index}.ts`,
      line: index + 1,
      text: `${index}:` + "x".repeat(120),
    })),
  });
}

function relationshipGraphText(count = 12) {
  return JSON.stringify({
    query: "run",
    scope: ".",
    heuristic: true,
    files: Array.from({ length: count }, (_, index) => ({
      path: `src/file-${index}.ts`,
      locations: [{ line: index + 1, text: "x".repeat(120), roles: ["reference"] }],
    })),
    metadata: { observedMatchCount: count, returnedCount: count, truncated: false },
  });
}

function assertPartialOutput(output: string, source: string, toolName: string, recalled = false) {
  const match = output.match(/; omitted (\d+)\/\d+ chars\]/);
  assert.ok(match);
  const omittedChars = Number(match[1]);
  const marker = partialOmissionMarker(toolName, source.length, omittedChars, recalled);
  const [head, tail] = output.split(`\n${marker}\n`);
  assert.equal(head.length + omittedChars + tail.length, source.length);
  assert.equal(head, source.slice(0, head.length));
  assert.equal(tail, source.slice(-tail.length));
  return omittedChars;
}

test("partially retains old output and treats all text blocks as one source", () => {
  const source = "x".repeat(4_000) + "y".repeat(SIEVE_THRESHOLD + 1 - 4_000);
  const content = [{ type: "text", text: source.slice(0, 4_000) }, { type: "text", text: source.slice(4_000) }];
  const result = sieveMessages([
    user("first"),
    { ...textResult("bash", "unused"), content },
    user("second"),
    user("third"),
  ]);
  const output = (result.messages[1].content as any)[0].text as string;
  const omittedChars = assertPartialOutput(output, source, "bash");

  assert.equal(output.length, SIEVE_THRESHOLD);
  assert.deepEqual(result.stats, {
    scanned: 1,
    transformed: 1,
    transformedBy: { ...noTransformTypes, ageThreshold: 1 },
    omittedChars,
    netCharsSaved: source.length - output.length,
    byTool: result.stats.byTool,
    skipped: noSkips,
  });
});

test("uses strict age-adjusted thresholds at every age boundary", () => {
  for (const [age, retainedLength, prunedLength] of [
    [2, 4_000, 4_001],
    [5, 4_000, 4_001],
    [6, 2_000, 2_001],
    [8, 2_000, 2_001],
  ] as const) {
    const retained = oldResultAtAge(age, "r".repeat(retainedLength));
    const pruned = oldResultAtAge(age, "p".repeat(prunedLength));
    assert.equal(retained.stats.transformed, 0, `age ${age} equality is retained`);
    assert.equal(pruned.stats.transformedBy.ageThreshold, 1, `age ${age} strictly over threshold is pruned`);
  }
});

test("preserves age 0 and caps only eligible successful age-1 output", () => {
  const age0 = sieveMessages([user("first"), user("current"), textResult("fd", "x".repeat(50_000))], 4_000);
  assert.equal(age0.stats.transformed, 0);
  assert.equal(age0.stats.skipped.recentWindow, 1);

  const equal = oldResultAtAge(1, "x".repeat(12_000));
  const over = oldResultAtAge(1, "x".repeat(12_001));
  assert.equal(equal.stats.transformed, 0);
  assert.equal(over.stats.transformedBy.ageThreshold, 1);

  const activeEqual = sieveMessages([
    user("before"),
    textResult("fd", "x".repeat(4_000)),
    user("after"),
  ], 4_000, { pruneActive: true });
  const activeOver = sieveMessages([
    user("before"),
    textResult("fd", "x".repeat(4_001)),
    user("after"),
  ], 4_000, { pruneActive: true });
  assert.equal(activeEqual.stats.transformed, 0, "active age-1 equality is retained");
  assert.equal(activeOver.stats.transformedBy.ageThreshold, 1, "active age-1 output cannot re-expand");

  const transitioning = textResult("fd", "x".repeat(4_001), { toolCallId: "age-transition", isError: false });
  const atAgeZero = sieveMessages([user("before"), transitioning], 4_000, { pruneActive: true });
  const atAgeOne = sieveMessages([user("before"), transitioning, user("after")], 4_000, { pruneActive: true });
  assert.match((atAgeZero.messages[1] as any).content[0].text, /sieve_recall "age-transition"/);
  assert.doesNotMatch((atAgeOne.messages[1] as any).content[0].text, /sieve_recall/);
  assert.equal(atAgeOne.recoverableActiveResults.length, 0);

  const combined = sieveMessages([
    user("before"),
    textResult("fd", "x".repeat(12_000)),
    textResult("fd", "y".repeat(12_000)),
    user("after"),
  ], 4_000);
  assert.equal(combined.stats.transformed, 0, "age-1 outputs do not share the old-output budget");

  assert.equal(oldResultAtAge(1, "x".repeat(50_000), { isError: true }).stats.transformed, 0);
  const read = sieveMessages([user("before"), textResult("read", "x".repeat(50_000)), user("after")], 4_000);
  assert.equal(read.stats.transformed, 0);
});

test("prunes bulky Heartbeat status and Memory lists without covering short mutation tools", () => {
  const source = "x".repeat(4_001);
  const heartbeat = textResult("heartbeat_status", source, { toolCallId: "heartbeat-1", details: { id: "job-1" } });
  const activeHeartbeat = sieveMessages([user("current"), heartbeat], 4_000, { pruneActive: true });
  assert.equal(activeHeartbeat.stats.transformedBy.activeThreshold, 1);
  assert.ok(((activeHeartbeat.messages[1] as any).content[0].text as string).length <= 4_000);
  assert.match((activeHeartbeat.messages[1] as any).content[0].text, /sieve_recall "heartbeat-1"/);
  assert.deepEqual((activeHeartbeat.messages[1] as any).details, { id: "job-1" });
  assert.equal(activeHeartbeat.recoverableActiveResults[0]?.toolName, "heartbeat_status");
  assert.equal(activeHeartbeat.recoverableActiveResults[0]?.toolCallId, "heartbeat-1");

  const recalledHeartbeat = recalledResult("heartbeat_status", source);
  const agedRecall = sieveMessages([user("before"), recalledHeartbeat, user("second"), user("third")], 4_000);
  assert.equal(agedRecall.stats.transformedBy.ageThreshold, 1);
  assert.match((agedRecall.messages[1] as any).content[0].text, /recalled heartbeat_status/);

  const memoryList = textResult("memory", source, { details: { memoryList: true } });
  const agedMemory = sieveMessages([user("before"), memoryList, user("second"), user("third")], 4_000);
  assert.equal(agedMemory.stats.transformedBy.ageThreshold, 1);

  for (const result of [
    textResult("memory", source, { details: { memoryCandidate: { action: "add", key: "workflow.test" } } }),
    textResult("continuity_update", source),
    textResult("heartbeat_start", source),
    textResult("heartbeat_cancel", source),
  ]) {
    const unchanged = sieveMessages([user("before"), result, user("second"), user("third")], 4_000);
    assert.equal(unchanged.messages[1], result);
    assert.equal(unchanged.stats.skipped.ineligibleTool, 1);
  }
});

test("enforces the retained successful-output budget at equality, overflow, and newest-first", () => {
  const budgetContext = (lengths: number[]) => [
    user("before"),
    ...lengths.map((length, index) => textResult("bash", String(index).repeat(length))),
    user("second"),
    user("third"),
  ];

  const equality = sieveMessages(budgetContext([1_000, 1_000, 1_000]), 1_000);
  assert.equal(equality.stats.transformed, 0);

  const overflow = sieveMessages(budgetContext([1_000, 1_000, 1_000, 1]), 1_000);
  assert.equal(overflow.stats.transformedBy.budget, 1);
  const overflowOutput = (overflow.messages[1].content as any)[0].text as string;
  assertPartialOutput(overflowOutput, "0".repeat(1_000), "bash");
  assert.ok(overflowOutput.length < 1_000);
  assert.equal((overflow.messages[4].content as any)[0].text.length, 1);

  const continueAfterOverflow = sieveMessages(budgetContext([800, 800, 800, 800, 800]), 1_000);
  assert.equal(continueAfterOverflow.stats.transformedBy.budget, 2);
  assert.equal((continueAfterOverflow.messages[1].content as any)[0].text, omissionMarker("bash", 800));
  assertPartialOutput((continueAfterOverflow.messages[2].content as any)[0].text, "1".repeat(800), "bash");
  assert.equal((continueAfterOverflow.messages[3].content as any)[0].text.length, 800);

  const tiny = textResult("bash", "x".repeat(11));
  const noExpansion = sieveMessages([user("before"), tiny, user("second"), user("third")], 10);
  assert.equal(noExpansion.messages[1], tiny, "marker larger than source fails open");
  assert.equal(noExpansion.stats.transformed, 0);
});

test("caps eligible old errors at the configured threshold with diagnostic head and tail", () => {
  const equal = oldResultAtAge(2, "x".repeat(4_000), { isError: true });
  assert.equal(equal.stats.transformed, 0);

  const source = "h".repeat(5_000) + "t".repeat(5_001);
  const result = sieveMessages([
    user("before"), textResult("bash", source, { isError: true }), user("second"), user("third"),
  ], 10_000);
  assert.equal(result.stats.transformedBy.errorCap, 1);
  const output = (result.messages[1].content as any)[0].text as string;
  assert.equal(output.length, 10_000);
  assert.match(output, /^\[pi-sieve: bash error;/);
  assert.match(output, /h+\nh*t+$/);
});

test("prunes a read only after a successful mutation and covering post-mutation read", () => {
  const cwd = resolve("stale-read-workspace");
  const relativePath = "src/example\u00a0file.ts";
  const normalizedRelativePath = "src/example file.ts";
  const absolutePath = resolve(cwd, normalizedRelativePath);
  const oldSource = "old snapshot\n".repeat(100);
  const newSource = "current snapshot\n".repeat(100);
  const messages = [
    user("update the file"),
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-old", name: "read", arguments: { path: relativePath, offset: 10, limit: 20 } }],
    },
    {
      ...textResult("read", oldSource, { toolCallId: "read-old", isError: false, details: { source: "preserved" } }),
      custom: true,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: normalizedRelativePath, edits: [{ oldText: "old", newText: "new" }] } }],
    },
    textResult("edit", "Successfully replaced 1 block", { toolCallId: "edit", isError: false }),
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-new", name: "read", arguments: { path: absolutePath, offset: 1, limit: 40 } }],
    },
    textResult("read", newSource, { toolCallId: "read-new", isError: false }),
  ];

  const result = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  const stale: any = result.messages[2];
  assert.deepEqual(stale.content, [{ type: "text", text: staleReadMarker(relativePath, oldSource.length) }]);
  assert.equal(stale.toolCallId, "read-old");
  assert.deepEqual(stale.details, { source: "preserved" });
  assert.equal(stale.custom, true);
  assert.equal(result.messages[6], messages[6]);
  assert.equal((messages[2] as any).content[0].text, oldSource, "stored source message remains untouched");
  assert.equal(result.stats.transformedBy.staleRead, 1);
  assert.equal(result.stats.omittedChars, oldSource.length);
  assert.equal(result.stats.netCharsSaved, oldSource.length - stale.content[0].text.length);
});

test("keeps reads when mutation ordering, success, or range coverage is ambiguous", () => {
  const cwd = resolve("stale-read-safety");
  const source = "context\n".repeat(100);
  const context = (mutationError: boolean, newArguments: Record<string, unknown>, sameTurn = false) => {
    const oldCall = { type: "toolCall", id: "old", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } };
    const mutationCall = { type: "toolCall", id: "mutation", name: "write", arguments: { path: "file.ts", content: "new" } };
    const newCall = { type: "toolCall", id: "new", name: "read", arguments: { path: "file.ts", ...newArguments } };
    return [
      user("update"),
      { role: "assistant", content: [oldCall] },
      textResult("read", source, { toolCallId: "old", isError: false }),
      { role: "assistant", content: sameTurn ? [mutationCall, newCall] : [mutationCall] },
      textResult("write", "write result", { toolCallId: "mutation", isError: mutationError }),
      ...(sameTurn ? [] : [{ role: "assistant", content: [newCall] }]),
      textResult("read", "new context\n".repeat(100), { toolCallId: "new", isError: false }),
    ];
  };

  for (const messages of [
    context(true, { offset: 1, limit: 100 }),
    context(false, { offset: 50, limit: 20 }),
    context(false, { offset: 1, limit: 100 }),
    context(false, { offset: 1, limit: 100 }, true),
  ]) {
    const result = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
    assert.equal(result.messages[2], messages[2]);
    assert.equal(result.stats.transformedBy.staleRead, 0);
  }

  const wholeFileAfterWrite = context(false, {});
  const pruned = sieveMessages(wholeFileAfterWrite, SIEVE_THRESHOLD, { cwd });
  assert.match((pruned.messages[2] as any).content[0].text, /stale read/);
});

test("ambiguous mutation attempts block partial pruning but allow a later whole-file snapshot", () => {
  const source = "baseline\n".repeat(100);
  const messages: any[] = [
    user("update"),
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } }] },
    textResult("read", source, { toolCallId: "old", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "x", newText: "x\nshift" }] } }] },
    textResult("edit", "aborted after write", { toolCallId: "failed", isError: true }),
    { role: "assistant", content: [{ type: "toolCall", id: "ok", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
    textResult("edit", "edited", { toolCallId: "ok", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } }] },
    textResult("read", "current\n".repeat(100), { toolCallId: "new", isError: false }),
  ];
  const cwd = resolve("ambiguous-mutation");
  const partial = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  assert.equal(partial.messages[2], messages[2]);

  delete messages[7].content[0].arguments.limit;
  const wholeFile = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  assert.match(wholeFile.messages[2].content[0].text, /stale read/);

  messages[3].content.push({
    type: "toolCall", id: "ok", name: "edit",
    arguments: { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] },
  });
  messages[7].content[0].arguments.limit = 100;
  const duplicateId = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  assert.equal(duplicateId.messages[2], messages[2]);
});

test("rejects malformed and overflowing read ranges", () => {
  const source = "baseline\n".repeat(100);
  const messages: any[] = [
    user("update"),
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } }] },
    textResult("read", source, { toolCallId: "old", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
    textResult("edit", "edited", { toolCallId: "edit", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "file.ts", offset: Number.MAX_SAFE_INTEGER, limit: 2 } }] },
    textResult("read", "current", { toolCallId: "new", isError: false }),
  ];
  const result = sieveMessages(messages, SIEVE_THRESHOLD, { cwd: resolve("bad-ranges") });
  assert.equal(result.messages[2], messages[2]);
});

test("uses actual returned lines for limited reads that reach EOF", () => {
  const source = Array.from({ length: 100 }, (_, index) => `old-${index}`).join("\n");
  const messages: any[] = [
    user("update"),
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } }] },
    textResult("read", source, { toolCallId: "old", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
    textResult("edit", "edited", { toolCallId: "edit", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "file.ts", offset: 1, limit: 100 } }] },
    textResult("read", Array.from({ length: 20 }, (_, index) => `new-${index}`).join("\n"), { toolCallId: "new", isError: false }),
  ];
  const cwd = resolve("eof-read");
  const limited = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  assert.equal(limited.messages[2], messages[2]);

  delete messages[5].content[0].arguments.limit;
  const wholeFile = sieveMessages(messages, SIEVE_THRESHOLD, { cwd });
  assert.match(wholeFile.messages[2].content[0].text, /stale read/);
});

test("uses truncation metadata when deciding whether a newer read covers an old read", () => {
  const source = "old\n".repeat(300);
  const messages = [
    user("update"),
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "file.ts", offset: 50 } }] },
    textResult("read", source, {
      toolCallId: "old",
      isError: false,
      details: { truncation: { truncated: true, firstLineExceedsLimit: false, outputLines: 25 } },
    }),
    { role: "assistant", content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
    textResult("edit", "edited", { toolCallId: "edit", isError: false }),
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "file.ts", offset: 40, limit: 40 } }] },
    textResult("read", "new\n".repeat(300), { toolCallId: "new", isError: false }),
  ];
  const result = sieveMessages(messages, SIEVE_THRESHOLD, { cwd: resolve("truncated-read") });
  assert.match((result.messages[2] as any).content[0].text, /stale read/);

  (messages[5] as any).content[0].arguments.limit = 20;
  const uncovered = sieveMessages(messages, SIEVE_THRESHOLD, { cwd: resolve("truncated-read") });
  assert.equal(uncovered.messages[2], messages[2]);
});

test("keeps read output, including giant successes and errors, fully preserved", () => {
  const giant = "x".repeat(40_001);
  const readSuccess = textResult("read", giant);
  const readError = textResult("read", giant, { isError: true });
  const result = sieveMessages([user("first"), readSuccess, readError, user("second"), user("third")]);

  assert.equal(result.messages[1], readSuccess);
  assert.equal(result.messages[2], readError);
  assert.deepEqual(result.stats.transformedBy, noTransformTypes);
  assert.equal(result.stats.skipped.ineligibleTool, 2);
});

test("structure-aware ranked search pruning preserves valid JSON, rank order, and active recall", () => {
  for (const [toolName, kind] of [["symbol_search", "symbol"], ["code_search", "code"]] as const) {
    const source = rankedSearchText(kind);
    const active = textResult(toolName, source, { toolCallId: `${toolName}-active` });
    const activeResult = sieveMessages([user("current"), active], 1_000, { pruneActive: true });
    const activeOutput = JSON.parse((activeResult.messages[1].content as any)[0].text);

    assert.ok(activeOutput.results.length > 0);
    assert.ok(activeOutput.results.length < 20);
    assert.equal(activeOutput.returned, activeOutput.results.length);
    assert.equal(activeOutput.truncated, true);
    assert.deepEqual(
      activeOutput.results.map((result: any) => result.path),
      Array.from({ length: activeOutput.results.length }, (_, index) => `src/result-${index}.ts`),
    );
    assert.deepEqual(activeOutput.piSieve.recoverVia, {
      tool: "sieve_recall",
      toolCallId: `${toolName}-active`,
    });
    assert.equal(activeResult.recoverableActiveResults[0].toolCallId, `${toolName}-active`);
    assert.equal(activeResult.stats.transformedBy.activeThreshold, 1);

    const aged = sieveMessages([user("before"), active, user("second"), user("third")], 1_000);
    const agedOutput = JSON.parse((aged.messages[1].content as any)[0].text);
    assert.ok(agedOutput.results.length < 20);
    assert.equal(agedOutput.returned, agedOutput.results.length);
    assert.equal(agedOutput.truncated, true);
    assert.equal(agedOutput.results[0].path, "src/result-0.ts");
    assert.equal(agedOutput.piSieve.recoverVia, undefined);
    assert.equal(aged.stats.transformedBy.ageThreshold, 1);
  }

  const malformed = textResult("code_search", "{" + "x".repeat(2_000), { toolCallId: "malformed" });
  const malformedResult = sieveMessages([user("current"), malformed], 1_000, { pruneActive: true });
  assert.equal(malformedResult.messages[1], malformed, "malformed structured output fails open");
  assert.equal(malformedResult.stats.skipped.malformedStructuredContent, 1);
  const malformedAged = sieveMessages([user("before"), malformed, user("second"), user("third")], 1_000);
  assert.equal(malformedAged.messages[1], malformed, "malformed aged search output fails open");
  assert.equal(malformedAged.stats.skipped.malformedStructuredContent, 1);
});

test("relationship graph keeps recent output, prunes complete graph records, then becomes marker-only", () => {
  const source = relationshipGraphText();
  const graph = textResult("relationship_graph", source, { toolCallId: "graph" });
  const active = sieveMessages([user("current"), graph], 1_000, { pruneActive: true });
  assert.equal(active.messages[1], graph);

  const ageOne = sieveMessages([user("before"), graph, user("after")], 1_000, { pruneActive: true });
  assert.equal(ageOne.messages[1], graph);

  const aged = sieveMessages([user("before"), graph, user("second"), user("third")], 1_000);
  const agedGraph = JSON.parse((aged.messages[1].content as any)[0].text);
  assert.ok(agedGraph.metadata.returnedCount < 12);
  assert.equal(agedGraph.metadata.truncated, true);
  assert.equal(agedGraph.piSieve.omittedLocations, 12 - agedGraph.metadata.returnedCount);
  assert.equal(agedGraph.files.reduce((count: number, file: any) => count + file.locations.length, 0), agedGraph.metadata.returnedCount);
  assert.equal(aged.stats.transformedBy.ageThreshold, 1);

  const old = sieveMessages([
    user("before"), graph,
    ...Array.from({ length: 6 }, (_, index) => user(`after-${index}`)),
  ], 10_000);
  assert.deepEqual(JSON.parse((old.messages[1].content as any)[0].text), {
    piSieve: {
      pruned: true,
      sourceToolName: "relationship_graph",
      sourceChars: source.length,
      omitted: true,
    },
  });

  const malformedGraphValue = JSON.parse(source);
  malformedGraphValue.files[0].locations[0].line = "bad";
  const malformedGraph = textResult("relationship_graph", JSON.stringify(malformedGraphValue));
  for (const age of [2, 6]) {
    const result = sieveMessages([
      user("before"), malformedGraph,
      ...Array.from({ length: age }, (_, index) => user(`malformed-after-${index}`)),
    ], 1_000);
    assert.equal(result.messages[1], malformedGraph, `malformed graph fails open at age ${age}`);
    assert.equal(result.stats.skipped.malformedStructuredContent, 1);
  }

  const status = textResult("index_status", "x".repeat(20_000));
  const statusResult = sieveMessages([user("before"), status, user("second"), user("third")], 1_000);
  assert.equal(statusResult.messages[1], status);
});

test("records recent-window and old-result skip reasons, including malformed and empty blocks", () => {
  const old = [
    textResult("bash", "x".repeat(SIEVE_THRESHOLD)),
    textResult("read", "x".repeat(8_001)),
    textResult("other", "x".repeat(8_001)),
    textResult("bash", "x".repeat(8_001), { isError: true }),
    textResult("bash", "x".repeat(8_001), { content: [{ type: "text", text: "x" }, { type: "image", data: "image" }] }),
    textResult("bash", "x".repeat(8_001), { content: [] }),
    textResult("bash", "x".repeat(8_001), { content: [{ type: "text" }] }),
    textResult("bash", "x".repeat(8_001), { content: [{ type: "text", text: "" }] }),
  ];
  const recent = textResult("bash", "x".repeat(8_001));
  const result = sieveMessages([user("first"), ...old, user("second"), recent, user("third")]);

  assert.equal(result.messages.at(-2), recent);
  assert.deepEqual(result.stats, {
    scanned: 9,
    transformed: 0,
    transformedBy: noTransformTypes,
    omittedChars: 0,
    netCharsSaved: 0,
    byTool: result.stats.byTool,
    skipped: {
      recentWindow: 0,
      ineligibleTool: 2,
      error: 1,
      nonTextMixedOrEmptyContent: 2,
      malformedStructuredContent: 0,
      atOrBelowThreshold: 4,
      recoveryUnavailable: 0,
    },
  });

  const noWindow = sieveMessages([user("only"), textResult("bash", "x".repeat(8_001))]);
  assert.deepEqual(noWindow.stats, {
    scanned: 0,
    transformed: 0,
    transformedBy: noTransformTypes,
    omittedChars: 0,
    netCharsSaved: 0,
    byTool: noWindow.stats.byTool,
    skipped: { ...noSkips, recentWindow: 1 },
  });
});

test("preserves age 0 and stored session messages", () => {
  const original = Object.freeze(textResult("fd", "x".repeat(SIEVE_THRESHOLD + 1), {
    toolCallId: "preserved-call", isError: false, timestamp: 123, details: { source: "tool" }, custom: true,
  }));
  const ageOneError = textResult("bash", "x".repeat(40_001), { isError: true });
  const ageOneSuccess = textResult("bash", "x".repeat(8_001));
  const ageZeroSuccess = textResult("bash", "x".repeat(50_000));
  const originalContent = original.content;
  const result = sieveMessages([
    user("first"), original, user("second"), ageOneError, ageOneSuccess, user("third"), ageZeroSuccess,
  ]);
  const transformed: any = result.messages[1];

  assert.notEqual(transformed, original);
  assert.equal(transformed.toolCallId, "preserved-call");
  assert.equal(transformed.toolName, "fd");
  assert.equal(transformed.timestamp, 123);
  assert.deepEqual(transformed.details, { source: "tool" });
  assert.equal(original.content, originalContent);
  assert.equal((original.content as any)[0].text.length, SIEVE_THRESHOLD + 1);
  assert.equal(result.messages[3], ageOneError);
  assert.equal(result.messages[4], ageOneSuccess);
  assert.equal(result.messages[6], ageZeroSuccess);
  assert.equal(result.stats.skipped.recentWindow, 1);
});

test("keeps recalls visible at age 0 then prunes eligible recalled output with age", () => {
  const activeRecall = recalledResult("bash", "x".repeat(50_000));
  const current = sieveMessages([user("current"), activeRecall], 4_000, { pruneActive: true });
  assert.equal(current.messages[1], activeRecall);
  assert.equal(current.stats.transformed, 0);

  const agedRecallText = "x".repeat(12_001);
  const agedRecall = recalledResult("rg", agedRecallText);
  const aged = sieveMessages([user("before"), agedRecall, user("after")], 4_000, { pruneActive: true });
  const agedOutput = (aged.messages[1].content as any)[0].text as string;
  assert.equal(agedOutput.length, 4_000);
  assert.match(agedOutput, /\[pi-sieve: recalled rg; omitted/);
  assert.doesNotMatch(agedOutput, /sieve_recall/);
  assert.equal(aged.stats.transformedBy.ageThreshold, 1);

  const budgetRecall = recalledResult("fd", "r".repeat(1_000));
  const budgeted = sieveMessages([
    user("before"),
    budgetRecall,
    textResult("bash", "a".repeat(1_000)),
    textResult("bash", "b".repeat(1_000)),
    textResult("bash", "c".repeat(1_000)),
    user("second"),
    user("third"),
  ], 1_000);
  assert.equal((budgeted.messages[1].content as any)[0].text, recalledOmissionMarker("fd", 1_000));
  assert.equal(budgeted.stats.transformedBy.budget, 1);

  const giantError = recalledResult("bash", "x".repeat(32_001), { sourceIsError: true });
  const oldError = sieveMessages([user("before"), giantError, user("second"), user("third")], 4_000);
  assert.match((oldError.messages[1].content as any)[0].text, /^\[pi-sieve: recalled bash error;/);
  assert.equal(oldError.stats.transformedBy.errorCap, 1);

  const boundaryError = recalledResult("bash", "x".repeat(4_000), { sourceIsError: true });
  const retainedError = sieveMessages([user("before"), boundaryError, user("second"), user("third")], 4_000);
  assert.equal(retainedError.messages[1], boundaryError);
  assert.equal(retainedError.stats.skipped.error, 1);

  for (const untouched of [
    recalledResult("read", "x".repeat(50_000)),
    recalledResult("unknown", "x".repeat(50_000)),
    textResult("sieve_recall", "x".repeat(50_000), { isError: true, details: { found: true, sourceToolName: "bash", sourceIsError: false } }),
    textResult("sieve_recall", "x".repeat(50_000), { details: null }),
    textResult("sieve_recall", "x".repeat(50_000), { details: [] }),
    textResult("sieve_recall", "x".repeat(50_000), { details: { found: "yes", sourceToolName: "bash", sourceIsError: false } }),
    textResult("sieve_recall", "x".repeat(50_000), { details: { found: true, sourceToolName: 1, sourceIsError: false } }),
    textResult("sieve_recall", "x".repeat(50_000), { details: { found: true, sourceToolName: "bash", sourceIsError: "no" } }),
    textResult("sieve_recall", "x".repeat(50_000), { details: { found: false, sourceToolName: "bash", sourceIsError: false } }),
  ]) {
    const result = sieveMessages([user("before"), untouched, user("second"), user("third")], 4_000);
    assert.equal(result.messages[1], untouched);
    assert.equal(result.stats.transformed, 0);
  }
});

test("partially prunes recoverable active results and registers full-result recovery", () => {
  assert.equal(
    activeOmissionMarker("rg", "call-1", 30_356, 22_347),
    '[pi-sieve: rg; omitted 22347/30356 chars; sieve_recall "call-1"]',
  );

  const successText = "h".repeat(2_001) + "t".repeat(2_000);
  const success = {
    ...textResult("bash", "unused", { toolCallId: "active-success" }),
    content: [{ type: "text", text: successText.slice(0, 2_001) }, { type: "text", text: successText.slice(2_001) }],
  };
  const errorText = "e".repeat(SIEVE_THRESHOLD + 1);
  const error = textResult("rg", errorText, { toolCallId: "active-error", isError: true });
  const read = textResult("read", "r".repeat(10_000), { toolCallId: "active-read" });
  const result = sieveMessages([user("first"), success, error, read], 4_000, { pruneActive: true });

  const successRecovery = result.recoverableActiveResults.find(({ toolCallId }) => toolCallId === "active-success")!;
  assert.equal(successRecovery.toolName, "bash");
  const successOutbound = (result.messages[1].content as any)[0].text as string;
  const successMatch = successOutbound.match(/omitted (\d+)\/\d+ chars/)!;
  const successOmittedLength = Number(successMatch[1]);
  const successMarker = activeOmissionMarker("bash", "active-success", successText.length, successOmittedLength);
  const [successHead, successTail] = successOutbound.split(`\n${successMarker}\n`);
  const successOmitted = successText.slice(successHead.length, successText.length - successTail.length);
  assert.equal(successOutbound.length, 4_000);
  assert.equal(successHead + successOmitted + successTail, successText);

  const errorRecovery = result.recoverableActiveResults.find(({ toolCallId }) => toolCallId === "active-error")!;
  assert.equal(errorRecovery.toolName, "rg");
  const errorOutbound = (result.messages[2].content as any)[0].text as string;
  const errorOmittedLength = Number(errorOutbound.match(/omitted (\d+)\/\d+ chars/)![1]);
  const errorMarker = activeOmissionMarker("rg", "active-error", errorText.length, errorOmittedLength);
  assert.equal(errorOutbound.length, SIEVE_THRESHOLD);
  assert.equal(errorOutbound, errorMarker + "\n" + errorText.slice(errorOmittedLength));

  assert.equal(result.messages[3], read);
  assert.equal((success.content as any)[0].text + (success.content as any)[1].text, successText);
  assert.equal(result.stats.transformedBy.activeThreshold, 2);
  assert.equal(result.stats.omittedChars, successOmitted.length + errorOmittedLength);
  assert.equal(result.stats.netCharsSaved, successText.length + errorText.length - successOutbound.length - errorOutbound.length);
  assert.deepEqual(
    new Set(result.recoverableActiveResults.map(({ toolCallId }) => toolCallId)),
    new Set(["active-success", "active-error"]),
  );

  const equal = sieveMessages([user("first"), textResult("bash", "x".repeat(4_000))], 4_000, { pruneActive: true });
  assert.equal(equal.stats.transformed, 0);

  const duplicateOrMissing = sieveMessages([
    user("first"),
    textResult("bash", "a".repeat(4_001), { toolCallId: "duplicate" }),
    textResult("bash", "b".repeat(4_001), { toolCallId: "duplicate" }),
    textResult("bash", "c".repeat(4_001), { toolCallId: "" }),
  ], 4_000, { pruneActive: true });
  assert.equal(duplicateOrMissing.stats.transformed, 0);
  assert.equal(duplicateOrMissing.stats.skipped.recoveryUnavailable, 3);

  const oversizedMarker = sieveMessages([
    user("first"),
    textResult("bash", "x".repeat(101), { toolCallId: "id".repeat(100) }),
  ], 100, { pruneActive: true });
  assert.equal(oversizedMarker.stats.transformed, 0);
  assert.equal(oversizedMarker.stats.skipped.recoveryUnavailable, 1);
});

test("active slicing converges across tiny, odd, and omitted-count boundary payloads", () => {
  const source = Array.from({ length: 1_100 }, (_, index) => String(index % 10)).join("");
  for (const [candidateRetainedChars, expectedRetainedChars] of [[1, 1], [3, 3], [101, 100]]) {
    const candidateOmittedChars = source.length - candidateRetainedChars;
    const candidateMarker = activeOmissionMarker("bash", "boundary", source.length, candidateOmittedChars);
    const threshold = candidateMarker.length + 2 + candidateRetainedChars;
    const result = sieveMessages([
      user("first"),
      textResult("bash", source, { toolCallId: "boundary" }),
    ], threshold, { pruneActive: true });
    const outbound = (result.messages[1].content as any)[0].text as string;
    assert.equal(result.recoverableActiveResults[0].toolCallId, "boundary");
    const omittedLength = Number(outbound.match(/omitted (\d+)\/\d+ chars/)![1]);
    const marker = activeOmissionMarker("bash", "boundary", source.length, omittedLength);
    const [head, tail] = outbound.split(`\n${marker}\n`);
    const omitted = source.slice(head.length, source.length - tail.length);

    assert.equal(outbound.length, threshold);
    assert.equal(source.length - omittedLength, expectedRetainedChars);
    assert.equal(head.length, Math.floor(expectedRetainedChars / 2));
    assert.equal(tail.length, expectedRetainedChars - head.length);
    assert.equal(head + omitted + tail, source);
  }
});

test("prunes only the later exact read duplicate and blocks dedupe across ambiguous mutations", () => {
  const source = "same snapshot\n".repeat(100);
  const call = (id: string, name: string, argumentsValue: Record<string, unknown>) => ({
    role: "assistant", content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
  });
  const readResult = (id: string) => textResult("read", source, { toolCallId: id, isError: false });
  const messages = [
    user("inspect"),
    call("read-1", "read", { path: "src/a.ts", offset: 1, limit: 100 }), readResult("read-1"),
    call("read-2", "read", { path: "src/a.ts", offset: 1, limit: 100 }), readResult("read-2"),
  ];
  const result = sieveMessages(messages, 1_000, { pruneActive: true, cwd: resolve("dedupe") });
  assert.equal(result.messages[2], messages[2]);
  assert.match((result.messages[4] as any).content[0].text, /duplicate read.*same as "read-1".*sieve_recall "read-2"/);
  assert.equal(result.stats.transformedBy.duplicate, 1);
  assert.deepEqual(result.recoverableActiveResults, [{ toolCallId: "read-2", toolName: "read", isError: false }]);

  const blocked = [...messages.slice(0, 3),
    call("edit-1", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }),
    ...messages.slice(3),
  ];
  const blockedResult = sieveMessages(blocked, 1_000, { pruneActive: true, cwd: resolve("dedupe") });
  assert.equal(blockedResult.stats.transformedBy.duplicate, 0);
  assert.equal(blockedResult.messages[6], blocked[6]);

  const sameMessage = [
    ...messages.slice(0, 3),
    { role: "assistant", content: [
      { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] } },
      { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/a.ts", offset: 1, limit: 100 } },
    ] },
    textResult("edit", "ambiguous", { toolCallId: "edit-1", isError: true }),
    readResult("read-2"),
  ];
  const sameMessageResult = sieveMessages(sameMessage, 1_000, { pruneActive: true, cwd: resolve("dedupe") });
  assert.equal(sameMessageResult.stats.transformedBy.duplicate, 0);
  assert.equal(sameMessageResult.messages[5], sameMessage[5]);
});

test("deduplicates only later exact successful results", () => {
  const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "rg", arguments: { pattern: "x" } }] });
  const source = "match\n".repeat(100);
  const first = textResult("rg", source, { toolCallId: "rg-1", isError: false, details: { truncated: false } });
  const second = textResult("rg", source, { toolCallId: "rg-2", isError: false, details: { truncated: false } });
  const result = sieveMessages([user("search"), call("rg-1"), first, call("rg-2"), second], 1_000, { pruneActive: true });
  assert.equal(result.messages[2], first);
  assert.match((result.messages[4] as any).content[0].text, /duplicate rg/);
  assert.equal(result.stats.transformedBy.duplicate, 1);

  const failed = textResult("rg", source, { toolCallId: "rg-2", isError: true, details: { truncated: false } });
  const failureResult = sieveMessages([user("search"), call("rg-1"), first, call("rg-2"), failed], 1_000, { pruneActive: true });
  assert.equal(failureResult.stats.transformedBy.duplicate, 0);
  assert.equal(failureResult.messages[4], failed);
});

test("prunes eligible text inside mixed content without changing image blocks", () => {
  const image = { type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } };
  const mixed = {
    ...textResult("bash", "unused", { toolCallId: "mixed", isError: false }),
    content: [{ type: "text", text: "h".repeat(2_000) }, image, { type: "text", text: "t".repeat(2_000) }],
  };
  const result = sieveMessages([user("current"), mixed], 1_000, { pruneActive: true });
  const output = (result.messages[1] as any).content;
  assert.deepEqual(output[1], image);
  assert.ok(output[0].text.length < 2_000 && output[2].text.length < 2_000);
  assert.equal(result.stats.transformedBy.mixedText, 1);
  assert.equal((mixed.content[0] as any).text.length, 2_000);
});

test("keeps unique delegated evidence and verify failures protected", () => {
  for (const toolName of ["advisor", "repo_scout", "grunt"]) {
    const result = textResult(toolName, "evidence".repeat(2_000), { toolCallId: `${toolName}-1`, isError: false });
    const output = sieveMessages([user("current"), result], 1_000, { pruneActive: true });
    assert.equal(output.messages[1], result);
    assert.equal(output.stats.transformed, 0);
  }
  const failure = textResult("verify", "failure".repeat(2_000), { toolCallId: "verify-1", isError: true });
  const output = sieveMessages([user("before"), failure, user("second"), user("third")], 1_000, { pruneActive: true });
  assert.equal(output.messages[1], failure);
  assert.equal(output.stats.transformed, 0);
});

test("caps age-zero results independently without a shared retained budget", () => {
  const below = Array.from({ length: 4 }, (_, index) => textResult("bash", String(index).repeat(900), {
    toolCallId: `active-below-${index}`, isError: false,
  }));
  const retained = sieveMessages([user("current"), ...below], 1_000, { pruneActive: true });
  assert.equal(retained.stats.transformed, 0);
  assert.deepEqual(retained.messages.slice(1), below);

  const above = Array.from({ length: 4 }, (_, index) => textResult("bash", String(index).repeat(1_200), {
    toolCallId: `active-above-${index}`, isError: false,
  }));
  const pruned = sieveMessages([user("current"), ...above], 1_000, { pruneActive: true });
  assert.equal(pruned.stats.transformedBy.activeThreshold, 4);
  assert.equal(pruned.stats.transformedBy.budget, 0);
  assert.ok(pruned.messages.slice(1).every((message: any) => message.content[0].text.length <= 1_000));
});

test("stable epochs freeze every prior result while context grows beyond the soft budget", () => {
  const epoch = createProjectionEpoch("session-start", {
    threshold: 1_000, activePruning: true, rolloverHighMultiplier: 3, rolloverLowMultiplier: 2,
  }, "prompt");
  const call = (id: string, name = "bash", argumentsValue: Record<string, unknown> = {}) => ({
    role: "assistant", content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
  });
  const messages: any[] = [user("start")];
  const prior = new Map<string, string>();

  for (let index = 0; index < 6; index++) {
    const id = `stable-${index}`;
    messages.push(call(id), textResult("bash", String(index).repeat(2_000), { toolCallId: id, isError: false }));
    const result = stableSieveMessages(messages, epoch, { cwd: resolve("stable") });
    for (const message of result.messages as any[]) {
      if (message.role !== "toolResult") continue;
      const serialized = JSON.stringify(message);
      assert.equal(prior.get(message.toolCallId) ?? serialized, serialized, `projection ${message.toolCallId} changed`);
      prior.set(message.toolCallId, serialized);
    }
    assert.equal((result.messages.at(-1) as any).content[0].text.length, 1_000);
  }

  const beforeUser = stableSieveMessages(messages, epoch, { cwd: resolve("stable") });
  messages.push(user("continue"));
  const afterUser = stableSieveMessages(messages, epoch, { cwd: resolve("stable") });
  assert.deepEqual(afterUser.messages.slice(0, -1), beforeUser.messages);
  assert.equal(afterUser.diagnostics.softBudgetExceeded, true);
  assert.equal(afterUser.diagnostics.sourceMismatches, 0);
  assert.equal(epoch.entries.size, 6);
});

test("budget rollover favors newest results, reaches its target, and freezes the new epoch", () => {
  const messages: any[] = [user("start")];
  for (let index = 0; index < 6; index++) {
    messages.push(textResult("bash", String(index).repeat(2_000), { toolCallId: `roll-${index}`, isError: false }));
  }
  const originalEpoch = createProjectionEpoch("session-start", {
    threshold: 1_000, activePruning: true, rolloverHighMultiplier: 3, rolloverLowMultiplier: 2,
  }, "prompt");
  const original = stableSieveMessages(messages, originalEpoch);
  assert.equal(original.diagnostics.softBudgetExceeded, true);

  const rolloverEpoch = createProjectionEpoch("budget-rollover", {
    threshold: 1_000, activePruning: true, rolloverHighMultiplier: 3, rolloverLowMultiplier: 2,
  }, "prompt");
  const rolled = rolloverStableSieveMessages(messages, rolloverEpoch, 2_000);
  assert.ok(retainedProjectionBudget(rolloverEpoch) <= 2_000);
  assert.equal(rolloverEpoch.entries.get("roll-0")?.retainedSourceChars, 0);
  assert.ok((rolloverEpoch.entries.get("roll-5")?.retainedSourceChars ?? 0) > 0);
  assert.equal(rolled.diagnostics.softBudgetExceeded, false);
  assert.deepEqual(stableSieveMessages(messages, rolloverEpoch).messages, rolled.messages);

  const read = textResult("read", "read".repeat(1_000), { toolCallId: "protected-read", isError: false });
  const error = textResult("bash", "error".repeat(400), { toolCallId: "protected-error", isError: true });
  const duplicateA = textResult("bash", "one", { toolCallId: "duplicate-id", isError: false });
  const duplicateB = textResult("bash", "two", { toolCallId: "duplicate-id", isError: false });
  const edgeMessages: any[] = [user("edges"), read, error, duplicateA, duplicateB, ...messages.slice(1)];
  const edgeEpoch = createProjectionEpoch("budget-rollover", {
    threshold: 1_000, activePruning: true, rolloverHighMultiplier: 3, rolloverLowMultiplier: 2,
  }, "prompt");
  const edge = rolloverStableSieveMessages(edgeMessages, edgeEpoch, 2_000);
  assert.deepEqual(edge.messages.slice(1, 5), [read, error, duplicateA, duplicateB]);
  assert.equal(edgeEpoch.entries.has("duplicate-id"), false);
  assert.ok(retainedProjectionBudget(edgeEpoch) <= 2_000);
});

test("regression replay keeps stable and restored legacy history fixed during one tool turn", () => {
  const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: id } }] });
  const messages: any[] = [user("long tool turn")];
  const epoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  let previousStable: any[] = [];
  let previousLegacy: any[] = [];
  let stableChangedHistoricalResults = 0;
  let legacyChangedHistoricalResults = 0;
  let stableRetainedChars = 0;
  let legacyRetainedChars = 0;

  for (let index = 0; index < 7; index++) {
    const id = `replay-${index}`;
    messages.push(call(id), textResult("bash", String(index).repeat(1_200), { toolCallId: id, isError: false }));
    const stable = stableSieveMessages(messages, epoch);
    const legacy = sieveMessages(messages, 1_000, { pruneActive: true });
    const historicalLength = previousStable.length;
    assert.deepEqual(stable.messages.slice(0, historicalLength), previousStable, `stable request ${index} rewrote its prefix`);
    for (let messageIndex = 0; messageIndex < previousLegacy.length; messageIndex++) {
      if ((previousLegacy[messageIndex] as any)?.role === "toolResult"
        && JSON.stringify(previousLegacy[messageIndex]) !== JSON.stringify(legacy.messages[messageIndex]))
        legacyChangedHistoricalResults++;
    }
    for (let messageIndex = 0; messageIndex < previousStable.length; messageIndex++) {
      if ((previousStable[messageIndex] as any)?.role === "toolResult"
        && JSON.stringify(previousStable[messageIndex]) !== JSON.stringify(stable.messages[messageIndex]))
        stableChangedHistoricalResults++;
    }
    previousStable = structuredClone(stable.messages);
    previousLegacy = structuredClone(legacy.messages);
    stableRetainedChars = stable.stats.byTool.bash?.retainedChars ?? 0;
    legacyRetainedChars = legacy.stats.byTool.bash?.retainedChars ?? 0;
  }

  assert.equal(stableChangedHistoricalResults, 0);
  assert.equal(legacyChangedHistoricalResults, 0, "independent age-zero caps must not rewrite prior results");
  assert.ok(stableRetainedChars > 3_000, "stable mode reports append-only retained growth");
  assert.ok(legacyRetainedChars <= stableRetainedChars);
});

test("stable projection applies only append-safe caps and duplicates", () => {
  const call = (id: string, name: string, argumentsValue: Record<string, unknown> = {}) => ({
    role: "assistant", content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
  });
  const readText = "read evidence\n".repeat(200);
  const delegated = "delegated evidence".repeat(200);
  const ranked = rankedSearchText("symbol");
  const graph = relationshipGraphText();
  const image = { type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } };
  const mixed = { ...textResult("bash", "unused", { toolCallId: "mixed-stable", isError: false }), content: [{ type: "text", text: "x".repeat(2_000) }, image] };
  const messages: any[] = [
    user("inspect"),
    call("read-1", "read", { path: "a.ts", offset: 1, limit: 200 }), textResult("read", readText, { toolCallId: "read-1", isError: false }),
    call("advisor-1", "advisor", { request: "review" }), textResult("advisor", delegated, { toolCallId: "advisor-1", isError: false }),
    call("verify-1", "verify", { scope: "changed" }), textResult("verify", delegated, { toolCallId: "verify-1", isError: true }),
    call("ranked-1", "symbol_search", { query: "run" }), textResult("symbol_search", ranked, { toolCallId: "ranked-1", isError: false }),
    call("graph-1", "relationship_graph", { query: "run" }), textResult("relationship_graph", graph, { toolCallId: "graph-1", isError: false }),
    call("mixed-stable", "bash"), mixed,
    call("recall-stable", "sieve_recall", { toolCallId: "ranked-1" }), textResult("sieve_recall", delegated, { toolCallId: "recall-stable", isError: false, details: { found: true, sourceToolName: "symbol_search", sourceIsError: false } }),
    call("read-2", "read", { path: "a.ts", offset: 1, limit: 200 }), textResult("read", readText, { toolCallId: "read-2", isError: false }),
  ];
  const source = structuredClone(messages);
  const epoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  const result = stableSieveMessages(messages, epoch, { cwd: resolve("stable-policy") });

  assert.deepEqual(result.messages[2], source[2], "unique read passes through byte-for-byte");
  assert.deepEqual(result.messages[4], source[4]);
  assert.deepEqual(result.messages[6], source[6]);
  assert.doesNotThrow(() => JSON.parse((result.messages[8] as any).content[0].text));
  assert.doesNotThrow(() => JSON.parse((result.messages[10] as any).content[0].text));
  assert.deepEqual((result.messages[12] as any).content[1], image);
  assert.deepEqual(result.messages[14], source[14], "explicit recall stays complete for the epoch");
  assert.match((result.messages[16] as any).content[0].text, /duplicate read/);
  assert.deepEqual(messages, source, "raw messages remain untouched");
});

test("stable epochs diagnose source changes and taint later duplicate IDs without rewriting the original", () => {
  const source = textResult("bash", "x".repeat(2_000), { toolCallId: "collision", isError: false });
  const messages: any[] = [user("start"), source];
  const epoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  const first = stableSieveMessages(messages, epoch);
  const frozen = JSON.stringify(first.messages[1]);

  const collided = [...messages, textResult("bash", "different", { toolCallId: "collision", isError: false })];
  const collision = stableSieveMessages(collided, epoch);
  assert.equal(collision.diagnostics.requiresReflow, true);
  assert.equal(collision.diagnostics.ambiguousReflows, 1);
  assert.equal(epoch.entries.get("collision")?.projectedMessage && JSON.stringify(epoch.entries.get("collision")!.projectedMessage), frozen);
  const collisionReflow = stableSieveMessages(collided, createProjectionEpoch("ambiguous-id", { threshold: 1_000, activePruning: true }, "prompt"));
  assert.deepEqual(collisionReflow.messages, collided, "ambiguous IDs pass through after the deliberate epoch reset");
  assert.equal(collisionReflow.recoverableActiveResults.length, 0);
  assert.equal(collisionReflow.diagnostics.ambiguousIds, 2);

  const malformedEpoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  const malformed: any[] = [user("start"), textResult("bash", "before", { toolCallId: "" })];
  stableSieveMessages(malformed, malformedEpoch);
  const malformedChanged = stableSieveMessages([malformed[0], { ...malformed[1], content: [{ type: "text", text: "after" }] }], malformedEpoch);
  assert.equal(malformedChanged.diagnostics.historyMismatches, 1, "ID-less historical changes force a reflow");

  const duplicateEpoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  const duplicates = [user("start"), textResult("bash", "one", { toolCallId: "same" }), textResult("bash", "two", { toolCallId: "same" })];
  stableSieveMessages(duplicates, duplicateEpoch);
  const swapped = stableSieveMessages([duplicates[0], duplicates[2], duplicates[1]], duplicateEpoch);
  assert.equal(swapped.diagnostics.historyMismatches, 1, "swapped ambiguous occurrences force a reflow");

  const reordered = [user("inserted history"), ...messages];
  const historyMismatch = stableSieveMessages(reordered, epoch);
  assert.equal(historyMismatch.diagnostics.requiresReflow, true);
  assert.equal(historyMismatch.diagnostics.historyMismatches, 1);
  assert.equal(epoch.entries.size, 1, "history mismatch does not mutate the ledger");

  const sourceEpoch = createProjectionEpoch("session-start", { threshold: 1_000, activePruning: true }, "prompt");
  stableSieveMessages(messages, sourceEpoch);
  const mutated = [messages[0], { ...source, content: [{ type: "text", text: "changed" }] }];
  const mismatch = stableSieveMessages(mutated, sourceEpoch);
  assert.equal(mismatch.diagnostics.requiresReflow, true);
  assert.equal(mismatch.diagnostics.sourceMismatches, 1);
  assert.equal(sourceEpoch.entries.get("collision")?.projectedMessage && JSON.stringify(sourceEpoch.entries.get("collision")!.projectedMessage), frozen);

  const rebuilt = stableSieveMessages(messages, createProjectionEpoch("reload", { threshold: 1_000, activePruning: true }, "prompt"));
  assert.deepEqual(rebuilt.messages, first.messages, "reload reconstruction is deterministic");
});

test("runtime modes, persisted settings, active recall, thresholds, and telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sieve-runtime-"));
  const settingsPath = join(directory, "config.json");
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let activeTools = ["bash", "read"];
  let toolSchemas: any[] = [
    { name: "bash", description: "Run command", parameters: { type: "object" } },
    { name: "read", description: "Read file", parameters: { type: "object" } },
    { name: "sieve_recall", description: "Recall", parameters: { type: "object" } },
  ];
  let runtimeInitialized = false;
  const eventHandlers = new Map<string, Function[]>();
  const publishedStates: any[] = [];
  const branch: any[] = [];
  const sessionManager = { getBranch: () => branch };
  extension({
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      activeTools.push(tool.name);
    },
    getActiveTools: () => {
      assert.equal(runtimeInitialized, true, "action API called during extension loading");
      return [...activeTools];
    },
    getAllTools: () => structuredClone(toolSchemas),
    setActiveTools: (names: string[]) => {
      assert.equal(runtimeInitialized, true, "action API called during extension loading");
      activeTools = [...names];
    },
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data: structuredClone(data) });
    },
    events: {
      on: (name: string, handler: Function) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => {};
      },
      emit: (name: string, value: unknown) => {
        if (name === "pi-sieve:state-change") publishedStates.push(value);
        for (const handler of eventHandlers.get(name) ?? []) handler(value);
      },
    },
  } as any, { configPath: settingsPath });
  assert.equal(activeTools.includes("sieve_recall"), true);
  runtimeInitialized = true;
  for (const handler of handlers.get("session_start") ?? []) await handler({}, { sessionManager });
  assert.equal(activeTools.includes("sieve_recall"), true);
  const hook = handlers.get("context")![0];
  const command = commands.get("sieve");
  const oversizedLength = SIEVE_THRESHOLD + 1;
  const context = { messages: [user("first"), textResult("ls", "x".repeat(oversizedLength)), user("second"), user("third")] };
  const expectedGrossTokens = 10;
  const expectedNetTokens = 1;
  let notification = "";
  const ctx: any = { sessionManager, ui: { notify: (text: string) => { notification = text; } } };

  await Promise.all([
    command.handler("active enable", ctx),
    command.handler("threshold 12000", ctx),
  ]);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: true,
    threshold: 12_000,
    projectionMode: "legacy",
    rolloverHighMultiplier: 8,
    rolloverLowMultiplier: 4,
  });
  await command.handler("active disable", ctx);
  await command.handler("threshold reset", ctx);
  await command.handler("active enable", ctx);

  await command.handler("observe", ctx);
  assert.equal(hook(context), undefined);
  assert.equal((context.messages[1].content[0] as { text: string }).text.length, oversizedLength);
  await command.handler("status", ctx);
  assert.match(notification, /pi-sieve: observe/);
  assert.match(notification, new RegExp(`Latest call \\(observe projections\\): scanned 1; projected transformations 1; transform types: age-threshold 1, budget 0, giant-error 0, active-threshold 0, stale-read 0.*projected gross omitted ~${expectedGrossTokens} tokens`));
  assert.match(notification, /actual transformations 0.*projected observe transformations 1/);

  await command.handler("enable", ctx);
  const outbound = hook(context);
  assert.notEqual(outbound.messages[1], context.messages[1]);
  await command.handler("status", ctx);
  assert.match(notification, /actual transformations 1.*projected observe transformations 1/);
  assert.match(notification, new RegExp(`actual net saved ~${expectedNetTokens} tokens; projected observe transformations 1; projected observe gross omitted ~${expectedGrossTokens} tokens; projected observe net saved ~${expectedNetTokens} tokens`));

  await command.handler("threshold 1000", ctx);
  await command.handler("status", ctx);
  assert.match(notification, /Threshold: > ~250 tokens \(1000 JS characters; estimated at 4 characters\/token\)/);
  await command.handler("threshold 50000", ctx);
  await command.handler("status", ctx);
  assert.match(notification, /Threshold: > ~12500 tokens \(50000 JS characters; estimated at 4 characters\/token\)/);
  await command.handler("threshold 999", ctx);
  assert.equal(notification, "Threshold must be an integer from 1000 to 50000.");
  await command.handler("threshold 50001", ctx);
  assert.equal(notification, "Threshold must be an integer from 1000 to 50000.");
  await command.handler("threshold reset", ctx);
  await command.handler("rollover 10 5", ctx);
  assert.equal((await loadConfig(settingsPath)).rolloverHighMultiplier, 10);
  assert.equal((await loadConfig(settingsPath)).rolloverLowMultiplier, 5);
  await command.handler("rollover reset", ctx);
  await command.handler("active disable", ctx);
  await command.handler("status", ctx);
  assert.match(notification, new RegExp(`Threshold: > ~${Math.ceil(SIEVE_THRESHOLD / 4)} tokens \\(${SIEVE_THRESHOLD} JS characters; estimated at 4 characters/token\\)`));
  assert.match(notification, /Active-result pruning: disabled/);

  await command.handler("active enable", ctx);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: true,
    threshold: SIEVE_THRESHOLD,
    projectionMode: "legacy",
    rolloverHighMultiplier: 8,
    rolloverLowMultiplier: 4,
  });
  assert.equal(activeTools.includes("sieve_recall"), true);
  await command.handler("observe", ctx);
  assert.equal(activeTools.includes("sieve_recall"), false);
  await command.handler("enable", ctx);
  assert.equal(activeTools.includes("sieve_recall"), true);
  await command.handler("projection stable", ctx);
  const activeSource = textResult("bash", "z".repeat(oversizedLength), { toolCallId: "active-runtime" });
  const activeOutbound = hook({ messages: [user("first"), activeSource] });
  const activeOutboundText = activeOutbound.messages[1].content[0].text;
  assert.equal(activeOutboundText.length, SIEVE_THRESHOLD);
  const firstEpoch = publishedStates.at(-1).epoch.id;
  hook({ messages: [user("first"), activeSource, user("partial same turn")] });
  assert.equal(publishedStates.at(-1).epoch.id, firstEpoch, "user messages do not start epochs");
  assert.ok(publishedStates.at(-1).stability.projectionCacheHits >= 1);
  assert.equal(publishedStates.at(-1).stability.prefixChurnViolations, 0);

  const rolloverMessages: any[] = [user("roll over")];
  for (let index = 0; index < 9; index++) {
    rolloverMessages.push(textResult("bash", String(index).repeat(SIEVE_THRESHOLD + 1_000), {
      toolCallId: `runtime-roll-${index}`, isError: false,
    }));
  }
  hook({ messages: rolloverMessages });
  assert.equal(publishedStates.at(-1).epoch.reason, "budget-rollover");
  assert.equal(publishedStates.at(-1).stability.automaticRollovers, 1);
  assert.equal(publishedStates.at(-1).latest.transformed, 9, "only final rollover stats are published");
  assert.equal(publishedStates.at(-1).rolloverHighMultiplier, 8);
  assert.equal(publishedStates.at(-1).rolloverLowMultiplier, 4);
  assert.ok(publishedStates.at(-1).epoch.rolloverEligibleRetainedChars <= 4 * SIEVE_THRESHOLD);
  const rolloverEpochId = publishedStates.at(-1).epoch.id;
  const rolloverRecall = await tools.get("sieve_recall").execute("rollover-recall", { toolCallId: "runtime-roll-0" });
  assert.equal(rolloverRecall.details.found, true);
  hook({ messages: rolloverMessages });
  assert.equal(publishedStates.at(-1).epoch.id, rolloverEpochId);
  assert.equal(publishedStates.at(-1).stability.automaticRollovers, 1, "unchanged context does not roll repeatedly");

  for (const [eventName, reason] of [["session_compact", "compaction"], ["session_tree", "branch-navigation"], ["model_select", "model-change"]] as const) {
    for (const handler of handlers.get(eventName) ?? []) await handler({}, { sessionManager });
    hook({ messages: [user("first"), activeSource] });
    assert.equal(publishedStates.at(-1).epoch.reason, reason);
    assert.notEqual(publishedStates.at(-1).epoch.id, firstEpoch);
  }

  const fingerprintMessages = { messages: [user("first"), activeSource] };
  const fingerprintCtx = (provider: string, prompt: string, cwd = resolve("fingerprint")) => ({
    cwd,
    model: { provider, id: "model" },
    getSystemPrompt: () => prompt,
  });
  hook(fingerprintMessages, fingerprintCtx("provider-a", "prompt-a"));
  const providerEpoch = publishedStates.at(-1).epoch.id;
  hook(fingerprintMessages, fingerprintCtx("provider-b", "prompt-a"));
  assert.equal(publishedStates.at(-1).epoch.reason, "prompt-fingerprint");
  assert.notEqual(publishedStates.at(-1).epoch.id, providerEpoch, "provider identity participates in the fingerprint");
  const promptEpoch = publishedStates.at(-1).epoch.id;
  hook(fingerprintMessages, fingerprintCtx("provider-b", "prompt-b", resolve("fingerprint", ".")));
  assert.notEqual(publishedStates.at(-1).epoch.id, promptEpoch, "effective prompt participates in the fingerprint");
  const schemaEpoch = publishedStates.at(-1).epoch.id;
  toolSchemas = toolSchemas.map((tool) => tool.name === "bash" ? { ...tool, description: "Changed schema description" } : tool);
  hook(fingerprintMessages, fingerprintCtx("provider-b", "prompt-b"));
  assert.notEqual(publishedStates.at(-1).epoch.id, schemaEpoch, "active tool schema participates in the fingerprint");

  await command.handler("reflow", ctx);
  hook({ messages: [user("first"), activeSource] });
  assert.equal(publishedStates.at(-1).epoch.reason, "explicit-reflow");
  assert.equal(publishedStates.at(-1).stability.explicitReflows, 1);
  const recallTool = tools.get("sieve_recall");
  const toolCtx = {
    sessionManager: { getBranch: () => [{ type: "message", message: activeSource }] },
  };
  const recalled = await recallTool.execute("recall-call", { toolCallId: "active-runtime" }, undefined, undefined, toolCtx);
  const omittedLength = Number(activeOutboundText.match(/omitted (\d+)\/\d+ chars/)![1]);
  assert.equal(recalled.content[0].text.length, oversizedLength);
  assert.ok(activeOutboundText.includes(activeOmissionMarker("bash", "active-runtime", oversizedLength, omittedLength)));
  assert.equal(recalled.details.sourceToolName, "bash");
  recalled.content[0].text = "mutated response";
  const recalledAgain = await recallTool.execute("recall-call-2", { toolCallId: "active-runtime" }, undefined, undefined, toolCtx);
  assert.equal(recalledAgain.content[0].text.length, oversizedLength);
  await command.handler("status", ctx);
  assert.match(notification, /Active-result pruning: enabled/);
  assert.match(notification, /Active recalls: 3; restored ~\d+ tokens/);
  for (const handler of handlers.get("input") ?? []) await handler({ source: "interactive" }, {});
  const afterInput = await recallTool.execute("recall-call-3", { toolCallId: "active-runtime" }, undefined, undefined, toolCtx);
  assert.equal(afterInput.details.found, true);
  const collisionSource = textResult("bash", "collision", { toolCallId: "active-runtime", isError: false });
  const collisionOutbound = hook({ messages: [user("first"), activeSource, collisionSource] });
  assert.deepEqual(collisionOutbound.messages.slice(1), [activeSource, collisionSource]);
  assert.equal(publishedStates.at(-1).epoch.reason, "ambiguous-id");
  const ambiguousRecall = await recallTool.execute("recall-ambiguous", { toolCallId: "active-runtime" }, undefined, undefined, toolCtx);
  assert.equal(ambiguousRecall.details.found, false);
  activeTools.push("later-tool");
  await command.handler("active disable", ctx);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: false,
    threshold: SIEVE_THRESHOLD,
    projectionMode: "stable",
    rolloverHighMultiplier: 8,
    rolloverLowMultiplier: 4,
  });
  assert.equal(activeTools.includes("sieve_recall"), false);
  assert.equal(activeTools.includes("later-tool"), true);
  assert.deepEqual(hook({ messages: [user("first"), activeSource] }).messages[1], activeSource);

  await command.handler("threshold 1000", ctx);
  await command.handler("disable", ctx);
  assert.equal(hook(context), undefined);
  await command.handler("reset-stats", ctx);
  await command.handler("status", ctx);
  assert.match(notification, /pi-sieve: disabled/);
  assert.match(notification, /Threshold: > ~250 tokens \(1000 JS characters; estimated at 4 characters\/token\)/);
  assert.match(notification, /actual transformations 0.*projected observe transformations 0/);
  assert.match(notification, /Latest call .*scanned 0; .* transformations 0/);
  await command.handler("what", ctx);
  assert.match(notification, /^Usage: \/sieve enable\|observe\|disable/);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: false,
    threshold: 1_000,
    projectionMode: "stable",
    rolloverHighMultiplier: 8,
    rolloverLowMultiplier: 4,
  });

  await command.handler("projection standard", ctx);
  assert.equal((await loadConfig(settingsPath)).projectionMode, "legacy");
  assert.match(notification, /projection mode set to standard/);
  await command.handler("projection legacy", ctx);
  assert.equal((await loadConfig(settingsPath)).projectionMode, "legacy", "legacy remains a compatibility alias");
  await command.handler("projection stable", ctx);
  assert.equal((await loadConfig(settingsPath)).projectionMode, "stable");
  assert.match(notification, /projection mode set to stable \(experimental\)/);
  await command.handler("active enable", ctx);
  const resumedHandlers = new Map<string, Function[]>();
  const resumedCommands = new Map<string, any>();
  let resumedActiveTools = ["bash"];
  extension({
    on: (name: string, handler: Function) => resumedHandlers.set(name, [...(resumedHandlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => resumedCommands.set(name, command),
    registerTool: (tool: any) => { resumedActiveTools.push(tool.name); },
    getActiveTools: () => [...resumedActiveTools],
    setActiveTools: (names: string[]) => { resumedActiveTools = [...names]; },
    appendEntry: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as any, { configPath: settingsPath });
  for (const handler of resumedHandlers.get("session_start") ?? []) await handler({}, { sessionManager });
  assert.equal(resumedActiveTools.includes("sieve_recall"), true);
  let resumedStatus = "";
  await resumedCommands.get("sieve").handler("status", {
    ui: { notify: (text: string) => { resumedStatus = text; } },
  });
  assert.match(resumedStatus, /Threshold: > ~250 tokens \(1000 JS characters/);
  assert.match(resumedStatus, /Active-result pruning: enabled/);
});

test("persists branch-aware telemetry while rebuilding recall caches from raw context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sieve-telemetry-"));
  const settingsPath = join(directory, "config.json");
  const createRuntime = (initialBranch: any[] = []) => {
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    let activeTools = ["bash", "read"];
    let branch = structuredClone(initialBranch);
    let notification = "";
    const sessionManager = { getBranch: () => branch };
    const ctx = {
      cwd: resolve("telemetry-runtime"),
      sessionManager,
      ui: { notify: (text: string) => { notification = text; } },
    };
    extension({
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerTool: (tool: any) => { tools.set(tool.name, tool); activeTools.push(tool.name); },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [
        { name: "bash", description: "Run command", parameters: { type: "object" } },
        { name: "read", description: "Read file", parameters: { type: "object" } },
        { name: "sieve_recall", description: "Recall", parameters: { type: "object" } },
      ],
      setActiveTools: (names: string[]) => { activeTools = [...names]; },
      appendEntry: (customType: string, data: unknown) => {
        branch.push({ type: "custom", customType, data: structuredClone(data) });
      },
      events: { on: () => () => {}, emit: () => {} },
    } as any, { configPath: settingsPath });
    return {
      handlers,
      command: commands.get("sieve"),
      recall: tools.get("sieve_recall"),
      hook: handlers.get("context")![0],
      ctx,
      branch: () => branch,
      setBranch: (entries: any[]) => { branch = structuredClone(entries); },
      status: async () => {
        await commands.get("sieve").handler("status", ctx);
        return notification;
      },
    };
  };
  const start = async (runtime: ReturnType<typeof createRuntime>, reason = "startup") => {
    for (const handler of runtime.handlers.get("session_start") ?? []) await handler({ reason }, runtime.ctx);
  };

  const source = textResult("bash", "z".repeat(SIEVE_THRESHOLD + 1), {
    toolCallId: "persisted-recall", isError: false,
  });
  const messages = [user("first"), source];
  const first = createRuntime();
  await start(first);
  first.hook({ messages }, first.ctx);
  assert.equal((await first.recall.execute("recall-1", { toolCallId: "persisted-recall" })).details.found, true);
  await first.command.handler("reflow", first.ctx);

  const savedBranch = structuredClone(first.branch());
  const saved = savedBranch.at(-1);
  assert.equal(saved.customType, "pi-sieve-telemetry");
  assert.equal(saved.data.cumulativeActual.transformed, 1);
  assert.equal(saved.data.recalls, 1);
  assert.equal(saved.data.stability.explicitReflows, 1);
  assert.doesNotMatch(JSON.stringify(saved.data), /z{100}/, "telemetry must not duplicate raw recall payloads");

  const resumed = createRuntime([
    ...savedBranch,
    { type: "custom", customType: "pi-sieve-telemetry", data: { version: 1, kind: "pi-sieve-telemetry" } },
  ]);
  await start(resumed, "reload");
  assert.match(await resumed.status(), /actual transformations 1/);
  assert.match(await resumed.status(), /Active recalls: 1;/);
  assert.match(await resumed.status(), /explicit reflows 1/);
  assert.equal((await resumed.recall.execute("recall-before-context", { toolCallId: "persisted-recall" })).details.found, false);

  resumed.hook({ messages }, resumed.ctx);
  assert.equal((await resumed.recall.execute("recall-2", { toolCallId: "persisted-recall" })).details.found, true);
  assert.match(await resumed.status(), /actual transformations 2/);
  assert.match(await resumed.status(), /Active recalls: 2;/);

  resumed.setBranch([]);
  for (const handler of resumed.handlers.get("session_tree") ?? []) await handler({}, resumed.ctx);
  assert.match(await resumed.status(), /actual transformations 0/);
  assert.match(await resumed.status(), /Active recalls: 0;/);
  assert.equal((await resumed.recall.execute("recall-after-tree", { toolCallId: "persisted-recall" })).details.found, false);

  resumed.setBranch(savedBranch);
  for (const handler of resumed.handlers.get("session_tree") ?? []) await handler({}, resumed.ctx);
  assert.match(await resumed.status(), /actual transformations 1/);
  assert.match(await resumed.status(), /Active recalls: 1;/);

  await resumed.command.handler("reset-stats", resumed.ctx);
  const resetRuntime = createRuntime(resumed.branch());
  await start(resetRuntime, "reload");
  assert.match(await resetRuntime.status(), /actual transformations 0/);
  assert.match(await resetRuntime.status(), /Active recalls: 0;/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  sieveMessages,
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
  atOrBelowThreshold: 0,
  recoveryUnavailable: 0,
};
const noTransformTypes = { ageThreshold: 0, budget: 0, giantError: 0, activeThreshold: 0 };

function oldResultAtAge(age: number, text: string, extra: Record<string, unknown> = {}) {
  return sieveMessages([user("before"), textResult("bash", text, extra), ...Array.from({ length: age }, (_, index) => user(`after-${index}`))], 4_000);
}

function assertPartialOutput(output: string, source: string, toolName: string, recalled = false) {
  const match = output.match(/; (\d+) chars omitted\]/);
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
    transformedBy: { ageThreshold: 1, budget: 0, giantError: 0, activeThreshold: 0 },
    omittedChars,
    netCharsSaved: source.length - output.length,
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

test("truncates only giant eligible text errors and preserves their concatenated source tail", () => {
  const giantBoundary = 32_000;
  const equal = oldResultAtAge(2, "x".repeat(giantBoundary), { isError: true });
  assert.equal(equal.stats.transformed, 0);
  assert.equal((equal.messages[1].content as any)[0].text.length, giantBoundary);

  const customBoundary = (length: number) => sieveMessages([
    user("before"), textResult("bash", "x".repeat(length), { isError: true }), user("second"), user("third"),
  ], 10_000);
  assert.equal(customBoundary(40_000).stats.transformed, 0);
  assert.equal(customBoundary(40_001).stats.transformedBy.giantError, 1);

  const tail = "t".repeat(GIANT_ERROR_TAIL_CHARS);
  const sourceBoundary = Math.max(32_000, 4 * SIEVE_THRESHOLD);
  const prefixLength = sourceBoundary + 1 - tail.length;
  const source = "x".repeat(prefixLength) + tail;
  const result = sieveMessages([
    user("before"),
    { ...textResult("bash", "unused", { isError: true }), content: [{ type: "text", text: source.slice(0, prefixLength) }, { type: "text", text: tail }] },
    user("second"),
    user("third"),
  ]);
  const output = (result.messages[1].content as any);
  const marker = giantErrorMarker("bash", source.length);

  assert.deepEqual(output, [{ type: "text", text: marker + tail }]);
  assert.equal(result.stats.transformedBy.giantError, 1);
  assert.equal(result.stats.omittedChars, source.length - GIANT_ERROR_TAIL_CHARS);
  assert.equal(result.stats.netCharsSaved, source.length - GIANT_ERROR_TAIL_CHARS - marker.length);
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
    skipped: {
      recentWindow: 0,
      ineligibleTool: 2,
      error: 1,
      nonTextMixedOrEmptyContent: 3,
      atOrBelowThreshold: 3,
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
  assertPartialOutput(agedOutput, agedRecallText, "rg", true);
  assert.equal(aged.stats.transformedBy.ageThreshold, 1);
  assert.equal(aged.stats.transformedBy.activeThreshold, 0);

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
  assert.equal(
    (oldError.messages[1].content as any)[0].text,
    recalledGiantErrorMarker("bash", 32_001) + "x".repeat(GIANT_ERROR_TAIL_CHARS),
  );
  assert.equal(oldError.stats.transformedBy.giantError, 1);

  const boundaryError = recalledResult("bash", "x".repeat(32_000), { sourceIsError: true });
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

test("partially prunes recoverable active results and stores only omitted text", () => {
  assert.equal(
    activeOmissionMarker("rg", "call-1", 30_356, 22_347),
    '[pi-sieve: OUTPUT TRUNCATED for rg; 22347 of 30356 chars omitted. Recover via sieve_recall(toolCallId="call-1").]',
  );

  const successText = "h".repeat(2_001) + "t".repeat(2_000);
  const success = {
    ...textResult("bash", "unused", { toolCallId: "active-success" }),
    content: [{ type: "text", text: successText.slice(0, 2_001) }, { type: "text", text: successText.slice(2_001) }],
  };
  const errorText = "e".repeat(4_001);
  const error = textResult("rg", errorText, { toolCallId: "active-error", isError: true });
  const read = textResult("read", "r".repeat(10_000), { toolCallId: "active-read" });
  const result = sieveMessages([user("first"), success, error, read], 4_000, { pruneActive: true });

  const successRecovery = result.recoverableActiveResults.find(({ toolCallId }) => toolCallId === "active-success")!;
  const successOmitted = successRecovery.content[0].text;
  const successMarker = activeOmissionMarker("bash", "active-success", successText.length, successOmitted.length);
  const successOutbound = (result.messages[1].content as any)[0].text as string;
  const [successHead, successTail] = successOutbound.split(`\n${successMarker}\n`);
  assert.equal(successOutbound.length, 4_000);
  assert.equal(successHead + successOmitted + successTail, successText);

  const errorRecovery = result.recoverableActiveResults.find(({ toolCallId }) => toolCallId === "active-error")!;
  const errorOmitted = errorRecovery.content[0].text;
  const errorMarker = activeOmissionMarker("rg", "active-error", errorText.length, errorOmitted.length);
  const errorOutbound = (result.messages[2].content as any)[0].text as string;
  assert.equal(errorOutbound.length, 4_000);
  assert.equal(errorOutbound, errorMarker + "\n" + errorText.slice(errorOmitted.length));
  assert.equal(errorOmitted + errorText.slice(errorOmitted.length), errorText);

  assert.equal(result.messages[3], read);
  assert.equal((success.content as any)[0].text + (success.content as any)[1].text, successText);
  assert.equal(result.stats.transformedBy.activeThreshold, 2);
  assert.equal(result.stats.omittedChars, successOmitted.length + errorOmitted.length);
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
    const omitted = result.recoverableActiveResults[0].content[0].text;
    const marker = activeOmissionMarker("bash", "boundary", source.length, omitted.length);
    const [head, tail] = outbound.split(`\n${marker}\n`);

    assert.equal(outbound.length, threshold);
    assert.equal(source.length - omitted.length, expectedRetainedChars);
    assert.equal(head.length, Math.floor(expectedRetainedChars / 2));
    assert.equal(tail.length, expectedRetainedChars - head.length);
    assert.equal(head + omitted + tail, source);
  }
});

test("runtime modes, persisted settings, active recall, thresholds, and telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sieve-runtime-"));
  const settingsPath = join(directory, "config.json");
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let activeTools = ["bash", "read"];
  let runtimeInitialized = false;
  const eventHandlers = new Map<string, Function[]>();
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
    setActiveTools: (names: string[]) => {
      assert.equal(runtimeInitialized, true, "action API called during extension loading");
      activeTools = [...names];
    },
    events: {
      on: (name: string, handler: Function) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => {};
      },
      emit: (name: string, value: unknown) => {
        for (const handler of eventHandlers.get(name) ?? []) handler(value);
      },
    },
  } as any, { configPath: settingsPath });
  assert.equal(activeTools.includes("sieve_recall"), true);
  runtimeInitialized = true;
  for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
  assert.equal(activeTools.includes("sieve_recall"), true);
  const hook = handlers.get("context")![0];
  const command = commands.get("sieve");
  const oversizedLength = SIEVE_THRESHOLD + 1;
  const context = { messages: [user("first"), textResult("ls", "x".repeat(oversizedLength)), user("second"), user("third")] };
  const expectedOldStats = sieveMessages(context.messages).stats;
  const expectedGrossTokens = Math.ceil(expectedOldStats.omittedChars / 4);
  const expectedNetTokens = Math.ceil(expectedOldStats.netCharsSaved / 4);
  let notification = "";
  const ctx: any = { ui: { notify: (text: string) => { notification = text; } } };

  await Promise.all([
    command.handler("active enable", ctx),
    command.handler("threshold 12000", ctx),
  ]);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: true,
    threshold: 12_000,
  });
  await command.handler("active disable", ctx);
  await command.handler("threshold reset", ctx);

  await command.handler("observe", ctx);
  assert.equal(hook(context), undefined);
  assert.equal((context.messages[1].content[0] as { text: string }).text.length, oversizedLength);
  await command.handler("status", ctx);
  assert.match(notification, /pi-sieve: observe/);
  assert.match(notification, new RegExp(`Latest call \\(observe projections\\): scanned 1; projected transformations 1; transform types: age-threshold 1, budget 0, giant-error 0, active-threshold 0; projected gross omitted ~${expectedGrossTokens} tokens`));
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
  await command.handler("status", ctx);
  assert.match(notification, new RegExp(`Threshold: > ~${Math.ceil(SIEVE_THRESHOLD / 4)} tokens \\(${SIEVE_THRESHOLD} JS characters; estimated at 4 characters/token\\)`));
  assert.match(notification, /Active-result pruning: disabled/);

  await command.handler("active enable", ctx);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: true,
    threshold: SIEVE_THRESHOLD,
  });
  assert.equal(activeTools.includes("sieve_recall"), true);
  await command.handler("observe", ctx);
  assert.equal(activeTools.includes("sieve_recall"), false);
  await command.handler("enable", ctx);
  assert.equal(activeTools.includes("sieve_recall"), true);
  const activeSource = textResult("bash", "z".repeat(oversizedLength), { toolCallId: "active-runtime" });
  const activeOutbound = hook({ messages: [user("first"), activeSource] });
  const activeOutboundText = activeOutbound.messages[1].content[0].text;
  assert.equal(activeOutboundText.length, SIEVE_THRESHOLD);
  hook({ messages: [user("partial same turn")] });
  const recallTool = tools.get("sieve_recall");
  const recalled = await recallTool.execute("recall-call", { toolCallId: "active-runtime" });
  const omittedLength = recalled.content[0].text.length;
  assert.ok(omittedLength > 0 && omittedLength < oversizedLength);
  assert.ok(activeOutboundText.includes(activeOmissionMarker("bash", "active-runtime", oversizedLength, omittedLength)));
  assert.equal(recalled.details.sourceToolName, "bash");
  recalled.content[0].text = "mutated response";
  const recalledAgain = await recallTool.execute("recall-call-2", { toolCallId: "active-runtime" });
  assert.equal(recalledAgain.content[0].text.length, omittedLength);
  await command.handler("status", ctx);
  assert.match(notification, /Active-result pruning: enabled/);
  assert.match(notification, new RegExp(`Active recalls: 2; restored ~${Math.ceil(2 * omittedLength / 4)} tokens`));
  for (const handler of handlers.get("input") ?? []) await handler({ source: "interactive" }, {});
  const missed = await recallTool.execute("recall-call-3", { toolCallId: "active-runtime" });
  assert.equal(missed.details.found, false);
  activeTools.push("later-tool");
  await command.handler("active disable", ctx);
  assert.deepEqual(await loadConfig(settingsPath), {
    version: 1,
    activePruning: false,
    threshold: SIEVE_THRESHOLD,
  });
  assert.equal(activeTools.includes("sieve_recall"), false);
  assert.equal(activeTools.includes("later-tool"), true);
  assert.equal(hook({ messages: [user("first"), activeSource] }).messages[1], activeSource);

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
  });

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
    events: { on: () => () => {}, emit: () => {} },
  } as any, { configPath: settingsPath });
  for (const handler of resumedHandlers.get("session_start") ?? []) await handler({}, {});
  assert.equal(resumedActiveTools.includes("sieve_recall"), true);
  let resumedStatus = "";
  await resumedCommands.get("sieve").handler("status", {
    ui: { notify: (text: string) => { resumedStatus = text; } },
  });
  assert.match(resumedStatus, /Threshold: > ~250 tokens \(1000 JS characters/);
  assert.match(resumedStatus, /Active-result pruning: enabled/);
});

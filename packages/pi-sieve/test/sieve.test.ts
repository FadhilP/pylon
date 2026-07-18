import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/pi-sieve.ts";
import {
  GIANT_ERROR_TAIL_CHARS,
  SIEVE_THRESHOLD,
  giantErrorMarker,
  omissionMarker,
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
const noSkips = {
  recentWindow: 0,
  ineligibleTool: 0,
  error: 0,
  nonTextMixedOrEmptyContent: 0,
  atOrBelowThreshold: 0,
};
const noTransformTypes = { ageThreshold: 0, budget: 0, giantError: 0 };

function oldResultAtAge(age: number, text: string, extra: Record<string, unknown> = {}) {
  return sieveMessages([user("before"), textResult("bash", text, extra), ...Array.from({ length: age }, (_, index) => user(`after-${index}`))], 4_000);
}

test("uses a compact normal marker and keeps all text blocks as one source", () => {
  const content = [{ type: "text", text: "x".repeat(4_000) }, { type: "text", text: "y".repeat(4_001) }];
  const result = sieveMessages([
    user("first"),
    { ...textResult("bash", "unused"), content },
    user("second"),
    user("third"),
  ]);
  const marker = omissionMarker("bash", SIEVE_THRESHOLD + 1);

  assert.equal(marker, "[pi-sieve: bash 8001 chars omitted]");
  assert.equal((result.messages[1].content as any)[0].text, marker);
  assert.deepEqual(result.stats, {
    scanned: 1,
    transformed: 1,
    transformedBy: { ageThreshold: 1, budget: 0, giantError: 0 },
    omittedChars: 8_001,
    netCharsSaved: 8_001 - marker.length,
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
  assert.equal((overflow.messages[1].content as any)[0].text, omissionMarker("bash", 1_000));
  assert.equal((overflow.messages[4].content as any)[0].text.length, 1);

  const continueAfterOverflow = sieveMessages(budgetContext([800, 800, 800, 800, 800]), 1_000);
  assert.equal(continueAfterOverflow.stats.transformedBy.budget, 2);
  assert.equal((continueAfterOverflow.messages[1].content as any)[0].text, omissionMarker("bash", 800));
  assert.equal((continueAfterOverflow.messages[2].content as any)[0].text, omissionMarker("bash", 800));
  assert.equal((continueAfterOverflow.messages[3].content as any)[0].text.length, 800);
});

test("truncates only giant eligible text errors and preserves their concatenated source tail", () => {
  const equal = oldResultAtAge(2, "x".repeat(32_000), { isError: true });
  assert.equal(equal.stats.transformed, 0);
  assert.equal((equal.messages[1].content as any)[0].text.length, 32_000);

  const customBoundary = (length: number) => sieveMessages([
    user("before"), textResult("bash", "x".repeat(length), { isError: true }), user("second"), user("third"),
  ], 10_000);
  assert.equal(customBoundary(40_000).stats.transformed, 0);
  assert.equal(customBoundary(40_001).stats.transformedBy.giantError, 1);

  const tail = "t".repeat(GIANT_ERROR_TAIL_CHARS);
  const source = "x".repeat(30_001) + tail;
  const result = sieveMessages([
    user("before"),
    { ...textResult("bash", "unused", { isError: true }), content: [{ type: "text", text: source.slice(0, 30_001) }, { type: "text", text: tail }] },
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
  const original = Object.freeze(textResult("fd", "x".repeat(8_001), {
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
  assert.equal((original.content as any)[0].text.length, 8_001);
  assert.equal(result.messages[3], ageOneError);
  assert.equal(result.messages[4], ageOneSuccess);
  assert.equal(result.messages[6], ageZeroSuccess);
  assert.equal(result.stats.skipped.recentWindow, 1);
});

test("runtime modes, thresholds, cumulative telemetry, and reset-stats", async () => {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  extension({
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any);
  const hook = handlers.get("context")![0];
  const command = commands.get("sieve");
  const context = { messages: [user("first"), textResult("ls", "x".repeat(8_001)), user("second"), user("third")] };
  let notification = "";
  const ctx: any = { ui: { notify: (text: string) => { notification = text; } } };

  await command.handler("observe", ctx);
  assert.equal(hook(context), undefined);
  assert.equal((context.messages[1].content[0] as { text: string }).text.length, 8_001);
  await command.handler("status", ctx);
  assert.match(notification, /pi-sieve: observe/);
  assert.match(notification, /Latest call \(observe projections\): scanned 1; projected transformations 1; transform types: age-threshold 1, budget 0, giant-error 0; projected gross omitted ~2001 tokens/);
  assert.match(notification, /actual transformations 0.*projected observe transformations 1/);

  await command.handler("enable", ctx);
  const outbound = hook(context);
  assert.notEqual(outbound.messages[1], context.messages[1]);
  await command.handler("status", ctx);
  const net = 8_001 - omissionMarker("ls", 8_001).length;
  const estimatedNetTokens = Math.ceil(net / 4);
  assert.match(notification, /actual transformations 1.*projected observe transformations 1/);
  assert.match(notification, new RegExp(`actual net saved ~${estimatedNetTokens} tokens; projected observe transformations 1; projected observe gross omitted ~2001 tokens; projected observe net saved ~${estimatedNetTokens} tokens`));

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
  assert.match(notification, /Threshold: > ~2000 tokens \(8000 JS characters; estimated at 4 characters\/token\)/);

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
});

import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/pi-sieve.ts";
import { SIEVE_THRESHOLD, omissionMarker, sieveMessages } from "../src/sieve.ts";

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

test("sieves multiple text blocks above the boundary and reports deterministic net savings", () => {
  const content = [{ type: "text", text: "x".repeat(4_000) }, { type: "text", text: "y".repeat(4_001) }];
  const result = sieveMessages([
    user("first"),
    { ...textResult("bash", "unused"), content },
    user("second"),
    user("third"),
  ]);
  const marker = omissionMarker("bash", SIEVE_THRESHOLD + 1);

  assert.equal((result.messages[1].content as any)[0].text, marker);
  assert.deepEqual(result.stats, {
    scanned: 1,
    transformed: 1,
    omittedChars: 8_001,
    netCharsSaved: 8_001 - marker.length,
    skipped: noSkips,
  });

  const custom = sieveMessages([user("first"), textResult("bash", "x".repeat(1_001)), user("second"), user("third")], 1_000);
  assert.equal(custom.stats.transformed, 1);
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
    scanned: 8,
    transformed: 0,
    omittedChars: 0,
    netCharsSaved: 0,
    skipped: {
      recentWindow: 1,
      ineligibleTool: 2,
      error: 1,
      nonTextMixedOrEmptyContent: 3,
      atOrBelowThreshold: 2,
    },
  });

  const noWindow = sieveMessages([user("only"), textResult("bash", "x".repeat(8_001))]);
  assert.deepEqual(noWindow.stats, {
    scanned: 0,
    transformed: 0,
    omittedChars: 0,
    netCharsSaved: 0,
    skipped: { ...noSkips, recentWindow: 1 },
  });
});

test("keeps tool-result fields and stored session messages immutable", () => {
  const original = Object.freeze(textResult("fd", "x".repeat(8_001), {
    toolCallId: "preserved-call", isError: false, timestamp: 123, details: { source: "tool" }, custom: true,
  }));
  const originalContent = original.content;
  const result = sieveMessages([user("first"), original, user("second"), user("third")]);
  const transformed: any = result.messages[1];

  assert.notEqual(transformed, original);
  assert.equal(transformed.toolCallId, "preserved-call");
  assert.equal(transformed.toolName, "fd");
  assert.equal(transformed.timestamp, 123);
  assert.deepEqual(transformed.details, { source: "tool" });
  assert.equal(original.content, originalContent);
  assert.equal((original.content as any)[0].text.length, 8_001);
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
  assert.match(notification, /Latest call \(observe projections\): scanned 1; projected transformations 1; projected gross omitted ~2001 tokens/);
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

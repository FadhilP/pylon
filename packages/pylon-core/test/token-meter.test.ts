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
    turns: 1, input: 120, output: 30, cacheRead: 400, cacheWrite: 20,
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

test("reports an empty current branch clearly", () => {
  const report = formatTokenMeter(meterFromBranch([]));
  assert.match(report, /No completed tool calls in current session branch/);
  assert.match(report, /0 turns; input 0; output 0/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { activeTurnAtMarker, groupConversationMessages, includeLatestLoadedTurn, liveToolMessage, replaceConversationMessage, replaceToolActivity, turnIdsInViewport } from "../src/shared/transcript.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { MessageReadModel } from "../src/shared/protocol/events.ts";

const message = (id: string, role: MessageReadModel["role"]): MessageReadModel => ({
  id,
  role,
  text: id,
  streaming: false,
});

test("all turns group tools, including the active turn", () => {
  const messages = [
    message("user-1", "user"),
    { ...message("tool-1", "tool"), tool: { id: "call-1", name: "read", status: "completed" as const } },
    message("assistant-1", "assistant"),
    message("tool-2", "tool"),
    message("user-2", "user"),
    message("tool-3", "tool"),
  ];

  const blocks = groupConversationMessages(messages);
  assert.equal(blocks[1]!.id, "tools-call-1");
  assert.deepEqual(blocks.map((block) => "tools" in block ? block.tools.map((tool) => tool.id) : block.id), [
    "user-1",
    ["tool-1", "tool-2"],
    "assistant-1",
    "user-2",
    ["tool-3"],
  ]);
});

test("live tools keep event position and reconcile without flicker", () => {
  const before = [message("user", "user"), message("assistant-before", "assistant")];
  const live = liveToolMessage({ id: "call", name: "read", status: "running" });
  const withTool = replaceConversationMessage(before, live);
  const duplicateStart = replaceConversationMessage(withTool, live);
  const after = [...duplicateStart, message("assistant-after", "assistant")];
  const completed = replaceConversationMessage(after, liveToolMessage({ id: "call", name: "read", status: "completed", summary: "Done" }));
  const result = replaceConversationMessage(completed, {
    ...message("tool-result", "tool"),
    tool: { id: "call", name: "read", status: "completed" },
  });

  assert.deepEqual(after.map((item) => item.id), ["user", "assistant-before", "live-tool-call", "assistant-after"]);
  assert.equal(completed[2]?.text, "Done");
  assert.deepEqual(result.map((item) => item.id), ["user", "assistant-before", "tool-result", "assistant-after"]);
  assert.equal(replaceConversationMessage(result, live), result);

  const endedFirst = replaceConversationMessage(before, liveToolMessage({ id: "late", name: "bash", status: "completed" }));
  assert.equal(endedFirst.at(-1)?.tool?.status, "completed");
  const tools = replaceToolActivity(
    [{ id: "call", name: "read", status: "completed" }, { id: "other", name: "bash", status: "running" }],
    { id: "call", name: "read", status: "running" },
  );
  assert.deepEqual(tools.map((tool) => [tool.id, tool.status]), [["call", "completed"], ["other", "running"]]);
});

test("the latest loaded prompt appears immediately in a stale latest rail page", () => {
  const page = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session",
    sessionGeneration: 1,
    turns: [{ promptId: "one", preview: "one", cursor: "one" }],
    totalCount: 3,
  };
  const merged = includeLatestLoadedTurn(page, { promptId: "two", preview: "two" }, true);
  assert.deepEqual(merged.turns.map((turn) => turn.promptId), ["two", "one"]);
  assert.equal(merged.totalCount, 3);
  assert.equal(includeLatestLoadedTurn(page, { promptId: "two", preview: "two" }, false), page);
  assert.equal(includeLatestLoadedTurn(page, { promptId: "one", preview: "one" }, true), page);
});

test("history rail keeps a turn active until the next prompt crosses the viewport marker", () => {
  const turns = [{ id: "one", top: -100 }, { id: "two", top: 240 }, { id: "three", top: 700 }];
  assert.equal(activeTurnAtMarker(turns, 200), "one");
  assert.equal(activeTurnAtMarker(turns, 300), "two");
  assert.equal(activeTurnAtMarker(turns, -200), "one");
});

test("history rail highlights every visible prompt and falls back to the current turn", () => {
  const turns = [
    { id: "one", top: -200, bottom: -100 },
    { id: "two", top: 20, bottom: 60 },
    { id: "three", top: 80, bottom: 120 },
    { id: "four", top: 140, bottom: 180 },
  ];
  assert.deepEqual(turnIdsInViewport(turns, { top: 0, bottom: 200 }), ["two", "three", "four"]);
  assert.deepEqual(turnIdsInViewport(turns, { top: 300, bottom: 500 }), ["four"]);
});

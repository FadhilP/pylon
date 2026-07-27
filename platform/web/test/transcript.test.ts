import test from "node:test";
import assert from "node:assert/strict";
import { activeTurnAtMarker, groupConversationMessages, latestTimedAssistant } from "../src/shared/transcript.ts";
import type { MessageReadModel } from "../src/shared/protocol/events.ts";

const message = (id: string, role: MessageReadModel["role"]): MessageReadModel => ({
  id,
  role,
  text: id,
  streaming: false,
});

test("completed turns group tools while the streaming turn keeps them visible", () => {
  const messages = [
    message("user-1", "user"),
    message("tool-1", "tool"),
    message("assistant-1", "assistant"),
    message("tool-2", "tool"),
    message("user-2", "user"),
    message("tool-3", "tool"),
  ];

  const blocks = groupConversationMessages(messages, true);
  assert.deepEqual(blocks.map((block) => "tools" in block ? block.tools.map((tool) => tool.id) : block.id), [
    "user-1",
    ["tool-1", "tool-2"],
    "assistant-1",
    "user-2",
    "tool-3",
  ]);
});

test("the latest completed turn timer follows any trailing tool activity", () => {
  const messages = [
    { ...message("user-1", "user") },
    { ...message("assistant-1", "assistant"), workDurationMs: 1_000 },
    message("tool-1", "tool"),
  ];

  assert.equal(latestTimedAssistant(messages)?.id, "assistant-1");
  assert.equal(latestTimedAssistant([...messages, message("user-2", "user")]), undefined);
});

test("history rail keeps a turn active until the next prompt crosses the viewport marker", () => {
  const turns = [{ id: "one", top: -100 }, { id: "two", top: 240 }, { id: "three", top: 700 }];
  assert.equal(activeTurnAtMarker(turns, 200), "one");
  assert.equal(activeTurnAtMarker(turns, 300), "two");
  assert.equal(activeTurnAtMarker(turns, -200), "one");
});

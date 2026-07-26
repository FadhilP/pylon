import test from "node:test";
import assert from "node:assert/strict";
import { groupConversationMessages } from "../src/shared/conversation.ts";
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

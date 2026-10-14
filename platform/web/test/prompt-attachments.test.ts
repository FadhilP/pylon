import test from "node:test";
import assert from "node:assert/strict";
import { PromptAttachmentBridge, PROMPT_FILES_CUSTOM_TYPE } from "../src/server/runtime/prompt-attachments.ts";

test("prompt attachments wait for user startup rather than custom continuations", () => {
  const bridge = new PromptAttachmentBridge();
  let beforeAgentStart: ((event: { messageType: "user" | "custom" }) => unknown) | undefined;
  (bridge.extension as any).factory({
    on(name: string, handler: typeof beforeAgentStart) {
      if (name === "before_agent_start") beforeAgentStart = handler;
    },
  } as any);

  bridge.stage("command-1", [{ name: "notes.txt", mimeType: "text/plain", text: "hello", size: 5 }]);
  assert.equal(beforeAgentStart?.({ messageType: "custom" }), undefined);
  assert.equal(bridge.consumed("command-1"), false);
  const first = beforeAgentStart?.({ messageType: "user" }) as any;
  assert.equal(first.message.customType, PROMPT_FILES_CUSTOM_TYPE);
  assert.equal(first.message.display, false);
  assert.equal(first.message.details.files.length, 1);
  const detail = first.message.details.files[0];
  assert.deepEqual(
    { name: detail.name, mimeType: detail.mimeType, size: detail.size },
    { name: "notes.txt", mimeType: "text/plain", size: 5 },
  );
  assert.equal(first.message.content.slice(detail.contentStart, detail.contentEnd), "hello");
  assert.equal(bridge.consumed("command-1"), true);
  bridge.clear("command-1");
  assert.equal(beforeAgentStart?.({ messageType: "user" }), undefined);
});

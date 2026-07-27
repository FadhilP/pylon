import test from "node:test";
import assert from "node:assert/strict";
import { PromptAttachmentBridge, PROMPT_FILES_CUSTOM_TYPE } from "../src/server/pi/prompt-attachments.ts";

test("prompt attachment bridge injects hidden file context exactly once", () => {
  const bridge = new PromptAttachmentBridge();
  let beforeAgentStart: (() => unknown) | undefined;
  (bridge.extension as any).factory({
    on(name: string, handler: () => unknown) {
      if (name === "before_agent_start") beforeAgentStart = handler;
    },
  } as any);

  bridge.stage("command-1", [{ name: "notes.txt", mimeType: "text/plain", text: "hello", size: 5 }]);
  const first = beforeAgentStart?.() as any;
  assert.equal(first.message.customType, PROMPT_FILES_CUSTOM_TYPE);
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /<file name="notes\.txt">\nhello\n<\/file>/);
  assert.deepEqual(first.message.details.files, [{ name: "notes.txt", mimeType: "text/plain", size: 5 }]);
  assert.equal(bridge.consumed("command-1"), true);
  bridge.clear("command-1");
  assert.equal(beforeAgentStart?.(), undefined);
});

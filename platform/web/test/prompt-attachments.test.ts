import test from "node:test";
import assert from "node:assert/strict";
import {
  PromptAttachmentBridge,
  PROMPT_FILES_CUSTOM_TYPE,
} from "../src/server/pi/prompt-attachments.ts";

test("prompt attachment bridge injects hidden file context exactly once", () => {
  const bridge = new PromptAttachmentBridge();
  let beforeAgentStart: (() => unknown) | undefined;
  (bridge.extension as any).factory({
    on(name: string, handler: () => unknown) {
      if (name === "before_agent_start") beforeAgentStart = handler;
    },
  } as any);

  bridge.stage("command-1", [
    { name: "notes.txt", mimeType: "text/plain", text: "hello", size: 5 },
  ]);
  const first = beforeAgentStart?.() as any;
  assert.equal(first.message.customType, PROMPT_FILES_CUSTOM_TYPE);
  assert.equal(first.message.display, false);
  assert.match(
    first.message.content,
    /<file name="notes\.txt">\nhello\n<\/file>/,
  );
  assert.equal(first.message.details.version, 2);
  assert.equal(first.message.details.files.length, 1);
  const detail = first.message.details.files[0];
  assert.deepEqual(
    { name: detail.name, mimeType: detail.mimeType, size: detail.size },
    { name: "notes.txt", mimeType: "text/plain", size: 5 },
  );
  assert.equal(
    first.message.content.slice(detail.contentStart, detail.contentEnd),
    "hello",
  );
  assert.equal(bridge.consumed("command-1"), true);
  bridge.clear("command-1");
  assert.equal(beforeAgentStart?.(), undefined);
});

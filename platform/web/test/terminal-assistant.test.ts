import test from "node:test";
import assert from "node:assert/strict";
import {
  finalAssistant,
  reconcileFinalAssistant,
} from "../src/shared/terminal-assistant.ts";

const assistant = {
  id: "history-2",
  entryId: "assistant-entry",
  role: "assistant" as const,
  text: "Done",
  streaming: false,
};

test("terminal assistant restores missing content and replaces a live message by entry ID", () => {
  const final = finalAssistant(assistant);
  assert.deepEqual(reconcileFinalAssistant([], final), [assistant]);
  assert.deepEqual(
    reconcileFinalAssistant(
      [
        {
          id: "live-assistant",
          entryId: assistant.entryId,
          role: "assistant",
          text: "Don",
          streaming: true,
        },
      ],
      final,
    ),
    [{ ...assistant, id: "live-assistant" }],
  );
});

test("terminal assistant reconciliation is idempotent and rejects malformed payloads", () => {
  assert.deepEqual(
    reconcileFinalAssistant([assistant], finalAssistant(assistant)),
    [assistant],
  );
  assert.equal(
    finalAssistant({ role: "assistant", id: "missing-text" }),
    undefined,
  );
});

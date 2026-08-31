import assert from "node:assert/strict";
import test from "node:test";
import { assignAgentColorHues } from "../src/shared/agent-colors.ts";

test("agent colors survive a rebuilt registry", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const first = assignAgentColorHues(new Map(), [{ id: "run-1", threadId: "agent-1" }]);
    Math.random = () => 0.5;
    const rebuilt = assignAgentColorHues(new Map(), [{ id: "run-2", threadId: "agent-1" }]);

    assert.deepEqual(rebuilt, first);
  } finally {
    Math.random = originalRandom;
  }
});

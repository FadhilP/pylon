import test from "node:test";
import assert from "node:assert/strict";
import type { MessageReadModel } from "../src/shared/protocol/events.ts";
import type { PairedAgentActivity } from "../src/client/sessions/agent-activity.ts";
import { messageToolCallViews, pairedToolCallViews } from "../src/client/conversation/tool-call-model.ts";

const toolMessage = (tool: MessageReadModel["tool"], text = ""): MessageReadModel => ({
  id: "message",
  role: "tool",
  text,
  streaming: false,
  ...(tool ? { tool } : {}),
});

test("messageToolCallViews elapses a running call against now", () => {
  const [view] = messageToolCallViews(
    [toolMessage({ id: "t1", name: "Bash", input: "npm test", status: "running", startedAt: "2026-01-01T00:00:00Z" })],
    Date.parse("2026-01-01T00:00:05Z"),
  );
  assert.deepEqual(view, {
    key: "t1",
    name: "Bash",
    input: "npm test",
    output: "",
    status: "running",
    durationMs: 5_000,
  });
});

test("pairedToolCallViews settles unfinished calls once the run stops", () => {
  const tools: PairedAgentActivity[] = [{ tool: "Grep", input: "assertBudget", startedAt: "2026-01-01T00:00:00Z" }];
  const [running] = pairedToolCallViews(tools, true, Date.parse("2026-01-01T00:00:03Z"));
  assert.equal(running?.status, "running");
  assert.equal(running?.durationMs, 3_000);
  const [settled] = pairedToolCallViews(tools, false);
  assert.equal(settled?.status, "completed");
  assert.equal(settled?.key, "Grep-0");
});

test("pairedToolCallViews reports a failed call over a completed one", () => {
  const [view] = pairedToolCallViews(
    [{ id: "c1", tool: "Bash", completed: true, failed: true, durationMs: 40 }],
    false,
  );
  assert.equal(view?.status, "failed");
  assert.equal(view?.key, "c1");
});

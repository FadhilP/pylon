import test from "node:test";
import assert from "node:assert/strict";
import type { MessageReadModel } from "../src/shared/protocol/events.ts";
import type { PairedAgentActivity } from "../src/shared/agent-activity.ts";
import {
  aggregateToolCallTiming,
  messageToolCallViews,
  pairedToolCallViews,
  toolCallGroupStatus,
  toolCallNames,
  toolCallTrackTicks,
  type ToolCallView,
} from "../src/shared/tool-calls.ts";

const call = (overrides: Partial<ToolCallView>): ToolCallView => ({
  key: "call",
  name: "Read",
  status: "completed",
  ...overrides,
});

const toolMessage = (tool: MessageReadModel["tool"], text = ""): MessageReadModel => ({
  id: "message",
  role: "tool",
  text,
  streaming: false,
  ...(tool ? { tool } : {}),
});

test("aggregateToolCallTiming prefers the longest running call", () => {
  const timing = aggregateToolCallTiming([
    call({ key: "a", status: "completed", durationMs: 9_000 }),
    call({ key: "b", status: "running", durationMs: 400 }),
    call({ key: "c", status: "running", durationMs: 1_200 }),
  ]);
  assert.deepEqual(timing, { durationMs: 1_200, status: "running" });
});

test("aggregateToolCallTiming falls back to the last settled call", () => {
  const timing = aggregateToolCallTiming([
    call({ key: "a", status: "completed", durationMs: 900 }),
    call({ key: "b", status: "failed", durationMs: 120 }),
  ]);
  assert.deepEqual(timing, { durationMs: 120, status: "failed" });
});

test("aggregateToolCallTiming has nothing to show without durations", () => {
  assert.equal(aggregateToolCallTiming([]), undefined);
  assert.equal(aggregateToolCallTiming([call({})]), undefined);
});

test("toolCallNames keeps the last distinct names in order", () => {
  const names = toolCallNames([
    call({ key: "a", name: "Glob" }),
    call({ key: "b", name: "Read" }),
    call({ key: "c", name: "Grep" }),
    call({ key: "d", name: "Read" }),
    call({ key: "e", name: "Bash" }),
  ]);
  assert.deepEqual(names, ["Grep", "Read", "Bash"]);
});

test("toolCallGroupStatus reports running first, then the outcome", () => {
  const failed = [call({ key: "a", status: "failed" })];
  assert.equal(toolCallGroupStatus(failed, true), "running");
  assert.equal(toolCallGroupStatus(failed), "failed");
  assert.equal(toolCallGroupStatus([call({ status: "attention" })]), "attention");
  assert.equal(toolCallGroupStatus([call({})]), "completed");
  assert.equal(toolCallGroupStatus([]), "completed");
});

test("toolCallGroupStatus leaves a recovered problem on its own row", () => {
  const recovered = [call({ key: "a", status: "failed" }), call({ key: "b", status: "completed" })];
  assert.equal(toolCallGroupStatus(recovered), "completed");
  const ended = [call({ key: "a", status: "completed" }), call({ key: "b", status: "failed" })];
  assert.equal(toolCallGroupStatus(ended), "failed");
  const partial = [call({ key: "a", status: "completed" }), call({ key: "b", status: "attention" })];
  assert.equal(toolCallGroupStatus(partial), "attention");
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

test("messageToolCallViews defaults a message without tool activity", () => {
  const [view] = messageToolCallViews([toolMessage(undefined, "output")]);
  assert.equal(view?.key, "message");
  assert.equal(view?.name, "Tool");
  assert.equal(view?.status, "completed");
  assert.equal(view?.durationMs, undefined);
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

test("toolCallTrackTicks keeps the newest window and scales failures visibly", () => {
  const calls = Array.from({ length: 35 }, (_, index) =>
    call({ key: String(index), durationMs: index === 34 ? 10_000 : 100 + index * 10 }),
  );
  calls[4] = call({ key: "4", status: "failed", durationMs: 10 });

  const ticks = toolCallTrackTicks(calls, 32);

  assert.equal(ticks.length, 32);
  assert.equal(ticks[0]?.key, "3");
  assert.equal(ticks.at(-1)?.key, "34");
  assert.equal(ticks.at(-1)?.height, 14);
  assert.ok((ticks.find(tick => tick.key === "4")?.height ?? 0) >= 9);
  assert.ok((ticks.find(tick => tick.key === "3")?.height ?? 0) < 14);
});

test("toolCallTrackTicks gives unknown and instant durations the visible floor", () => {
  const ticks = toolCallTrackTicks([call({ key: "unknown" }), call({ key: "instant", durationMs: 0 })]);
  assert.deepEqual(
    ticks.map(tick => tick.height),
    [3, 3],
  );
});

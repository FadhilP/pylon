import test from "node:test";
import assert from "node:assert/strict";
import { activeTurnAtMarker, aggregateToolTiming, groupConversationMessages, includeLatestLoadedTurn, latestUniqueToolNames, liveToolMessage, reconcileToolActivity, replaceConversationMessage, replaceDelegatedRun, replaceToolActivity, settleRunningActivities, terminalActivityStatus, toolElapsedDuration, turnIdsInViewport } from "../src/shared/transcript.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { DelegatedAgentRunReadModel, MessageReadModel } from "../src/shared/protocol/events.ts";

const message = (id: string, role: MessageReadModel["role"]): MessageReadModel => ({
  id,
  role,
  text: id,
  streaming: false,
});

test("adjacent tools group without crossing message boundaries", () => {
  const messages = [
    message("user-1", "user"),
    { ...message("tool-1", "tool"), tool: { id: "call-1", name: "read", status: "completed" as const } },
    message("tool-2", "tool"),
    message("assistant-1", "assistant"),
    message("tool-3", "tool"),
    message("user-2", "user"),
    message("tool-4", "tool"),
  ];

  const blocks = groupConversationMessages(messages);
  assert.equal(blocks[1]!.id, "tools-call-1");
  assert.deepEqual(blocks.map((block) => "tools" in block ? block.tools.map((tool) => tool.id) : block.id), [
    "user-1",
    ["tool-1", "tool-2"],
    "assistant-1",
    ["tool-3"],
    "user-2",
    ["tool-4"],
  ]);
});

test("tool summaries use recent unique names and the longest relevant duration", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const tools: MessageReadModel[] = [
    { ...message("one", "tool"), tool: { id: "one", name: "bash", status: "completed", durationMs: 8_000 } },
    { ...message("two", "tool"), tool: { id: "two", name: "rg", status: "completed", durationMs: 1_000 } },
    { ...message("three", "tool"), tool: { id: "three", name: "bash", status: "completed", durationMs: 3_000 } },
    { ...message("four", "tool"), tool: { id: "four", name: "fd", status: "running", startedAt } },
    { ...message("five", "tool"), tool: { id: "five", name: "fd", status: "running", startedAt: "2026-01-01T00:00:02.000Z" } },
  ];
  const now = Date.parse("2026-01-01T00:00:05.000Z");

  assert.deepEqual(latestUniqueToolNames(tools), ["rg", "bash", "fd"]);
  assert.equal(toolElapsedDuration(tools[3]!, now), 5_000);
  assert.deepEqual(aggregateToolTiming(tools, now), { durationMs: 5_000, status: "running" });
  const completed = tools.map((tool) => tool.tool?.status === "running"
    ? { ...tool, tool: { ...tool.tool, status: "completed" as const, durationMs: tool.tool.id === "four" ? 5_000 : 3_000 } }
    : tool);
  assert.deepEqual(aggregateToolTiming(completed, now), { durationMs: 3_000, status: "completed" });

  const sequential: MessageReadModel[] = [
    { ...message("slow", "tool"), tool: { id: "slow", name: "bash", status: "completed", durationMs: 3_000 } },
    { ...message("latest", "tool"), tool: { id: "latest", name: "rg", status: "completed", durationMs: 1_000 } },
  ];
  assert.deepEqual(aggregateToolTiming(sequential, now), { durationMs: 1_000, status: "completed" });
  sequential.push({ ...message("failed", "tool"), tool: { id: "failed", name: "bash", status: "failed", durationMs: 4_000 } });
  assert.deepEqual(aggregateToolTiming(sequential, now), { durationMs: 4_000, status: "failed" });
});

test("live tool activity settles stale history messages before aggregation", () => {
  const stale = {
    ...message("stale", "tool"),
    streaming: true,
    tool: { id: "call-1", name: "bash", status: "running" as const, startedAt: "2026-01-01T00:00:00.000Z" },
  };
  const reconciled = reconcileToolActivity(stale, {
    id: "call-1",
    name: "bash",
    status: "completed",
    summary: "Done",
    durationMs: 9_000,
  });

  assert.equal(reconciled.tool?.status, "completed");
  assert.equal(reconciled.tool?.durationMs, 9_000);
  assert.equal(reconciled.streaming, false);
  assert.equal(reconciled.text, "Done");
});

test("terminal activity status is neutral for stops and failed for errors and retry handoffs", () => {
  assert.equal(terminalActivityStatus("end", { stopped: true, willRetry: true }), "completed");
  assert.equal(terminalActivityStatus("error", { stopped: true }), "completed");
  assert.equal(terminalActivityStatus("end", { willRetry: true }), "failed");
  assert.equal(terminalActivityStatus("error", {}), "failed");
  assert.equal(terminalActivityStatus("end", {}), "completed");
});

test("terminal agent events settle only residual running activity", () => {
  const runningMessage = {
    ...message("running-tool", "tool"),
    streaming: true,
    tool: { id: "call-running", name: "bash", status: "running" as const },
  };
  const completedMessage = {
    ...message("completed-tool", "tool"),
    tool: { id: "call-completed", name: "read", status: "completed" as const },
  };
  const runningRun: DelegatedAgentRunReadModel = {
    id: "run-running",
    kind: "advisor",
    turn: 1,
    status: "running",
    activity: [],
  };
  const completedRun: DelegatedAgentRunReadModel = { ...runningRun, id: "run-completed", status: "completed" };
  const conversation = {
    messages: [runningMessage, completedMessage],
    tools: [
      { id: "call-running", name: "bash", status: "running" as const },
      { id: "call-failed", name: "write", status: "failed" as const },
    ],
    delegatedRuns: [runningRun, completedRun],
  };

  const stopped = settleRunningActivities(conversation, "completed");
  assert.equal(stopped.messages[0]?.tool?.status, "completed");
  assert.equal(stopped.messages[0]?.streaming, false);
  assert.equal(stopped.messages[1]?.tool?.status, "completed");
  assert.deepEqual(stopped.tools.map((tool) => tool.status), ["completed", "failed"]);
  assert.deepEqual(stopped.delegatedRuns.map((run) => run.status), ["completed", "completed"]);

  const errored = settleRunningActivities(conversation, "failed");
  assert.equal(errored.messages[0]?.tool?.status, "failed");
  assert.equal(errored.tools[0]?.status, "failed");
  assert.equal(errored.delegatedRuns[0]?.status, "failed");
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

test("delegated run updates preserve position and bound new runs", () => {
  const run = (id: string): DelegatedAgentRunReadModel => ({
    id, kind: "grunt", turn: 1, status: "running", activity: [],
  });
  const original = Array.from({ length: 100 }, (_, index) => run(`run-${index}`));
  const completed = { ...original[40]!, status: "completed" as const };
  const replaced = replaceDelegatedRun(original, completed);

  assert.equal(replaced[40], completed);
  assert.deepEqual(replaced.map(({ id }) => id), original.map(({ id }) => id));

  const appended = replaceDelegatedRun(replaced, run("new-run"));
  assert.equal(appended.length, 100);
  assert.equal(appended[0]?.id, "run-1");
  assert.equal(appended.at(-1)?.id, "new-run");
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

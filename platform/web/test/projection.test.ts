import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { RuntimeSnapshot } from "../src/shared/protocol/snapshots.ts";
import { decodeHistoryCursor, encodeHistoryCursor, latestVisibleUserIndex, projectConversation, projectConversationTurnIndex, projectMessages, RuntimeProjection } from "../src/server/pi/projections.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";

function runtime(): RuntimeSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION, sessionId: "session", sessionGeneration: 1, ready: true, cwdLabel: "repo",
    activeTools: [], availableTools: [], optionalCapabilities: {}, diagnostics: [],
    conversation: { messages: [], tools: [], delegatedRuns: [], streaming: false, queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false } },
    sessionControls: { model: { provider: "mock", id: "test", name: "Test" }, models: [{ provider: "mock", id: "test", name: "Test" }], thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] },
  runtimePolicy: { revision: 1, global: { timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, project: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, session: {}, effective: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, availableVerifyChecks: [] },
    metrics: { model: "test", provider: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextTokens: 0, contextLimit: 1, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
    operational: initialOperational([], []),
    extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
  };
}

test("turn index keeps bounded prompt metadata without assistant bodies", () => {
  const turns = projectConversationTurnIndex([
    { role: "user", content: "  First\n prompt  ", entryId: "user-one", timestamp: "2026-07-27T01:02:00Z" },
    { role: "assistant", content: "large response that does not belong in the index" },
    { role: "user", content: "x".repeat(200), entryId: "user-two" },
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], {
    promptId: "user-one",
    preview: "First prompt",
    createdAt: "2026-07-27T01:02:00.000Z",
    cursor: encodeHistoryCursor(0),
  });
  assert.equal(turns[1]!.preview.length, 120);
});

function session(payload: Record<string, unknown>) {
  return { type: "session.event" as const, sessionId: "session", sessionGeneration: 1, payload };
}

function ui(method: string, payload: Record<string, unknown>, requestId = method) {
  return { type: "ui.event" as const, sessionId: "session", sessionGeneration: 1, payload: { kind: "request", requestId, method, payload, createdAt: new Date().toISOString() } };
}

test("session status projects completion as a separate pulse", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const workStartedAt = "2026-07-30T10:00:00.000Z";
  projection.apply({ type: "session.status", sessionId: "background", sessionGeneration: 1, state: "idle", workStartedAt: null, completed: true, cue: "turn-complete" });
  projection.apply({ type: "session.status", sessionId: "background", sessionGeneration: 1, state: "running", workStartedAt });
  assert.deepEqual(published, [
    { type: "session.status", payload: { sessionId: "background", state: "idle", workStartedAt: null, completed: true, cue: "turn-complete" } },
    { type: "session.status", payload: { sessionId: "background", state: "running", workStartedAt } },
  ]);
});

test("projection maps SDK event names and retains active messages", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "queue_update", steering: ["one"], followUp: ["two", "three"] }));
  projection.apply(session({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "retry" }));
  projection.apply(session({ type: "compaction_start", reason: "threshold" }));
  projection.apply(session({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "src/app.ts", apiToken: "hidden" } }));
  projection.apply(session({ type: "tool_execution_end", toolCallId: "call", toolName: "read", result: {}, isError: false }));
  projection.apply(session({ type: "message_start", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "source" }], isError: false } }));
  projection.apply(session({ type: "message_end", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "source" }], isError: false } }));
  const toolMessage = projection.snapshot().conversation.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.tool?.input ?? "", /src\/app\.ts/);
  assert.doesNotMatch(toolMessage?.tool?.input ?? "", /hidden|apiToken/);
  for (let index = 0; index < 105; index++) {
    projection.apply(session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: `message ${index}` }] } }));
    projection.apply(session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `message ${index}` }] } }));
  }
  const result = projection.snapshot();
  assert.deepEqual(result.conversation.queue, { steering: 1, followUp: 2 });
  assert.equal(result.conversation.retry.active, true);
  assert.deepEqual(result.conversation.compaction, { active: true, reason: "threshold" });
  assert.equal(result.conversation.tools[0]?.status, "completed");
  assert.equal(result.conversation.messages.length, 106);
  assert.equal(result.conversation.messages[0]?.role, "tool");
  assert.equal(result.conversation.messages.at(-1)?.text, "message 104");
  assert.ok(result.conversation.messages.at(-1)?.createdAt);
  assert.ok(published.some((event) => event.type === "tool.start"));

  const replacement = runtime();
  replacement.sessionId = "replacement";
  replacement.sessionGeneration = 2;
  replacement.conversation.messages = [{ id: "history", role: "user", text: "Loaded history", streaming: false }];
  projection.apply({
    type: "session.replaced",
    sessionId: replacement.sessionId,
    sessionGeneration: replacement.sessionGeneration,
    runtime: replacement,
  });
  const replaced = projection.snapshot().conversation;
  assert.equal(replaced.messages.length, 1);
  assert.equal(replaced.messages[0]?.text, "Loaded history");
  assert.equal(replaced.tools.length, 0);
});

test("next prompt keeps the expanded existing-session turn", () => {
  const initial = runtime();
  initial.conversation.historyCursor = "before-expanded-turn";
  initial.conversation.historyRemaining = 25;
  initial.conversation.messages = [
    { id: "previous-user", role: "user", text: "Previous prompt", streaming: false },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `previous-tool-${index}`,
      role: "tool" as const,
      text: `result ${index}`,
      streaming: false,
      tool: { id: `call-${index}`, name: "read", status: "completed" as const },
    })),
  ];
  const projection = new RuntimeProjection(initial, () => {});

  projection.apply(session({
    type: "message_start",
    message: { id: "next-user", role: "user", content: "Next prompt" },
  }));

  const snapshot = projection.snapshot();
  assert.equal(snapshot.conversation.messages.length, 122);
  assert.equal(snapshot.conversation.messages[0]?.id, "previous-user");
  assert.equal(snapshot.conversation.messages.filter((message) => message.role === "tool").length, 120);
  assert.equal(snapshot.conversation.messages.at(-1)?.id, "next-user");
  assert.equal(snapshot.conversation.historyCursor, "before-expanded-turn");
  assert.equal(snapshot.conversation.historyRemaining, 25);
});

test("history projection pairs bounded redacted tool inputs with results", () => {
  const messages = projectMessages([
    { role: "custom", customType: "pi-continuity-memory", display: false, content: "injected context" },
    { role: "user", content: [{ type: "text", text: "" }, { type: "image", mimeType: "image/png", data: "not-returned" }] },
    {
      role: "custom",
      customType: "pylon-prompt-files",
      display: false,
      content: "hidden file contents",
      details: { version: 1, files: [{ name: "notes.txt", size: 12 }] },
    },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/app.ts", password: "hidden" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "done" }], isError: false },
  ]);
  assert.deepEqual(messages[0], { id: "history-0", role: "system", text: "injected context", streaming: false, systemSource: "pi-continuity-memory" });
  assert.equal(messages[1]?.attachmentCount, 1);
  assert.equal(messages[1]?.fileAttachmentCount, 1);
  assert.doesNotMatch(JSON.stringify(messages), /hidden file contents|notes\.txt/);
  assert.equal(messages[2]?.text, "");
  assert.deepEqual(messages[3]?.tool, {
    id: "call-1",
    name: "write",
    input: '{\n  "path": "src/app.ts"\n}',
    status: "completed",
  });
  assert.equal(messages[3]?.text, "done");
});

test("history projection keeps stable global IDs and skips old non-delegate payload serialization", () => {
  let oldPayloadReads = 0;
  const oldArguments = new Proxy({ path: "old.ts" }, {
    ownKeys(target) { oldPayloadReads++; return Reflect.ownKeys(target); },
  });
  const history = [
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: oldArguments }] },
    { role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "old" }] },
    ...Array.from({ length: 150 }, (_, index) => ({ role: "user", content: `message ${index}` })),
  ];
  const projected = projectConversation(history);
  assert.equal(projected.messages.length, 100);
  assert.equal(projected.messages[0]?.id, "history-52");
  assert.equal(projected.messages.at(-1)?.id, "history-151");
  assert.equal(oldPayloadReads, 0);
  const page = projectConversation(history, { start: 2, end: 12, includeDelegated: false });
  assert.equal(page.messages[0]?.id, "history-2");
  assert.equal(page.messages.at(-1)?.id, "history-11");
  assert.equal(decodeHistoryCursor(encodeHistoryCursor(52)), 52);
  assert.equal(decodeHistoryCursor("not-a-cursor"), undefined);
});

test("existing-session projection keeps the complete latest user turn", () => {
  const history = [
    ...Array.from({ length: 30 }, (_, index) => ({ role: "assistant", content: `old ${index}` })),
    { role: "user", content: "Run every check" },
    ...Array.from({ length: 60 }, (_, index) => ([
      { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.ts` } }] },
      { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: `result ${index}` }] },
    ])).flat(),
    { role: "assistant", content: [{ type: "toolCall", id: "call-running", name: "bash", arguments: { command: "npm test" } }] },
  ];
  const tailStart = history.length - 100;
  const historyStart = Math.min(tailStart, latestVisibleUserIndex(history) ?? tailStart);
  const projected = projectConversation(history, { start: historyStart, limitMessages: false });

  assert.equal(historyStart, 30);
  assert.equal(projected.messages[0]?.role, "user");
  assert.equal(projected.messages[0]?.text, "Run every check");
  const tools = projected.messages.filter((message) => message.role === "tool");
  assert.equal(tools.length, 61);
  assert.deepEqual(tools[0]?.tool, {
    id: "call-0",
    name: "read",
    input: '{\n  "path": "0.ts"\n}',
    status: "completed",
  });
  assert.deepEqual(tools.at(-1)?.tool, {
    id: "call-running",
    name: "bash",
    input: '{\n  "command": "npm test"\n}',
    status: "running",
  });
});

test("history projection retains bounded Pi entry IDs for editable prompts", () => {
  const projected = projectConversation([
    { role: "user", content: "Original prompt", entryId: "pi-entry-1", timestamp: 1_000, canUndo: true },
    { role: "assistant", content: "Original response", entryId: "pi-entry-2" },
  ]);
  assert.equal(projected.messages[0]?.id, "history-0");
  assert.equal(projected.messages[0]?.entryId, "pi-entry-1");
  assert.equal(projected.messages[0]?.createdAt, new Date(1_000).toISOString());
  assert.equal(projected.messages[0]?.canUndo, true);
  assert.equal(projected.messages[1]?.entryId, "pi-entry-2");
});

test("projections reject invalid dates and negative worktree counts", () => {
  assert.equal(projectMessages([
    { role: "user", content: "Bad timestamp", timestamp: 1e100 },
  ])[0]?.createdAt, undefined);

  const initial = runtime();
  initial.conversation.messages = [{
    id: "assistant-1",
    role: "assistant",
    text: "Done",
    streaming: false,
  }];
  const projection = new RuntimeProjection(initial, () => undefined);
  projection.apply(session({
    type: "worktree_summary",
    messageId: "assistant-1",
    files: [
      { path: "invalid.ts", additions: -1, deletions: 2 },
      { path: "valid.ts", additions: 3, deletions: 1 },
    ],
  }));
  assert.deepEqual(projection.snapshot().conversation.messages[0]?.changedFiles, [
    { path: "valid.ts", additions: 3, deletions: 1 },
  ]);
});

test("Timeline undo availability is published without exposing Pi entry IDs", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const initial = runtime();
  initial.conversation.messages = [{
    id: "message-1",
    entryId: "entry-1",
    role: "user",
    text: "Prompt",
    streaming: false,
  }];
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "prompt_undo", entryIds: ["entry-1"] }));
  assert.equal(projection.snapshot().conversation.messages[0]?.canUndo, true);
  const event = published.find((item) => item.type === "message.undo");
  assert.deepEqual(event?.payload, {
    items: [{ id: "message-1", canUndo: true, canForkWithTimeline: false }],
  });
  assert.doesNotMatch(JSON.stringify(event), /entry-1/);
});

test("history projection reconstructs bounded delegated runs from tool details", () => {
  const activity = Array.from({ length: 105 }, (_, index) => ({
    kind: index % 2 ? "result" : "call",
    tool: "read",
    text: "x".repeat(2_100),
  }));
  const projected = projectConversation([
    { role: "user", content: "Inspect the repository" },
    { role: "assistant", content: [{ type: "toolCall", id: "scout-1", name: "repo_scout", arguments: { task: "Map the runtime", apiToken: "hidden" } }] },
    {
      role: "toolResult",
      toolCallId: "scout-1",
      toolName: "repo_scout",
      content: [{ type: "text", text: "Repository report" }],
      isError: false,
      details: {
        agentName: "S1",
        startedAt: "2026-07-27T01:02:03.000Z",
        model: "provider/scout",
        thinking: "high",
        durationMs: 1_250,
        usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, cost: 0.01 },
        activity,
      },
    },
    { role: "assistant", content: [{ type: "toolCall", id: "other", name: "read", arguments: { path: "src/app.ts" } }] },
  ]);
  assert.equal(projected.delegatedRuns.length, 1);
  assert.deepEqual(projected.delegatedRuns[0], {
    id: "scout-1",
    kind: "repo_scout",
    turn: 1,
    request: "Map the runtime",
    response: "Repository report",
    status: "completed",
    agentName: "S1",
    startedAt: "2026-07-27T01:02:03.000Z",
    modelName: "provider/scout",
    thinkingLevel: "high",
    durationMs: 1_250,
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, cost: 0.01 },
    activity: activity.slice(0, 100).map((item) => ({ ...item, text: item.text.slice(0, 2_000) })),
  });
  assert.doesNotMatch(projected.delegatedRuns[0]?.request ?? "", /hidden|apiToken/);
});

test("delegated activity remains bounded when redaction expands text", () => {
  const projected = projectConversation([
    { role: "assistant", content: [{ type: "toolCall", id: "scout-1", name: "repo_scout", arguments: {} }] },
    {
      role: "toolResult",
      toolCallId: "scout-1",
      toolName: "repo_scout",
      details: { activity: [{ kind: "result", tool: "read", text: `password: x ${"x".repeat(1_988)}` }] },
    },
  ]);
  const text = projected.delegatedRuns[0]?.activity[0]?.text ?? "";
  assert.equal(text.length, 2_000);
  assert.match(text, /password: <redacted>/);
});

test("projection publishes live delegated-run updates once per tool event", () => {
  const published: Array<{ type: string; payload: any }> = [];
  const initial = runtime();
  initial.metrics.userMessages = 2;
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "tool_execution_start", toolCallId: "grunt-1", toolName: "grunt", args: { task: "Apply edits" } }));
  projection.apply(session({
    type: "tool_execution_update",
    toolCallId: "grunt-1",
    toolName: "grunt",
    args: { task: "Apply edits" },
    partialResult: {
      content: [{ type: "text", text: "Worker activity:\nread a.ts" }],
      details: { state: "running", model: "provider/grunt", thinking: "medium", activity: [{ kind: "call", tool: "read", text: "{\"path\":\"a.ts\",\"password\":\"hidden\"}" }] },
    },
  }));
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.response, undefined);
  projection.apply(session({
    type: "tool_execution_end",
    toolCallId: "grunt-1",
    toolName: "grunt",
    result: {
      content: [{ type: "text", text: "Worker status: completed." }],
      details: {
        status: "completed",
        model: "provider/grunt",
        thinking: "medium",
        durationMs: 500,
        usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
        activity: [
          { kind: "call", tool: "read", text: "{\"path\":\"a.ts\",\"password\":\"hidden\"}" },
          { kind: "result", tool: "read", text: "token=hidden source" },
        ],
      },
    },
    isError: false,
  }));
  projection.apply(session({
    type: "tool_execution_update",
    toolCallId: "grunt-1",
    toolName: "grunt",
    partialResult: {
      content: [{ type: "text", text: "Worker activity:\nlate update" }],
      details: {
        state: "running",
        activity: [
          { kind: "call", tool: "read", text: "{\"path\":\"a.ts\",\"password\":\"hidden\"}" },
          { kind: "result", tool: "read", text: "token=hidden source" },
          { kind: "call", tool: "edit", text: "{\"path\":\"a.ts\"}" },
        ],
      },
    },
  }));
  const updates = published.filter((event) => event.type === "delegate.update");
  assert.equal(updates.length, 4);
  assert.equal(updates[0]?.payload.status, "running");
  assert.deepEqual(projection.snapshot().conversation.delegatedRuns[0], {
    id: "grunt-1",
    kind: "grunt",
    turn: 2,
    request: "Apply edits",
    response: "Worker status: completed.",
    status: "completed",
    modelName: "provider/grunt",
    thinkingLevel: "medium",
    durationMs: 500,
    usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
    activity: [
      { kind: "call", tool: "read", text: '{\n  "path": "a.ts"\n}' },
      { kind: "result", tool: "read", text: "token=<redacted> source" },
      { kind: "call", tool: "edit", text: '{\n  "path": "a.ts"\n}' },
    ],
  });
});

test("Repo Scout live records settle with usage and bounded tool history", () => {
  const projection = new RuntimeProjection(runtime(), () => undefined);
  projection.apply(session({
    type: "tool_execution_start",
    toolCallId: "scout-live",
    toolName: "repo_scout",
    args: { task: "Trace the runtime" },
  }));
  projection.apply(session({
    type: "tool_execution_update",
    toolCallId: "scout-live",
    toolName: "repo_scout",
    partialResult: {
      content: [{ type: "text", text: "Scout child activity:\nread src/app.ts" }],
      details: {
        state: "running",
        activity: [{ kind: "call", tool: "read", text: "{\"path\":\"src/app.ts\"}" }],
      },
    },
  }));
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.response, undefined);
  projection.apply(session({
    type: "tool_execution_update",
    toolCallId: "scout-live",
    toolName: "repo_scout",
    partialResult: {
      details: {
        state: "running",
        usage: { input: 50, output: 12, cacheRead: 20, cacheWrite: 0, cost: 0.03 },
        activity: [],
      },
    },
  }));
  projection.apply(session({
    type: "tool_execution_end",
    toolCallId: "scout-live",
    toolName: "repo_scout",
    result: {
      content: [{ type: "text", text: "Scout report" }],
      details: {
        model: "provider/scout",
        durationMs: 900,
      },
    },
  }));
  projection.apply(session({
    type: "tool_execution_update",
    toolCallId: "scout-live",
    toolName: "repo_scout",
    partialResult: {
      content: [{ type: "text", text: "Scout child activity:\nlate update" }],
      details: {
        state: "running",
        activity: [
          { kind: "call", tool: "read", text: "{\"path\":\"src/app.ts\"}" },
          { kind: "result", tool: "read", text: "export const app = true;" },
        ],
      },
    },
  }));
  projection.apply(session({
    type: "tool_execution_start",
    toolCallId: "scout-failed",
    toolName: "repo_scout",
    args: { task: "Inspect missing credentials" },
  }));
  projection.apply(session({
    type: "tool_execution_end",
    toolCallId: "scout-failed",
    toolName: "repo_scout",
    result: {
      content: [{ type: "text", text: "Repo Scout child failed." }],
      details: {
        failureCode: "child_error",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        activity: [],
      },
    },
  }));

  const [completed, failed] = projection.snapshot().conversation.delegatedRuns;
  assert.deepEqual(completed?.usage, { input: 50, output: 12, cacheRead: 20, cacheWrite: 0, cost: 0.03 });
  assert.deepEqual(completed?.activity, [
    { kind: "call", tool: "read", text: '{\n  "path": "src/app.ts"\n}' },
    { kind: "result", tool: "read", text: "export const app = true;" },
  ]);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.response, "Scout report");
  assert.deepEqual(failed?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.deepEqual(failed?.activity, []);
  assert.equal(failed?.status, "failed");
});

test("projection publishes live session names and agent timing metadata", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const startedAt = new Date().toISOString();

  projection.apply(session({
    type: "agent_start",
    turnId: "turn-1",
    workStartedAt: startedAt,
    modelName: "GPT-5",
    thinkingLevel: "high",
    metrics: { userMessages: 1 },
  }));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  projection.apply(session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-1",
    workDurationMs: 1_234,
    modelName: "GPT-5",
    thinkingLevel: "high",
    gitBranch: "main",
    metrics: { userMessages: 1, cost: 0.25 },
    assistantMessage: { id: "history-2", entryId: "assistant-entry", role: "assistant", text: "Done", streaming: false },
  }));
  projection.apply(session({
    type: "worktree_summary",
    turnId: "turn-1",
    messageId: "history-999",
    files: [{ path: "src/app.ts", additions: 4, deletions: 2, binary: false }],
  }));
  projection.apply(session({ type: "session_info_changed", name: "Renamed by timeline" }));

  const snapshot = projection.snapshot();
  assert.equal(snapshot.sessionName, "Renamed by timeline");
  assert.equal(snapshot.gitBranch, "main");
  assert.equal(snapshot.metrics.userMessages, 1);
  assert.equal(snapshot.metrics.cost, 0.25);
  assert.equal(snapshot.conversation.workStartedAt, undefined);
  assert.equal(snapshot.conversation.messages.at(-1)?.workDurationMs, 1_234);
  assert.equal(snapshot.conversation.messages.at(-1)?.modelName, "GPT-5");
  assert.equal(snapshot.conversation.messages.at(-1)?.thinkingLevel, "high");
  assert.deepEqual(snapshot.conversation.messages.at(-1)?.changedFiles, [
    { path: "src/app.ts", additions: 4, deletions: 2 },
  ]);
  assert.deepEqual(published.filter((event) => event.type === "session.info").map((event) => event.payload), [
    { sessionId: "session", name: "Renamed by timeline" },
  ]);
  assert.equal((published.find((event) => event.type === "agent.start")?.payload as { startedAt: string }).startedAt, startedAt);
  assert.equal((published.find((event) => event.type === "agent.end")?.payload as { durationMs: number }).durationMs, 1_234);
  assert.ok(published.some((event) => event.type === "turn.changes"));
});

test("agent completion restores an assistant lost during session selection", () => {
  const initial = runtime();
  initial.conversation.streaming = true;
  initial.conversation.messages = [
    { id: "history-1", entryId: "earlier-assistant", role: "assistant", text: "Completed while switching sessions", streaming: false },
  ];
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));

  projection.apply(session({
    type: "agent_end",
    turnId: "turn-1",
    workDurationMs: 1_234,
    modelName: "GPT-5",
    thinkingLevel: "high",
    assistantMessage: {
      id: "history-3",
      entryId: "final-assistant",
      role: "assistant",
      text: "Completed while switching sessions",
      streaming: false,
    },
  }));

  const messages = projection.snapshot().conversation.messages;
  assert.deepEqual(messages.map((message) => message.id), ["history-1", "history-3"]);
  assert.equal(messages.at(-1)?.entryId, "final-assistant");
  assert.equal(messages.at(-1)?.workDurationMs, 1_234);
  assert.equal(projection.snapshot().conversation.streaming, false);
  assert.deepEqual(published.filter((event) => event.type.startsWith("message.")).map((event) => event.type), [
    "message.start",
    "message.end",
  ]);
  assert.equal((published.at(-1)?.payload as { messageId?: string }).messageId, "history-3");
});

test("agent completion does not duplicate live or snapshotted assistants", () => {
  const canonical = {
    id: "history-2",
    entryId: "final-assistant",
    role: "assistant" as const,
    text: "Done",
    streaming: false,
  };
  const liveEvents: string[] = [];
  const live = new RuntimeProjection(runtime(), (type) => liveEvents.push(type));
  live.apply(session({ type: "agent_start", turnId: "turn-live" }));
  live.apply(session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  live.apply(session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  live.apply(session({ type: "agent_end", turnId: "turn-live", assistantMessage: canonical }));
  assert.equal(live.snapshot().conversation.messages.length, 1);
  assert.equal(live.snapshot().conversation.messages[0]?.entryId, "final-assistant");
  assert.deepEqual(liveEvents.filter((type) => type.startsWith("message.")), ["message.start", "message.end"]);

  const loaded = runtime();
  loaded.conversation.messages = [canonical];
  const loadedEvents: string[] = [];
  const snapshotted = new RuntimeProjection(loaded, (type) => loadedEvents.push(type));
  snapshotted.apply(session({ type: "agent_end", turnId: "turn-loaded", assistantMessage: canonical }));
  assert.equal(snapshotted.snapshot().conversation.messages.length, 1);
  assert.deepEqual(loadedEvents.filter((type) => type.startsWith("message.")), []);

  const malformedRuntime = runtime();
  malformedRuntime.conversation.messages = [
    { id: "older-assistant", role: "assistant", text: "Earlier turn", streaming: false },
  ];
  const malformed = new RuntimeProjection(malformedRuntime, () => undefined);
  malformed.apply(session({ type: "agent_end", turnId: "turn-malformed", workDurationMs: 500, assistantMessage: { role: "assistant" } }));
  assert.equal(malformed.snapshot().conversation.messages[0]?.workDurationMs, undefined);
});

test("agent completion flushes pending text before its terminal event", () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), (type) => published.push(type));
  projection.apply(session({ type: "agent_start", turnId: "turn-pending" }));
  projection.apply(session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-pending",
    assistantMessage: { id: "history-2", entryId: "final-assistant", role: "assistant", text: "Done", streaming: false },
  }));
  assert.equal(projection.snapshot().conversation.messages.length, 1);
  assert.deepEqual(published.slice(-3), ["message.update", "message.end", "agent.end"]);
});

test("projection keeps one active timer across retry attempts", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const originalStart = "2026-01-01T00:00:00.000Z";

  projection.apply(session({ type: "agent_start", turnId: "turn-1", workStartedAt: originalStart, modelName: "GPT-5" }));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Temporary failure" }] } }));
  projection.apply(session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Temporary failure" }] } }));
  projection.apply(session({ type: "agent_end", turnId: "turn-1", workDurationMs: 1_000, willRetry: true }));

  assert.equal(projection.snapshot().conversation.workStartedAt, originalStart);
  assert.equal(projection.snapshot().conversation.messages.at(-1)?.workDurationMs, undefined);

  projection.apply(session({ type: "agent_start", turnId: "turn-1", workStartedAt: "2026-01-01T00:00:10.000Z", modelName: "GPT-5" }));
  assert.equal(projection.snapshot().conversation.workStartedAt, originalStart);

  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  projection.apply(session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-1",
    workDurationMs: 12_000,
    willRetry: false,
    assistantMessage: { id: "history-4", entryId: "final-retry", role: "assistant", text: "Done", streaming: false },
  }));

  assert.equal(projection.snapshot().conversation.workStartedAt, undefined);
  assert.equal(projection.snapshot().conversation.messages.at(-1)?.workDurationMs, 12_000);

  projection.apply(session({ type: "agent_start", turnId: "turn-2", workStartedAt: originalStart }));
  projection.apply(session({ type: "agent_end", turnId: "turn-2", workDurationMs: 500, willRetry: true, stopped: true }));
  assert.equal(projection.snapshot().conversation.workStartedAt, undefined);
  assert.equal((published.at(-1)?.payload as { willRetry?: boolean }).willRetry, false);
});

test("projection persists terminal agent errors and clears them for retries and new runs", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));

  projection.apply(session({ type: "agent_start", turnId: "turn-error" }));
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-error",
    errorMessage: "provider rejected request",
    willRetry: false,
  }));

  assert.equal(projection.snapshot().conversation.agentError, "provider rejected request");
  assert.equal(([...published].reverse().find((event) => event.type === "agent.end")?.payload as { message?: string }).message, "provider rejected request");

  projection.apply(session({ type: "agent_start", turnId: "turn-retry" }));
  assert.equal(projection.snapshot().conversation.agentError, undefined);
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-retry",
    errorMessage: "temporary failure",
    willRetry: true,
  }));
  assert.equal(projection.snapshot().conversation.agentError, undefined);
});

test("projection retains stopped tool-only run metadata without an assistant message", () => {
  const initial = runtime();
  initial.conversation.messages = [
    { id: "older-assistant", role: "assistant", text: "Earlier turn", streaming: false },
  ];
  const projection = new RuntimeProjection(initial, () => undefined);
  projection.apply(session({
    type: "agent_start",
    turnId: "turn-stopped",
    workStartedAt: new Date().toISOString(),
    modelName: "GPT-5",
    thinkingLevel: "medium",
  }));
  projection.apply(session({
    type: "agent_end",
    turnId: "turn-stopped",
    userEntryId: "user-entry",
    workDurationMs: 500,
    modelName: "GPT-5",
    thinkingLevel: "medium",
    stopped: true,
    assistantMessage: null,
  }));
  assert.deepEqual(projection.snapshot().conversation.stoppedRun, {
    turnId: "turn-stopped",
    userEntryId: "user-entry",
    durationMs: 500,
    modelName: "GPT-5",
    thinkingLevel: "medium",
  });
  assert.equal(projection.snapshot().conversation.messages[0]?.workDurationMs, undefined);
  assert.equal(projection.snapshot().conversation.stopping, false);
});

test("projection publishes bounded discover index state", () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), (type) => published.push(type));
  projection.apply(session({
    type: "discover_index",
    value: { state: "idle", files: 1_200, symbols: 3_400, indexedAt: new Date(0).toISOString() },
  }));
  assert.deepEqual(projection.snapshot().discoverIndex, {
    state: "idle",
    files: 1_200,
    symbols: 3_400,
    indexedAt: new Date(0).toISOString(),
  });
  assert.ok(published.includes("discover.index"));
});

test("projection retains bounded extension UI state and publishes mutation events", () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), (type) => published.push(type));
  projection.apply(ui("notify", { message: "done", type: "info" }));
  projection.apply(ui("setStatus", { key: "guard", text: "ready" }));
  projection.apply(ui("setWidget", { key: "plan", lines: ["one", "two"], placement: "aboveEditor" }));
  projection.apply(ui("setTitle", { title: "Pylon run" }));
  projection.apply(ui("setEditorText", { text: "draft" }));

  let state = projection.snapshot().extensionUi;
  assert.equal(state.notifications[0]?.message, "done");
  assert.deepEqual(state.statuses, [{ key: "guard", text: "ready" }]);
  assert.deepEqual(state.widgets, [{ key: "plan", lines: ["one", "two"], placement: "aboveEditor" }]);
  assert.equal(state.title, "Pylon run");
  assert.equal(state.editorText, "draft");
  assert.equal(state.editorRevision, 1);
  assert.deepEqual(published, ["ui.notify", "ui.status", "ui.widget", "ui.title", "ui.editor-text"]);

  projection.apply(ui("setStatus", { key: "guard" }));
  projection.apply(ui("setWidget", { key: "plan" }));
  state = projection.snapshot().extensionUi;
  assert.deepEqual(state.statuses, []);
  assert.deepEqual(state.widgets, []);
});

test("projection synchronizes slash-command results and dismissal", () => {
  const published: unknown[] = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => {
    if (type === "command.result") published.push(payload);
  });
  const result = {
    id: "command-1",
    command: "sieve",
    output: "Pi Sieve enabled.",
    severity: "info" as const,
    occurredAt: new Date().toISOString(),
  };
  projection.apply({ type: "command.result", sessionId: "session", sessionGeneration: 1, result });
  assert.deepEqual(projection.snapshot().commandResult, result);
  projection.apply({ type: "command.result", sessionId: "session", sessionGeneration: 1 });
  assert.equal(projection.snapshot().commandResult, undefined);
  assert.equal(published.length, 2);
});

test("projection disposal cancels delayed stream publication", async () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), (type) => published.push(type));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [] } }));
  projection.apply(session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }));
  projection.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(published, ["message.start"]);
});

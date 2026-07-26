import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { RuntimeSnapshot } from "../src/shared/protocol/snapshots.ts";
import { projectMessages, RuntimeProjection } from "../src/server/pi/projections.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";

function runtime(): RuntimeSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION, sessionId: "session", sessionGeneration: 1, ready: true, cwdLabel: "repo",
    activeTools: [], availableTools: [], optionalCapabilities: {}, diagnostics: [],
    conversation: { messages: [], tools: [], streaming: false, queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false } },
    sessionControls: { model: { provider: "mock", id: "test", name: "Test" }, models: [{ provider: "mock", id: "test", name: "Test" }], thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] },
    metrics: { model: "test", provider: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextTokens: 0, contextLimit: 1, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
    operational: initialOperational([], []),
    extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
  };
}

function session(payload: Record<string, unknown>) {
  return { type: "session.event" as const, sessionId: "session", sessionGeneration: 1, payload };
}

function ui(method: string, payload: Record<string, unknown>, requestId = method) {
  return { type: "ui.event" as const, sessionId: "session", sessionGeneration: 1, payload: { kind: "request", requestId, method, payload, createdAt: new Date().toISOString() } };
}

test("projection maps SDK event names and bounds retained read models", () => {
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
  assert.equal(result.conversation.messages.length, 100);
  assert.equal(result.conversation.messages.at(-1)?.text, "message 104");
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
  assert.equal(projection.snapshot().conversation.messages[0]?.text, "Loaded history");
});

test("history projection pairs bounded redacted tool inputs with results", () => {
  const messages = projectMessages([
    { role: "custom", customType: "pi-continuity-memory", display: false, content: "injected context" },
    { role: "user", content: [{ type: "text", text: "" }, { type: "image", mimeType: "image/png", data: "not-returned" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/app.ts", password: "hidden" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "done" }], isError: false },
  ]);
  assert.deepEqual(messages[0], { id: "history-0", role: "system", text: "injected context", streaming: false, systemSource: "pi-continuity-memory" });
  assert.equal(messages[1]?.attachmentCount, 1);
  assert.equal(messages[2]?.text, "");
  assert.deepEqual(messages[3]?.tool, {
    id: "call-1",
    name: "write",
    input: '{\n  "path": "src/app.ts"\n}',
    status: "completed",
  });
  assert.equal(messages[3]?.text, "done");
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

test("projection disposal cancels delayed stream publication", async () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), (type) => published.push(type));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [] } }));
  projection.apply(session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }));
  projection.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(published, ["message.start"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { agentColorId } from "../src/shared/format.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { RuntimeSnapshot } from "../src/shared/protocol/snapshots.ts";
import type { ProviderAuthReadModel } from "../src/shared/protocol/events.ts";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  latestVisibleUserIndex,
  projectConversation,
  projectConversationTurnIndex,
  projectMessages,
  RuntimeProjection,
} from "../src/server/pi/projections.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";

function runtime(): RuntimeSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session",
    sessionGeneration: 1,
    ready: true,
    cwdLabel: "repo",
    activeTools: [],
    availableTools: [],
    optionalCapabilities: {},
    diagnostics: [],
    conversation: {
      messages: [],
      tools: [],
      delegatedRuns: [],
      streaming: false,
      queue: { steering: 0, followUp: 0 },
      retry: { active: false },
      compaction: { active: false },
    },
    sessionControls: {
      model: { provider: "mock", id: "test", name: "Test" },
      models: [{ provider: "mock", id: "test", name: "Test" }],
      thinkingLevel: "medium",
      thinkingLevels: ["low", "medium", "high"],
    },
    runtimePolicy: {
      revision: 1,
      global: {
        timelineEnabled: true,
        guardEnabled: true,
        workspace: "local",
        guardTimeoutSeconds: 60,
        clarifyTimeoutSeconds: 60,
      },
      project: {
        verify: { mode: "auto" },
        timelineEnabled: true,
        guardEnabled: true,
        workspace: "local",
        guardTimeoutSeconds: 60,
        clarifyTimeoutSeconds: 60,
      },
      session: {},
      effective: {
        verify: { mode: "auto" },
        timelineEnabled: true,
        guardEnabled: true,
        workspace: "local",
        guardTimeoutSeconds: 60,
        clarifyTimeoutSeconds: 60,
      },
      availableVerifyChecks: [],
    },
    metrics: {
      model: "test",
      provider: "mock",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 0,
      contextLimit: 1,
      contextPercent: 0,
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
    },
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
  return {
    type: "ui.event" as const,
    sessionId: "session",
    sessionGeneration: 1,
    payload: { kind: "request", requestId, method, payload, createdAt: new Date().toISOString() },
  };
}

test("provider auth driver events publish live sign-in links", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const providerAuth: ProviderAuthReadModel = {
    providers: [
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        configured: false,
        stored: false,
        methods: [{ type: "oauth", name: "OpenAI (ChatGPT Plus/Pro)", interactive: true }],
      },
    ],
    flow: {
      id: "auth-flow",
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      authType: "oauth",
      status: "running",
      message: "Complete login in your browser.",
      authUrl: "https://auth.openai.com/oauth/authorize",
    },
  };

  projection.apply({ type: "provider.auth", sessionId: "session", sessionGeneration: 1, providerAuth });

  assert.deepEqual(projection.snapshot().providerAuth, providerAuth);
  assert.deepEqual(published, [{ type: "provider.auth", payload: providerAuth }]);
});

test("metrics projection retains bounded per-tool usage", () => {
  const projection = new RuntimeProjection(runtime(), () => undefined);
  projection.apply(
    session({
      type: "usage",
      inputTokens: 120,
      cacheReadTokens: 240,
      cacheWriteTokens: 60,
      toolUsage: [
        { name: "read", calls: 3, inputTokens: 72, outputTokens: 8, tokens: 80 },
        { name: "invalid", calls: -1, inputTokens: 18, outputTokens: 2, tokens: 20 },
      ],
    }),
  );
  assert.equal(projection.snapshot().metrics.inputTokens, 120);
  assert.equal(projection.snapshot().metrics.cacheReadTokens, 240);
  assert.equal(projection.snapshot().metrics.cacheWriteTokens, 60);
  assert.deepEqual(projection.snapshot().metrics.toolUsage, [
    { name: "read", calls: 3, inputTokens: 72, outputTokens: 8, tokens: 80 },
  ]);
  projection.apply(
    session({
      type: "usage",
      toolUsage: Array.from({ length: 201 }, (_, index) => ({
        name: `tool-${index}`,
        calls: 1,
        inputTokens: 1,
        outputTokens: 0,
        tokens: 1,
      })),
    }),
  );
  assert.equal(projection.snapshot().metrics.toolUsage?.length, 200);
  projection.apply(
    session({
      type: "usage",
      toolUsage: [
        { name: "read", calls: 3, inputTokens: 72, outputTokens: 8, tokens: 80 },
        { name: "read", calls: 2, inputTokens: 36, outputTokens: 4, tokens: 40 },
      ],
    }),
  );
  assert.deepEqual(projection.snapshot().metrics.toolUsage, [
    { name: "read", calls: 3, inputTokens: 72, outputTokens: 8, tokens: 80 },
  ]);
});

test("session status retains background completion until that session is selected", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const workStartedAt = "2026-07-30T10:00:00.000Z";
  projection.apply({
    type: "session.status",
    sessionId: "background",
    sessionGeneration: 1,
    state: "idle",
    workStartedAt: null,
    completed: true,
    cue: "turn-complete",
  });
  projection.apply({
    type: "session.status",
    sessionId: "background",
    sessionGeneration: 1,
    state: "sleeping",
    workStartedAt: null,
  });
  projection.apply({
    type: "session.status",
    sessionId: "external",
    sessionGeneration: 1,
    state: "sleeping",
    completed: true,
  });
  assert.deepEqual(projection.unseenCompletionSessionIds(), ["background", "external"]);
  assert.deepEqual(published, [
    {
      type: "session.status",
      payload: { sessionId: "background", state: "idle", workStartedAt: null, completed: true, cue: "turn-complete" },
    },
    { type: "session.status", payload: { sessionId: "background", state: "sleeping", workStartedAt: null } },
    { type: "session.status", payload: { sessionId: "external", state: "sleeping", completed: true } },
  ]);

  const replacement = runtime();
  replacement.sessionId = "background";
  replacement.sessionGeneration = 2;
  projection.apply({ type: "session.replaced", sessionId: "background", sessionGeneration: 2, runtime: replacement });
  projection.apply({
    type: "session.status",
    sessionId: "background",
    sessionGeneration: 2,
    state: "idle",
    completed: true,
  });
  assert.deepEqual(projection.unseenCompletionSessionIds(), ["external"]);
});

test("correlated user starts reuse the optimistic pending message ID", () => {
  const published: Array<{ type: string; payload: any }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(
    session({
      type: "message_start",
      clientMessageId: "command-1",
      message: { role: "user", content: "same", timestamp: 1 },
    }),
  );
  assert.equal(projection.snapshot().conversation.messages[0]?.id, "pending-command-1");
  assert.equal(published[0]?.payload.id, "pending-command-1");
  projection.apply(session({ type: "message_end", message: { role: "user", content: "same" }, entryId: "entry-1" }));
  assert.equal(projection.snapshot().conversation.messages[0]?.entryId, "entry-1");
});

test("projection maps SDK event names and retains active messages", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "queue_update", steering: ["one"], followUp: ["two", "three"] }));
  projection.apply(session({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "retry" }));
  projection.apply(session({ type: "compaction_start", reason: "threshold" }));
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "read",
      args: { path: "src/app.ts", apiToken: "hidden" },
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      result: {},
      isError: false,
      durationMs: 1_250,
    }),
  );
  projection.apply(
    session({
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "source" }],
        isError: false,
      },
    }),
  );
  projection.apply(
    session({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "source" }],
        isError: false,
      },
    }),
  );
  const toolMessage = projection.snapshot().conversation.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.tool?.input ?? "", /src\/app\.ts/);
  assert.doesNotMatch(toolMessage?.tool?.input ?? "", /hidden|apiToken/);
  assert.equal(toolMessage?.tool?.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(toolMessage?.tool?.durationMs, 1_250);
  for (let index = 0; index < 105; index++) {
    projection.apply(
      session({
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: `message ${index}` }] },
      }),
    );
    projection.apply(
      session({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `message ${index}` }] },
      }),
    );
  }
  const result = projection.snapshot();
  assert.deepEqual(result.conversation.queue, { steering: 1, followUp: 2 });
  assert.equal(result.conversation.retry.active, true);
  assert.deepEqual(result.conversation.compaction, { active: true, reason: "threshold" });
  assert.equal(result.conversation.tools[0]?.status, "completed");
  assert.equal(result.conversation.tools[0]?.durationMs, 1_250);
  assert.equal(result.conversation.messages.length, 106);
  assert.equal(result.conversation.messages[0]?.role, "tool");
  assert.equal(result.conversation.messages.at(-1)?.text, "message 104");
  assert.ok(result.conversation.messages.at(-1)?.createdAt);
  assert.ok(published.some(event => event.type === "tool.start"));

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

test("history projection attaches persisted tool durations", () => {
  const projected = projectConversation(
    [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } }],
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "source" }],
        isError: false,
      },
    ],
    { toolDurations: new Map([["read-1", 1_250]]) },
  );

  assert.equal(projected.messages.find(message => message.role === "tool")?.tool?.durationMs, 1_250);
});

test("compaction completion appends a durable disclosure without changing streaming state", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const initial = runtime();
  initial.conversation.streaming = true;
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  const completedMessage = {
    id: "compaction-entry-1",
    entryId: "entry-1",
    role: "system",
    text: "## Preserved context\n\nSummary body",
    streaming: false,
    createdAt: "2026-08-05T09:00:00.000Z",
    systemSource: "pylon-compaction",
    compaction: { contextAfterTokens: 28_400, sourceEntryCount: 143 },
  };

  projection.apply(
    session({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: completedMessage.text },
      completedMessage,
    }),
  );

  assert.equal(projection.snapshot().conversation.streaming, true);
  assert.deepEqual(projection.snapshot().conversation.compaction, { active: false, reason: "threshold" });
  assert.deepEqual(projection.snapshot().conversation.messages, [completedMessage]);
  assert.deepEqual(published.at(-1), {
    type: "compaction.update",
    payload: { active: false, reason: "threshold", completedMessage },
  });

  projection.apply(
    session({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: completedMessage.text },
      completedMessage,
    }),
  );
  assert.equal(projection.snapshot().conversation.messages.length, 1);
  projection.apply(session({ type: "compaction_end", reason: "manual", aborted: true }));
  assert.equal(projection.snapshot().conversation.messages.length, 1);
});

test("history projection retains bounded structured compaction display data", () => {
  const display = {
    records: [
      { sourceEntryId: "user-entry", role: "user" as const, text: "Keep exact **plain text**" },
      { sourceEntryId: "assistant-entry", role: "assistant" as const, text: "Implemented the change" },
    ],
    failedTools: [{ sourceEntryId: "failed-entry", text: "permission denied" }],
    toolResults: [{ sourceEntryId: "result-entry", text: "all checks passed" }],
    history: {
      read: [{ path: "src/input.ts", sourceEntryId: "read-entry" }],
      modified: [{ path: "src/output.ts", sourceEntryId: "write-entry" }],
    },
  };
  assert.deepEqual(
    projectMessages([
      {
        role: "custom",
        customType: "pylon-compaction",
        content: "# Canonical summary stays separate",
        entryId: "compaction-entry",
        timestamp: "2026-08-05T09:00:00.000Z",
        compaction: {
          contextAfterTokens: 12_345,
          contextBeforeTokens: 52_000,
          sourceEntryCount: 77,
          display: {
            ...display,
            ignored: "not transported",
            records: display.records.map(record => ({ ...record, ignored: true })),
          },
        },
      },
    ]),
    [
      {
        id: "history-0",
        entryId: "compaction-entry",
        role: "system",
        text: "# Canonical summary stays separate",
        streaming: false,
        createdAt: "2026-08-05T09:00:00.000Z",
        systemSource: "pylon-compaction",
        compaction: { contextAfterTokens: 12_345, contextBeforeTokens: 52_000, sourceEntryCount: 77, display },
      },
    ],
  );

  const malformed = projectMessages([
    {
      role: "custom",
      customType: "pylon-compaction",
      content: "summary",
      compaction: {
        contextAfterTokens: 10,
        display: { ...display, toolResults: [{ sourceEntryId: "result", text: "x".repeat(2_001) }] },
      },
    },
  ])[0];
  assert.deepEqual(malformed?.compaction, { contextAfterTokens: 10 });
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

  projection.apply(
    session({ type: "message_start", message: { id: "next-user", role: "user", content: "Next prompt" } }),
  );

  const snapshot = projection.snapshot();
  assert.equal(snapshot.conversation.messages.length, 122);
  assert.equal(snapshot.conversation.messages[0]?.id, "previous-user");
  assert.equal(snapshot.conversation.messages.filter(message => message.role === "tool").length, 120);
  assert.equal(snapshot.conversation.messages.at(-1)?.id, "next-user");
  assert.equal(snapshot.conversation.historyCursor, "before-expanded-turn");
  assert.equal(snapshot.conversation.historyRemaining, 25);
});

test("history projection pairs bounded redacted tool inputs with results", () => {
  const messages = projectMessages([
    { role: "custom", customType: "pi-continuity-memory", display: false, content: "injected context" },
    {
      role: "user",
      content: [
        { type: "text", text: "" },
        { type: "image", mimeType: "image/png", data: "not-returned" },
      ],
    },
    {
      role: "custom",
      customType: "pylon-prompt-files",
      display: false,
      content: "hidden file contents",
      details: { version: 1, files: [{ name: "notes.txt", size: 12 }] },
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/app.ts", password: "hidden" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "write",
      content: [{ type: "text", text: "done" }],
      isError: false,
    },
  ]);
  assert.deepEqual(messages[0], {
    id: "history-0",
    role: "system",
    text: "injected context",
    streaming: false,
    systemSource: "pi-continuity-memory",
  });
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

test("new attachment projection exposes metadata while legacy entries remain count-only", () => {
  const fileContent = "prefix\nhello\nsuffix";
  const messages = projectMessages([
    {
      role: "user",
      entryId: "user-entry",
      content: [
        { type: "text", text: "Review these" },
        { type: "image", mimeType: "image/png", data: "eA==", pylonAttachmentVersion: 2 },
      ],
    },
    {
      role: "custom",
      entryId: "file-entry",
      customType: "pylon-prompt-files",
      display: false,
      content: fileContent,
      details: {
        version: 2,
        files: [{ name: "notes.txt", size: 5, mimeType: "text/plain", contentStart: 7, contentEnd: 12 }],
      },
    },
  ]);
  assert.deepEqual(messages[0]?.attachments, [
    { sourceEntryId: "user-entry", index: 0, kind: "image", name: "Image 1", mimeType: "image/png", size: 1 },
    { sourceEntryId: "file-entry", index: 0, kind: "file", name: "notes.txt", mimeType: "text/plain", size: 5 },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /eA==|hello/);
});

test("Continuity compaction interruptions stay persisted but are omitted from Web history", () => {
  const interruption = {
    role: "assistant",
    content: [{ type: "text", text: "partial internal response" }],
    stopReason: "aborted",
    diagnostics: [
      {
        type: "pi-continuity-compaction-interruption",
        timestamp: 1,
        details: { version: 1, requestId: "compact-1", sessionId: "session" },
      },
    ],
  };
  assert.deepEqual(
    projectConversation([
      { role: "user", content: "Do the task" },
      interruption,
      { role: "assistant", content: "Done", stopReason: "stop" },
    ]).messages.map(message => message.text),
    ["Do the task", "Done"],
  );
  assert.equal(interruption.stopReason, "aborted");
});

test("live Continuity compaction interruption removes only the active assistant", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [] } }));
  projection.apply(
    session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }),
  );
  projection.apply(
    session({
      type: "continuity_compaction_interruption",
      message: {
        role: "assistant",
        stopReason: "aborted",
        diagnostics: [
          { type: "pi-continuity-compaction-interruption", details: { version: 1, requestId: "compact-1" } },
        ],
      },
    }),
  );
  assert.deepEqual(projection.snapshot().conversation.messages, []);
  assert.equal(projection.snapshot().conversation.streaming, false);
  assert.equal(published.at(-1)?.type, "message.remove");
});

test("history projection keeps stable global IDs and skips old non-delegate payload serialization", () => {
  let oldPayloadReads = 0;
  const oldArguments = new Proxy(
    { path: "old.ts" },
    {
      ownKeys(target) {
        oldPayloadReads++;
        return Reflect.ownKeys(target);
      },
    },
  );
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

test("history pages do not mark tool calls running when their result is on a later page", () => {
  const history = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "paged-call", name: "read", arguments: { path: "src/app.ts" } }],
    },
    ...Array.from({ length: 20 }, (_, index) => ({ role: "assistant", content: `filler-${index}` })),
    {
      role: "toolResult",
      toolCallId: "paged-call",
      toolName: "read",
      content: [{ type: "text", text: "done" }],
      isError: false,
    },
  ];

  const page = projectConversation(history, { start: 0, end: 10, includeDelegated: false, limitMessages: false });
  const tool = page.messages.find(message => message.tool?.id === "paged-call");
  assert.equal(tool?.tool?.status, "completed");
  assert.equal(tool?.id, "history-0-tool-0");

  const failed = projectConversation(
    [
      history[0],
      { role: "toolResult", toolCallId: "paged-call", toolName: "read", content: [], isError: true },
      { role: "toolResult", toolCallId: "paged-call", toolName: "read", content: [], isError: false },
    ],
    { start: 0, end: 1, includeDelegated: false, limitMessages: false },
  );
  assert.equal(failed.messages.find(message => message.tool?.id === "paged-call")?.tool?.status, "failed");
});

test("existing-session projection keeps the complete latest user turn", () => {
  const history = [
    ...Array.from({ length: 30 }, (_, index) => ({ role: "assistant", content: `old ${index}` })),
    { role: "user", content: "Run every check" },
    ...Array.from({ length: 60 }, (_, index) => [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.ts` } }],
      },
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${index}` }],
      },
    ]).flat(),
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-running", name: "bash", arguments: { command: "npm test" } }],
    },
  ];
  const tailStart = history.length - 100;
  const historyStart = Math.min(tailStart, latestVisibleUserIndex(history) ?? tailStart);
  const projected = projectConversation(history, { start: historyStart, limitMessages: false });

  assert.equal(historyStart, 30);
  assert.equal(projected.messages[0]?.role, "user");
  assert.equal(projected.messages[0]?.text, "Run every check");
  const tools = projected.messages.filter(message => message.role === "tool");
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
  assert.equal(
    projectMessages([{ role: "user", content: "Bad timestamp", timestamp: 1e100 }])[0]?.createdAt,
    undefined,
  );

  const initial = runtime();
  initial.conversation.messages = [{ id: "assistant-1", role: "assistant", text: "Done", streaming: false }];
  const projection = new RuntimeProjection(initial, () => undefined);
  projection.apply(
    session({
      type: "worktree_summary",
      messageId: "assistant-1",
      files: [
        { path: "invalid.ts", additions: -1, deletions: 2 },
        { path: "valid.ts", additions: 3, deletions: 1 },
      ],
    }),
  );
  assert.deepEqual(projection.snapshot().conversation.messages[0]?.changedFiles, [
    { path: "valid.ts", additions: 3, deletions: 1 },
  ]);
});

test("Timeline undo availability is published without exposing Pi entry IDs", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const initial = runtime();
  initial.conversation.messages = [
    { id: "message-1", entryId: "entry-1", role: "user", text: "Prompt", streaming: false },
  ];
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "prompt_undo", entryIds: ["entry-1"] }));
  assert.equal(projection.snapshot().conversation.messages[0]?.canUndo, true);
  const event = published.find(item => item.type === "message.undo");
  assert.deepEqual(event?.payload, { items: [{ id: "message-1", canUndo: true, canForkWithTimeline: false }] });
  assert.doesNotMatch(JSON.stringify(event), /entry-1/);
});

test("history projection retains complete delegated activity with bounded event text", () => {
  const activity = Array.from({ length: 105 }, (_, index) => ({
    kind: index % 2 ? "result" : "call",
    tool: "read",
    text: "x".repeat(2_100),
  }));
  const projected = projectConversation([
    { role: "user", content: "Inspect the repository" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "scout-1",
          name: "repo_scout",
          arguments: { task: "Map the runtime", apiToken: "hidden" },
        },
      ],
    },
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
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "other", name: "read", arguments: { path: "src/app.ts" } }],
    },
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
    activity: activity.map(item => ({ ...item, text: item.text.slice(0, 2_000) })),
  });
  assert.doesNotMatch(projected.delegatedRuns[0]?.request ?? "", /hidden|apiToken/);
});

test("live delegated activity appends correlated deltas without replacing prior events", () => {
  const published: Array<{ type: string; payload: any }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-live",
      toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect everything" },
    }),
  );
  for (let index = 0; index < 125; index++) {
    for (const kind of ["call", "result"] as const) {
      projection.apply(
        session({
          type: "tool_execution_update",
          toolCallId: "spawn-live",
          toolName: "spawn_agent",
          partialResult: {
            details: {
              state: "running",
              activityDelta: [
                {
                  id: `child-${index}`,
                  kind,
                  tool: "read",
                  text: String(index),
                  ...(kind === "call" ? { startedAt: "2026-01-01T00:00:00.000Z" } : { durationMs: index * 10 }),
                },
              ],
            },
          },
        }),
      );
    }
  }
  const activity = projection.snapshot().conversation.delegatedRuns[0]?.activity ?? [];
  assert.equal(activity.length, 250);
  assert.deepEqual(activity.slice(-2), [
    { id: "child-124", kind: "call", tool: "read", text: "124", startedAt: "2026-01-01T00:00:00.000Z" },
    { id: "child-124", kind: "result", tool: "read", text: "124", durationMs: 1_240 },
  ]);
  const updates = published.filter(event => event.type === "delegate.update").slice(1);
  assert.equal(updates.length, 250);
  assert.ok(
    updates.every(
      (event, index) =>
        event.payload.activityMode === "append" &&
        event.payload.activityBase === index &&
        event.payload.activity.length === 1,
    ),
  );
  assert.ok(updates.every(event => Buffer.byteLength(JSON.stringify(event)) < 64 * 1024));
});

test("pi-spawn executions expose stable child metadata and ignore list actions", () => {
  const projected = projectConversation([
    { role: "user", content: "Delegate the investigation" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "spawn-create",
          name: "spawn_agent",
          arguments: { action: "create", prompt: "Inspect auth" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-create",
      toolName: "spawn_agent",
      isError: false,
      content: [{ type: "text", text: "First report" }],
      details: {
        piSpawn: { version: 1, kind: "agent", id: "child-agent" },
        agentName: "Agent-child",
        status: "completed",
        model: "provider/child",
        durationMs: 20,
        usage: { input: 3, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
        sessionUsage: { input: 30, output: 15, cacheRead: 10, cacheWrite: 0, cost: 0.2 },
        activity: [{ kind: "call", tool: "read", text: '{"path":"auth.ts"}' }],
      },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "spawn-continue",
          name: "spawn_agent",
          arguments: { action: "continue", id: "child-agent", prompt: "Go deeper" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-continue",
      toolName: "spawn_agent",
      isError: false,
      content: [{ type: "text", text: "Second report" }],
      details: { piSpawn: { version: 1, kind: "agent", id: "child-agent" }, status: "completed", activity: [] },
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "spawn-list", name: "spawn_agent", arguments: { action: "list" } }],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-list",
      toolName: "spawn_agent",
      isError: false,
      content: [{ type: "text", text: "child-agent" }],
      details: { threads: [] },
    },
  ]);

  assert.equal(projected.delegatedRuns.length, 2);
  assert.deepEqual(
    projected.delegatedRuns.map(({ id, action, threadId, request, response }) => ({
      id,
      action,
      threadId,
      request,
      response,
    })),
    [
      {
        id: "spawn-create",
        action: "create",
        threadId: "child-agent",
        request: "Inspect auth",
        response: "First report",
      },
      {
        id: "spawn-continue",
        action: "continue",
        threadId: "child-agent",
        request: "Go deeper",
        response: "Second report",
      },
    ],
  );
  assert.equal(agentColorId(projected.delegatedRuns[0]!), agentColorId(projected.delegatedRuns[1]!));
  assert.deepEqual(projected.delegatedRuns[0]?.usage, { input: 3, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.02 });
  assert.deepEqual(projected.delegatedRuns[0]?.sessionUsage, {
    input: 30,
    output: 15,
    cacheRead: 10,
    cacheWrite: 0,
    cost: 0.2,
  });
  assert.deepEqual(projected.delegatedRuns[0]?.activity, [
    { kind: "call", tool: "read", text: '{\n  "path": "auth.ts"\n}' },
  ]);
});

test("background pi-spawn controls update the original delegated run without duplicates", () => {
  const projection = new RuntimeProjection(runtime(), () => undefined);
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-start",
      toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect auth", background: true },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "spawn-start",
      toolName: "spawn_agent",
      isError: false,
      result: {
        content: [{ type: "text", text: "Started" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-agent" },
          runId: "run-1",
          background: true,
          agentName: "Ada",
          startedAt: "2026-07-30T10:00:00.000Z",
          status: "running",
        },
      },
    }),
  );
  assert.deepEqual(
    projection
      .snapshot()
      .conversation.delegatedRuns.map(({ id, status, runId, threadId, response, usage }) => ({
        id,
        status,
        runId,
        threadId,
        response,
        usage,
      })),
    [
      {
        id: "spawn-start",
        status: "running",
        runId: "run-1",
        threadId: "child-agent",
        response: undefined,
        usage: undefined,
      },
    ],
  );

  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-status",
      toolName: "spawn_agent",
      args: { action: "status", id: "child-agent", runId: "run-1" },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "spawn-status",
      toolName: "spawn_agent",
      isError: false,
      result: {
        content: [{ type: "text", text: "Done" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-agent" },
          runId: "run-1",
          background: true,
          startedAt: "2026-07-30T10:00:00.000Z",
          status: "completed",
          durationMs: 2_000,
          usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
          sessionUsage: { input: 40, output: 60, cacheRead: 10, cacheWrite: 0, cost: 0.2 },
          activity: [{ kind: "result", tool: "read", text: "source" }],
        },
      },
    }),
  );
  const [completed] = projection.snapshot().conversation.delegatedRuns;
  assert.equal(projection.snapshot().conversation.delegatedRuns.length, 1);
  assert.deepEqual(
    {
      id: completed?.id,
      status: completed?.status,
      response: completed?.response,
      durationMs: completed?.durationMs,
      output: completed?.usage?.output,
      sessionOutput: completed?.sessionUsage?.output,
      activity: completed?.activity.length,
    },
    {
      id: "spawn-start",
      status: "completed",
      response: "Done",
      durationMs: 2_000,
      output: 6,
      sessionOutput: 60,
      activity: 1,
    },
  );

  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-stale",
      toolName: "spawn_agent",
      args: { action: "status", id: "child-agent", runId: "run-1" },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "spawn-stale",
      toolName: "spawn_agent",
      isError: false,
      result: {
        content: [{ type: "text", text: "Result already collected" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-agent" },
          runId: "run-1",
          background: true,
          failureCode: "not_found",
        },
      },
    }),
  );
  const [retained] = projection.snapshot().conversation.delegatedRuns;
  assert.equal(projection.snapshot().conversation.delegatedRuns.length, 1);
  assert.deepEqual(
    {
      status: retained?.status,
      response: retained?.response,
      output: retained?.usage?.output,
      activity: retained?.activity.length,
    },
    { status: "completed", response: "Done", output: 6, activity: 1 },
  );
});

test("background spawn progress updates one delegated run through completion", () => {
  const projection = new RuntimeProjection(runtime(), () => undefined);
  const marker = { version: 1, kind: "session", id: "child-session", path: "/sessions/child.jsonl", cwd: "/repo" };
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-start",
      toolName: "spawn_session",
      args: { action: "create", prompt: "Inspect auth", background: true },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "spawn-start",
      toolName: "spawn_session",
      result: {
        content: [{ type: "text", text: "Started" }],
        details: {
          piSpawn: marker,
          runId: "run-1",
          background: true,
          status: "running",
          state: "running",
          startedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    }),
  );
  projection.apply(
    session({
      type: "spawn_progress",
      phase: "update",
      toolCallId: "spawn-start",
      toolName: "spawn_session",
      result: {
        content: [],
        details: {
          piSpawn: marker,
          runId: "run-1",
          background: true,
          status: "running",
          state: "running",
          startedAt: "2026-08-01T10:00:00.000Z",
          partialResponse: "Checking auth…",
          usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
          activityDelta: [{ id: "read-1", kind: "call", tool: "read", text: '{"path":"auth.ts"}' }],
        },
      },
    }),
  );
  let [run] = projection.snapshot().conversation.delegatedRuns;
  assert.deepEqual(
    {
      id: run?.id,
      status: run?.status,
      response: run?.response,
      output: run?.usage?.output,
      activity: run?.activity.length,
    },
    { id: "spawn-start", status: "running", response: "Checking auth…", output: 3, activity: 1 },
  );

  projection.apply(
    session({
      type: "spawn_progress",
      phase: "end",
      toolCallId: "spawn-start",
      toolName: "spawn_session",
      result: {
        content: [{ type: "text", text: "Done" }],
        details: {
          piSpawn: marker,
          runId: "run-1",
          background: true,
          status: "completed",
          usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
          sessionUsage: { input: 40, output: 60, cacheRead: 10, cacheWrite: 0, cost: 0.2 },
          activity: [
            { id: "read-1", kind: "call", tool: "read", text: "{}" },
            { id: "read-1", kind: "result", tool: "read", text: "source" },
          ],
        },
      },
    }),
  );
  [run] = projection.snapshot().conversation.delegatedRuns;
  assert.equal(projection.snapshot().conversation.delegatedRuns.length, 1);
  assert.deepEqual(
    {
      status: run?.status,
      response: run?.response,
      output: run?.usage?.output,
      sessionOutput: run?.sessionUsage?.output,
      activity: run?.activity.length,
    },
    { status: "completed", response: "Done", output: 6, sessionOutput: 60, activity: 2 },
  );
});

test("history correlates background pi-spawn status results by run ID", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "spawn-start",
          name: "spawn_session",
          arguments: { action: "create", prompt: "Check build", background: true },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-start",
      toolName: "spawn_session",
      isError: false,
      content: [{ type: "text", text: "Started" }],
      details: {
        piSpawn: { version: 1, kind: "session", id: "child-session" },
        runId: "run-2",
        background: true,
        startedAt: "2026-07-30T10:00:00.000Z",
        status: "running",
      },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "spawn-status",
          name: "spawn_session",
          arguments: { action: "status", id: "child-session", runId: "run-2" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-status",
      toolName: "spawn_session",
      isError: false,
      content: [{ type: "text", text: "Finished" }],
      details: {
        piSpawn: { version: 1, kind: "session", id: "child-session" },
        runId: "run-2",
        background: true,
        startedAt: "2026-07-30T10:00:00.000Z",
        status: "completed",
        durationMs: 3_000,
        usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
        activity: [],
      },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "spawn-stale",
          name: "spawn_session",
          arguments: { action: "status", id: "child-session", runId: "run-2" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "spawn-stale",
      toolName: "spawn_session",
      isError: false,
      content: [{ type: "text", text: "Result already collected" }],
      details: {
        piSpawn: { version: 1, kind: "session", id: "child-session" },
        runId: "run-2",
        background: true,
        failureCode: "not_found",
      },
    },
  ];
  const [run] = projectConversation(messages).delegatedRuns;
  assert.equal(projectConversation(messages).delegatedRuns.length, 1);
  assert.deepEqual(
    {
      id: run?.id,
      status: run?.status,
      runId: run?.runId,
      response: run?.response,
      durationMs: run?.durationMs,
      output: run?.usage?.output,
    },
    { id: "spawn-start", status: "completed", runId: "run-2", response: "Finished", durationMs: 3_000, output: 7 },
  );
});

test("invalid pi-spawn actions remain ordinary tools", () => {
  const projected = projectConversation([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "agent-adopt",
          name: "spawn_agent",
          arguments: { action: "adopt", id: "child", prompt: "No" },
        },
        { type: "toolCall", id: "session-list", name: "spawn_session", arguments: { action: "list" } },
        {
          type: "toolCall",
          id: "session-unknown",
          name: "spawn_session",
          arguments: { action: "unknown", prompt: "No" },
        },
      ],
    },
  ]);
  assert.deepEqual(projected.delegatedRuns, []);

  const live = new RuntimeProjection(runtime(), () => undefined);
  live.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "agent-list",
      toolName: "spawn_agent",
      args: { action: "list" },
    }),
  );
  live.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "session-list",
      toolName: "spawn_session",
      args: { action: "list" },
    }),
  );
  assert.deepEqual(live.snapshot().conversation.delegatedRuns, []);
});

test("live spawn-session adoption gains its authorized child ID from updates", () => {
  const projection = new RuntimeProjection(runtime(), () => undefined);
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "spawn-adopt",
      toolName: "spawn_session",
      args: { action: "adopt", id: "requested-session", prompt: "Resume this" },
    }),
  );
  assert.deepEqual(projection.snapshot().conversation.delegatedRuns[0], {
    id: "spawn-adopt",
    kind: "spawn_session",
    turn: 0,
    request: "Resume this",
    status: "running",
    action: "adopt",
    activity: [],
  });

  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "spawn-adopt",
      toolName: "spawn_session",
      partialResult: {
        content: [],
        details: { piSpawn: { version: 2, kind: "agent", id: "untrusted-session" }, state: "running" },
      },
    }),
  );
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.threadId, undefined);

  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "spawn-adopt",
      toolName: "spawn_session",
      partialResult: {
        content: [{ type: "text", text: "Session is working" }],
        details: {
          piSpawn: { version: 1, kind: "session", id: "existing-session" },
          state: "running",
          activity: [{ kind: "call", tool: "read", text: '{"path":"README.md"}' }],
        },
      },
    }),
  );
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.threadId, "existing-session");
  assert.notEqual(projection.snapshot().conversation.delegatedRuns[0]?.threadId, "requested-session");
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.response, undefined);

  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "spawn-adopt",
      toolName: "spawn_session",
      isError: false,
      result: {
        content: [{ type: "text", text: "Resumed" }],
        details: {
          piSpawn: { version: 1, kind: "session", id: "existing-session" },
          status: "completed",
          model: "provider/child",
          durationMs: 50,
          usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          activity: [{ kind: "call", tool: "read", text: "{}" }],
        },
      },
    }),
  );
  const completed = projection.snapshot().conversation.delegatedRuns[0];
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.threadId, "existing-session");
  assert.equal(completed?.response, "Resumed");
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

test("projection suppresses duration-only delegated heartbeats", () => {
  const published: Array<{ type: string; payload: any }> = [];
  const initial = runtime();
  initial.metrics.userMessages = 2;
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  projection.apply(
    session({ type: "tool_execution_start", toolCallId: "grunt-1", toolName: "grunt", args: { task: "Apply edits" } }),
  );
  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "grunt-1",
      toolName: "grunt",
      args: { task: "Apply edits" },
      partialResult: {
        content: [{ type: "text", text: "Worker activity:\nread a.ts" }],
        details: {
          state: "running",
          model: "provider/grunt",
          thinking: "medium",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          activity: [{ kind: "call", tool: "read", text: '{"path":"a.ts","password":"hidden"}' }],
        },
      },
    }),
  );
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.response, undefined);
  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "grunt-1",
      toolName: "grunt",
      partialResult: { content: [{ type: "text", text: "1s" }], details: { state: "running", durationMs: 1_000 } },
    }),
  );
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.durationMs, 1_000);
  assert.deepEqual(projection.snapshot().conversation.delegatedRuns[0]?.usage, {
    input: 2,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.01,
  });
  assert.equal(published.filter(event => event.type === "delegate.update").length, 2);
  projection.apply(
    session({
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
            { kind: "call", tool: "read", text: '{"path":"a.ts","password":"hidden"}' },
            { kind: "result", tool: "read", text: "token=hidden source" },
          ],
        },
      },
      isError: false,
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "grunt-1",
      toolName: "grunt",
      partialResult: {
        content: [{ type: "text", text: "Worker activity:\nlate update" }],
        details: {
          state: "running",
          activity: [
            { kind: "call", tool: "read", text: '{"path":"a.ts","password":"hidden"}' },
            { kind: "result", tool: "read", text: "token=hidden source" },
            { kind: "call", tool: "edit", text: '{"path":"a.ts"}' },
          ],
        },
      },
    }),
  );
  const updates = published.filter(event => event.type === "delegate.update");
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
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "scout-live",
      toolName: "repo_scout",
      args: { task: "Trace the runtime" },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "scout-live",
      toolName: "repo_scout",
      partialResult: {
        content: [{ type: "text", text: "Scout child activity:\nread src/app.ts" }],
        details: { state: "running", activity: [{ kind: "call", tool: "read", text: '{"path":"src/app.ts"}' }] },
      },
    }),
  );
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.response, undefined);
  projection.apply(
    session({
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
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_end",
      toolCallId: "scout-live",
      toolName: "repo_scout",
      result: {
        content: [{ type: "text", text: "Scout report" }],
        details: { model: "provider/scout", durationMs: 900 },
      },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_update",
      toolCallId: "scout-live",
      toolName: "repo_scout",
      partialResult: {
        content: [{ type: "text", text: "Scout child activity:\nlate update" }],
        details: {
          state: "running",
          activity: [
            { kind: "call", tool: "read", text: '{"path":"src/app.ts"}' },
            { kind: "result", tool: "read", text: "export const app = true;" },
          ],
        },
      },
    }),
  );
  projection.apply(
    session({
      type: "tool_execution_start",
      toolCallId: "scout-failed",
      toolName: "repo_scout",
      args: { task: "Inspect missing credentials" },
    }),
  );
  projection.apply(
    session({
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
    }),
  );

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

  projection.apply(
    session({
      type: "agent_start",
      turnId: "turn-1",
      workStartedAt: startedAt,
      modelName: "GPT-5",
      thinkingLevel: "high",
      metrics: { userMessages: 1 },
    }),
  );
  projection.apply(
    session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  projection.apply(
    session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  projection.apply(
    session({
      type: "agent_end",
      turnId: "turn-1",
      workDurationMs: 1_234,
      modelName: "GPT-5",
      thinkingLevel: "high",
      gitBranch: "main",
      turnGitBranch: "feature/turn-branches",
      metrics: { userMessages: 1, cost: 0.25 },
      assistantMessage: {
        id: "history-2",
        entryId: "assistant-entry",
        role: "assistant",
        text: "Done",
        streaming: false,
      },
    }),
  );
  projection.apply(
    session({
      type: "worktree_summary",
      turnId: "turn-1",
      messageId: "history-999",
      files: [{ path: "src/app.ts", additions: 4, deletions: 2, binary: false }],
    }),
  );
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
  assert.equal(snapshot.conversation.messages.at(-1)?.gitBranch, "feature/turn-branches");
  assert.deepEqual(snapshot.conversation.messages.at(-1)?.changedFiles, [
    { path: "src/app.ts", additions: 4, deletions: 2 },
  ]);
  assert.deepEqual(
    published.filter(event => event.type === "session.info").map(event => event.payload),
    [{ sessionId: "session", name: "Renamed by timeline" }],
  );
  assert.equal(
    (published.find(event => event.type === "agent.start")?.payload as { startedAt: string }).startedAt,
    startedAt,
  );
  assert.equal(
    (published.find(event => event.type === "agent.end")?.payload as { durationMs: number }).durationMs,
    1_234,
  );
  assert.equal(
    (published.find(event => event.type === "agent.end")?.payload as { turnGitBranch: string }).turnGitBranch,
    "feature/turn-branches",
  );
  assert.ok(published.some(event => event.type === "turn.changes"));
});

test("agent completion restores an assistant lost during session selection", () => {
  const initial = runtime();
  initial.conversation.streaming = true;
  initial.conversation.messages = [
    {
      id: "history-1",
      entryId: "earlier-assistant",
      role: "assistant",
      text: "Completed while switching sessions",
      streaming: false,
    },
  ];
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));

  projection.apply(
    session({
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
    }),
  );

  const messages = projection.snapshot().conversation.messages;
  assert.deepEqual(
    messages.map(message => message.id),
    ["history-1", "history-3"],
  );
  assert.equal(messages.at(-1)?.entryId, "final-assistant");
  assert.equal(messages.at(-1)?.workDurationMs, 1_234);
  assert.equal(projection.snapshot().conversation.streaming, false);
  assert.deepEqual(
    published.filter(event => event.type.startsWith("message.")).map(event => event.type),
    ["message.start", "message.end"],
  );
  const completion = published.at(-1)?.payload as {
    messageId?: string;
    assistantMessage?: { entryId?: string; text?: string };
  };
  assert.equal(completion.messageId, "history-3");
  assert.equal(completion.assistantMessage?.entryId, "final-assistant");
  assert.equal(completion.assistantMessage?.text, "Completed while switching sessions");
});

test("authoritative refresh repairs a terminal assistant omitted from live events", () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), type => published.push(type));
  const fresh = runtime();
  fresh.conversation.messages = [
    {
      id: "history-2",
      entryId: "final-assistant",
      role: "assistant",
      text: "Recovered from snapshot",
      streaming: false,
    },
  ];

  projection.refresh(fresh);

  assert.equal(projection.snapshot().conversation.messages[0]?.text, "Recovered from snapshot");
  assert.deepEqual(
    published.filter(type => type.startsWith("message.")),
    ["message.start", "message.end"],
  );
});

test("authoritative refresh settles delegated runs missed during session switching", () => {
  const initial = runtime();
  initial.conversation.delegatedRuns = [
    {
      id: "spawn-1",
      kind: "spawn_agent",
      turn: 1,
      request: "Inspect auth",
      status: "running",
      agentName: "Ada",
      startedAt: "2026-07-27T01:02:03.000Z",
      modelName: "provider/child",
      activity: [
        { kind: "call", tool: "read", text: "auth.ts" },
        { kind: "result", tool: "read", text: "source" },
      ],
    },
  ];
  const published: Array<{ type: string; payload: any }> = [];
  const projection = new RuntimeProjection(initial, (type, payload) => published.push({ type, payload }));
  const completed = runtime();
  completed.conversation.delegatedRuns = [
    {
      id: "spawn-1",
      kind: "spawn_agent",
      turn: 1,
      request: "Inspect auth",
      response: "Done",
      status: "completed",
      durationMs: 1_250,
      sessionUsage: { input: 30, output: 15, cacheRead: 10, cacheWrite: 0, cost: 0.2 },
      activity: [{ kind: "call", tool: "read", text: "auth.ts" }],
    },
  ];

  projection.refresh(completed);

  const run = projection.snapshot().conversation.delegatedRuns[0];
  assert.equal(run?.status, "completed");
  assert.equal(run?.response, "Done");
  assert.equal(run?.agentName, "Ada");
  assert.equal(run?.modelName, "provider/child");
  assert.deepEqual(run?.sessionUsage, { input: 30, output: 15, cacheRead: 10, cacheWrite: 0, cost: 0.2 });
  assert.equal(run?.activity.length, 2);
  assert.deepEqual(
    published
      .filter(event => event.type === "delegate.update")
      .map(event => ({ id: event.payload.id, status: event.payload.status })),
    [{ id: "spawn-1", status: "completed" }],
  );

  projection.refresh(initial);
  assert.equal(projection.snapshot().conversation.delegatedRuns[0]?.status, "completed");
  assert.equal(published.filter(event => event.type === "delegate.update").length, 1);
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
  const live = new RuntimeProjection(runtime(), type => liveEvents.push(type));
  live.apply(session({ type: "agent_start", turnId: "turn-live" }));
  live.apply(
    session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  live.apply(
    session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  live.apply(session({ type: "agent_end", turnId: "turn-live", assistantMessage: canonical }));
  assert.equal(live.snapshot().conversation.messages.length, 1);
  assert.equal(live.snapshot().conversation.messages[0]?.entryId, "final-assistant");
  assert.deepEqual(
    liveEvents.filter(type => type.startsWith("message.")),
    ["message.start", "message.end"],
  );

  const loaded = runtime();
  loaded.conversation.messages = [canonical];
  const loadedEvents: string[] = [];
  const snapshotted = new RuntimeProjection(loaded, type => loadedEvents.push(type));
  snapshotted.apply(session({ type: "agent_end", turnId: "turn-loaded", assistantMessage: canonical }));
  assert.equal(snapshotted.snapshot().conversation.messages.length, 1);
  assert.deepEqual(
    loadedEvents.filter(type => type.startsWith("message.")),
    [],
  );

  const malformedRuntime = runtime();
  malformedRuntime.conversation.messages = [
    { id: "older-assistant", role: "assistant", text: "Earlier turn", streaming: false },
  ];
  const malformed = new RuntimeProjection(malformedRuntime, () => undefined);
  malformed.apply(
    session({
      type: "agent_end",
      turnId: "turn-malformed",
      workDurationMs: 500,
      assistantMessage: { role: "assistant" },
    }),
  );
  assert.equal(malformed.snapshot().conversation.messages[0]?.workDurationMs, undefined);
});

test("agent completion flushes pending text before its terminal event", () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), type => published.push(type));
  projection.apply(session({ type: "agent_start", turnId: "turn-pending" }));
  projection.apply(
    session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  projection.apply(
    session({
      type: "agent_end",
      turnId: "turn-pending",
      assistantMessage: {
        id: "history-2",
        entryId: "final-assistant",
        role: "assistant",
        text: "Done",
        streaming: false,
      },
    }),
  );
  assert.equal(projection.snapshot().conversation.messages.length, 1);
  assert.deepEqual(published.slice(-3), ["message.update", "message.end", "agent.end"]);
});

test("projection keeps one active timer across retry attempts", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  const originalStart = "2026-01-01T00:00:00.000Z";

  projection.apply(
    session({ type: "agent_start", turnId: "turn-1", workStartedAt: originalStart, modelName: "GPT-5" }),
  );
  projection.apply(
    session({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "Temporary failure" }] },
    }),
  );
  projection.apply(
    session({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Temporary failure" }] },
    }),
  );
  projection.apply(session({ type: "agent_end", turnId: "turn-1", workDurationMs: 1_000, willRetry: true }));

  assert.equal(projection.snapshot().conversation.workStartedAt, originalStart);
  assert.equal(projection.snapshot().conversation.messages.at(-1)?.workDurationMs, undefined);

  projection.apply(
    session({ type: "agent_start", turnId: "turn-1", workStartedAt: "2026-01-01T00:00:10.000Z", modelName: "GPT-5" }),
  );
  assert.equal(projection.snapshot().conversation.workStartedAt, originalStart);

  projection.apply(
    session({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  projection.apply(
    session({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  );
  projection.apply(
    session({
      type: "agent_end",
      turnId: "turn-1",
      workDurationMs: 12_000,
      willRetry: false,
      assistantMessage: { id: "history-4", entryId: "final-retry", role: "assistant", text: "Done", streaming: false },
    }),
  );

  assert.equal(projection.snapshot().conversation.workStartedAt, undefined);
  assert.equal(projection.snapshot().conversation.messages.at(-1)?.workDurationMs, 12_000);

  projection.apply(session({ type: "agent_start", turnId: "turn-2", workStartedAt: originalStart }));
  projection.apply(
    session({ type: "agent_end", turnId: "turn-2", workDurationMs: 500, willRetry: true, stopped: true }),
  );
  assert.equal(projection.snapshot().conversation.workStartedAt, undefined);
  assert.equal((published.at(-1)?.payload as { willRetry?: boolean }).willRetry, false);
});

test("projection persists terminal agent errors and clears them for retries and new runs", () => {
  const published: Array<{ type: string; payload: unknown }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));

  projection.apply(session({ type: "agent_start", turnId: "turn-error" }));
  projection.apply(
    session({ type: "agent_end", turnId: "turn-error", errorMessage: "provider rejected request", willRetry: false }),
  );

  assert.equal(projection.snapshot().conversation.agentError, "provider rejected request");
  assert.equal(
    ([...published].reverse().find(event => event.type === "agent.end")?.payload as { message?: string }).message,
    "provider rejected request",
  );

  projection.apply(session({ type: "agent_start", turnId: "turn-retry" }));
  assert.equal(projection.snapshot().conversation.agentError, undefined);
  projection.apply(
    session({ type: "agent_end", turnId: "turn-retry", errorMessage: "temporary failure", willRetry: true }),
  );
  assert.equal(projection.snapshot().conversation.agentError, undefined);
});

test("terminal agent events settle residual tool and delegated activity", () => {
  const initial = runtime();
  initial.conversation.messages = [
    {
      id: "live-tool-call",
      role: "tool",
      text: "",
      streaming: true,
      tool: { id: "call", name: "bash", status: "running" },
    },
  ];
  initial.conversation.tools = [
    { id: "call", name: "bash", status: "running" },
    { id: "done", name: "read", status: "completed" },
  ];
  initial.conversation.delegatedRuns = [{ id: "delegate", kind: "advisor", turn: 1, status: "running", activity: [] }];

  const stopped = new RuntimeProjection(initial, () => undefined);
  stopped.apply(session({ type: "agent_end", turnId: "turn-stopped", stopped: true }));
  const stoppedConversation = stopped.snapshot().conversation;
  assert.equal(stoppedConversation.messages[0]?.tool?.status, "completed");
  assert.equal(stoppedConversation.messages[0]?.streaming, false);
  assert.deepEqual(
    stoppedConversation.tools.map(tool => tool.status),
    ["completed", "completed"],
  );
  assert.equal(stoppedConversation.delegatedRuns[0]?.status, "completed");

  const errored = new RuntimeProjection(initial, () => undefined);
  errored.apply(session({ type: "agent_error", turnId: "turn-error", willRetry: true }));
  const errorConversation = errored.snapshot().conversation;
  assert.equal(errorConversation.messages[0]?.tool?.status, "failed");
  assert.deepEqual(
    errorConversation.tools.map(tool => tool.status),
    ["failed", "completed"],
  );
  assert.equal(errorConversation.delegatedRuns[0]?.status, "failed");
});

test("projection retains stopped tool-only run metadata without an assistant message", () => {
  const initial = runtime();
  initial.conversation.messages = [
    { id: "older-assistant", role: "assistant", text: "Earlier turn", streaming: false },
  ];
  const projection = new RuntimeProjection(initial, () => undefined);
  projection.apply(
    session({
      type: "agent_start",
      turnId: "turn-stopped",
      workStartedAt: new Date().toISOString(),
      modelName: "GPT-5",
      thinkingLevel: "medium",
    }),
  );
  projection.apply(
    session({
      type: "agent_end",
      turnId: "turn-stopped",
      userEntryId: "user-entry",
      workDurationMs: 500,
      modelName: "GPT-5",
      thinkingLevel: "medium",
      stopped: true,
      assistantMessage: null,
    }),
  );
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
  const projection = new RuntimeProjection(runtime(), type => published.push(type));
  projection.apply(
    session({
      type: "discover_index",
      value: { state: "idle", files: 1_200, symbols: 3_400, indexedAt: new Date(0).toISOString() },
    }),
  );
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
  const projection = new RuntimeProjection(runtime(), type => published.push(type));
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

test("projection coalesces cumulative stream updates on a readable cadence", async () => {
  const published: Array<{ type: string; payload: any }> = [];
  const projection = new RuntimeProjection(runtime(), (type, payload) => published.push({ type, payload }));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [] } }));
  projection.apply(session({ type: "message_update", delta: "one" }));
  projection.apply(session({ type: "message_update", delta: " two" }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(
    published.map(item => item.type),
    ["message.start"],
  );
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(
    published.map(item => item.type),
    ["message.start", "message.update"],
  );
  assert.deepEqual(published.at(-1)?.payload, { id: "message-1", text: "one two" });
  projection.dispose();
});

test("projection disposal cancels delayed stream publication", async () => {
  const published: string[] = [];
  const projection = new RuntimeProjection(runtime(), type => published.push(type));
  projection.apply(session({ type: "message_start", message: { role: "assistant", content: [] } }));
  projection.apply(
    session({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }),
  );
  projection.dispose();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(published, ["message.start"]);
});

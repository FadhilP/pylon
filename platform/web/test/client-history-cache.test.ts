import test from "node:test";
import assert from "node:assert/strict";
import { hasCompleteHistory, mergeHistoryMessages, restoreCachedHistory } from "../src/shared/history-cache.ts";
import type { MessageReadModel } from "../src/shared/protocol/events.ts";
import type { RuntimeSnapshot } from "../src/shared/protocol/snapshots.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";

function messages(start: number, end: number): MessageReadModel[] {
  return Array.from({ length: end - start }, (_, offset) => ({
    id: `history-${start + offset}`,
    role: "user",
    text: String(start + offset),
    streaming: false,
  }));
}

function runtime(history: MessageReadModel[], cursor?: string, remaining?: number): RuntimeSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "session-one",
    sessionGeneration: 2,
    ready: true,
    cwdLabel: "project",
    activeTools: [],
    availableTools: [],
    optionalCapabilities: {},
    diagnostics: [],
    conversation: {
      messages: history,
      tools: [],
      delegatedRuns: [],
      ...(cursor ? { historyCursor: cursor, historyRemaining: remaining } : {}),
      streaming: false,
      queue: { steering: 0, followUp: 0 },
      retry: { active: false },
      compaction: { active: false },
    },
    sessionControls: { models: [], thinkingLevels: [], commands: [] },
  runtimePolicy: { revision: 1, global: { timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, project: { verify: { mode: "auto" }, timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, session: {}, effective: { verify: { mode: "auto" }, timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, availableVerifyChecks: [] },
    metrics: {
      model: "none", provider: "none", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      contextTokens: 0, contextLimit: 0, contextPercent: 0, cost: 0,
      userMessages: 0, assistantMessages: 0, toolCalls: 0,
    },
    operational: initialOperational([], []),
    extensionUi: { notifications: [], statuses: [], widgets: [], editorRevision: 0, editorText: "" },
  };
}

test("cached session history survives replacement and preserves safe paging", () => {
  const restored = restoreCachedHistory(runtime(messages(100, 200), "fresh", 100), {
    messages: [...messages(0, 200), { id: "stream-1", role: "assistant", text: "stale", streaming: false }],
    historyCursor: undefined,
    historyRemaining: undefined,
  });
  assert.equal(restored.conversation.messages.length, 200);
  assert.equal(restored.conversation.messages.some((message) => message.id === "stream-1"), false);
  assert.equal(restored.conversation.historyCursor, undefined);

  const gap = restoreCachedHistory(runtime(messages(300, 400), "fresh", 300), {
    messages: messages(0, 200),
    historyCursor: undefined,
    historyRemaining: undefined,
  });
  assert.deepEqual(gap.conversation.messages.map((message) => message.id).slice(-2), ["history-398", "history-399"]);
  assert.equal(gap.conversation.historyCursor, "fresh");
  assert.equal(gap.conversation.historyRemaining, 300);
  const filled = mergeHistoryMessages(gap.conversation.messages, messages(200, 300));
  assert.equal(hasCompleteHistory(filled), true);
  assert.deepEqual(filled.slice(198, 202).map((message) => message.id), [
    "history-198", "history-199", "history-200", "history-201",
  ]);

  const rewound = restoreCachedHistory(runtime(messages(0, 50)), {
    messages: messages(0, 200),
    historyCursor: undefined,
    historyRemaining: undefined,
  });
  assert.equal(rewound.conversation.messages.length, 50);
});

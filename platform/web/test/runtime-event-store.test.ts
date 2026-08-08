import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcilePendingQueue, type PendingMessageReadModel } from "../src/shared/pending-messages.ts";

test("expected session replacement clears stale runtime while staying loading", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /event\.type === "session\.replaced"[\s\S]*?this\.reset\("loading", true\)/);
  assert.match(source, /runtime: clearRuntime \|\| !this\.snapshot\.runtime \? undefined : \{ \.\.\.this\.snapshot\.runtime, ready: false \}/);
  assert.match(source, /historyWindow: clearRuntime \? undefined : this\.snapshot\.historyWindow/);
  assert.match(source, /const connection = this\.snapshot\.connection === "loading" \? "loading" : "disconnected"/);
  assert.match(source, /event\.type === "session\.unavailable"[\s\S]*?this\.reset\(\)/);
  assert.match(source, /source\.onerror = \(\) => \{[\s\S]*?connection: "disconnected"/);
});

test("Continuity plan review stays in the runtime dialog rather than Inspector Overview", async () => {
  const store = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  const inspector = await readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8");

  assert.match(store, /async continuityPlanAction[\s\S]*?type: "continuityPlanAction"[\s\S]*?expectedRevision/);
  assert.doesNotMatch(inspector, /PlanReview|Approve & reset context|Keep current context|Request changes/);
  assert.match(inspector, /title="Task List"[\s\S]*?work\.latestFailure[\s\S]*?work\.nextAction[\s\S]*?<TodoList work=\{work\}/);
});

test("switching sessions drops history cached for a potentially different branch", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /async switchSession\(sessionId: string\)[\s\S]*?this\.historyCache\.delete\(sessionId\)[\s\S]*?type: "switchSession"/);
});

test("delegated activity delta events append without replacing prior invocation history", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /update\.activityMode === "append"[\s\S]*?update\.activityBase !== run\.activity\.length[\s\S]*?this\.reset\(\)/);
  assert.match(source, /const \{ activityMode, activityBase: _, \.\.\.run \} = update/);
  assert.match(source, /activityMode === "append" && previous[\s\S]*?\[\.\.\.previous\.activity, \.\.\.run\.activity\]/);
});

test("terminal agent event restores a dropped final assistant atomically", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /case "agent\.end":[\s\S]*?finalAssistant\(info\.assistantMessage\)[\s\S]*?reconcileFinalAssistant\(conversation\.messages, assistant\)/);
});

test("history windows remain bounded while rotating through many session generations", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /if \(!segments\?\.length\)[\s\S]*?this\.setHistorySegments\(key, segments\)/);
  assert.match(source, /private setHistorySegments[\s\S]*?while \(this\.historyWindows\.size > MAX_CACHED_SESSIONS\)/);
  assert.match(source, /jumpToHistory[\s\S]*?this\.setHistorySegments\(historyKey/);
});

test("merged history is revision-cached and destructive command failures restore it", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /mergedHistoryWindows\.get\(key\)[\s\S]*?cached\?\.revision === revision/);
  assert.match(source, /private touchHistoryWindow[\s\S]*?mergedHistoryWindows\.delete\(key\)/);
  assert.match(source, /async forkPrompt[\s\S]*?const cachedWindow[\s\S]*?catch \(error\)[\s\S]*?setHistorySegments\(key, cachedWindow\)/);
  assert.match(source, /async timeline[\s\S]*?const cachedWindow[\s\S]*?catch \(error\)[\s\S]*?setHistorySegments\(key, cachedWindow\)/);
});

test("completed compactions join the live transcript without changing stream state", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  const start = source.indexOf('case "compaction.update"');
  const reducer = source.slice(start, source.indexOf('case "metrics.update"', start));

  assert.match(source, /HISTORY_MUTATION_EVENTS[\s\S]*?"compaction\.update"/);
  assert.match(reducer, /completedMessage[\s\S]*?replaceConversationMessage/);
  assert.doesNotMatch(reducer, /streaming: (?:true|false)/);
});

test("pending queue reconciliation preserves delivery and removes restored entries", () => {
  const pending = (commandId: string): PendingMessageReadModel => ({
    id: `pending-${commandId}`,
    commandId,
    sessionId: "session",
    sessionGeneration: 1,
    text: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state: "queued",
  });
  const queued = (commandId: string, state: "queued" | "delivering") => ({
    id: `queue-${commandId}`,
    commandId,
    preview: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state,
  });
  const first = reconcilePendingQueue(
    [pending("one"), pending("two")],
    [queued("one", "queued"), queued("two", "queued")],
    [queued("one", "delivering"), queued("two", "queued")],
    "session",
    1,
  );
  assert.deepEqual(first.map((item) => [item.commandId, item.state]), [["one", "sending"], ["two", "queued"]]);
  const delivered = reconcilePendingQueue(first, [queued("one", "delivering"), queued("two", "queued")], [queued("two", "queued")], "session", 1);
  assert.deepEqual(delivered.map((item) => item.commandId), ["one", "two"]);
  const restored = reconcilePendingQueue(delivered, [queued("two", "queued")], [], "session", 1);
  assert.deepEqual(restored.map((item) => item.commandId), ["one"]);
  const rehydrated = reconcilePendingQueue([], [], [queued("three", "queued")], "session", 1);
  assert.equal(rehydrated[0]?.id, "pending-three");
});

test("queue updates feed one pending transcript row with queue actions", async () => {
  const store = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(store, /case "queue\.update": return \{ \.\.\.runtime, conversation: \{ \.\.\.conversation, queue: payload/);
  assert.match(store, /reconcilePendingQueue\([\s\S]*?runtime\.conversation\.queue\.items/);
  assert.match(panel, /const pendingTranscriptMessages: MessageReadModel\[\]/);
  assert.match(panel, /className="pending-message-footer"/);
  assert.match(panel, /restoreQueued\(queued\)[\s\S]*?steerQueued\(queued\)/);
  assert.doesNotMatch(panel, /className="composer-surface queue-surface"/);
});

test("message submission creates and atomically reconciles an optimistic pending row", async () => {
  const store = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  assert.match(store, /const knownCommand = Boolean\(commandName[\s\S]*?command\.name === commandName\)/);
  assert.match(store, /const pending: PendingMessageReadModel = \{[\s\S]*?id: pendingMessageId\(id\)/);
  assert.match(store, /await this\.sendCommand\([\s\S]*?pendingMessages: \(this\.snapshot\.pendingMessages \?\? \[\]\)\.filter/);
  assert.match(store, /event\.type === "message\.start"[\s\S]*?item\.id !== message\.id/);
  assert.match(store, /pendingMessages: clearRuntime \? \[\] : this\.snapshot\.pendingMessages/);
});

test("retryable agent events preserve active work while terminal errors settle it", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  assert.match(source, /"agent\.start", "agent\.end", "agent\.error"/);
  assert.match(source, /case "agent\.start":[\s\S]*?agentError: undefined/);
  assert.match(source, /case "agent\.end":[\s\S]*?workStartedAt: willRetry \? conversation\.workStartedAt : undefined/);
  assert.match(source, /case "agent\.end":[\s\S]*?agentError: willRetry \|\| typeof info\.message !== "string"/);
  assert.match(source, /case "agent\.error":[\s\S]*?workStartedAt: willRetry \? conversation\.workStartedAt : undefined/);
  assert.match(source, /case "agent\.error":[\s\S]*?agentError: willRetry \|\| typeof info\.message !== "string"/);
});

test("completed background sessions stay unread until selected", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /status\.completed === true && current\.runtime\?\.sessionId !== status\.sessionId/);
  assert.match(source, /unseenCompletions\[status\.sessionId\] = true/);
  assert.match(source, /markSessionSeen\(sessionId: string\)[\s\S]*?delete unseenCompletions\[sessionId\]/);
  assert.match(source, /status\.state === "sleeping"[\s\S]*?delete unseenCompletions\[status\.sessionId\]/);
  assert.match(source, /status\.workStartedAt === null[\s\S]*?sessionWorkStartedAts\[status\.sessionId\] = null/);
  assert.match(source, /typeof status\.workStartedAt === "string"[\s\S]*?!Number\.isNaN\(Date\.parse\(status\.workStartedAt\)\)/);
  assert.doesNotMatch(source, /else \{\s*sessionWorkStartedAts\[status\.sessionId\] = null/);
  assert.match(source, /sessionStatuses: clearRuntime \? undefined : this\.snapshot\.sessionStatuses/);
  assert.match(source, /sessionStatuses: this\.snapshot\.sessionStatuses,[\s\S]*?unseenCompletions: this\.snapshot\.unseenCompletions/);
});

test("session status retention is bounded", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  assert.match(source, /MAX_SESSION_STATUSES = 200/);
  assert.match(source, /while \(Object\.keys\(sessionStatuses\)\.length > MAX_SESSION_STATUSES\)/);
});

test("files wait for replacement runtime to reconnect before loading", async () => {
  const source = await readFile(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /useEffect\(\(\) => \{\s*if \(live\.connection !== "connected" \|\| !runtime\?\.ready\) \{\s*setInventoryLoading\(false\);\s*return;/);
  assert.match(source, /if \(!selectedPath\)[\s\S]*?const current = runtimeStore\.getSnapshot\(\);[\s\S]*?current\.connection !== "connected"[\s\S]*?current\.runtime\.sessionGeneration !== runtime\.sessionGeneration[\s\S]*?setViewerLoading\(false\);[\s\S]*?const request = view/);
  assert.match(source, /\[live\.connection, runtime\?\.ready, runtime\?\.sessionId, runtime\?\.sessionGeneration, runtime\?\.workspace\?\.revision\]/);
  assert.match(source, /const stillCurrent = \(\) =>[\s\S]*?snapshot\.runtime\.sessionGeneration === generation/);
  assert.match(source, /if \(active && stillCurrent\(\)\) setContent\(value\)/);
  assert.match(source, /\[live\.connection, selectedPath, view, runtime\?\.ready, runtime\?\.sessionId, runtime\?\.sessionGeneration, runtime\?\.workspace\?\.revision\]/);
});

test("browser waits for replacement runtime to reconnect before checking status", async () => {
  const browser = await readFile(new URL("../src/client/browser-panel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(browser, /const request = async[\s\S]*?const snapshot = runtimeStore\.getSnapshot\(\);\s*if \(snapshot\.connection !== "connected" \|\| !snapshot\.runtime\?\.ready\) return;[\s\S]*?const stillCurrent = \(\) =>[\s\S]*?current\.runtime\.sessionGeneration === sessionGeneration/);
  assert.match(browser, /if \(!active\.current \|\| !stillCurrent\(\)\) return;/);
  assert.match(browser, /useEffect\(\(\) => \{\s*if \(!connected\) return;\s*void request\(\{ action: "status" \}\)\.catch\(\(\) => undefined\);\s*\}, \[connected, generation\]\)/);
  assert.match(browser, /if \(!connected \|\| !mirrorRequest/);
  assert.match(app, /<BrowserPanel[\s\S]*?connected=\{live\.connection === "connected" && live\.runtime\?\.ready === true\}[\s\S]*?generation=\{live\.runtime\?\.sessionGeneration\}/);
});

test("terminal agent events settle stale running activity in the client projection", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /case "agent\.end":[\s\S]*?const willRetry = info\.willRetry === true && info\.stopped !== true[\s\S]*?terminalActivityStatus\("end", \{ stopped: info\.stopped === true, willRetry \}\)/);
  assert.match(source, /case "agent\.error":[\s\S]*?const willRetry = info\.willRetry === true && info\.stopped !== true[\s\S]*?terminalActivityStatus\("error", \{ stopped: info\.stopped === true, willRetry \}\)/);
  assert.match(source, /conversation: \{\s*\.\.\.conversation,\s*\.\.\.settledActivities,/);
});

test("agent completion and tool starts bypass frame batching", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /const batchNotification = event\.type !== "agent\.end" && event\.type !== "agent\.error" && event\.type !== "tool\.start"/);
  assert.match(source, /audioCues,\s*\}, batchNotification\)/);
  assert.match(source, /if \(!batched\) \{\s*if \(this\.frame !== undefined\) cancelAnimationFrame\(this\.frame\);\s*this\.frame = undefined;\s*this\.notify\(\)/);
});

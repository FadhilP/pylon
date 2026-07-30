import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("expected session replacement clears stale runtime while staying loading", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /event\.type === "session\.replaced"[\s\S]*?this\.reset\("loading", true\)/);
  assert.match(source, /runtime: clearRuntime \|\| !this\.snapshot\.runtime \? undefined : \{ \.\.\.this\.snapshot\.runtime, ready: false \}/);
  assert.match(source, /historyWindow: clearRuntime \? undefined : this\.snapshot\.historyWindow/);
  assert.match(source, /const connection = this\.snapshot\.connection === "loading" \? "loading" : "disconnected"/);
  assert.match(source, /event\.type === "session\.unavailable"[\s\S]*?this\.reset\(\)/);
  assert.match(source, /source\.onerror = \(\) => \{[\s\S]*?connection: "disconnected"/);
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
  assert.match(source, /sessionStatuses: clearRuntime \? undefined : this\.snapshot\.sessionStatuses/);
});

test("files wait for replacement runtime to reconnect before loading", async () => {
  const source = await readFile(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /useEffect\(\(\) => \{\s*if \(live\.connection !== "connected" \|\| !runtime\?\.ready\) \{\s*setInventoryLoading\(false\);\s*return;/);
  assert.match(source, /\[live\.connection, runtime\?\.ready, runtime\?\.sessionId, runtime\?\.workspace\?\.revision\]/);
});

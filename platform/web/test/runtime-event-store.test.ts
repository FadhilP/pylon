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

test("switching sessions drops history cached for a potentially different branch", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /async switchSession\(sessionId: string\)[\s\S]*?this\.historyCache\.delete\(sessionId\)[\s\S]*?type: "switchSession"/);
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

test("agent completion bypasses frame batching and flushes pending notifications", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /const batchNotification = event\.type !== "agent\.end" && event\.type !== "agent\.error"/);
  assert.match(source, /audioCues,\s*\}, batchNotification\)/);
  assert.match(source, /if \(!batched\) \{\s*if \(this\.frame !== undefined\) cancelAnimationFrame\(this\.frame\);\s*this\.frame = undefined;\s*this\.notify\(\)/);
});

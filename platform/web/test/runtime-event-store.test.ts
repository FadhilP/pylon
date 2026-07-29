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

test("terminal agent errors are subscribed and reduced into conversation state", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  assert.match(source, /"agent\.start", "agent\.end", "agent\.error"/);
  assert.match(source, /case "agent\.start":[\s\S]*?agentError: undefined/);
  assert.match(source, /case "agent\.end":[\s\S]*?agentError: info\.willRetry === true \|\| typeof info\.message !== "string"/);
  assert.match(source, /case "agent\.error":[\s\S]*?agentError: info\.willRetry === true \|\| typeof info\.message !== "string"/);
});

test("files wait for replacement runtime to reconnect before loading", async () => {
  const source = await readFile(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /useEffect\(\(\) => \{\s*if \(live\.connection !== "connected" \|\| !runtime\?\.ready\) \{\s*setInventoryLoading\(false\);\s*return;/);
  assert.match(source, /\[live\.connection, runtime\?\.ready, runtime\?\.sessionId, runtime\?\.workspace\?\.revision\]/);
});

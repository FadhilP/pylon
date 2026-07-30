import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendWorkDuration,
  MAX_WORK_DURATION_MS,
  parseWorkDuration,
  readPersistedWorkDurations,
} from "../src/work-duration.ts";

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

test("work durations are validated", () => {
  const valid = { version: 1, assistantEntryId: "assistant-1", durationMs: 12_345 };
  assert.deepEqual(parseWorkDuration(valid), valid);
  assert.equal(parseWorkDuration({ ...valid, assistantEntryId: "../assistant" }), undefined);
  assert.equal(parseWorkDuration({ ...valid, durationMs: -1 }), undefined);
  assert.equal(parseWorkDuration({ ...valid, durationMs: MAX_WORK_DURATION_MS + 1 }), undefined);
  assert.equal(parseWorkDuration({ ...valid, durationMs: 1.5 }), undefined);
  assert.equal(parseWorkDuration({ ...valid, padding: "x".repeat(1_024) }), undefined);
});

test("work durations survive reload and follow the active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-duration-"));
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  try {
    const session = SessionManager.create(cwd, sessionDir);
    const userEntryId = session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Do work" }],
      timestamp: Date.now(),
    });
    const assistantEntryId = session.appendMessage(assistant("Done"));
    assert.equal(appendWorkDuration(session, assistantEntryId, 12_345), true);
    assert.equal(appendWorkDuration(session, assistantEntryId, 23_456), true);
    assert.equal(appendWorkDuration(session, "../assistant", 1), false);

    const resumed = SessionManager.open(session.getSessionFile()!);
    assert.equal(readPersistedWorkDurations(resumed).get(assistantEntryId), 23_456);

    resumed.branch(userEntryId);
    const otherAssistantEntryId = resumed.appendMessage(assistant("Different branch"));
    assert.equal(appendWorkDuration(resumed, otherAssistantEntryId, 34_567), true);
    const branchDurations = readPersistedWorkDurations(resumed);
    assert.equal(branchDurations.has(assistantEntryId), false);
    assert.equal(branchDurations.get(otherAssistantEntryId), 34_567);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

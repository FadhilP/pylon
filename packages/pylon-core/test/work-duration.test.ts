import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendToolDuration,
  appendTurnGitBranch,
  appendWorkDuration,
  MAX_WORK_DURATION_MS,
  parseToolDuration,
  parseTurnGitBranch,
  parseWorkDuration,
  readPersistedToolDurations,
  readPersistedTurnGitBranches,
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

test("turn Git branches are validated", () => {
  const valid = { version: 1, assistantEntryId: "assistant-1", gitBranch: "feature/turn-branches" };
  assert.deepEqual(parseTurnGitBranch(valid), valid);
  assert.equal(parseTurnGitBranch({ ...valid, assistantEntryId: "../assistant" }), undefined);
  assert.equal(parseTurnGitBranch({ ...valid, gitBranch: "" }), undefined);
  assert.equal(parseTurnGitBranch({ ...valid, gitBranch: "x".repeat(201) }), undefined);
  assert.equal(parseTurnGitBranch({ ...valid, gitBranch: "feature\nunsafe" }), undefined);
});

test("tool durations accept provider IDs and reject unsafe bounds", () => {
  const valid = { version: 1, toolCallId: "call_h4vNJBk3x4Tca1eaI8kOlmab|fc_0051fc92ddf5b487", durationMs: 1_250 };
  assert.deepEqual(parseToolDuration(valid), valid);
  assert.equal(parseToolDuration({ ...valid, toolCallId: "call\u0000one" }), undefined);
  assert.equal(parseToolDuration({ ...valid, toolCallId: "x".repeat(129) }), undefined);
  assert.equal(parseToolDuration({ ...valid, durationMs: -1 }), undefined);
  assert.equal(parseToolDuration({ ...valid, durationMs: MAX_WORK_DURATION_MS + 1 }), undefined);
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

test("turn Git branches survive reload and follow the active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-turn-branch-"));
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
    assert.equal(appendTurnGitBranch(session, assistantEntryId, "feature/one"), true);
    assert.equal(appendTurnGitBranch(session, assistantEntryId, "feature/two"), true);
    assert.equal(appendTurnGitBranch(session, "../assistant", "feature/unsafe"), false);

    const resumed = SessionManager.open(session.getSessionFile()!);
    assert.equal(readPersistedTurnGitBranches(resumed).get(assistantEntryId), "feature/two");

    resumed.branch(userEntryId);
    const otherAssistantEntryId = resumed.appendMessage(assistant("Different branch"));
    assert.equal(appendTurnGitBranch(resumed, otherAssistantEntryId, "feature/other"), true);
    const branches = readPersistedTurnGitBranches(resumed);
    assert.equal(branches.has(assistantEntryId), false);
    assert.equal(branches.get(otherAssistantEntryId), "feature/other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool durations survive reload and follow the active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-tool-duration-"));
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  try {
    const session = SessionManager.create(cwd, sessionDir);
    const toolCallId = "call_h4vNJBk3x4Tca1eaI8kOlmab|fc_0051fc92ddf5b487";
    const userEntryId = session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Read the file" }],
      timestamp: Date.now(),
    });
    session.appendMessage({
      ...assistant(""),
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }],
    });
    assert.equal(appendToolDuration(session, toolCallId, 1_250), true);
    assert.equal(appendToolDuration(session, toolCallId, 2_500), true);
    assert.equal(appendToolDuration(session, "call\u0000one", 1), false);

    const resumed = SessionManager.open(session.getSessionFile()!);
    assert.equal(readPersistedToolDurations(resumed).get(toolCallId), 2_500);
    resumed.branch(userEntryId);
    assert.equal(readPersistedToolDurations(resumed).has(toolCallId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

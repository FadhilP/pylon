import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readPersistedWorktreeSummaries } from "pylon-core/src/worktree.ts";

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

test("worktree summaries survive reload and follow the active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-summary-"));
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  try {
    const session = SessionManager.create(cwd, sessionDir);
    const userEntryId = session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Change the file" }],
      timestamp: Date.now(),
    });
    const assistantEntryId = session.appendMessage(assistant("Done"));
    session.appendCustomEntry("pylon-worktree-summary", {
      version: 1,
      assistantEntryId,
      files: [{ path: "src/app.ts", additions: 4, deletions: 2 }],
    });
    session.appendCustomEntry("pylon-worktree-summary", {
      version: 1,
      assistantEntryId,
      files: [{ path: "../secret", additions: 1, deletions: 0 }],
    });
    session.appendCustomEntry("pylon-worktree-summary", {
      version: 1,
      assistantEntryId,
      files: [{ path: "ignored.ts", additions: 1, deletions: 0 }],
      padding: "x".repeat(64 * 1024),
    });

    assert.equal(JSON.stringify(session.buildSessionContext()).includes("src/app.ts"), false);
    const resumed = SessionManager.open(session.getSessionFile()!);
    assert.deepEqual(readPersistedWorktreeSummaries(resumed).get(assistantEntryId), [
      { path: "src/app.ts", additions: 4, deletions: 2 },
    ]);

    resumed.branch(userEntryId);
    resumed.appendMessage(assistant("Different branch"));
    assert.equal(readPersistedWorktreeSummaries(resumed).has(assistantEntryId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

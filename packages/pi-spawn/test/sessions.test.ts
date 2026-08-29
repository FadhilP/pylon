import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  RECENT_THREAD_MAX_TOTAL_CHARS,
  SpawnBusyError,
  createSpawnedSession,
  listSpawnedSessions,
  recentThreadTranscript,
  withThreadLock,
} from "../src/sessions.ts";

test("recent transcript bounds mixed message content and omits private reasoning and malformed entries", () => {
  const transcript = recentThreadTranscript(
    {
      getBranch: () =>
        [
          { type: "message", message: { role: "invalid", content: "ignore" } },
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "question" }, { type: "image" }] },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "hidden" },
                { type: "toolCall", name: "read" },
                { type: "text", text: "answer" },
              ],
            },
          },
          {
            type: "message",
            message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(200) }] },
          },
          { type: "custom_message", customType: "notice", content: "remember this" },
        ] as any,
    },
    { limit: 4, maxChars: 80 },
  );

  assert.equal(transcript.available, 4);
  assert.equal(transcript.returned, 4);
  assert.equal(transcript.truncated, true);
  assert.match(transcript.text, /\[user\][\s\S]*question[\s\S]*\[image\]/);
  assert.match(transcript.text, /\[assistant\][\s\S]*tool calls: read[\s\S]*answer/);
  assert.match(transcript.text, /\[tool:read\]/);
  assert.match(transcript.text, /\[custom:notice\][\s\S]*remember this/);
  assert.doesNotMatch(transcript.text, /hidden/);
});

test("recent transcript enforces a total output budget", () => {
  const transcript = recentThreadTranscript(
    {
      getBranch: () =>
        Array.from({ length: 50 }, (_, index) => ({
          type: "message",
          message: { role: "user", content: `${index}:${"x".repeat(2_000)}` },
        })) as any,
    },
    { limit: 50, maxChars: 2_000 },
  );

  assert.ok(transcript.text.length <= RECENT_THREAD_MAX_TOTAL_CHARS);
  assert.ok(transcript.returned < transcript.available);
  assert.equal(transcript.truncated, true);
});

test("thread lock rejects only overlapping work on the same thread and always releases", async () => {
  let release!: () => void;
  const held = withThreadLock(
    "thread-a",
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => withThreadLock("thread-a", async () => {}), SpawnBusyError);
  await withThreadLock("thread-b", async () => {});
  release();
  await held;
  await withThreadLock("thread-a", async () => {});
});

test("thread lock does not start work after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(
    () =>
      withThreadLock(
        "cancelled",
        async () => {
          started = true;
        },
        controller.signal,
      ),
    /aborted/,
  );
  assert.equal(started, false);
});

test("legacy spawned-session references use the shallow inventory fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-spawn-legacy-session-"));
  const cwd = join(root, "workspace"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const parent = SessionManager.create(cwd);
    parent.appendSessionInfo("Parent");
    const owner = { id: parent.getSessionId(), file: parent.getSessionFile()! };
    const child = createSpawnedSession(cwd, owner, "Legacy child");

    const listed = await listSpawnedSessions(owner, new Map([[child.info.id, undefined]]));
    assert.deepEqual(
      listed.map(item => item.info.id),
      [child.info.id],
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

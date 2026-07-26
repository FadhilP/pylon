import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { PooledSdkDriver } from "../src/server/pi/pooled-sdk-driver.ts";
import { projectIdForCwd, SessionIndex } from "../src/server/pi/session-index.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check());
}

function persistSession(session: SessionManager, name: string): void {
  session.appendSessionInfo(name);
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: name }],
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `Reply to ${name}` }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

test("session index pages projects, counts user messages, and searches unloaded sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-index-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const first = SessionManager.create(cwd);
  const second = SessionManager.create(cwd);
  persistSession(first, "First indexed session");
  persistSession(second, "Second searchable session");

  try {
    const index = new SessionIndex();
    const options = {
      activeId: first.getSessionId(),
      generation: 7,
      stateFor: () => "sleeping" as const,
    };
    const page = await index.list({ projectId: projectIdForCwd(cwd), limit: 1 }, options);
    assert.equal(page.projects[0]?.sessions.length, 1);
    assert.equal(page.projects[0]?.sessions[0]?.userMessageCount, 1);
    assert.ok(page.projects[0]?.nextCursor);

    const search = await index.list({ query: "Second searchable" }, options);
    assert.equal(search.projects[0]?.sessions[0]?.id, second.getSessionId());
  } finally {
    await Promise.all([first.getSessionFile(), second.getSessionFile()].map((path) => path ? rm(path, { force: true }) : undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime pool warm-switches without rebuilding and wakes sleeping sessions", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-pool-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(agentDir)]);
  const existing = SessionManager.create(cwd);
  persistSession(existing, "Existing current-project session");
  const other = SessionManager.create(otherCwd);
  persistSession(other, "Background session");
  let starts = 0;
  const probe: InlineExtension = {
    name: "pool-probe",
    factory(pi) {
      pi.on("session_start", () => { starts++; });
    },
  };
  const driver = new PooledSdkDriver({
    extensionFactories: [probe],
    sleepAfterMs: 500,
    viewOnlySleepAfterMs: 20,
    sleepCheckMs: 5,
  });
  const states: Array<[string, string]> = [];
  driver.subscribe((event) => {
    if (event.type === "session.status") states.push([event.sessionId, event.state]);
  });

  try {
    const initial = await driver.start({ cwd, agentDir, repositoryRoot });
    assert.notEqual(initial.sessionId, existing.getSessionId());
    assert.equal((await driver.snapshot()).metrics.userMessages, 0);
    await driver.switchSession({ sessionId: other.getSessionId() });
    assert.equal(starts, 2);
    const awakeSessions = await driver.listSessions({ projectId: projectIdForCwd(cwd) });
    assert.ok(awakeSessions.projects[0]?.sessions.some((session) => session.id === initial.sessionId));

    const warmStartedAt = Date.now();
    const warm = await driver.switchSession({ sessionId: initial.sessionId });
    assert.equal(warm.sessionId, initial.sessionId);
    assert.equal(starts, 2);
    assert.ok(Date.now() - warmStartedAt < 500);

    await waitFor(() => states.some(([id, state]) => id === other.getSessionId() && state === "sleeping"));
    await driver.switchSession({ sessionId: other.getSessionId() });
    assert.equal(starts, 3);
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

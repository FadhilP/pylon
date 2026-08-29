import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionIndex } from "../src/server/pi/session-index.ts";

function persist(manager: SessionManager): void {
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake",
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

test("web session index attributes only pi-spawn marked sessions to their owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-spawn-index-"));
  const cwd = join(root, "repo");
  const otherCwd = join(root, "other-repo");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(agentDir)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const parentManager = SessionManager.create(cwd);
    persist(parentManager);
    const parent = { id: parentManager.getSessionId(), file: parentManager.getSessionFile()! };
    parentManager.appendSessionInfo("Parent work");
    const ordinary = SessionManager.create(cwd, undefined, { parentSession: parent.file });
    ordinary.appendSessionInfo("Ordinary child");
    persist(ordinary);
    const spawned = SessionManager.create(cwd, undefined, { parentSession: parent.file });
    spawned.appendCustomEntry("pi-spawn-session", {
      version: 1,
      ownerSessionId: parent.id,
      ownerSessionFile: parent.file,
      createdAt: new Date().toISOString(),
    });
    spawned.appendSessionInfo("Visible child");
    persist(spawned);
    const adopted = SessionManager.create(cwd);
    adopted.appendCustomEntry("pi-spawn-session", {
      version: 1,
      ownerSessionId: parent.id,
      ownerSessionFile: parent.file,
      createdAt: new Date().toISOString(),
    });
    adopted.appendSessionInfo("Adopted child");
    persist(adopted);
    const malformed = SessionManager.create(cwd);
    malformed.appendCustomEntry("pi-spawn-session", {
      version: 1,
      ownerSessionId: parent.id,
      ownerSessionFile: parent.file,
      model: "",
      createdAt: new Date().toISOString(),
    });
    malformed.appendSessionInfo("Malformed child");
    persist(malformed);
    const privateAgent = SessionManager.create(
      cwd,
      join(agentDir, "pi-spawn", "agents", encodeURIComponent(parent.id)),
      { parentSession: parent.file },
    );
    privateAgent.appendSessionInfo("Private child");
    persist(privateAgent);
    const foreignParent = SessionManager.create(otherCwd);
    foreignParent.appendSessionInfo("Other parent");
    persist(foreignParent);
    const crossProjectChild = SessionManager.create(cwd, undefined, { parentSession: foreignParent.getSessionFile()! });
    crossProjectChild.appendCustomEntry("pi-spawn-session", {
      version: 1,
      ownerSessionId: foreignParent.getSessionId(),
      ownerSessionFile: foreignParent.getSessionFile()!,
      createdAt: new Date().toISOString(),
    });
    crossProjectChild.appendSessionInfo("Cross-project child");
    persist(crossProjectChild);

    const index = new SessionIndex();
    const list = () =>
      index.list(
        {},
        {
          activeId: parent.id,
          generation: 1,
          stateFor: () => "sleeping" as const,
          runningUnderParentSessionIdFor: sessionId => (sessionId === spawned.getSessionId() ? parent.id : undefined),
        },
      );
    const snapshot = await list();
    const sessions = snapshot.projects.flatMap(project => project.sessions);
    assert.equal(sessions.find(session => session.id === ordinary.getSessionId())?.parentSession, undefined);
    assert.deepEqual(sessions.find(session => session.id === spawned.getSessionId())?.parentSession, {
      id: parent.id,
      title: "Parent work",
    });
    assert.equal(
      sessions.find(session => session.id === spawned.getSessionId())?.runningUnderParentSessionId,
      parent.id,
    );
    assert.deepEqual(sessions.find(session => session.id === adopted.getSessionId())?.parentSession, {
      id: parent.id,
      title: "Parent work",
    });
    assert.equal(sessions.find(session => session.id === malformed.getSessionId())?.parentSession, undefined);
    assert.equal(sessions.find(session => session.id === crossProjectChild.getSessionId())?.parentSession, undefined);
    assert.ok(!sessions.some(session => session.id === privateAgent.getSessionId()));

    await new Promise(resolve => setTimeout(resolve, 10));
    ordinary.appendCustomEntry("pi-spawn-session", {
      version: 1,
      ownerSessionId: parent.id,
      ownerSessionFile: parent.file,
      createdAt: new Date().toISOString(),
    });
    const updated = (await list()).projects.flatMap(project => project.sessions);
    assert.deepEqual(updated.find(session => session.id === ordinary.getSessionId())?.parentSession, {
      id: parent.id,
      title: "Parent work",
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionIndex } from "../src/server/pi/session-index.ts";

function persist(manager: SessionManager): void {
  manager.appendMessage({
    role: "assistant", content: [], api: "fake", provider: "fake", model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  });
}

test("web session index includes standard spawned sessions but not private agents", async () => {
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
    const standard = SessionManager.create(cwd, undefined, { parentSession: parent.file });
    standard.appendSessionInfo("Visible child");
    persist(standard);
    const privateAgent = SessionManager.create(cwd, join(agentDir, "pi-spawn", "agents", encodeURIComponent(parent.id)), { parentSession: parent.file });
    privateAgent.appendSessionInfo("Private child");
    persist(privateAgent);
    const foreignParent = SessionManager.create(otherCwd);
    foreignParent.appendSessionInfo("Other parent");
    persist(foreignParent);
    const crossProjectChild = SessionManager.create(cwd, undefined, { parentSession: foreignParent.getSessionFile()! });
    crossProjectChild.appendSessionInfo("Cross-project child");
    persist(crossProjectChild);

    const snapshot = await new SessionIndex().list({}, {
      activeId: parent.id,
      generation: 1,
      stateFor: () => "sleeping",
    });
    const sessions = snapshot.projects.flatMap((project) => project.sessions);
    const child = sessions.find((session) => session.id === standard.getSessionId());
    assert.deepEqual(child?.parentSession, { id: parent.id, title: "Parent work" });
    assert.equal(sessions.find((session) => session.id === crossProjectChild.getSessionId())?.parentSession, undefined);
    assert.ok(!sessions.some((session) => session.id === privateAgent.getSessionId()));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

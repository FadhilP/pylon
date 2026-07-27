import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "../src/server/pi/runtime-coordinator.ts";
import { projectIdForCwd, SessionIndex } from "../src/server/pi/session-index.ts";
import { ProjectRegistry } from "../src/server/pi/project-registry.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

    const draft = {
      id: "draft-session",
      path: "",
      cwd,
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    };
    const withoutDraft = await index.list({}, { ...options, activeId: draft.id, fallbacks: [draft], userCountFor: () => 0 });
    assert.equal(withoutDraft.activeSessions.some((session) => session.id === draft.id), false);
    const withPrompt = await index.list({}, {
      ...options,
      activeId: draft.id,
      fallbacks: [{ ...draft, messageCount: 1 }],
      userCountFor: (id) => id === draft.id ? 1 : undefined,
      stateFor: (id) => id === draft.id ? "idle" : "sleeping",
    });
    assert.equal(withPrompt.activeSessions.some((session) => session.id === draft.id), true);
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
  const driver = new RuntimeCoordinator({
    extensionFactories: [probe],
    sleepAfterMs: 500,
    viewOnlySleepAfterMs: 100,
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
    assert.equal((await driver.listSessions()).activeSessions.some((session) => session.id === other.getSessionId()), false);
    const awakeSessions = await driver.listSessions({ projectId: projectIdForCwd(cwd) });
    assert.equal(awakeSessions.projects[0]?.sessions.some((session) => session.id === initial.sessionId) ?? false, false);

    const warmStartedAt = Date.now();
    const warm = await driver.switchSession({ sessionId: initial.sessionId });
    assert.equal(warm.sessionId, initial.sessionId);
    assert.equal(starts, 2);
    assert.ok(Date.now() - warmStartedAt < 500);

    await waitFor(() => states.some(([id, state]) => id === other.getSessionId() && state === "sleeping"));
    await driver.setSessionActive({ sessionId: other.getSessionId(), active: true });
    assert.equal(starts, 3);
    await driver.renameSession({ sessionId: other.getSessionId(), name: "Manually active" });
    const active = await driver.listSessions();
    assert.equal(active.activeSessions.find((session) => session.id === other.getSessionId())?.name, "Manually active");
    await driver.setSessionActive({ sessionId: other.getSessionId(), active: false });
    assert.ok(states.some(([id, state]) => id === other.getSessionId() && state === "sleeping"));
    const selectedOther = await driver.switchSession({ sessionId: other.getSessionId() });
    assert.equal(starts, 4);
    const archived = await driver.archiveSession({ sessionId: other.getSessionId(), expectedGeneration: selectedOther.sessionGeneration });
    assert.equal((await driver.listSessions()).projects.some((project) => project.sessions.some((session) => session.id === other.getSessionId())), false);
    assert.equal((await driver.listArchived()).sessions[0]?.id, other.getSessionId());
    await driver.restoreSession({ sessionId: other.getSessionId(), expectedGeneration: archived.sessionGeneration });
    assert.equal((await driver.listArchived()).sessions.length, 0);
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("empty project registry uses parking runtime and add/remove keeps the workspace", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-projects-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await ProjectRegistry.forAgentDir(agentDir).load([]);
  let selectedDirectory: string | undefined;
  const driver = new RuntimeCoordinator({ pickDirectory: async () => selectedDirectory });

  try {
    await driver.start({ cwd, agentDir, repositoryRoot });
    assert.equal((await driver.snapshot()).projectAvailable, false);
    assert.deepEqual((await driver.listSessions()).projects, []);

    assert.equal((await driver.addProject({ expectedGeneration: 1 })).cancelled, true);
    selectedDirectory = cwd;
    const added = await driver.addProject({ expectedGeneration: 1 });
    assert.equal(added.cancelled, false);
    assert.equal((await driver.snapshot()).projectAvailable, true);
    assert.equal((await driver.listSessions()).projects[0]?.totalCount, 0);

    const archived = await driver.archiveProject({ projectId: projectIdForCwd(cwd), expectedGeneration: added.sessionGeneration });
    assert.equal((await driver.snapshot()).projectAvailable, false);
    assert.equal((await driver.listArchived()).projects[0]?.id, projectIdForCwd(cwd));
    await driver.restoreProject({ projectId: projectIdForCwd(cwd), expectedGeneration: archived.sessionGeneration });
    assert.equal((await driver.listSessions()).projects[0]?.id, projectIdForCwd(cwd));

    await driver.removeProject({ projectId: projectIdForCwd(cwd), expectedGeneration: archived.sessionGeneration });
    assert.equal((await driver.snapshot()).projectAvailable, false);
    assert.deepEqual((await driver.listSessions()).projects, []);
    await assert.doesNotReject(() => mkdir(join(cwd, "still-here")));
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing the coordinator aborts and clears an open directory picker", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-picker-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await ProjectRegistry.forAgentDir(agentDir).load([]);
  let aborted = false;
  const driver = new RuntimeCoordinator({
    pickDirectory: (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("directory picker was closed"));
    }, { once: true })),
  });
  try {
    await driver.start({ cwd, agentDir, repositoryRoot });
    const pending = driver.addProject({ expectedGeneration: 1 });
    const rejected = assert.rejects(pending, /picker was closed/);
    await assert.rejects(driver.addProject({ expectedGeneration: 1 }), /already open/);
    await driver.dispose();
    await rejected;
    assert.equal(aborted, true);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

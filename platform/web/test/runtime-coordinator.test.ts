import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import { RuntimeCoordinator } from "../src/server/pi/runtime-coordinator.ts";
import { projectIdForCwd, SessionIndex } from "../src/server/pi/session-index.ts";
import { ProjectRegistry } from "../src/server/pi/project-registry.ts";

const run = promisify(execFile);

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

test("runtime pool warm-switches without rebuilding and wakes sleeping sessions", { timeout: 45_000 }, async () => {
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
    const initial = await driver.start({ cwd, agentDir, repositoryRoot: root });
    assert.notEqual(initial.sessionId, existing.getSessionId());
    assert.equal((await driver.snapshot()).metrics.userMessages, 0);
    await driver.switchSession({ sessionId: other.getSessionId() });
    assert.equal(starts, 2);
    assert.equal((await driver.listPackages()).sessionGeneration, (await driver.snapshot()).sessionGeneration);
    assert.equal((await driver.listSessions()).activeSessions.some((session) => session.id === other.getSessionId()), false);
    const awakeSessions = await driver.listSessions({ projectId: projectIdForCwd(cwd) });
    assert.equal(awakeSessions.projects[0]?.sessions.some((session) => session.id === initial.sessionId) ?? false, false);

    const selectedSlot = (driver as any).selected();
    const originalFileSuggestions = selectedSlot.driver.fileSuggestions.bind(selectedSlot.driver);
    let releaseSuggestions!: () => void;
    selectedSlot.driver.fileSuggestions = () => new Promise((resolve) => {
      releaseSuggestions = () => resolve({
        protocolVersion: PROTOCOL_VERSION,
        sessionGeneration: 1,
        available: true,
        paths: [],
      });
    });
    const staleSuggestions = driver.fileSuggestions({ query: "" });
    const warmStartedAt = Date.now();
    const warm = await driver.switchSession({ sessionId: initial.sessionId });
    releaseSuggestions();
    await assert.rejects(staleSuggestions, /session changed while loading file suggestions/);
    selectedSlot.driver.fileSuggestions = originalFileSuggestions;
    assert.equal(warm.sessionId, initial.sessionId);
    assert.equal(starts, 2);
    assert.ok(Date.now() - warmStartedAt < 500);

    const sessionIndex = (driver as any).sessionIndex as SessionIndex;
    const originalList = sessionIndex.list.bind(sessionIndex);
    let listEntered!: () => void;
    let releaseList!: () => void;
    const entered = new Promise<void>((resolve) => { listEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseList = resolve; });
    let holdFirstList = true;
    sessionIndex.list = async (...args: Parameters<SessionIndex["list"]>) => {
      const result = await originalList(...args);
      if (holdFirstList) {
        holdFirstList = false;
        listEntered();
        await held;
      }
      return result;
    };
    const listingDuringSwitch = driver.listSessions();
    await entered;
    const switchedDuringList = await driver.switchSession({ sessionId: other.getSessionId() });
    releaseList();
    assert.equal((await listingDuringSwitch).sessionGeneration, switchedDuringList.sessionGeneration);
    sessionIndex.list = originalList;
    await driver.switchSession({ sessionId: initial.sessionId });

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

test("Local draft provisioning leaves the project branch and worktree list unchanged", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-local-workspace-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(cwd, "README.md"), "local\n");
  await run("git", ["init"], { cwd });
  await run("git", ["config", "user.name", "Pylon Test"], { cwd });
  await run("git", ["config", "user.email", "pylon@test.local"], { cwd });
  await run("git", ["add", "README.md"], { cwd });
  await run("git", ["commit", "-m", "Initial"], { cwd });
  const branchBefore = (await run("git", ["branch", "--show-current"], { cwd })).stdout.trim();
  const worktreesBefore = (await run("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const slot = (driver as any).selected();
    persistSession((slot.driver as any).runtime.session.sessionManager, "Apply session changes");
    await ((driver as any).registry() as ProjectRegistry).setSessionWorkspace({
      sessionId: slot.id,
      projectId: projectIdForCwd(cwd),
      mode: "local",
    });
    const registry = (driver as any).registry() as ProjectRegistry;
    assert.equal(registry.workspaceForSession(slot.id)?.mode, "local");
    assert.equal((await run("git", ["branch", "--show-current"], { cwd })).stdout.trim(), branchBefore);
    assert.equal((await run("git", ["worktree", "list", "--porcelain"], { cwd })).stdout, worktreesBefore);
    assert.equal((await run("git", ["branch", "--list", "pylon-session-*"], { cwd })).stdout.trim(), "");
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("session changes apply from a worktree and Project folder without committing", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-apply-session-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(cwd, "README.md"), "base\n");
  await run("git", ["init"], { cwd });
  await run("git", ["config", "user.name", "Pylon Test"], { cwd });
  await run("git", ["config", "user.email", "pylon@test.local"], { cwd });
  await run("git", ["add", "README.md"], { cwd });
  await run("git", ["commit", "-m", "Initial"], { cwd });
  const originalBranch = (await run("git", ["branch", "--show-current"], { cwd })).stdout.trim();
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const slot = (driver as any).selected();
    await (driver as any).ensureDraftWorkspace(slot);
    await (driver as any).moveSelectedFromLocal(slot, projectIdForCwd(cwd), "worktree");
    await writeFile(join(slot.driver.runtimeDetails().cwd, "README.md"), "base\nisolated\n");
    await writeFile(join(cwd, "local.txt"), "keep local\n");
    const worktreeSnapshot = await driver.snapshot();
    assert.equal(worktreeSnapshot.workspace?.mode, "worktree");
    await assert.rejects(driver.applySessionChanges({
      expectedGeneration: worktreeSnapshot.sessionGeneration,
      expectedRevision: "stale-revision",
    }), /session changes changed/);
    assert.equal((await readFile(join(cwd, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "base\n");
    const applied = await driver.applySessionChanges({
      expectedGeneration: worktreeSnapshot.sessionGeneration,
      expectedRevision: worktreeSnapshot.workspace!.revision!,
    });
    assert.equal((await readFile(join(cwd, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "base\nisolated\n");
    assert.equal((await readFile(join(cwd, "local.txt"), "utf8")).trim(), "keep local");
    assert.equal((await driver.snapshot()).workspace?.mode, "worktree");
    assert.equal((await run("git", ["status", "--porcelain"], { cwd })).stdout.includes("README.md"), true);

    const moved = await driver.handoffSession({ destination: "checkout", expectedGeneration: applied.sessionGeneration });
    await writeFile(join(cwd, "README.md"), "base\nisolated\nproject-folder\n");
    const checkoutSnapshot = await driver.snapshot();
    assert.equal(checkoutSnapshot.workspace?.mode, "checkout");
    const localized = await driver.applySessionChanges({
      expectedGeneration: moved.sessionGeneration,
      expectedRevision: checkoutSnapshot.workspace!.revision!,
    });
    assert.equal((await driver.snapshot()).workspace?.mode, "local");
    assert.equal((await run("git", ["branch", "--show-current"], { cwd })).stdout.trim(), originalBranch);
    assert.equal((await readFile(join(cwd, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
      "base\nisolated\nproject-folder\n");
    assert.equal(localized.sessionId, slot.id);
    assert.equal((await run("git", ["log", "-1", "--pretty=%s"], { cwd })).stdout.trim(), "Initial");
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("fork translates the coordinator generation to the selected runtime generation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-fork-generation-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const existing = SessionManager.create(cwd);
  persistSession(existing, "Fork generation");
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const selected = await driver.switchSession({ sessionId: existing.getSessionId() });
    const slot = (driver as any).selected();
    assert.notEqual(selected.sessionGeneration, slot.innerGeneration);

    const prompt = (await driver.snapshot()).conversation.messages.find((message) =>
      message.role === "user" && message.entryId);
    assert.ok(prompt?.entryId);

    const forked = await driver.fork({
      expectedGeneration: selected.sessionGeneration,
      entryId: prompt.entryId,
      name: "Forked after switching",
      mode: "conversation",
      position: "at",
    });
    assert.equal(forked.cancelled, false);
    assert.equal((await driver.snapshot()).sessionName, "Forked after switching");
    const sessions = await driver.listSessions();
    assert.equal(sessions.activeSessions[0]?.id, forked.sessionId);
    assert.equal(sessions.projects[0]?.sessions[0]?.id, forked.sessionId);
    assert.ok(Date.now() - Date.parse(sessions.activeSessions[0]!.modifiedAt) < 60_000);
    await assert.rejects(driver.fork({
      expectedGeneration: selected.sessionGeneration,
      entryId: prompt.entryId,
      name: "Stale fork",
      mode: "conversation",
    }), /stale session generation/);
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
    await driver.start({ cwd, agentDir, repositoryRoot: root });
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
    await driver.start({ cwd, agentDir, repositoryRoot: root });
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

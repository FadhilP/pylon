import test, { after } from "node:test";
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
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pylon-coordinator-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

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
    const workStartedAt = "2026-07-30T10:00:00.000Z";
    const options = {
      activeId: first.getSessionId(),
      generation: 7,
      stateFor: () => "sleeping" as const,
      workStartedAtFor: (id: string) => id === second.getSessionId() ? workStartedAt : undefined,
    };
    const page = await index.list({ projectId: projectIdForCwd(cwd), limit: 1 }, options);
    assert.equal(page.projects[0]?.sessions.length, 1);
    assert.equal(page.projects[0]?.sessions[0]?.userMessageCount, 1);
    assert.ok(page.projects[0]?.nextCursor);

    const search = await index.list({ query: "Second searchable" }, options);
    assert.equal(search.projects[0]?.sessions[0]?.id, second.getSessionId());
    assert.equal(search.projects[0]?.sessions[0]?.workStartedAt, workStartedAt);

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

test("session status publishes work timer changes even when runtime state is unchanged", () => {
  const coordinator = new RuntimeCoordinator();
  const events: Array<{ workStartedAt?: string | null }> = [];
  coordinator.subscribe((event) => {
    if (event.type === "session.status") events.push(event);
  });
  let workStartedAt: string | undefined;
  let state = "running";
  const slot = {
    driver: {
      runtimeState: () => state,
      runtimeDetails: () => ({ workStartedAt }),
    },
    lastState: "running",
    lastWorkStartedAt: undefined,
  };
  const internal = coordinator as any;
  internal.generation = 1;
  internal.selectedId = "session";
  internal.slots.set("session", slot);

  internal.publishStatus("session");
  workStartedAt = "2026-07-30T10:00:00.000Z";
  internal.publishStatus("session");
  state = "attention";
  internal.publishStatus("session");
  state = "running";
  internal.publishStatus("session");
  workStartedAt = undefined;
  internal.publishStatus("session");

  assert.deepEqual(events.map((event) => event.workStartedAt), [
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
    null,
  ]);
});

test("background completion preserves its sound cue when selection changes during settlement", async () => {
  const coordinator = new RuntimeCoordinator();
  const events: any[] = [];
  coordinator.subscribe((event) => events.push(event));
  const internal = coordinator as any;
  internal.generation = 1;
  internal.selectedId = "selected";
  const slot = {
    id: "background",
    driver: {
      runtimeState: () => "idle",
      runtimeDetails: () => ({ workStartedAt: undefined }),
    },
    lastState: "running",
    lastWorkStartedAt: "2026-07-30T10:00:00.000Z",
    lastActivityAt: Date.now(),
  };
  internal.slots.set(slot.id, slot);
  internal.invalidateWorkspaceInventory = () => {};
  internal.refreshWorkspace = async () => {};
  let releaseSettlement!: () => void;
  internal.settleAgentRun = () => new Promise<void>((resolve) => { releaseSettlement = resolve; });

  internal.onSlotEvent(slot, {
    type: "session.event",
    sessionId: slot.id,
    sessionGeneration: 1,
    payload: { type: "agent_end", stopped: false },
  });
  await Promise.resolve();
  internal.selectedId = slot.id;
  releaseSettlement();
  await Promise.resolve();
  await Promise.resolve();

  const completion = events.find((event) => event.type === "session.status" && event.completed === true);
  assert.equal(completion?.sessionId, slot.id);
  assert.equal(completion?.cue, "turn-complete");
});

test("background attention status carries explicit sound cue intent", () => {
  const coordinator = new RuntimeCoordinator();
  const events: any[] = [];
  coordinator.subscribe((event) => events.push(event));
  const internal = coordinator as any;
  internal.generation = 1;
  internal.selectedId = "selected";
  const slot = {
    id: "background",
    driver: {
      runtimeState: () => "attention",
      runtimeDetails: () => ({ workStartedAt: undefined }),
    },
    lastState: "running",
    lastActivityAt: Date.now(),
  };
  internal.slots.set(slot.id, slot);

  internal.onSlotEvent(slot, {
    type: "ui.event",
    sessionId: slot.id,
    sessionGeneration: 1,
    payload: { kind: "request", requestId: "approval", method: "confirm", payload: {}, createdAt: new Date().toISOString() },
  });

  const attention = events.find((event) => event.type === "session.status" && event.state === "attention");
  assert.equal(attention?.sessionId, slot.id);
  assert.equal(attention?.cue, "attention");
});

test("settings persist while sessions run, but provider logout waits for idle", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const updates: string[] = [];
  let running = true;
  const selected = {
    id: "selected",
    innerGeneration: 1,
    driver: {
      canSleep: () => true,
      setPackageEnabled: async () => { updates.push("enabled"); },
      updatePackageSettings: async () => { updates.push("package"); },
      updateHookSettings: async () => { updates.push("hooks"); },
      logoutProvider: async () => { updates.push("logout"); },
    },
  };
  const background = {
    id: "background",
    driver: { canSleep: () => !running },
  };
  internal.generation = 1;
  internal.selectedId = selected.id;
  internal.slots.set(selected.id, selected);
  internal.slots.set(background.id, background);

  await coordinator.setPackageEnabled({ packageId: "pi-sieve", enabled: false });
  await coordinator.updatePackageSettings({ packageId: "pi-sieve", settings: { kind: "sieve", activePruning: true, threshold: 10_000, projectionMode: "stable", rolloverHighMultiplier: 8, rolloverLowMultiplier: 4 } });
  await coordinator.updateHookSettings({ settings: { sessionStart: { enabled: false, sources: [] }, beforeAgentStart: { enabled: false, sources: [] } } });
  assert.deepEqual(updates, ["enabled", "package", "hooks"]);
  assert.equal(internal.slots.size, 2);

  await assert.rejects(coordinator.logoutProvider("mock", 1), /every session is idle/);
  running = false;
  await coordinator.logoutProvider("mock", 1);
  assert.deepEqual(updates, ["enabled", "package", "hooks", "logout"]);
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
    const originalRefreshWorkspace = (driver as any).refreshWorkspace.bind(driver);
    let releaseRefresh!: () => void;
    let refreshStarted = false;
    (driver as any).refreshWorkspace = async (...args: unknown[]) => {
      refreshStarted = true;
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return originalRefreshWorkspace(...args);
    };
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
    assert.equal(refreshStarted, true);
    releaseRefresh();
    (driver as any).refreshWorkspace = originalRefreshWorkspace;

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
    await driver.setSessionPinned({ sessionId: other.getSessionId(), pinned: true });
    assert.equal(starts, 3);
    await driver.renameSession({ sessionId: other.getSessionId(), name: "Manually active" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const active = await driver.listSessions();
    assert.equal(active.activeSessions.find((session) => session.id === other.getSessionId())?.name, "Manually active");
    assert.equal(active.activeSessions.find((session) => session.id === other.getSessionId())?.pinned, true);
    await assert.rejects(driver.setSessionActive({ sessionId: other.getSessionId(), active: false }), /unpin before deactivating/);
    await driver.setSessionPinned({ sessionId: other.getSessionId(), pinned: false });
    const unpinned = await driver.listSessions();
    assert.equal(unpinned.projects.flatMap((project) => project.sessions).find((session) => session.id === other.getSessionId())?.pinned, false);
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

test("pinned sessions persist, wake on restart, and never sleep", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-pinned-session-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const pinned = SessionManager.create(cwd);
  persistSession(pinned, "Pinned session");
  const registry = ProjectRegistry.forAgentDir(agentDir);
  await registry.load([cwd]);
  await registry.pinSession(pinned.getSessionId());
  await registry.activateSession(pinned.getSessionId());
  const driver = new RuntimeCoordinator({ sleepAfterMs: 20, viewOnlySleepAfterMs: 20, sleepCheckMs: 5 });

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sessions = await driver.listSessions();
    const summary = sessions.activeSessions.find((session) => session.id === pinned.getSessionId());
    assert.equal(summary?.pinned, true);
    assert.notEqual(summary?.runtimeState, "sleeping");
    assert.equal((driver as any).slots.has(pinned.getSessionId()), true);
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("new sessions apply the effective workspace policy before the first prompt", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-new-session-workspace-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(cwd, "README.md"), "local\n");
  await run("git", ["init"], { cwd });
  await run("git", ["config", "user.name", "Pylon Test"], { cwd });
  await run("git", ["config", "user.email", "pylon@test.local"], { cwd });
  await run("git", ["add", "README.md"], { cwd });
  await run("git", ["commit", "-m", "Initial"], { cwd });
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const created = await driver.newSession({ expectedGeneration: 1 });
    const snapshot = await driver.snapshot();
    const registry = (driver as any).registry() as ProjectRegistry;
    const projectId = projectIdForCwd(cwd);
    assert.equal(snapshot.workspace?.mode, snapshot.runtimePolicy.effective.workspace);
    assert.equal(snapshot.workspace?.mode, "local");
    assert.equal(registry.workspaceForSession(created.sessionId)?.mode, "local");

    const policy = registry.runtimePolicy(projectId, created.sessionId);
    await registry.updateRuntimePolicy({
      scope: "project",
      projectId,
      sessionId: created.sessionId,
      verify: policy.project.verify,
      timeline: "inherit", guard: "inherit",
      workspace: "worktree",
      guardTimeoutSeconds: "inherit",
      clarifyTimeoutSeconds: "inherit",
      expectedRevision: policy.revision,
    });
    const isolated = await driver.newSession({ expectedGeneration: created.sessionGeneration });
    const isolatedSnapshot = await driver.snapshot();
    assert.equal(isolatedSnapshot.workspace?.mode, isolatedSnapshot.runtimePolicy.effective.workspace);
    assert.equal(isolatedSnapshot.workspace?.mode, "worktree");
    assert.equal(registry.workspaceForSession(isolated.sessionId)?.mode, "worktree");
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

test("Local sessions can run concurrently in one project", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-local-concurrency-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const first = (driver as any).selected();
    const registry = (driver as any).registry() as ProjectRegistry;
    const projectId = projectIdForCwd(cwd);
    await registry.setSessionWorkspace({ sessionId: first.id, projectId, mode: "local" });
    await driver.newSession({ expectedGeneration: 1 });
    const second = (driver as any).selected();
    assert.equal(registry.workspaceForSession(second.id)?.mode, "local");

    const runtimeState = first.driver.runtimeState;
    first.driver.runtimeState = () => "running";
    try {
      assert.doesNotThrow(() => (driver as any).assertCheckoutAvailable(second));

      await registry.setSessionWorkspace({ sessionId: first.id, projectId, mode: "checkout" });
      assert.throws(
        () => (driver as any).assertCheckoutAvailable(second),
        /another checkout-bound session is already running in this project/,
      );
      await registry.removeSessionWorkspace(first.id);
      assert.throws(
        () => (driver as any).assertCheckoutAvailable(second),
        /another checkout-bound session is already running in this project/,
      );
      await registry.setSessionWorkspace({ sessionId: first.id, projectId, mode: "local" });
      await registry.setSessionWorkspace({ sessionId: second.id, projectId, mode: "checkout" });
      assert.throws(
        () => (driver as any).assertCheckoutAvailable(second),
        /another checkout-bound session is already running in this project/,
      );
    } finally {
      first.driver.runtimeState = runtimeState;
    }
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
    const localSnapshot = await driver.snapshot();
    assert.equal(localSnapshot.workspace?.mode, "local");
    assert.equal(localSnapshot.workspace?.changedCount, 2);
    const localFiles = await driver.workspaceFiles({});
    assert.deepEqual(localFiles.files.filter((file) => file.status).map((file) => file.path).sort(), ["README.md", "local.txt"]);
    assert.match((await driver.workspaceDiff({ path: "README.md" })).text ?? "", /^\+project-folder$/m);
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
    await driver.setSessionPinned({ sessionId: existing.getSessionId(), pinned: true });
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
    assert.equal(sessions.activeSessions[0]?.pinned, true);
    assert.equal(sessions.projects[0]?.sessions[0]?.id, forked.sessionId);
    const registry = (driver as any).registry() as ProjectRegistry;
    assert.equal(registry.isSessionPinned(existing.getSessionId()), false);
    assert.equal(registry.isSessionPinned(forked.sessionId), true);
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
    assert.equal((await driver.listSessions()).projects[0]?.cwd, cwd);

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

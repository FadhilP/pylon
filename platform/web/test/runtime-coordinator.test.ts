import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { RuntimeSnapshot } from "../src/shared/protocol/snapshots.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";
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

function runtime(sessionId: string, messages: RuntimeSnapshot["conversation"]["messages"] = []): RuntimeSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION, sessionId, sessionGeneration: 1, ready: true, cwdLabel: "repo",
    activeTools: [], availableTools: [], optionalCapabilities: {}, diagnostics: [],
    conversation: { messages, tools: [], delegatedRuns: [], streaming: false, queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false } },
    sessionControls: { model: { provider: "mock", id: "test", name: "Test" }, models: [{ provider: "mock", id: "test", name: "Test" }], thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] },
    runtimePolicy: { revision: 1, global: { timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, project: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, session: {}, effective: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, availableVerifyChecks: [] },
    metrics: { model: "test", provider: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextLimit: 1, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
    operational: initialOperational([], []),
    extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
  };
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

test("session index refreshes one changed session without SDK-wide scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-targeted-index-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const session = SessionManager.create(cwd);
  persistSession(session, "Initial searchable text");
  const originalList = SessionManager.list;
  const originalListAll = SessionManager.listAll;
  let directoryScans = 0;
  let globalScans = 0;
  (SessionManager as any).list = async (...args: unknown[]) => {
    directoryScans++;
    return (originalList as any).apply(SessionManager, args);
  };
  (SessionManager as any).listAll = async (...args: unknown[]) => {
    globalScans++;
    return (originalListAll as any).apply(SessionManager, args);
  };

  try {
    const index = new SessionIndex();
    const options = { activeId: session.getSessionId(), generation: 1, stateFor: () => "idle" as const };
    await index.list({}, options);
    persistSession(session, "New lifecycle text");
    index.invalidateSession(session.getSessionId(), session.getSessionFile(), cwd);
    const result = await index.list({ query: "New lifecycle text" }, options);

    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());
    assert.equal(globalScans, 0);
    assert.equal(directoryScans, 0);
  } finally {
    (SessionManager as any).list = originalList;
    (SessionManager as any).listAll = originalListAll;
    if (session.getSessionFile()) await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("session index reuses its persisted cache and rebuilds corrupt or outdated caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-persisted-index-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const session = SessionManager.create(cwd);
  let added: SessionManager | undefined;
  persistSession(session, "Persisted cache source");
  const cachePath = join(isolatedAgentDir, "pylon-web", "session-summaries-v1.json");
  const options = { activeId: session.getSessionId(), generation: 1, stateFor: () => "sleeping" as const };

  try {
    const initial = new SessionIndex(undefined, isolatedAgentDir);
    await initial.list({}, options);
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    const record = cache.records.find((item: any) => item.session.id === session.getSessionId());
    assert.ok(record);
    record.session.allMessagesText += " persisted-only-sentinel";
    await writeFile(cachePath, JSON.stringify(cache));

    const warm = new SessionIndex(undefined, isolatedAgentDir);
    let result = await warm.list({ query: "persisted-only-sentinel" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());

    const sessionPath = session.getSessionFile()!;
    const source = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, "{temporarily malformed");
    warm.invalidate();
    result = await warm.list({ query: "persisted-only-sentinel" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());
    await writeFile(sessionPath, source);

    persistSession(session, "Changed file replaces cached sentinel");
    warm.invalidateSession(session.getSessionId(), session.getSessionFile(), cwd);
    result = await warm.list({ query: "Changed file replaces cached sentinel" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());

    added = SessionManager.create(cwd);
    persistSession(added, "Added after initial cache");
    warm.invalidate();
    result = await warm.list({ query: "Added after initial cache" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, added.getSessionId());
    await rm(added.getSessionFile()!, { force: true });
    warm.invalidate();
    result = await warm.list({ query: "Added after initial cache" }, options);
    assert.equal(result.projects.flatMap((project) => project.sessions).some((item) => item.id === added!.getSessionId()), false);

    const duplicateDirectory = join(isolatedAgentDir, "sessions", "duplicate-id");
    const duplicatePath = join(duplicateDirectory, "duplicate.jsonl");
    await mkdir(duplicateDirectory, { recursive: true });
    await copyFile(sessionPath, duplicatePath);
    warm.invalidate();
    result = await warm.list({}, options);
    assert.equal(result.projects.flatMap((project) => project.sessions).filter((item) => item.id === session.getSessionId()).length, 1);
    await rm(duplicateDirectory, { recursive: true, force: true });

    await writeFile(cachePath, "{broken");
    const corrupt = new SessionIndex(undefined, isolatedAgentDir);
    result = await corrupt.list({ query: "Persisted cache source" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());

    const outdated = JSON.parse(await readFile(cachePath, "utf8"));
    outdated.version++;
    await writeFile(cachePath, JSON.stringify(outdated));
    result = await new SessionIndex(undefined, isolatedAgentDir).list({ query: "Persisted cache source" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, session.getSessionId());
  } finally {
    if (session.getSessionFile()) await rm(session.getSessionFile()!, { force: true });
    if (added?.getSessionFile()) await rm(added.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("switching a session index agent directory drops pending paths from the prior agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-index-agent-switch-"));
  const cwdA = join(root, "workspace-a");
  const cwdB = join(root, "workspace-b");
  const agentA = join(root, "agent-a");
  const agentB = join(root, "agent-b");
  const sessionsA = join(agentA, "sessions", "a");
  const sessionsB = join(agentB, "sessions", "b");
  await Promise.all([cwdA, cwdB, sessionsA, sessionsB].map((path) => mkdir(path, { recursive: true })));
  const first = SessionManager.create(cwdA, sessionsA);
  const second = SessionManager.create(cwdB, sessionsB);
  persistSession(first, "Old agent session");
  persistSession(second, "New agent session");

  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentA;
    const index = new SessionIndex(undefined, agentA);
    await index.list({}, { activeId: first.getSessionId(), generation: 1, stateFor: () => "sleeping" as const });
    index.invalidateSession(first.getSessionId(), first.getSessionFile(), cwdA);
    process.env.PI_CODING_AGENT_DIR = agentB;
    index.setAgentDir(agentB);
    const result = await index.list({}, { activeId: second.getSessionId(), generation: 2, stateFor: () => "sleeping" as const });
    const ids = result.projects.flatMap((project) => project.sessions).map((session) => session.id);
    assert.deepEqual(ids, [second.getSessionId()]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("targeted session refresh isolates cwd values and follows path changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-custom-index-"));
  const custom = join(root, "sessions");
  const moved = join(root, "moved");
  const cwdA = join(root, "workspace-a");
  const cwdB = join(root, "workspace-b");
  await Promise.all([custom, moved, cwdA, cwdB].map((path) => mkdir(path, { recursive: true })));
  const first = SessionManager.create(cwdA, custom);
  const second = SessionManager.create(cwdB, custom);
  persistSession(first, "Custom A");
  persistSession(second, "Custom B");
  const firstPath = first.getSessionFile()!;
  const movedPath = join(moved, basename(firstPath));

  try {
    const index = new SessionIndex();
    const options = { activeId: first.getSessionId(), generation: 1, stateFor: () => "idle" as const };
    index.invalidateSession(first.getSessionId(), firstPath, cwdA);
    index.invalidateSession(second.getSessionId(), second.getSessionFile(), cwdB);
    let result = await index.list({}, options);
    let sessions = result.projects.flatMap((project) => project.sessions);
    assert.deepEqual(new Set(sessions.map((session) => session.id)), new Set([first.getSessionId(), second.getSessionId()]));

    persistSession(first, "Custom A refreshed");
    index.invalidateSession(first.getSessionId(), firstPath, cwdA);
    result = await index.list({ query: "Custom A refreshed" }, options);
    assert.equal(result.projects[0]?.sessions[0]?.id, first.getSessionId());

    await rename(firstPath, movedPath);
    index.invalidateSession(first.getSessionId(), movedPath, cwdA);
    result = await index.list({}, options);
    sessions = result.projects.flatMap((project) => project.sessions);
    assert.equal(sessions.filter((session) => session.id === first.getSessionId()).length, 1);
    assert.equal(sessions.find((session) => session.id === second.getSessionId())?.projectId, projectIdForCwd(cwdB));

    await rm(movedPath, { force: true });
    index.invalidateSession(first.getSessionId(), movedPath, cwdA);
    result = await index.list({}, options);
    sessions = result.projects.flatMap((project) => project.sessions);
    assert.equal(sessions.some((session) => session.id === first.getSessionId()), false);
    assert.equal(sessions.some((session) => session.id === second.getSessionId()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session switching restores live delegated-agent metadata from the background runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-live-delegate-switch-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const other = SessionManager.create(cwd);
  persistSession(other, "Other session");
  const coordinator = new RuntimeCoordinator({ sleepAfterMs: 60_000, viewOnlySleepAfterMs: 60_000 });

  try {
    const initial = await coordinator.start({ cwd, agentDir, repositoryRoot: root });
    await coordinator.switchSession({ sessionId: other.getSessionId() });
    const background = (coordinator as any).slots.get(initial.sessionId).driver.runtime.session;
    background._emit({
      type: "tool_execution_start", toolCallId: "spawn-background", toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect auth" },
    });
    background._emit({
      type: "tool_execution_update", toolCallId: "spawn-background", toolName: "spawn_agent",
      args: { action: "create", prompt: "Inspect auth" },
      partialResult: {
        content: [{ type: "text", text: "Private agent is working" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-session" },
          agentName: "Ada", startedAt: "2026-07-30T10:00:00.000Z", state: "running",
          model: "provider/child", durationMs: 1_000,
          usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.01 },
          activity: [{ kind: "call", tool: "read", text: "{\"path\":\"auth.ts\"}" }],
        },
      },
    });

    await coordinator.switchSession({ sessionId: initial.sessionId });
    const [run] = (await coordinator.snapshot()).conversation.delegatedRuns;
    assert.equal(run?.status, "running");
    assert.equal(run?.agentName, "Ada");
    assert.equal(run?.threadId, "child-session");
    assert.equal(run?.activity.length, 1);
    assert.equal(run?.usage?.output, 3);

    await coordinator.switchSession({ sessionId: other.getSessionId() });
    background._emit({
      type: "tool_execution_end", toolCallId: "spawn-background", toolName: "spawn_agent", isError: false,
      result: {
        content: [{ type: "text", text: "Done" }],
        details: {
          piSpawn: { version: 1, kind: "agent", id: "child-session" },
          agentName: "Ada", status: "completed", model: "provider/child", durationMs: 2_000,
          usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
          activity: [
            { kind: "call", tool: "read", text: "{\"path\":\"auth.ts\"}" },
            { kind: "result", tool: "read", text: "source" },
          ],
        },
      },
    });
    await coordinator.switchSession({ sessionId: initial.sessionId });
    const [completed] = (await coordinator.snapshot()).conversation.delegatedRuns;
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.response, "Done");
    assert.equal(completed?.activity.length, 2);
    assert.equal(completed?.usage?.output, 6);
  } finally {
    await coordinator.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("memory mutations forward scoped IDs and revisions, and reject changed generations", async () => {
  const coordinator = new RuntimeCoordinator();
  try {
    const internal = coordinator as any; internal.generation = 1; internal.selectedId = "session";
    let release!: () => void; const updates: any[] = [], deletes: any[] = [], migrations: any[] = [];
    internal.slots.set("session", { id: "session", innerGeneration: 7, lastActivityAt: 0, unsubscribe: () => {}, driver: {
      updateContinuityMemory: (input: any) => { updates.push(input); return Promise.resolve(); },
      deleteContinuityMemory: (input: any) => { deletes.push(input); return Promise.resolve(); },
      migrateContinuityMemory: (input: any) => { migrations.push(input); return migrations.length === 2 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(); }, dispose: async () => {},
    } });
    const userId = "00000000-0000-4000-8000-000000000001", projectId = "00000000-0000-4000-8000-000000000002";
    await coordinator.updateContinuityMemory({ expectedGeneration: 1, scope: "user", id: userId, trigger: "responding", guidance: "Keep replies concise.", expectedRevision: 3 });
    await coordinator.deleteContinuityMemory({ expectedGeneration: 1, scope: "project", id: projectId, expectedRevision: 4 });
    await coordinator.migrateContinuityMemory({ expectedGeneration: 1 });
    assert.deepEqual(updates[0], { expectedGeneration: 7, scope: "user", id: userId, trigger: "responding", guidance: "Keep replies concise.", expectedRevision: 3 });
    assert.deepEqual(deletes[0], { expectedGeneration: 7, scope: "project", id: projectId, expectedRevision: 4 });
    assert.deepEqual(migrations[0], { expectedGeneration: 7 });
    const pending = coordinator.migrateContinuityMemory({ expectedGeneration: 1 });
    await Promise.resolve(); internal.generation = 2; release();
    await assert.rejects(pending, /stale/i);
  } finally { await coordinator.dispose(); }
});

test("session selection retries a snapshot invalidated by a background completion", async () => {
  const coordinator = new RuntimeCoordinator();
  const events: any[] = [];
  coordinator.subscribe((event) => events.push(event));
  const internal = coordinator as any;
  const stale = runtime("background");
  const fresh = runtime("background", [
    { id: "history-1", entryId: "assistant-entry", role: "assistant", text: "Completed while switching", streaming: false },
  ]);
  const slot = {
    id: "background",
    eventRevision: 0,
    lastActivityAt: Date.now(),
    driver: {
      runtimeState: () => "idle",
      runtimeDetails: () => ({ workStartedAt: undefined }),
    },
    lastState: "running",
    lastWorkStartedAt: undefined,
  };
  internal.generation = 1;
  internal.selectedId = "selected";
  internal.slots.set(slot.id, slot);
  internal.invalidateWorkspaceInventory = () => {};
  internal.refreshWorkspace = async () => {};
  let releaseSettlement!: () => void;
  internal.settleAgentRun = () => new Promise<void>((resolve) => { releaseSettlement = resolve; });
  let snapshots = 0;
  let releaseFirst!: () => void;
  internal.snapshotFor = () => {
    snapshots++;
    if (snapshots > 1) return Promise.resolve(fresh);
    return new Promise<RuntimeSnapshot>((resolve) => { releaseFirst = () => resolve(stale); });
  };

  const selecting = internal.select(slot);
  for (const type of ["message_end", "agent_end"]) {
    internal.onSlotEvent(slot, {
      type: "session.event",
      sessionId: slot.id,
      sessionGeneration: 1,
      payload: { type, stopped: false },
    });
  }
  releaseFirst();
  await selecting;
  releaseSettlement();
  await Promise.resolve();
  await Promise.resolve();

  const replacement = events.find((event) => event.type === "session.replaced");
  const completion = events.find((event) => event.type === "session.status" && event.completed === true);
  assert.equal(snapshots, 2);
  assert.equal(events.some((event) => event.type === "session.event"), false);
  assert.equal(replacement.runtime.conversation.messages[0]?.text, "Completed while switching");
  assert.equal(completion?.cue, "turn-complete");
});

test("awake sessions recover once from an invalid runtime snapshot", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const events: any[] = [];
  coordinator.subscribe((event) => events.push(event));
  internal.generation = 4;
  internal.selectedId = "selected";
  internal.target = { cwd: "repo", agentDir: "agent", repositoryRoot: "root" };
  internal.projectRegistry = {
    isSessionArchived: () => false,
    effectiveCwd: () => "repo",
    projectForSession: () => ({ id: "project-1" }),
  };
  const poisoned = { id: "poisoned", eventRevision: 0, lastActivityAt: 0 };
  internal.slots.set(poisoned.id, poisoned);
  internal.sessionIndex.resolve = async () => ({ id: poisoned.id, cwd: "repo", path: "session.jsonl" });
  internal.slotCanSleep = () => true;
  internal.publishStatus = () => {};
  const invalid = runtime(poisoned.id);
  (invalid.operational.verification as any).checks = "invalid";
  const recovered: any = { id: poisoned.id, eventRevision: 0, lastActivityAt: 0 };
  let created = 0;
  const disposed: unknown[] = [];
  internal.snapshotFor = async (slot: unknown) => slot === poisoned ? invalid : runtime(poisoned.id);
  internal.disposeSlot = async (slot: any) => {
    disposed.push(slot);
    if (internal.slots.get(slot.id) === slot) internal.slots.delete(slot.id);
  };
  internal.createSlot = async (target: unknown) => {
    created++;
    recovered.target = target;
    internal.slots.set(recovered.id, recovered);
    return recovered;
  };

  const result = await coordinator.switchSession({ sessionId: poisoned.id });

  assert.equal(result.sessionId, poisoned.id);
  assert.equal(result.sessionGeneration, 5);
  assert.equal(internal.selectedId, poisoned.id);
  assert.equal(created, 1);
  assert.deepEqual(disposed, [poisoned]);
  assert.equal((recovered as any).target.sessionPath, "session.jsonl");
  assert.equal(events.filter((event) => event.type === "session.replaced").length, 1);
});

test("awake-session recovery stops after one invalid reconstruction", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const events: any[] = [];
  coordinator.subscribe((event) => events.push(event));
  internal.generation = 4;
  internal.selectedId = "selected";
  internal.target = { cwd: "repo", agentDir: "agent", repositoryRoot: "root" };
  internal.projectRegistry = {
    isSessionArchived: () => false,
    effectiveCwd: () => "repo",
    projectForSession: () => ({ id: "project-1" }),
  };
  const poisoned = { id: "poisoned", eventRevision: 0, lastActivityAt: 0 };
  const recovered = { id: poisoned.id, eventRevision: 0, lastActivityAt: 0 };
  internal.slots.set(poisoned.id, poisoned);
  internal.sessionIndex.resolve = async () => ({ id: poisoned.id, cwd: "repo", path: "session.jsonl" });
  internal.slotCanSleep = () => true;
  internal.publishStatus = () => {};
  const invalid = runtime(poisoned.id);
  (invalid.operational.verification as any).checks = "invalid";
  let snapshots = 0;
  const disposed: unknown[] = [];
  internal.snapshotFor = async () => { snapshots++; return invalid; };
  internal.disposeSlot = async (slot: any) => {
    disposed.push(slot);
    if (internal.slots.get(slot.id) === slot) internal.slots.delete(slot.id);
  };
  internal.createSlot = async () => {
    internal.slots.set(recovered.id, recovered);
    return recovered;
  };

  await assert.rejects(coordinator.switchSession({ sessionId: poisoned.id }), /operational\.verification\.checks/);

  assert.equal(snapshots, 2);
  assert.deepEqual(disposed, [poisoned, recovered]);
  assert.equal(internal.selectedId, "selected");
  assert.equal(internal.generation, 4);
  assert.equal(events.some((event) => event.type === "session.replaced"), false);
});

test("awake-session recovery leaves running invalid slots untouched", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  internal.generation = 4;
  internal.selectedId = "selected";
  internal.projectRegistry = { isSessionArchived: () => false };
  const awake = { id: "awake", eventRevision: 0, lastActivityAt: 0 };
  internal.slots.set(awake.id, awake);
  const invalid = runtime(awake.id);
  (invalid.operational.verification as any).checks = "invalid";
  internal.snapshotFor = async () => invalid;
  internal.slotCanSleep = () => false;
  let resolved = false;
  let disposed = false;
  internal.sessionIndex.resolve = async () => { resolved = true; return undefined; };
  internal.disposeSlot = async () => { disposed = true; };

  await assert.rejects(coordinator.switchSession({ sessionId: awake.id }), /operational\.verification\.checks/);

  assert.equal(resolved, false);
  assert.equal(disposed, false);
  assert.equal(internal.slots.get(awake.id), awake);
  assert.equal(internal.selectedId, "selected");
  assert.equal(internal.generation, 4);
});

test("awake-session recovery does not recreate until old-slot disposal completes", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  internal.generation = 4;
  internal.selectedId = "selected";
  internal.target = { cwd: "repo", agentDir: "agent", repositoryRoot: "root" };
  internal.projectRegistry = {
    isSessionArchived: () => false,
    effectiveCwd: () => "repo",
    projectForSession: () => ({ id: "project-1" }),
  };
  const awake = { id: "awake", eventRevision: 0, lastActivityAt: 0 };
  internal.slots.set(awake.id, awake);
  internal.sessionIndex.resolve = async () => ({ id: awake.id, cwd: "repo", path: "session.jsonl" });
  internal.slotCanSleep = () => true;
  const invalid = runtime(awake.id);
  (invalid.operational.verification as any).checks = "invalid";
  internal.snapshotFor = async () => invalid;
  internal.disposeSlot = async () => { throw new Error("disposal failed"); };
  let created = false;
  internal.createSlot = async () => { created = true; };

  await assert.rejects(coordinator.switchSession({ sessionId: awake.id }), /disposal failed/);

  assert.equal(created, false);
  assert.equal(internal.selectedId, "selected");
  assert.equal(internal.generation, 4);
});

test("awake-session recovery does not intercept non-validation failures", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  internal.generation = 4;
  internal.selectedId = "selected";
  internal.projectRegistry = { isSessionArchived: () => false };
  const awake = { id: "awake", eventRevision: 0, lastActivityAt: 0 };
  internal.slots.set(awake.id, awake);
  let resolved = false;
  let disposed = false;
  internal.sessionIndex.resolve = async () => { resolved = true; return undefined; };
  internal.snapshotFor = async () => { throw new Error("workspace refresh failed"); };
  internal.disposeSlot = async () => { disposed = true; };

  await assert.rejects(coordinator.switchSession({ sessionId: awake.id }), /workspace refresh failed/);

  assert.equal(resolved, false);
  assert.equal(disposed, false);
  assert.equal(internal.selectedId, "selected");
  assert.equal(internal.generation, 4);
});

test("queued prompts stay ordered and continue after queued control failures", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const prompted: string[] = [];
  const steered: string[] = [];
  let state = "running";
  const slot = {
    id: "session",
    innerGeneration: 7,
    eventRevision: 0,
    lastActivityAt: Date.now(),
    lastState: "running",
    lastWorkStartedAt: "2026-07-30T10:00:00.000Z",
    receivedInput: false,
    nativeQueue: { steering: 0, followUp: 0 },
    queuedPrompts: [] as any[],
    pendingControls: undefined as any,
    driver: {
      runtimeState: () => state,
      runtimeDetails: () => ({ workStartedAt: state === "running" ? "2026-07-30T10:00:00.000Z" : undefined }),
      prompt: async (input: any) => { prompted.push(input.message); return { commandId: input.commandId, sessionGeneration: 7, accepted: true }; },
      steer: async (input: any) => { steered.push(input.message); return { commandId: input.commandId, sessionGeneration: 7, accepted: true }; },
      setSessionControls: async () => { throw new Error("model unavailable"); },
    },
  };
  internal.generation = 1;
  internal.selectedId = slot.id;
  internal.slots.set(slot.id, slot);
  internal.invalidateWorkspaceInventory = () => {};
  internal.refreshWorkspace = async () => {};
  const enqueue = (message: string) => coordinator.queuePrompt({ message, commandId: `command-${message}`, expectedGeneration: 1 });

  await enqueue("first");
  await enqueue("second");
  await enqueue("third");
  const [first, second, third] = internal.queueReadModel(slot).items;
  assert.deepEqual([first.preview, second.preview, third.preview], ["first", "second", "third"]);
  assert.deepEqual([first.commandId, second.commandId, third.commandId], ["command-first", "command-second", "command-third"]);

  assert.equal((await coordinator.queuedPrompt({ queueId: second.id, expectedGeneration: 1 })).message, "second");
  await coordinator.restoreQueuedPrompt({ queueId: second.id, expectedGeneration: 1 });
  await coordinator.steerQueuedPrompt({ queueId: third.id, commandId: "steer-third", expectedGeneration: 1 });
  assert.deepEqual(steered, ["third"]);

  state = "idle";
  await enqueue("fourth");
  slot.pendingControls = { input: {}, model: {} };
  internal.onSlotEvent(slot, {
    type: "session.event",
    sessionId: slot.id,
    sessionGeneration: 7,
    payload: { type: "agent_end", stopped: false },
  });
  await waitFor(() => prompted.length === 1);
  assert.deepEqual(prompted, ["first"]);
  assert.deepEqual(internal.queueReadModel(slot).items.map((item: any) => item.preview), ["fourth"]);

  await internal.settleAgentRun(slot);
  assert.deepEqual(prompted, ["first", "fourth"]);
  assert.deepEqual(internal.queueReadModel(slot).items, []);
});

test("multiple queued prompts advance after streaming settles", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const prompted: string[] = [];
  let state = "running";
  let workStartedAt: string | undefined = "turn-original";
  const slot = {
    id: "session",
    innerGeneration: 4,
    eventRevision: 0,
    lastActivityAt: Date.now(),
    lastState: "running",
    lastWorkStartedAt: workStartedAt,
    receivedInput: false,
    nativeQueue: { steering: 0, followUp: 0 },
    queuedPrompts: [] as any[],
    driver: {
      runtimeState: () => state,
      runtimeDetails: () => ({ workStartedAt }),
      prompt: async (input: any) => {
        if (state !== "idle") throw new Error("Agent is already processing");
        prompted.push(input.message);
        state = "running";
        workStartedAt = `turn-${prompted.length}`;
        return { commandId: input.commandId, sessionGeneration: 4, accepted: true };
      },
    },
  };
  internal.generation = 1;
  internal.selectedId = slot.id;
  internal.slots.set(slot.id, slot);
  internal.invalidateWorkspaceInventory = () => {};
  internal.refreshWorkspace = async () => {};
  const enqueue = (message: string) => coordinator.queuePrompt({ message, commandId: `command-${message}`, expectedGeneration: 1 });
  const endTurn = () => internal.onSlotEvent(slot, {
    type: "session.event",
    sessionId: slot.id,
    sessionGeneration: 4,
    payload: { type: "agent_end", stopped: false },
  });

  await enqueue("first");
  await enqueue("second");
  endTurn();
  await waitFor(() => Boolean((slot as any).queueFlushTimer));
  workStartedAt = undefined;
  state = "idle";
  await waitFor(() => prompted.length === 1);
  assert.deepEqual(prompted, ["first"]);
  assert.deepEqual(internal.queueReadModel(slot).items.map((item: any) => item.preview), ["second"]);

  endTurn();
  await waitFor(() => Boolean((slot as any).queueFlushTimer));
  workStartedAt = undefined;
  state = "idle";
  await waitFor(() => prompted.length === 2);
  assert.deepEqual(prompted, ["first", "second"]);
  assert.deepEqual(internal.queueReadModel(slot).items, []);
});

test("queue pump retries only a transient busy prompt rejection", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  let attempts = 0;
  const slot = {
    id: "session",
    innerGeneration: 4,
    eventRevision: 0,
    lastActivityAt: Date.now(),
    receivedInput: false,
    nativeQueue: { steering: 0, followUp: 0 },
    queuedPrompts: [] as any[],
    driver: {
      runtimeState: () => "idle",
      runtimeDetails: () => ({ workStartedAt: undefined }),
      prompt: async (input: any) => {
        if (++attempts === 1) throw new Error("Agent is already processing. Specify streamingBehavior to queue the message.");
        return { commandId: input.commandId, sessionGeneration: 4, accepted: true };
      },
    },
  };
  internal.generation = 1;
  internal.selectedId = slot.id;
  internal.slots.set(slot.id, slot);

  await coordinator.queuePrompt({ message: "retry me", commandId: "command-retry", expectedGeneration: 1 });
  await waitFor(() => attempts === 2);
  assert.deepEqual(internal.queueReadModel(slot).items, []);
});

test("queued follow-up remains visible while a turn timer is active", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const prompted: string[] = [];
  const published: string[][] = [];
  let workStartedAt: string | undefined = "2026-08-05T04:42:30.383Z";
  coordinator.subscribe((event) => {
    if (event.type === "queue.changed") published.push(event.queue.items?.map((item) => `${item.preview}:${item.state}`) ?? []);
  });
  const slot = {
    id: "session",
    innerGeneration: 4,
    eventRevision: 0,
    lastActivityAt: Date.now(),
    lastState: "idle",
    lastWorkStartedAt: workStartedAt,
    receivedInput: false,
    nativeQueue: { steering: 0, followUp: 0 },
    queuedPrompts: [] as any[],
    driver: {
      runtimeState: () => "idle",
      runtimeDetails: () => ({ workStartedAt }),
      prompt: async (input: any) => { prompted.push(input.message); return { commandId: input.commandId, sessionGeneration: 4, accepted: true }; },
    },
  };
  internal.generation = 1;
  internal.selectedId = slot.id;
  internal.slots.set(slot.id, slot);
  internal.invalidateWorkspaceInventory = () => {};
  internal.refreshWorkspace = async () => {};
  const enqueue = (message: string) => coordinator.queuePrompt({ message, commandId: `command-${message}`, expectedGeneration: 1 });

  await enqueue("during tool work");
  assert.deepEqual(prompted, []);
  assert.deepEqual(internal.queueReadModel(slot).items.map((item: any) => item.preview), ["during tool work"]);
  assert.deepEqual(published, [["during tool work:queued"]]);

  internal.onSlotEvent(slot, {
    type: "session.event",
    sessionId: slot.id,
    sessionGeneration: 4,
    payload: { type: "agent_end", willRetry: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(prompted, []);
  assert.deepEqual(internal.queueReadModel(slot).items.map((item: any) => item.preview), ["during tool work"]);

  workStartedAt = undefined;
  internal.onSlotEvent(slot, {
    type: "session.event",
    sessionId: slot.id,
    sessionGeneration: 4,
    payload: { type: "agent_end", stopped: false },
  });
  await waitFor(() => prompted.length === 1);
  assert.deepEqual(prompted, ["during tool work"]);
  assert.deepEqual(published.slice(-2), [["during tool work:delivering"], []]);

  await enqueue("truly idle");
  assert.deepEqual(prompted, ["during tool work", "truly idle"]);
  assert.deepEqual(internal.queueReadModel(slot).items, []);
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
    eventRevision: 0,
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
    eventRevision: 0,
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

test("repeated Local forks retain Local workspace records and allow concurrent sessions", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-local-forks-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const source = SessionManager.create(cwd);
  persistSession(source, "Repeated Local forks");
  const sourceId = source.getSessionId();
  const driver = new RuntimeCoordinator();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    await driver.switchSession({ sessionId: sourceId });
    const registry = (driver as any).registry() as ProjectRegistry;
    const projectId = projectIdForCwd(cwd);
    await registry.setSessionWorkspace({ sessionId: sourceId, projectId, mode: "local" });
    const sourcePrompt = (await driver.snapshot()).conversation.messages.find((message) =>
      message.role === "user" && message.entryId);
    assert.ok(sourcePrompt?.entryId);

    const first = await driver.fork({
      expectedGeneration: (await driver.snapshot()).sessionGeneration,
      entryId: sourcePrompt.entryId,
      name: "First Local fork",
      mode: "conversation",
      position: "at",
    });
    assert.equal(registry.workspaceForSession(sourceId)?.mode, "local");
    assert.equal(registry.workspaceForSession(first.sessionId)?.mode, "local");

    const selectedSource = await driver.switchSession({ sessionId: sourceId });
    const secondSourcePrompt = (await driver.snapshot()).conversation.messages.find((message) =>
      message.role === "user" && message.entryId);
    assert.ok(secondSourcePrompt?.entryId);
    const second = await driver.fork({
      expectedGeneration: selectedSource.sessionGeneration,
      entryId: secondSourcePrompt.entryId,
      name: "Second Local fork",
      mode: "conversation",
      position: "at",
    });
    assert.equal(registry.workspaceForSession(sourceId)?.mode, "local");
    assert.equal(registry.workspaceForSession(first.sessionId)?.mode, "local");
    assert.equal(registry.workspaceForSession(second.sessionId)?.mode, "local");

    const runningFork = (driver as any).selected();
    const runtimeState = runningFork.driver.runtimeState;
    runningFork.driver.runtimeState = () => "running";
    try {
      await driver.newSession({ expectedGeneration: second.sessionGeneration });
      const fresh = (driver as any).selected();
      assert.equal(registry.workspaceForSession(fresh.id)?.mode, "local");
      assert.doesNotThrow(() => (driver as any).assertCheckoutAvailable(fresh));
    } finally {
      runningFork.driver.runtimeState = runtimeState;
    }
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

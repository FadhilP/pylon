import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { appendWorkDuration } from "pylon-core/src/work-duration.ts";
import { deferUserMessageEndEntryId, deleteSessionFile, SessionRuntime, terminalAgentError } from "../src/server/pi/session-runtime.ts";
import { encodeHistoryCursor } from "../src/server/pi/projections.ts";
import { mergeHistoryMessages } from "../src/shared/history-cache.ts";
import type { DialogMethod, UiRequest } from "../src/server/pi/remote-ui-context.ts";
import { runtimeSnapshotValidationIssue } from "../src/shared/protocol/validation.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pylon-runtime-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
after(async () => {
  try {
    await rm(isolatedAgentDir, { recursive: true, force: true });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("user completion resolves its entry ID after persistence", async () => {
  const session = SessionManager.inMemory();
  const firstEntryId = session.appendMessage({ role: "user", content: "Prompt A", timestamp: Date.now() });
  const latestUserEntryId = () => [...session.getBranch()].reverse().find((entry) =>
    entry.type === "message" && entry.message.role === "user")?.id;
  const forwarded: Record<string, unknown>[] = [];
  const deferred = deferUserMessageEndEntryId(
    { type: "message_end", message: { role: "user", content: "Prompt B" } },
    () => true,
    latestUserEntryId,
    (payload) => forwarded.push(payload),
  );

  assert.equal(deferred, true);
  assert.equal(forwarded.length, 0);
  const secondEntryId = session.appendMessage({ role: "user", content: "Prompt B", timestamp: Date.now() });
  await Promise.resolve();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.entryId, secondEntryId);

  const merged = mergeHistoryMessages([], [
    { id: "history-0", entryId: firstEntryId, role: "user", text: "Prompt A", streaming: false },
    { id: "message-1", entryId: String(forwarded[0]?.entryId), role: "user", text: "Prompt B", streaming: false },
  ]);
  assert.deepEqual(merged.map((message) => message.text), ["Prompt A", "Prompt B"]);

  let resolveCalls = 0;
  assert.equal(deferUserMessageEndEntryId(
    { type: "message_end", message: { role: "user", content: "Stale prompt" } },
    () => false,
    () => { resolveCalls++; return secondEntryId; },
    (payload) => forwarded.push(payload),
  ), true);
  await Promise.resolve();
  assert.equal(resolveCalls, 1);
  assert.equal(forwarded.length, 1);

  const unresolved: Record<string, unknown>[] = [];
  assert.equal(deferUserMessageEndEntryId(
    { type: "message_end", message: { role: "user", content: "Unpersisted prompt" } },
    () => true,
    () => secondEntryId,
    (payload) => unresolved.push(payload),
  ), true);
  await Promise.resolve();
  assert.equal(unresolved[0]?.entryId, undefined);
  assert.equal(deferUserMessageEndEntryId(
    { type: "message_complete", message: { role: "user", content: "Compatibility event" } },
    () => true,
    latestUserEntryId,
    (payload) => forwarded.push(payload),
  ), false);
});

test("terminal agent errors come only from the latest assistant response", () => {
  assert.equal(terminalAgentError([
    { role: "assistant", stopReason: "error", errorMessage: " old failure " },
    { role: "assistant", stopReason: "stop" },
  ]), undefined);
  assert.equal(terminalAgentError([
    { role: "assistant", stopReason: "error", errorMessage: "old failure" },
    { role: "user", content: "new prompt" },
  ]), undefined);
  assert.equal(terminalAgentError([
    { role: "assistant", stopReason: "toolUse" },
    { role: "toolResult" },
    { role: "assistant", stopReason: "error", errorMessage: "  provider rejected request  " },
  ]), "provider rejected request");
  assert.equal(terminalAgentError([
    { role: "assistant", stopReason: "error", errorMessage: "x".repeat(1_001) },
  ])?.length, 1_000);
});

function persistSession(session: SessionManager, name: string): string {
  session.appendSessionInfo(name);
  return session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: name }],
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

test("completed work duration survives runtime restart", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-duration-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  const assistantEntryId = persistSession(session, "Timed response");
  appendWorkDuration(session, assistantEntryId, 12_345);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot, sessionPath: session.getSessionFile()! });
    const message = (await driver.snapshot()).conversation.messages.find((item) => item.entryId === assistantEntryId);
    assert.equal(message?.workDurationMs, 12_345);
  } finally {
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("public SDK binds RPC UI, aborts, replaces, discovers Pylon, and shuts down", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-phase0-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const failureCwd = join(root, "failure-workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(failureCwd), mkdir(agentDir)]);

  const observations = {
    dialogs: [] as Array<[string, unknown]>,
    starts: 0,
    shutdowns: 0,
    unavailable: 0,
    notifications: 0,
  };
  let cancelNextReplacement = true;
  let cancelRecoverySwitch = false;
  let factoryCalls = 0;
  let failOnFactoryCall = 0;
  const recoveryCanceller: InlineExtension = {
    name: "pylon-web-recovery-canceller",
    factory(pi) {
      pi.on("session_before_switch", () => {
        if (!cancelRecoverySwitch) return;
        cancelRecoverySwitch = false;
        return { cancel: true };
      });
    },
  };
  const probe: InlineExtension = {
    name: "pylon-web-phase0-probe",
    factory(pi) {
      factoryCalls++;
      if (factoryCalls === failOnFactoryCall) {
        cancelRecoverySwitch = true;
        throw new Error("deliberate replacement failure");
      }
      pi.on("session_start", () => { observations.starts++; });
      pi.on("session_shutdown", () => { observations.shutdowns++; });
      pi.on("session_before_switch", async (_event, ctx) => {
        if (!cancelNextReplacement) return;
        cancelNextReplacement = false;
        if (!await ctx.ui.confirm("Cancel replacement?", "Test cancellation")) return { cancel: true };
      });
      pi.registerCommand("phase0-probe", {
        handler: async (_args, ctx) => {
          observations.dialogs.push(["select", await ctx.ui.select("Choose", ["A", "B"])]);
          observations.dialogs.push(["confirm", await ctx.ui.confirm("Confirm", "Proceed?")]);
          observations.dialogs.push(["input", await ctx.ui.input("Input")]);
          observations.dialogs.push(["editor", await ctx.ui.editor("Editor", "before")]);
          ctx.abort();
        },
      });
      pi.registerCommand("phase4-implicit-replace", {
        handler: async (_args, ctx) => { await ctx.waitForIdle(); await ctx.newSession(); },
      });
      pi.registerCommand("phase0-notify", {
        handler: async (_args, ctx) => { ctx.ui.notify("Command result", "info"); },
      });
      pi.registerCommand("phase0-wait", {
        handler: async (_args, ctx) => { await ctx.ui.input("Wait for cancellation"); },
      });
    },
  };

  const driver = new SessionRuntime({
    extensionFactories: [recoveryCanceller, probe],
    onShutdownRequested: () => {},
  });
  const unsubscribe = driver.subscribe((event) => {
    if (event.type === "session.unavailable") observations.unavailable++;
    if (event.type !== "ui.event") return;
    const request = event.payload as UiRequest;
    if (request.method === "notify") observations.notifications++;
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    if (request.payload.title === "Wait for cancellation") return;
    const method = request.method as DialogMethod;
    queueMicrotask(() => {
      const base = {
        requestId: request.requestId,
        sessionGeneration: request.sessionGeneration,
        method,
      };
      if (method === "confirm") {
        const title = request.payload.title;
        void driver.answerUiRequest({
          ...base,
          method,
          confirmed: title === "Cancel replacement?" ? false : true,
        });
      }
      else if (method === "select") void driver.answerUiRequest({ ...base, method, value: "B" });
      else void driver.answerUiRequest({ ...base, method, value: method === "input" ? "typed" : "edited" });
    });
  });

  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root });
    const foreignParent = SessionManager.create(otherCwd);
    persistSession(foreignParent, "Foreign parent");
    const failureParent = SessionManager.create(failureCwd);
    persistSession(failureParent, "Failure parent");
    assert.equal(handle.sessionGeneration, 1);
    assert.equal((await driver.snapshot()).ready, true);

    const accepted = await driver.prompt({
      commandId: "phase0-command",
      expectedGeneration: 1,
      message: "/phase0-probe",
    });
    assert.equal(accepted.accepted, true);
    assert.deepEqual(observations.dialogs, [
      ["select", "B"],
      ["confirm", true],
      ["input", "typed"],
      ["editor", "edited"],
    ]);

    await driver.abort();

    await driver.prompt({ commandId: "notify-command", expectedGeneration: 1, message: "/phase0-notify" });
    assert.equal((await driver.snapshot()).commandResult?.output, "Command result");
    assert.equal(observations.notifications, 0);
    driver.dismissCommandResult("notify-command", 1);
    assert.equal((await driver.snapshot()).commandResult, undefined);

    let resolvePending!: () => void;
    const pendingUi = new Promise<void>((resolve) => { resolvePending = resolve; });
    const stopPending = driver.subscribe((event) => {
      if (event.type === "ui.event" && (event.payload as UiRequest).payload.title === "Wait for cancellation") resolvePending();
    });
    const waiting = driver.prompt({ commandId: "wait-command", expectedGeneration: 1, message: "/phase0-wait" });
    await pendingUi;
    await driver.abort();
    await waiting;
    stopPending();
    assert.equal(driver.runtimeState(), "idle");

    const cancelled = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.sessionGeneration, 1);
    assert.equal((await driver.snapshot()).ready, true);

    const replacement = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(replacement.cancelled, false);
    assert.equal(replacement.sessionGeneration, 3);
    assert.notEqual(replacement.sessionId, handle.sessionId);
    assert.equal(observations.starts, 3);
    assert.equal(observations.shutdowns, 2);
    const replacedSnapshot = await driver.snapshot();
    assert.equal(replacedSnapshot.cwdLabel, "other-workspace");

    const sameProject = await driver.newSession({ parentSessionId: foreignParent.getSessionId() });
    assert.equal(sameProject.cancelled, false);
    assert.equal(sameProject.sessionGeneration, 4);
    assert.equal(observations.starts, 4);
    assert.equal(observations.shutdowns, 3);

    const implicitReplacement = new Promise<void>((resolve) => {
      const stop = driver.subscribe((event) => {
        if (event.type !== "session.replaced" || event.sessionGeneration !== 5) return;
        stop(); resolve();
      });
    });
    await driver.prompt({ commandId: "implicit-replacement", expectedGeneration: 4, message: "/phase4-implicit-replace" });
    await implicitReplacement;
    const implicitSnapshot = await driver.snapshot();
    assert.equal(implicitSnapshot.sessionGeneration, 5);
    assert.equal(implicitSnapshot.ready, true);
    assert.equal(observations.starts, 5);
    assert.equal(observations.shutdowns, 4);

    await assert.rejects(
      driver.steer({ commandId: "stale", expectedGeneration: 1, message: "ignored" }),
      { name: "StaleGenerationError" },
    );

    failOnFactoryCall = factoryCalls + 2;
    const packageFailure = await driver.newSession({ parentSessionId: failureParent.getSessionId() });
    assert.equal(packageFailure.cancelled, false);
    const failed = await driver.snapshot();
    assert.equal(failed.sessionGeneration, 7);
    assert.equal(failed.cwdLabel, "failure-workspace");
    assert.ok(failed.diagnostics.some((item) => item.message.includes("failed to load")));
    assert.equal(failed.ready, true);
    assert.equal(observations.starts, 6);
    assert.equal(observations.shutdowns, 6);
    assert.equal(observations.unavailable, 0);
  } finally {
    unsubscribe();
    await driver.dispose();
    const testSessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(testSessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(observations.shutdowns, 6);
});

test("repository packages load, toggle, and save settings", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-packages-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();

  try {
    await driver.start({ cwd, agentDir, repositoryRoot });
    const first = await driver.snapshot();
    assert.ok(first.availableTools.includes("search_tools"));
    assert.ok(first.availableTools.includes("continuity_update"));
    assert.ok(first.availableTools.includes("verify"));
    assert.ok(first.availableTools.includes("heartbeat_start"));
    assert.equal(first.operational.continuity.availability, "available");
    assert.equal(first.operational.timeline.availability, "available");
    assert.ok(first.operational.tools.policies.length > 0);
    assert.ok((await driver.listPackages()).packages.some((item) => item.id === "pi-timeline" && item.active));

    const disabled = await driver.setPackageEnabled({ packageId: "pi-timeline", enabled: false });
    assert.equal(disabled.sessionGeneration, 2);
    assert.equal((await driver.snapshot()).operational.timeline.availability, "unavailable");
    assert.ok((await driver.listPackages()).packages.some((item) => item.id === "pi-timeline" && !item.enabled && !item.active));
    const sieve = (await driver.listPackages()).packages.find((item) => item.id === "pi-sieve")?.settings;
    assert.equal(sieve?.kind, "sieve");
    if (sieve?.kind !== "sieve") throw new Error("pi-sieve settings are unavailable");
    const threshold = sieve.threshold === 1_000 ? 2_000 : 1_000;
    const configured = await driver.updatePackageSettings({ packageId: "pi-sieve", settings: { ...sieve, threshold } });
    assert.equal(configured.sessionGeneration, 3);
    assert.deepEqual(
      (await driver.listPackages()).packages.find((item) => item.id === "pi-sieve")?.settings,
      { ...sieve, threshold },
    );
    await assert.rejects(driver.updatePackageSettings({
      packageId: "pi-advisor",
      settings: { kind: "advisor", mode: "model", model: "missing/model" },
    }), /unavailable/);
  } finally {
    await driver.dispose();
    const testSessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(testSessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("session deletion only falls back when trash is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-delete-file-"));
  const sessionPath = join(root, "session.jsonl");
  try {
    await writeFile(sessionPath, "session");
    const unavailable = Object.assign(new Error("spawn trash ENOENT"), { code: "ENOENT" });
    await deleteSessionFile(sessionPath, () => ({ status: null, error: unavailable }));
    assert.equal(existsSync(sessionPath), false);

    await writeFile(sessionPath, "session");
    await assert.rejects(deleteSessionFile(sessionPath, () => ({ status: 1, stderr: "permission denied" })), /permission denied/);
    assert.equal(existsSync(sessionPath), true);

    await assert.rejects(deleteSessionFile(sessionPath, () => ({ status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) })), /timed out/);
    assert.equal(existsSync(sessionPath), true);

    await assert.rejects(deleteSessionFile(sessionPath, () => ({ status: 0 })), /session file remains/);
    assert.equal(existsSync(sessionPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver deletes only inactive sessions and blocks concurrent lifecycle changes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-delete-"));
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();
  const deletable = SessionManager.create(otherCwd);
  persistSession(deletable, "Deletable session");
  const switchable = SessionManager.create(otherCwd);
  persistSession(switchable, "Switchable session");
  const deletablePath = deletable.getSessionFile()!;
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root });
    await assert.rejects(driver.deleteSession({ sessionId: handle.sessionId }), /currently active/);
    assert.equal((await driver.snapshot()).sessionId, handle.sessionId);

    const deletion = driver.deleteSession({ sessionId: deletable.getSessionId() });
    await assert.rejects(driver.switchSession({ sessionId: switchable.getSessionId() }), /another session operation/);
    await deletion;
    assert.equal(existsSync(deletablePath), false);
    await assert.rejects(driver.deleteSession({ sessionId: "missing-session" }), /unavailable/);
  } finally {
    await driver.dispose();
    await Promise.all([deletable.getSessionFile(), switchable.getSessionFile()].map((path) => path ? rm(path, { force: true }) : undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("fork validates idle state without rejecting its own lifecycle mutation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-fork-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const session = SessionManager.create(cwd, sessionDir);
  const userEntryId = session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Fork from here" }],
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
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
  const blocker: InlineExtension = {
    name: "pylon-web-fork-blocker",
    factory(pi) {
      pi.registerCommand("fork-blocker", {
        handler: async (_args, ctx) => { await ctx.ui.confirm("Keep open?", "Block lifecycle controls"); },
      });
    },
  };
  const driver = new SessionRuntime({ extensionFactories: [blocker] });
  let receiveRequest!: (request: UiRequest) => void;
  const pendingRequest = new Promise<UiRequest>((resolve) => { receiveRequest = resolve; });
  const unsubscribe = driver.subscribe((event) => {
    if (event.type === "ui.event") receiveRequest(event.payload as UiRequest);
  });
  try {
    const handle = await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const prompt = driver.prompt({
      commandId: "fork-blocker",
      expectedGeneration: handle.sessionGeneration,
      message: "/fork-blocker",
    });
    const request = await pendingRequest;
    await assert.rejects(driver.fork({
      expectedGeneration: handle.sessionGeneration,
      entryId: userEntryId,
      name: "Blocked fork",
      mode: "conversation",
      position: "at",
    }), /only change while the session is idle/);
    await driver.answerUiRequest({
      requestId: request.requestId,
      sessionGeneration: request.sessionGeneration,
      method: "confirm",
      confirmed: false,
    });
    await prompt;

    const forked = await driver.fork({
      expectedGeneration: handle.sessionGeneration,
      entryId: userEntryId,
      name: "Forked session",
      mode: "conversation",
      position: "at",
    });
    assert.equal(forked.cancelled, false);
    assert.equal((await driver.snapshot()).sessionName, "Forked session");
    await assert.rejects(driver.fork({
      expectedGeneration: handle.sessionGeneration,
      entryId: userEntryId,
      name: "Stale fork",
      mode: "conversation",
    }), /stale session generation/);
  } finally {
    unsubscribe();
    await driver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("driver starts without a root manifest and still loads required core", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-standalone-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.ready, true);
    const packages = (await driver.listPackages()).packages;
    assert.deepEqual(packages.map((item) => item.id), ["pylon-core"]);
    assert.equal(packages[0]?.required, true);
    assert.equal(packages[0]?.active, true);
  } finally {
    await driver.dispose();
    const sessions = (await SessionManager.listAll()).filter((session) => session.cwd.startsWith(root));
    await Promise.all(sessions.map((session) => rm(session.path, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
});

test("existing long sessions keep the latest user turn and every tool result", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-latest-turn-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const session = SessionManager.create(cwd);
  for (let index = 0; index < 30; index++) {
    persistSession(session, `old-${index}`);
  }
  session.appendMessage({ role: "user", content: "Run every check", timestamp: Date.now() });
  for (let index = 0; index < 120; index++) {
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.ts` } }],
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
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read",
      content: [{ type: "text", text: `result ${index}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.messages[0]?.role, "user");
    assert.equal(snapshot.conversation.messages[0]?.text, "Run every check");
    assert.equal(snapshot.conversation.messages.length, 241);
    assert.deepEqual(
      snapshot.conversation.messages.filter((message) => message.role === "tool").map((message) => message.text),
      Array.from({ length: 120 }, (_, index) => `result ${index}`),
    );
    assert.equal(snapshot.conversation.historyRemaining, 30);
    assert.equal(runtimeSnapshotValidationIssue(snapshot), undefined);
    const earlier = await driver.conversationHistory({ cursor: snapshot.conversation.historyCursor! });
    assert.deepEqual(earlier.messages.map((message) => message.text), Array.from({ length: 30 }, (_, index) => `old-${index}`));
    const snapshotEntryIds = new Set(snapshot.conversation.messages.map((message) => message.entryId));
    assert.equal(earlier.messages.some((message) => snapshotEntryIds.has(message.entryId)), false);
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("driver pages the complete visible branch after compaction", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-history-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const session = SessionManager.create(cwd);
  const messageIds: string[] = [];
  for (let index = 0; index < 155; index++) {
    messageIds.push(session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `message-${index}` }],
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
    }));
    if (index === 134) session.appendCompaction("summary", messageIds[120]!, 1_000);
  }

  const driver = new SessionRuntime();
  try {
    await driver.start({ cwd, agentDir, repositoryRoot: root, sessionPath: session.getSessionFile()! });
    const snapshot = await driver.snapshot();
    assert.equal(snapshot.conversation.messages.length, 100);
    assert.equal(snapshot.conversation.messages[0]?.text, "message-55");
    assert.equal(snapshot.conversation.messages[0]?.entryId, messageIds[55]);
    assert.equal(snapshot.conversation.historyRemaining, 55);

    const earlier: string[] = [];
    let cursor = snapshot.conversation.historyCursor;
    while (cursor) {
      const page = await driver.conversationHistory({ cursor });
      earlier.unshift(...page.messages.map((message) => message.text));
      cursor = page.nextCursor;
    }
    assert.equal(earlier.length, 55);
    assert.equal(earlier[0], "message-0");
    assert.equal(earlier.at(-1), "message-54");
    const firstPage = await driver.conversationHistory({ cursor: snapshot.conversation.historyCursor! });
    assert.equal(firstPage.messages[0]?.entryId, messageIds[0]);
    const laterPage = await driver.conversationHistory({
      cursor: encodeHistoryCursor(55),
      direction: "after",
      limit: 10,
    });
    assert.equal(laterPage.messages[0]?.text, "message-55");
    assert.equal(laterPage.messages.at(-1)?.text, "message-64");
    const aroundPage = await driver.conversationHistory({
      cursor: encodeHistoryCursor(77),
      direction: "around",
      limit: 10,
    });
    assert.equal(aroundPage.messages[0]?.text, "message-72");
    assert.equal(aroundPage.messages.at(-1)?.text, "message-81");
  } finally {
    await driver.dispose();
    await rm(session.getSessionFile()!, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

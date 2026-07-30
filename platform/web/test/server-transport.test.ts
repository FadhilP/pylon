import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { AcceptedCommand, QueuedPromptPayload } from "../src/shared/protocol/commands.ts";
import type { HeliosBrowserInput } from "../src/shared/protocol/helios.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { ArchiveListSnapshot, ConversationHistoryPage, FileSuggestionList, PackageListSnapshot, RuntimeSnapshot, SessionListSnapshot } from "../src/shared/protocol/snapshots.ts";
import { ServerTransport } from "../src/server/http/router.ts";
import { startPylonServer } from "../src/server/index.ts";
import type { DriverEvent, DriverEventListener, EditPromptInput, ForkInput, PiDriver, PromptInput, QueueMutationInput, ReplacementResult, RewindPromptInput, RuntimeHandle, RuntimeTarget, SetSessionControlsInput } from "../src/server/pi/pi-driver.ts";
import type { UiResponse } from "../src/server/pi/remote-ui-context.ts";
import { initialOperational } from "../src/server/pi/operational-projections.ts";
import { encodeHistoryCursor } from "../src/server/pi/projections.ts";

const snapshot: RuntimeSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  sessionId: "session-1",
  sessionGeneration: 1,
  ready: true,
  cwdLabel: "workspace",
  activeTools: ["read"],
  availableTools: ["read"],
  optionalCapabilities: {},
  diagnostics: [],
  conversation: { messages: [], tools: [], delegatedRuns: [], streaming: false, queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false } },
  sessionControls: { model: { provider: "mock", id: "test", name: "Test" }, models: [{ provider: "mock", id: "test", name: "Test" }], thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] },
  runtimePolicy: { revision: 1, global: { timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, project: { verify: { mode: "auto" }, timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, session: {}, effective: { verify: { mode: "auto" }, timelineEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 }, availableVerifyChecks: [] },
  metrics: { model: "test", provider: "mock", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextTokens: 0, contextLimit: 1, contextPercent: 0, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0 },
  operational: initialOperational([], []),
  extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
};

class FakeDriver implements PiDriver {
  private listeners = new Set<DriverEventListener>();
  private current = structuredClone(snapshot);
  calls = 0;
  prompts: string[] = [];
  promptImages: PromptInput["images"][] = [];
  queued?: QueuedPromptPayload;
  edits: EditPromptInput[] = [];
  rewinds: RewindPromptInput[] = [];
  forks: ForkInput[] = [];
  answers: UiResponse[] = [];
  keepAlives: Array<{ requestId: string; sessionGeneration: number }> = [];
  deletedSessions: string[] = [];
  renamedSessions: Array<{ sessionId: string; name: string }> = [];
  renamedProjects: Array<{ projectId: string; name: string }> = [];
  activatedSessions: Array<{ sessionId: string; active: boolean }> = [];
  pinnedSessions: Array<{ sessionId: string; pinned: boolean }> = [];
  selectedModels: Array<{ provider: string; modelId: string }> = [];
  selectedThinking: string[] = [];
  packageSettingsUpdates: unknown[] = [];
  indexRebuilds = 0;
  newSessionParent?: string;
  heliosRequests: HeliosBrowserInput[] = [];
  dialogMethod: "confirm" | "questionnaire" = "confirm";
  start(_target: RuntimeTarget): Promise<RuntimeHandle> { return Promise.resolve({ sessionId: "session-1", sessionGeneration: 1 }); }
  snapshot(): Promise<RuntimeSnapshot> { return Promise.resolve(structuredClone(this.current)); }
  terminalTarget() { return { sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration, cwd: process.cwd() }; }
  conversationHistory(): Promise<ConversationHistoryPage> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      messages: [{ id: "history-0", role: "user", text: "Earlier message", streaming: false }],
      remaining: 0,
    });
  }
  fileSuggestions(): Promise<FileSuggestionList> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      available: true,
      paths: ["src/index.ts"],
    });
  }
  listSessions(): Promise<SessionListSnapshot> {
    const session = { id: this.current.sessionId, projectId: "project-workspace", cwdLabel: this.current.cwdLabel, createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(), userMessageCount: 0, preview: "", active: true, pinned: false, runtimeState: "idle" as const };
    return Promise.resolve({ protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.current.sessionGeneration, activeSessions: [session], projects: [{ id: "project-workspace", label: "workspace", totalCount: 1, sessions: [session] }] });
  }
  listArchived(): Promise<ArchiveListSnapshot> {
    return Promise.resolve({ protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.current.sessionGeneration, projects: [], sessions: [], totalSessionCount: 0 });
  }
  listPackages(): Promise<PackageListSnapshot> { return Promise.resolve({ protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.current.sessionGeneration, packages: [{ id: "pi-test", name: "pi-test", description: "Test package", enabled: true, active: true, extensionCount: 1 }] }); }
  heliosBrowser(input: HeliosBrowserInput) {
    this.heliosRequests.push(input);
    return Promise.resolve({ version: 1 as const, sessionGeneration: this.current.sessionGeneration, active: true, ownership: "owned" as const, state: "ready" as const, controlled: true });
  }
  prompt(input: PromptInput): Promise<AcceptedCommand> {
    this.prompts.push(input.message);
    this.promptImages.push(input.images);
    const requestId = `dialog-${++this.calls}`;
    const payload = this.dialogMethod === "questionnaire"
      ? { title: "Clarify", questions: [{ question: "Which target?", options: ["Tests", "Build"] }] }
      : { title: "Guard approval", message: "Allow risky action?" };
    this.emit({ type: "ui.event", sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration, payload: { kind: "request", requestId, sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration, method: this.dialogMethod, payload, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    return Promise.resolve({ commandId: input.commandId, sessionGeneration: this.current.sessionGeneration, accepted: true });
  }
  queuePrompt(input: PromptInput): Promise<AcceptedCommand> {
    this.queued = { id: "queue-1", message: input.message, images: input.images, planMode: input.planMode === true };
    return Promise.resolve({ commandId: input.commandId, sessionGeneration: this.current.sessionGeneration, accepted: true });
  }
  queuedPrompt(input: QueueMutationInput): Promise<QueuedPromptPayload> {
    if (!this.queued || this.queued.id !== input.queueId) return Promise.reject(new Error("queued prompt is unavailable"));
    return Promise.resolve(structuredClone(this.queued));
  }
  restoreQueuedPrompt(input: QueueMutationInput): Promise<void> {
    if (!this.queued || this.queued.id !== input.queueId) return Promise.reject(new Error("queued prompt is unavailable"));
    this.queued = undefined;
    return Promise.resolve();
  }
  steerQueuedPrompt(input: QueueMutationInput): Promise<AcceptedCommand> {
    if (!this.queued || this.queued.id !== input.queueId) return Promise.reject(new Error("queued prompt is unavailable"));
    this.queued = undefined;
    return Promise.resolve({ commandId: input.commandId ?? "steer-queued", sessionGeneration: this.current.sessionGeneration, accepted: true });
  }
  steer(input: PromptInput): Promise<AcceptedCommand> { return Promise.resolve({ commandId: input.commandId, sessionGeneration: this.current.sessionGeneration, accepted: true }); }
  followUp(input: PromptInput): Promise<AcceptedCommand> { return this.steer(input); }
  editPrompt(input: EditPromptInput): Promise<AcceptedCommand> {
    this.edits.push(input);
    return this.steer(input);
  }
  rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand> {
    this.rewinds.push(input);
    return Promise.resolve({ commandId: input.commandId, sessionGeneration: this.current.sessionGeneration, accepted: true });
  }
  abort(): Promise<void> { return Promise.resolve(); }
  addProject(): Promise<ReplacementResult> { return Promise.resolve(this.replace("session-project", "project-workspace")); }
  removeProject(): Promise<ReplacementResult> { return Promise.resolve(this.replace("session-project-removed", "workspace")); }
  renameProject(input: { projectId: string; name: string }): Promise<void> {
    this.renamedProjects.push({ projectId: input.projectId, name: input.name });
    return Promise.resolve();
  }
  reorderProject(): Promise<void> { return Promise.resolve(); }
  archiveProject(): Promise<ReplacementResult> { return Promise.resolve(this.replace("session-project-archived", "workspace")); }
  restoreProject(): Promise<void> { return Promise.resolve(); }
  archiveSession(): Promise<ReplacementResult> { return Promise.resolve(this.replace("session-archived", "workspace")); }
  restoreSession(): Promise<void> { return Promise.resolve(); }
  reorderActiveSession(): Promise<void> { return Promise.resolve(); }
  newSession(input?: { parentSessionId?: string }): Promise<ReplacementResult> {
    this.newSessionParent = input?.parentSessionId;
    return Promise.resolve(this.replace("session-2", "other-workspace"));
  }
  switchSession(input: { sessionId: string }): Promise<ReplacementResult> { return Promise.resolve(this.replace(input.sessionId, "switched-workspace")); }
  deleteSession(input: { sessionId: string }): Promise<void> { this.deletedSessions.push(input.sessionId); return Promise.resolve(); }
  renameSession(input: { sessionId: string; name: string }): Promise<void> { this.renamedSessions.push(input); return Promise.resolve(); }
  setSessionActive(input: { sessionId: string; active: boolean }): Promise<void> { this.activatedSessions.push(input); return Promise.resolve(); }
  setSessionPinned(input: { sessionId: string; pinned: boolean }): Promise<void> { this.pinnedSessions.push(input); return Promise.resolve(); }
  fork(input: ForkInput): Promise<ReplacementResult> {
    this.forks.push(input);
    return Promise.resolve({ cancelled: true, sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration });
  }
  setPackageEnabled(): Promise<ReplacementResult> { return Promise.resolve(this.replace(this.current.sessionId, this.current.cwdLabel)); }
  updatePackageSettings(input: unknown): Promise<ReplacementResult> {
    this.packageSettingsUpdates.push(input);
    return Promise.resolve({ cancelled: false, sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration });
  }
  rebuildDiscoverIndex(): Promise<void> { this.indexRebuilds++; return Promise.resolve(); }
  setModel(input: { provider: string; modelId: string }): Promise<void> {
    this.selectedModels.push(input);
    this.current.sessionControls.model = { provider: input.provider, id: input.modelId, name: input.modelId };
    return Promise.resolve();
  }
  setThinkingLevel(input: { level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }): void {
    this.selectedThinking.push(input.level);
    this.current.sessionControls.thinkingLevel = input.level;
  }
  setSessionControls(input: SetSessionControlsInput): Promise<void> {
    this.selectedModels.push({ provider: input.provider, modelId: input.modelId });
    this.selectedThinking.push(input.thinkingLevel);
    this.current.sessionControls.model = { provider: input.provider, id: input.modelId, name: input.modelId };
    this.current.sessionControls.thinkingLevel = input.thinkingLevel;
    return Promise.resolve();
  }
  updateRuntimePolicy(): Promise<void> { return Promise.resolve(); }
  updateContinuityMemory(): Promise<void> { return Promise.resolve(); }
  deleteContinuityMemory(): Promise<void> { return Promise.resolve(); }
  answerUiRequest(input: UiResponse): Promise<void> { this.answers.push(input); this.emit({ type: "ui.closed", sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration, requestId: input.requestId }); return Promise.resolve(); }
  keepUiRequestAlive(requestId: string, sessionGeneration: number): void {
    this.keepAlives.push({ requestId, sessionGeneration });
  }
  subscribe(listener: DriverEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emitRuntime(runtime: RuntimeSnapshot): void {
    this.emit({ type: "session.replaced", sessionId: runtime.sessionId, sessionGeneration: runtime.sessionGeneration, runtime });
  }
  dispose(): Promise<void> { return Promise.resolve(); }
  private replace(sessionId: string, cwdLabel: string): ReplacementResult {
    this.current = { ...structuredClone(snapshot), sessionId, cwdLabel, sessionGeneration: this.current.sessionGeneration + 1 };
    this.emit({ type: "session.replaced", sessionId, sessionGeneration: this.current.sessionGeneration, runtime: structuredClone(this.current) });
    return { cancelled: false, sessionId, sessionGeneration: this.current.sessionGeneration };
  }
  private emit(event: DriverEvent): void { for (const listener of this.listeners) listener(event); }
}

async function body(response: Response): Promise<Record<string, unknown>> { return await response.json() as Record<string, unknown>; }
async function rawStatus(url: string, headers: Record<string, string>, setHost = true): Promise<number> {
  const target = new URL(url);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, headers, setHost }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

test("local server rejects foreign Host before API and asset routing", async () => {
  const running = await startPylonServer({ port: 0, development: false, driver: new FakeDriver() });
  const port = (running.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await rawStatus(`${origin}/`, { host: "evil.invalid" }), 403);
    assert.equal(await rawStatus(`${origin}/api/v1/health`, { host: "evil.invalid" }), 403);
    assert.ok([400, 403].includes(await rawStatus(`${origin}/api/v1/health`, {}, false)));
    assert.equal(await rawStatus(`${origin}/api/v1/health`, { host: `127.0.0.1:${port}` }), 200);
    assert.equal(running.server.headersTimeout, 10_000);
    assert.equal(running.server.requestTimeout, 30_000);
  } finally {
    await running.close();
  }
});

test("terminal upgrade rejects unauthenticated and stale sessions before spawning", async () => {
  const running = await startPylonServer({ port: 0, development: false, driver: new FakeDriver() });
  const port = (running.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const tab = "terminal-security-tab";
  const upgradeStatus = (url: URL, cookie?: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), origin } });
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.once("open", () => { socket.close(); reject(new Error("terminal upgrade unexpectedly succeeded")); });
    socket.once("error", () => undefined);
  });
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const csrf = String((await body(bootstrap)).csrfToken);
    const url = new URL(origin.replace("http:", "ws:") + "/api/v1/terminal");
    url.search = new URLSearchParams({ tabId: tab, generation: "2", csrf }).toString();
    assert.equal(await upgradeStatus(url, cookie), 409);
    url.searchParams.set("generation", "1");
    assert.equal(await upgradeStatus(url), 403);
  } finally {
    await running.close();
  }
});

test("server startup disposes a driver that fails to initialize", async () => {
  class FailingDriver extends FakeDriver {
    disposed = false;
    override start(): Promise<RuntimeHandle> {
      return Promise.reject(new Error("startup failed"));
    }
    override dispose(): Promise<void> {
      this.disposed = true;
      return Promise.resolve();
    }
  }
  const driver = new FailingDriver();

  await assert.rejects(startPylonServer({ port: 0, development: false, driver }), /startup failed/);
  assert.equal(driver.disposed, true);
});

test("bootstrap rejects invalid runtime snapshots with a bounded diagnostic", async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`] });
  driver.emitRuntime({
    ...snapshot,
    sessionGeneration: 2,
    conversation: { ...snapshot.conversation, messages: "invalid" },
  } as unknown as RuntimeSnapshot);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
      headers: { "x-pylon-tab-id": "invalid-runtime-tab" },
    });
    assert.equal(response.status, 503);
    assert.match(String((await body(response)).error), /Invalid runtime snapshot in conversation/);
  } finally {
    await transport.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("transport enforces origin, CSRF, size, generation, readiness, idempotency, and dialog ownership", { timeout: 10_000 }, async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`] });
  const tab = "tab-owner";
  const otherTab = "tab-other";
  const abortSse = new AbortController();
  const abortOtherSse = new AbortController();
  try {
    const staleEvents = await fetch(`${origin}/api/v1/events?tabId=stale-tab&cursor=1:0`);
    assert.equal(staleEvents.status, 200);
    assert.match(await staleEvents.text(), /stream\.reset-required[\s\S]+session-invalid/);

    const foreign = await fetch(`${origin}/api/v1/bootstrap`, { headers: { origin: "http://evil.invalid", "x-pylon-tab-id": tab } });
    assert.equal(foreign.status, 403);
    assert.equal(await rawStatus(`${origin}/api/v1/bootstrap`, { host: "evil.invalid", "x-pylon-tab-id": tab }), 403);
    const crossSite = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "sec-fetch-site": "cross-site", "x-pylon-tab-id": tab } });
    assert.equal(crossSite.status, 403);

    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const setCookie = bootstrap.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /; HttpOnly;/);
    assert.match(setCookie, /; SameSite=Strict(?:;|$)/);
    assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
    const cookie = setCookie.split(";")[0];
    const boot = await body(bootstrap);
    const csrf = String(boot.csrfToken);
    const mutationHeaders = { cookie, "content-type": "application/json", "x-pylon-csrf": csrf, "x-pylon-tab-id": tab };

    const malformedPath = await fetch(`${origin}/api/v1/ui-responses/%E0%A4%A`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(malformedPath.status, 400);
    const noStream = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "prompt", commandId: "before-stream", expectedGeneration: 1, message: "hello" }) });
    assert.equal(noStream.status, 409);
    const noStreamBrowser = await fetch(`${origin}/api/v1/helios-browser`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ action: "status", expectedGeneration: 1 }) });
    assert.equal(noStreamBrowser.status, 409);
    const badCsrf = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: { ...mutationHeaders, "x-pylon-csrf": "bad" }, body: JSON.stringify({ type: "abort", commandId: "bad", expectedGeneration: 1 }) });
    assert.equal(badCsrf.status, 403);
    const stale = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "abort", commandId: "stale", expectedGeneration: 2 }) });
    assert.equal(stale.status, 409);
    const oversized = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "prompt", commandId: "large", expectedGeneration: 1, message: "x".repeat(129 * 1024) }) });
    assert.equal(oversized.status, 400);

    const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: abortSse.signal });
    assert.equal(events.status, 200);
    const firstChunk = await events.body!.getReader().read();
    assert.match(new TextDecoder().decode(firstChunk.value), /: connected/);
    const browserStatus = await fetch(`${origin}/api/v1/helios-browser`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ action: "status", expectedGeneration: 1 }) });
    assert.equal(browserStatus.status, 200);
    assert.equal(browserStatus.headers.get("cache-control"), "no-store");
    assert.equal((await body(browserStatus)).controlled, true);
    assert.equal(driver.heliosRequests.at(-1)?.owner, "web:tab-owner");
    assert.equal((await fetch(`${origin}/api/v1/helios-browser`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ action: "pointer", expectedGeneration: 1, x: -1, y: 1, phase: "move" }) })).status, 400);
    assert.equal((await fetch(`${origin}/api/v1/helios-browser`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ action: "status", expectedGeneration: 2 }) })).status, 409);
    assert.equal((await fetch(`${origin}/api/v1/helios-browser`, { method: "POST", headers: { ...mutationHeaders, "x-pylon-csrf": "bad" }, body: JSON.stringify({ action: "status", expectedGeneration: 1 }) })).status, 403);
    const images = [{ mimeType: "image/png", data: "eA==" }] as const;
    const command = { type: "prompt", commandId: "once", expectedGeneration: 1, message: "hello", images };
    const accepted = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(command) });
    assert.equal(accepted.status, 200);
    const duplicate = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(command) });
    assert.equal(duplicate.status, 200);
    assert.equal(driver.calls, 1);
    assert.deepEqual(driver.promptImages, [images]);

    const ownerBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }));
    assert.equal((ownerBoot.pendingUi as { owned: boolean }).owned, true);
    const otherBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": otherTab } }));
    const otherEvents = await fetch(`${origin}/api/v1/events?tabId=${otherTab}&cursor=1:${String(otherBoot.sequence)}`, { headers: { cookie }, signal: abortOtherSse.signal });
    assert.equal(otherEvents.status, 200);
    const otherHeaders = { ...mutationHeaders, "x-pylon-tab-id": otherTab };
    const responseBody = JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true });
    const foreignAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, { method: "POST", headers: otherHeaders, body: responseBody });
    assert.equal(foreignAnswer.status, 409);
    const foreignKeepAlive = await fetch(`${origin}/api/v1/ui-keepalive/dialog-1`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ sessionGeneration: 1 }),
    });
    assert.equal(foreignKeepAlive.status, 409);
    const keepAlive = await fetch(`${origin}/api/v1/ui-keepalive/dialog-1`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ sessionGeneration: 1 }),
    });
    assert.equal(keepAlive.status, 200);
    assert.deepEqual(driver.keepAlives, [{ requestId: "dialog-1", sessionGeneration: 1 }]);

    const release = await fetch(`${origin}/api/v1/ui-ownership/dialog-1`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ sessionGeneration: 1, action: "release" }) });
    assert.equal(release.status, 200);
    const releasedOwnerAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, { method: "POST", headers: mutationHeaders, body: responseBody });
    assert.equal(releasedOwnerAnswer.status, 409);
    const claim = await fetch(`${origin}/api/v1/ui-ownership/dialog-1`, { method: "POST", headers: otherHeaders, body: JSON.stringify({ sessionGeneration: 1, action: "claim" }) });
    assert.equal(claim.status, 200);
    const transferredAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, { method: "POST", headers: otherHeaders, body: responseBody });
    assert.equal(transferredAnswer.status, 200);
    assert.equal(driver.answers.at(-1)?.confirmed, true);
    const duplicateAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, { method: "POST", headers: otherHeaders, body: responseBody });
    assert.equal(duplicateAnswer.status, 409);

    driver.dialogMethod = "questionnaire";
    const questionnaire = await fetch(`${origin}/api/v1/commands`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ type: "prompt", commandId: "questionnaire", expectedGeneration: 1, message: "clarify" }),
    });
    assert.equal(questionnaire.status, 200);
    const questionnaireBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, {
      headers: { cookie, "x-pylon-tab-id": tab },
    }));
    assert.equal((questionnaireBoot.pendingUi as { owned: boolean }).owned, true);
    assert.equal((questionnaireBoot.pendingUi as { method: string }).method, "questionnaire");
    const questionnaireKeepAlive = await fetch(`${origin}/api/v1/ui-keepalive/dialog-2`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ sessionGeneration: 1 }),
    });
    assert.equal(questionnaireKeepAlive.status, 200);
    const questionnaireAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-2`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ sessionGeneration: 1, method: "questionnaire", answers: ["Tests"] }),
    });
    assert.equal(questionnaireAnswer.status, 200);
    assert.deepEqual(driver.answers.at(-1)?.answers, ["Tests"]);

    const editCommand = {
      type: "editPrompt",
      entryId: "entry-1",
      message: "Updated prompt",
      images,
      rollbackFiles: true,
      commandId: "edit-once",
      expectedGeneration: 1,
    };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(editCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(editCommand) })).status, 200);
    assert.equal(driver.edits.length, 1);
    assert.equal(driver.edits[0]?.entryId, "entry-1");
    assert.equal(driver.edits[0]?.rollbackFiles, true);
    assert.deepEqual(driver.edits[0]?.images, images);
    const rewindCommand = {
      type: "rewindPrompt",
      entryId: "entry-1",
      commandId: "rewind-once",
      expectedGeneration: 1,
    };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(rewindCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(rewindCommand) })).status, 200);
    assert.equal(driver.rewinds.length, 1);

    const sessions = await fetch(`${origin}/api/v1/sessions`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(sessions.status, 200);
    const sessionList = await body(sessions);
    assert.equal((sessionList.projects as unknown[]).length, 1);
    assert.equal((sessionList.activeSessions as unknown[]).length, 1);
    const invalidCursor = await fetch(`${origin}/api/v1/sessions?cursor=not-valid`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(invalidCursor.status, 400);
    const history = await fetch(`${origin}/api/v1/conversation-history?cursor=${encodeHistoryCursor(100)}&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(history.status, 200);
    assert.equal(((await body(history)).messages as unknown[]).length, 1);
    const staleHistory = await fetch(`${origin}/api/v1/conversation-history?cursor=${encodeHistoryCursor(100)}&generation=2`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(staleHistory.status, 409);
    const invalidHistory = await fetch(`${origin}/api/v1/conversation-history?cursor=not-valid&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(invalidHistory.status, 400);
    const files = await fetch(`${origin}/api/v1/file-suggestions?q=src&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(files.status, 200);
    assert.deepEqual((await body(files)).paths, ["src/index.ts"]);
    assert.equal((await fetch(`${origin}/api/v1/file-suggestions?q=src&generation=2`, { headers: { cookie, "x-pylon-tab-id": tab } })).status, 409);
    assert.equal((await fetch(`${origin}/api/v1/file-suggestions?q=${"x".repeat(201)}&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } })).status, 400);
    const archives = await fetch(`${origin}/api/v1/archives`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(archives.status, 200);
    assert.deepEqual((await body(archives)).projects, []);
    const invalidArchiveCursor = await fetch(`${origin}/api/v1/archives?cursor=not-valid`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(invalidArchiveCursor.status, 400);
    const packages = await fetch(`${origin}/api/v1/packages`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(packages.status, 200);
    assert.equal(((await body(packages)).packages as unknown[]).length, 1);
    const settingsCommand = {
      type: "updatePackageSettings",
      packageId: "pi-advisor",
      settings: { kind: "advisor", mode: "session", thinking: "high" },
      commandId: "settings-once",
      expectedGeneration: 1,
    };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(settingsCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(settingsCommand) })).status, 200);
    assert.equal(driver.packageSettingsUpdates.length, 1);
    const indexCommand = { type: "rebuildDiscoverIndex", commandId: "index-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(indexCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(indexCommand) })).status, 200);
    assert.equal(driver.indexRebuilds, 1);

    const timeline = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "timeline", action: "fork", checkpointId: "session-1:checkpoint-1", commandId: "timeline-fork", expectedGeneration: 1 }) });
    assert.equal(timeline.status, 200);
    assert.equal(driver.prompts.at(-1), "/timeline fork session-1:checkpoint-1");
    const injectedTimeline = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "timeline", action: "restore", checkpointId: "bad id /clear", commandId: "timeline-injected", expectedGeneration: 1 }) });
    assert.equal(injectedTimeline.status, 400);

    const modelCommand = { type: "setModel", provider: "mock", modelId: "next", commandId: "model-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(modelCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(modelCommand) })).status, 200);
    assert.deepEqual(driver.selectedModels, [{ provider: "mock", modelId: "next" }]);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "setThinkingLevel", level: "high", commandId: "thinking-once", expectedGeneration: 1 }) })).status, 200);
    assert.deepEqual(driver.selectedThinking, ["high"]);
    const controlsCommand = { type: "setSessionControls", provider: "mock", modelId: "atomic", thinkingLevel: "medium", commandId: "controls-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(controlsCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(controlsCommand) })).status, 200);
    assert.deepEqual(driver.selectedModels.at(-1), { provider: "mock", modelId: "atomic" });
    assert.equal(driver.selectedThinking.at(-1), "medium");

    const queueCommand = { type: "queuePrompt", message: "queued message", images, planMode: true, commandId: "queue-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(queueCommand) })).status, 200);
    const queuedPayload = await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(queuedPayload.status, 200);
    assert.deepEqual(await body(queuedPayload), { id: "queue-1", message: "queued message", images, planMode: true });
    assert.equal((await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=2`, { headers: { cookie, "x-pylon-tab-id": tab } })).status, 409);
    const restoreCommand = { type: "restoreQueuedPrompt", queueId: "queue-1", commandId: "restore-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(restoreCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=1`, { headers: { cookie, "x-pylon-tab-id": tab } })).status, 409);

    const renameProjectCommand = { type: "renameProject", projectId: "project-workspace", name: "Renamed project", commandId: "rename-project-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(renameProjectCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(renameProjectCommand) })).status, 200);
    assert.deepEqual(driver.renamedProjects, [{ projectId: "project-workspace", name: "Renamed project" }]);

    const renameCommand = { type: "renameSession", sessionId: "session-old", name: "Renamed", commandId: "rename-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(renameCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(renameCommand) })).status, 200);
    assert.deepEqual(driver.renamedSessions, [{ sessionId: "session-old", name: "Renamed" }]);
    const activeCommand = { type: "setSessionActive", sessionId: "session-old", active: true, commandId: "active-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(activeCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(activeCommand) })).status, 200);
    assert.deepEqual(driver.activatedSessions, [{ sessionId: "session-old", active: true }]);
    const pinCommand = { type: "setSessionPinned", sessionId: "session-old", pinned: true, commandId: "pin-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(pinCommand) })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(pinCommand) })).status, 200);
    assert.deepEqual(driver.pinnedSessions, [{ sessionId: "session-old", pinned: true }]);

    const deleteCommand = { type: "deleteSession", sessionId: "session-old", commandId: "delete-once", expectedGeneration: 1 };
    const deleted = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(deleteCommand) });
    assert.equal(deleted.status, 200);
    assert.equal((await body(deleted)).sessionGeneration, 1);
    const replayDelete = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(deleteCommand) });
    assert.equal(replayDelete.status, 200);
    assert.deepEqual(driver.deletedSessions, ["session-old"]);

    const forkCommand = { type: "fork", entryId: "entry-1", name: "Forked session", mode: "conversation", commandId: "fork-once", expectedGeneration: 1 };
    assert.equal((await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(forkCommand) })).status, 200);
    assert.equal(driver.forks.length, 1);
    assert.deepEqual(driver.forks[0], {
      expectedGeneration: 1,
      entryId: "entry-1",
      name: "Forked session",
      position: undefined,
      mode: "conversation",
    });

    const replacement = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "newSession", parentSessionId: "session-1", commandId: "replace-once", expectedGeneration: 1 }) });
    assert.equal(replacement.status, 200);
    assert.equal(driver.newSessionParent, "session-1");
    assert.equal((await body(replacement)).sessionGeneration, 2);
    const replacedBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }));
    assert.equal((replacedBoot.runtime as RuntimeSnapshot).sessionId, "session-2");
    assert.equal((replacedBoot.runtime as RuntimeSnapshot).cwdLabel, "other-workspace");
    assert.equal(replacedBoot.pendingUi, undefined);
    const replayReplacement = await fetch(`${origin}/api/v1/commands`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ type: "newSession", commandId: "replace-once", expectedGeneration: 1 }) });
    assert.equal(replayReplacement.status, 409);
  } finally {
    abortSse.abort();
    abortOtherSse.abort();
    transport.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("dialog owner reconnect preserves Guard confirmation and owner loss releases it", { timeout: 10_000 }, async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`], dialogReconnectGraceMs: 500 });
  const tab = "guard-owner";
  let stream = new AbortController();
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const boot = await body(bootstrap);
    const headers = { cookie, "content-type": "application/json", "x-pylon-csrf": String(boot.csrfToken), "x-pylon-tab-id": tab };
    await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: stream.signal });
    const prompt = (commandId: string) => fetch(`${origin}/api/v1/commands`, {
      method: "POST", headers, body: JSON.stringify({ type: "prompt", commandId, expectedGeneration: 1, message: "risky action" }),
    });

    assert.equal((await prompt("guard-reconnect")).status, 200);
    stream.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reconnectBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }));
    assert.equal((reconnectBoot.pendingUi as { owned: boolean }).owned, true);
    stream = new AbortController();
    await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:${String(reconnectBoot.sequence)}`, { headers: { cookie }, signal: stream.signal });
    const allow = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
      method: "POST", headers, body: JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true }),
    });
    assert.equal(allow.status, 200);
    assert.equal(driver.answers.at(-1)?.confirmed, true);

    assert.equal((await prompt("guard-owner-loss")).status, 200);
    stream.abort();
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.notEqual(driver.answers.at(-1)?.requestId, "dialog-2");
    const otherTab = "guard-observer";
    const otherBoot = await body(await fetch(`${origin}/api/v1/bootstrap`, {
      headers: { cookie, "x-pylon-tab-id": otherTab },
    }));
    assert.equal((otherBoot.pendingUi as { ownershipAvailable: boolean }).ownershipAvailable, true);
    const otherStream = new AbortController();
    await fetch(`${origin}/api/v1/events?tabId=${otherTab}&cursor=1:${String(otherBoot.sequence)}`, {
      headers: { cookie },
      signal: otherStream.signal,
    });
    const otherHeaders = { ...headers, "x-pylon-tab-id": otherTab };
    const claim = await fetch(`${origin}/api/v1/ui-ownership/dialog-2`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ sessionGeneration: 1, action: "claim" }),
    });
    assert.equal(claim.status, 200);
    const answer = await fetch(`${origin}/api/v1/ui-responses/dialog-2`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true }),
    });
    assert.equal(answer.status, 200);
    otherStream.abort();
  } finally {
    stream.abort();
    transport.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

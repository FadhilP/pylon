import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnotationList, AnnotationMutation, AnnotationRequest } from "../src/shared/workspace/annotations.ts";
import type { WorkspaceMutationInput } from "../src/shared/workspace/workspace-mutations.ts";
import type { GitActionInput, GitDetailQuery } from "../src/shared/workspace/git.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { AcceptedCommand, QueuedPromptPayload } from "../src/shared/protocol/commands.ts";
import type { HeliosBrowserInput } from "../src/shared/protocol/helios.ts";
import type { HeliosAndroidToolingCommand } from "../src/shared/protocol/helios-android-tooling.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type {
  ArchiveListSnapshot,
  ConversationAttachmentContent,
  ConversationHistoryPage,
  ExtensionListSnapshot,
  FileSuggestionList,
  HookSettingsReadModel,
  HookSettingsSnapshot,
  LocalImageContent,
  PackageListSnapshot,
  PapercutMutationResult,
  RuntimeSnapshot,
  SessionListSnapshot,
  SkillListSnapshot,
  StateQLCommandInput,
  StateQLCommandResult,
  StateQLSnapshot,
  UsageQuery,
  UsageSnapshot,
  WorkspaceFileHistory,
} from "../src/shared/protocol/snapshots.ts";
import type { FileHistoryQuery } from "pylon-core/src/file-history.ts";
import { isStateQLCommandInput } from "../src/shared/protocol/validation.ts";
import { ServerTransport } from "../src/server/http/router.ts";
import { startPylonServer } from "../src/server/index.ts";
import type {
  DriverEvent,
  DriverEventListener,
  EditPromptInput,
  ForkInput,
  HeliosBrowserFrame,
  HeliosBrowserStreamInput,
  PapercutMutationInput,
  PiDriver,
  PromptInput,
  QueueMutationInput,
  ReplacementResult,
  RewindPromptInput,
  RuntimeHandle,
  RuntimeTarget,
  SetSessionControlsInput,
  UpdateHookSettingsInput,
} from "../src/server/runtime/pi-driver.ts";
import type { UiResponse } from "../src/server/runtime/remote-ui-bridge.ts";
import { initialOperational } from "../src/server/runtime/operational-projections.ts";
import { encodeHistoryCursor } from "../src/server/runtime/projections.ts";

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
  conversation: {
    messages: [],
    tools: [],
    delegatedRuns: [],
    streaming: false,
    queue: { steering: 0, followUp: 0 },
    retry: { active: false },
    compaction: { active: false },
  },
  sessionControls: {
    model: { provider: "mock", id: "test", name: "Test" },
    models: [{ provider: "mock", id: "test", name: "Test" }],
    thinkingLevel: "medium",
    thinkingLevels: ["low", "medium", "high"],
  },
  runtimePolicy: {
    revision: 1,
    global: {
      timelineEnabled: true,
      guardEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    project: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      guardEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    session: {},
    effective: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      guardEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    availableVerifyChecks: [],
  },
  metrics: {
    model: "test",
    provider: "mock",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextLimit: 1,
    contextPercent: 0,
    cost: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
  },
  operational: initialOperational([], []),
  extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
};

test("annotation APIs protect private drafts with tab, CSRF, session and generation guards", async () => {
  let writes = 0;
  const saved: AnnotationList = { scope: "server-owned-scope", sessionId: "session-1", sessionGeneration: 1, notes: [] };
  class NotesDriver extends FakeDriver {
    async annotationNotes(_input: AnnotationRequest) { return structuredClone(saved); }
    async mutateAnnotation(input: AnnotationMutation) {
      if (input.note?.scope !== saved.scope) throw Object.assign(new Error("scope mismatch"), { statusCode: 400 });
      const previous = saved.notes.find(note => note.id === input.id);
      if (previous?.version !== input.expectedVersion) throw Object.assign(new Error("stale note"), { statusCode: 409 });
      saved.notes = input.note ? [input.note] : []; writes++; return structuredClone(saved);
    }
  }
  const driver = new NotesDriver();
  const running = await startIsolatedServer({ port: 0, development: false, driver });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  const tab = "annotation-tab";
  const abort = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/v1/annotations?generation=1&sessionId=session-1`)).status, 403);
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const csrf = String((await body(bootstrap)).csrfToken);
    const headers = { cookie, "content-type": "application/json", "x-pylon-csrf": csrf, "x-pylon-tab-id": tab };
    const input: AnnotationMutation = { sessionId: "session-1", expectedGeneration: 1, id: "00000000-0000-4000-8000-000000000001", note: {
      id: "00000000-0000-4000-8000-000000000001", scope: saved.scope, version: 1, body: "Private review draft", path: "src/file.ts",
      from: 1, to: 1, code: "private source", kind: "historical", revision: "commit:1",
    } };
    const send = (value: unknown, h = headers) => fetch(`${origin}/api/v1/annotations`, { method: "POST", headers: h, body: JSON.stringify(value) });
    assert.equal((await send(input)).status, 409); // No SSE presence yet.
    const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: abort.signal });
    await events.body!.getReader().read();
    assert.equal((await send(input, { ...headers, "x-pylon-csrf": "invalid" })).status, 403);
    assert.equal((await send({ ...input, sessionId: "another-session" })).status, 409);
    assert.equal((await send({ ...input, expectedGeneration: 2 })).status, 409);
    assert.equal((await send({ ...input, note: { ...input.note, path: "../escape" } })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await send(input)).status, 200);
    assert.equal((await send(input)).status, 409); // Ambiguous retries never overwrite.
    assert.equal(writes, 1);
    const read = await fetch(`${origin}/api/v1/annotations?generation=1&sessionId=session-1`, { headers });
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal(((await body(read)).notes as Array<{ body: string }>)[0].body, "Private review draft");
    assert.deepEqual((await driver.snapshot()).conversation.messages, []); // Saving is not an agent prompt.
    assert.equal((await fetch(`${origin}/api/v1/annotations?generation=1&sessionId=other`, { headers })).status, 409);
  } finally { abort.abort(); await running.close(); }
});

test("workspace saves transport large text once and reject unsafe or stale requests before mutation", async () => {
  let saved = "";
  let writes = 0;
  class EditingDriver extends FakeDriver {
    async mutateWorkspace(input: WorkspaceMutationInput) {
      if (input.mutation.action === "save") { saved = input.mutation.text; writes++; }
      return { savedVersion: "b".repeat(64) };
    }
    async workspaceEntry(path: string) {
      return { sessionId: "session-1", sessionGeneration: 1, path, kind: "file" as const, entries: 1, version: "a".repeat(64), text: saved };
    }
  }
  const running = await startIsolatedServer({ port: 0, development: false, driver: new EditingDriver() });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  const tab = "workspace-edit-tab";
  const abort = new AbortController();
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const csrf = String((await body(bootstrap)).csrfToken);
    const headers = { cookie, "content-type": "application/json", "x-pylon-csrf": csrf, "x-pylon-tab-id": tab };
    const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: abort.signal });
    await events.body!.getReader().read();
    const command = { type: "mutateWorkspace", commandId: "save-large", expectedGeneration: 1, sessionId: "session-1",
      mutation: { action: "save", path: "large.txt", expectedVersion: "a".repeat(64), text: "x".repeat(512 * 1024) } };
    const send = (input: unknown, requestHeaders = headers) => fetch(`${origin}/api/v1/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify(input) });
    assert.equal((await send(command, { ...headers, "x-pylon-csrf": "invalid" })).status, 403);
    assert.equal((await send({ ...command, expectedGeneration: 2 })).status, 409);
    assert.equal((await send({ ...command, mutation: { action: "createFile", path: "../escape" } })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await body(await send(command))).savedVersion, "b".repeat(64));
    assert.equal((await body(await send(command))).savedVersion, "b".repeat(64), "idempotent retries return the same save receipt");
    assert.equal(writes, 1);
    assert.equal(saved, command.mutation.text);
    const entry = await fetch(`${origin}/api/v1/workspace/entry?generation=1&path=large.txt`, { headers: { cookie, "x-pylon-tab-id": tab } });
    assert.equal(entry.status, 200);
    assert.equal((await body(entry)).text, saved);
    assert.equal((await send({ ...command, commandId: "too-large", mutation: { ...command.mutation, text: "x".repeat(1024 * 1024 + 1) } })).status, 400);
    assert.equal(writes, 1);
  } finally { abort.abort(); await running.close(); }
});

test("Git transport protects actions and cancels disconnected detail readers", { timeout: 10_000 }, async () => {
  class GitDriver extends FakeDriver {
    gitActions = 0;
    pendingDetail?: { started(): void; cancelled(): void };
    workspaceGitState() {
      return Promise.resolve({
        available: true, revision: "a".repeat(64), remotes: [], branches: [], files: [], history: [], stashes: [],
        sessionId: "session-1", sessionGeneration: 1,
      });
    }
    workspaceGitDetail(_query: GitDetailQuery, signal?: AbortSignal) {
      if (this.pendingDetail) return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { this.pendingDetail!.cancelled(); reject(signal.reason); }, { once: true });
        this.pendingDetail!.started();
      });
      return Promise.resolve({
        revision: "a".repeat(64), files: [], unifiedDiff: "", sessionId: "session-1", sessionGeneration: 1,
      });
    }
    gitAction(_input: { commandId: string; sessionId: string; expectedGeneration: number; input: GitActionInput }) {
      this.gitActions++;
      return Promise.resolve({ commandId: _input.commandId, sessionGeneration: 1, accepted: true } as const);
    }
  }
  const driver = new GitDriver();
  const running = await startIsolatedServer({ port: 0, development: false, driver });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  const tab = "git-tab";
  const abort = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/v1/workspace/git?sessionGeneration=1`)).status, 403);
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const csrf = String((await body(bootstrap)).csrfToken);
    const headers = { cookie, "content-type": "application/json", "x-pylon-csrf": csrf, "x-pylon-tab-id": tab };
    assert.equal((await fetch(`${origin}/api/v1/workspace/git?sessionGeneration=2`, { headers })).status, 409);
    assert.equal((await fetch(`${origin}/api/v1/workspace/git-detail?sessionGeneration=1&query=not-json`, { headers })).status, 400);
    assert.equal((await body(await fetch(`${origin}/api/v1/workspace/git?sessionGeneration=1`, { headers }))).revision, "a".repeat(64));
    const detail = encodeURIComponent(JSON.stringify({ kind: "history", ref: "HEAD" }));
    assert.equal((await fetch(`${origin}/api/v1/workspace/git-detail?sessionGeneration=1&query=${detail}`, { headers })).status, 200);
    const command = { type: "gitAction", commandId: "git-stage", expectedGeneration: 1, sessionId: "session-1",
      input: { action: "stage", expectedRevision: "a".repeat(64), paths: ["file.ts"] } };
    const send = (value: unknown, requestHeaders = headers) => fetch(`${origin}/api/v1/commands`, { method: "POST", headers: requestHeaders, body: JSON.stringify(value) });
    assert.equal((await send(command, { ...headers, "x-pylon-csrf": "invalid" })).status, 403);
    assert.equal((await send({ ...command, input: { ...command.input, expectedRevision: "bad" } })).status, 400);
    assert.equal((await send(command)).status, 409); // A mutating command needs an SSE-owned tab.
    const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: abort.signal });
    await events.body!.getReader().read();
    assert.equal((await send(command)).status, 200);
    assert.equal((await send(command)).status, 200);
    assert.equal(driver.gitActions, 1, "Git actions use command idempotency");
    let started!: () => void, cancelled!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    driver.pendingDetail = { started, cancelled };
    const readAbort = new AbortController();
    const request = fetch(`${origin}/api/v1/workspace/git-detail?sessionGeneration=1&query=${detail}`, { headers, signal: readAbort.signal });
    const rejected = assert.rejects(request, /abort/i);
    await began;
    readAbort.abort();
    await rejected;
    await stopped;
  } finally { abort.abort(); await running.close(); }
});

test("editable entry reads complete while optional Git comparison is still pending", { timeout: 10_000 }, async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const comparisonStarted = new Promise<void>(resolve => { started = resolve; });
  class EditingDriver extends FakeDriver {
    async workspaceEntry(path: string, _destination?: string, includeGitIndex = true) {
      if (includeGitIndex) await waiting;
      return { sessionId: "session-1", sessionGeneration: 1, path, kind: "file" as const, entries: 1, version: "a".repeat(64), text: "editable now" };
    }
    async workspaceGitIndex() {
      started(); await waiting;
      return { sessionId: "session-1", sessionGeneration: 1, text: "indexed text" };
    }
  }
  const running = await startIsolatedServer({ port: 0, development: false, driver: new EditingDriver() });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": "optional-index" } });
    const headers = { cookie: (bootstrap.headers.get("set-cookie") ?? "").split(";")[0], "x-pylon-tab-id": "optional-index" };
    const index = fetch(`${origin}/api/v1/workspace/index?generation=1&path=file.ts`, { headers });
    await comparisonStarted;
    const entry = await fetch(`${origin}/api/v1/workspace/entry?generation=1&path=file.ts&gitIndex=false`, { headers });
    assert.equal(entry.status, 200);
    assert.equal((await body(entry)).text, "editable now");
    assert.equal((await fetch(`${origin}/api/v1/workspace/index?generation=2&path=file.ts`, { headers })).status, 409);
    assert.equal((await fetch(`${origin}/api/v1/workspace/index?generation=1&path=../outside`, { headers })).status, 400);
    release();
    assert.equal((await body(await index)).text, "indexed text");
  } finally { release(); await running.close(); }
});

test("StateQL HTTP command validation accepts native Mongo commands and rejects irrelevant or oversized payloads", () => {
  const read = {
    command: "mongo.query",
    mongo: { operation: "find", collection: "users", filter: { active: true }, options: { limit: 10 } },
  };
  const write = {
    command: "mongo.exec",
    mongo: { operation: "updateOne", collection: "users", filter: { id: 1 }, update: { $set: { active: false } } },
  };
  assert.equal(isStateQLCommandInput(read), true);
  assert.equal(isStateQLCommandInput(write), true);
  assert.equal(isStateQLCommandInput({ ...read, sql: "SELECT 1" }), false);
  assert.equal(
    isStateQLCommandInput({ command: "mongo.query", mongo: { operation: "find", collection: "users", extra: true } }),
    false,
  );
  assert.equal(
    isStateQLCommandInput({
      command: "mongo.query",
      mongo: { operation: "find", collection: "users", filter: { payload: "x".repeat(33 * 1024) } },
    }),
    false,
  );
  assert.equal(
    isStateQLCommandInput({ command: "exec", sql: "UPDATE users SET active = false", timeout_ms: 0 }),
    false,
  );
});

test("transport keeps backpressured SSE clients until the connection actually closes", async () => {
  const driver = new FakeDriver();
  const transport = new ServerTransport(driver, structuredClone(snapshot), {
    allowedHosts: ["localhost"],
    dialogReconnectGraceMs: 5,
  });
  const session = { secret: "secret", csrfToken: "csrf", tabs: new Set(["slow-tab"]) };
  let ended = 0;
  const response = {
    write: () => false,
    end: () => {
      ended++;
    },
    writableEnded: false,
  };
  const heartbeat = setInterval(() => {}, 10_000);
  const client = { response, session, tabId: "slow-tab", heartbeat };
  (transport as any).clients.add(client);
  (transport as any).publish("test.event", { value: true });
  assert.equal((transport as any).clients.size, 1);
  assert.equal(ended, 0);

  (transport as any).removeClient(client);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(session.tabs.has("slow-tab"), false);
  transport.dispose();
});

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
  hookSettingsUpdates: HookSettingsReadModel[] = [];
  localImageSources: string[] = [];
  planActions: unknown[] = [];
  hookSettings: HookSettingsReadModel = {
    sessionStart: { enabled: false, sources: [] },
    beforeAgentStart: { enabled: false, sources: [] },
  };
  indexRebuilds = 0;
  newSessionParent?: string;
  modelRefreshes = 0;
  modelRefreshFailure?: Error;
  heliosRequests: HeliosBrowserInput[] = [];
  heliosStreamRequests: HeliosBrowserStreamInput[] = [];
  heliosAndroidToolingRequests: HeliosAndroidToolingCommand[] = [];
  stateqlHistoryLimits: number[] = [];
  stateqlRowsRequests: Array<{ handle: string; offset: number; limit: number }> = [];
  stateqlCommands: StateQLCommandInput[] = [];
  papercutMutations: PapercutMutationInput[] = [];
  usageDays: number[] = [];
  usageQueries: UsageQuery[] = [];
  fileHistoryQueries: FileHistoryQuery[] = [];
  deferDialog = false;
  dialogMethod: "confirm" | "questionnaire" = "confirm";
  private pendingDialog?: DriverEvent;
  start(_target: RuntimeTarget): Promise<RuntimeHandle> {
    return Promise.resolve({ sessionId: "session-1", sessionGeneration: 1 });
  }
  snapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve(structuredClone(this.current));
  }
  terminalTarget() {
    return { sessionId: this.current.sessionId, sessionGeneration: this.current.sessionGeneration, cwd: process.cwd() };
  }
  conversationHistory(): Promise<ConversationHistoryPage> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      messages: [{ id: "history-0", role: "user", text: "Earlier message", streaming: false }],
      remaining: 0,
    });
  }
  conversationAttachment(): Promise<ConversationAttachmentContent> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      kind: "image",
      name: "Image 1",
      mimeType: "image/png",
      size: 1,
      data: "eA==",
    });
  }
  localImage(input: { source: string }): Promise<LocalImageContent> {
    this.localImageSources.push(input.source);
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      kind: "image",
      name: "chart.png",
      mimeType: "image/png",
      size: 1,
      data: "eA==",
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
  fileHistory(input: FileHistoryQuery): Promise<WorkspaceFileHistory> {
    this.fileHistoryQueries.push(input);
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      path: input.path,
      revision: "revision-1",
      stops: [],
      sessionAvailable: true,
      baselineAvailable: true,
      partial: false,
      hasMore: false,
      view: input.view,
    });
  }
  listSessions(): Promise<SessionListSnapshot> {
    const session = {
      id: this.current.sessionId,
      projectId: "project-workspace",
      cwdLabel: this.current.cwdLabel,
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date(0).toISOString(),
      userMessageCount: 0,
      preview: "",
      active: true,
      pinned: false,
      runtimeState: "idle" as const,
    };
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      activeSessions: [session],
      projects: [
        { id: "project-workspace", label: "workspace", cwd: process.cwd(), totalCount: 1, sessions: [session] },
      ],
    });
  }
  usage(input: UsageQuery = {}): Promise<UsageSnapshot> {
    this.usageQueries.push(input);
    this.usageDays.push(input.days ?? 30);
    const now = new Date().toISOString();
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      generatedAt: now,
      fromInclusive: now,
      toExclusive: now,
      records: [],
      sessions: [],
      diagnostics: {
        unreadableFiles: 0,
        conflictingDuplicates: 0,
        unknownCostRecords: 0,
        unknownAttributionRecords: 0,
        truncated: false,
      },
    });
  }
  listArchived(): Promise<ArchiveListSnapshot> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      projects: [],
      sessions: [],
      sources: [],
      totalSessionCount: 0,
    });
  }
  listPackages(): Promise<PackageListSnapshot> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      packages: [
        { id: "pi-test", name: "pi-test", description: "Test package", enabled: true, active: true, extensionCount: 1 },
      ],
    });
  }
  listExtensions(): Promise<ExtensionListSnapshot> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      projectTrustRequired: false,
      projectTrusted: true,
      packages: [],
      extensions: [
        {
          id: "a".repeat(32),
          scope: "user",
          path: "extensions/test.ts",
          source: "auto",
          origin: "top-level",
          enabled: true,
          active: true,
        },
      ],
    });
  }
  listSkills(): Promise<SkillListSnapshot> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      projectTrustRequired: false,
      projectTrusted: true,
      skills: [
        {
          id: "b".repeat(32),
          name: "test-skill",
          description: "Tests skill transport.",
          scope: "user",
          path: "skills/test-skill/SKILL.md",
          source: "auto",
          origin: "top-level",
          manualOnly: false,
        },
      ],
      diagnostics: [],
    });
  }
  listHookSettings(): Promise<HookSettingsSnapshot> {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      settings: structuredClone(this.hookSettings),
    });
  }
  heliosBrowser(input: HeliosBrowserInput) {
    this.heliosRequests.push(input);
    return Promise.resolve({
      version: 1 as const,
      sessionGeneration: this.current.sessionGeneration,
      active: true,
      ownership: "owned" as const,
      state: "ready" as const,
      controlled: true,
    });
  }
  async heliosBrowserStream(
    input: HeliosBrowserStreamInput,
    send: (frame: HeliosBrowserFrame) => void,
    signal: AbortSignal,
  ) {
    this.heliosStreamRequests.push(input);
    send({ mimeType: "image/jpeg", data: Buffer.from("jpeg-frame"), sequence: 1 });
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  heliosAndroidTooling(input: HeliosAndroidToolingCommand) {
    this.heliosAndroidToolingRequests.push(input);
    return Promise.resolve({
      version: 1 as const,
      sessionGeneration: this.current.sessionGeneration,
      state: "ready" as const,
      appiumVersion: "3.6.0",
      driverVersion: "8.2.2",
    });
  }
  stateqlSnapshot(historyLimit: number): Promise<StateQLSnapshot> {
    this.stateqlHistoryLimits.push(historyLimit);
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      session: { session_id: "s_1", name: "shared-workspace", status: "active" },
      actor_id: this.current.sessionId,
      connection: null,
      transaction: null,
      state_version: null,
      state_confidence: null,
      recent_results: [],
      recent_operations: [],
      history: [],
    });
  }
  stateqlRows(handle: string, offset: number, limit: number) {
    this.stateqlRowsRequests.push({ handle, offset, limit });
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      actor_id: this.current.sessionId,
      handle,
      offset,
      limit,
      rows: [{ id: 1 }],
      returned: 1,
      total: 1,
      truncated: false,
      next_offset: null,
    });
  }
  stateqlExport(_handle: string, format: "json" | "jsonl" | "csv") {
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      actor_id: this.current.sessionId,
      format,
      content: '[{"value":"complete"}]',
    });
  }
  stateqlCommand(input: StateQLCommandInput): Promise<StateQLCommandResult> {
    this.stateqlCommands.push(input);
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      actor_id: this.current.sessionId,
      command: input.command,
      status: "completed",
      response: {
        ok: true,
        command_id: `command-${this.stateqlCommands.length}`,
        session_id: "s_1",
        data: { command: input.command },
        warnings: [],
        meta: { duration_ms: 1 },
      },
    });
  }
  papercutMutation(input: PapercutMutationInput): Promise<PapercutMutationResult> {
    this.papercutMutations.push(input);
    return Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.current.sessionGeneration,
      revision: this.papercutMutations.length,
    });
  }
  prompt(input: PromptInput): Promise<AcceptedCommand> {
    this.prompts.push(input.message);
    this.promptImages.push(input.images);
    const requestId = `dialog-${++this.calls}`;
    const payload =
      this.dialogMethod === "questionnaire"
        ? { title: "Clarify", questions: [{ question: "Which target?", options: ["Tests", "Build"] }] }
        : { title: "Guard approval", message: "Allow risky action?" };
    const event: DriverEvent = {
      type: "ui.event",
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      payload: {
        kind: "request",
        requestId,
        sessionId: this.current.sessionId,
        sessionGeneration: this.current.sessionGeneration,
        method: this.dialogMethod,
        payload,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    if (this.deferDialog) this.pendingDialog = event;
    else this.emit(event);
    return Promise.resolve({
      commandId: input.commandId,
      sessionGeneration: this.current.sessionGeneration,
      accepted: true,
    });
  }
  flushDialog(): void {
    if (!this.pendingDialog) return;
    this.emit(this.pendingDialog);
    this.pendingDialog = undefined;
  }
  queuePrompt(input: PromptInput): Promise<AcceptedCommand> {
    this.queued = { id: "queue-1", message: input.message, images: input.images, planMode: input.planMode === true };
    return Promise.resolve({
      commandId: input.commandId,
      sessionGeneration: this.current.sessionGeneration,
      accepted: true,
    });
  }
  queuedPrompt(input: QueueMutationInput): Promise<QueuedPromptPayload> {
    if (!this.queued || this.queued.id !== input.queueId)
      return Promise.reject(new Error("queued prompt is unavailable"));
    return Promise.resolve(structuredClone(this.queued));
  }
  restoreQueuedPrompt(input: QueueMutationInput): Promise<void> {
    if (!this.queued || this.queued.id !== input.queueId)
      return Promise.reject(new Error("queued prompt is unavailable"));
    this.queued = undefined;
    return Promise.resolve();
  }
  steerQueuedPrompt(input: QueueMutationInput): Promise<AcceptedCommand> {
    if (!this.queued || this.queued.id !== input.queueId)
      return Promise.reject(new Error("queued prompt is unavailable"));
    this.queued = undefined;
    return Promise.resolve({
      commandId: input.commandId ?? "steer-queued",
      sessionGeneration: this.current.sessionGeneration,
      accepted: true,
    });
  }
  steer(input: PromptInput): Promise<AcceptedCommand> {
    return Promise.resolve({
      commandId: input.commandId,
      sessionGeneration: this.current.sessionGeneration,
      accepted: true,
    });
  }
  followUp(input: PromptInput): Promise<AcceptedCommand> {
    return this.steer(input);
  }
  editPrompt(input: EditPromptInput): Promise<AcceptedCommand> {
    this.edits.push(input);
    return this.steer(input);
  }
  rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand> {
    this.rewinds.push(input);
    return Promise.resolve({
      commandId: input.commandId,
      sessionGeneration: this.current.sessionGeneration,
      accepted: true,
    });
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
  addProject(): Promise<ReplacementResult> {
    return Promise.resolve(this.replace("session-project", "project-workspace"));
  }
  removeProject(): Promise<ReplacementResult> {
    return Promise.resolve(this.replace("session-project-removed", "workspace"));
  }
  renameProject(input: { projectId: string; name: string }): Promise<void> {
    this.renamedProjects.push({ projectId: input.projectId, name: input.name });
    return Promise.resolve();
  }
  reorderProject(): Promise<void> {
    return Promise.resolve();
  }
  archiveProject(): Promise<ReplacementResult> {
    return Promise.resolve(this.replace("session-project-archived", "workspace"));
  }
  restoreProject(): Promise<void> {
    return Promise.resolve();
  }
  archiveSession(): Promise<ReplacementResult> {
    return Promise.resolve(this.replace("session-archived", "workspace"));
  }
  restoreSession(): Promise<void> {
    return Promise.resolve();
  }
  reorderActiveSession(): Promise<void> {
    return Promise.resolve();
  }
  newSession(input?: { parentSessionId?: string }): Promise<ReplacementResult> {
    this.newSessionParent = input?.parentSessionId;
    return Promise.resolve(this.replace("session-2", "other-workspace"));
  }
  switchSession(input: { sessionId: string }): Promise<ReplacementResult> {
    return Promise.resolve(this.replace(input.sessionId, "switched-workspace"));
  }
  deleteSession(input: { sessionId: string }): Promise<void> {
    this.deletedSessions.push(input.sessionId);
    return Promise.resolve();
  }
  renameSession(input: { sessionId: string; name: string }): Promise<void> {
    this.renamedSessions.push(input);
    return Promise.resolve();
  }
  setSessionActive(input: { sessionId: string; active: boolean }): Promise<void> {
    this.activatedSessions.push(input);
    return Promise.resolve();
  }
  setSessionPinned(input: { sessionId: string; pinned: boolean }): Promise<void> {
    this.pinnedSessions.push(input);
    return Promise.resolve();
  }
  fork(input: ForkInput): Promise<ReplacementResult> {
    this.forks.push(input);
    return Promise.resolve({
      cancelled: true,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  setPackageEnabled(): Promise<ReplacementResult> {
    return Promise.resolve(this.replace(this.current.sessionId, this.current.cwdLabel));
  }
  updatePackageSettings(input: unknown): Promise<ReplacementResult> {
    this.packageSettingsUpdates.push(input);
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  setExtensionEnabled(): Promise<ReplacementResult> {
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  installExtensionPackage(): Promise<ReplacementResult> {
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  removeExtensionPackage(): Promise<ReplacementResult> {
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  setProjectTrust(): Promise<ReplacementResult> {
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  reloadExtensions(): Promise<ReplacementResult> {
    return Promise.resolve({
      cancelled: false,
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  updateHookSettings(input: UpdateHookSettingsInput): Promise<void> {
    this.hookSettings = structuredClone(input.settings);
    this.hookSettingsUpdates.push(structuredClone(input.settings));
    return Promise.resolve();
  }
  rebuildDiscoverIndex(): Promise<void> {
    this.indexRebuilds++;
    return Promise.resolve();
  }
  refreshModelCatalogs(): Promise<void> {
    this.modelRefreshes++;
    this.current.sessionControls.models.push({
      provider: "mock",
      id: `refreshed-${this.modelRefreshes}`,
      name: `Refreshed ${this.modelRefreshes}`,
    });
    return this.modelRefreshFailure ? Promise.reject(this.modelRefreshFailure) : Promise.resolve();
  }
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
  updateRuntimePolicy(): Promise<void> {
    return Promise.resolve();
  }
  updateContinuityMemory(): Promise<void> {
    return Promise.resolve();
  }
  deleteContinuityMemory(): Promise<void> {
    return Promise.resolve();
  }
  migrateContinuityMemory(): Promise<void> {
    return Promise.resolve();
  }
  continuityPlanAction(input: unknown): Promise<void> {
    this.planActions.push(input);
    return Promise.resolve();
  }
  answerUiRequest(input: UiResponse): Promise<void> {
    this.answers.push(input);
    this.emit({
      type: "ui.closed",
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
      requestId: input.requestId,
    });
    return Promise.resolve();
  }
  keepUiRequestAlive(requestId: string, sessionGeneration: number): void {
    this.keepAlives.push({ requestId, sessionGeneration });
  }
  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emitRuntime(runtime: RuntimeSnapshot): void {
    this.emit({
      type: "session.replaced",
      sessionId: runtime.sessionId,
      sessionGeneration: runtime.sessionGeneration,
      runtime,
    });
  }
  emitCleared(): void {
    this.current = { ...this.current, sessionGeneration: this.current.sessionGeneration + 1 };
    this.emit({
      type: "session.cleared",
      sessionId: this.current.sessionId,
      sessionGeneration: this.current.sessionGeneration,
    });
  }
  emitStatus(sessionId: string, state: "sleeping" | "idle" | "running" | "attention", completed = false): void {
    this.emit({
      type: "session.status",
      sessionId,
      sessionGeneration: this.current.sessionGeneration,
      state,
      ...(completed ? { completed: true } : {}),
    });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
  private replace(sessionId: string, cwdLabel: string): ReplacementResult {
    this.current = {
      ...structuredClone(snapshot),
      sessionId,
      cwdLabel,
      sessionGeneration: this.current.sessionGeneration + 1,
    };
    this.emit({
      type: "session.replaced",
      sessionId,
      sessionGeneration: this.current.sessionGeneration,
      runtime: structuredClone(this.current),
    });
    return { cancelled: false, sessionId, sessionGeneration: this.current.sessionGeneration };
  }
  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
async function rawStatus(url: string, headers: Record<string, string>, setHost = true): Promise<number> {
  const target = new URL(url);
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path: target.pathname, headers, setHost },
      response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function startIsolatedServer(options: Parameters<typeof startPylonServer>[0]) {
  const agentDir = mkdtempSync(join(tmpdir(), "pylon-web-transport-"));
  try {
    const running = await startPylonServer({ ...options, agentDir });
    return { ...running, async close() {
      try { await running.close(); } finally { rmSync(agentDir, { recursive: true, force: true }); }
    } };
  } catch (error) { rmSync(agentDir, { recursive: true, force: true }); throw error; }
}


test("local server rejects foreign Host before API and asset routing", async () => {
  const running = await startIsolatedServer({ port: 0, development: false, driver: new FakeDriver() });
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
  const running = await startIsolatedServer({ port: 0, development: false, driver: new FakeDriver() });
  const port = (running.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const tab = "terminal-security-tab";
  const upgradeStatus = (url: URL, cookie?: string) =>
    new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), origin } });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => {
        socket.close();
        reject(new Error("terminal upgrade unexpectedly succeeded"));
      });
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

test("terminals stay attached per session until that session deactivates", { timeout: 15_000 }, async () => {
  const driver = new FakeDriver();
  const terminals: Array<{ killed: boolean }> = [];
  const terminalSpawn = () => {
    const terminal = {
      pid: terminals.length + 1,
      cols: 80,
      rows: 24,
      process: "test-shell",
      handleFlowControl: false,
      killed: false,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      resize() {},
      clear() {},
      write() {},
      kill() {
        terminal.killed = true;
      },
      pause() {},
      resume() {},
    };
    terminals.push(terminal);
    return terminal;
  };
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`], terminalSpawn });
  server.on("upgrade", transport.handleUpgrade);
  const tab = "terminal-retention-tab";
  let first: WebSocket | undefined;
  let second: WebSocket | undefined;
  const connect = (generation: number, cookie: string, csrf: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const url = new URL(origin.replace("http:", "ws:") + "/api/v1/terminal");
      url.search = new URLSearchParams({ tabId: tab, generation: String(generation), csrf }).toString();
      const socket = new WebSocket(url, { headers: { cookie, origin } });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`terminal upgrade failed (${response.statusCode ?? 0})`));
      });
      socket.once("error", reject);
      socket.on("message", data => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "ready") resolve(socket);
      });
    });
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const csrf = String((await body(bootstrap)).csrfToken);
    first = await connect(1, cookie, csrf);
    const replacement = await driver.switchSession({ sessionId: "session-2" });
    second = await connect(replacement.sessionGeneration, cookie, csrf);
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(second.readyState, WebSocket.OPEN);
    assert.equal(terminals.length, 2);
    await driver.switchSession({ sessionId: "session-1" });
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(second.readyState, WebSocket.OPEN);

    const firstClosed = new Promise<void>(resolve => first!.once("close", () => resolve()));
    driver.emitStatus("session-1", "sleeping");
    await firstClosed;
    assert.equal(terminals[0].killed, true);
    assert.equal(terminals[1].killed, false);
    assert.equal(second.readyState, WebSocket.OPEN);
  } finally {
    first?.close();
    second?.close();
    server.off("upgrade", transport.handleUpgrade);
    transport.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
  assert.equal(terminals[1].killed, true);
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
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
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
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test("bootstrap represents a cleared session selection without a fake runtime", async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`] });
  try {
    driver.emitCleared();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
      headers: { "x-pylon-tab-id": "empty-selection-tab" },
    });
    assert.equal(response.status, 200);
    const boot = await body(response);
    assert.equal(boot.runtime, null);
    assert.equal(boot.sessionGeneration, 2);
  } finally {
    transport.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test("keyboard preferences are sessionless, CSRF protected, replayable and reject stale browser writes", async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`] });
  const stream = new AbortController();
  const timeout = setTimeout(() => stream.abort(), 5_000);
  try {
    driver.emitCleared();
    const connect = async (tab: string) => {
      const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
      const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
      const boot = await body(response);
      assert.equal(boot.runtime, null);
      assert.deepEqual(boot.keyboardSettings, { revision: 0, keymap: { preset: "pylon", overrides: {} } });
      return { boot, headers: { cookie, "x-pylon-tab-id": tab, "x-pylon-csrf": String(boot.csrfToken), "content-type": "application/json" } };
    };
    const first = await connect("keyboard-first");
    const second = await connect("keyboard-second");
    const keymap: import("../src/shared/settings/keyboard.ts").Keymap = { preset: "pylon", overrides: { theme: { kind: "chord", key: "F8", modifiers: [] } } };
    const post = (headers: Record<string, string>, revision: number, map = keymap) => fetch(`${origin}/api/v1/settings/keyboard`, { method: "POST", headers, body: JSON.stringify({ revision, keymap: map }) });
    assert.equal((await fetch(`${origin}/api/v1/settings/keyboard`)).status, 403);
    assert.equal((await post({ ...first.headers, "x-pylon-csrf": "wrong" }, 0)).status, 403);
    assert.equal((await post({ ...first.headers, "x-pylon-tab-id": "unknown" }, 0)).status, 403);
    assert.equal((await post(first.headers, 0, { ...keymap, overrides: { theme: { kind: "chord", key: "T", modifiers: ["Mod"] } } })).status, 400);
    const saved = await post(first.headers, 0);
    assert.equal(saved.status, 200);
    assert.deepEqual(await body(saved), { revision: 1, keymap });
    const stale = await post(second.headers, 0);
    assert.equal(stale.status, 409);
    assert.deepEqual((await body(stale)).current, { revision: 1, keymap });
    const events = await fetch(`${origin}/api/v1/events?tabId=keyboard-second&cursor=${second.boot.sessionGeneration}:${second.boot.sequence}`, { headers: second.headers, signal: stream.signal });
    const reader = events.body!.getReader();
    let data = "";
    const until = async (revision: number) => {
      while (!data.includes(`\"revision\":${revision}`)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        data += new TextDecoder().decode(chunk.value);
      }
      assert.match(data, /event: keyboard.settings/);
    };
    await until(1); // The second browser replays a write made after its bootstrap cursor.
    assert.equal((await post(second.headers, 1)).status, 200);
    await until(2); // Live delivery uses the same channel.
    driver.emitRuntime({ ...structuredClone(snapshot), sessionId: "next", sessionGeneration: 3 });
    const after = await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: first.headers }));
    assert.deepEqual(after.keyboardSettings, { revision: 2, keymap });
  } finally {
    clearTimeout(timeout); stream.abort(); transport.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test("bootstrap snapshots completions at its cursor and later completions replay", async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, { allowedHosts: [`127.0.0.1:${port}`] });
  const tab = "completion-tab";
  const stream = new AbortController();
  try {
    driver.emitStatus("before-bootstrap", "idle", true);
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const boot = await body(bootstrap);
    assert.deepEqual(boot.unseenCompletionSessionIds, ["before-bootstrap"]);

    driver.emitStatus("after-bootstrap", "sleeping", true);
    const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:${String(boot.sequence)}`, {
      headers: { cookie },
      signal: stream.signal,
    });
    const chunk = await events.body!.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /after-bootstrap[\s\S]+"completed":true/);

    const current = await body(
      await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
    );
    assert.deepEqual(current.unseenCompletionSessionIds, ["before-bootstrap", "after-bootstrap"]);
    driver.emitRuntime({ ...structuredClone(snapshot), sessionId: "before-bootstrap", sessionGeneration: 2 });
    const selected = await body(
      await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
    );
    assert.deepEqual(selected.unseenCompletionSessionIds, ["after-bootstrap"]);
  } finally {
    stream.abort();
    transport.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test(
  "transport enforces origin, CSRF, size, generation, readiness, idempotency, and dialog ownership",
  { timeout: 10_000 },
  async () => {
    const driver = new FakeDriver();
    let transport: ServerTransport;
    const server = createServer((request, response) => void transport.handle(request, response));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
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

      const foreign = await fetch(`${origin}/api/v1/bootstrap`, {
        headers: { origin: "http://evil.invalid", "x-pylon-tab-id": tab },
      });
      assert.equal(foreign.status, 403);
      assert.equal(await rawStatus(`${origin}/api/v1/bootstrap`, { host: "evil.invalid", "x-pylon-tab-id": tab }), 403);
      const crossSite = await fetch(`${origin}/api/v1/bootstrap`, {
        headers: { "sec-fetch-site": "cross-site", "x-pylon-tab-id": tab },
      });
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
      const mutationHeaders = {
        cookie,
        "content-type": "application/json",
        "x-pylon-csrf": csrf,
        "x-pylon-tab-id": tab,
      };

      const malformedPath = await fetch(`${origin}/api/v1/ui-responses/%E0%A4%A`, {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      });
      assert.equal(malformedPath.status, 400);
      const noStream = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ type: "prompt", commandId: "before-stream", expectedGeneration: 1, message: "hello" }),
      });
      assert.equal(noStream.status, 409);
      const noStreamBrowser = await fetch(`${origin}/api/v1/helios-browser`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ action: "status", expectedGeneration: 1 }),
      });
      assert.equal(noStreamBrowser.status, 409);
      const noStreamAndroidTooling = await fetch(`${origin}/api/v1/helios-android-tooling`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ action: "status", expectedGeneration: 1 }),
      });
      assert.equal(noStreamAndroidTooling.status, 409);
      const badCsrf = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
        body: JSON.stringify({ type: "abort", commandId: "bad", expectedGeneration: 1 }),
      });
      assert.equal(badCsrf.status, 403);
      const stale = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ type: "abort", commandId: "stale", expectedGeneration: 2 }),
      });
      assert.equal(stale.status, 409);
      const oversized = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          type: "prompt",
          commandId: "large",
          expectedGeneration: 1,
          message: "x".repeat(129 * 1024),
        }),
      });
      assert.equal(oversized.status, 400);

      const events = await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, {
        headers: { cookie },
        signal: abortSse.signal,
      });
      assert.equal(events.status, 200);
      const firstChunk = await events.body!.getReader().read();
      assert.match(new TextDecoder().decode(firstChunk.value), /: connected/);
      const browserStatus = await fetch(`${origin}/api/v1/helios-browser`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ action: "status", expectedGeneration: 1 }),
      });
      assert.equal(browserStatus.status, 200);
      assert.equal(browserStatus.headers.get("cache-control"), "no-store");
      assert.equal((await body(browserStatus)).controlled, true);
      assert.equal(driver.heliosRequests.at(-1)?.owner, "web:tab-owner");
      const abortMirror = new AbortController();
      const mirror = await fetch(
        `${origin}/api/v1/helios-browser-stream?tabId=${tab}&generation=1&csrf=${csrf}&width=1600&height=900`,
        { headers: { cookie }, signal: abortMirror.signal },
      );
      assert.equal(mirror.status, 200);
      assert.match(mirror.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
      const mirrorReader = mirror.body!.getReader();
      let mirrorBytes = Buffer.alloc(0);
      while ((mirrorBytes.toString("latin1").match(/--helios-frame/g) ?? []).length < 2) {
        const chunk = await mirrorReader.read();
        assert.equal(chunk.done, false);
        mirrorBytes = Buffer.concat([mirrorBytes, Buffer.from(chunk.value!)]);
        assert.ok(mirrorBytes.length < 12 * 1024 * 1024);
      }
      assert.match(mirrorBytes.toString("latin1"), /Content-Type: image\/jpeg[\s\S]+jpeg-frame/);
      assert.deepEqual(driver.heliosStreamRequests.at(-1), {
        expectedGeneration: 1,
        owner: "web:tab-owner",
        width: 1600,
        height: 900,
      });
      abortMirror.abort();
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-browser`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ action: "pointer", expectedGeneration: 1, x: -1, y: 1, phase: "move" }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-browser`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ action: "status", expectedGeneration: 2 }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-browser`, {
            method: "POST",
            headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
            body: JSON.stringify({ action: "status", expectedGeneration: 1 }),
          })
        ).status,
        403,
      );
      const androidToolingStatus = await fetch(`${origin}/api/v1/helios-android-tooling`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ action: "status", expectedGeneration: 1 }),
      });
      assert.equal(androidToolingStatus.status, 200);
      assert.equal(androidToolingStatus.headers.get("cache-control"), "no-store");
      assert.equal((await body(androidToolingStatus)).appiumVersion, "3.6.0");
      assert.deepEqual(driver.heliosAndroidToolingRequests.at(-1), { action: "status", expectedGeneration: 1 });
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-android-tooling`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ action: "install", expectedGeneration: 1 }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-android-tooling`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ action: "install", expectedGeneration: 1, confirmed: true, package: "arbitrary" }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/helios-android-tooling`, {
            method: "POST",
            headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
            body: JSON.stringify({ action: "remove", expectedGeneration: 1, confirmed: true }),
          })
        ).status,
        403,
      );
      const papercutId = "00000000-0000-4000-8000-000000000001";
      const papercutEdit = await fetch(`${origin}/api/v1/papercuts/mutate`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          generation: 1,
          action: "edit",
          id: papercutId,
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          message: "Updated friction",
        }),
      });
      assert.equal(papercutEdit.status, 200);
      assert.equal(papercutEdit.headers.get("cache-control"), "no-store");
      assert.deepEqual(driver.papercutMutations.at(-1), {
        action: "edit",
        id: papercutId,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        message: "Updated friction",
      });
      assert.equal(
        (
          await fetch(`${origin}/api/v1/papercuts/mutate`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({
              generation: 1,
              action: "delete",
              id: papercutId,
              expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
              message: "invalid",
            }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/papercuts/mutate`, {
            method: "POST",
            headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
            body: JSON.stringify({
              generation: 1,
              action: "delete",
              id: papercutId,
              expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
            }),
          })
        ).status,
        403,
      );
      const images = [{ mimeType: "image/png", data: "eA==" }] as const;
      const command = { type: "prompt", commandId: "once", expectedGeneration: 1, message: "hello", images };
      const accepted = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(command),
      });
      assert.equal(accepted.status, 200);
      const duplicate = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(command),
      });
      assert.equal(duplicate.status, 200);
      assert.equal(driver.calls, 1);
      assert.deepEqual(driver.promptImages, [images]);

      const ownerBoot = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
      );
      assert.equal((ownerBoot.pendingUi as { owned: boolean }).owned, true);
      const otherBoot = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": otherTab } }),
      );
      const otherEvents = await fetch(
        `${origin}/api/v1/events?tabId=${otherTab}&cursor=1:${String(otherBoot.sequence)}`,
        { headers: { cookie }, signal: abortOtherSse.signal },
      );
      assert.equal(otherEvents.status, 200);
      const otherHeaders = { ...mutationHeaders, "x-pylon-tab-id": otherTab };
      const responseBody = JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true });
      const foreignAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
        method: "POST",
        headers: otherHeaders,
        body: responseBody,
      });
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

      const release = await fetch(`${origin}/api/v1/ui-ownership/dialog-1`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ sessionGeneration: 1, action: "release" }),
      });
      assert.equal(release.status, 200);
      const releasedOwnerAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
        method: "POST",
        headers: mutationHeaders,
        body: responseBody,
      });
      assert.equal(releasedOwnerAnswer.status, 409);
      const claim = await fetch(`${origin}/api/v1/ui-ownership/dialog-1`, {
        method: "POST",
        headers: otherHeaders,
        body: JSON.stringify({ sessionGeneration: 1, action: "claim" }),
      });
      assert.equal(claim.status, 200);
      const transferredAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
        method: "POST",
        headers: otherHeaders,
        body: responseBody,
      });
      assert.equal(transferredAnswer.status, 200);
      assert.equal(driver.answers.at(-1)?.confirmed, true);
      const duplicateAnswer = await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
        method: "POST",
        headers: otherHeaders,
        body: responseBody,
      });
      assert.equal(duplicateAnswer.status, 409);

      driver.dialogMethod = "questionnaire";
      const questionnaire = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ type: "prompt", commandId: "questionnaire", expectedGeneration: 1, message: "clarify" }),
      });
      assert.equal(questionnaire.status, 200);
      const questionnaireBoot = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
      );
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
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(editCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(editCommand),
          })
        ).status,
        200,
      );
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
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(rewindCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(rewindCommand),
          })
        ).status,
        200,
      );
      assert.equal(driver.rewinds.length, 1);

      const sessions = await fetch(`${origin}/api/v1/sessions`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(sessions.status, 200);
      const sessionList = await body(sessions);
      assert.equal((sessionList.projects as unknown[]).length, 1);
      assert.equal((sessionList.activeSessions as unknown[]).length, 1);
      const invalidCursor = await fetch(`${origin}/api/v1/sessions?cursor=not-valid`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(invalidCursor.status, 400);
      const unauthorizedInvalidCursor = await fetch(`${origin}/api/v1/sessions?cursor=not-valid`, {
        headers: { cookie, "x-pylon-tab-id": "unknown-tab" },
      });
      assert.equal(unauthorizedInvalidCursor.status, 403);
      const usage = await fetch(`${origin}/api/v1/usage?days=7`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(usage.status, 200);
      assert.equal((await body(usage)).sessionGeneration, 1);
      assert.deepEqual(driver.usageDays, [7]);
      const defaultUsage = await fetch(`${origin}/api/v1/usage`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(defaultUsage.status, 200);
      assert.deepEqual(driver.usageDays, [7, 30]);
      const originalUsage = driver.usage.bind(driver);
      driver.usage = async input => ({ ...(await originalUsage(input)), sessionGeneration: 2 });
      assert.equal(
        (await fetch(`${origin}/api/v1/usage?days=30`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
        409,
      );
      driver.usage = originalUsage;
      assert.equal(
        (await fetch(`${origin}/api/v1/usage?days=8`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
        400,
      );
      assert.equal(
        (await fetch(`${origin}/api/v1/usage?days=7&days=30`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
        400,
      );
      const customUsage = await fetch(`${origin}/api/v1/usage?from=2026-03-15&through=2026-03-16`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(customUsage.status, 200);
      assert.deepEqual(driver.usageQueries.at(-1), { from: "2026-03-15", through: "2026-03-16" });
      for (const query of [
        "from=2026-03-16&through=2026-03-15",
        "from=2026-03-15&through=2026-03-15&days=7",
        "from=2026-03-15&from=2026-03-16&through=2026-03-16",
      ])
        assert.equal(
          (await fetch(`${origin}/api/v1/usage?${query}`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
          400,
        );
      assert.equal(
        (await fetch(`${origin}/api/v1/usage`, { headers: { cookie, "x-pylon-tab-id": "unknown-tab" } })).status,
        403,
      );
      const history = await fetch(
        `${origin}/api/v1/conversation-history?cursor=${encodeHistoryCursor(100)}&generation=1`,
        { headers: { cookie, "x-pylon-tab-id": tab } },
      );
      assert.equal(history.status, 200);
      assert.equal(((await body(history)).messages as unknown[]).length, 1);
      const staleHistory = await fetch(
        `${origin}/api/v1/conversation-history?cursor=${encodeHistoryCursor(100)}&generation=2`,
        { headers: { cookie, "x-pylon-tab-id": tab } },
      );
      assert.equal(staleHistory.status, 409);
      const invalidHistory = await fetch(`${origin}/api/v1/conversation-history?cursor=not-valid&generation=1`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(invalidHistory.status, 400);
      const attachment = await fetch(`${origin}/api/v1/conversation-attachment?entry=user-entry&index=0&generation=1`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(attachment.status, 200);
      assert.deepEqual(await body(attachment), {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: "session-1",
        sessionGeneration: 1,
        kind: "image",
        name: "Image 1",
        mimeType: "image/png",
        size: 1,
        data: "eA==",
      });
      assert.equal(
        (
          await fetch(`${origin}/api/v1/conversation-attachment?entry=user-entry&index=0&generation=2`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/conversation-attachment?entry=user-entry&index=-1&generation=1`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/conversation-attachment?entry=user-entry&index=0&generation=1`, {
            headers: { cookie, "x-pylon-tab-id": "unknown-tab" },
          })
        ).status,
        403,
      );
      const localImageSource = "file:///outside/workspace/chart.png";
      const localImage = await fetch(
        `${origin}/api/v1/local-image?source=${encodeURIComponent(localImageSource)}&generation=1`,
        { headers: { cookie, "x-pylon-tab-id": tab } },
      );
      assert.equal(localImage.status, 200);
      assert.equal((await body(localImage)).name, "chart.png");
      assert.deepEqual(driver.localImageSources, [localImageSource]);
      assert.equal(
        (
          await fetch(`${origin}/api/v1/local-image?source=${encodeURIComponent(localImageSource)}&generation=2`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/local-image?source=${encodeURIComponent(localImageSource)}`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/local-image?source=${encodeURIComponent(localImageSource)}&generation=1`, {
            headers: { cookie, "x-pylon-tab-id": "unknown-tab" },
          })
        ).status,
        403,
      );
      const files = await fetch(`${origin}/api/v1/file-suggestions?q=src&generation=1`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(files.status, 200);
      assert.deepEqual((await body(files)).paths, ["src/index.ts"]);
      assert.equal(
        (
          await fetch(`${origin}/api/v1/file-suggestions?q=src&generation=2`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/file-suggestions?q=${"x".repeat(201)}&generation=1`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        400,
      );
      const fileHistory = await fetch(
        `${origin}/api/v1/workspace/history?generation=1&path=src%2Findex.ts&scope=all&limit=20&selected=checkpoint-1&view=diff`,
        { headers: { cookie, "x-pylon-tab-id": tab } },
      );
      assert.equal(fileHistory.status, 200);
      assert.deepEqual(driver.fileHistoryQueries.at(-1), {
        path: "src/index.ts",
        scope: "all",
        limit: 20,
        selected: "checkpoint-1",
        view: "diff",
      });
      for (const query of [
        "path=..%2Fsecret&generation=1",
        "path=src%5Cindex.ts&generation=1",
        "path=src%00index.ts&generation=1",
        "path=src%0Aindex.ts&generation=1",
        "path=src%2Findex.ts&generation=1&limit=201",
        "path=src%2Findex.ts&generation=1&selected=not%2Fvalid",
      ]) {
        assert.equal(
          (await fetch(`${origin}/api/v1/workspace/history?${query}`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
          400,
        );
      }
      assert.equal(
        (await fetch(`${origin}/api/v1/workspace/history?path=src%2Findex.ts&generation=2`, {
          headers: { cookie, "x-pylon-tab-id": tab },
        })).status,
        409,
      );
      const originalFileHistory = driver.fileHistory.bind(driver);
      driver.fileHistory = async input => ({ ...(await originalFileHistory(input)), sessionGeneration: 2 });
      assert.equal(
        (await fetch(`${origin}/api/v1/workspace/history?path=src%2Findex.ts&generation=1`, {
          headers: { cookie, "x-pylon-tab-id": tab },
        })).status,
        409,
      );
      driver.fileHistory = originalFileHistory;
      const stateql = await fetch(`${origin}/api/v1/stateql?generation=1&historyLimit=25`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(stateql.status, 200);
      assert.equal(stateql.headers.get("cache-control"), "no-store");
      assert.equal((await body(stateql)).sessionGeneration, 1);
      assert.deepEqual(driver.stateqlHistoryLimits, [25]);
      assert.equal(
        (await fetch(`${origin}/api/v1/stateql?generation=2`, { headers: { cookie, "x-pylon-tab-id": tab } })).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql?generation=1&historyLimit=101`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        400,
      );
      const exportInput = { generation: 1, handle: "result-1", format: "json" };
      const download = await fetch(`${origin}/api/v1/stateql/export`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(exportInput),
      });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-disposition"), 'attachment; filename="result.json"');
      assert.equal(await download.text(), '[{"value":"complete"}]');
      for (const [input, status] of [
        [{ ...exportInput, generation: 2 }, 409],
        [{ ...exportInput, format: "xml" }, 400],
        [{ ...exportInput, path: "target.json" }, 400],
      ] as const) {
        assert.equal(
          (
            await fetch(`${origin}/api/v1/stateql/export`, {
              method: "POST",
              headers: mutationHeaders,
              body: JSON.stringify(input),
            })
          ).status,
          status,
        );
      }
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/export`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(exportInput),
          })
        ).status,
        403,
      );
      const rowsInput = { generation: 1, handle: "result-1", offset: 0, limit: 25 };
      const rows = await fetch(`${origin}/api/v1/stateql/rows`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(rowsInput),
      });
      assert.equal(rows.status, 200);
      assert.equal(rows.headers.get("cache-control"), "no-store");
      assert.equal((await body(rows)).handle, "result-1");
      assert.deepEqual(driver.stateqlRowsRequests, [{ handle: "result-1", offset: 0, limit: 25 }]);
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/rows`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ ...rowsInput, generation: 2 }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/rows`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ ...rowsInput, limit: 101 }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/rows`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ ...rowsInput, handle: "   " }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/rows`, {
            method: "POST",
            headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
            body: JSON.stringify(rowsInput),
          })
        ).status,
        403,
      );
      const commandRequest = { generation: 1, input: { command: "query", sql: "SELECT 1", cache: "bypass" } };
      const stateqlCommand = await fetch(`${origin}/api/v1/stateql/command`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(commandRequest),
      });
      assert.equal(stateqlCommand.status, 200);
      assert.equal(stateqlCommand.headers.get("cache-control"), "no-store");
      assert.equal((await body(stateqlCommand)).command, "query");
      assert.deepEqual(driver.stateqlCommands, [commandRequest.input]);
      const execCommand = { generation: 1, input: { command: "exec", sql: "DELETE FROM users" } };
      const execResponse = await fetch(`${origin}/api/v1/stateql/command`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(execCommand),
      });
      assert.equal(execResponse.status, 200);
      assert.deepEqual(driver.stateqlCommands, [commandRequest.input, execCommand.input]);
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/command`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ ...commandRequest, generation: 2 }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/stateql/command`, {
            method: "POST",
            headers: { ...mutationHeaders, "x-pylon-csrf": "bad" },
            body: JSON.stringify(commandRequest),
          })
        ).status,
        403,
      );
      const archives = await fetch(`${origin}/api/v1/archives`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(archives.status, 200);
      assert.deepEqual((await body(archives)).projects, []);
      const invalidArchiveCursor = await fetch(`${origin}/api/v1/archives?cursor=not-valid`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(invalidArchiveCursor.status, 400);
      const packages = await fetch(`${origin}/api/v1/packages`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(packages.status, 200);
      assert.equal(((await body(packages)).packages as unknown[]).length, 1);
      const extensions = await fetch(`${origin}/api/v1/extensions`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(extensions.status, 200);
      assert.equal(((await body(extensions)).extensions as unknown[]).length, 1);
      const skills = await fetch(`${origin}/api/v1/skills`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(skills.status, 200);
      assert.deepEqual(
        ((await body(skills)).skills as Array<{ name: string; path: string }>).map(skill => [skill.name, skill.path]),
        [["test-skill", "skills/test-skill/SKILL.md"]],
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({
              type: "installExtensionPackage",
              source: "npm:example",
              scope: "user",
              confirmed: false,
              commandId: "extension-invalid",
              expectedGeneration: 1,
            }),
          })
        ).status,
        400,
      );
      const settingsCommand = {
        type: "updatePackageSettings",
        packageId: "pi-advisor",
        settings: {
          kind: "advisor",
          mode: "session",
          thinking: "high",
          maxCalls: 3,
          timeoutMs: 900_000,
          maxCostUsd: 0.5,
          maxOutputTokens: 8_192,
          inputTokenBudget: 32_768,
          prompt: { mode: "default", text: "" },
        },
        commandId: "settings-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(settingsCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(settingsCommand),
          })
        ).status,
        200,
      );
      assert.equal(driver.packageSettingsUpdates.length, 1);
      const hooks = await fetch(`${origin}/api/v1/hooks`, { headers: { cookie, "x-pylon-tab-id": tab } });
      assert.equal(hooks.status, 200);
      assert.equal((await body(hooks)).sessionGeneration, 1);
      const hookSettings = {
        sessionStart: { enabled: true, sources: [{ id: "start", name: "Start", kind: "text", content: "hello" }] },
        beforeAgentStart: { enabled: false, sources: [] },
      };
      const hookCommand = {
        type: "updateHookSettings",
        settings: hookSettings,
        commandId: "hooks-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(hookCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(hookCommand),
          })
        ).status,
        200,
      );
      assert.equal(driver.hookSettingsUpdates.length, 1);
      assert.deepEqual(driver.hookSettings, hookSettings);
      const indexCommand = { type: "rebuildDiscoverIndex", commandId: "index-once", expectedGeneration: 1 };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(indexCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(indexCommand),
          })
        ).status,
        200,
      );
      assert.equal(driver.indexRebuilds, 1);
      const approvePlanCommand = {
        type: "continuityPlanAction",
        action: "approve",
        resetContext: true,
        expectedRevision: 2,
        commandId: "approve-plan-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(approvePlanCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(approvePlanCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.planActions, [approvePlanCommand]);

      const timeline = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          type: "timeline",
          action: "fork",
          checkpointId: "session-1:checkpoint-1",
          commandId: "timeline-fork",
          expectedGeneration: 1,
        }),
      });
      assert.equal(timeline.status, 200);
      assert.equal(driver.prompts.at(-1), "/timeline fork session-1:checkpoint-1");
      const injectedTimeline = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          type: "timeline",
          action: "restore",
          checkpointId: "bad id /clear",
          commandId: "timeline-injected",
          expectedGeneration: 1,
        }),
      });
      assert.equal(injectedTimeline.status, 400);

      const modelCommand = {
        type: "setModel",
        provider: "mock",
        modelId: "next",
        commandId: "model-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(modelCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(modelCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.selectedModels, [{ provider: "mock", modelId: "next" }]);
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({
              type: "setThinkingLevel",
              level: "high",
              commandId: "thinking-once",
              expectedGeneration: 1,
            }),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.selectedThinking, ["high"]);
      const controlsCommand = {
        type: "setSessionControls",
        provider: "mock",
        modelId: "atomic",
        thinkingLevel: "medium",
        commandId: "controls-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(controlsCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(controlsCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.selectedModels.at(-1), { provider: "mock", modelId: "atomic" });
      assert.equal(driver.selectedThinking.at(-1), "medium");

      const refreshModels = (commandId: string) =>
        fetch(`${origin}/api/v1/commands`, {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({ type: "refreshModelCatalogs", commandId, expectedGeneration: 1 }),
        });
      assert.equal((await refreshModels("refresh-models")).status, 200);
      assert.equal(driver.modelRefreshes, 1);
      let refreshedBootstrap = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
      );
      assert.equal((refreshedBootstrap.runtime as RuntimeSnapshot).sessionControls.models.at(-1)?.id, "refreshed-1");

      driver.modelRefreshFailure = new Error("openrouter unavailable");
      assert.equal((await refreshModels("refresh-models-partial")).status, 500);
      refreshedBootstrap = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
      );
      assert.equal((refreshedBootstrap.runtime as RuntimeSnapshot).sessionControls.models.at(-1)?.id, "refreshed-2");
      driver.modelRefreshFailure = undefined;

      const queueCommand = {
        type: "queuePrompt",
        message: "queued message",
        images,
        planMode: true,
        commandId: "queue-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(queueCommand),
          })
        ).status,
        200,
      );
      const queuedPayload = await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=1`, {
        headers: { cookie, "x-pylon-tab-id": tab },
      });
      assert.equal(queuedPayload.status, 200);
      assert.deepEqual(await body(queuedPayload), { id: "queue-1", message: "queued message", images, planMode: true });
      assert.equal(
        (
          await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=2`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        409,
      );
      const restoreCommand = {
        type: "restoreQueuedPrompt",
        queueId: "queue-1",
        commandId: "restore-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(restoreCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/queued-prompt?queueId=queue-1&generation=1`, {
            headers: { cookie, "x-pylon-tab-id": tab },
          })
        ).status,
        409,
      );

      const renameProjectCommand = {
        type: "renameProject",
        projectId: "project-workspace",
        name: "Renamed project",
        commandId: "rename-project-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(renameProjectCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(renameProjectCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.renamedProjects, [{ projectId: "project-workspace", name: "Renamed project" }]);

      const renameCommand = {
        type: "renameSession",
        sessionId: "session-old",
        name: "Renamed",
        commandId: "rename-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(renameCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(renameCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.renamedSessions, [{ sessionId: "session-old", name: "Renamed" }]);
      const activeCommand = {
        type: "setSessionActive",
        sessionId: "session-old",
        active: true,
        commandId: "active-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(activeCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(activeCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.activatedSessions, [{ sessionId: "session-old", active: true }]);
      const pinCommand = {
        type: "setSessionPinned",
        sessionId: "session-old",
        pinned: true,
        commandId: "pin-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(pinCommand),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(pinCommand),
          })
        ).status,
        200,
      );
      assert.deepEqual(driver.pinnedSessions, [{ sessionId: "session-old", pinned: true }]);

      const deleteCommand = {
        type: "deleteSession",
        sessionId: "session-old",
        commandId: "delete-once",
        expectedGeneration: 1,
      };
      const deleted = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(deleteCommand),
      });
      assert.equal(deleted.status, 200);
      assert.equal((await body(deleted)).sessionGeneration, 1);
      const replayDelete = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(deleteCommand),
      });
      assert.equal(replayDelete.status, 200);
      assert.deepEqual(driver.deletedSessions, ["session-old"]);

      const forkCommand = {
        type: "fork",
        entryId: "entry-1",
        name: "Forked session",
        mode: "conversation",
        commandId: "fork-once",
        expectedGeneration: 1,
      };
      assert.equal(
        (
          await fetch(`${origin}/api/v1/commands`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify(forkCommand),
          })
        ).status,
        200,
      );
      assert.equal(driver.forks.length, 1);
      assert.deepEqual(driver.forks[0], {
        expectedGeneration: 1,
        entryId: "entry-1",
        name: "Forked session",
        position: undefined,
        mode: "conversation",
      });

      const replacement = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          type: "newSession",
          parentSessionId: "session-1",
          commandId: "replace-once",
          expectedGeneration: 1,
        }),
      });
      assert.equal(replacement.status, 200);
      assert.equal(driver.newSessionParent, "session-1");
      assert.equal((await body(replacement)).sessionGeneration, 2);
      const replacedBoot = await body(
        await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
      );
      assert.equal((replacedBoot.runtime as RuntimeSnapshot).sessionId, "session-2");
      assert.equal((replacedBoot.runtime as RuntimeSnapshot).cwdLabel, "other-workspace");
      assert.equal(replacedBoot.pendingUi, undefined);
      const replayReplacement = await fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ type: "newSession", commandId: "replace-once", expectedGeneration: 1 }),
      });
      assert.equal(replayReplacement.status, 409);
    } finally {
      abortSse.abort();
      abortOtherSse.abort();
      transport.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
);

test("dialog owner survives disconnect races and releases after reconnect grace", { timeout: 10_000 }, async () => {
  const driver = new FakeDriver();
  let transport: ServerTransport;
  const server = createServer((request, response) => void transport.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  transport = await ServerTransport.create(driver, {
    allowedHosts: [`127.0.0.1:${port}`],
    dialogReconnectGraceMs: 500,
  });
  const tab = "guard-owner";
  const otherTab = "guard-observer";
  let stream = new AbortController();
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
    const boot = await body(bootstrap);
    const headers = {
      cookie,
      "content-type": "application/json",
      "x-pylon-csrf": String(boot.csrfToken),
      "x-pylon-tab-id": tab,
    };
    await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:0`, { headers: { cookie }, signal: stream.signal });
    const prompt = (commandId: string) =>
      fetch(`${origin}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "prompt", commandId, expectedGeneration: 1, message: "risky action" }),
      });
    const waitForDisconnect = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const health = await body(await fetch(`${origin}/api/v1/health`));
        if (health.sseClients === 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("SSE client did not disconnect");
    };

    driver.deferDialog = true;
    assert.equal((await prompt("guard-delayed-dialog")).status, 200);
    stream.abort();
    await waitForDisconnect();
    driver.flushDialog();
    const delayedBoot = await body(
      await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
    );
    const delayedPending = delayedBoot.pendingUi as { owned: boolean; ownershipAvailable: boolean };
    assert.deepEqual(
      { owned: delayedPending.owned, ownershipAvailable: delayedPending.ownershipAvailable },
      { owned: true, ownershipAvailable: false },
    );
    const observerDuringGrace = (
      await body(await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": otherTab } }))
    ).pendingUi as { owned: boolean; ownershipAvailable: boolean };
    assert.deepEqual(
      { owned: observerDuringGrace.owned, ownershipAvailable: observerDuringGrace.ownershipAvailable },
      { owned: false, ownershipAvailable: false },
    );
    stream = new AbortController();
    await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:${String(delayedBoot.sequence)}`, {
      headers: { cookie },
      signal: stream.signal,
    });
    assert.equal(
      (
        await fetch(`${origin}/api/v1/ui-responses/dialog-1`, {
          method: "POST",
          headers,
          body: JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true }),
        })
      ).status,
      200,
    );
    driver.deferDialog = false;

    assert.equal((await prompt("guard-reconnect")).status, 200);
    stream.abort();
    await waitForDisconnect();
    const reconnectBoot = await body(
      await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": tab } }),
    );
    assert.equal((reconnectBoot.pendingUi as { owned: boolean }).owned, true);
    stream = new AbortController();
    await fetch(`${origin}/api/v1/events?tabId=${tab}&cursor=1:${String(reconnectBoot.sequence)}`, {
      headers: { cookie },
      signal: stream.signal,
    });
    const allow = await fetch(`${origin}/api/v1/ui-responses/dialog-2`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true }),
    });
    assert.equal(allow.status, 200);
    assert.equal(driver.answers.at(-1)?.confirmed, true);

    assert.equal((await prompt("guard-owner-loss")).status, 200);
    stream.abort();
    await waitForDisconnect();
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.notEqual(driver.answers.at(-1)?.requestId, "dialog-3");
    const otherBoot = await body(
      await fetch(`${origin}/api/v1/bootstrap`, { headers: { cookie, "x-pylon-tab-id": otherTab } }),
    );
    assert.equal((otherBoot.pendingUi as { ownershipAvailable: boolean }).ownershipAvailable, true);
    const otherStream = new AbortController();
    await fetch(`${origin}/api/v1/events?tabId=${otherTab}&cursor=1:${String(otherBoot.sequence)}`, {
      headers: { cookie },
      signal: otherStream.signal,
    });
    const otherHeaders = { ...headers, "x-pylon-tab-id": otherTab };
    const claim = await fetch(`${origin}/api/v1/ui-ownership/dialog-3`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ sessionGeneration: 1, action: "claim" }),
    });
    assert.equal(claim.status, 200);
    const answer = await fetch(`${origin}/api/v1/ui-responses/dialog-3`, {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ sessionGeneration: 1, method: "confirm", confirmed: true }),
    });
    assert.equal(answer.status, 200);
    otherStream.abort();
  } finally {
    stream.abort();
    transport.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("workspace search streams bounded results, rejects stale inputs and cancels disconnected consumers", { timeout: 15_000 }, async () => {
  let calls = 0;
  let disconnected!: () => void;
  const aborted = new Promise<void>(resolve => { disconnected = resolve; });
  class SearchDriver extends FakeDriver {
    async workspaceSearch(input: import("../src/server/runtime/pi-driver.ts").WorkspaceSearchInput,
      send: (value: import("../src/shared/workspace/workspace-search.ts").WorkspaceSearchResult) => void | Promise<void>, signal: AbortSignal) {
      calls++;
      const result: import("../src/shared/workspace/workspace-search.ts").WorkspaceSearchResult = {
        protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, engine: "grep", files: [],
        truncated: false, inventoryTruncated: false, skipped: 0, timedOut: false, elapsedMs: 1,
      };
      await send(result);
      if (input.query === "wait") await new Promise<void>(resolve => signal.addEventListener("abort", () => { disconnected(); resolve(); }, { once: true }));
      return result;
    }
  }
  const driver = new SearchDriver();
  const running = await startIsolatedServer({ port: 0, development: false, driver });
  const origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  const tab = "workspace-search-tab";
  try {
    const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { "x-pylon-tab-id": tab } });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    await bootstrap.arrayBuffer();
    const headers = { cookie, "x-pylon-tab-id": tab };
    const denied = await fetch(`${origin}/api/v1/workspace/search?generation=1&q=hit`);
    assert.equal(denied.status, 403);
    const stale = await fetch(`${origin}/api/v1/workspace/search?generation=2&q=hit`, { headers });
    assert.equal(stale.status, 409);
    const invalid = await fetch(`${origin}/api/v1/workspace/search?generation=1&q=hit&regex=yes`, { headers });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const response = await fetch(`${origin}/api/v1/workspace/search?generation=1&q=hit`, { headers });
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(frames.map(frame => frame.event), ["update", "done"]);
    assert.equal(frames[1].result.engine, "grep");
    const controller = new AbortController();
    const pending = await fetch(`${origin}/api/v1/workspace/search?generation=1&q=wait`, { headers, signal: controller.signal });
    await pending.body!.getReader().read();
    controller.abort();
    await aborted;
  } finally { await running.close(); }
});

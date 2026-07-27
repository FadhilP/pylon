import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { validateCommand } from "../../shared/protocol/validation.ts";
import type { AcceptedCommand, WebCommand } from "../../shared/protocol/commands.ts";
import type { BootstrapSnapshot } from "../../shared/protocol/snapshots.ts";
import type { WebEvent } from "../../shared/protocol/envelope.ts";
import type { DriverEvent, PiDriver } from "../pi/pi-driver.ts";
import { decodeSessionCursor } from "../pi/session-index.ts";
import { decodeHistoryCursor, RuntimeProjection } from "../pi/projections.ts";
import { CommandIdempotency } from "../transport/commands.ts";
import { EventJournal, eventCursor } from "../transport/event-journal.ts";
import { applySecurityHeaders, httpError, MAX_JSON_BODY_BYTES, readJson, readJsonWithSize, requestAllowed, SessionStore, type BrowserSession, type SecurityOptions, validCsrf, validTabId } from "./security.ts";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface SseClient { response: ServerResponse; tabId: string; heartbeat: NodeJS.Timeout; }
interface DialogOwner { requestId: string; sessionGeneration: number; tabId?: string; lossTimer?: NodeJS.Timeout; }
const MAX_COMMAND_BODY_BYTES = 42 * 1024 * 1024;

export interface ServerTransportOptions extends SecurityOptions {
  secureCookies?: boolean;
  dialogReconnectGraceMs?: number;
}

/** HTTP/SSE adapter. It deliberately owns no Pi state beyond bounded projections. */
export class ServerTransport {
  private journal: EventJournal;
  private readonly projection: RuntimeProjection;
  private readonly sessions = new SessionStore();
  private readonly clients = new Set<SseClient>();
  private readonly idempotency = new CommandIdempotency();
  private readonly unsubscribe: () => void;
  private lastCommandOwner?: string;
  private dialogOwner?: DialogOwner;

  constructor(private readonly driver: PiDriver, initial: Awaited<ReturnType<PiDriver["snapshot"]>>, private readonly options: ServerTransportOptions) {
    this.journal = new EventJournal(initial.sessionGeneration, initial.sessionId);
    this.projection = new RuntimeProjection(initial, (type, payload) => this.publish(type, payload));
    this.unsubscribe = driver.subscribe((event) => this.onDriverEvent(event));
  }

  static async create(driver: PiDriver, options: ServerTransportOptions): Promise<ServerTransport> {
    return new ServerTransport(driver, await driver.snapshot(), options);
  }

  dispose(): void {
    this.unsubscribe();
    this.projection.dispose();
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      client.response.end();
    }
    this.clients.clear();
    this.clearDialogOwner();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    if (!requestAllowed(request, this.options)) return this.send(response, 403, { error: "request origin is not allowed" });
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") return this.bootstrap(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/events") return this.events(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/sessions") return await this.sessionList(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/conversation-history") return await this.conversationHistory(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/file-suggestions") return await this.fileSuggestions(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/files") return await this.workspaceFiles(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/file") return await this.workspaceFile(request, response, url, false);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/diff") return await this.workspaceFile(request, response, url, true);
      if (request.method === "GET" && url.pathname === "/api/v1/queued-prompt") return await this.queuedPrompt(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/archives") return await this.archiveList(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/packages") return await this.packageList(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/commands") return await this.command(request, response);
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/ui-responses/")) return await this.uiResponse(request, response, decodeURIComponent(url.pathname.slice("/api/v1/ui-responses/".length)));
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/ui-ownership/")) return await this.uiOwnership(request, response, decodeURIComponent(url.pathname.slice("/api/v1/ui-ownership/".length)));
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        const runtime = await this.driver.snapshot();
        return this.send(response, 200, {
          ok: runtime.operational.health.status !== "unavailable",
          status: runtime.operational.health.status,
          issues: runtime.operational.health.issues,
          generation: this.journal.sessionGeneration,
          sseClients: this.clients.size,
        });
      }
      return this.send(response, 404, { error: "not found" });
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode: number }).statusCode : 500;
      this.send(response, status, { error: error instanceof Error ? error.message.slice(0, 500) : "internal server error" });
    }
  }

  private bootstrap(request: IncomingMessage, response: ServerResponse): void {
    const session = this.session(request, response);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (validTabId(tabId) && !session.tabs.has(tabId) && session.tabs.size >= 32) throw httpError(429, "too many browser tabs");
    if (validTabId(tabId)) session.tabs.add(tabId);
    // Flush, snapshot, and cursor capture are one synchronous serialization boundary.
    this.projection.flush();
    const runtime = this.projection.snapshot();
    const pending = this.pendingFor(tabId);
    const body: BootstrapSnapshot = { protocolVersion: runtime.protocolVersion, sequence: this.journal.sequence, csrfToken: session.csrfToken, runtime, ...(pending ? { pendingUi: pending } : {}) };
    this.send(response, 200, body);
  }

  private events(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const session = this.sessions.get(request);
    const tabId = url.searchParams.get("tabId") ?? undefined;
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("connection", "close");
      response.flushHeaders();
      response.end("event: stream.reset-required\ndata: {\"reason\":\"session-invalid\"}\n\n");
      return;
    }
    // EventSource cannot set Last-Event-ID for its first connection, so the
    // browser supplies the bootstrap cursor as a query parameter.
    const replay = this.journal.replay(header(request.headers["last-event-id"]) ?? url.searchParams.get("cursor") ?? undefined);
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    if (!replay.ok) {
      response.write("event: stream.reset-required\ndata: {\"reason\":\"cursor-invalid\"}\n\n");
      response.end();
      return;
    }
    response.write(": connected\n\n");
    for (const event of replay.events) this.writeEvent(response, event, tabId);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keep-alive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    const client: SseClient = { response, tabId, heartbeat };
    this.clients.add(client);
    this.renew(tabId);
    const close = () => this.removeClient(client);
    request.once("close", close); response.once("close", close);
  }

  private async command(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const body = await readJsonWithSize(request, MAX_COMMAND_BODY_BYTES);
    const parsed = validateCommand(body.value);
    if (!parsed.ok) throw httpError(400, parsed.error);
    const command = parsed.value;
    if (!["prompt", "queuePrompt", "steer", "followUp", "editPrompt"].includes(command.type)
      && body.bytes > MAX_JSON_BODY_BYTES) {
      throw httpError(413, "request body too large");
    }
    if (command.expectedGeneration !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    const runtime = this.projection.snapshot();
    if (!runtime.ready) throw httpError(409, "runtime is not ready");
    if (command.type !== "abort" && ![...this.clients].some((client) => client.tabId === tabId)) {
      throw httpError(409, "the command tab must have an SSE connection");
    }
    this.renew(tabId);
    try {
      const accepted = await this.idempotency.execute(command, () => {
        this.lastCommandOwner = tabId;
        return this.execute(command);
      });
      this.send(response, 200, accepted);
    } catch (error) {
      if (error instanceof Error && error.name === "IdempotencyConflictError") throw httpError(409, error.message);
      if (error instanceof Error && error.name === "StaleGenerationError") throw httpError(409, error.message);
      throw error;
    }
  }

  private async sessionList(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const query = url.searchParams.get("q")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 10 : Number(rawLimit);
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw httpError(400, "invalid projectId");
    if (cursor && (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor) || !decodeSessionCursor(cursor))) throw httpError(400, "invalid cursor");
    if (query && query.length > 200) throw httpError(400, "query is too long");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid limit");
    const result = await this.driver.listSessions({ projectId, cursor, query, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while listing sessions");
    this.send(response, 200, result);
  }

  private async packageList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const result = await this.driver.listPackages();
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while listing packages");
    this.send(response, 200, result);
  }

  private async conversationHistory(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const cursor = url.searchParams.get("cursor") ?? "";
    const generation = Number(url.searchParams.get("generation"));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!cursor || cursor.length > 128 || decodeHistoryCursor(cursor) === undefined) throw httpError(400, "invalid history cursor");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid history limit");
    const result = await this.driver.conversationHistory({ cursor, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while loading history");
    this.send(response, 200, result);
  }

  private async fileSuggestions(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const query = url.searchParams.get("q")?.trim() ?? "";
    const generation = Number(url.searchParams.get("generation"));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 8 : Number(rawLimit);
    if (query.length > 200) throw httpError(400, "query is too long");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw httpError(400, "invalid limit");
    const result = await this.driver.fileSuggestions({ query, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while listing files");
    this.send(response, 200, result);
  }

  private async workspaceFiles(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const generation = Number(url.searchParams.get("generation"));
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!this.driver.workspaceFiles) throw httpError(404, "workspace files are unavailable");
    const query = url.searchParams.get("q")?.trim() ?? "";
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 200);
    if (query.length > 200 || (cursor && cursor.length > 128)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, "invalid file query");
    const result = await this.driver.workspaceFiles({ query, cursor, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while listing files");
    this.send(response, 200, result);
  }

  private async workspaceFile(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    diff: boolean,
  ): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const generation = Number(url.searchParams.get("generation"));
    const path = url.searchParams.get("path") ?? "";
    const view = url.searchParams.get("view") === "base" ? "base" : "current";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!path || path.length > 500 || path.includes("\\") || path.startsWith("/")
      || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw httpError(400, "invalid workspace path");
    }
    const method = diff ? this.driver.workspaceDiff : this.driver.workspaceFile;
    if (!method) throw httpError(404, "workspace file view is unavailable");
    const result = await method.call(this.driver, { path, view });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while reading file");
    this.send(response, 200, result);
  }

  private async queuedPrompt(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const queueId = url.searchParams.get("queueId") ?? "";
    const generation = Number(url.searchParams.get("generation"));
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(queueId)) throw httpError(400, "invalid queueId");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    const queued = await this.driver.queuedPrompt({ queueId, expectedGeneration: generation })
      .catch((error) => {
        throw httpError(409, error instanceof Error ? error.message : "queued prompt is unavailable");
      });
    this.renew(tabId);
    this.send(response, 200, queued);
  }

  private async archiveList(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const query = url.searchParams.get("q")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (cursor && (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor) || !decodeSessionCursor(cursor))) throw httpError(400, "invalid cursor");
    if (query && query.length > 200) throw httpError(400, "query is too long");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid limit");
    const result = await this.driver.listArchived({ cursor, query, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while listing archives");
    this.send(response, 200, result);
  }

  private async uiResponse(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const pending = this.projection.pendingUi;
    const owner = this.dialogOwner;
    if (!pending || !owner || pending.requestId !== requestId || owner.requestId !== requestId) throw httpError(409, "UI request is not pending");
    if (owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
    const body = await readJson(request);
    if (this.dialogOwner !== owner || this.projection.pendingUi !== pending) throw httpError(409, "UI request is no longer pending");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "UI response must be an object");
    const value = body as Record<string, unknown>;
    if (value.requestId !== undefined && value.requestId !== requestId) throw httpError(400, "requestId does not match path");
    if (value.sessionGeneration !== this.journal.sessionGeneration || value.method !== pending.method) throw httpError(409, "UI response does not match pending request");
    const responseValue = { requestId, sessionGeneration: value.sessionGeneration, method: value.method, cancelled: value.cancelled === true, value: value.value, confirmed: value.confirmed } as Parameters<PiDriver["answerUiRequest"]>[0];
    try { await this.driver.answerUiRequest(responseValue); }
    catch (error) { throw httpError(400, error instanceof Error ? error.message : "invalid UI response"); }
    this.renew(tabId);
    this.send(response, 200, { accepted: true, requestId });
  }

  private async uiOwnership(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const pending = this.projection.pendingUi;
    const owner = this.dialogOwner;
    if (!pending || !owner || pending.requestId !== requestId || owner.requestId !== requestId) throw httpError(409, "UI request is not pending");
    const body = await readJson(request);
    if (this.dialogOwner !== owner || this.projection.pendingUi !== pending) throw httpError(409, "UI request is no longer pending");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "ownership request must be an object");
    const value = body as Record<string, unknown>;
    if (value.sessionGeneration !== owner.sessionGeneration || owner.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (value.action === "release") {
      if (owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
      this.releaseDialogOwner(owner);
    } else if (value.action === "claim") {
      if (owner.tabId !== undefined && owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
      if (![...this.clients].some((client) => client.tabId === tabId)) throw httpError(409, "claiming tab must have an SSE connection");
      owner.tabId = tabId;
      this.renew(tabId);
    } else {
      throw httpError(400, "unknown ownership action");
    }
    this.publishOwnership(requestId);
    this.send(response, 200, { accepted: true, requestId });
  }

  private execute(command: WebCommand): Promise<AcceptedCommand> {
    const accepted = (sessionGeneration: number): AcceptedCommand => ({ commandId: command.commandId, sessionGeneration, accepted: true });
    switch (command.type) {
      case "prompt": return this.driver.prompt(command);
      case "queuePrompt": return this.driver.queuePrompt(command);
      case "restoreQueuedPrompt":
        return this.driver.restoreQueuedPrompt(command).then(() => accepted(command.expectedGeneration));
      case "steerQueuedPrompt": return this.driver.steerQueuedPrompt(command);
      case "steer": return this.driver.steer(command);
      case "followUp": return this.driver.followUp(command);
      case "abort": return this.driver.abort().then(() => accepted(command.expectedGeneration));
      case "addProject": return this.driver.addProject({ expectedGeneration: command.expectedGeneration }).then((result) => accepted(result.sessionGeneration));
      case "removeProject": return this.driver.removeProject({ projectId: command.projectId, expectedGeneration: command.expectedGeneration }).then((result) => accepted(result.sessionGeneration));
      case "archiveProject": return this.driver.archiveProject(command).then((result) => accepted(result.sessionGeneration));
      case "restoreProject": return this.driver.restoreProject(command).then(() => accepted(command.expectedGeneration));
      case "newSession": return this.driver.newSession({
        parentSessionId: command.parentSessionId,
        projectId: command.projectId,
        expectedGeneration: command.expectedGeneration,
      }).then((result) => accepted(result.sessionGeneration));
      case "switchSession": return this.driver.switchSession({ sessionId: command.sessionId }).then((result) => accepted(result.sessionGeneration));
      case "deleteSession": return this.driver.deleteSession({ sessionId: command.sessionId }).then(() => accepted(command.expectedGeneration));
      case "archiveSession": return this.driver.archiveSession(command).then((result) => accepted(result.sessionGeneration));
      case "restoreSession": return this.driver.restoreSession(command).then(() => accepted(command.expectedGeneration));
      case "renameSession": return this.driver.renameSession({ sessionId: command.sessionId, name: command.name }).then(() => accepted(command.expectedGeneration));
      case "setSessionActive": return this.driver.setSessionActive({ sessionId: command.sessionId, active: command.active }).then(() => accepted(command.expectedGeneration));
      case "editPrompt": return this.driver.editPrompt(command);
      case "rewindPrompt": return this.driver.rewindPrompt(command);
      case "fork": return this.driver.fork({ entryId: command.entryId, position: command.position }).then((result) => accepted(result.sessionGeneration));
      case "timeline": {
        const action = command.action === "restore" ? "jump" : command.action;
        const message = `/timeline ${action}${command.checkpointId ? ` ${command.checkpointId}` : ""}`;
        return this.driver.prompt({ commandId: command.commandId, expectedGeneration: command.expectedGeneration, message });
      }
      case "setPackageEnabled":
        if (this.projection.pendingUi) return Promise.reject(httpError(409, "packages cannot change while a UI request is pending"));
        return this.driver.setPackageEnabled({ packageId: command.packageId, enabled: command.enabled })
          .then((result) => accepted(result.sessionGeneration));
      case "updatePackageSettings":
        if (this.projection.pendingUi) return Promise.reject(httpError(409, "packages cannot change while a UI request is pending"));
        return this.driver.updatePackageSettings({ packageId: command.packageId, settings: command.settings })
          .then((result) => accepted(result.sessionGeneration));
      case "rebuildDiscoverIndex":
        return this.driver.rebuildDiscoverIndex().then(() => accepted(command.expectedGeneration));
      case "setModel":
        return this.driver.setModel({ provider: command.provider, modelId: command.modelId })
          .then(async () => { this.projection.refresh(await this.driver.snapshot()); return accepted(command.expectedGeneration); });
      case "setThinkingLevel":
        return Promise.resolve()
          .then(() => this.driver.setThinkingLevel({ level: command.level }))
          .then(async () => { this.projection.refresh(await this.driver.snapshot()); return accepted(command.expectedGeneration); });
      case "setSessionControls":
        return this.driver.setSessionControls({
          provider: command.provider,
          modelId: command.modelId,
          thinkingLevel: command.thinkingLevel,
        }).then(async () => {
          this.projection.refresh(await this.driver.snapshot());
          return accepted(command.expectedGeneration);
        });
      case "updateContinuityMemory":
        return this.driver.updateContinuityMemory(command).then(() => accepted(command.expectedGeneration));
      case "deleteContinuityMemory":
        return this.driver.deleteContinuityMemory(command).then(() => accepted(command.expectedGeneration));
      case "handoffSession":
        if (!this.driver.handoffSession) return Promise.reject(httpError(409, "workspace handoff is unavailable"));
        return this.driver.handoffSession(command).then((result) => accepted(result.sessionGeneration));
      case "updateProjectWorktreeSettings":
        if (!this.driver.updateProjectWorktreeSettings) return Promise.reject(httpError(409, "worktree settings are unavailable"));
        return this.driver.updateProjectWorktreeSettings(command).then(() => accepted(command.expectedGeneration));
    }
  }

  private onDriverEvent(event: DriverEvent): void {
    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      this.projection.discardPending();
      this.clearDialogOwner();
      this.lastCommandOwner = undefined;
      this.journal = new EventJournal(event.sessionGeneration, event.sessionId);
    }
    // The owner must be installed before projection publication so the first
    // UI event is personalized correctly for every connected tab.
    if (event.type === "ui.event") {
      const raw = event.payload && typeof event.payload === "object" ? event.payload as { requestId?: unknown; method?: unknown } : {};
      if (typeof raw.requestId === "string" && ["select", "confirm", "input", "editor"].includes(String(raw.method))) {
        this.openDialog(raw.requestId, event.sessionGeneration, this.lastCommandOwner);
      }
    }
    this.projection.apply(event);
    if (event.type === "ui.closed" && this.dialogOwner?.requestId === event.requestId) this.clearDialogOwner();
    if (event.type === "session.event") {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as { type?: unknown } : {};
      if (["message_end", "tool_execution_end", "agent_end", "session_controls_changed"].includes(String(payload.type))) {
        void this.driver.snapshot().then((snapshot) => this.projection.refresh(snapshot)).catch(() => undefined);
      }
    }
  }

  private publish(type: string, payload: unknown): void {
    const event = this.journal.append(type, payload);
    for (const client of this.clients) this.writeEvent(client.response, event, client.tabId);
  }

  private writeEvent(response: ServerResponse, event: WebEvent, tabId: string): void {
    const personalized = event.type === "ui.request" || event.type === "ui.ownership";
    const eventPayload = personalized ? event.payload as Record<string, unknown> : undefined;
    const matchesCurrent = eventPayload?.requestId === this.dialogOwner?.requestId;
    const payload = personalized ? {
      ...eventPayload,
      owned: matchesCurrent && this.dialogOwner?.tabId === tabId,
      ownershipAvailable: matchesCurrent && this.dialogOwner?.tabId === undefined,
    } : event.payload;
    response.write(`id: ${eventCursor(event)}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, payload })}\n\n`);
  }

  private session(request: IncomingMessage, response: ServerResponse): BrowserSession {
    return this.sessions.get(request) ?? this.sessions.create(response, this.options.secureCookies);
  }
  private mutatingSession(request: IncomingMessage): BrowserSession {
    const session = this.sessions.get(request);
    if (!validCsrf(session, request.headers["x-pylon-csrf"] as string | undefined)) throw httpError(403, "invalid CSRF token");
    return session as BrowserSession;
  }
  private tab(request: IncomingMessage, session: BrowserSession): string {
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    return tabId;
  }
  private pendingFor(tabId: string | string[] | undefined) {
    const pending = this.projection.pendingUi;
    if (!pending) return undefined;
    return {
      ...pending,
      owned: typeof tabId === "string" && this.dialogOwner?.tabId === tabId,
      ownershipAvailable: this.dialogOwner?.tabId === undefined,
    };
  }
  private openDialog(requestId: string, sessionGeneration: number, tabId: string | undefined): void {
    this.clearDialogOwner();
    const connectedOwner = tabId && [...this.clients].some((client) => client.tabId === tabId) ? tabId : undefined;
    this.dialogOwner = { requestId, sessionGeneration, tabId: connectedOwner };
  }
  private renew(tabId: string): void {
    const owner = this.dialogOwner;
    if (owner?.tabId !== tabId) return;
    if (owner.lossTimer) clearTimeout(owner.lossTimer);
    owner.lossTimer = undefined;
  }
  private removeClient(client: SseClient): void {
    if (!this.clients.delete(client)) return;
    clearInterval(client.heartbeat);
    const owner = this.dialogOwner;
    if (owner?.tabId === client.tabId && ![...this.clients].some((item) => item.tabId === client.tabId)) {
      const expected = owner;
      owner.lossTimer = setTimeout(() => {
        if (this.dialogOwner === expected && expected.tabId === client.tabId) void this.cancelOwnedDialog(expected);
      }, this.options.dialogReconnectGraceMs ?? 10_000);
      owner.lossTimer.unref?.();
    }
  }
  private async cancelOwnedDialog(owner: DialogOwner): Promise<void> {
    const pending = this.projection.pendingUi;
    if (this.dialogOwner !== owner || !pending || pending.requestId !== owner.requestId || owner.sessionGeneration !== this.journal.sessionGeneration) return;
    try { await this.driver.answerUiRequest({ requestId: owner.requestId, sessionGeneration: owner.sessionGeneration, method: pending.method, cancelled: true }); }
    catch { /* Driver expiry/closure already resolved neutrally. */ }
  }
  private releaseDialogOwner(owner: DialogOwner): void {
    if (owner.lossTimer) clearTimeout(owner.lossTimer);
    owner.lossTimer = undefined;
    owner.tabId = undefined;
  }
  private publishOwnership(requestId: string): void { this.publish("ui.ownership", { requestId }); }
  private clearDialogOwner(): void {
    const owner = this.dialogOwner; if (!owner) return;
    if (owner.lossTimer) clearTimeout(owner.lossTimer);
    this.dialogOwner = undefined;
  }
  private send(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(body));
  }
}

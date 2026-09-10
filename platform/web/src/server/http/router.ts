import { validWorkspacePath } from "../../shared/workspace/workspace-mutations.ts";
import { validGitDetailQuery } from "../../shared/workspace/git.ts";
import { validAnnotationMutation, type AnnotationMutation, type AnnotationRequest } from "../../shared/workspace/annotations.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import {
  describeRuntimeSnapshotIssue,
  isStateQLCommandInput,
  validateCommand,
  isStateQLWorkspace,
} from "../../shared/protocol/validation.ts";
import { validateHeliosBrowserCommand } from "../../shared/protocol/helios.ts";
import { validateHeliosAndroidToolingCommand } from "../../shared/protocol/helios-android-tooling.ts";
import type { AcceptedCommand, WebCommand } from "../../shared/protocol/commands.ts";
import type { BootstrapSnapshot, StateQLCommandInput, StateQLWorkspace, UsageQuery } from "../../shared/protocol/snapshots.ts";
import type { FileHistoryQuery } from "pylon-core/src/file-history.ts";
import { PROTOCOL_VERSION, type WebEvent } from "../../shared/protocol/envelope.ts";
import type { WorkspaceSearchQuery, WorkspaceSymbolResult } from "../../shared/workspace/workspace-search.ts";
import type { DriverEvent, PiDriver } from "../runtime/pi-driver.ts";
import { decodeSessionCursor } from "../sessions/session-index.ts";
import { usageWindow } from "../usage/usage-aggregation.ts";
import { decodeHistoryCursor, decodeTurnIndexCursor, RuntimeProjection } from "../runtime/projections.ts";
import { CommandIdempotency } from "../transport/commands.ts";
import { EventJournal, eventCursor } from "../transport/event-journal.ts";
import {
  applySecurityHeaders,
  httpError,
  MAX_JSON_BODY_BYTES,
  readJson,
  readJsonWithSize,
  requestAllowed,
  SessionStore,
  type BrowserSession,
  type SecurityOptions,
  validCsrf,
  validTabId,
} from "./security.ts";
import { TerminalServer, type TerminalSpawn } from "./terminal.ts";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface SseClient {
  response: ServerResponse;
  session: BrowserSession;
  tabId: string;
  heartbeat: NodeJS.Timeout;
}
interface HeliosMirrorClient {
  session: BrowserSession;
  tabId: string;
  controller: AbortController;
}
interface DialogOwner {
  requestId: string;
  sessionGeneration: number;
  tabId?: string;
  lossTimer?: NodeJS.Timeout;
}
const MAX_COMMAND_BODY_BYTES = 42 * 1024 * 1024;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

import { KeyboardRevisionConflict, KeyboardSettingsStore } from "../settings/keyboard-settings.ts";
import { validateKeymap, type Keymap } from "../../shared/settings/keyboard.ts";

export interface ServerTransportOptions extends SecurityOptions {
  secureCookies?: boolean;
  dialogReconnectGraceMs?: number;
  terminalSpawn?: TerminalSpawn;
  keyboardSettingsPath?: string;
}

/** HTTP/SSE adapter. It deliberately owns no Pi state beyond bounded projections. */
export class ServerTransport {
  private journal: EventJournal;
  private readonly projection: RuntimeProjection;
  private readonly sessions = new SessionStore();
  private readonly clients = new Set<SseClient>();
  private readonly idempotency = new CommandIdempotency();
  private readonly mirrors = new Set<HeliosMirrorClient>();
  private readonly unsubscribe: () => void;
  private readonly terminal: TerminalServer;
  private lastCommandOwner?: string;
  private exportController?: AbortController;
  private databaseCommand?: { tabId: string; controller: AbortController };
  private dialogOwner?: DialogOwner;
  private readonly tabLossTimers = new Map<string, NodeJS.Timeout>();
  private readonly keyboardSettings: KeyboardSettingsStore;
  private disposed = false;

  constructor(
    private readonly driver: PiDriver,
    initial: Awaited<ReturnType<PiDriver["snapshot"]>>,
    private readonly options: ServerTransportOptions,
  ) {
    this.keyboardSettings = new KeyboardSettingsStore(options.keyboardSettingsPath ?? ":memory:");
    try {
      this.journal = new EventJournal(initial.sessionGeneration, initial.sessionId);
      this.projection = new RuntimeProjection(initial, (type, payload) => this.publish(type, payload));
      this.terminal = new TerminalServer(driver, this.sessions, options, options.terminalSpawn);
      this.unsubscribe = driver.subscribe(event => this.onDriverEvent(event));
    } catch (error) { this.keyboardSettings.close(); throw error; }
  }

  static async create(driver: PiDriver, options: ServerTransportOptions): Promise<ServerTransport> {
    return new ServerTransport(driver, await driver.snapshot(), options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.keyboardSettings.close();
    this.unsubscribe();
    this.databaseCommand?.controller.abort();
    this.exportController?.abort();
    this.projection.dispose();
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      client.response.end();
    }
    this.clients.clear();
    for (const mirror of this.mirrors) mirror.controller.abort(new Error("Server closing"));
    this.mirrors.clear();
    for (const timer of this.tabLossTimers.values()) clearTimeout(timer);
    this.tabLossTimers.clear();
    this.clearDialogOwner();
    this.terminal.dispose();
  }

  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void this.terminal.handleUpgrade(request, socket, head);
  };

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    if (!requestAllowed(request, this.options))
      return this.send(response, 403, { error: "request origin is not allowed" });
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") return this.bootstrap(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/events") return this.events(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/sessions")
        return await this.sessionList(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/branches")
        return await this.localBranchList(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/usage") return await this.usage(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/conversation-history")
        return await this.conversationHistory(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/conversation-attachment")
        return await this.conversationAttachment(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/local-image")
        return await this.localImage(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/turn-diff")
        return await this.turnDiff(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/conversation-turns")
        return await this.conversationTurnIndex(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/file-suggestions")
        return await this.fileSuggestions(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/files")
        return await this.workspaceFiles(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/search") return await this.workspaceSearch(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/index")
        return await this.workspaceGitIndex(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/git")
        return await this.workspaceGitState(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/git-detail")
        return await this.workspaceGitDetail(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/entry")
        return await this.workspaceEntry(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/file")
        return await this.workspaceFile(request, response, url, false);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/symbols") return await this.workspaceSymbols(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/diff")
        return await this.workspaceFile(request, response, url, true);
      if (request.method === "GET" && url.pathname === "/api/v1/workspace/history")
        return await this.workspaceHistory(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/timeline/files")
        return await this.timelineCheckpoint(request, response, url, false);
      if (request.method === "GET" && url.pathname === "/api/v1/timeline/diff")
        return await this.timelineCheckpoint(request, response, url, true);
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/v1/annotations")
        return await this.annotations(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/queued-prompt")
        return await this.queuedPrompt(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/archives")
        return await this.archiveList(request, response, url);
      if (request.method === "GET" && url.pathname === "/api/v1/packages")
        return await this.packageList(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/extensions")
        return await this.extensionList(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/skills") return await this.skillList(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/hooks")
        return await this.hookSettings(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/stateql")
        return await this.stateqlSnapshot(request, response, url);
      if (request.method === "POST" && url.pathname === "/api/v1/stateql/rows")
        return await this.stateqlRows(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/stateql/export")
        return await this.stateqlExport(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/stateql/command")
        return await this.stateqlCommand(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/papercuts")
        return await this.papercutList(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/papercuts/mutate")
        return await this.papercutMutation(request, response);
      if (request.method === "GET" && url.pathname === "/api/v1/helios-browser-stream")
        return await this.heliosBrowserStream(request, response, url);
      if (request.method === "POST" && url.pathname === "/api/v1/helios-browser")
        return await this.heliosBrowser(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/helios-android-tooling")
        return await this.heliosAndroidTooling(request, response);
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/v1/settings/keyboard")
        return await this.keyboardPreferences(request, response);
      if (request.method === "POST" && url.pathname === "/api/v1/commands")
        return await this.command(request, response);
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/ui-responses/"))
        return await this.uiResponse(
          request,
          response,
          decodeURIComponent(url.pathname.slice("/api/v1/ui-responses/".length)),
        );
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/ui-ownership/"))
        return await this.uiOwnership(
          request,
          response,
          decodeURIComponent(url.pathname.slice("/api/v1/ui-ownership/".length)),
        );
      if (request.method === "POST" && url.pathname.startsWith("/api/v1/ui-keepalive/"))
        return await this.uiKeepAlive(
          request,
          response,
          decodeURIComponent(url.pathname.slice("/api/v1/ui-keepalive/".length)),
        );
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
      const status =
        error instanceof URIError
          ? 400
          : error && typeof error === "object" && "statusCode" in error
            ? (error as { statusCode: number }).statusCode
            : 500;
      this.send(response, status, {
        error: error instanceof Error ? error.message.slice(0, 500) : "internal server error",
      });
    }
  }

  private async annotations(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const mutation = request.method === "POST";
    const tabId = mutation ? this.tab(request, this.mutatingSession(request)) : this.requireTab(request);
    let input: AnnotationRequest | AnnotationMutation;
    if (mutation) {
      const body = await readJson(request);
      if (!validAnnotationMutation(body)) throw httpError(400, "Invalid annotation mutation");
      input = body;
      if (![...this.clients].some(client => client.tabId === tabId)) throw httpError(409, "the browser tab must have an SSE connection");
    } else {
      input = { sessionId: url.searchParams.get("sessionId") ?? "", expectedGeneration: Number(url.searchParams.get("generation")) };
    }
    const runtime = this.projection.snapshot();
    if (!runtime.ready || runtime.sessionId !== input.sessionId || input.expectedGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "Session changed or is unavailable. Reload notes.");
    if (!this.driver.annotationNotes || !this.driver.mutateAnnotation) throw httpError(409, "Annotations are unavailable");
    const result = mutation ? await this.driver.mutateAnnotation(input as AnnotationMutation) : await this.driver.annotationNotes(input);
    if (result.sessionGeneration !== this.journal.sessionGeneration || result.sessionId !== this.projection.snapshot().sessionId)
      throw httpError(409, "Session changed while accessing notes");
    this.renew(tabId);
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private bootstrap(request: IncomingMessage, response: ServerResponse): void {
    const session = this.session(request, response);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (validTabId(tabId) && !session.tabs.has(tabId) && session.tabs.size >= 32)
      throw httpError(429, "too many browser tabs");
    if (validTabId(tabId)) session.tabs.add(tabId);
    // Flush, snapshot, and cursor capture are one synchronous serialization boundary.
    this.projection.flush();
    const runtime = this.projection.selectedSnapshot();
    if (runtime) {
      const runtimeIssue = describeRuntimeSnapshotIssue(runtime);
      if (runtimeIssue) throw httpError(503, runtimeIssue);
    }
    const pending = this.pendingFor(tabId);
    const body: BootstrapSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: this.journal.sequence,
      sessionGeneration: this.journal.sessionGeneration,
      csrfToken: session.csrfToken,
      runtime,
      keyboardSettings: this.keyboardSettings.read(),
      unseenCompletionSessionIds: this.projection.unseenCompletionSessionIds(),
      ...(pending ? { pendingUi: pending } : {}),
    };
    this.send(response, 200, body);
  }

  private async keyboardPreferences(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.disposed) throw httpError(503, "Server closing");
    this.requireTab(request);
    if (request.method === "GET") return this.send(response, 200, this.keyboardSettings.read());
    this.mutatingSession(request);
    const body = await readJson(request, 16 * 1024) as { revision?: unknown; keymap?: unknown } | null;
    if (!body || typeof body !== "object" || Object.keys(body).some(key => !["revision", "keymap"].includes(key))
      || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw httpError(400, "Invalid keyboard settings revision");
    const problem = validateKeymap(body.keymap);
    if (problem) throw httpError(400, problem);
    try {
      const saved = this.keyboardSettings.update(body.revision as number, body.keymap as Keymap);
      this.publish("keyboard.settings", saved);
      this.send(response, 200, saved);
    } catch (error) {
      if (error instanceof KeyboardRevisionConflict) return this.send(response, 409, { error: error.message, current: error.current });
      throw error;
    }
  }

  private events(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const session = this.sessions.get(request);
    const tabId = url.searchParams.get("tabId") ?? undefined;
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("connection", "close");
      response.flushHeaders();
      response.end('event: stream.reset-required\ndata: {"reason":"session-invalid"}\n\n');
      return;
    }
    // EventSource cannot set Last-Event-ID for its first connection, so the
    // browser supplies the bootstrap cursor as a query parameter.
    const replay = this.journal.replay(
      header(request.headers["last-event-id"]) ?? url.searchParams.get("cursor") ?? undefined,
    );
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    if (!replay.ok) {
      response.write('event: stream.reset-required\ndata: {"reason":"cursor-invalid"}\n\n');
      response.end();
      return;
    }
    response.write(": connected\n\n");
    for (const event of replay.events) this.writeEvent(response, event, tabId);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keep-alive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    const client: SseClient = { response, session, tabId, heartbeat };
    this.clients.add(client);
    this.cancelTabLossGrace(session, tabId);
    this.renew(tabId);
    const close = () => this.removeClient(client);
    request.once("close", close);
    response.once("close", close);
  }

  private async heliosBrowserStream(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(request);
    const tabId = url.searchParams.get("tabId") ?? undefined;
    const generation = Number(url.searchParams.get("generation"));
    const width = Number(url.searchParams.get("width"));
    const height = Number(url.searchParams.get("height"));
    if (
      !validCsrf(session, url.searchParams.get("csrf") ?? undefined) ||
      !validTabId(tabId) ||
      !session?.tabs.has(tabId)
    )
      throw httpError(403, "forbidden");
    if (
      !Number.isSafeInteger(generation) ||
      generation !== this.journal.sessionGeneration ||
      !Number.isSafeInteger(width) ||
      width < 320 ||
      width > 1920 ||
      !Number.isSafeInteger(height) ||
      height < 240 ||
      height > 1080
    )
      throw httpError(400, "invalid Helios browser stream request");
    if (![...this.clients].some(client => client.tabId === tabId))
      throw httpError(409, "the browser tab must have an SSE connection");
    if (!this.driver.heliosBrowserStream) throw httpError(409, "Helios browser stream is unavailable");
    this.renew(tabId);
    response.statusCode = 200;
    response.setHeader("content-type", "multipart/x-mixed-replace; boundary=helios-frame");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    const controller = new AbortController();
    const mirror: HeliosMirrorClient = { session, tabId, controller };
    this.mirrors.add(mirror);
    let blocked = false;
    let closed = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const markBackpressure = (accepted: boolean) => {
      if (accepted || blocked) return;
      blocked = true;
      response.once("drain", () => (blocked = false));
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (settleTimer) clearTimeout(settleTimer);
      controller.abort(new Error("Browser mirror disconnected"));
    };
    request.once("close", close);
    response.once("close", close);
    try {
      await this.driver.heliosBrowserStream(
        { expectedGeneration: generation, owner: `web:${tabId}`, width, height },
        frame => {
          if (
            closed ||
            blocked ||
            response.writableEnded ||
            frame.mimeType !== "image/jpeg" ||
            frame.data.byteLength > 5 * 1024 * 1024
          )
            return;
          const header = Buffer.from(
            `--helios-frame\r\nContent-Type: ${frame.mimeType}\r\nContent-Length: ${frame.data.byteLength}\r\nX-Sequence: ${frame.sequence}\r\n\r\n`,
          );
          const part = Buffer.concat([header, Buffer.from(frame.data), Buffer.from("\r\n")]);
          if (settleTimer) clearTimeout(settleTimer);
          markBackpressure(response.write(part));
          // Chromium displays an MJPEG part only after the next boundary arrives. If the
          // page becomes static, one delayed duplicate terminates and reveals the frame.
          settleTimer = setTimeout(() => {
            settleTimer = undefined;
            if (!closed && !response.writableEnded) markBackpressure(response.write(part));
          }, 50);
          settleTimer.unref?.();
        },
        controller.signal,
      );
    } finally {
      if (settleTimer) clearTimeout(settleTimer);
      request.off("close", close);
      response.off("close", close);
      this.mirrors.delete(mirror);
      if (!response.writableEnded) response.end();
    }
  }

  private async heliosBrowser(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = validateHeliosBrowserCommand(await readJson(request));
    if (!input) throw httpError(400, "invalid Helios browser request");
    if (input.expectedGeneration !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (![...this.clients].some(client => client.tabId === tabId))
      throw httpError(409, "the browser tab must have an SSE connection");
    if (!this.driver.heliosBrowser) throw httpError(409, "Helios embedded browser is unavailable");
    this.renew(tabId);
    const result = await this.driver.heliosBrowser({ ...input, owner: `web:${tabId}` });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while controlling Helios browser");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async heliosAndroidTooling(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = validateHeliosAndroidToolingCommand(await readJson(request));
    if (!input) throw httpError(400, "invalid Helios Android tooling request");
    if (input.expectedGeneration !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (![...this.clients].some(client => client.tabId === tabId))
      throw httpError(409, "the browser tab must have an SSE connection");
    if (!this.driver.heliosAndroidTooling) throw httpError(409, "Helios Android tooling is unavailable");
    this.renew(tabId);
    const result = await this.driver.heliosAndroidTooling(input);
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while controlling Helios Android tooling");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async command(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const body = await readJsonWithSize(request, MAX_COMMAND_BODY_BYTES);
    const parsed = validateCommand(body.value);
    if (!parsed.ok) throw httpError(400, parsed.error);
    const command = parsed.value;
    if (
      !["prompt", "queuePrompt", "steer", "followUp", "editPrompt"].includes(command.type) &&
      body.bytes > (command.type === "mutateWorkspace" ? 6 * 1024 * 1024 + 4096 : MAX_JSON_BODY_BYTES)
    ) {
      throw httpError(413, "request body too large");
    }
    if (command.expectedGeneration !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    const runtime = this.projection.snapshot();
    if (!runtime.ready) throw httpError(409, "runtime is not ready");
    if (command.type !== "abort" && ![...this.clients].some(client => client.tabId === tabId)) {
      throw httpError(409, "the command tab must have an SSE connection");
    }
    this.renew(tabId);
    try {
      const accepted = await this.idempotency.execute(command, () => {
        if (command.expectedGeneration !== this.journal.sessionGeneration) {
          throw httpError(409, "stale session generation");
        }
        this.lastCommandOwner = tabId;
        return this.execute(command);
      });
      this.send(response, 200, accepted);
    } catch (error) {
      if (error instanceof Error && error.name === "IdempotencyConflictError") throw httpError(409, error.message);
      if (error instanceof Error && (error.name === "StaleGenerationError" || error.name === "StaleMemoryError"))
        throw httpError(409, error.message);
      throw error;
    }
  }

  private requireTab(request: IncomingMessage): string {
    const session = this.sessions.get(request);
    const tabId = header(request.headers["x-pylon-tab-id"]);
    if (!session || !validTabId(tabId) || !session.tabs.has(tabId)) throw httpError(403, "unknown tab");
    return tabId;
  }

  private async sessionList(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const query = url.searchParams.get("q")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 10 : Number(rawLimit);
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw httpError(400, "invalid projectId");
    if (cursor && (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor) || !decodeSessionCursor(cursor)))
      throw httpError(400, "invalid cursor");
    if (query && query.length > 200) throw httpError(400, "query is too long");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid limit");
    const result = await this.driver.listSessions({ projectId, cursor, query, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing sessions");
    this.send(response, 200, result);
  }

  private async localBranchList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireTab(request);
    if (!this.driver.listLocalBranches) throw httpError(404, "branch listing is unavailable");
    const result = await this.driver.listLocalBranches();
    if (result.sessionGeneration !== this.journal.sessionGeneration) {
      throw httpError(409, "session changed while listing branches");
    }
    this.send(response, 200, result);
  }

  private async usage(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const names = ["days", "from", "through"] as const;
    const values = Object.fromEntries(names.map(name => [name, url.searchParams.getAll(name)])) as Record<
      (typeof names)[number],
      string[]
    >;
    if (Object.values(values).some(items => items.length > 1)) throw httpError(400, "duplicate usage bound");
    const rawDays = values.days[0];
    const days =
      rawDays === undefined
        ? undefined
        : rawDays === "7"
          ? 7
          : rawDays === "30"
            ? 30
            : rawDays === "90"
              ? 90
              : undefined;
    if (rawDays !== undefined && days === undefined) throw httpError(400, "invalid days");
    if (days !== undefined && (values.from[0] !== undefined || values.through[0] !== undefined)) {
      throw httpError(400, "days cannot be combined with calendar bounds");
    }
    const input: UsageQuery =
      days !== undefined
        ? { days }
        : values.from[0] !== undefined || values.through[0] !== undefined
          ? {
              ...(values.from[0] !== undefined ? { from: values.from[0] } : {}),
              ...(values.through[0] !== undefined ? { through: values.through[0] } : {}),
            }
          : { days: 30 };
    try {
      usageWindow(input);
    } catch (cause) {
      throw httpError(400, cause instanceof Error ? cause.message : "invalid usage range");
    }
    const result = await this.driver.usage(input);
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading usage");
    this.send(response, 200, result);
  }

  private async packageList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireTab(request);
    const result = await this.driver.listPackages();
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing packages");
    this.send(response, 200, result);
  }

  private async hookSettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireTab(request);
    if (!this.driver.listHookSettings) throw httpError(409, "hook settings are unavailable");
    const result = await this.driver.listHookSettings();
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing hook settings");
    this.send(response, 200, result);
  }

  private async stateqlSnapshot(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    if ([...url.searchParams.keys()].some(key => !["generation", "historyLimit", "workspace"].includes(key)))
      throw httpError(400, "invalid StateQL snapshot request");
    const generation = Number(url.searchParams.get("generation"));
    const historyLimit = Number(url.searchParams.get("historyLimit") ?? 50);
    const workspaces = url.searchParams.getAll("workspace");
    const workspace = (workspaces[0] ?? "session") as StateQLWorkspace;
    if (workspaces.length > 1 || !isStateQLWorkspace(workspace)) throw httpError(400, "invalid StateQL workspace");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 100)
      throw httpError(400, "invalid StateQL history limit");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.stateqlSnapshot) throw httpError(409, "StateQL snapshot is unavailable");
    const result = await this.driver.stateqlSnapshot(historyLimit, workspace);
    if (result.sessionGeneration !== this.journal.sessionGeneration || result.workspace !== workspace)
      throw httpError(409, "session changed while loading StateQL status");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async stateqlRows(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw httpError(400, "invalid StateQL rows request");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["generation", "workspace", "handle", "offset", "limit"].includes(key)))
      throw httpError(400, "invalid StateQL rows request");
    const workspace = (body.workspace ?? "session") as StateQLWorkspace;
    if (!isStateQLWorkspace(workspace)) throw httpError(400, "invalid StateQL workspace");
    if (
      typeof body.generation !== "number" ||
      !Number.isSafeInteger(body.generation) ||
      body.generation !== this.journal.sessionGeneration
    ) {
      throw httpError(409, "stale session generation");
    }
    if (
      typeof body.handle !== "string" ||
      !body.handle.trim() ||
      body.handle.length > 200 ||
      typeof body.offset !== "number" ||
      !Number.isSafeInteger(body.offset) ||
      body.offset < 0 ||
      body.offset > 10_000 ||
      typeof body.limit !== "number" ||
      !Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > 100
    ) {
      throw httpError(400, "invalid StateQL rows request");
    }
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.stateqlRows) throw httpError(409, "StateQL rows are unavailable");
    this.renew(tabId);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    let result;
    try {
      result = await this.driver.stateqlRows(body.handle, body.offset, body.limit, controller.signal, workspace);
    } finally {
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
    }
    if (result.sessionGeneration !== this.journal.sessionGeneration || result.workspace !== workspace)
      throw httpError(409, "session changed while loading StateQL rows");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async stateqlExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    this.tab(request, session);
    const body = (await readJson(request)) as Record<string, unknown>;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some(key => !["generation", "workspace", "handle", "format"].includes(key)) ||
      typeof body.handle !== "string" ||
      !body.handle ||
      body.handle.length > 200 ||
      !["json", "jsonl", "csv"].includes(String(body.format))
    )
      throw httpError(400, "Invalid export request");
    const workspace = (body.workspace ?? "session") as StateQLWorkspace;
    if (!isStateQLWorkspace(workspace)) throw httpError(400, "invalid StateQL workspace");
    if (body.generation !== this.journal.sessionGeneration || !this.projection.isReady())
      throw httpError(409, "Session is not ready");
    if (!this.driver.stateqlExport) throw httpError(409, "StateQL exports are unavailable");
    if (this.exportController) throw httpError(409, "An export is already running");
    const controller = new AbortController();
    this.exportController = controller;
    const cancel = () => controller.abort();
    const timeout = setTimeout(cancel, 35_000);
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      const result = await this.driver.stateqlExport(
        body.handle,
        body.format as "json" | "jsonl" | "csv",
        controller.signal,
        workspace,
      );
      controller.signal.throwIfAborted();
      if (result.sessionGeneration !== this.journal.sessionGeneration || result.workspace !== workspace)
        throw httpError(409, "Session changed during export");
      response.setHeader("cache-control", "no-store");
      response.setHeader(
        "content-type",
        result.format === "csv"
          ? "text/csv; charset=utf-8"
          : result.format === "jsonl"
            ? "application/x-ndjson"
            : "application/json",
      );
      response.setHeader("content-disposition", 'attachment; filename="result.' + result.format + '"');
      response.setHeader("content-length", Buffer.byteLength(result.content, "utf8"));
      response.end(result.content);
    } finally {
      clearTimeout(timeout);
      if (this.exportController === controller) this.exportController = undefined;
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
    }
  }

  private async stateqlCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw httpError(400, "invalid StateQL command request");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["generation", "workspace", "input", "expectedConnectionId", "operationId"].includes(key)))
      throw httpError(400, "invalid StateQL command request");
    const workspace = (body.workspace ?? "session") as StateQLWorkspace;
    if (!isStateQLWorkspace(workspace)) throw httpError(400, "invalid StateQL workspace");
    if (
      typeof body.generation !== "number" ||
      !Number.isSafeInteger(body.generation) ||
      body.generation !== this.journal.sessionGeneration
    )
      throw httpError(409, "stale session generation");
    if (!isStateQLCommandInput(body.input)) throw httpError(400, "invalid StateQL command request");
    if (
      body.expectedConnectionId !== undefined &&
      body.expectedConnectionId !== null &&
      (typeof body.expectedConnectionId !== "string" ||
        !body.expectedConnectionId ||
        body.expectedConnectionId.length > 200)
    )
      throw httpError(400, "invalid database connection scope");
    if (body.operationId !== undefined && !validOperationId(body.operationId))
      throw httpError(400, "invalid database operation correlation");
    if (this.databaseCommand) throw httpError(409, "A database command is already running");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.stateqlCommand) throw httpError(409, "StateQL commands are unavailable");
    if (![...this.clients].some(client => client.tabId === tabId))
      throw httpError(409, "the StateQL command tab must have an SSE connection");
    this.renew(tabId);
    const controller = new AbortController();
    const commandOwner = { tabId, controller };
    this.databaseCommand = commandOwner;
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    let result: Awaited<ReturnType<NonNullable<PiDriver["stateqlCommand"]>>>;
    try {
      result = await this.driver.stateqlCommand(
        body.input as StateQLCommandInput,
        controller.signal,
        body.expectedConnectionId as string | null | undefined,
        body.operationId as string | undefined,
        workspace,
      );
    } finally {
      request.removeListener("aborted", cancel);
      response.removeListener("close", cancel);
      if (this.databaseCommand === commandOwner) this.databaseCommand = undefined;
    }
    if (result.sessionGeneration !== this.journal.sessionGeneration || result.workspace !== workspace)
      throw httpError(409, "session changed while running StateQL command");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async papercutList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw httpError(400, "invalid papercut list request");
    const body = input as Record<string, unknown>;
    if (
      !Number.isSafeInteger(body.generation) ||
      body.generation !== this.journal.sessionGeneration ||
      !["open", "resolved", "dismissed", "all"].includes(String(body.status)) ||
      typeof body.query !== "string" ||
      body.query.length > 200 ||
      !Number.isSafeInteger(body.offset) ||
      (body.offset as number) < 0 ||
      (body.offset as number) > 1_000 ||
      !Number.isSafeInteger(body.limit) ||
      (body.limit as number) < 1 ||
      (body.limit as number) > 50
    )
      throw httpError(400, "invalid papercut list request");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.papercutList) throw httpError(409, "Papercuts are unavailable");
    this.renew(tabId);
    const result = await this.driver.papercutList(
      body.status as "open" | "resolved" | "dismissed" | "all",
      body.query,
      body.offset as number,
      body.limit as number,
    );
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading papercuts");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async papercutMutation(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw httpError(400, "invalid papercut mutation request");
    const body = input as Record<string, unknown>;
    if (!Number.isSafeInteger(body.generation) || body.generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (
      !["edit", "delete"].includes(String(body.action)) ||
      typeof body.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id) ||
      typeof body.expectedUpdatedAt !== "string" ||
      Number.isNaN(Date.parse(body.expectedUpdatedAt)) ||
      (body.action === "edit" &&
        (typeof body.message !== "string" || !body.message.trim() || body.message.length > 500)) ||
      (body.action === "delete" && body.message !== undefined)
    )
      throw httpError(400, "invalid papercut mutation request");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.papercutMutation) throw httpError(409, "Papercut mutations are unavailable");
    this.renew(tabId);
    try {
      const mutation =
        body.action === "edit"
          ? {
              action: "edit" as const,
              id: body.id,
              expectedUpdatedAt: body.expectedUpdatedAt,
              message: body.message as string,
            }
          : { action: "delete" as const, id: body.id, expectedUpdatedAt: body.expectedUpdatedAt };
      const result = await this.driver.papercutMutation(mutation);
      if (result.sessionGeneration !== this.journal.sessionGeneration)
        throw httpError(409, "session changed while updating papercut");
      response.setHeader("cache-control", "no-store");
      this.send(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update papercut";
      if (/changed or was removed/i.test(message)) throw httpError(409, message);
      if (/already uses this message/i.test(message)) throw httpError(409, message);
      if (/message is invalid/i.test(message)) throw httpError(400, message);
      throw error;
    }
  }

  private async conversationHistory(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const cursor = url.searchParams.get("cursor") ?? "";
    const generation = Number(url.searchParams.get("generation"));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    const direction = url.searchParams.get("direction") ?? "before";
    if (!cursor || cursor.length > 128 || decodeHistoryCursor(cursor) === undefined)
      throw httpError(400, "invalid history cursor");
    if (!["before", "after", "around"].includes(direction)) throw httpError(400, "invalid history direction");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid history limit");
    const result = await this.driver.conversationHistory({
      cursor,
      limit,
      direction: direction as "before" | "after" | "around",
    });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading history");
    this.send(response, 200, result);
  }

  private async conversationAttachment(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const sourceEntryId = url.searchParams.get("entry") ?? "";
    const index = Number(url.searchParams.get("index"));
    const generation = Number(url.searchParams.get("generation"));
    if (!sourceEntryId || sourceEntryId.length > 128) throw httpError(400, "invalid attachment entry");
    if (!Number.isSafeInteger(index) || index < 0 || index >= 100) throw httpError(400, "invalid attachment index");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.driver.conversationAttachment) throw httpError(404, "conversation attachments are unavailable");
    try {
      const result = await this.driver.conversationAttachment({ sourceEntryId, index });
      if (result.sessionGeneration !== this.journal.sessionGeneration)
        throw httpError(409, "session changed while loading attachment");
      this.send(response, 200, result);
    } catch (error) {
      if (error instanceof Error && /attachment is|attachments are/i.test(error.message))
        throw httpError(404, error.message);
      throw error;
    }
  }

  private async localImage(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const source = url.searchParams.get("source") ?? "";
    const generationValue = url.searchParams.get("generation");
    if (!source || source.length > 8_192) throw httpError(400, "invalid local image URL");
    if (generationValue === null || !/^\d+$/.test(generationValue)) throw httpError(400, "invalid session generation");
    const generation = Number(generationValue);
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.driver.localImage) throw httpError(404, "local images are unavailable");
    const result = await this.driver.localImage({ source });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading local image");
    this.send(response, 200, result);
  }
  private async turnDiff(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const entryId = url.searchParams.get("entry") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(entryId)) throw httpError(400, "invalid turn entry ID");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.driver.turnDiff) throw httpError(404, "turn diffs are unavailable");
    try {
      const result = await this.driver.turnDiff({ entryId });
      if (result.sessionGeneration !== this.journal.sessionGeneration)
        throw httpError(409, "session changed while loading turn diff");
      this.send(response, 200, result);
    } catch (error) {
      if (error instanceof Error && /unavailable/i.test(error.message)) throw httpError(404, error.message);
      throw error;
    }
  }

  private async conversationTurnIndex(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const direction = url.searchParams.get("direction") ?? "earlier";
    const generation = Number(url.searchParams.get("generation"));
    const limit = Number(url.searchParams.get("limit") ?? 250);
    if (cursor && (cursor.length > 128 || decodeTurnIndexCursor(cursor) === undefined))
      throw httpError(400, "invalid turn cursor");
    if (!["earlier", "later"].includes(direction)) throw httpError(400, "invalid turn direction");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw httpError(400, "invalid turn limit");
    if (!this.driver.conversationTurnIndex) throw httpError(404, "conversation turn index is unavailable");
    const result = await this.driver.conversationTurnIndex({
      cursor,
      direction: direction as "earlier" | "later",
      limit,
    });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading turns");
    this.send(response, 200, result);
  }

  private async fileSuggestions(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const generation = Number(url.searchParams.get("generation"));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 15 : Number(rawLimit);
    if (query.length > 200) throw httpError(400, "query is too long");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw httpError(400, "invalid limit");
    const result = await this.driver.fileSuggestions({ query, limit });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing files");
    this.send(response, 200, result);
  }

  private async workspaceFiles(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.driver.workspaceFiles) throw httpError(404, "workspace files are unavailable");
    const query = url.searchParams.get("q")?.trim() ?? "";
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const refresh = url.searchParams.get("refresh") === "1";
    if (
      query.length > 200 ||
      (cursor && cursor.length > 128) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw httpError(400, "invalid file query");
    const result = await this.driver.workspaceFiles({ query, cursor, limit, refresh });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing files");
    this.send(response, 200, result);
  }

  private async workspaceSearch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (!this.driver.workspaceSearch) throw httpError(404, "workspace search is unavailable");
    const query = url.searchParams.get("q") ?? "";
    const glob = url.searchParams.get("glob") ?? undefined;
    const flag = (name: string) => { const value = url.searchParams.get(name); if (value !== null && value !== "0" && value !== "1") throw httpError(400, `invalid ${name}`); return value === "1"; };
    if (!query || query.length > 2000 || /[\0\r\n]/.test(query) || glob && (glob.length > 500 || /[\0\r\n]/.test(glob))) throw httpError(400, "invalid workspace search query");
    const input: WorkspaceSearchQuery = { query, regex: flag("regex"), caseSensitive: flag("caseSensitive"), wholeWord: flag("wholeWord"), touched: flag("touched"), ...(glob ? { glob } : {}) };
    const controller = new AbortController();
    request.once("aborted", () => controller.abort(new Error("Client disconnected")));
    response.once("close", () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected")); });
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    const send = async (event: string, value: unknown) => {
      if (controller.signal.aborted) return;
      if (event !== "error" && generation !== this.journal.sessionGeneration) throw httpError(409, "session changed while searching workspace");
      const line = JSON.stringify({ event, result: value }) + "\n";
      if (!response.write(line)) await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => controller.abort(new Error("Search consumer stalled")), 30_000);
        const cleanup = () => { clearTimeout(timer); response.off("drain", drained); controller.signal.removeEventListener("abort", aborted); };
        const drained = () => { cleanup(); resolvePromise(); };
        const aborted = () => { cleanup(); reject(controller.signal.reason); };
        response.once("drain", drained);
        controller.signal.addEventListener("abort", aborted, { once: true });
        if (controller.signal.aborted) aborted();
      });
    };
    try {
      const result = await this.driver.workspaceSearch({ ...input, expectedGeneration: generation }, value => send("update", value), controller.signal);
      if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while searching workspace");
      await send("done", result);
    } catch (error) {
      if (!controller.signal.aborted) await send("error", { error: error instanceof Error ? error.message.slice(0, 1000) : "Workspace search failed" });
    } finally { response.end(); }
  }

  private async workspaceSymbols(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const query = url.searchParams.get("q") ?? "";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration) throw httpError(409, "stale session generation");
    if (query.length > 2000 || query.includes("\0")) throw httpError(400, "invalid workspace symbol query");
    if (!this.driver.workspaceSymbols) throw httpError(404, "workspace symbols are unavailable");
    const controller = new AbortController(); request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    const result: WorkspaceSymbolResult = await this.driver.workspaceSymbols(query, controller.signal);
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while searching symbols");
    this.send(response, 200, result);
  }


  private async workspaceEntry(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const path = url.searchParams.get("path") ?? "";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!path || path.length > 500) throw httpError(400, "invalid workspace path");
    if (!this.driver.workspaceEntry) throw httpError(404, "workspace editing is unavailable");
    const moveDestination = url.searchParams.get("moveDestination") ?? undefined;
    if (moveDestination !== undefined && (!moveDestination || moveDestination.length > 500)) throw httpError(400, "invalid move destination");
    const entry = await this.driver.workspaceEntry(path, moveDestination, url.searchParams.get("gitIndex") !== "false");
    if (entry.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while inspecting entry");
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, entry);
  }

  private async workspaceGitIndex(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const path = url.searchParams.get("path") ?? "";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!validWorkspacePath(path)) throw httpError(400, "invalid workspace path");
    if (!this.driver.workspaceGitIndex) throw httpError(404, "workspace comparison is unavailable");
    const result = await this.driver.workspaceGitIndex(path);
    if (result.sessionGeneration !== this.journal.sessionGeneration) throw httpError(409, "session changed while reading index");
    this.send(response, 200, result);
  }

  private async gitRead<T>(response: ServerResponse, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const closed = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", closed);
    try { return await load(controller.signal); }
    finally { response.off("close", closed); }
  }

  private async workspaceGitState(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("sessionGeneration"));
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.workspaceGitState) throw httpError(404, "Git workspace is unavailable");
    const result = await this.gitRead(response, signal => this.driver.workspaceGitState!(signal));
    const runtime = this.projection.snapshot();
    if (
      result.sessionGeneration !== this.journal.sessionGeneration ||
      result.sessionId !== runtime.sessionId
    ) {
      throw httpError(409, "session changed while reading Git state");
    }
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async workspaceGitDetail(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("sessionGeneration"));
    const values = url.searchParams.getAll("query");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (values.length !== 1 || values[0].length > 8_192) throw httpError(400, "invalid Git detail query");
    let query: unknown;
    try {
      query = JSON.parse(values[0]);
    } catch {
      throw httpError(400, "invalid Git detail query");
    }
    if (!validGitDetailQuery(query)) throw httpError(400, "invalid Git detail query");
    if (!this.projection.isReady()) throw httpError(409, "runtime is not ready");
    if (!this.driver.workspaceGitDetail) throw httpError(404, "Git detail is unavailable");
    const detailQuery = query;
    const result = await this.gitRead(response, signal => this.driver.workspaceGitDetail!(detailQuery, signal));
    const runtime = this.projection.snapshot();
    if (
      result.sessionGeneration !== this.journal.sessionGeneration ||
      result.sessionId !== runtime.sessionId
    ) {
      throw httpError(409, "session changed while reading Git detail");
    }
    response.setHeader("cache-control", "no-store");
    this.send(response, 200, result);
  }

  private async workspaceFile(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    diff: boolean,
  ): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const path = url.searchParams.get("path") ?? "";
    const view = url.searchParams.get("view") === "base" ? "base" : "current";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (
      !path ||
      path.length > 500 ||
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")
    ) {
      throw httpError(400, "invalid workspace path");
    }
    const method = diff ? this.driver.workspaceDiff : this.driver.workspaceFile;
    if (!method) throw httpError(404, "workspace file view is unavailable");
    const result = await method.call(this.driver, { path, view });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while reading file");
    this.send(response, 200, result);
  }

  private async workspaceHistory(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!this.driver.fileHistory) throw httpError(404, "workspace file history is unavailable");
    const path = url.searchParams.get("path") ?? "";
    const scope = url.searchParams.get("scope") ?? "session";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 40 : Number(rawLimit);
    const selected = url.searchParams.get("selected") ?? undefined;
    const view = url.searchParams.get("view") ?? "file";
    if (
      !path ||
      path.length > 500 ||
      /[\0\r\n\\]/.test(path) ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")
    ) {
      throw httpError(400, "invalid history path");
    }
    if (scope !== "session" && scope !== "all") throw httpError(400, "invalid history scope");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw httpError(400, "invalid history limit");
    if (selected !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(selected))
      throw httpError(400, "invalid history selection");
    if (view !== "file" && view !== "diff" && view !== "change") throw httpError(400, "invalid history view");
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    const result = await this.driver.fileHistory({
      path,
      scope,
      limit,
      ...(selected ? { selected } : {}),
      view,
    } satisfies FileHistoryQuery, controller.signal);
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while loading file history");
    this.send(response, 200, result);
  }

  private async timelineCheckpoint(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    diff: boolean,
  ): Promise<void> {
    this.requireTab(request);
    const generation = Number(url.searchParams.get("generation"));
    const checkpointId = url.searchParams.get("checkpointId") ?? "";
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(checkpointId)) throw httpError(400, "invalid checkpoint ID");
    if (!diff) {
      if (!this.driver.timelineCheckpointFiles) throw httpError(404, "Timeline files are unavailable");
      const result = await this.driver.timelineCheckpointFiles({ checkpointId });
      if (result.sessionGeneration !== this.journal.sessionGeneration)
        throw httpError(409, "session changed while reading Timeline");
      return this.send(response, 200, result);
    }
    const path = url.searchParams.get("path") ?? "";
    if (
      !path ||
      path.length > 500 ||
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..")
    )
      throw httpError(400, "invalid Timeline path");
    if (!this.driver.timelineCheckpointDiff) throw httpError(404, "Timeline diff is unavailable");
    const result = await this.driver.timelineCheckpointDiff({ checkpointId, path });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while reading Timeline");
    this.send(response, 200, result);
  }

  private async queuedPrompt(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const tabId = this.requireTab(request);
    const queueId = url.searchParams.get("queueId") ?? "";
    const generation = Number(url.searchParams.get("generation"));
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(queueId)) throw httpError(400, "invalid queueId");
    if (!Number.isSafeInteger(generation) || generation !== this.journal.sessionGeneration)
      throw httpError(409, "stale session generation");
    const queued = await this.driver.queuedPrompt({ queueId, expectedGeneration: generation }).catch(error => {
      throw httpError(409, error instanceof Error ? error.message : "queued prompt is unavailable");
    });
    this.renew(tabId);
    this.send(response, 200, queued);
  }

  private async extensionList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireTab(request);
    if (!this.driver.listExtensions) throw httpError(409, "native extensions are unavailable");
    const result = await this.driver.listExtensions();
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing extensions");
    this.send(response, 200, result);
  }

  private async skillList(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requireTab(request);
    if (!this.driver.listSkills) throw httpError(409, "skills are unavailable");
    const result = await this.driver.listSkills();
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing skills");
    this.send(response, 200, result);
  }

  private async archiveList(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.requireTab(request);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const query = url.searchParams.get("q")?.trim() || undefined;
    const projectId = url.searchParams.get("project")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (cursor && (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor) || !decodeSessionCursor(cursor)))
      throw httpError(400, "invalid cursor");
    if (query && query.length > 200) throw httpError(400, "query is too long");
    if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw httpError(400, "invalid project");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "invalid limit");
    const result = await this.driver.listArchived({ cursor, query, limit, projectId });
    if (result.sessionGeneration !== this.journal.sessionGeneration)
      throw httpError(409, "session changed while listing archives");
    this.send(response, 200, result);
  }

  private async uiResponse(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const pending = this.projection.pendingUi;
    const owner = this.dialogOwner;
    if (!pending || !owner || pending.requestId !== requestId || owner.requestId !== requestId)
      throw httpError(409, "UI request is not pending");
    if (owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
    const body = await readJson(request);
    if (this.dialogOwner !== owner || this.projection.pendingUi !== pending)
      throw httpError(409, "UI request is no longer pending");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "UI response must be an object");
    const value = body as Record<string, unknown>;
    if (value.requestId !== undefined && value.requestId !== requestId)
      throw httpError(400, "requestId does not match path");
    if (value.sessionGeneration !== this.journal.sessionGeneration || value.method !== pending.method)
      throw httpError(409, "UI response does not match pending request");
    const responseValue = {
      requestId,
      sessionGeneration: value.sessionGeneration,
      method: value.method,
      cancelled: value.cancelled === true,
      value: value.value,
      confirmed: value.confirmed,
      answers: value.answers,
    } as Parameters<PiDriver["answerUiRequest"]>[0];
    try {
      await this.driver.answerUiRequest(responseValue);
    } catch (error) {
      throw httpError(400, error instanceof Error ? error.message : "invalid UI response");
    }
    this.renew(tabId);
    this.send(response, 200, { accepted: true, requestId });
  }

  private async uiOwnership(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const pending = this.projection.pendingUi;
    const owner = this.dialogOwner;
    if (!pending || !owner || pending.requestId !== requestId || owner.requestId !== requestId)
      throw httpError(409, "UI request is not pending");
    const body = await readJson(request);
    if (this.dialogOwner !== owner || this.projection.pendingUi !== pending)
      throw httpError(409, "UI request is no longer pending");
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw httpError(400, "ownership request must be an object");
    const value = body as Record<string, unknown>;
    if (
      value.sessionGeneration !== owner.sessionGeneration ||
      owner.sessionGeneration !== this.journal.sessionGeneration
    )
      throw httpError(409, "stale session generation");
    if (value.action === "release") {
      if (owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
      this.releaseDialogOwner(owner);
    } else if (value.action === "claim") {
      if (owner.tabId !== undefined && owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
      if (![...this.clients].some(client => client.tabId === tabId))
        throw httpError(409, "claiming tab must have an SSE connection");
      owner.tabId = tabId;
      this.renew(tabId);
    } else {
      throw httpError(400, "unknown ownership action");
    }
    this.publishOwnership(requestId);
    this.send(response, 200, { accepted: true, requestId });
  }

  private async uiKeepAlive(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const session = this.mutatingSession(request);
    const tabId = this.tab(request, session);
    const pending = this.projection.pendingUi;
    const owner = this.dialogOwner;
    if (!pending || !owner || pending.requestId !== requestId || owner.requestId !== requestId) {
      throw httpError(409, "UI request is not pending");
    }
    if (owner.tabId !== tabId) throw httpError(409, "UI request belongs to another tab");
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw httpError(400, "keepalive request must be an object");
    const generation = (body as Record<string, unknown>).sessionGeneration;
    if (generation !== owner.sessionGeneration || owner.sessionGeneration !== this.journal.sessionGeneration) {
      throw httpError(409, "stale session generation");
    }
    let expiresAt: string | undefined;
    try {
      const renewed = this.driver.keepUiRequestAlive(requestId, generation);
      expiresAt = typeof renewed === "string" ? renewed : undefined;
    } catch (error) {
      throw httpError(409, error instanceof Error ? error.message : "UI request is unavailable");
    }
    this.renew(tabId);
    this.send(response, 200, { accepted: true, requestId, ...(expiresAt ? { expiresAt } : {}) });
  }

  private execute(command: WebCommand): Promise<AcceptedCommand> {
    const accepted = (sessionGeneration: number): AcceptedCommand => ({
      commandId: command.commandId,
      sessionGeneration,
      accepted: true,
    });
    switch (command.type) {
      case "prompt":
        return this.driver.prompt(command);
      case "queuePrompt":
        return this.driver.queuePrompt(command);
      case "restoreQueuedPrompt":
        return this.driver.restoreQueuedPrompt(command).then(() => accepted(command.expectedGeneration));
      case "steerQueuedPrompt":
        return this.driver.steerQueuedPrompt(command);
      case "steer":
        return this.driver.steer(command);
      case "followUp":
        return this.driver.followUp(command);
      case "abort":
        return this.driver.abort().then(() => accepted(command.expectedGeneration));
      case "addProject":
        return this.driver
          .addProject({ expectedGeneration: command.expectedGeneration })
          .then(result => accepted(result.sessionGeneration));
      case "removeProject":
        return this.driver
          .removeProject({ projectId: command.projectId, expectedGeneration: command.expectedGeneration })
          .then(result => accepted(result.sessionGeneration));
      case "renameProject":
        return this.driver.renameProject(command).then(() => accepted(command.expectedGeneration));
      case "reorderProject":
        return this.driver.reorderProject(command).then(() => accepted(command.expectedGeneration));
      case "archiveProject":
        return this.driver.archiveProject(command).then(result => accepted(result.sessionGeneration));
      case "restoreProject":
        return this.driver.restoreProject(command).then(() => accepted(command.expectedGeneration));
      case "newSession":
        return this.driver
          .newSession({
            parentSessionId: command.parentSessionId,
            projectId: command.projectId,
            expectedGeneration: command.expectedGeneration,
          })
          .then(result => accepted(result.sessionGeneration));
      case "switchSession":
        return this.driver
          .switchSession({ sessionId: command.sessionId })
          .then(result => accepted(result.sessionGeneration));
      case "deleteSession":
        return this.driver
          .deleteSession({ sessionId: command.sessionId, expectedGeneration: command.expectedGeneration })
          .then(() => accepted(command.expectedGeneration));
      case "archiveSession":
        return this.driver.archiveSession(command).then(result => accepted(result.sessionGeneration));
      case "restoreSession":
        return this.driver.restoreSession(command).then(() => accepted(command.expectedGeneration));
      case "renameSession":
        return this.driver
          .renameSession({ sessionId: command.sessionId, name: command.name })
          .then(() => accepted(command.expectedGeneration));
      case "setSessionActive":
        return this.driver
          .setSessionActive({ sessionId: command.sessionId, active: command.active })
          .then(() => accepted(command.expectedGeneration));
      case "setSessionPinned":
        return this.driver
          .setSessionPinned({ sessionId: command.sessionId, pinned: command.pinned })
          .then(() => accepted(command.expectedGeneration));
      case "reorderActiveSession":
        return this.driver.reorderActiveSession(command).then(() => accepted(command.expectedGeneration));
      case "checkoutBranch":
        if (!this.driver.checkoutBranch) throw new Error("branch checkout is unavailable");
        return this.driver.checkoutBranch(command).then(result => accepted(result.sessionGeneration));
      case "editPrompt":
        return this.driver.editPrompt(command);
      case "rewindPrompt":
        return this.driver.rewindPrompt(command);
      case "fork":
        return this.driver
          .fork({
            expectedGeneration: command.expectedGeneration,
            entryId: command.entryId,
            name: command.name,
            position: command.position,
            mode: command.mode,
          })
          .then(result => accepted(result.sessionGeneration));
      case "timeline": {
        const message = `/timeline ${command.action}${command.checkpointId ? ` ${command.checkpointId}` : ""}`;
        return this.driver.prompt({
          commandId: command.commandId,
          expectedGeneration: command.expectedGeneration,
          message,
        });
      }
      case "setPackageEnabled":
        return this.driver
          .setPackageEnabled({ packageId: command.packageId, enabled: command.enabled })
          .then(result => accepted(result.sessionGeneration));
      case "updatePackageSettings":
        return this.driver
          .updatePackageSettings({ packageId: command.packageId, settings: command.settings })
          .then(result => accepted(result.sessionGeneration));
      case "setExtensionEnabled":
        if (!this.driver.setExtensionEnabled)
          return Promise.reject(httpError(409, "native extensions are unavailable"));
        return this.driver
          .setExtensionEnabled({ extensionId: command.extensionId, enabled: command.enabled })
          .then(result => accepted(result.sessionGeneration));
      case "installExtensionPackage":
        if (!this.driver.installExtensionPackage)
          return Promise.reject(httpError(409, "native extensions are unavailable"));
        return this.driver
          .installExtensionPackage({ source: command.source, scope: command.scope, projectId: command.projectId })
          .then(result => accepted(result.sessionGeneration));
      case "removeExtensionPackage":
        if (!this.driver.removeExtensionPackage)
          return Promise.reject(httpError(409, "native extensions are unavailable"));
        return this.driver
          .removeExtensionPackage({ source: command.source, scope: command.scope })
          .then(result => accepted(result.sessionGeneration));
      case "setProjectTrust":
        if (!this.driver.setProjectTrust) return Promise.reject(httpError(409, "project trust is unavailable"));
        return this.driver
          .setProjectTrust({ trusted: command.trusted })
          .then(result => accepted(result.sessionGeneration));
      case "reloadExtensions":
        if (!this.driver.reloadExtensions) return Promise.reject(httpError(409, "native extensions are unavailable"));
        return this.driver.reloadExtensions().then(result => accepted(result.sessionGeneration));
      case "updateHookSettings":
        if (!this.driver.updateHookSettings) return Promise.reject(httpError(409, "hook settings are unavailable"));
        return this.driver
          .updateHookSettings({ settings: command.settings })
          .then(() => accepted(command.expectedGeneration));
      case "rebuildDiscoverIndex":
        return this.driver.rebuildDiscoverIndex().then(() => accepted(command.expectedGeneration));
      case "refreshModelCatalogs":
        if (!this.driver.refreshModelCatalogs) return Promise.reject(httpError(409, "model catalogs are unavailable"));
        return (async () => {
          try {
            await this.driver.refreshModelCatalogs!(command.expectedGeneration);
          } finally {
            this.projection.refresh(await this.driver.snapshot());
          }
          return accepted(command.expectedGeneration);
        })();
      case "setModel":
        return this.driver.setModel({ provider: command.provider, modelId: command.modelId }).then(async () => {
          this.projection.refresh(await this.driver.snapshot());
          return accepted(command.expectedGeneration);
        });
      case "setThinkingLevel":
        return Promise.resolve()
          .then(() => this.driver.setThinkingLevel({ level: command.level }))
          .then(async () => {
            this.projection.refresh(await this.driver.snapshot());
            return accepted(command.expectedGeneration);
          });
      case "setSessionControls":
        return this.driver
          .setSessionControls({
            provider: command.provider,
            modelId: command.modelId,
            thinkingLevel: command.thinkingLevel,
          })
          .then(async () => {
            this.projection.refresh(await this.driver.snapshot());
            return accepted(command.expectedGeneration);
          });
      case "startProviderLogin":
        if (!this.driver.startProviderLogin)
          return Promise.reject(httpError(409, "provider authentication is unavailable"));
        return this.driver.startProviderLogin(command).then(() => accepted(command.expectedGeneration));
      case "cancelProviderLogin":
        if (!this.driver.cancelProviderLogin)
          return Promise.reject(httpError(409, "provider authentication is unavailable"));
        return this.driver
          .cancelProviderLogin(command.expectedGeneration)
          .then(() => accepted(command.expectedGeneration));
      case "logoutProvider":
        if (!this.driver.logoutProvider)
          return Promise.reject(httpError(409, "provider authentication is unavailable"));
        return this.driver
          .logoutProvider(command.provider, command.expectedGeneration)
          .then(() => accepted(command.expectedGeneration));
      case "updateContinuityMemory":
        return this.driver.updateContinuityMemory(command).then(() => accepted(command.expectedGeneration));
      case "deleteContinuityMemory":
        return this.driver.deleteContinuityMemory(command).then(() => accepted(command.expectedGeneration));
      case "migrateContinuityMemory":
        return this.driver
          .migrateContinuityMemory({ expectedGeneration: command.expectedGeneration })
          .then(() => accepted(command.expectedGeneration));
      case "continuityPlanAction":
        return this.driver.continuityPlanAction(command).then(() => accepted(command.expectedGeneration));
      case "handoffSession":
        if (!this.driver.handoffSession) return Promise.reject(httpError(409, "workspace handoff is unavailable"));
        return this.driver.handoffSession(command).then(result => accepted(result.sessionGeneration));
      case "applySessionChanges":
        if (!this.driver.applySessionChanges)
          return Promise.reject(httpError(409, "applying session changes is unavailable"));
        return this.driver.applySessionChanges(command).then(result => accepted(result.sessionGeneration));
      case "mutateWorkspace":
        if (!this.driver.mutateWorkspace) return Promise.reject(httpError(409, "workspace editing is unavailable"));
        return this.driver.mutateWorkspace(command).then(result => ({ ...accepted(command.expectedGeneration), ...(result ? { savedVersion: result.savedVersion } : {}) }));
      case "gitAction":
        if (!this.driver.gitAction) return Promise.reject(httpError(409, "Git actions are unavailable"));
        return this.driver.gitAction(command);
      case "updateProjectWorktreeSettings":
        if (!this.driver.updateProjectWorktreeSettings)
          return Promise.reject(httpError(409, "worktree settings are unavailable"));
        return this.driver.updateProjectWorktreeSettings(command).then(() => accepted(command.expectedGeneration));
      case "updateRuntimePolicy":
        return this.driver.updateRuntimePolicy(command).then(async () => {
          this.projection.refresh(await this.driver.snapshot());
          return accepted(command.expectedGeneration);
        });
      case "updateToolPolicy":
        if (!this.driver.updateToolPolicy) return Promise.reject(httpError(409, "tool policy is unavailable"));
        return this.driver.updateToolPolicy(command).then(async () => {
          this.projection.refresh(await this.driver.snapshot());
          return accepted(command.expectedGeneration);
        });
      case "dismissCommandResult":
        if (!this.driver.dismissCommandResult) return Promise.reject(httpError(409, "command results are unavailable"));
        this.driver.dismissCommandResult(command.resultId, command.expectedGeneration);
        return Promise.resolve(accepted(command.expectedGeneration));
    }
  }

  private onDriverEvent(event: DriverEvent): void {
    if (event.type === "session.replaced" || event.type === "session.unavailable" || event.type === "session.cleared") {
      this.projection.discardPending();
      this.clearDialogOwner();
      this.lastCommandOwner = undefined;
      this.exportController?.abort();
      this.databaseCommand?.controller.abort();
      this.databaseCommand = undefined;
      this.journal = new EventJournal(event.sessionGeneration, event.sessionId);
      for (const mirror of this.mirrors) mirror.controller.abort(new Error("Session changed"));
    }
    // The owner must be installed before projection publication so the first
    // UI event is personalized correctly for every connected tab.
    if (event.type === "ui.event") {
      const raw =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { requestId?: unknown; method?: unknown; surface?: unknown })
          : {};
      if (
        typeof raw.requestId === "string" &&
        ["select", "confirm", "input", "editor", "questionnaire"].includes(String(raw.method))
      ) {
        this.openDialog(
          raw.requestId,
          event.sessionGeneration,
          raw.surface === "database" ? this.databaseCommand?.tabId : this.lastCommandOwner,
        );
      }
    }
    this.projection.apply(event);
    if (event.type === "ui.closed" && this.dialogOwner?.requestId === event.requestId) this.clearDialogOwner();
  }

  private publish(type: string, payload: unknown): void {
    const event = this.journal.append(type, payload);
    const serialized = this.journal.serialized(event);
    for (const client of this.clients) this.writeEvent(client.response, event, client.tabId, serialized);
  }

  private writeEvent(response: ServerResponse, event: WebEvent, tabId: string, serialized?: string): void {
    const personalized = event.type === "ui.request" || event.type === "ui.ownership";
    const eventPayload = personalized ? (event.payload as Record<string, unknown>) : undefined;
    const matchesCurrent = eventPayload?.requestId === this.dialogOwner?.requestId;
    const payload = personalized
      ? {
          ...eventPayload,
          owned: matchesCurrent && this.dialogOwner?.tabId === tabId,
          ownershipAvailable: matchesCurrent && this.dialogOwner?.tabId === undefined,
        }
      : event.payload;
    const data = personalized ? JSON.stringify({ ...event, payload }) : (serialized ?? JSON.stringify(event));
    response.write(`id: ${eventCursor(event)}\nevent: ${event.type}\ndata: ${data}\n\n`);
  }

  private session(request: IncomingMessage, response: ServerResponse): BrowserSession {
    return this.sessions.get(request) ?? this.sessions.create(response, this.options.secureCookies);
  }
  private mutatingSession(request: IncomingMessage): BrowserSession {
    const session = this.sessions.get(request);
    if (!validCsrf(session, request.headers["x-pylon-csrf"] as string | undefined))
      throw httpError(403, "invalid CSRF token");
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
    this.dialogOwner = { requestId, sessionGeneration, tabId };
    this.startDialogOwnerLossGrace(this.dialogOwner);
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
    this.startTabLossGrace(client.session, client.tabId);
    for (const mirror of this.mirrors) {
      if (mirror.session === client.session && mirror.tabId === client.tabId)
        mirror.controller.abort(new Error("Browser tab disconnected"));
    }
    const owner = this.dialogOwner;
    if (owner?.tabId === client.tabId) this.startDialogOwnerLossGrace(owner);
  }
  private tabTimerKey(session: BrowserSession, tabId: string): string {
    return `${session.secret}\0${tabId}`;
  }
  private cancelTabLossGrace(session: BrowserSession, tabId: string): void {
    const key = this.tabTimerKey(session, tabId);
    const timer = this.tabLossTimers.get(key);
    if (timer) clearTimeout(timer);
    this.tabLossTimers.delete(key);
  }
  private startTabLossGrace(session: BrowserSession, tabId: string): void {
    if ([...this.clients].some(client => client.session === session && client.tabId === tabId)) return;
    const key = this.tabTimerKey(session, tabId);
    if (this.tabLossTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.tabLossTimers.delete(key);
      if (![...this.clients].some(client => client.session === session && client.tabId === tabId))
        session.tabs.delete(tabId);
    }, this.options.dialogReconnectGraceMs ?? 10_000);
    timer.unref?.();
    this.tabLossTimers.set(key, timer);
  }
  private startDialogOwnerLossGrace(owner: DialogOwner): void {
    const tabId = owner.tabId;
    if (!tabId || owner.lossTimer || [...this.clients].some(client => client.tabId === tabId)) return;
    owner.lossTimer = setTimeout(() => {
      if (this.dialogOwner !== owner || owner.tabId !== tabId) return;
      this.releaseDialogOwner(owner);
      this.publishOwnership(owner.requestId);
    }, this.options.dialogReconnectGraceMs ?? 10_000);
    owner.lossTimer.unref?.();
  }
  private releaseDialogOwner(owner: DialogOwner): void {
    if (owner.lossTimer) clearTimeout(owner.lossTimer);
    owner.lossTimer = undefined;
    owner.tabId = undefined;
  }
  private publishOwnership(requestId: string): void {
    this.publish("ui.ownership", { requestId });
  }
  private clearDialogOwner(): void {
    const owner = this.dialogOwner;
    if (!owner) return;
    if (owner.lossTimer) clearTimeout(owner.lossTimer);
    this.dialogOwner = undefined;
  }
  private send(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }
}

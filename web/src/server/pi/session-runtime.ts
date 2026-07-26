import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createAgentSessionRuntime,
  createEventBus,
  SessionManager,
  type AgentSession,
  type SessionInfo,
  type EventBusController,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { PackageListSnapshot, RuntimeDiagnostic, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots.ts";
import { GenerationGate } from "./generation-gate.ts";
import type {
  DeleteSessionInput,
  DriverEvent,
  DriverEventListener,
  ForkInput,
  NewSessionInput,
  PiDriver,
  PromptInput,
  ReplacementResult,
  RuntimeHandle,
  RuntimeTarget,
  SetModelInput,
  SetPackageEnabledInput,
  SetThinkingLevelInput,
  SwitchSessionInput,
} from "./pi-driver.ts";
import { RemoteUiBridge, type UiRequest, type UiResponse } from "./remote-ui-context.ts";
import { createPylonRuntimeFactory } from "./runtime-factory.ts";
import { applyOperationalEvent, cloneOperational, initialOperational, withOperationalCapabilities } from "./operational-projections.ts";
import { PackageCatalog, type PackageCatalogState } from "./package-catalog.ts";
import { projectMessages } from "./projections.ts";
import { projectIdForCwd, SessionIndex } from "./session-index.ts";

interface TrashAttempt {
  status: number | null;
  error?: NodeJS.ErrnoException;
  stderr?: string | null;
}

function moveToTrash(sessionPath: string): TrashAttempt {
  return spawnSync("trash", sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath], { encoding: "utf8", timeout: 1_000, windowsHide: true });
}

export async function deleteSessionFile(sessionPath: string, trash: (path: string) => TrashAttempt = moveToTrash): Promise<void> {
  const result = trash(sessionPath);
  if (!existsSync(sessionPath)) return;
  if (result.error?.code === "ENOENT") {
    await unlink(sessionPath);
    return;
  }
  const detail = result.error?.message
    || result.stderr?.trim().split("\n")[0]
    || (result.status === 0 ? "trash reported success but the session file remains" : `trash exited with status ${result.status ?? "unknown"}`);
  throw new Error(`could not move session to trash: ${detail.slice(0, 200)}`);
}

const OPTIONAL_TOOLS = [
  "continuity_update",
  "memory",
  "verify",
  "heartbeat_start",
  "heartbeat_status",
  "heartbeat_cancel",
] as const;

export interface SessionRuntimeOptions {
  dialogTimeoutMs?: number;
  extensionFactories?: InlineExtension[];
  onShutdownRequested?: () => void;
}

export class SessionRuntime implements PiDriver {
  private runtime?: AgentSessionRuntime;
  private readonly gate = new GenerationGate();
  private readonly eventBus: EventBusController = createEventBus();
  private busUnsubscribers: Array<() => void> = [];
  private operational = initialOperational([], []);
  private readonly listeners = new Set<DriverEventListener>();
  private readonly ui: RemoteUiBridge;
  private unsubscribeSession?: () => void;
  private replacementGeneration?: number;
  private replacementInvalidated = false;
  private implicitReplacement = false;
  private runtimeDisposable = false;
  private diagnostics: RuntimeDiagnostic[] = [];
  private lastSnapshot?: RuntimeSnapshot;
  private target?: RuntimeTarget;
  private createRuntime?: CreateAgentSessionRuntimeFactory;
  private packageCatalog?: PackageCatalog;
  private packageState?: PackageCatalogState;
  private packageUpdate = false;
  private sessionMutation?: "lifecycle" | "delete";
  private readonly sessionIndex = new SessionIndex();
  private disposed = false;

  constructor(private readonly options: SessionRuntimeOptions = {}) {
    this.ui = new RemoteUiBridge(
      (request) => this.publishUi(request),
      options.dialogTimeoutMs,
      (request) => this.publishUiClosed(request),
    );
  }

  async start(target: RuntimeTarget): Promise<RuntimeHandle> {
    if (this.runtime || this.disposed) throw new Error("driver cannot be started twice");
    this.target = target;
    this.packageCatalog = new PackageCatalog(target.repositoryRoot, target.agentDir);
    this.packageState = await this.packageCatalog.scan();
    const generation = this.gate.start();
    this.installBusHooks(generation);
    const createRuntime = await createPylonRuntimeFactory({
      agentDir: target.agentDir,
      additionalExtensionPaths: this.packageState.extensionPaths,
      extensionFactories: this.options.extensionFactories,
      eventBus: this.eventBus,
    });
    this.createRuntime = createRuntime;
    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: target.cwd,
        agentDir: target.agentDir,
        sessionManager: target.sessionPath
          ? SessionManager.open(target.sessionPath)
          : SessionManager.create(target.cwd, undefined, target.parentSessionPath ? { parentSession: target.parentSessionPath } : undefined),
      });
      this.runtime = runtime;
      this.runtimeDisposable = true;
      this.installRuntimeHooks(runtime);
      await this.bindSession(runtime.session, generation);
      this.refreshSnapshot();
      return { sessionId: runtime.session.sessionId, sessionGeneration: generation };
    } catch (error) {
      this.gate.stop();
      this.detachBus();
      await runtime?.dispose().catch(() => undefined);
      this.runtime = undefined;
      throw error;
    }
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    if (!this.runtime || !this.target) throw new Error("runtime has not started");
    if (this.gate.ready) this.refreshSnapshot();
    if (!this.lastSnapshot) throw new Error("runtime snapshot is unavailable");
    return {
      ...this.lastSnapshot,
      sessionGeneration: this.gate.generation,
      ready: this.gate.ready,
      diagnostics: [...this.diagnostics],
    };
  }

  async listSessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const activeId = runtime.session.sessionId;
    const now = new Date();
    return this.sessionIndex.list(input, {
      activeId,
      generation: this.gate.generation,
      stateFor: (sessionId) => sessionId === activeId ? runtime.session.isStreaming ? "running" : "idle" : "sleeping",
      userCountFor: (sessionId) => sessionId === activeId ? runtime.session.getSessionStats().userMessages : undefined,
      activeFallback: {
        id: activeId,
        path: runtime.session.sessionFile ?? "",
        cwd: runtime.cwd,
        name: runtime.session.sessionManager.getSessionName(),
        created: now,
        modified: now,
        messageCount: runtime.session.getSessionStats().totalMessages,
        firstMessage: "",
        allMessagesText: "",
      },
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    const catalog = this.packageCatalog;
    const runtime = this.requireRuntime();
    if (!catalog || !this.gate.ready) throw new Error("runtime is not ready");
    const state = await catalog.scan();
    const extensions = runtime.services.resourceLoader.getExtensions();
    const loaded = new Set(extensions.extensions.map((item) => resolve(item.resolvedPath)));
    const failed = new Set(extensions.errors.map((item) => resolve(item.path)));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      packages: state.packages.map((item) => {
        const enabled = state.enabledIds.has(item.id);
        const active = enabled && item.extensionPaths.every((path) => loaded.has(resolve(path)));
        return {
          id: item.id,
          name: item.name,
          description: item.description,
          enabled,
          active,
          extensionCount: item.extensionPaths.length,
          ...(!active && enabled && item.extensionPaths.some((path) => failed.has(resolve(path)))
            ? { error: "One or more extensions failed to load." }
            : {}),
        };
      }),
    };
  }

  prompt(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    return new Promise<AcceptedCommand>((resolve, reject) => {
      let decided = false;
      const finish = (accepted: boolean) => {
        if (decided) return;
        decided = true;
        if (!accepted) reject(new Error("prompt was rejected before acceptance"));
        else resolve(this.accepted(input.commandId));
      };
      void session.prompt(input.message, {
        source: "rpc",
        images: input.images?.map((image) => ({ type: "image", ...image })),
        preflightResult: finish,
      }).catch((error) => {
        this.failImplicitReplacement(error);
        reject(error);
      });
    });
  }

  async steer(input: PromptInput): Promise<AcceptedCommand> {
    await this.sessionFor(input.expectedGeneration).steer(input.message, input.images?.map((image) => ({ type: "image", ...image })));
    return this.accepted(input.commandId);
  }

  async followUp(input: PromptInput): Promise<AcceptedCommand> {
    await this.sessionFor(input.expectedGeneration).followUp(input.message, input.images?.map((image) => ({ type: "image", ...image })));
    return this.accepted(input.commandId);
  }

  async abort(): Promise<void> {
    if (!this.runtime || !this.gate.ready) throw new Error("runtime is not ready");
    await this.runtime.session.abort();
  }

  newSession(input?: NewSessionInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const parent = input?.parentSessionId ? await this.resolveSession(input.parentSessionId) : undefined;
      const runtime = this.requireRuntime();
      const crossProject = parent && projectIdForCwd(parent.cwd) !== projectIdForCwd(runtime.cwd);
      if (crossProject) {
        const switched = await this.replace(() => runtime.switchSession(parent.path));
        if (switched.cancelled) return switched;
      }
      try {
        return await this.replace(() => runtime.newSession({ parentSession: parent?.path }));
      } catch (error) {
        if (crossProject) await this.recoverSession(parent).catch(() => undefined);
        throw error;
      }
    });
  }

  switchSession(input: SwitchSessionInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = await this.resolveSession(input.sessionId);
      return this.replace(() => this.requireRuntime().switchSession(session.path));
    });
  }

  deleteSession(input: DeleteSessionInput): Promise<void> {
    return this.withSessionMutation("delete", async () => {
      if (!this.gate.ready) throw new Error("runtime is not ready");
      const runtime = this.requireRuntime();
      if (input.sessionId === runtime.session.sessionId) throw new Error("cannot delete the currently active session");
      const session = await this.resolveSession(input.sessionId);
      const activeFile = runtime.session.sessionManager.getSessionFile();
      if (activeFile && resolve(session.path) === resolve(activeFile)) throw new Error("cannot delete the currently active session");
      await deleteSessionFile(session.path);
      this.sessionIndex.remove(input.sessionId);
    });
  }

  fork(input: ForkInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", () => this.replace(() => this.requireRuntime().fork(input.entryId, { position: input.position })));
  }

  async setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult> {
    const runtime = this.requireRuntime();
    const catalog = this.packageCatalog;
    if (!catalog || !this.createRuntime || !this.gate.ready) throw new Error("runtime is not ready");
    if (this.packageUpdate || this.sessionMutation || runtime.session.isStreaming || this.ui.hasPendingDialog
      || this.operational.jobs.items.some((job) => job.state === "running")) {
      throw new Error("packages can only change while the session is idle");
    }
    this.packageUpdate = true;
    try {
      const previous = await catalog.scan();
      if (previous.enabledIds.has(input.packageId) === input.enabled) {
        return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
      }

      const sessionFile = runtime.session.sessionFile;
      if (!sessionFile) throw new Error("the current session must be persisted before packages can change");
      const session = { cwd: runtime.cwd, path: sessionFile };
      const previousFactory = this.createRuntime;
      try {
        const next = await catalog.setEnabled(input.packageId, input.enabled);
        const nextFactory = await createPylonRuntimeFactory({
          agentDir: this.target!.agentDir,
          additionalExtensionPaths: next.extensionPaths,
          extensionFactories: this.options.extensionFactories,
          eventBus: this.eventBus,
        });
        this.packageState = next;
        await this.rebuildSession(session, nextFactory, false);
        this.createRuntime = nextFactory;
        return { cancelled: false, sessionId: this.requireRuntime().session.sessionId, sessionGeneration: this.gate.generation };
      } catch (error) {
        await catalog.restoreEnabled(previous.enabledIds).catch(() => undefined);
        this.packageState = previous;
        if (!this.gate.ready) {
          await this.rebuildSession(session, previousFactory, true).catch((recoveryError) => {
            this.recordError(recoveryError);
          });
        }
        throw error;
      }
    } finally {
      this.packageUpdate = false;
    }
  }

  async setModel(input: SetModelInput): Promise<void> {
    const session = this.controlSession();
    const model = this.requireRuntime().services.modelRuntime.getAvailableSnapshot()
      .find((item) => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    await session.setModel(model);
    this.refreshSnapshot();
  }

  setThinkingLevel(input: SetThinkingLevelInput): void {
    const session = this.controlSession();
    if (!session.getAvailableThinkingLevels().includes(input.level)) throw new Error("thinking level is unavailable for this model");
    session.setThinkingLevel(input.level);
    this.refreshSnapshot();
  }

  async answerUiRequest(input: UiResponse): Promise<void> {
    this.ui.answer(input);
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtimeState(): SessionRuntimeState {
    const runtime = this.requireRuntime();
    if (this.ui.hasPendingDialog) return "attention";
    if (runtime.session.isStreaming || runtime.session.pendingMessageCount > 0
      || this.operational.jobs.items.some((job) => job.state === "running")) return "running";
    return "idle";
  }

  canSleep(): boolean {
    return this.runtimeState() === "idle" && !this.sessionMutation && !this.packageUpdate;
  }

  runtimeDetails(): {
    sessionId: string;
    generation: number;
    cwd: string;
    sessionPath?: string;
    name?: string;
    userMessageCount: number;
  } {
    const runtime = this.requireRuntime();
    return {
      sessionId: runtime.session.sessionId,
      generation: this.gate.generation,
      cwd: runtime.cwd,
      sessionPath: runtime.session.sessionFile,
      name: runtime.session.sessionManager.getSessionName(),
      userMessageCount: runtime.session.getSessionStats().userMessages,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ui.cancelAll();
    this.detachSession();
    this.detachBus();
    this.eventBus.clear();
    const runtime = this.runtime;
    const shouldDisposeRuntime = this.runtimeDisposable;
    this.runtime = undefined;
    this.runtimeDisposable = false;
    if (runtime && shouldDisposeRuntime) await runtime.dispose();
    this.gate.stop();
    this.listeners.clear();
  }

  private installRuntimeHooks(runtime: AgentSessionRuntime): void {
    runtime.setBeforeSessionInvalidate(() => {
      if (this.sessionMutation === "delete") throw new Error("session cannot change while deletion is in progress");
      const oldGeneration = this.gate.generation;
      this.ui.cancelGeneration(oldGeneration);
      this.detachSession();
      this.detachBus();
      this.operational = initialOperational([], []);
      if (this.lastSnapshot) this.lastSnapshot = { ...this.lastSnapshot, ready: false, operational: cloneOperational(this.operational) };
      this.runtimeDisposable = false;
      if (this.disposed) {
        this.gate.stop();
        return;
      }
      if (this.replacementGeneration === undefined) {
        this.replacementGeneration = this.gate.beginReplacement();
        this.implicitReplacement = true;
      }
      this.gate.invalidateCurrent();
      this.replacementInvalidated = true;
      this.installBusHooks(this.replacementGeneration);
    });
    runtime.setRebindSession(async (session) => {
      const generation = this.replacementGeneration;
      if (generation === undefined) throw new Error("replacement session arrived without an allocated generation");
      this.runtimeDisposable = true;
      await this.bindSession(session, generation);
      this.gate.commitReplacement();
      this.installBusHooks(generation);
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.implicitReplacement = false;
      this.refreshSnapshot();
      this.emit({
        type: "session.replaced",
        sessionId: session.sessionId,
        sessionGeneration: generation,
        runtime: this.lastSnapshot!,
      });
    });
  }

  private async bindSession(session: AgentSession, generation: number): Promise<void> {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.ui.context(session.sessionId, generation),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => this.requireRuntime().newSession(options),
        switchSession: (sessionPath, options) => this.requireRuntime().switchSession(sessionPath, options),
        fork: (entryId, options) => this.requireRuntime().fork(entryId, options),
        navigateTree: (targetId, options) => session.navigateTree(targetId, options),
        reload: () => session.reload(),
      },
      abortHandler: () => {
        if (this.gate.accepts(generation)) void session.abort().catch((error) => this.recordError(error));
      },
      shutdownHandler: () => this.options.onShutdownRequested?.(),
      onError: (error) => this.recordExtensionError(error),
    });
    this.unsubscribeSession = session.subscribe((payload) => {
      if (!this.gate.accepts(generation)) return;
      this.emit({
        type: "session.event",
        sessionId: session.sessionId,
        sessionGeneration: generation,
        payload,
      });
    });
  }

  private async replace(action: () => Promise<{ cancelled: boolean }>): Promise<ReplacementResult> {
    const runtime = this.requireRuntime();
    this.replacementGeneration = this.gate.beginReplacement();
    this.replacementInvalidated = false;
    this.implicitReplacement = false;
    try {
      const result = await action();
      if (result.cancelled) {
        this.gate.cancelReplacement();
        this.replacementGeneration = undefined;
        return {
          cancelled: true,
          sessionId: runtime.session.sessionId,
          sessionGeneration: this.gate.generation,
        };
      }
      if (!this.gate.ready) throw new Error("replacement completed without rebinding the new session");
      return {
        cancelled: false,
        sessionId: runtime.session.sessionId,
        sessionGeneration: this.gate.generation,
      };
    } catch (error) {
      const invalidated = this.replacementInvalidated;
      if (invalidated) this.gate.failReplacement();
      else this.gate.cancelReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.implicitReplacement = false;
      this.recordError(error);
      if (invalidated) this.publishUnavailable();
      throw error;
    }
  }

  private async recoverSession(session: SessionInfo): Promise<void> {
    const createRuntime = this.createRuntime;
    if (!createRuntime) throw new Error("runtime recovery is unavailable");
    await this.rebuildSession(session, createRuntime, true);
  }

  private async rebuildSession(
    session: Pick<SessionInfo, "cwd" | "path">,
    createRuntime: CreateAgentSessionRuntimeFactory,
    recovery: boolean,
  ): Promise<void> {
    const target = this.target;
    if (!target) throw new Error("runtime recovery is unavailable");
    const oldGeneration = this.gate.generation;
    const generation = recovery ? this.gate.beginRecovery() : this.gate.beginReplacement();
    this.replacementGeneration = generation;
    this.replacementInvalidated = true;
    this.implicitReplacement = false;
    if (!recovery) this.gate.invalidateCurrent();
    this.ui.cancelGeneration(oldGeneration);
    this.detachSession();
    this.detachBus();
    this.operational = initialOperational([], []);
    this.installBusHooks(generation);
    const previousSessionFile = this.runtime?.session.sessionFile;
    this.runtimeDisposable = false;
    await this.runtime?.dispose().catch(() => undefined);

    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: session.cwd,
        agentDir: target.agentDir,
        sessionManager: SessionManager.open(session.path),
        sessionStartEvent: {
          type: "session_start",
          reason: "resume",
          previousSessionFile,
        },
      });
      this.runtime = runtime;
      this.runtimeDisposable = true;
      this.installRuntimeHooks(runtime);
      await this.bindSession(runtime.session, generation);
      this.gate.commitReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.refreshSnapshot();
      this.emit({
        type: "session.replaced",
        sessionId: runtime.session.sessionId,
        sessionGeneration: generation,
        runtime: this.lastSnapshot!,
      });
    } catch (error) {
      this.detachSession();
      this.detachBus();
      await runtime?.dispose().catch(() => undefined);
      this.gate.failReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.recordError(error);
      this.publishUnavailable();
      throw error;
    }
  }

  private failImplicitReplacement(error: unknown): void {
    if (!this.implicitReplacement) return;
    const invalidated = this.replacementInvalidated;
    if (invalidated) this.gate.failReplacement();
    else this.gate.cancelReplacement();
    this.replacementGeneration = undefined;
    this.replacementInvalidated = false;
    this.implicitReplacement = false;
    this.recordError(error);
    if (invalidated) this.publishUnavailable();
  }

  private publishUnavailable(): void {
    const runtime = this.requireRuntime();
    if (!this.lastSnapshot) return;
    this.operational = initialOperational([], []);
    this.lastSnapshot = {
      ...this.lastSnapshot,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      ready: false,
      cwdLabel: basename(runtime.cwd) || runtime.cwd,
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: [], tools: [], streaming: false,
        queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false },
      },
      operational: cloneOperational(this.operational),
      extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
    };
    this.emit({
      type: "session.unavailable",
      sessionId: this.lastSnapshot.sessionId,
      sessionGeneration: this.gate.generation,
      runtime: this.lastSnapshot,
    });
  }

  private async withSessionMutation<T>(kind: "lifecycle" | "delete", action: () => Promise<T>): Promise<T> {
    if (this.sessionMutation || this.packageUpdate) throw new Error("another session operation is in progress");
    this.sessionMutation = kind;
    try {
      return await action();
    } finally {
      this.sessionMutation = undefined;
    }
  }

  private controlSession(): AgentSession {
    const runtime = this.requireRuntime();
    if (!this.gate.ready || !runtime.session.isIdle || this.sessionMutation || this.packageUpdate || this.ui.hasPendingDialog) {
      throw new Error("session controls can only change while the session is idle");
    }
    return runtime.session;
  }

  private async resolveSession(sessionId: string): Promise<SessionInfo> {
    const matches = (await SessionManager.listAll()).filter((session) => session.id === sessionId);
    if (matches.length !== 1) throw new Error(matches.length ? "session id is ambiguous" : "session is unavailable");
    return matches[0]!;
  }

  private refreshSnapshot(): void {
    const runtime = this.requireRuntime();
    const availableTools = runtime.session.getAllTools().map((tool) => tool.name).sort();
    const available = new Set(availableTools);
    this.diagnostics = runtime.diagnostics.slice(0, 50).map((diagnostic) => ({
      level: diagnostic.type,
      message: this.sanitizeDiagnostic(diagnostic.message),
    }));
    const session = runtime.session;
    const stats = session.getSessionStats();
    const context = session.getContextUsage();
    const messages = session.state.messages.length > 0
      ? session.state.messages
      : session.sessionManager.buildSessionContext().messages;
    const model = session.model;
    const models = runtime.services.modelRuntime.getAvailableSnapshot().slice(0, 500)
      .map((item) => ({ provider: item.provider, id: item.id, name: item.name }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
    const loadedExtensions = runtime.services.resourceLoader.getExtensions().extensions.map((extension) => basename(extension.resolvedPath));
    this.operational = withOperationalCapabilities(this.operational, availableTools, loadedExtensions, this.diagnostics);
    this.requestPackageStates(session.sessionId);
    this.lastSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      sessionGeneration: this.gate.generation,
      ready: this.gate.ready,
      cwdLabel: basename(runtime.cwd) || runtime.cwd,
      activeTools: session.getActiveToolNames().sort(),
      availableTools,
      optionalCapabilities: Object.fromEntries(
        OPTIONAL_TOOLS.map((tool) => [tool, available.has(tool) ? "available" : "unavailable"]),
      ),
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: projectMessages(messages),
        tools: [],
        streaming: session.isStreaming,
        queue: { steering: 0, followUp: 0 },
        retry: { active: false },
        compaction: { active: false },
      },
      sessionControls: {
        model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
        models,
        thinkingLevel: session.supportsThinking() ? session.thinkingLevel : undefined,
        thinkingLevels: session.getAvailableThinkingLevels(),
      },
      operational: this.operational,
      metrics: {
        model: model?.name ?? "No model",
        provider: model?.provider ?? "unavailable",
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        contextTokens: context?.tokens ?? 0,
        contextLimit: context?.contextWindow ?? 0,
        contextPercent: context?.percent ?? 0,
        cost: stats.cost,
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
      },
      extensionUi: this.ui.snapshot(),
    };
  }

  private installBusHooks(generation: number): void {
    this.detachBus();
    for (const channel of ["pi-verify:lifecycle", "pi-verify:result", "pi-heartbeat:job", "pi-guard:decision", "pylon:tool-policy", "pi-continuity:state-change", "pi-timeline:state-change"]) {
      this.busUnsubscribers.push(this.eventBus.on(channel, (payload) => {
        const active = this.gate.accepts(generation);
        const replacing = this.replacementInvalidated && this.replacementGeneration === generation;
        if (!active && !replacing) return;
        const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
        if (replacing && raw?.available === false) return;
        const sessionId = active ? this.runtime?.session.sessionId : undefined;
        this.operational = applyOperationalEvent(
          this.operational,
          channel,
          payload,
          this.diagnostics,
          sessionId,
          (value) => this.sanitizeOperationalText(value),
        );
        if (active && sessionId) this.emit({
          type: "package.event",
          sessionId,
          sessionGeneration: generation,
          channel,
          payload,
          operational: cloneOperational(this.operational),
        });
      }));
    }
  }

  private requestPackageStates(sessionId: string): void {
    for (const channel of ["pi-continuity:state-request", "pi-timeline:state-request"]) {
      let answered = false;
      try {
        this.eventBus.emit(channel, {
          version: 1,
          sessionId,
          respond: (payload: unknown) => {
            const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
            if (answered || raw?.sessionId !== sessionId) return;
            answered = true;
            const stateChannel = channel.replace("state-request", "state-change");
            this.operational = applyOperationalEvent(
              this.operational,
              stateChannel,
              payload,
              this.diagnostics,
              sessionId,
              (value) => this.sanitizeOperationalText(value),
            );
          },
        });
      } catch (error) {
        this.recordError(error);
      }
    }
  }

  private detachBus(): void {
    for (const unsubscribe of this.busUnsubscribers.splice(0)) unsubscribe();
  }

  private sessionFor(expectedGeneration: number): AgentSession {
    this.gate.assert(expectedGeneration);
    return this.requireRuntime().session;
  }

  private accepted(commandId: string): AcceptedCommand {
    return { commandId, sessionGeneration: this.gate.generation, accepted: true };
  }

  private publishUi(request: UiRequest): void {
    if (!this.gate.acceptsUi(request.sessionGeneration)) return;
    this.emit({
      type: "ui.event",
      sessionId: request.sessionId,
      sessionGeneration: request.sessionGeneration,
      payload: request,
    });
  }

  private publishUiClosed(request: UiRequest): void {
    this.emit({
      type: "ui.closed",
      sessionId: request.sessionId,
      sessionGeneration: request.sessionGeneration,
      requestId: request.requestId,
    });
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private detachSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("runtime has not started");
    return this.runtime;
  }

  private recordExtensionError(error: ExtensionError): void {
    this.diagnostics.push({
      level: "error",
      message: this.sanitizeDiagnostic(`${basename(error.extensionPath)} failed during ${error.event}`),
    });
    this.diagnostics = this.diagnostics.slice(-50);
  }

  private recordError(error: unknown): void {
    this.diagnostics.push({
      level: "error",
      message: this.sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
    });
    this.diagnostics = this.diagnostics.slice(-50);
  }

  private sanitizeOperationalText(message: string): string {
    return this.sanitizeDiagnostic(message)
      .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*)\s*=\s*\S+/g, "$1=<redacted>");
  }

  private sanitizeDiagnostic(message: string): string {
    let safe = message;
    for (const path of [this.target?.cwd, this.target?.agentDir, this.target?.repositoryRoot]) {
      if (path) safe = safe.split(path).join("<path>");
    }
    return safe
      .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
      .slice(0, 2_000);
  }
}

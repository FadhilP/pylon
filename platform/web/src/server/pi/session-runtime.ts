import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseWorktreeSummary,
  readPersistedWorktreeSummaries,
} from "pylon-core/src/worktree.ts";
import {
  createAgentSessionRuntime,
  createEventBus,
  SessionManager,
  sessionEntryToContextMessages,
  type AgentSession,
  type SessionInfo,
  type EventBusController,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { AcceptedCommand, QueuedPromptPayload } from "../../shared/protocol/commands.ts";
import type { ChangedFileReadModel, ModelOptionReadModel, SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, ConversationHistoryPage, ConversationHistoryQuery, ConversationTurnIndexPage, ConversationTurnIndexQuery, DiscoverIndexReadModel, FileSuggestionList, PackageListSnapshot, PackageSettingsReadModel, RuntimeDiagnostic, RuntimePolicyReadModel, RuntimeSnapshot, SessionListQuery, SessionListSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, VerifyPolicyReadModel } from "../../shared/protocol/snapshots.ts";
import { GenerationGate } from "./generation-gate.ts";
import type {
  DeleteSessionInput,
  DeleteContinuityMemoryInput,
  DriverEvent,
  DriverEventListener,
  EditPromptInput,
  FileSuggestionInput,
  ForkInput,
  NewSessionInput,
  PiDriver,
  ProjectInput,
  ProjectArchiveInput,
  PromptInput,
  QueueMutationInput,
  RewindPromptInput,
  ReorderActiveSessionInput,
  ReorderProjectInput,
  RemoveProjectInput,
  ReplacementResult,
  RuntimeHandle,
  RuntimeTarget,
  RenameSessionInput,
  SetModelInput,
  SetPackageEnabledInput,
  SetSessionActiveInput,
  SetThinkingLevelInput,
  SetSessionControlsInput,
  SessionArchiveInput,
  SwitchSessionInput,
  TimelineCheckpointDiffInput,
  TimelineCheckpointInput,
  UpdateContinuityMemoryInput,
  UpdatePackageSettingsInput,
  UpdateRuntimePolicyInput,
} from "./pi-driver.ts";
import { RemoteUiBridge, type UiRequest, type UiResponse } from "./remote-ui-context.ts";
import { createPylonRuntimeFactory } from "./runtime-factory.ts";
import { applyOperationalEvent, cloneOperational, initialOperational, withOperationalCapabilities } from "./operational-projections.ts";
import { PackageCatalog, type PackageCatalogState } from "./package-catalog.ts";
import { PromptAttachmentBridge, promptFilesMessage } from "./prompt-attachments.ts";
import { WorkspaceApplyTool, type WorkspaceApplyToolInfo } from "./workspace-apply-tool.ts";
import { decodeHistoryCursor, decodeTurnIndexCursor, encodeHistoryCursor, encodeTurnIndexCursor, HISTORY_PAGE_SIZE, projectConversation, projectConversationTurnIndex } from "./projections.ts";
import { invalidateFileSuggestions, suggestGitFiles } from "./file-suggestions.ts";
import { projectIdForCwd, SessionIndex } from "./session-index.ts";
import { ProjectRegistry } from "./project-registry.ts";

interface TrashAttempt {
  status: number | null;
  error?: NodeJS.ErrnoException;
  stderr?: string | null;
}

interface TimelineEditTransaction {
  apply(): Promise<void>;
  rollback(): Promise<void>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
}

function cloneVerifyPolicy(value: VerifyPolicyReadModel): VerifyPolicyReadModel {
  return value.mode === "auto" ? { mode: "auto" } : { mode: "selected", checks: [...value.checks] };
}

function defaultRuntimePolicy(): RuntimePolicyReadModel {
  return {
    revision: 0,
    project: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    session: {},
    effective: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
    },
    availableVerifyChecks: [],
  };
}

function agentWasAborted(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.messages)) return false;
  for (let index = value.messages.length - 1; index >= 0; index--) {
    const message = value.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const item = message as Record<string, unknown>;
    if (item.role === "assistant") return item.stopReason === "aborted";
  }
  return false;
}

function moveToTrash(sessionPath: string): TrashAttempt {
  return spawnSync("trash", sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath], { encoding: "utf8", timeout: 1_000, windowsHide: true });
}

export function readGitBranch(cwd: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch ? branch.slice(0, 200) : undefined;
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
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"] as const;
  if (!model.thinkingLevelMap) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

export interface SessionRuntimeOptions {
  dialogTimeoutMs?: number;
  extensionFactories?: InlineExtension[];
  onShutdownRequested?: () => void;
  projectRegistry?: ProjectRegistry;
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
  private replacementSessionName?: string;
  private runtimeDisposable = false;
  private diagnostics: RuntimeDiagnostic[] = [];
  private lastSnapshot?: RuntimeSnapshot;
  private target?: RuntimeTarget;
  private createRuntime?: CreateAgentSessionRuntimeFactory;
  private packageCatalog?: PackageCatalog;
  private packageState?: PackageCatalogState;
  private packageUpdate = false;
  private indexUpdate = false;
  private sessionMutation?: "lifecycle" | "delete";
  private readonly sessionIndex = new SessionIndex();
  private readonly promptAttachments = new PromptAttachmentBridge();
  private readonly workspaceApplyTool = new WorkspaceApplyTool();
  private projectRegistry?: ProjectRegistry;
  private readonly workDurations = new Map<string, number>();
  private readonly turnControls = new Map<string, { modelName?: string; thinkingLevel?: RuntimeSnapshot["sessionControls"]["thinkingLevel"] }>();
  private readonly turnChanges = new Map<string, ChangedFileReadModel[]>();
  private turnChangesLeafId: string | null | undefined;
  private timingSessionId?: string;
  private workStartedAt?: string;
  private workStartedAtMs?: number;
  private workModelName?: string;
  private workThinkingLevel?: RuntimeSnapshot["sessionControls"]["thinkingLevel"];
  private workTurnId?: string;
  private workUserEntryId?: string;
  private stopping = false;
  private stoppedRun?: RuntimeSnapshot["conversation"]["stoppedRun"];
  private nextTurnId = 0;
  private readonly pendingWorktreeTurns: Array<{ turnId: string; messageId?: string; assistantEntryId?: string }> = [];
  private discoverIndex?: DiscoverIndexReadModel;
  private gitBranch?: string;
  private runtimePolicy: RuntimePolicyReadModel = defaultRuntimePolicy();
  private transcriptCache?: { sessionId: string; leafId: string | null; messages: unknown[] };
  private undoPromptEntryIds = new Set<string>();
  private forkPromptEntryIds = new Set<string>();
  private forkPromptCheckpoints = new Map<string, string>();
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
    this.projectRegistry = this.options.projectRegistry ?? ProjectRegistry.forAgentDir(target.agentDir);
    if (!this.options.projectRegistry) {
      await this.projectRegistry.load(async () => {
        const knownSessions = await SessionManager.listAll();
        return [target.cwd, ...knownSessions.map((session) => session.cwd)];
      });
    }
    this.sessionIndex.setProjectRegistry(this.projectRegistry);
    this.gitBranch = this.readDisplayGitBranch(target.cwd);
    this.packageCatalog = new PackageCatalog(target.repositoryRoot, target.agentDir);
    this.packageState = await this.packageCatalog.scan();
    const generation = this.gate.start();
    this.installBusHooks(generation);
    const createRuntime = await createPylonRuntimeFactory({
      agentDir: target.agentDir,
      additionalExtensionPaths: this.packageState.extensionPaths,
      extensionFactories: [this.promptAttachments.extension, this.workspaceApplyTool.extension, ...(this.options.extensionFactories ?? [])],
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
          : target.inMemory
            ? SessionManager.inMemory(target.cwd)
            : SessionManager.create(target.cwd, undefined, target.parentSessionPath ? { parentSession: target.parentSessionPath } : undefined),
      });
      this.runtime = runtime;
      this.runtimeDisposable = true;
      this.installRuntimeHooks(runtime);
      this.loadRuntimePolicy(runtime.session.sessionId);
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

  async conversationHistory(input: ConversationHistoryQuery): Promise<ConversationHistoryPage> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const cursor = decodeHistoryCursor(input.cursor);
    if (cursor === undefined) throw new Error("history cursor is invalid");
    const messages = this.transcriptMessages(runtime.session);
    const limit = Math.min(HISTORY_PAGE_SIZE, Math.max(1, input.limit ?? HISTORY_PAGE_SIZE));
    const direction = input.direction ?? "before";
    let start: number;
    let end: number;
    if (direction === "after") {
      start = Math.min(cursor, messages.length);
      end = Math.min(messages.length, start + limit);
    } else if (direction === "around") {
      start = Math.max(0, Math.min(cursor, messages.length) - Math.floor(limit / 2));
      end = Math.min(messages.length, start + limit);
      start = Math.max(0, end - limit);
    } else {
      end = Math.min(cursor, messages.length);
      start = Math.max(0, end - limit);
    }
    const projected = projectConversation(messages, { start, end, includeDelegated: false }).messages;
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      messages: projected,
      remaining: start,
      ...(start > 0 ? { nextCursor: encodeHistoryCursor(start) } : {}),
      ...(start > 0 ? { earlierCursor: encodeHistoryCursor(start) } : {}),
      ...(end < messages.length ? { laterCursor: encodeHistoryCursor(end) } : {}),
      atStart: start === 0,
      atEnd: end === messages.length,
    };
  }

  async conversationTurnIndex(input: ConversationTurnIndexQuery): Promise<ConversationTurnIndexPage> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const turns = projectConversationTurnIndex(this.transcriptMessages(runtime.session));
    const limit = Math.min(250, Math.max(1, input.limit ?? 250));
    const cursor = input.cursor ? decodeTurnIndexCursor(input.cursor) : undefined;
    if (input.cursor && cursor === undefined) throw new Error("turn index cursor is invalid");
    let start: number;
    let end: number;
    if (input.direction === "later") {
      start = Math.min(cursor ?? 0, turns.length);
      end = Math.min(turns.length, start + limit);
    } else {
      end = Math.min(cursor ?? turns.length, turns.length);
      start = Math.max(0, end - limit);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      turns: turns.slice(start, end).reverse(),
      totalCount: turns.length,
      ...(start > 0 ? { earlierCursor: encodeTurnIndexCursor(start) } : {}),
      ...(end < turns.length ? { laterCursor: encodeTurnIndexCursor(end) } : {}),
    };
  }

  async fileSuggestions(input: FileSuggestionInput): Promise<FileSuggestionList> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const result = await suggestGitFiles(runtime.session.sessionManager.getCwd(), input.query, input.limit);
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      ...result,
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

  async listArchived(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    return this.sessionIndex.listArchived(input, {
      activeId: runtime.session.sessionId,
      generation: this.gate.generation,
      stateFor: () => "sleeping",
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
    const packages = await Promise.all(state.packages.map(async (item) => {
      let settings: PackageSettingsReadModel | undefined;
      let settingsError: string | undefined;
      try {
        settings = await catalog.readSettings(item.id, state);
      } catch (error) {
        settingsError = error instanceof Error ? error.message.slice(0, 500) : "Settings unavailable";
      }
      const enabled = state.enabledIds.has(item.id);
      const active = enabled && item.extensionPaths.every((path) => loaded.has(resolve(path)));
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        ...(item.required ? { required: true } : {}),
        enabled,
        active,
        extensionCount: item.extensionPaths.length,
        ...(settings ? { settings } : {}),
        ...(!active && enabled && item.extensionPaths.some((path) => failed.has(resolve(path)))
          ? { error: "One or more extensions failed to load." }
          : settingsError ? { error: settingsError } : {}),
      };
    }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      packages,
    };
  }

  prompt(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    return this.sendPrompt(session, input);
  }

  private async sendPrompt(session: AgentSession, input: PromptInput): Promise<AcceptedCommand> {
    if (!input.planMode) return this.acceptPrompt(session, input);
    const plan = this.requireRuntime().services.resourceLoader.getExtensions().runtime.getCommands()
      .find((command) => command.name === "plan" && command.source === "extension");
    if (!plan) throw new Error("Plan mode is unavailable");
    await session.prompt("/plan", { source: "rpc" });
    try {
      return await this.acceptPrompt(session, input);
    } catch (error) {
      await session.prompt("/plan cancel", { source: "rpc" }).catch(() => undefined);
      throw error;
    }
  }

  private acceptPrompt(session: AgentSession, input: PromptInput): Promise<AcceptedCommand> {
    const files = input.files ?? [];
    const commandName = /^\s*\/([^\s]+)/.exec(input.message)?.[1];
    const knownCommand = Boolean(commandName && this.requireRuntime().services.resourceLoader
      .getExtensions().runtime.getCommands().some((command) => command.name === commandName));
    if (files.length) this.promptAttachments.stage(input.commandId, files);
    return new Promise<AcceptedCommand>((resolve, reject) => {
      let decided = false;
      const finish = (accepted: boolean) => {
        if (decided) return;
        decided = true;
        const filesConsumed = !files.length || this.promptAttachments.consumed(input.commandId);
        this.promptAttachments.clear(input.commandId);
        if (!accepted && knownCommand && !files.length && !input.images?.length) resolve(this.accepted(input.commandId));
        else if (!accepted && knownCommand) reject(new Error("files and images require a command that starts a model turn"));
        else if (!accepted) reject(new Error("prompt was rejected before acceptance"));
        else if (!filesConsumed) reject(new Error("text files require a prompt that starts a model turn"));
        else resolve(this.accepted(input.commandId));
      };
      void session.prompt(input.message, {
        source: "rpc",
        images: input.images?.map((image) => ({ type: "image", ...image })),
        preflightResult: finish,
      }).catch((error) => {
        this.promptAttachments.clear(input.commandId);
        this.failImplicitReplacement(error);
        reject(error);
      });
    });
  }

  queuePrompt(_input: PromptInput): Promise<AcceptedCommand> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  queuedPrompt(_input: QueueMutationInput): Promise<QueuedPromptPayload> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  restoreQueuedPrompt(_input: QueueMutationInput): Promise<void> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  steerQueuedPrompt(_input: QueueMutationInput): Promise<AcceptedCommand> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  async steer(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    await session.steer(input.message, input.images?.map((image) => ({ type: "image", ...image })));
    if (input.files?.length) {
      await session.sendCustomMessage(promptFilesMessage(input.files), { deliverAs: "steer" });
    }
    return this.accepted(input.commandId);
  }

  async followUp(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    await session.followUp(input.message, input.images?.map((image) => ({ type: "image", ...image })));
    if (input.files?.length) {
      await session.sendCustomMessage(promptFilesMessage(input.files), { deliverAs: "followUp" });
    }
    return this.accepted(input.commandId);
  }

  async abort(): Promise<void> {
    if (!this.runtime || !this.gate.ready) throw new Error("runtime is not ready");
    if (this.stopping) return;
    this.stopping = true;
    this.refreshSnapshot();
    try {
      await this.runtime.session.abort();
    } catch (error) {
      this.stopping = false;
      this.refreshSnapshot();
      throw error;
    }
  }

  applyRuntimePolicy(policy: RuntimePolicyReadModel): void {
    this.runtimePolicy = {
      ...policy,
      project: { ...policy.project, verify: cloneVerifyPolicy(policy.project.verify) },
      session: {
        ...(policy.session.verify ? { verify: cloneVerifyPolicy(policy.session.verify) } : {}),
        ...(policy.session.timelineEnabled !== undefined ? { timelineEnabled: policy.session.timelineEnabled } : {}),
        ...(policy.session.workspace ? { workspace: policy.session.workspace } : {}),
        ...(policy.session.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: policy.session.guardTimeoutSeconds } : {}),
        ...(policy.session.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: policy.session.clarifyTimeoutSeconds } : {}),
      },
      effective: { ...policy.effective, verify: cloneVerifyPolicy(policy.effective.verify) },
      availableVerifyChecks: policy.availableVerifyChecks.map((check) => ({ ...check })),
    };
    this.publishRuntimePolicy();
    this.refreshSnapshot();
  }

  updateRuntimePolicy(_input: UpdateRuntimePolicyInput): Promise<void> {
    return Promise.reject(new Error("runtime policy updates require the runtime coordinator"));
  }

  addProject(_input: ProjectInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  removeProject(_input: RemoveProjectInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  reorderProject(_input: ReorderProjectInput): Promise<void> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  archiveProject(_input: ProjectArchiveInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  restoreProject(_input: ProjectArchiveInput): Promise<void> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  archiveSession(_input: SessionArchiveInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("session archiving requires the runtime coordinator"));
  }

  restoreSession(_input: SessionArchiveInput): Promise<void> {
    return Promise.reject(new Error("session archiving requires the runtime coordinator"));
  }

  newSession(input?: NewSessionInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      if (input?.expectedGeneration !== undefined) this.gate.assert(input.expectedGeneration);
      const parent = input?.parentSessionId ? await this.resolveSession(input.parentSessionId) : undefined;
      const project = input?.projectId ? this.projectRegistry?.get(input.projectId) : undefined;
      if (input?.projectId && (!project || project.archivedAt)) throw new Error("project is unavailable");
      const runtime = this.requireRuntime();
      if (project && projectIdForCwd(project.cwd) !== projectIdForCwd(runtime.cwd)) {
        throw new Error("cross-project session creation requires the runtime coordinator");
      }
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

  rebindWorkspace(cwd: string): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const runtime = this.requireRuntime();
      const sessionPath = runtime.session.sessionFile;
      if (!sessionPath) throw new Error("session is not persisted");
      const result = await this.replace(() => runtime.switchSession(sessionPath, { cwdOverride: cwd }));
      if (!result.cancelled && this.target) this.target.cwd = cwd;
      return result;
    });
  }

  async timelineRelocationReady(): Promise<void> {
    const runtime = this.requireRuntime();
    let response: Promise<unknown> | undefined;
    this.eventBus.emit("pi-timeline:relocation-readiness", {
      version: 1,
      sessionId: runtime.session.sessionId,
      respond: (value: unknown) => { response = Promise.resolve(value); },
    });
    const value = await response;
    if (!value) return;
    const result = value as { ready?: unknown };
    if (result.ready !== true) throw new Error("Timeline checkpoints are not portable.");
  }

  workspaceApplied(): void {
    const runtime = this.requireRuntime();
    this.gitBranch = readGitBranch(runtime.cwd);
    this.eventBus.emit("pylon:workspace-applied", {
      version: 1,
      sessionId: runtime.session.sessionId,
    });
    this.refreshSnapshot();
  }

  setWorkspaceApplyHandler(handler: (request: { type: "inspect" } | { type: "schedule"; revision: string }) =>
    Promise<WorkspaceApplyToolInfo | void>): void {
    this.workspaceApplyTool.setHandler(handler);
  }

  recordWorkspaceApplyResult(result: string): void {
    this.workspaceApplyTool.recordResult(result);
  }

  async timelineCheckpointFiles(input: TimelineCheckpointInput): Promise<TimelineCheckpointFiles> {
    const runtime = this.requireRuntime();
    let response: Promise<any> | undefined;
    this.eventBus.emit("pi-timeline:files-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      checkpointId: input.checkpointId,
      respond: (value: unknown) => { response = Promise.resolve(value); },
    });
    if (!response) throw new Error("Timeline checkpoint files are unavailable");
    const value = await response;
    const files = Array.isArray(value?.files) ? value.files.slice(0, 200).flatMap((item: any) => {
      if (!item || typeof item.path !== "string" || item.path.length > 500
        || !["added", "modified", "deleted"].includes(item.status)
        || !Number.isSafeInteger(item.additions) || item.additions < 0
        || !Number.isSafeInteger(item.deletions) || item.deletions < 0) return [];
      return [{
        path: item.path,
        status: item.status,
        additions: item.additions,
        deletions: item.deletions,
        binary: item.binary === true,
      }];
    }) : [];
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      checkpointId: input.checkpointId,
      files,
      totalCount: Number.isSafeInteger(value?.totalCount) ? Math.min(10_000, value.totalCount) : files.length,
      truncated: value?.truncated === true,
    };
  }

  async timelineCheckpointDiff(input: TimelineCheckpointDiffInput): Promise<TimelineCheckpointDiff> {
    const runtime = this.requireRuntime();
    let response: Promise<any> | undefined;
    this.eventBus.emit("pi-timeline:diff-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      checkpointId: input.checkpointId,
      path: input.path,
      respond: (value: unknown) => { response = Promise.resolve(value); },
    });
    if (!response) throw new Error("Timeline checkpoint diff is unavailable");
    const value = await response;
    if (!value || value.path !== input.path
      || !["text", "binary", "unavailable", "oversized"].includes(value.state))
      throw new Error("Timeline returned an invalid diff");
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      checkpointId: input.checkpointId,
      path: input.path,
      state: value.state,
      ...(typeof value.text === "string" ? { text: value.text.slice(0, 2 * 1024 * 1024) } : {}),
      ...(value.truncated === true ? { truncated: true } : {}),
    };
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

  async renameSession(input: RenameSessionInput): Promise<void> {
    const runtime = this.requireRuntime();
    const name = input.name.trim();
    if (input.sessionId === runtime.session.sessionId) {
      this.controlSession().setSessionName(name);
      this.refreshSnapshot();
    } else {
      const session = await this.resolveSession(input.sessionId);
      SessionManager.open(session.path).appendSessionInfo(name);
    }
    this.sessionIndex.invalidate();
  }

  setSessionActive(input: SetSessionActiveInput): Promise<void> {
    const current = this.requireRuntime().session.sessionId;
    if (input.sessionId === current && input.active) return Promise.resolve();
    if (input.sessionId === current) return Promise.reject(new Error("cannot deactivate the selected session"));
    return Promise.reject(new Error("manual session activation requires the runtime coordinator"));
  }

  reorderActiveSession(_input: ReorderActiveSessionInput): Promise<void> {
    return Promise.reject(new Error("session ordering requires the runtime coordinator"));
  }

  editPrompt(input: EditPromptInput): Promise<AcceptedCommand> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("prompts can only be edited while the session is idle");
      }
      const branch = session.sessionManager.getBranch();
      const targetIndex = branch.findIndex((entry) => entry.id === input.entryId);
      const target = branch[targetIndex];
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      const parentId = typeof (target as { parentId?: unknown }).parentId === "string"
        ? (target as { parentId: string }).parentId
        : branch[targetIndex - 1]?.id;
      const oldLeaf = session.sessionManager.getLeafId();
      if (!parentId || !oldLeaf) throw new Error("the selected prompt cannot be edited");

      const timeline = await this.prepareTimelineEdit(session, target.id, input.rollbackFiles);
      let navigated = false;
      try {
        const result = await session.navigateTree(parentId, { summarize: false });
        if (result.cancelled) {
          throw new Error("prompt editing was cancelled");
        }
        navigated = true;
        await timeline?.apply();
        const accepted = await this.sendPrompt(session, input);
        await timeline?.commit().catch((cleanupError) => this.recordError(cleanupError));
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        return accepted;
      } catch (error) {
        if (navigated) {
          await timeline?.rollback().catch((rollbackError) => this.recordError(rollbackError));
          await session.navigateTree(oldLeaf, { summarize: false }).catch((rollbackError) => this.recordError(rollbackError));
        } else {
          await timeline?.cancel().catch((rollbackError) => this.recordError(rollbackError));
        }
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        throw error;
      }
    });
  }

  rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("prompts can only be rewound while the session is idle");
      }
      const branch = session.sessionManager.getBranch();
      const targetIndex = branch.findIndex((entry) => entry.id === input.entryId);
      const target = branch[targetIndex];
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      if (!this.undoPromptEntryIds.has(target.id)) {
        throw new Error("Pi Timeline cannot restore files before this prompt");
      }
      const parentId = typeof (target as { parentId?: unknown }).parentId === "string"
        ? (target as { parentId: string }).parentId
        : branch[targetIndex - 1]?.id;
      const oldLeaf = session.sessionManager.getLeafId();
      if (!parentId || !oldLeaf || oldLeaf === target.id) {
        throw new Error("the selected prompt cannot be rewound");
      }

      const timeline = await this.prepareTimelineEdit(session, target.id, true);
      let navigated = false;
      try {
        const result = await session.navigateTree(parentId, { summarize: false });
        if (result.cancelled) throw new Error("prompt rewind was cancelled");
        navigated = true;
        await timeline!.apply();
        await timeline!.commit().catch((cleanupError) => this.recordError(cleanupError));
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        return this.accepted(input.commandId);
      } catch (error) {
        if (navigated) {
          await timeline?.rollback().catch((rollbackError) => this.recordError(rollbackError));
          await session.navigateTree(oldLeaf, { summarize: false }).catch((rollbackError) => this.recordError(rollbackError));
        } else {
          await timeline?.cancel().catch((rollbackError) => this.recordError(rollbackError));
        }
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        throw error;
      }
    });
  }

  fork(input: ForkInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (!session.isIdle || this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("Session controls can only change while the session is idle");
      }
      const target = session.sessionManager.getBranch().find((entry) => entry.id === input.entryId);
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      const name = input.name.trim();
      this.replacementSessionName = name;
      try {
        if (input.mode !== "timeline") {
          return await this.replace(() => this.requireRuntime().fork(input.entryId, { position: input.position }));
        }
        const checkpointId = this.forkPromptCheckpoints.get(input.entryId);
        if (!checkpointId || !this.runtimePolicy.effective.timelineEnabled) {
          throw new Error("No compatible Timeline checkpoint exists for this prompt");
        }
        await this.confirmTimelinePromptFork(session, checkpointId);
        return await this.replace(async () => {
          await session.prompt(`/timeline fork ${checkpointId}`, { source: "rpc" });
          return { cancelled: false };
        });
      } finally {
        this.replacementSessionName = undefined;
      }
    });
  }

  async setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult> {
    const catalog = this.packageCatalog;
    if (!catalog) throw new Error("runtime is not ready");
    return this.changePackages(async (previous) => {
      if (previous.enabledIds.has(input.packageId) === input.enabled) {
        return { next: previous, rollback: async () => undefined, changed: false };
      }
      return {
        next: await catalog.setEnabled(input.packageId, input.enabled),
        rollback: () => catalog.restoreEnabled(previous.enabledIds),
      };
    });
  }

  async updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult> {
    const catalog = this.packageCatalog;
    if (!catalog) throw new Error("runtime is not ready");
    this.assertPackageModels(input.settings);
    return this.changePackages(async () => {
      const oldSettings = await catalog.updateSettings(input.packageId, input.settings);
      return {
        next: await catalog.scan(),
        rollback: () => catalog.updateSettings(input.packageId, oldSettings).then(() => undefined),
      };
    });
  }

  async rebuildDiscoverIndex(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready || this.indexUpdate || !this.canSleep()) {
      throw new Error("the index can only rebuild while the session is idle");
    }
    this.indexUpdate = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let handled = false;
        this.eventBus.emit("pi-discover:index-action", {
          version: 1,
          action: "rebuild",
          acknowledge: () => { handled = true; },
          resolve,
          reject,
        });
        if (!handled) reject(new Error("pi-discover indexing is unavailable"));
      });
      this.refreshSnapshot();
    } finally {
      this.indexUpdate = false;
      if (runtime === this.runtime) this.refreshSnapshot();
    }
  }

  private async changePackages(
    mutate: (previous: PackageCatalogState) => Promise<{ next: PackageCatalogState; rollback: () => Promise<void>; changed?: boolean }>,
  ): Promise<ReplacementResult> {
    const runtime = this.requireRuntime();
    const catalog = this.packageCatalog;
    if (!catalog || !this.createRuntime || !this.target || !this.gate.ready) throw new Error("runtime is not ready");
    if (this.packageUpdate || this.sessionMutation || runtime.session.isStreaming || this.ui.hasPendingDialog
      || this.operational.jobs.items.some((job) => job.state === "running")) {
      throw new Error("packages can only change while the session is idle");
    }
    const sessionFile = runtime.session.sessionFile;
    if (!sessionFile) throw new Error("the current session must be persisted before packages can change");
    const session = { cwd: runtime.cwd, path: sessionFile };
    this.packageUpdate = true;
    const previous = await catalog.scan().catch((error) => {
      this.packageUpdate = false;
      throw error;
    });
    const previousFactory = this.createRuntime;
    let rollback: (() => Promise<void>) | undefined;
    try {
      const change = await mutate(previous);
      rollback = change.rollback;
      if (change.changed === false) {
        return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
      }
      const nextFactory = await createPylonRuntimeFactory({
        agentDir: this.target.agentDir,
        additionalExtensionPaths: change.next.extensionPaths,
        extensionFactories: [this.promptAttachments.extension, this.workspaceApplyTool.extension, ...(this.options.extensionFactories ?? [])],
        eventBus: this.eventBus,
      });
      this.packageState = change.next;
      await this.rebuildSession(session, nextFactory, false);
      this.createRuntime = nextFactory;
      return { cancelled: false, sessionId: this.requireRuntime().session.sessionId, sessionGeneration: this.gate.generation };
    } catch (error) {
      await rollback?.().catch(() => undefined);
      this.packageState = previous;
      if (!this.gate.ready) {
        await this.rebuildSession(session, previousFactory, true).catch((recoveryError) => this.recordError(recoveryError));
      }
      throw error;
    } finally {
      this.packageUpdate = false;
    }
  }

  private assertPackageModels(settings: PackageSettingsReadModel): void {
    const runtime = this.requireRuntime();
    const available = new Map(runtime.services.modelRuntime.getAvailableSnapshot()
      .map((model) => [`${model.provider}/${model.id}`, model]));
    const assertProfile = (modelRef: string | undefined, thinking: string | undefined) => {
      const model = modelRef ? available.get(modelRef) : undefined;
      if (!model) throw new Error("package model is unavailable or has no configured credentials");
      if (thinking && !supportedThinkingLevels(model).includes(thinking as ThinkingLevel)) {
        throw new Error("package thinking level is unavailable for the selected model");
      }
    };
    if (settings.kind === "continuity") {
      if (settings.planner) assertProfile(settings.planner.model, settings.planner.thinking);
      if (settings.executor) assertProfile(settings.executor.model, settings.executor.thinking);
      return;
    }
    if (settings.kind === "advisor" || settings.kind === "scout") {
      if (settings.mode === "disabled") return;
      if (settings.mode === "model") {
        assertProfile(settings.model, settings.thinking);
        return;
      }
      if (settings.thinking && !runtime.session.getAvailableThinkingLevels().includes(settings.thinking)) {
        throw new Error("package thinking level is unavailable for the session model");
      }
      return;
    }
    if (settings.kind === "grunt" && settings.mode === "model") {
      assertProfile(settings.model, undefined);
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

  async setSessionControls(input: SetSessionControlsInput): Promise<void> {
    const session = this.controlSession();
    this.validateSessionControls(input);
    const model = this.requireRuntime().services.modelRuntime.getAvailableSnapshot()
      .find((item) => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    const previousModel = session.model;
    const previousThinking = session.thinkingLevel;
    try {
      await session.setModel(model);
      session.setThinkingLevel(input.thinkingLevel);
      this.refreshSnapshot();
    } catch (error) {
      if (previousModel) await session.setModel(previousModel).catch(() => undefined);
      if (session.getAvailableThinkingLevels().includes(previousThinking)) {
        session.setThinkingLevel(previousThinking);
      }
      this.refreshSnapshot();
      throw error;
    }
  }

  validateSessionControls(input: SetSessionControlsInput): ModelOptionReadModel {
    const model = this.requireRuntime().services.modelRuntime.getAvailableSnapshot()
      .find((item) => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    const thinkingLevels = supportedThinkingLevels(model);
    if (!thinkingLevels.includes(input.thinkingLevel)) {
      throw new Error("thinking level is unavailable for this model");
    }
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      thinkingLevels: [...thinkingLevels],
    };
  }

  hasActiveAgentRun(): boolean {
    return Boolean(this.workStartedAt);
  }

  updateContinuityMemory(input: UpdateContinuityMemoryInput): Promise<void> {
    return this.continuityMemoryMutation({
      action: "update",
      key: input.key,
      text: input.text,
      kind: input.kind,
      expectedUpdatedAt: input.expectedUpdatedAt,
    }, input.expectedGeneration);
  }

  deleteContinuityMemory(input: DeleteContinuityMemoryInput): Promise<void> {
    return this.continuityMemoryMutation({
      action: "delete",
      key: input.key,
      expectedUpdatedAt: input.expectedUpdatedAt,
    }, input.expectedGeneration);
  }

  async answerUiRequest(input: UiResponse): Promise<void> {
    this.ui.answer(input);
  }

  keepUiRequestAlive(requestId: string, sessionGeneration: number): void {
    this.gate.assert(sessionGeneration);
    this.ui.keepAlive(requestId, sessionGeneration);
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtimeState(): SessionRuntimeState {
    const runtime = this.requireRuntime();
    if (this.ui.hasPendingDialog) return "attention";
    if (runtime.session.isStreaming || runtime.session.pendingMessageCount > 0 || this.indexUpdate
      || this.operational.jobs.items.some((job) => job.state === "running")) return "running";
    return "idle";
  }

  canSleep(): boolean {
    return this.runtimeState() === "idle" && !this.sessionMutation && !this.packageUpdate && !this.indexUpdate;
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
      if (this.replacementSessionName) session.setSessionName(this.replacementSessionName);
      this.runtimeDisposable = true;
      this.loadRuntimePolicy(session.sessionId);
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
    if (this.timingSessionId !== session.sessionId) {
      this.timingSessionId = session.sessionId;
      this.workStartedAt = undefined;
      this.workStartedAtMs = undefined;
      this.workDurations.clear();
      this.turnControls.clear();
      this.turnChanges.clear();
      this.turnChangesLeafId = undefined;
      this.pendingWorktreeTurns.length = 0;
      this.nextTurnId = 0;
      this.workTurnId = undefined;
      this.workUserEntryId = undefined;
      this.stopping = false;
      this.stoppedRun = undefined;
      this.discoverIndex = undefined;
      this.workModelName = undefined;
      this.workThinkingLevel = undefined;
      this.gitBranch = this.readDisplayGitBranch(session.sessionManager.getCwd(), session.sessionId);
    }
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
    this.publishRuntimePolicy();
    this.unsubscribeSession = session.subscribe((payload) => {
      if (!this.gate.accepts(generation)) return;
      const raw = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const kind = String(raw.type ?? "");
      let forwarded: unknown = payload;
      if (kind === "agent_start") {
        this.workTurnId = `turn-${++this.nextTurnId}`;
        this.workStartedAtMs = Date.now();
        this.workStartedAt = new Date(this.workStartedAtMs).toISOString();
        this.workModelName = session.model?.name;
        this.workThinkingLevel = session.supportsThinking() ? session.thinkingLevel : undefined;
        this.workUserEntryId = this.latestUserEntryId(session);
        this.stopping = false;
        this.stoppedRun = undefined;
        this.sessionIndex.invalidate();
        this.refreshSnapshot();
        forwarded = {
          ...raw,
          workStartedAt: this.workStartedAt,
          turnId: this.workTurnId,
          modelName: this.workModelName,
          thinkingLevel: this.workThinkingLevel,
          metrics: this.lastSnapshot?.metrics,
        };
      } else if (kind === "message_end" || kind === "message_complete") {
        const message = raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
          ? raw.message as Record<string, unknown>
          : {};
        if (String(raw.role ?? message.role) === "user" && typeof raw.entryId !== "string" && typeof message.entryId !== "string") {
          forwarded = { ...raw, entryId: this.latestUserEntryId(session) };
        }
      } else if (kind === "agent_end") {
        const duration = Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, Date.now() - (this.workStartedAtMs ?? Date.now())));
        const messages = this.transcriptMessages(session);
        let assistantIndex = -1;
        for (let index = messages.length - 1; index >= 0; index--) {
          if ((messages[index] as { role?: unknown } | undefined)?.role === "assistant") {
            assistantIndex = index;
            break;
          }
        }
        const messageId = assistantIndex >= 0 ? `history-${assistantIndex}` : undefined;
        const assistantEntryId = assistantIndex >= 0
          && typeof (messages[assistantIndex] as { entryId?: unknown }).entryId === "string"
          ? (messages[assistantIndex] as { entryId: string }).entryId
          : undefined;
        if (messageId) {
          this.workDurations.set(messageId, duration);
          this.turnControls.set(messageId, {
            modelName: this.workModelName,
            thinkingLevel: this.workThinkingLevel,
          });
        }
        const turnId = this.workTurnId ?? `turn-${++this.nextTurnId}`;
        this.pendingWorktreeTurns.push({ turnId, messageId, assistantEntryId });
        if (this.pendingWorktreeTurns.length > 20) this.pendingWorktreeTurns.shift();
        const modelName = this.workModelName;
        const thinkingLevel = this.workThinkingLevel;
        const userEntryId = this.workUserEntryId;
        const stopped = this.stopping || agentWasAborted(raw);
        if (stopped) {
          this.stoppedRun = {
            turnId,
            ...(this.workUserEntryId ? { userEntryId: this.workUserEntryId } : {}),
            durationMs: duration,
            ...(modelName ? { modelName } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          };
        }
        this.workStartedAt = undefined;
        this.workStartedAtMs = undefined;
        this.workModelName = undefined;
        this.workThinkingLevel = undefined;
        this.workTurnId = undefined;
        this.workUserEntryId = undefined;
        this.stopping = false;
        this.sessionIndex.invalidate();
        invalidateFileSuggestions(session.sessionManager.getCwd());
        this.gitBranch = this.readDisplayGitBranch(session.sessionManager.getCwd(), session.sessionId);
        this.refreshSnapshot();
        forwarded = {
          ...raw,
          workDurationMs: duration,
          turnId,
          modelName,
          thinkingLevel,
          gitBranch: this.gitBranch,
          metrics: this.lastSnapshot?.metrics,
          stopped,
          userEntryId,
        };
      } else if (kind === "session_info_changed") {
        this.sessionIndex.invalidate();
        this.refreshSnapshot();
      }
      this.emit({
        type: "session.event",
        sessionId: session.sessionId,
        sessionGeneration: generation,
        payload: forwarded,
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
      cwdLabel: this.displayCwdLabel(runtime.cwd, runtime.session.sessionId),
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: [], tools: [], delegatedRuns: [], streaming: false,
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
      throw new Error("Session controls can only change while the session is idle");
    }
    return runtime.session;
  }

  private continuityMemoryMutation(
    mutation: Record<string, unknown>,
    expectedGeneration = this.gate.generation,
  ): Promise<void> {
    this.gate.assert(expectedGeneration);
    const session = this.controlSession();
    return new Promise<void>((resolve, reject) => {
      let answered = false;
      this.eventBus.emit("pi-continuity:memory-mutation", {
        version: 1,
        sessionId: session.sessionId,
        ...mutation,
        respond: (result: unknown | Promise<unknown>) => {
          if (answered) return;
          answered = true;
          Promise.resolve(result).then(() => resolve(), reject);
        },
      });
      if (!answered) reject(new Error("Continuity memory is unavailable"));
    });
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
    this.hydrateTurnChanges(session);
    this.requestPackageStates(session.sessionId);
    const stats = session.getSessionStats();
    const context = session.getContextUsage();
    const messages = this.transcriptMessages(session);
    const historyStart = Math.max(0, messages.length - HISTORY_PAGE_SIZE);
    const projectedConversation = projectConversation(messages, { start: historyStart });
    const projectedMessages = projectedConversation.messages.map((message) => {
      const workDurationMs = this.workDurations.get(message.id);
      const controls = this.turnControls.get(message.id);
      const changedFiles = message.entryId ? this.turnChanges.get(message.entryId) : undefined;
      return workDurationMs === undefined && !controls && !changedFiles
        ? message
        : {
            ...message,
            ...(workDurationMs === undefined ? {} : { workDurationMs }),
            ...controls,
            ...(changedFiles ? { changedFiles: changedFiles.map((file) => ({ ...file })) } : {}),
          };
    });
    const model = session.model;
    const models = runtime.services.modelRuntime.getAvailableSnapshot().slice(0, 500)
      .map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        thinkingLevels: [...supportedThinkingLevels(item)],
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
    const commands = runtime.services.resourceLoader.getExtensions().runtime.getCommands()
      .slice(0, 200)
      .map((command) => ({
        name: command.name.slice(0, 120),
        ...(command.description ? { description: command.description.slice(0, 300) } : {}),
        source: command.source,
      }));
    const loadedExtensions = runtime.services.resourceLoader.getExtensions().extensions.map((extension) => basename(extension.resolvedPath));
    const selectedProject = this.projectRegistry?.projectForSession(session.sessionId, runtime.cwd);
    this.operational = withOperationalCapabilities(this.operational, availableTools, loadedExtensions, this.diagnostics);
    this.lastSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      sessionGeneration: this.gate.generation,
      ready: this.gate.ready,
      cwdLabel: selectedProject?.label ?? this.displayCwdLabel(runtime.cwd, session.sessionId),
      projectAvailable: !this.target?.inMemory && Boolean(selectedProject && !selectedProject.archivedAt),
      sessionName: session.sessionManager.getSessionName(),
      gitBranch: this.gitBranch,
      activeTools: session.getActiveToolNames().sort(),
      availableTools,
      optionalCapabilities: Object.fromEntries(
        OPTIONAL_TOOLS.map((tool) => [tool, available.has(tool) ? "available" : "unavailable"]),
      ),
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: projectedMessages,
        tools: [],
        delegatedRuns: projectedConversation.delegatedRuns,
        ...(historyStart > 0 ? {
          historyCursor: encodeHistoryCursor(historyStart),
          historyRemaining: historyStart,
        } : {}),
        streaming: session.isStreaming,
        workStartedAt: this.workStartedAt,
        workModelName: this.workModelName,
        workThinkingLevel: this.workThinkingLevel,
        ...(this.stopping ? { stopping: true } : {}),
        ...(this.stoppedRun ? { stoppedRun: { ...this.stoppedRun } } : {}),
        queue: { steering: 0, followUp: 0 },
        retry: { active: false },
        compaction: { active: false },
      },
      sessionControls: {
        model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
        models,
        thinkingLevel: session.supportsThinking() ? session.thinkingLevel : undefined,
        thinkingLevels: session.getAvailableThinkingLevels(),
        commands,
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
      ...(this.discoverIndex ? { discoverIndex: { ...this.discoverIndex } } : {}),
      extensionUi: this.ui.snapshot(),
      runtimePolicy: {
        ...this.runtimePolicy,
        project: { ...this.runtimePolicy.project, verify: cloneVerifyPolicy(this.runtimePolicy.project.verify) },
        session: {
          ...(this.runtimePolicy.session.verify ? { verify: cloneVerifyPolicy(this.runtimePolicy.session.verify) } : {}),
          ...(this.runtimePolicy.session.timelineEnabled !== undefined ? { timelineEnabled: this.runtimePolicy.session.timelineEnabled } : {}),
          ...(this.runtimePolicy.session.workspace ? { workspace: this.runtimePolicy.session.workspace } : {}),
          ...(this.runtimePolicy.session.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: this.runtimePolicy.session.guardTimeoutSeconds } : {}),
          ...(this.runtimePolicy.session.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: this.runtimePolicy.session.clarifyTimeoutSeconds } : {}),
        },
        effective: { ...this.runtimePolicy.effective, verify: cloneVerifyPolicy(this.runtimePolicy.effective.verify) },
        availableVerifyChecks: this.runtimePolicy.availableVerifyChecks.map((check) => ({ ...check })),
      },
    };
  }

  private displayProject(cwd: string, sessionId?: string) {
    const selected = this.target?.projectId
      ? this.projectRegistry?.get(this.target.projectId)
      : undefined;
    return selected ?? (sessionId ? this.projectRegistry?.projectForSession(sessionId, cwd) : undefined);
  }

  private loadRuntimePolicy(sessionId: string): void {
    const project = this.displayProject(this.runtime?.session.sessionManager.getCwd() ?? this.target?.cwd ?? "", sessionId);
    this.runtimePolicy = project && this.projectRegistry
      ? this.projectRegistry.runtimePolicy(project.id, sessionId)
      : defaultRuntimePolicy();
  }

  private publishRuntimePolicy(): void {
    const sessionId = this.runtime?.session.sessionId;
    if (!sessionId) return;
    this.eventBus.emit("pylon:runtime-policy", {
      version: 2,
      sessionId,
      verify: cloneVerifyPolicy(this.runtimePolicy.effective.verify),
      timelineEnabled: this.runtimePolicy.effective.timelineEnabled,
      dialogTimeouts: {
        guard: this.runtimePolicy.effective.guardTimeoutSeconds,
        clarify: this.runtimePolicy.effective.clarifyTimeoutSeconds,
      },
    });
    this.eventBus.emit("pi-verify:catalog-request", {
      version: 1,
      sessionId,
      respond: (value: unknown) => this.captureVerifyCatalog(value),
    });
  }

  private captureVerifyCatalog(value: unknown): void {
    if (value && typeof (value as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(value).then((resolved) => this.captureVerifyCatalog(resolved), (error) => this.recordError(error));
      return;
    }
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    if (raw?.version !== 1 || !Array.isArray(raw.checks)) return;
    const checks = raw.checks.slice(0, 100).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const check = value as Record<string, unknown>;
      if (typeof check.id !== "string" || !check.id || check.id.length > 100
        || typeof check.label !== "string" || !check.label || check.label.length > 200
        || typeof check.command !== "string" || !check.command || check.command.length > 500) return [];
      return [{ id: check.id, label: check.label, command: check.command }];
    });
    this.runtimePolicy = { ...this.runtimePolicy, availableVerifyChecks: checks };
    if (this.gate.ready && this.runtime) {
      this.refreshSnapshot();
      this.emit({
        type: "session.event",
        sessionId: this.runtime.session.sessionId,
        sessionGeneration: this.gate.generation,
        payload: { type: "runtime_policy_changed" },
      });
    }
  }

  private displayCwdLabel(cwd: string, sessionId?: string): string {
    return this.displayProject(cwd, sessionId)?.label ?? (basename(cwd) || cwd);
  }

  private readDisplayGitBranch(cwd: string, sessionId?: string): string | undefined {
    return readGitBranch(this.displayProject(cwd, sessionId)?.cwd ?? cwd);
  }

  private installBusHooks(generation: number): void {
    this.detachBus();
    this.busUnsubscribers.push(this.eventBus.on("pi-discover:index-state", (payload) => {
      if (!this.gate.accepts(generation)) return;
      const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      if (raw?.version !== 1) return;
      if (raw.available === false) {
        this.discoverIndex = undefined;
      } else if (["idle", "indexing", "error"].includes(String(raw.state))) {
        this.discoverIndex = {
          state: raw.state as DiscoverIndexReadModel["state"],
          ...(Number.isSafeInteger(raw.files) && (raw.files as number) >= 0 ? { files: raw.files as number } : {}),
          ...(Number.isSafeInteger(raw.symbols) && (raw.symbols as number) >= 0 ? { symbols: raw.symbols as number } : {}),
          ...(typeof raw.indexedAt === "string" && !Number.isNaN(Date.parse(raw.indexedAt)) ? { indexedAt: raw.indexedAt } : {}),
          ...(typeof raw.error === "string" && raw.error ? { error: raw.error.slice(0, 500) } : {}),
        };
      } else {
        return;
      }
      const sessionId = this.runtime?.session.sessionId;
      if (sessionId) this.emit({
        type: "session.event",
        sessionId,
        sessionGeneration: generation,
        payload: { type: "discover_index", value: this.discoverIndex },
      });
    }));
    this.busUnsubscribers.push(this.eventBus.on("pi-verify:catalog", (payload) => {
      if (!this.gate.accepts(generation)) return;
      this.captureVerifyCatalog(payload);
    }));
    for (const channel of ["pi-verify:lifecycle", "pi-verify:result", "pi-heartbeat:job", "pi-guard:decision", "pylon:tool-policy", "pi-continuity:state-change", "pi-timeline:state-change", "pi-sieve:state-change"]) {
      this.busUnsubscribers.push(this.eventBus.on(channel, (payload) => {
        const active = this.gate.accepts(generation);
        const replacing = this.replacementInvalidated && this.replacementGeneration === generation;
        if (!active && !replacing) return;
        const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
        if (replacing && raw?.available === false) return;
        const sessionId = active ? this.runtime?.session.sessionId : undefined;
        if (channel === "pi-timeline:state-change") this.captureTimelineUndo(raw);
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
          payload: channel === "pi-timeline:state-change" && raw
            ? Object.fromEntries(Object.entries(raw).filter(([key]) =>
                key !== "undoPromptEntryIds"
                && key !== "forkPromptEntryIds"
                && key !== "forkPromptCheckpoints"))
            : payload,
          operational: cloneOperational(this.operational),
        });
      }));
    }
    this.busUnsubscribers.push(this.eventBus.on("pylon:worktree-summary", (payload) => {
      if (!this.gate.accepts(generation)) return;
      const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      if (raw?.version !== 1 || typeof raw.known !== "boolean" || !Array.isArray(raw.files)) return;
      const turn = this.pendingWorktreeTurns.shift();
      if (!turn || raw.known !== true || !turn.messageId || !turn.assistantEntryId) return;
      if (raw.assistantEntryId !== undefined && raw.assistantEntryId !== turn.assistantEntryId) return;
      const summary = parseWorktreeSummary({
        version: 1,
        assistantEntryId: turn.assistantEntryId,
        files: raw.files,
      });
      if (!summary) return;
      const messageId = turn.messageId;
      this.turnChanges.set(summary.assistantEntryId, summary.files);
      this.turnChangesLeafId = this.runtime!.session.sessionManager.getLeafId();
      const sessionId = this.runtime!.session.sessionId;
      this.emit({
        type: "session.event",
        sessionId,
        sessionGeneration: generation,
        payload: { type: "worktree_summary", turnId: turn.turnId, messageId, files: summary.files },
      });
    }));
  }

  private hydrateTurnChanges(session: AgentSession): void {
    const leafId = session.sessionManager.getLeafId();
    if (this.turnChangesLeafId === leafId) return;
    this.turnChanges.clear();
    for (const [entryId, files] of readPersistedWorktreeSummaries(session.sessionManager)) {
      this.turnChanges.set(entryId, files);
    }
    this.turnChangesLeafId = leafId;
  }

  private transcriptMessages(session: AgentSession): unknown[] {
    const sessionId = session.sessionId;
    const leafId = session.sessionManager.getLeafId();
    const cached = this.transcriptCache;
    if (cached?.sessionId === sessionId && cached.leafId === leafId) return cached.messages;
    const messages = session.sessionManager.getBranch()
      .filter((entry) => entry.type === "message" || entry.type === "custom_message")
      .flatMap((entry) => sessionEntryToContextMessages(entry)
        .map((message) => ({
          ...message,
          entryId: entry.id,
          timestamp: (message as { timestamp?: unknown }).timestamp
            ?? (entry as { timestamp?: unknown }).timestamp,
          ...(this.undoPromptEntryIds.has(entry.id) ? { canUndo: true } : {}),
          ...(this.forkPromptEntryIds.has(entry.id) ? { canForkWithTimeline: true } : {}),
        })));
    this.transcriptCache = { sessionId, leafId, messages };
    return messages;
  }

  private latestUserEntryId(session: AgentSession): string | undefined {
    const branch = session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as { id?: unknown; type?: unknown; message?: { role?: unknown } } | undefined;
      if (entry?.type === "message" && entry.message?.role === "user" && typeof entry.id === "string") return entry.id;
    }
    return undefined;
  }

  private prepareTimelineEdit(
    session: AgentSession,
    targetEntryId: string,
    rollbackFiles: boolean,
  ): Promise<TimelineEditTransaction | undefined> {
    return new Promise((resolve, reject) => {
      let handled = false;
      this.eventBus.emit("pi-timeline:edit-navigation", {
        version: 1,
        sessionId: session.sessionId,
        targetEntryId,
        rollbackFiles,
        respond: (result: TimelineEditTransaction | Promise<TimelineEditTransaction>) => {
          handled = true;
          void Promise.resolve(result).then(resolve, reject);
        },
      });
      if (handled) return;
      if (rollbackFiles) {
        reject(new Error("Pi Timeline is unavailable for filesystem rollback"));
        return;
      }
      resolve(undefined);
    });
  }

  private confirmTimelinePromptFork(session: AgentSession, checkpointId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let handled = false;
      this.eventBus.emit("pi-timeline:prompt-fork", {
        version: 1,
        sessionId: session.sessionId,
        checkpointId,
        respond: (result: unknown) => {
          handled = true;
          const value = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
          if (value?.version === 1 && value.available === true) resolve();
          else reject(new Error("No compatible Timeline checkpoint exists for this prompt"));
        },
      });
      if (!handled) reject(new Error("Pi Timeline is unavailable for this prompt"));
    });
  }

  private requestPackageStates(sessionId: string): void {
    for (const channel of ["pi-continuity:state-request", "pi-timeline:state-request", "pi-sieve:state-request"]) {
      let answered = false;
      try {
        this.eventBus.emit(channel, {
          version: channel === "pi-timeline:state-request" ? 4 : channel === "pi-sieve:state-request" ? 1 : 2,
          sessionId,
          respond: (payload: unknown) => {
            const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
            if (answered || raw?.sessionId !== sessionId) return;
            answered = true;
            const stateChannel = channel.replace("state-request", "state-change");
            if (stateChannel === "pi-timeline:state-change") this.captureTimelineUndo(raw, false);
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

  private captureTimelineUndo(raw?: Record<string, unknown>, publish = true): void {
    if (raw?.version !== 4 || !Array.isArray(raw.undoPromptEntryIds)) return;
    const available = raw.available === true;
    this.undoPromptEntryIds = new Set(
      (available ? raw.undoPromptEntryIds : [])
        .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128)
        .slice(0, 10_000),
    );
    this.forkPromptEntryIds = new Set(
      available && Array.isArray(raw.forkPromptEntryIds)
        ? raw.forkPromptEntryIds
            .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128)
            .slice(0, 10_000)
        : [],
    );
    this.forkPromptCheckpoints = new Map(
      available && Array.isArray(raw.forkPromptCheckpoints)
        ? raw.forkPromptCheckpoints.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const item = value as Record<string, unknown>;
            return typeof item.promptEntryId === "string" && item.promptEntryId.length <= 128
              && typeof item.checkpointId === "string" && item.checkpointId.length <= 128
              ? [[item.promptEntryId, item.checkpointId] as const]
              : [];
          }).slice(0, 10_000)
        : [],
    );
    const sessionId = this.runtime?.session.sessionId;
    if (!publish || !sessionId) return;
    this.emit({
      type: "session.event",
      sessionId,
      sessionGeneration: this.gate.generation,
      payload: {
        type: "prompt_undo",
        entryIds: [...this.undoPromptEntryIds],
        forkEntryIds: [...this.forkPromptEntryIds],
      },
    });
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

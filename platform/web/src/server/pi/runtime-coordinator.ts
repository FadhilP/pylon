import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import type { PromptImage, PromptTextFile, QueuedPromptPayload } from "../../shared/protocol/commands.ts";
import type { HeliosBrowserInput, HeliosBrowserResult } from "../../shared/protocol/helios.ts";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createSessionWorktreeFromState,
  claimSessionCheckout,
  captureCheckoutState,
  inspectGitWorkspace,
  inspectWorkspaceChanges,
  inspectTreeChanges,
  mergeWorkspaceChanges,
  collectWorkspaceFiles,
  collectPlainWorkspaceFiles,
  readWorkspaceFile,
  readPlainWorkspaceFile,
  recreateSessionWorktree,
  restoreCheckoutState,
  diffWorkspaceFile,
  removeSessionWorktree,
  removeSessionBranch,
  sessionWorktreeBranch,
  snapshotSessionBranch,
} from "pylon-core/src/worktree.ts";
import type { CheckoutState } from "pylon-core/src/worktree.ts";
import type { ModelOptionReadModel, QueueReadModel, SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, ConversationHistoryPage, ConversationHistoryQuery, ConversationTurnIndexPage, ConversationTurnIndexQuery, FileSuggestionList, PackageListSnapshot, RuntimeSnapshot, SessionListQuery, SessionListSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFilePage, WorkspaceFileReadModel, WorkspaceReadModel } from "../../shared/protocol/snapshots.ts";
import { describeRuntimeSnapshotIssue } from "../../shared/protocol/validation.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import { SessionRuntime, type SessionRuntimeOptions } from "./session-runtime.ts";
import { createPylonModelRuntime } from "./runtime-factory.ts";
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
  ProjectWorktreeSettingsInput,
  PromptInput,
  ApplySessionChangesInput,
  HandoffSessionInput,
  QueueMutationInput,
  RewindPromptInput,
  ReorderActiveSessionInput,
  ReorderProjectInput,
  RemoveProjectInput,
  RenameProjectInput,
  ReplacementResult,
  RuntimeHandle,
  RuntimeTarget,
  RenameSessionInput,
  SetModelInput,
  SetPackageEnabledInput,
  SetSessionActiveInput,
  SetSessionPinnedInput,
  SetThinkingLevelInput,
  SetSessionControlsInput,
  StartProviderLoginInput,
  SessionArchiveInput,
  SwitchSessionInput,
  TimelineCheckpointDiffInput,
  TimelineCheckpointInput,
  UpdateContinuityMemoryInput,
  UpdatePackageSettingsInput,
  UpdateRuntimePolicyInput,
  WorkspaceFileInput,
  WorkspaceFilesInput,
} from "./pi-driver.ts";
import type { UiRequest, UiResponse } from "./remote-ui-context.ts";
import { SessionIndex } from "./session-index.ts";
import { pickProjectDirectory, ProjectRegistry, projectIdForCwd } from "./project-registry.ts";

const SLEEP_AFTER_MS = 30 * 60 * 1000;
const VIEW_ONLY_SLEEP_AFTER_MS = 60 * 1000;
const SLEEP_CHECK_MS = 60 * 1000;
const SETUP_LOG_BYTES = 64 * 1024;
const WORKSPACE_INVENTORY_TTL_MS = 60_000;
const MAX_WORKSPACE_INVENTORIES = 25;
const branchLabel = (ref?: string) => ref?.replace(/^refs\/heads\//, "").slice(0, 200);

function sameCheckout(left: CheckoutState, right: CheckoutState): boolean {
  return left.commonDir === right.commonDir
    && left.head === right.head
    && left.headRef === right.headRef
    && left.indexTree === right.indexTree
    && left.worktreeTree === right.worktreeTree;
}

class WorkspaceApplyConflictError extends Error {
  constructor(readonly conflicts: Array<{ path: string; context?: string }>) {
    super(`Session changes conflict in ${conflicts.slice(0, 8).map((item) => item.path).join(", ")}${conflicts.length > 8 ? ` and ${conflicts.length - 8} more` : ""}.`);
  }
}

interface CachedWorkspaceInventory {
  cwd: string;
  baselineTree?: string;
  expiresAt: number;
  revision: string;
  files: WorkspaceFileReadModel[];
  truncated: boolean;
}

function runSetupCommand(cwd: string, command: string, signal?: AbortSignal): Promise<void> {
  if (!command.trim()) return Promise.resolve();
  const executable = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, {
      cwd,
      timeout: 10 * 60_000,
      maxBuffer: SETUP_LOG_BYTES,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise();
        return;
      }
      const log = String(stderr || stdout || error.message).trim().slice(0, SETUP_LOG_BYTES);
      reject(new Error(log || "worktree setup failed"));
    });
  });
}

export interface RuntimeCoordinatorOptions extends SessionRuntimeOptions {
  sleepAfterMs?: number;
  viewOnlySleepAfterMs?: number;
  sleepCheckMs?: number;
  pickDirectory?: (signal?: AbortSignal) => Promise<string | undefined>;
}

interface RuntimeSlot {
  id: string;
  driver: SessionRuntime;
  target: RuntimeTarget;
  innerGeneration: number;
  lastActivityAt: number;
  receivedInput: boolean;
  pinned: boolean;
  lastState: SessionRuntimeState;
  pendingUi?: UiRequest;
  nativeQueue: { steering: number; followUp: number };
  queuedPrompt?: {
    id: string;
    commandId: string;
    message: string;
    images?: PromptImage[];
    files?: PromptTextFile[];
    planMode: boolean;
    state: "queued" | "delivering";
  };
  pendingControls?: {
    input: SetSessionControlsInput;
    model: ModelOptionReadModel;
  };
  pendingApply?: { revision: string };
  suppressEvents?: boolean;
  unsubscribe: () => void;
  setupState?: "idle" | "running" | "failed";
  setupError?: string;
  applyState?: "pending" | "applying";
  lastApply?: NonNullable<WorkspaceReadModel["lastApply"]>;
  workspace?: WorkspaceReadModel;
  workspaceRefresh?: Promise<void>;
  provisional?: {
    previous: RuntimeSlot;
    projectId: string;
    worktree: {
      root: string;
      commonDir: string;
      branch: string;
    };
    oldSessionPath?: string;
  };
  checkoutProvisional?: {
    projectId: string;
    branch: string;
    commonDir: string;
    parked: CheckoutState;
  };
}

/** Keeps visited SDK sessions alive while preserving one server-wide selection. */
export class RuntimeCoordinator implements PiDriver {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly listeners = new Set<DriverEventListener>();
  private readonly sessionIndex = new SessionIndex();
  private projectRegistry?: ProjectRegistry;
  private selectedId = "";
  private generation = 0;
  private target?: RuntimeTarget;
  private modelRuntime?: ModelRuntime;
  private sleepTimer?: NodeJS.Timeout;
  private lifecycleBusy = false;
  private pickerBusy = false;
  private pickerAbort?: AbortController;
  private setupAbort?: AbortController;
  private disposed = false;
  private readonly workspaceInventories = new Map<string, CachedWorkspaceInventory>();

  constructor(private readonly options: RuntimeCoordinatorOptions = {}) {}

  async start(target: RuntimeTarget): Promise<RuntimeHandle> {
    if (this.target || this.disposed) throw new Error("driver cannot be started twice");
    this.target = target;
    this.modelRuntime = this.options.modelRuntime ?? await createPylonModelRuntime(target.agentDir);
    this.projectRegistry = ProjectRegistry.forAgentDir(target.agentDir);
    await this.projectRegistry.load(async () => {
      const knownSessions = await SessionManager.listAll();
      return [target.cwd, ...knownSessions.map((session) => session.cwd)];
    });
    await this.recoverProvision();
    await this.recoverHandoff();
    await this.recoverApply();
    this.sessionIndex.setProjectRegistry(this.projectRegistry);
    const projects = this.projectRegistry.list();
    const project = projects.find((candidate) => candidate.id === projectIdForCwd(target.cwd)) ?? projects[0];
    const slot = await this.createSlot(project
      ? { ...target, cwd: project.cwd, projectId: project.id }
      : { ...target, inMemory: true });
    this.selectedId = slot.id;
    this.generation = 1;
    await this.wakePinnedSessions(slot.id);
    this.sleepTimer = setInterval(() => void this.sleepIdleSlots(), this.options.sleepCheckMs ?? SLEEP_CHECK_MS);
    this.sleepTimer.unref?.();
    return { sessionId: slot.id, sessionGeneration: this.generation };
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return this.selectedSnapshot();
  }

  terminalTarget() {
    const slot = this.selected();
    return {
      sessionId: slot.id,
      sessionGeneration: this.generation,
      cwd: slot.driver.runtimeDetails().cwd,
    };
  }

  async conversationHistory(input: ConversationHistoryQuery): Promise<ConversationHistoryPage> {
    const slot = this.selected();
    const generation = this.generation;
    const page = await slot.driver.conversationHistory(input);
    this.assertSelected(slot, generation, "loading history");
    return { ...page, sessionGeneration: generation };
  }

  async conversationTurnIndex(input: ConversationTurnIndexQuery): Promise<ConversationTurnIndexPage> {
    const slot = this.selected();
    const generation = this.generation;
    if (!slot.driver.conversationTurnIndex) throw new Error("conversation turn index is unavailable");
    const page = await slot.driver.conversationTurnIndex(input);
    this.assertSelected(slot, generation, "loading turn index");
    return { ...page, sessionGeneration: generation };
  }

  async listSessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    let result: SessionListSnapshot | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const selectedId = this.selected().id;
      const generation = this.generation;
      const activeIds = new Set(this.registry().listActiveSessionOrder());
      result = await this.sessionIndex.list(input, {
        activeId: selectedId,
        generation,
        stateFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeState() ?? "sleeping",
        activeFor: (sessionId) => this.slots.has(sessionId) && activeIds.has(sessionId),
        pinnedFor: (sessionId) => this.registry().isSessionPinned(sessionId),
        userCountFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeDetails().userMessageCount,
        fallbacks: [...this.slots.values()].map((slot) => {
          const details = slot.driver.runtimeDetails();
          return {
            id: details.sessionId,
            path: details.sessionPath ?? "",
            cwd: details.cwd,
            name: details.name,
            created: new Date(slot.lastActivityAt),
            modified: new Date(slot.lastActivityAt),
            messageCount: details.userMessageCount,
            firstMessage: "",
            allMessagesText: "",
          };
        }),
      });
      if (selectedId === this.selectedId && generation === this.generation) return result;
    }
    return result!;
  }

  async listArchived(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const selected = this.selected();
    return this.sessionIndex.listArchived(input, {
      activeId: selected.id,
      generation: this.generation,
      stateFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeState() ?? "sleeping",
      pinnedFor: (sessionId) => this.registry().isSessionPinned(sessionId),
      userCountFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeDetails().userMessageCount,
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    const slot = this.selected();
    const generation = this.generation;
    const result = await slot.driver.listPackages();
    this.assertSelected(slot, generation, "listing packages");
    return { ...result, sessionGeneration: generation };
  }

  async heliosBrowser(input: HeliosBrowserInput): Promise<HeliosBrowserResult> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    if (!slot.driver.heliosBrowser) throw new Error("Helios embedded browser is unavailable");
    const result = await slot.driver.heliosBrowser({ ...input, expectedGeneration: slot.innerGeneration });
    this.assertSelected(slot, input.expectedGeneration, "controlling Helios browser");
    return { ...result, sessionGeneration: this.generation };
  }

  async fileSuggestions(input: FileSuggestionInput): Promise<FileSuggestionList> {
    const slot = this.selected();
    const generation = this.generation;
    const result = await slot.driver.fileSuggestions(input);
    this.assertSelected(slot, generation, "loading file suggestions");
    return { ...result, sessionGeneration: generation };
  }

  async workspaceFiles(input: WorkspaceFilesInput): Promise<WorkspaceFilePage> {
    const slot = this.selected();
    const generation = this.generation;
    const record = this.registry().workspaceForSession(slot.id);
    const cwd = slot.driver.runtimeDetails().cwd;
    const inventoryKey = workspaceInventoryKey(cwd, record?.baselineTree);
    if (input.refresh) this.workspaceInventories.delete(inventoryKey);
    let inventory = this.workspaceInventories.get(inventoryKey);
    if (!inventory || inventory.expiresAt <= Date.now()
      || inventory.cwd !== cwd || inventory.baselineTree !== record?.baselineTree) {
      await this.refreshWorkspace(slot, true);
      const collected = await (await inspectGitWorkspace(cwd)
        ? collectWorkspaceFiles({ cwd, baselineTree: record?.baselineTree })
        : collectPlainWorkspaceFiles({ cwd }));
      inventory = {
        cwd,
        baselineTree: record?.baselineTree,
        expiresAt: Date.now() + WORKSPACE_INVENTORY_TTL_MS,
        revision: collected.revision,
        files: collected.files,
        truncated: collected.truncated,
      };
      this.workspaceInventories.delete(inventoryKey);
      this.workspaceInventories.set(inventoryKey, inventory);
      while (this.workspaceInventories.size > MAX_WORKSPACE_INVENTORIES) {
        this.workspaceInventories.delete(this.workspaceInventories.keys().next().value!);
      }
    }
    const query = (input.query ?? "").trim().toLocaleLowerCase();
    const filtered = query
      ? inventory.files.filter((file) => file.path.toLocaleLowerCase().includes(query))
      : inventory.files;
    const offset = decodeWorkspaceFileCursor(input.cursor, filtered.length);
    const limit = Math.min(200, Math.max(1, input.limit ?? 200));
    const files = filtered.slice(offset, offset + limit);
    const next = offset + files.length;
    this.assertSelected(slot, generation, "listing workspace files");
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: generation,
      revision: inventory.revision,
      files,
      totalCount: filtered.length,
      truncated: inventory.truncated,
      ...(next < filtered.length ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
    };
  }

  async workspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileContent> {
    const slot = this.selected();
    const generation = this.generation;
    const record = this.registry().workspaceForSession(slot.id);
    const cwd = slot.driver.runtimeDetails().cwd;
    const file = await (await inspectGitWorkspace(cwd)
      ? readWorkspaceFile({ cwd, path: input.path, baselineTree: record?.baselineTree, view: input.view })
      : readPlainWorkspaceFile(cwd, input.path));
    this.assertSelected(slot, generation, "loading a workspace file");
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: generation, ...file };
  }

  async workspaceDiff(input: WorkspaceFileInput): Promise<WorkspaceFileDiff> {
    const slot = this.selected();
    const generation = this.generation;
    const record = this.registry().workspaceForSession(slot.id);
    const diff = await diffWorkspaceFile({
      cwd: slot.driver.runtimeDetails().cwd,
      path: input.path,
      baselineTree: record?.baselineTree,
    });
    this.assertSelected(slot, generation, "loading a workspace diff");
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: generation, ...diff };
  }

  async timelineCheckpointFiles(input: TimelineCheckpointInput): Promise<TimelineCheckpointFiles> {
    const slot = this.selected();
    const generation = this.generation;
    const result = await slot.driver.timelineCheckpointFiles(input);
    this.assertSelected(slot, generation, "loading checkpoint files");
    return { ...result, sessionGeneration: generation };
  }

  async timelineCheckpointDiff(input: TimelineCheckpointDiffInput): Promise<TimelineCheckpointDiff> {
    const slot = this.selected();
    const generation = this.generation;
    const result = await slot.driver.timelineCheckpointDiff(input);
    this.assertSelected(slot, generation, "loading a checkpoint diff");
    return { ...result, sessionGeneration: generation };
  }

  async prompt(input: PromptInput): Promise<AcceptedCommand> {
    return this.withLifecycle(() => this.messageCommand("prompt", input));
  }

  async queuePrompt(input: PromptInput): Promise<AcceptedCommand> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    if (slot.queuedPrompt) throw new Error("a prompt is already queued");
    if (slot.driver.runtimeState() !== "running") {
      return this.withLifecycle(() => this.messageCommand("prompt", input));
    }
    slot.queuedPrompt = {
      id: randomUUID(),
      commandId: input.commandId,
      message: input.message,
      ...(input.images?.length ? { images: input.images.map((image) => ({ ...image })) } : {}),
      ...(input.files?.length ? { files: structuredClone(input.files) } : {}),
      planMode: input.planMode === true,
      state: "queued",
    };
    slot.receivedInput = true;
    slot.lastActivityAt = Date.now();
    this.publishQueue(slot);
    return { commandId: input.commandId, sessionGeneration: this.generation, accepted: true };
  }

  async queuedPrompt(input: QueueMutationInput): Promise<QueuedPromptPayload> {
    this.assertGeneration(input.expectedGeneration);
    const queued = this.selectedQueuedPrompt(input.queueId);
    if (queued.state !== "queued") throw new Error("queued prompt is already being delivered");
    return {
      id: queued.id,
      message: queued.message,
      ...(queued.images?.length ? { images: queued.images.map((image) => ({ ...image })) } : {}),
      ...(queued.files?.length ? { files: structuredClone(queued.files) } : {}),
      planMode: queued.planMode,
    };
  }

  async restoreQueuedPrompt(input: QueueMutationInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    const queued = this.selectedQueuedPrompt(input.queueId);
    if (queued.state !== "queued") throw new Error("queued prompt is already being delivered");
    slot.queuedPrompt = undefined;
    slot.lastActivityAt = Date.now();
    this.publishQueue(slot);
  }

  async steerQueuedPrompt(input: QueueMutationInput): Promise<AcceptedCommand> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    const queued = this.selectedQueuedPrompt(input.queueId);
    if (queued.state !== "queued") throw new Error("queued prompt is already being delivered");
    queued.state = "delivering";
    this.publishQueue(slot);
    try {
      const accepted = await slot.driver.steer({
        commandId: queued.commandId,
        expectedGeneration: slot.innerGeneration,
        message: queued.message,
        images: queued.images,
        files: queued.files,
      });
      slot.queuedPrompt = undefined;
      this.publishQueue(slot);
      return {
        ...accepted,
        commandId: input.commandId ?? accepted.commandId,
        sessionGeneration: this.generation,
      };
    } catch (error) {
      queued.state = "queued";
      this.publishQueue(slot);
      throw error;
    }
  }

  async steer(input: PromptInput): Promise<AcceptedCommand> {
    return this.messageCommand("steer", input);
  }

  async followUp(input: PromptInput): Promise<AcceptedCommand> {
    return this.messageCommand("followUp", input);
  }

  async editPrompt(input: EditPromptInput): Promise<AcceptedCommand> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const slot = this.selected();
      slot.lastActivityAt = Date.now();
      slot.suppressEvents = true;
      try {
        await slot.driver.editPrompt({ ...input, expectedGeneration: slot.innerGeneration });
        slot.receivedInput = true;
        this.sessionIndex.invalidate();
        this.generation++;
        const runtime = await this.selectedSnapshot();
        slot.suppressEvents = false;
        this.emit({
          type: "session.replaced",
          sessionId: slot.id,
          sessionGeneration: this.generation,
          runtime,
        });
        return {
          commandId: input.commandId,
          sessionGeneration: this.generation,
          accepted: true,
        };
      } finally {
        slot.suppressEvents = false;
      }
    });
  }

  async rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const slot = this.selected();
      slot.lastActivityAt = Date.now();
      slot.suppressEvents = true;
      try {
        await slot.driver.rewindPrompt({ ...input, expectedGeneration: slot.innerGeneration });
        this.sessionIndex.invalidate();
        this.generation++;
        const runtime = await this.selectedSnapshot();
        slot.suppressEvents = false;
        this.emit({
          type: "session.replaced",
          sessionId: slot.id,
          sessionGeneration: this.generation,
          runtime,
        });
        return {
          commandId: input.commandId,
          sessionGeneration: this.generation,
          accepted: true,
        };
      } finally {
        slot.suppressEvents = false;
      }
    });
  }

  async abort(): Promise<void> {
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.abort();
  }

  async newSession(input: NewSessionInput = {}): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const parent = input.parentSessionId ? await this.sessionIndex.resolve(input.parentSessionId) : undefined;
      if (input.parentSessionId && !parent) throw new Error("parent session is unavailable");
      if (parent && this.registry().isSessionArchived(parent.id)) throw new Error("parent session is archived");
      const project = input.projectId ? this.registry().get(input.projectId) : undefined;
      if (input.projectId && (!project || project.archivedAt)) throw new Error("project is unavailable");
      const current = this.selected().driver.runtimeDetails();
      const draft = await this.createSlot({
        ...this.baseTarget(),
        cwd: project?.cwd ?? parent?.cwd ?? current.cwd,
        projectId: project?.id
          ?? (parent ? this.registry().projectForSession(parent.id, parent.cwd)?.id : undefined)
          ?? this.registry().projectForSession(current.sessionId, current.cwd)?.id,
        parentSessionPath: parent?.path ?? current.sessionPath,
        parentSessionId: parent?.id ?? current.sessionId,
      });
      let slot = draft;
      try {
        slot = await this.ensureDraftWorkspace(slot);
        this.sessionIndex.invalidate();
        const result = slot.provisional
          ? await this.commitProvisional(slot).then(() => this.replacement(false))
          : await this.select(slot);
        slot.checkoutProvisional = undefined;
        return result;
      } catch (error) {
        await this.rollbackProvisional(slot);
        if (this.slots.has(draft.id) && draft.id !== this.selectedId) {
          await this.registry().removeSessionWorkspace(draft.id).catch(() => {});
          await this.disposeSlot(draft).catch(() => {});
        }
        throw error;
      }
    });
  }

  async addProject(input: ProjectInput): Promise<ReplacementResult> {
    this.assertGeneration(input.expectedGeneration);
    if (this.pickerBusy) throw new Error("a directory picker is already open");
    this.pickerBusy = true;
    const abort = new AbortController();
    this.pickerAbort = abort;
    try {
      const directory = await (this.options.pickDirectory ?? ((signal) => pickProjectDirectory(process.platform, signal)))(abort.signal);
      if (!directory) return this.replacement(true);
      return this.withLifecycle(async () => {
        this.assertGeneration(input.expectedGeneration);
        const project = await this.registry().add(directory);
        const slot = await this.createSlot({ ...this.baseTarget(), cwd: project.cwd, projectId: project.id });
        this.sessionIndex.invalidate();
        const result = await this.select(slot);
        this.emitProjectsChanged();
        return result;
      });
    } finally {
      if (this.pickerAbort === abort) this.pickerAbort = undefined;
      this.pickerBusy = false;
    }
  }

  async removeProject(input: RemoveProjectInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      const project = registry.get(input.projectId);
      if (!project || project.archivedAt) throw new Error("project is unavailable");
      const projectSlots = [...this.slots.values()]
        .filter((slot) => this.projectIdForSlot(slot) === project.id);
      if (projectSlots.some((slot) => !this.slotCanSleep(slot))) {
        throw new Error("cannot remove a project with a running, queued, or attention session");
      }

      const sessions = (await SessionManager.listAll())
        .filter((session) => registry.projectForSession(session.id, session.cwd)?.id === project.id);
      if (projectSlots.some((slot) => slot.id === this.selectedId)) {
        const alternative = registry.list().find((candidate) => candidate.id !== project.id);
        const slot = alternative
          ? await this.slotForProject(alternative.id, alternative.cwd)
          : await this.createSlot({ ...this.baseTarget(), inMemory: true });
        await this.select(slot);
      }

      for (const slot of projectSlots) {
        if (this.slots.has(slot.id)) await this.disposeSlot(slot);
      }
      for (const session of sessions) {
        await unlink(session.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        const workspace = registry.workspaceForSession(session.id);
        if (workspace?.mode === "checkout" && workspace.commonDir && workspace.branch
          && workspace.parkedRoot && workspace.parkedCommonDir && workspace.parkedIndexTree && workspace.parkedWorktreeTree) {
          await restoreCheckoutState(project.cwd, {
            root: workspace.parkedRoot,
            commonDir: workspace.parkedCommonDir,
            head: workspace.parkedHead,
            headRef: workspace.parkedHeadRef,
            indexTree: workspace.parkedIndexTree,
            worktreeTree: workspace.parkedWorktreeTree,
          });
          await removeSessionBranch(project.cwd, workspace.branch, workspace.commonDir);
        } else if (workspace?.mode === "worktree" && workspace.worktreePath && workspace.commonDir && workspace.branch) {
          await removeSessionWorktree(project.cwd, {
            root: workspace.worktreePath,
            commonDir: workspace.commonDir,
            branch: workspace.branch,
          }, registry.worktreeRoot(project.id));
        }
        this.sessionIndex.remove(session.id);
        this.emitStatus(session.id, "sleeping");
      }
      await registry.remove(project.id, sessions.map((session) => session.id));
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async renameProject(input: RenameProjectInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    await this.registry().renameProject(input.projectId, input.name);
    this.sessionIndex.invalidate();
    this.emitProjectsChanged();
  }

  async reorderProject(input: ReorderProjectInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    await this.registry().reorderProject(input.projectId, input.beforeProjectId);
    this.sessionIndex.invalidate();
    this.emitProjectsChanged();
  }

  async archiveProject(input: ProjectArchiveInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      const project = registry.get(input.projectId);
      if (!project || project.archivedAt) throw new Error("project is unavailable");
      const projectSlots = [...this.slots.values()]
        .filter((slot) => this.projectIdForSlot(slot) === project.id);
      if (projectSlots.some((slot) => !this.slotCanSleep(slot))) {
        throw new Error("cannot archive a project with a running, queued, or attention session");
      }
      if (registry.listSessionWorkspaces().some((workspace) =>
        workspace.projectId === project.id && workspace.mode === "checkout")) {
        throw new Error("move the checkout-owning session back to its worktree before archiving this project");
      }
      if (projectSlots.some((slot) => slot.id === this.selectedId)) {
        const alternative = registry.list().find((candidate) => candidate.id !== project.id);
        const slot = alternative
          ? await this.slotForProject(alternative.id, alternative.cwd)
          : await this.createSlot({ ...this.baseTarget(), inMemory: true });
        await this.select(slot);
      }
      const projectSessionIds = (await SessionManager.listAll())
        .filter((session) => registry.projectForSession(session.id, session.cwd)?.id === project.id)
        .map((session) => session.id);
      await registry.archiveProject(project.id, projectSessionIds);
      await registry.deactivateSessions(projectSessionIds);
      for (const slot of projectSlots) {
        if (this.slots.has(slot.id)) await this.disposeSlot(slot);
      }
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async restoreProject(input: ProjectArchiveInput): Promise<void> {
    await this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const project = this.registry().get(input.projectId);
      if (!project?.archivedAt) throw new Error("archived project is unavailable");
      await this.registry().restoreProject(input.projectId);
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
    });
  }

  async updateProjectWorktreeSettings(input: ProjectWorktreeSettingsInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    await this.registry().updateWorktreeSettings(input.projectId, input.setupCommand);
    this.emitProjectsChanged();
  }

  async handoffSession(input: HandoffSessionInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const slot = this.selected();
      if (!this.slotCanSleep(slot)) throw new Error("session must be idle before moving its checkout");
      const registry = this.registry();
      const record = registry.workspaceForSession(slot.id);
      if (!record?.branch || !record.commonDir || !record.worktreePath
        || !record.baseline || !record.baselineTree) {
        throw new Error("only isolated sessions can move between checkouts");
      }
      if (record.mode === input.destination) return this.replacement(false);
      const project = registry.get(record.projectId);
      if (!project || project.archivedAt) throw new Error("project is unavailable");
      await slot.driver.timelineRelocationReady();
      this.invalidateWorkspaceInventory(slot);

      if (input.destination === "checkout") {
        const owner = registry.listSessionWorkspaces().find((item) =>
          item.projectId === project.id && item.mode === "checkout" && item.sessionId !== slot.id);
        if (owner) throw new Error("another session currently owns the project checkout");
        const parked = await captureCheckoutState(project.cwd, true);
        const session = await captureCheckoutState(record.worktreePath, true);
        await registry.writeHandoffJournal({
          version: 1,
          sessionId: slot.id,
          projectId: project.id,
          workspace: record,
          projectState: parked,
          sessionState: session,
        });
        try {
          await removeSessionWorktree(project.cwd, {
            root: record.worktreePath,
            commonDir: record.commonDir,
            branch: record.branch,
          }, registry.worktreeRoot(project.id), false);
          await restoreCheckoutState(project.cwd, session);
          await registry.setSessionWorkspace({
            ...record,
            mode: "checkout",
            parkedRoot: parked.root,
            parkedCommonDir: parked.commonDir,
            parkedHead: parked.head,
            parkedHeadRef: parked.headRef,
            parkedIndexTree: parked.indexTree,
            parkedWorktreeTree: parked.worktreeTree,
          });
          const previousId = slot.id;
          slot.suppressEvents = true;
          await slot.driver.rebindWorkspace(project.cwd);
          slot.suppressEvents = false;
          await registry.rekeySession(previousId, slot.id);
          slot.target.cwd = project.cwd;
          await registry.clearHandoffJournal();
        } catch (error) {
          slot.suppressEvents = false;
          await restoreCheckoutState(project.cwd, parked).catch(() => {});
          const recreated = await recreateSessionWorktree(
            project.cwd,
            record.worktreePath,
            registry.worktreeRoot(project.id),
            record.branch,
            record.commonDir,
          ).catch(() => undefined);
          if (recreated) await restoreCheckoutState(recreated, session).catch(() => {});
          if (recreated) {
            await registry.setSessionWorkspace(record).catch(() => {});
            await registry.clearHandoffJournal().catch(() => {});
          }
          throw error;
        }
      } else {
        if (!record.parkedRoot || !record.parkedCommonDir || !record.parkedIndexTree || !record.parkedWorktreeTree) {
          throw new Error("parked project checkout state is unavailable");
        }
        const session = await captureCheckoutState(project.cwd, true);
        const parked = {
          root: record.parkedRoot,
          commonDir: record.parkedCommonDir,
          head: record.parkedHead,
          headRef: record.parkedHeadRef,
          indexTree: record.parkedIndexTree,
          worktreeTree: record.parkedWorktreeTree,
        };
        await registry.writeHandoffJournal({
          version: 1,
          sessionId: slot.id,
          projectId: project.id,
          workspace: record,
          projectState: parked,
          sessionState: session,
        });
        let recreated: string | undefined;
        try {
          await restoreCheckoutState(project.cwd, parked);
          recreated = await recreateSessionWorktree(
            project.cwd,
            record.worktreePath,
            registry.worktreeRoot(project.id),
            record.branch,
            record.commonDir,
          );
          await restoreCheckoutState(recreated, session);
          await registry.setSessionWorkspace({
            sessionId: record.sessionId,
            projectId: record.projectId,
            mode: "worktree",
            worktreePath: recreated,
            commonDir: record.commonDir,
            branch: record.branch,
            baseline: record.baseline,
            baselineTree: record.baselineTree,
          });
          const previousId = slot.id;
          slot.suppressEvents = true;
          await slot.driver.rebindWorkspace(recreated);
          slot.suppressEvents = false;
          await registry.rekeySession(previousId, slot.id);
          slot.target.cwd = recreated;
          await registry.clearHandoffJournal();
        } catch (error) {
          slot.suppressEvents = false;
          if (recreated) {
            await removeSessionWorktree(project.cwd, {
              root: recreated,
              commonDir: record.commonDir,
              branch: record.branch,
            }, registry.worktreeRoot(project.id), false).catch(() => {});
          }
          await restoreCheckoutState(project.cwd, session).catch(() => {});
          await registry.setSessionWorkspace(record).catch(() => {});
          await registry.clearHandoffJournal().catch(() => {});
          throw error;
        }
      }
      slot.suppressEvents = false;
      slot.innerGeneration = slot.driver.runtimeDetails().generation;
      this.generation++;
      this.invalidateWorkspaceInventory(slot);
      await this.refreshWorkspace(slot, false);
      const runtime = await this.selectedSnapshot();
      this.emit({ type: "session.replaced", sessionId: slot.id, sessionGeneration: this.generation, runtime });
      this.sessionIndex.invalidate();
      return this.replacement(false);
    });
  }

  async applySessionChanges(input: ApplySessionChangesInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const slot = this.selected();
      await this.applySlotChanges(slot, input.expectedRevision);
      return this.replacement(false);
    });
  }

  async archiveSession(input: SessionArchiveInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      if (registry.isSessionArchived(input.sessionId)) throw new Error("session is already archived");
      const session = await this.sessionIndex.resolve(input.sessionId);
      if (!session) throw new Error("session is unavailable");
      const project = registry.projectForSession(session.id, session.cwd);
      if (!project || project.archivedAt) throw new Error("session project is unavailable");
      const awake = this.slots.get(input.sessionId);
      if (registry.workspaceForSession(input.sessionId)?.mode === "checkout") {
        throw new Error("move this session back to its worktree before archiving it");
      }
      if (awake && !this.slotCanSleep(awake)) throw new Error("cannot archive a running, queued, or attention session");
      if (input.sessionId === this.selectedId) {
        const replacement = await this.createSlot({ ...this.baseTarget(), cwd: project.cwd, projectId: project.id });
        await this.select(replacement);
      }
      await registry.archiveSession(input.sessionId);
      await registry.deactivateSession(input.sessionId);
      if (awake && this.slots.has(awake.id)) await this.disposeSlot(awake);
      this.sessionIndex.invalidate();
      this.emitStatus(input.sessionId, "sleeping");
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async restoreSession(input: SessionArchiveInput): Promise<void> {
    await this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      if (!registry.isSessionArchived(input.sessionId)) throw new Error("archived session is unavailable");
      const session = await this.sessionIndex.resolve(input.sessionId);
      if (!session) throw new Error("archived session is unavailable");
      if (registry.projectForSession(session.id, session.cwd)?.archivedAt) throw new Error("restore the project before restoring this session");
      await registry.restoreSession(input.sessionId);
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
    });
  }

  async switchSession(input: SwitchSessionInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      if (this.registry().isSessionArchived(input.sessionId)) throw new Error("session is archived");
      if (input.sessionId === this.selectedId) return this.replacement(false);
      const awake = this.slots.get(input.sessionId);
      if (awake) return this.select(awake);
      const session = await this.sessionIndex.resolve(input.sessionId);
      if (!session) throw new Error("session is unavailable");
      const slot = await this.createSlot({
        ...this.baseTarget(),
        cwd: this.registry().effectiveCwd(session.id, session.cwd),
        sessionPath: session.path,
        projectId: this.registry().projectForSession(session.id, session.cwd)?.id,
      });
      try {
        return await this.select(slot);
      } catch (error) {
        await this.disposeSlot(slot).catch(() => undefined);
        throw error;
      }
    });
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before deleting it");
    if (input.sessionId === this.selectedId) throw new Error("cannot delete the currently active session");
    const awake = this.slots.get(input.sessionId);
    if (awake) {
      if (!this.slotCanSleep(awake)) throw new Error("cannot delete a running or queued session");
      await this.disposeSlot(awake);
    }
    const selected = this.selected();
    await selected.driver.deleteSession({ sessionId: input.sessionId });
    const record = this.registry().workspaceForSession(input.sessionId);
    const project = record ? this.registry().get(record.projectId) : undefined;
    if (record?.mode === "checkout" && project && record.commonDir && record.branch
      && record.parkedRoot && record.parkedCommonDir && record.parkedIndexTree && record.parkedWorktreeTree) {
      await restoreCheckoutState(project.cwd, {
        root: record.parkedRoot,
        commonDir: record.parkedCommonDir,
        head: record.parkedHead,
        headRef: record.parkedHeadRef,
        indexTree: record.parkedIndexTree,
        worktreeTree: record.parkedWorktreeTree,
      });
      await removeSessionBranch(project.cwd, record.branch, record.commonDir);
    } else if (record?.mode === "worktree" && project && record.worktreePath && record.commonDir && record.branch) {
      await removeSessionWorktree(project.cwd, {
        root: record.worktreePath,
        commonDir: record.commonDir,
        branch: record.branch,
      }, this.registry().worktreeRoot(project.id));
    }
    await this.registry().removeSessionWorkspace(input.sessionId);
    await this.registry().removeSessionPolicy(input.sessionId);
    await this.registry().unpinSession(input.sessionId);
    await this.registry().deactivateSession(input.sessionId);
    this.sessionIndex.remove(input.sessionId);
    this.emitStatus(input.sessionId, "sleeping");
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before renaming it");
    const slot = this.slots.get(input.sessionId);
    if (slot) slot.lastActivityAt = Date.now();
    await (slot ?? this.selected()).driver.renameSession(input);
    this.sessionIndex.invalidate();
  }

  setSessionActive(input: SetSessionActiveInput): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before activating it");
      const awake = this.slots.get(input.sessionId);
      if (input.active) {
        if (awake) {
          await this.registry().activateSession(input.sessionId);
          awake.receivedInput = true;
          awake.lastActivityAt = Date.now();
          this.sessionIndex.invalidate();
          this.emitProjectsChanged();
          return;
        }
        const session = await this.sessionIndex.resolve(input.sessionId);
        if (!session) throw new Error("session is unavailable");
        const slot = await this.createSlot({
          ...this.baseTarget(),
          cwd: this.registry().effectiveCwd(session.id, session.cwd),
          sessionPath: session.path,
          projectId: this.registry().projectForSession(session.id, session.cwd)?.id,
        });
        slot.receivedInput = true;
        await this.registry().activateSession(input.sessionId);
        this.sessionIndex.invalidate();
        this.emitStatus(slot.id, slot.driver.runtimeState());
        this.emitProjectsChanged();
        return;
      }
      if (input.sessionId === this.selectedId) throw new Error("cannot deactivate the selected session");
      if (this.registry().isSessionPinned(input.sessionId)) throw new Error("unpin before deactivating");
      if (!awake) {
        await this.registry().deactivateSession(input.sessionId);
        this.sessionIndex.invalidate();
        this.emitProjectsChanged();
        return;
      }
      if (!this.slotCanSleep(awake)) throw new Error("cannot deactivate a running or queued session");
      await this.registry().deactivateSession(input.sessionId);
      await this.disposeSlot(awake);
      this.emitStatus(input.sessionId, "sleeping");
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
    });
  }

  async setSessionPinned(input: SetSessionPinnedInput): Promise<void> {
    return this.withLifecycle(async () => {
      const registry = this.registry();
      if (!input.pinned) {
        await registry.unpinSession(input.sessionId);
        const slot = this.slots.get(input.sessionId);
        if (slot) {
          slot.pinned = false;
          slot.lastActivityAt = Date.now();
        }
        this.sessionIndex.invalidate();
        this.emitProjectsChanged();
        return;
      }
      if (registry.isSessionArchived(input.sessionId)) throw new Error("restore the session before pinning it");
      const awake = this.slots.get(input.sessionId);
      const wasPinned = registry.isSessionPinned(input.sessionId);
      let slot = awake;
      let created = false;
      try {
        if (!slot) {
          const session = await this.sessionIndex.resolve(input.sessionId);
          if (!session) throw new Error("session is unavailable");
          const project = registry.projectForSession(session.id, session.cwd);
          if (!project || project.archivedAt) throw new Error("session project is unavailable");
          slot = await this.createSlot({
            ...this.baseTarget(),
            cwd: registry.effectiveCwd(session.id, session.cwd),
            sessionPath: session.path,
            projectId: project.id,
          });
          created = true;
        }
        await registry.pinSession(slot.id);
        slot.pinned = true;
        slot.lastActivityAt = Date.now();
        await registry.activateSession(slot.id);
      } catch (error) {
        if (!wasPinned) await registry.unpinSession(slot?.id ?? input.sessionId).catch(() => undefined);
        if (created && slot && this.slots.has(slot.id)) await this.disposeSlot(slot).catch(() => undefined);
        throw error;
      }
      this.sessionIndex.invalidate();
      this.emitStatus(slot.id, slot.driver.runtimeState());
      this.emitProjectsChanged();
    });
  }

  async reorderActiveSession(input: ReorderActiveSessionInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const active = await this.listSessions();
    if (!active.activeSessions.some((session) => session.id === input.sessionId)) {
      throw new Error("active session is unavailable");
    }
    if (input.beforeSessionId && !active.activeSessions.some((session) => session.id === input.beforeSessionId)) {
      throw new Error("active session reorder target is unavailable");
    }
    await this.registry().reorderActiveSession(input.sessionId, input.beforeSessionId);
    this.sessionIndex.invalidate();
    this.emitProjectsChanged();
  }

  async fork(input: ForkInput): Promise<ReplacementResult> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    const previousId = slot.id;
    slot.lastActivityAt = Date.now();
    const forked = await slot.driver.fork({ ...input, expectedGeneration: slot.innerGeneration });
    if (forked.cancelled) return this.replacement(true);
    slot.lastActivityAt = Date.now();
    slot.receivedInput = true;
    if (slot.id !== previousId) {
      await this.registry().deactivateSession(previousId);
      await this.registry().activateSession(slot.id);
    }
    this.sessionIndex.invalidate();
    this.emitProjectsChanged();
    return this.replacement(false);
  }

  async updateRuntimePolicy(input: UpdateRuntimePolicyInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const selected = this.selected();
    const projectId = this.projectIdForSlot(selected);
    if (!projectId) throw new Error("runtime policy requires a registered project");
    const affected = input.scope === "global"
      ? [...this.slots.values()].filter((slot) => Boolean(this.projectIdForSlot(slot)))
      : input.scope === "project"
        ? [...this.slots.values()].filter((slot) => this.projectIdForSlot(slot) === projectId)
        : [selected];
    if (affected.some((slot) => !this.slotCanSleep(slot))) {
      throw new Error("runtime policy can only change while affected sessions are idle");
    }
    const previous = this.registry().runtimePolicy(projectId, selected.id);
    await this.registry().updateRuntimePolicy({
      scope: input.scope,
      projectId,
      sessionId: selected.id,
      verify: input.verify,
      timeline: input.timeline,
      workspace: input.workspace,
      guardTimeoutSeconds: input.guardTimeoutSeconds,
      clarifyTimeoutSeconds: input.clarifyTimeoutSeconds,
      expectedRevision: input.expectedRevision,
    });
    try {
      if (input.scope === "session") {
        await this.applySelectedWorkspacePolicy(input.expectedGeneration);
      }
    } catch (error) {
      await this.registry().updateRuntimePolicy({
        scope: "session",
        projectId,
        sessionId: selected.id,
        verify: previous.session.verify ?? { mode: "inherit" },
        timeline: previous.session.timelineEnabled === undefined
          ? "inherit"
          : previous.session.timelineEnabled ? "enabled" : "disabled",
        workspace: previous.session.workspace ?? "inherit",
        guardTimeoutSeconds: previous.session.guardTimeoutSeconds === undefined ? "inherit" : previous.session.guardTimeoutSeconds,
        clarifyTimeoutSeconds: previous.session.clarifyTimeoutSeconds === undefined ? "inherit" : previous.session.clarifyTimeoutSeconds,
        expectedRevision: this.registry().runtimePolicy(projectId, selected.id).revision,
      }).catch(() => {});
      throw error;
    }
    for (const slot of affected) {
      const current = await slot.driver.snapshot();
      const slotProjectId = this.projectIdForSlot(slot);
      if (!slotProjectId) continue;
      const policy = this.registry().runtimePolicy(slotProjectId, slot.id);
      policy.availableVerifyChecks = current.runtimePolicy.availableVerifyChecks.map((check) => ({ ...check }));
      slot.driver.applyRuntimePolicy(policy);
    }
    this.emit({
      type: "session.event",
      sessionId: selected.id,
      sessionGeneration: this.generation,
      payload: { type: "runtime_policy_changed" },
    });
  }

  async setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      for (const slot of this.slots.values()) {
        if (!this.slotCanSleep(slot)) throw new Error("packages can only change while every session is idle");
      }
      const selected = this.selected();
      await selected.driver.setPackageEnabled(input);
      for (const slot of [...this.slots.values()]) {
        if (slot.id !== this.selectedId) {
          await this.registry().deactivateSession(slot.id);
          await this.disposeSlot(slot);
        }
      }
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      for (const slot of this.slots.values()) {
        if (!this.slotCanSleep(slot)) throw new Error("packages can only change while every session is idle");
      }
      const selected = this.selected();
      await selected.driver.updatePackageSettings(input);
      for (const slot of [...this.slots.values()]) {
        if (slot.id !== this.selectedId) {
          await this.registry().deactivateSession(slot.id);
          await this.disposeSlot(slot);
        }
      }
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async rebuildDiscoverIndex(): Promise<void> {
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.rebuildDiscoverIndex();
  }

  async setModel(input: SetModelInput): Promise<void> {
    await this.selected().driver.setModel(input);
  }

  setThinkingLevel(input: SetThinkingLevelInput): void {
    this.selected().driver.setThinkingLevel(input);
  }

  async setSessionControls(input: SetSessionControlsInput): Promise<void> {
    const slot = this.selected();
    const model = slot.driver.validateSessionControls(input);
    if (!slot.driver.hasActiveAgentRun()) {
      slot.pendingControls = undefined;
      await slot.driver.setSessionControls(input);
      return;
    }
    const current = (await slot.driver.snapshot()).sessionControls;
    const unchanged = current.model?.provider === input.provider
      && current.model.id === input.modelId
      && current.thinkingLevel === input.thinkingLevel;
    slot.pendingControls = unchanged ? undefined : { input: { ...input }, model };
  }

  async startProviderLogin(input: StartProviderLoginInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    await slot.driver.startProviderLogin({ ...input, expectedGeneration: slot.innerGeneration });
  }

  async cancelProviderLogin(expectedGeneration: number): Promise<void> {
    this.assertGeneration(expectedGeneration);
    const slot = this.selected();
    await slot.driver.cancelProviderLogin(slot.innerGeneration);
  }

  async logoutProvider(provider: string, expectedGeneration: number): Promise<void> {
    this.assertGeneration(expectedGeneration);
    const slot = this.selected();
    await slot.driver.logoutProvider(provider, slot.innerGeneration);
  }

  async updateContinuityMemory(input: UpdateContinuityMemoryInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.updateContinuityMemory({ ...input, expectedGeneration: slot.innerGeneration });
  }

  async deleteContinuityMemory(input: DeleteContinuityMemoryInput): Promise<void> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.deleteContinuityMemory({ ...input, expectedGeneration: slot.innerGeneration });
  }

  async answerUiRequest(input: UiResponse): Promise<void> {
    const slot = this.selected();
    await slot.driver.answerUiRequest({ ...input, sessionGeneration: slot.innerGeneration });
  }

  keepUiRequestAlive(requestId: string, sessionGeneration: number): string | undefined {
    this.assertGeneration(sessionGeneration);
    const slot = this.selected();
    return slot.driver.keepUiRequestAlive(requestId, slot.innerGeneration);
  }

  dismissCommandResult(resultId: string, sessionGeneration: number): void {
    this.assertGeneration(sessionGeneration);
    const slot = this.selected();
    slot.driver.dismissCommandResult(resultId, slot.innerGeneration);
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pickerAbort?.abort();
    this.pickerAbort = undefined;
    this.setupAbort?.abort();
    this.setupAbort = undefined;
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    for (const slot of [...this.slots.values()]) await this.disposeSlot(slot);
    this.listeners.clear();
    this.workspaceInventories.clear();
  }

  private async createSlot(target: RuntimeTarget): Promise<RuntimeSlot> {
    const driver = new SessionRuntime({ ...this.options, modelRuntime: this.modelRuntime, projectRegistry: this.registry() });
    const handle = await driver.start(target);
    const slot: RuntimeSlot = {
      id: handle.sessionId,
      driver,
      target,
      innerGeneration: handle.sessionGeneration,
      lastActivityAt: Date.now(),
      receivedInput: false,
      pinned: this.registry().isSessionPinned(handle.sessionId),
      lastState: driver.runtimeState(),
      nativeQueue: { steering: 0, followUp: 0 },
      unsubscribe: () => undefined,
    };
    driver.setWorkspaceApplyHandler((request) => this.handleWorkspaceApplyTool(slot, request));
    slot.unsubscribe = driver.subscribe((event) => this.onSlotEvent(slot, event));
    this.slots.set(slot.id, slot);
    return slot;
  }

  private async ensureDraftWorkspace(slot: RuntimeSlot): Promise<RuntimeSlot> {
    const details = slot.driver.runtimeDetails();
    const registry = this.registry();
    const existing = registry.workspaceForSession(slot.id);
    if (existing || details.userMessageCount > 0 || slot.target.inMemory) return slot;
    const project = slot.target.projectId
      ? registry.get(slot.target.projectId)
      : registry.projectForSession(slot.id, details.cwd);
    if (!project || project.archivedAt) return slot;
    const destination = registry.runtimePolicy(project.id, slot.id).effective.workspace;
    const checkoutOwner = this.checkoutOwner(project.id, slot.id);
    if (destination === "local") {
      await registry.setSessionWorkspace({ sessionId: slot.id, projectId: project.id, mode: "local" });
      return slot;
    }
    if (destination === "checkout" && checkoutOwner) {
      throw new Error("another session currently owns the project folder; use Local or Worktree");
    }
    const gitWorkspace = await inspectGitWorkspace(details.cwd);
    if (!gitWorkspace) {
      await registry.setSessionWorkspace({
        sessionId: slot.id,
        projectId: project.id,
        mode: "local",
      });
      return slot;
    }

    const controls = (await slot.driver.snapshot()).sessionControls;
    const opaqueId = randomUUID().replaceAll("-", "");
    const ownedRoot = registry.worktreeRoot(project.id);
    const targetPath = resolve(ownedRoot, opaqueId);
    if (destination === "checkout") {
      const checkout = await claimSessionCheckout(project.cwd, opaqueId);
      await registry.setSessionWorkspace({
        sessionId: slot.id,
        projectId: project.id,
        mode: "checkout",
        worktreePath: targetPath,
        commonDir: checkout.commonDir,
        branch: checkout.branch,
        baseline: checkout.baseline,
        baselineTree: checkout.baselineTree,
        parkedRoot: checkout.parked.root,
        parkedCommonDir: checkout.parked.commonDir,
        parkedHead: checkout.parked.head,
        parkedHeadRef: checkout.parked.headRef,
        parkedIndexTree: checkout.parked.indexTree,
        parkedWorktreeTree: checkout.parked.worktreeTree,
      });
      slot.checkoutProvisional = {
        projectId: project.id,
        branch: checkout.branch,
        commonDir: checkout.commonDir,
        parked: checkout.parked,
      };
      return slot;
    }
    const source = await this.projectBaselineState(project.id);
    await registry.writeProvisionJournal({
      version: 1,
      projectId: project.id,
      worktreePath: targetPath,
      commonDir: gitWorkspace.commonDir,
      branch: sessionWorktreeBranch(opaqueId),
    });
    const worktree = await createSessionWorktreeFromState(project.cwd, source, targetPath, ownedRoot, opaqueId)
      .catch(async (error) => {
        await registry.clearProvisionJournal().catch(() => {});
        throw error;
      });
    let next: RuntimeSlot | undefined;
    try {
      slot.setupState = project.setupCommand ? "running" : "idle";
      const setupAbort = new AbortController();
      this.setupAbort = setupAbort;
      try {
        await runSetupCommand(worktree.root, project.setupCommand ?? "", setupAbort.signal);
      } finally {
        if (this.setupAbort === setupAbort) this.setupAbort = undefined;
      }
      next = await this.createSlot({
        ...this.baseTarget(),
        cwd: worktree.root,
        projectId: project.id,
      });
      next.setupState = "idle";
      if (controls.model && controls.thinkingLevel) {
        await next.driver.setSessionControls({
          provider: controls.model.provider,
          modelId: controls.model.id,
          thinkingLevel: controls.thinkingLevel,
        });
      }
      await registry.setSessionWorkspace({
        sessionId: next.id,
        projectId: project.id,
        mode: "worktree",
        worktreePath: worktree.root,
        commonDir: worktree.commonDir,
        branch: worktree.branch,
        baseline: worktree.baseline,
        baselineTree: worktree.baselineTree,
      });
      await registry.clearProvisionJournal();
      next.provisional = {
        previous: slot,
        projectId: project.id,
        worktree: {
          root: worktree.root,
          commonDir: worktree.commonDir,
          branch: worktree.branch,
        },
        oldSessionPath: details.sessionPath,
      };
      return next;
    } catch (error) {
      if (next) await this.disposeSlot(next).catch(() => {});
      if (next) await registry.removeSessionWorkspace(next.id).catch(() => {});
      await removeSessionWorktree(details.cwd, worktree, ownedRoot).catch(() => {});
      await registry.clearProvisionJournal().catch(() => {});
      slot.setupState = "failed";
      slot.setupError = error instanceof Error ? error.message.slice(0, 500) : "worktree setup failed";
      throw error;
    }
  }

  private async messageCommand(kind: "prompt" | "steer" | "followUp", input: PromptInput): Promise<AcceptedCommand> {
    this.assertGeneration(input.expectedGeneration);
    const slot = kind === "prompt"
      ? await this.ensureDraftWorkspace(this.selected())
      : this.selected();
    this.assertCheckoutAvailable(slot);
    const wasActive = slot.receivedInput || slot.pinned;
    slot.lastActivityAt = Date.now();
    try {
      await slot.driver[kind]({ ...input, expectedGeneration: slot.innerGeneration });
    } catch (error) {
      await this.rollbackProvisional(slot);
      throw error;
    }
    await this.commitProvisional(slot);
    slot.checkoutProvisional = undefined;
    slot.receivedInput = true;
    if (!wasActive) {
      await this.registry().activateSession(slot.id).catch(() => undefined);
      this.emitProjectsChanged();
    }
    this.sessionIndex.invalidate();
    return { commandId: input.commandId, sessionGeneration: this.generation, accepted: true };
  }

  private async commitProvisional(slot: RuntimeSlot): Promise<void> {
    const provisional = slot.provisional;
    if (!provisional) return;
    await this.select(slot);
    slot.provisional = undefined;
    await this.disposeSlot(provisional.previous);
    if (provisional.oldSessionPath) await unlink(provisional.oldSessionPath).catch(() => {});
    this.sessionIndex.invalidate();
    this.emitProjectsChanged();
  }

  private async rollbackProvisional(slot: RuntimeSlot): Promise<void> {
    const checkout = slot.checkoutProvisional;
    if (checkout) {
      slot.checkoutProvisional = undefined;
      const project = this.registry().get(checkout.projectId);
      if (project) {
        await restoreCheckoutState(project.cwd, checkout.parked).catch(() => {});
        await removeSessionBranch(project.cwd, checkout.branch, checkout.commonDir).catch(() => {});
      }
      await this.registry().removeSessionWorkspace(slot.id).catch(() => {});
    }
    const provisional = slot.provisional;
    if (!provisional) return;
    slot.provisional = undefined;
    await this.disposeSlot(slot).catch(() => {});
    await this.registry().removeSessionWorkspace(slot.id).catch(() => {});
    const project = this.registry().get(provisional.projectId);
    if (project) {
      await removeSessionWorktree(project.cwd, provisional.worktree, this.registry().worktreeRoot(project.id)).catch(() => {});
    }
  }

  private checkoutOwner(projectId: string, excludeSessionId?: string) {
    return this.registry().listSessionWorkspaces().find((item) =>
      item.projectId === projectId && item.mode === "checkout" && item.sessionId !== excludeSessionId);
  }

  private async projectBaselineState(projectId: string): Promise<CheckoutState> {
    const registry = this.registry();
    const project = registry.get(projectId);
    if (!project) throw new Error("project is unavailable");
    const owner = this.checkoutOwner(projectId);
    if (owner?.parkedRoot && owner.parkedCommonDir && owner.parkedIndexTree && owner.parkedWorktreeTree) {
      return {
        root: owner.parkedRoot,
        commonDir: owner.parkedCommonDir,
        head: owner.parkedHead,
        headRef: owner.parkedHeadRef,
        indexTree: owner.parkedIndexTree,
        worktreeTree: owner.parkedWorktreeTree,
      };
    }
    return captureCheckoutState(project.cwd, true);
  }

  private async applySlotChanges(slot: RuntimeSlot, expectedRevision: string): Promise<void> {
    if (!slot.driver.canSleep()) throw new Error("session must be idle before applying changes");
    const registry = this.registry();
    const record = registry.workspaceForSession(slot.id);
    if (!record || (record.mode !== "worktree" && record.mode !== "checkout")
      || !record.baselineTree || !record.commonDir || !record.branch) {
      throw new Error("only Project folder and Session worktree sessions can apply changes");
    }
    const project = registry.get(record.projectId);
    if (!project || project.archivedAt) throw new Error("project is unavailable");
    const owner = this.checkoutOwner(project.id, slot.id);
    if (record.mode === "worktree" && owner) {
      throw new Error("another session currently owns the project folder");
    }
    const runningLocal = [...this.slots.values()].find((candidate) =>
      candidate !== slot
      && candidate.target.projectId === project.id
      && registry.workspaceForSession(candidate.id)?.mode === "local"
      && candidate.driver.runtimeState() !== "idle");
    if (runningLocal) throw new Error("another Local session is currently using the project folder");

    const source = await captureCheckoutState(slot.driver.runtimeDetails().cwd, true);
    const sourceChanges = await inspectWorkspaceChanges(source.root, record.baselineTree);
    if (sourceChanges.revision !== expectedRevision) throw new Error("session changes changed before they could be applied");
    if (!sourceChanges.files.length) throw new Error("this session has no changes to apply");

    const target: CheckoutState = record.mode === "checkout"
      ? this.parkedCheckout(record)
      : await captureCheckoutState(project.cwd, true);
    const targetBranch = branchLabel(target.headRef);
    if (!targetBranch) throw new Error("the target project checkout is not on a branch");
    slot.applyState = "applying";
    await this.publishWorkspaceState(slot);

    try {
      const merged = await mergeWorkspaceChanges(project.cwd, record.baselineTree, target, source);
      if (merged.state === "conflict") {
        slot.lastApply = {
          state: "conflict",
          targetBranch,
          conflicts: merged.conflicts.map((item) => item.path),
          message: "Both workspaces were left unchanged.",
        };
        throw new WorkspaceApplyConflictError(merged.conflicts);
      }

      const currentSource = await captureCheckoutState(source.root, true);
      if (!sameCheckout(source, currentSource)) throw new Error("session changes changed while applying");
      if (record.mode === "worktree") {
        const currentTarget = await captureCheckoutState(project.cwd, true);
        if (!sameCheckout(target, currentTarget)) throw new Error("project folder changed while applying");
        await registry.writeApplyJournal({
          version: 1,
          sessionId: slot.id,
          projectId: project.id,
          mode: "worktree",
          workspace: record,
          targetState: target,
          sourceState: source,
          mergedState: merged.checkout,
        });
        try {
          await restoreCheckoutState(project.cwd, merged.checkout);
          await registry.clearApplyJournal();
        } catch (error) {
          const restored = await restoreCheckoutState(project.cwd, target).then(() => true, () => false);
          if (restored) await registry.clearApplyJournal().catch(() => {});
          throw error;
        }
      } else {
        await slot.driver.timelineRelocationReady();
        const snapshot = await snapshotSessionBranch(project.cwd, record.branch, record.commonDir, source.worktreeTree);
        const recovery = { ...source, head: snapshot };
        await registry.writeApplyJournal({
          version: 1,
          sessionId: slot.id,
          projectId: project.id,
          mode: "checkout",
          workspace: record,
          targetState: target,
          sourceState: recovery,
          mergedState: merged.checkout,
        });
        try {
          await restoreCheckoutState(project.cwd, merged.checkout);
          await registry.setSessionWorkspace({
            sessionId: slot.id,
            projectId: project.id,
            mode: "local",
            commonDir: record.commonDir,
            branch: record.branch,
            baseline: record.baseline,
            baselineTree: record.baselineTree,
          });
          slot.driver.workspaceApplied();
          await registry.clearApplyJournal();
        } catch (error) {
          const restored = await restoreCheckoutState(project.cwd, recovery).then(() => true, () => false);
          if (restored) {
            await registry.setSessionWorkspace(record).catch(() => {});
            await registry.clearApplyJournal().catch(() => {});
          }
          throw error;
        }
      }

      slot.lastApply = {
        state: merged.state,
        targetBranch,
        message: merged.state === "unchanged"
          ? "These session changes were already present."
          : "Changes were applied to the working tree without staging or committing them.",
      };
      this.invalidateProjectWorkspaceInventories(project.id);
      if (record.mode === "checkout" && slot.id === this.selectedId) {
        this.generation++;
        await this.refreshWorkspace(slot, false);
        this.emit({
          type: "session.replaced",
          sessionId: slot.id,
          sessionGeneration: this.generation,
          runtime: await this.snapshotFor(slot),
        });
      }
    } catch (error) {
      if (!(error instanceof WorkspaceApplyConflictError)) {
        slot.lastApply = {
          state: "error",
          targetBranch,
          message: error instanceof Error ? error.message.slice(0, 500) : "Could not apply session changes.",
        };
      }
      throw error;
    } finally {
      slot.applyState = undefined;
      await this.publishWorkspaceState(slot);
    }
  }

  private async handleWorkspaceApplyTool(
    slot: RuntimeSlot,
    request: { type: "inspect" } | { type: "schedule"; revision: string },
  ) {
    if (request.type === "schedule") {
      if (slot.pendingApply) throw new Error("session changes are already scheduled for application");
      const info = await this.workspaceApplyToolInfo(slot);
      if (!info.available || info.revision !== request.revision) {
        throw new Error(info.reason ?? "session changes changed before approval completed");
      }
      slot.pendingApply = { revision: request.revision };
      slot.applyState = "pending";
      await this.publishWorkspaceState(slot);
      return;
    }
    return this.workspaceApplyToolInfo(slot);
  }

  private async workspaceApplyToolInfo(slot: RuntimeSlot) {
    const record = this.registry().workspaceForSession(slot.id);
    if (!record || (record.mode !== "checkout" && record.mode !== "worktree")
      || !record.baselineTree || !record.commonDir) {
      return { available: false, reason: "Only Project folder and Session worktree sessions can apply changes." };
    }
    const project = this.registry().get(record.projectId);
    if (!project || project.archivedAt) return { available: false, reason: "The project is unavailable." };
    if (record.mode === "worktree" && this.checkoutOwner(project.id, slot.id)) {
      return { available: false, reason: "Another session currently owns the project folder." };
    }
    const source = await inspectWorkspaceChanges(slot.driver.runtimeDetails().cwd, record.baselineTree);
    if (!source.files.length) return { available: false, reason: "This session has no changes to apply." };
    const targetBranch = record.mode === "checkout"
      ? branchLabel(record.parkedHeadRef)
      : branchLabel((await inspectGitWorkspace(project.cwd))?.headRef);
    if (!targetBranch) return { available: false, reason: "The target project checkout is not on a branch." };
    return {
      available: true,
      targetBranch,
      changedCount: source.files.length,
      revision: source.revision,
      mode: record.mode,
    } as const;
  }

  private parkedCheckout(record: NonNullable<ReturnType<ProjectRegistry["workspaceForSession"]>>): CheckoutState {
    if (!record.parkedRoot || !record.parkedCommonDir || !record.parkedIndexTree || !record.parkedWorktreeTree) {
      throw new Error("parked project-folder state is unavailable");
    }
    return {
      root: record.parkedRoot,
      commonDir: record.parkedCommonDir,
      head: record.parkedHead,
      headRef: record.parkedHeadRef,
      indexTree: record.parkedIndexTree,
      worktreeTree: record.parkedWorktreeTree,
    };
  }

  private async publishWorkspaceState(slot: RuntimeSlot): Promise<void> {
    await this.refreshWorkspace(slot, slot.id === this.selectedId);
  }

  private invalidateProjectWorkspaceInventories(projectId: string): void {
    for (const candidate of this.slots.values()) {
      if (candidate.target.projectId === projectId) this.invalidateWorkspaceInventory(candidate);
    }
  }

  private async applySelectedWorkspacePolicy(expectedGeneration: number): Promise<void> {
    const slot = this.selected();
    const details = slot.driver.runtimeDetails();
    const projectId = this.projectIdForSlot(slot);
    if (!projectId || details.userMessageCount === 0) return;
    const record = this.registry().workspaceForSession(slot.id);
    const destination = this.registry().runtimePolicy(projectId, slot.id).effective.workspace;
    if (record?.mode === destination) return;
    if (destination === "local") {
      await this.moveSelectedToLocal(slot, projectId, record);
      return;
    }
    if (record?.mode === "local" || !record) {
      await this.moveSelectedFromLocal(slot, projectId, destination);
      return;
    }
    await this.handoffSession({
      destination,
      expectedGeneration,
    });
  }

  private async moveSelectedFromLocal(
    slot: RuntimeSlot,
    projectId: string,
    destination: "checkout" | "worktree",
  ): Promise<void> {
    const registry = this.registry();
    const project = registry.get(projectId);
    if (!project) throw new Error("project is unavailable");
    if (destination === "checkout" && this.checkoutOwner(projectId, slot.id)) {
      throw new Error("another session currently owns the project folder");
    }
    const opaqueId = randomUUID().replaceAll("-", "");
    const targetPath = resolve(registry.worktreeRoot(projectId), opaqueId);
    if (destination === "checkout") {
      const checkout = await claimSessionCheckout(project.cwd, opaqueId);
      await registry.setSessionWorkspace({
        sessionId: slot.id,
        projectId,
        mode: "checkout",
        worktreePath: targetPath,
        commonDir: checkout.commonDir,
        branch: checkout.branch,
        baseline: checkout.baseline,
        baselineTree: checkout.baselineTree,
        parkedRoot: checkout.parked.root,
        parkedCommonDir: checkout.parked.commonDir,
        parkedHead: checkout.parked.head,
        parkedHeadRef: checkout.parked.headRef,
        parkedIndexTree: checkout.parked.indexTree,
        parkedWorktreeTree: checkout.parked.worktreeTree,
      });
      await this.refreshWorkspace(slot, true);
      return;
    }
    const source = await captureCheckoutState(project.cwd, true);
    const worktree = await createSessionWorktreeFromState(
      project.cwd,
      source,
      targetPath,
      registry.worktreeRoot(projectId),
      opaqueId,
    );
    try {
      await runSetupCommand(worktree.root, project.setupCommand ?? "");
      await registry.setSessionWorkspace({
        sessionId: slot.id,
        projectId,
        mode: "worktree",
        worktreePath: worktree.root,
        commonDir: worktree.commonDir,
        branch: worktree.branch,
        baseline: worktree.baseline,
        baselineTree: worktree.baselineTree,
      });
      const previousId = slot.id;
      slot.suppressEvents = true;
      await slot.driver.rebindWorkspace(worktree.root);
      slot.suppressEvents = false;
      await registry.rekeySession(previousId, slot.id);
      slot.target.cwd = worktree.root;
      slot.innerGeneration = slot.driver.runtimeDetails().generation;
    } catch (error) {
      slot.suppressEvents = false;
      await registry.removeSessionWorkspace(slot.id).catch(() => {});
      await removeSessionWorktree(project.cwd, worktree, registry.worktreeRoot(projectId)).catch(() => {});
      throw error;
    }
    await this.publishWorkspaceReplacement(slot);
  }

  private async moveSelectedToLocal(
    slot: RuntimeSlot,
    projectId: string,
    record?: ReturnType<ProjectRegistry["workspaceForSession"]>,
  ): Promise<void> {
    if (!record || record.mode === "local") return;
    const registry = this.registry();
    const project = registry.get(projectId);
    if (!project) throw new Error("project is unavailable");
    await slot.driver.timelineRelocationReady();
    const session = await captureCheckoutState(slot.driver.runtimeDetails().cwd, true);
    if (record.mode === "checkout") {
      if (!record.parkedRoot || !record.parkedCommonDir || !record.parkedIndexTree || !record.parkedWorktreeTree
        || !record.branch || !record.commonDir) throw new Error("parked project-folder state is unavailable");
      const parked: CheckoutState = {
        root: record.parkedRoot,
        commonDir: record.parkedCommonDir,
        head: record.parkedHead,
        headRef: record.parkedHeadRef,
        indexTree: record.parkedIndexTree,
        worktreeTree: record.parkedWorktreeTree,
      };
      try {
        await restoreCheckoutState(project.cwd, {
          ...parked,
          indexTree: session.indexTree,
          worktreeTree: session.worktreeTree,
        });
        await registry.setSessionWorkspace({ sessionId: slot.id, projectId, mode: "local" });
        await removeSessionBranch(project.cwd, record.branch, record.commonDir);
      } catch (error) {
        await restoreCheckoutState(project.cwd, session).catch(() => {});
        await registry.setSessionWorkspace(record).catch(() => {});
        throw error;
      }
      await this.refreshWorkspace(slot, true);
      return;
    }
    if (!record.worktreePath || !record.commonDir || !record.branch || !record.baselineTree) {
      throw new Error("session worktree metadata is incomplete");
    }
    if (this.checkoutOwner(projectId, slot.id)) throw new Error("another session currently owns the project folder");
    const local = await captureCheckoutState(project.cwd, true);
    if (local.worktreeTree !== record.baselineTree) {
      throw new Error("project folder changed since this worktree started; move or commit those changes first");
    }
    try {
      await restoreCheckoutState(project.cwd, {
        ...local,
        indexTree: session.indexTree,
        worktreeTree: session.worktreeTree,
      });
      await registry.setSessionWorkspace({ sessionId: slot.id, projectId, mode: "local" });
      const previousId = slot.id;
      slot.suppressEvents = true;
      await slot.driver.rebindWorkspace(project.cwd);
      slot.suppressEvents = false;
      await registry.rekeySession(previousId, slot.id);
      slot.target.cwd = project.cwd;
      slot.innerGeneration = slot.driver.runtimeDetails().generation;
    } catch (error) {
      slot.suppressEvents = false;
      await restoreCheckoutState(project.cwd, local).catch(() => {});
      await registry.setSessionWorkspace(record).catch(() => {});
      await slot.driver.rebindWorkspace(record.worktreePath).catch(() => {});
      throw error;
    }
    await removeSessionWorktree(project.cwd, {
      root: record.worktreePath,
      commonDir: record.commonDir,
      branch: record.branch,
    }, registry.worktreeRoot(projectId)).catch(() => {});
    await this.publishWorkspaceReplacement(slot);
  }

  private async publishWorkspaceReplacement(slot: RuntimeSlot): Promise<void> {
    this.generation++;
    this.invalidateWorkspaceInventory(slot);
    await this.refreshWorkspace(slot, false);
    const runtime = await this.selectedSnapshot();
    this.emit({ type: "session.replaced", sessionId: slot.id, sessionGeneration: this.generation, runtime });
    this.sessionIndex.invalidate();
  }

  private assertCheckoutAvailable(slot: RuntimeSlot): void {
    const mode = this.registry().workspaceForSession(slot.id)?.mode;
    if (mode === "worktree") return;
    const details = slot.driver.runtimeDetails();
    const projectId = slot.target.projectId
      ?? this.registry().projectForSession(slot.id, details.cwd)?.id;
    if (!projectId) return;
    const conflict = [...this.slots.values()].find((candidate) => {
      if (candidate === slot || candidate.driver.runtimeState() === "idle") return false;
      const value = candidate.driver.runtimeDetails();
      const candidateProject = candidate.target.projectId
        ?? this.registry().projectForSession(candidate.id, value.cwd)?.id;
      const candidateMode = this.registry().workspaceForSession(candidate.id)?.mode;
      return candidateProject === projectId
        && candidateMode !== "worktree"
        && (mode !== "local" || candidateMode !== "local");
    });
    if (conflict) throw new Error("another checkout-bound session is already running in this project");
  }

  private async select(slot: RuntimeSlot): Promise<ReplacementResult> {
    const previousId = this.selectedId;
    slot.lastActivityAt = Date.now();
    const cachedWorkspace = Boolean(slot.workspace);
    const runtime = await this.snapshotFor(slot, cachedWorkspace);
    const issue = describeRuntimeSnapshotIssue(runtime);
    if (issue) throw new Error(issue);
    this.selectedId = slot.id;
    this.generation++;
    this.emit({ type: "session.replaced", sessionId: slot.id, sessionGeneration: this.generation, runtime });
    if (slot.pendingUi) this.emit({ type: "ui.event", sessionId: slot.id, sessionGeneration: this.generation, payload: slot.pendingUi });
    if (previousId) this.publishStatus(previousId);
    this.publishStatus(slot.id);
    if (cachedWorkspace) this.queueWorkspaceRefresh(slot);
    return this.replacement(false);
  }

  private onSlotEvent(slot: RuntimeSlot, event: DriverEvent): void {
    slot.lastActivityAt = Date.now();
    if (event.type === "session.event") {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const kind = String(payload.type ?? "").replace(/-/g, "_");
      if (kind === "session_info_changed" || kind === "agent_end") this.sessionIndex.invalidate();
    }
    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      const oldId = slot.id;
      const wasSelected = this.selectedId === oldId;
      slot.innerGeneration = event.sessionGeneration;
      slot.id = event.sessionId;
      if (oldId !== slot.id && !slot.suppressEvents) {
        if (this.slots.has(slot.id)) throw new Error("session replacement collided with an active runtime");
        void this.registry().rekeySession(oldId, slot.id).catch(() => undefined);
      }
      this.slots.delete(oldId);
      this.slots.set(slot.id, slot);
      if (wasSelected) this.selectedId = slot.id;
      if (slot.suppressEvents) return;
      if (wasSelected) {
        this.generation++;
        this.emit({ ...event, sessionId: slot.id, sessionGeneration: this.generation, runtime: this.translateSnapshot(event.runtime, slot) });
      }
      this.sessionIndex.invalidate();
      this.publishStatus(slot.id);
      return;
    }
    if (slot.suppressEvents) {
      this.publishStatus(slot.id);
      return;
    }
    if (event.type === "session.event") {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const kind = String(payload.type ?? "").replace(/-/g, "_");
      if (kind === "queue_update") {
        slot.nativeQueue = {
          steering: Array.isArray(payload.steering) ? payload.steering.length : Number.isSafeInteger(payload.steering) ? Math.max(0, payload.steering as number) : 0,
          followUp: Array.isArray(payload.followUp) ? payload.followUp.length : Number.isSafeInteger(payload.followUp) ? Math.max(0, payload.followUp as number) : 0,
        };
        this.publishQueue(slot);
        this.publishStatus(slot.id);
        return;
      }
    }
    if (event.type === "ui.event") {
      const request = event.payload as UiRequest;
      if (["select", "confirm", "input", "editor", "questionnaire"].includes(request.method)) slot.pendingUi = request;
    }
    if (event.type === "ui.closed" && slot.pendingUi?.requestId === event.requestId) slot.pendingUi = undefined;
    if (slot.id === this.selectedId) {
      this.emit({ ...event, sessionId: slot.id, sessionGeneration: this.generation } as DriverEvent);
    }
    if (event.type === "session.event") {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      if (String(payload.type ?? "").replace(/-/g, "_") === "agent_end") {
        this.invalidateWorkspaceInventory(slot);
        queueMicrotask(() => void this.refreshWorkspace(slot, true).catch(() => undefined));
        const completed = payload.stopped !== true && payload.willRetry !== true;
        queueMicrotask(() => void this.settleAgentRun(slot, payload.stopped === true).then(
          () => this.publishStatus(slot.id, completed),
          () => this.publishStatus(slot.id),
        ));
      } else if (String(payload.type ?? "").replace(/-/g, "_") === "worktree_summary") {
        this.invalidateWorkspaceInventory(slot);
        queueMicrotask(() => void this.refreshWorkspace(slot, true).catch(() => undefined));
      }
    }
    this.publishStatus(slot.id);
  }

  private publishStatus(sessionId: string, completed = false): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const state = slot.driver.runtimeState();
    completed = completed && state === "idle";
    if (state === slot.lastState && !completed) return;
    slot.lastState = state;
    this.emitStatus(sessionId, state, completed);
  }

  private emitStatus(sessionId: string, state: SessionRuntimeState, completed = false): void {
    if (!this.generation || !this.selectedId) return;
    this.emit({ type: "session.status", sessionId, sessionGeneration: this.generation, state, ...(completed ? { completed: true } : {}) });
  }

  private async selectedSnapshot(): Promise<RuntimeSnapshot> {
    return this.snapshotFor(this.selected());
  }

  private async snapshotFor(slot: RuntimeSlot, useCachedWorkspace = false): Promise<RuntimeSnapshot> {
    if (!useCachedWorkspace || !slot.workspace) {
      await (slot.workspaceRefresh ?? this.refreshWorkspace(slot, false));
    }
    return this.translateSnapshot(await slot.driver.snapshot(), slot);
  }

  private queueWorkspaceRefresh(slot: RuntimeSlot): void {
    const sessionId = slot.id;
    const generation = this.generation;
    const publish = () => this.publishWorkspace(slot, sessionId, generation);
    if (slot.workspaceRefresh) {
      void slot.workspaceRefresh.then(publish).catch(() => undefined);
      return;
    }
    const refresh = this.refreshWorkspace(slot, false)
      .catch(() => undefined)
      .finally(() => {
        if (slot.workspaceRefresh === refresh) slot.workspaceRefresh = undefined;
      });
    slot.workspaceRefresh = refresh;
    void refresh.then(publish).catch(() => undefined);
  }

  private translateSnapshot(snapshot: RuntimeSnapshot, slot: RuntimeSlot): RuntimeSnapshot {
    slot.nativeQueue = {
      steering: snapshot.conversation.queue.steering,
      followUp: snapshot.conversation.queue.followUp,
    };
    return {
      ...snapshot,
      sessionGeneration: this.generation,
      ready: true,
      conversation: {
        ...snapshot.conversation,
        queue: this.queueReadModel(slot),
      },
      sessionControls: {
        ...snapshot.sessionControls,
        ...(slot.pendingControls ? {
          pending: {
            model: { ...slot.pendingControls.model },
            thinkingLevel: slot.pendingControls.input.thinkingLevel,
          },
        } : { pending: undefined }),
      },
      workspace: slot.workspace,
    };
  }

  private async refreshWorkspace(slot: RuntimeSlot, publish: boolean): Promise<void> {
    const details = slot.driver.runtimeDetails();
    const record = this.registry().workspaceForSession(slot.id);
    try {
      if ((record?.mode === "worktree" || record?.mode === "checkout") && record.baselineTree) {
        const changes = await inspectWorkspaceChanges(details.cwd, record.baselineTree);
        const project = this.registry().get(record.projectId);
        const projectGit = project ? await inspectGitWorkspace(project.cwd) : undefined;
        const sameRepository = Boolean(projectGit && record.commonDir
          && resolve(projectGit.commonDir).toLocaleLowerCase() === resolve(record.commonDir).toLocaleLowerCase());
        const owner = this.checkoutOwner(record.projectId, slot.id);
        const idle = slot.driver.runtimeState() === "idle";
        const applyTargetBranch = record.mode === "checkout"
          ? branchLabel(record.parkedHeadRef)
          : branchLabel(projectGit?.headRef);
        const applyTarget = record.mode === "checkout"
          ? this.parkedCheckout(record)
          : project
            ? await captureCheckoutState(project.cwd)
            : undefined;
        const applyTargetChangedCount = applyTarget?.head
          ? (await inspectTreeChanges(project!.cwd, applyTarget.head, applyTarget.worktreeTree)).length
          : undefined;
        const canMoveToCheckout = record.mode === "worktree" && idle && sameRepository && !owner;
        const reason = record.mode === "worktree" && !canMoveToCheckout
          ? !idle
            ? "Session must be idle before moving."
            : owner
              ? "Another session currently owns the project folder."
              : !projectGit
                ? "The registered project folder is not a Git checkout."
                : !sameRepository
                  ? "The project folder belongs to a different Git repository."
                  : "Workspace handoff is unavailable."
          : undefined;
        slot.workspace = {
          gitAvailable: true,
          mode: record.mode,
          revision: changes.revision,
          changedCount: changes.files.length,
          setupState: slot.setupState ?? "idle",
          ...(slot.setupError ? { setupError: slot.setupError } : {}),
          ...(record.mode === "checkout" ? { checkoutOwner: slot.id.slice(0, 128) } : {}),
          canMoveToCheckout,
          canMoveToWorktree: record.mode === "checkout" && idle,
          canApplyChanges: idle && !slot.applyState && changes.files.length > 0
            && Boolean(applyTargetBranch) && sameRepository && (record.mode === "checkout" || !owner),
          ...(applyTargetBranch ? { applyTargetBranch } : {}),
          ...(applyTargetChangedCount !== undefined ? { applyTargetChangedCount } : {}),
          ...(!changes.files.length
            ? { applyUnavailableReason: "This session has no changes to apply." }
            : !idle
              ? { applyUnavailableReason: "Session must be idle before applying changes." }
              : slot.applyState
                ? { applyUnavailableReason: "Session changes are already being applied." }
                : owner
                  ? { applyUnavailableReason: "Another session currently owns the project folder." }
                  : !applyTargetBranch
                    ? { applyUnavailableReason: "The target project checkout is not on a branch." }
                    : !sameRepository
                      ? { applyUnavailableReason: "The project folder belongs to a different Git repository." }
                      : {}),
          ...(slot.applyState ? { applyState: slot.applyState } : {}),
          ...(slot.lastApply ? { lastApply: slot.lastApply } : {}),
          ...(reason ? { handoffUnavailableReason: reason } : {}),
        };
      } else {
        const gitWorkspace = await inspectGitWorkspace(details.cwd);
        const localChanges = gitWorkspace && record?.mode === "local"
          ? await inspectWorkspaceChanges(details.cwd)
          : undefined;
        slot.workspace = {
          gitAvailable: Boolean(gitWorkspace),
          mode: gitWorkspace ? record?.mode === "local" ? "local" : "checkout" : "non-git",
          ...(localChanges ? { revision: localChanges.revision } : {}),
          changedCount: localChanges?.files.length ?? 0,
          setupState: slot.setupState ?? "idle",
          ...(slot.setupError ? { setupError: slot.setupError } : {}),
          ...(record?.mode === "checkout" ? { checkoutOwner: slot.id.slice(0, 128) } : {}),
          canMoveToCheckout: false,
          canMoveToWorktree: Boolean(record?.mode === "checkout" && record.branch),
          canApplyChanges: false,
          applyUnavailableReason: "Only Project folder and Session worktree sessions can apply changes.",
          ...(slot.applyState ? { applyState: slot.applyState } : {}),
          ...(slot.lastApply ? { lastApply: slot.lastApply } : {}),
          ...(!gitWorkspace ? { handoffUnavailableReason: "The session folder is not a Git checkout." } : {}),
        };
      }
    } catch (error) {
      slot.workspace = {
        gitAvailable: false,
        mode: "non-git",
        changedCount: 0,
        setupState: "failed",
        setupError: error instanceof Error ? error.message.slice(0, 500) : "workspace unavailable",
        canMoveToCheckout: false,
        canMoveToWorktree: false,
        canApplyChanges: false,
        applyUnavailableReason: "Workspace changes are unavailable.",
        ...(slot.applyState ? { applyState: slot.applyState } : {}),
        ...(slot.lastApply ? { lastApply: slot.lastApply } : {}),
      };
    }
    if (publish) this.publishWorkspace(slot, slot.id, this.generation);
  }

  private publishWorkspace(slot: RuntimeSlot, sessionId: string, generation: number): void {
    if (slot.id !== sessionId || this.selectedId !== sessionId || this.generation !== generation
      || this.slots.get(sessionId) !== slot || !slot.workspace) return;
    this.emit({
      type: "workspace.revision",
      sessionId,
      sessionGeneration: generation,
      workspace: slot.workspace,
    });
  }

  private selected(): RuntimeSlot {
    const slot = this.slots.get(this.selectedId);
    if (!slot) throw new Error("runtime has not started");
    return slot;
  }

  private selectedQueuedPrompt(queueId: string): NonNullable<RuntimeSlot["queuedPrompt"]> {
    const queued = this.selected().queuedPrompt;
    if (!queued || queued.id !== queueId) throw new Error("queued prompt is unavailable");
    return queued;
  }

  private queueReadModel(slot: RuntimeSlot): QueueReadModel {
    const queued = slot.queuedPrompt;
    return {
      steering: slot.nativeQueue.steering,
      followUp: slot.nativeQueue.followUp + (queued ? 1 : 0),
      ...(queued ? {
        pending: {
          id: queued.id,
          preview: queued.message.replace(/\s+/g, " ").trim().slice(0, 2_000),
          attachmentCount: queued.images?.length ?? 0,
          fileAttachmentCount: queued.files?.length ?? 0,
          planMode: queued.planMode,
          state: queued.state,
        },
      } : {}),
    };
  }

  private publishQueue(slot: RuntimeSlot): void {
    if (slot.id !== this.selectedId) return;
    this.emit({
      type: "queue.changed",
      sessionId: slot.id,
      sessionGeneration: this.generation,
      queue: this.queueReadModel(slot),
    });
  }

  private async flushQueuedPrompt(slot: RuntimeSlot): Promise<void> {
    const queued = slot.queuedPrompt;
    if (!queued || queued.state !== "queued") return;
    queued.state = "delivering";
    this.publishQueue(slot);
    try {
      await slot.driver.prompt({
        commandId: queued.commandId,
        expectedGeneration: slot.innerGeneration,
        message: queued.message,
        images: queued.images,
        files: queued.files,
        planMode: queued.planMode,
      });
      slot.queuedPrompt = undefined;
      slot.lastActivityAt = Date.now();
      this.publishQueue(slot);
    } catch {
      if (slot.queuedPrompt === queued) {
        queued.state = "queued";
        this.publishQueue(slot);
      }
    }
  }

  private async settleAgentRun(slot: RuntimeSlot, stopped = false): Promise<void> {
    const apply = slot.pendingApply;
    if (apply) {
      slot.pendingApply = undefined;
      if (stopped) {
        slot.applyState = undefined;
        slot.driver.recordWorkspaceApplyResult("Session changes were not applied because the requesting turn was stopped.");
        await this.publishWorkspaceState(slot);
      } else {
        try {
          await this.withLifecycle(() => this.applySlotChanges(slot, apply.revision));
          const result = slot.lastApply;
          slot.driver.recordWorkspaceApplyResult(
            `Session changes ${result?.state === "unchanged" ? "were already present on" : "were applied to"} ${result?.targetBranch ?? "the project branch"} as uncommitted working-tree changes.`,
          );
        } catch (error) {
          const details = error instanceof WorkspaceApplyConflictError
            ? `\n\nConflicts:\n${error.conflicts.slice(0, 20).map((item) =>
                `- ${item.path}${item.context ? `\n${item.context}` : ""}`).join("\n")}`
            : "";
          const message = `${error instanceof Error ? error.message : "Could not apply session changes."}${details}`.slice(0, 32 * 1024);
          slot.driver.recordWorkspaceApplyResult(`Session changes were not applied. Both workspaces were left unchanged.\n\n${message}`);
          if (slot.id === this.selectedId) {
            this.emit({
              type: "session.event",
              sessionId: slot.id,
              sessionGeneration: this.generation,
              payload: { type: "runtime_error", message },
            });
          }
        }
      }
    }
    const pending = slot.pendingControls;
    if (pending) {
      slot.pendingControls = undefined;
      try {
        await slot.driver.setSessionControls(pending.input);
      } catch (error) {
        if (slot.id === this.selectedId) {
          this.emit({
            type: "session.event",
            sessionId: slot.id,
            sessionGeneration: this.generation,
            payload: {
              type: "session_controls_error",
              message: error instanceof Error ? error.message : "Could not apply the queued model change",
            },
          });
        }
        this.emitControlsChanged(slot);
        return;
      }
      this.emitControlsChanged(slot);
    }
    await this.flushQueuedPrompt(slot);
  }

  private slotCanSleep(slot: RuntimeSlot): boolean {
    return !slot.queuedPrompt && !slot.pendingControls && !slot.pendingApply && slot.driver.canSleep();
  }

  private emitControlsChanged(slot: RuntimeSlot): void {
    if (slot.id !== this.selectedId) return;
    this.emit({
      type: "session.event",
      sessionId: slot.id,
      sessionGeneration: this.generation,
      payload: { type: "session_controls_changed" },
    });
  }

  private baseTarget(): RuntimeTarget {
    if (!this.target) throw new Error("runtime has not started");
    return {
      cwd: this.target.cwd,
      agentDir: this.target.agentDir,
      repositoryRoot: this.target.repositoryRoot,
    };
  }

  private registry(): ProjectRegistry {
    if (!this.projectRegistry) throw new Error("project registry is unavailable");
    return this.projectRegistry;
  }

  private async recoverHandoff(): Promise<void> {
    const registry = this.registry();
    const journal = await registry.readHandoffJournal();
    if (!journal) return;
    const project = registry.get(journal.projectId);
    const workspace = journal.workspace;
    if (!project || !workspace.worktreePath || !workspace.commonDir || !workspace.branch) {
      throw new Error("handoff recovery metadata is incomplete");
    }
    const currentProject = await captureCheckoutState(project.cwd, true);
    const sessionState = currentProject.headRef === workspace.branch
      ? currentProject
      : journal.sessionState;
    if (currentProject.headRef === workspace.branch) {
      await restoreCheckoutState(project.cwd, journal.projectState);
    } else if (currentProject.headRef !== journal.projectState.headRef || currentProject.head !== journal.projectState.head) {
      throw new Error("project folder changed branches during handoff recovery");
    }
    const existing = await inspectGitWorkspace(workspace.worktreePath);
    const worktreePath = existing
      ? workspace.worktreePath
      : await recreateSessionWorktree(
          project.cwd,
          workspace.worktreePath,
          registry.worktreeRoot(project.id),
          workspace.branch,
          workspace.commonDir,
        );
    await restoreCheckoutState(worktreePath, sessionState);
    await registry.setSessionWorkspace({
      sessionId: workspace.sessionId,
      projectId: workspace.projectId,
      mode: "worktree",
      worktreePath,
      commonDir: workspace.commonDir,
      branch: workspace.branch,
      baseline: workspace.baseline,
      baselineTree: workspace.baselineTree,
    });
    await registry.clearHandoffJournal();
  }

  private async recoverApply(): Promise<void> {
    const registry = this.registry();
    const journal = await registry.readApplyJournal();
    if (!journal) return;
    const project = registry.get(journal.projectId);
    if (!project) throw new Error("workspace apply recovery project is unavailable");
    const current = await captureCheckoutState(project.cwd, true);
    if (sameCheckout(current, journal.mergedState)) {
      if (journal.mode === "checkout") {
        await registry.setSessionWorkspace({
          sessionId: journal.sessionId,
          projectId: journal.projectId,
          mode: "local",
          commonDir: journal.workspace.commonDir,
          branch: journal.workspace.branch,
          baseline: journal.workspace.baseline,
          baselineTree: journal.workspace.baselineTree,
        });
      }
      await registry.clearApplyJournal();
      return;
    }
    if (journal.mode === "worktree" && sameCheckout(current, journal.targetState)) {
      await registry.clearApplyJournal();
      return;
    }
    if (journal.mode === "checkout"
      && (sameCheckout(current, journal.sourceState) || sameCheckout(current, journal.targetState))) {
      await restoreCheckoutState(project.cwd, journal.sourceState);
      await registry.setSessionWorkspace(journal.workspace);
      await registry.clearApplyJournal();
      return;
    }
    throw new Error("project folder changed during workspace apply recovery");
  }

  private async recoverProvision(): Promise<void> {
    const registry = this.registry();
    const journal = await registry.readProvisionJournal();
    if (!journal) return;
    const mapped = registry.listSessionWorkspaces().some((workspace) =>
      workspace.worktreePath === journal.worktreePath && workspace.branch === journal.branch);
    if (mapped) {
      await registry.clearProvisionJournal();
      return;
    }
    const project = registry.get(journal.projectId);
    if (!project) throw new Error("worktree recovery project is unavailable");
    await removeSessionWorktree(project.cwd, {
      root: journal.worktreePath,
      commonDir: journal.commonDir,
      branch: journal.branch,
    }, registry.worktreeRoot(project.id)).catch(async () => {
      await removeSessionBranch(project.cwd, journal.branch, journal.commonDir);
    });
    await registry.clearProvisionJournal();
  }

  private async wakePinnedSessions(selectedId: string): Promise<void> {
    const registry = this.registry();
    for (const sessionId of registry.listPinnedSessionIds()) {
      if (sessionId === selectedId || registry.isSessionArchived(sessionId)) continue;
      const session = await this.sessionIndex.resolve(sessionId);
      const project = session && registry.projectForSession(session.id, session.cwd);
      if (!session || !project || project.archivedAt) {
        await registry.unpinSession(sessionId);
        continue;
      }
      let created: RuntimeSlot | undefined;
      try {
        if (!this.slots.has(sessionId)) {
          created = await this.createSlot({
            ...this.baseTarget(),
            cwd: registry.effectiveCwd(session.id, session.cwd),
            sessionPath: session.path,
            projectId: project.id,
          });
        }
        const slot = created ?? this.slots.get(sessionId);
        if (!slot) throw new Error("pinned session failed to wake");
        slot.pinned = true;
        await registry.activateSession(slot.id);
      } catch {
        if (created && this.slots.has(created.id)) await this.disposeSlot(created).catch(() => undefined);
        // Keep a valid persisted pin so the next startup can retry waking it.
      }
    }
  }

  private async slotForProject(projectId: string, cwd: string): Promise<RuntimeSlot> {
    const awake = [...this.slots.values()].find((slot) => this.projectIdForSlot(slot) === projectId);
    if (awake) return awake;
    const session = (await SessionManager.listAll())
      .filter((candidate) => this.registry().projectForSession(candidate.id, candidate.cwd)?.id === projectId
        && !this.registry().isSessionArchived(candidate.id))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())[0];
    return this.createSlot(session
      ? { ...this.baseTarget(), cwd: this.registry().effectiveCwd(session.id, session.cwd), sessionPath: session.path, projectId }
      : { ...this.baseTarget(), cwd, projectId });
  }

  private projectIdForSlot(slot: RuntimeSlot): string | undefined {
    const details = slot.driver.runtimeDetails();
    return slot.target.projectId
      ?? this.registry().projectForSession(slot.id, details.cwd)?.id;
  }

  private emitProjectsChanged(): void {
    this.emit({
      type: "projects.changed",
      sessionId: this.selectedId,
      sessionGeneration: this.generation,
    });
  }

  private replacement(cancelled: boolean): ReplacementResult {
    return { cancelled, sessionId: this.selectedId, sessionGeneration: this.generation };
  }

  private assertGeneration(expected = this.generation): void {
    if (expected !== this.generation) {
      const error = new Error(`stale session generation: expected ${this.generation}, received ${expected}`);
      error.name = "StaleGenerationError";
      throw error;
    }
  }

  private assertSelected(slot: RuntimeSlot, generation: number, action: string): void {
    if (slot.id !== this.selectedId || generation !== this.generation) {
      throw new Error(`session changed while ${action}`);
    }
  }

  private async withLifecycle<T>(action: () => Promise<T>): Promise<T> {
    if (this.lifecycleBusy) throw new Error("another session operation is in progress");
    this.lifecycleBusy = true;
    try {
      return await action();
    } finally {
      this.lifecycleBusy = false;
    }
  }

  private async sleepIdleSlots(): Promise<void> {
    const now = Date.now();
    for (const slot of [...this.slots.values()]) {
      if (!slot.receivedInput && slot.driver.runtimeDetails().userMessageCount === 0) continue;
      const sleepAfterMs = slot.receivedInput
        ? this.options.sleepAfterMs ?? SLEEP_AFTER_MS
        : this.options.viewOnlySleepAfterMs ?? VIEW_ONLY_SLEEP_AFTER_MS;
      if (slot.id === this.selectedId || slot.pinned || now - slot.lastActivityAt < sleepAfterMs || !this.slotCanSleep(slot)) continue;
      await this.registry().deactivateSession(slot.id);
      await this.disposeSlot(slot);
      this.emitStatus(slot.id, "sleeping");
      this.emitProjectsChanged();
    }
  }

  private async disposeSlot(slot: RuntimeSlot): Promise<void> {
    slot.unsubscribe();
    this.slots.delete(slot.id);
    await slot.driver.dispose();
  }

  private invalidateWorkspaceInventory(slot: RuntimeSlot): void {
    const record = this.registry().workspaceForSession(slot.id);
    this.workspaceInventories.delete(workspaceInventoryKey(slot.driver.runtimeDetails().cwd, record?.baselineTree));
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function decodeWorkspaceFileCursor(cursor: string | undefined, length: number): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new Error("Invalid file cursor.");
  return offset;
}

function workspaceInventoryKey(cwd: string, baselineTree?: string): string {
  return `${resolve(cwd).toLocaleLowerCase()}\0${baselineTree ?? ""}`;
}

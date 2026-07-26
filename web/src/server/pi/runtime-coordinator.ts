import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, PackageListSnapshot, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots.ts";
import { SessionRuntime, type SessionRuntimeOptions } from "./session-runtime.ts";
import type {
  DeleteSessionInput,
  DeleteContinuityMemoryInput,
  DriverEvent,
  DriverEventListener,
  ForkInput,
  NewSessionInput,
  PiDriver,
  ProjectInput,
  ProjectArchiveInput,
  PromptInput,
  RemoveProjectInput,
  ReplacementResult,
  RuntimeHandle,
  RuntimeTarget,
  RenameSessionInput,
  SetModelInput,
  SetPackageEnabledInput,
  SetSessionActiveInput,
  SetThinkingLevelInput,
  SessionArchiveInput,
  SwitchSessionInput,
  UpdateContinuityMemoryInput,
  UpdatePackageSettingsInput,
} from "./pi-driver.ts";
import type { UiRequest, UiResponse } from "./remote-ui-context.ts";
import { SessionIndex } from "./session-index.ts";
import { pickProjectDirectory, ProjectRegistry, projectIdForCwd } from "./project-registry.ts";

const SLEEP_AFTER_MS = 30 * 60 * 1000;
const VIEW_ONLY_SLEEP_AFTER_MS = 60 * 1000;
const SLEEP_CHECK_MS = 60 * 1000;

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
  unsubscribe: () => void;
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
  private sleepTimer?: NodeJS.Timeout;
  private lifecycleBusy = false;
  private pickerBusy = false;
  private pickerAbort?: AbortController;
  private disposed = false;

  constructor(private readonly options: RuntimeCoordinatorOptions = {}) {}

  async start(target: RuntimeTarget): Promise<RuntimeHandle> {
    if (this.target || this.disposed) throw new Error("driver cannot be started twice");
    this.target = target;
    this.projectRegistry = ProjectRegistry.forAgentDir(target.agentDir);
    const knownSessions = await SessionManager.listAll();
    await this.projectRegistry.load([target.cwd, ...knownSessions.map((session) => session.cwd)]);
    this.sessionIndex.setProjectRegistry(this.projectRegistry);
    const projects = this.projectRegistry.list();
    const project = projects.find((candidate) => candidate.id === projectIdForCwd(target.cwd)) ?? projects[0];
    const slot = await this.createSlot(project
      ? { ...target, cwd: project.cwd }
      : { ...target, inMemory: true });
    this.selectedId = slot.id;
    this.generation = 1;
    this.sleepTimer = setInterval(() => void this.sleepIdleSlots(), this.options.sleepCheckMs ?? SLEEP_CHECK_MS);
    this.sleepTimer.unref?.();
    return { sessionId: slot.id, sessionGeneration: this.generation };
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return this.selectedSnapshot();
  }

  async listSessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    const selected = this.selected();
    return this.sessionIndex.list(input, {
      activeId: selected.id,
      generation: this.generation,
      stateFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeState() ?? "sleeping",
      activeFor: (sessionId) => {
        const slot = this.slots.get(sessionId);
        return Boolean(slot && (slot.receivedInput || slot.pinned));
      },
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
  }

  async listArchived(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const selected = this.selected();
    return this.sessionIndex.listArchived(input, {
      activeId: selected.id,
      generation: this.generation,
      stateFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeState() ?? "sleeping",
      userCountFor: (sessionId) => this.slots.get(sessionId)?.driver.runtimeDetails().userMessageCount,
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    return this.selected().driver.listPackages();
  }

  async prompt(input: PromptInput): Promise<AcceptedCommand> {
    return this.messageCommand("prompt", input);
  }

  async steer(input: PromptInput): Promise<AcceptedCommand> {
    return this.messageCommand("steer", input);
  }

  async followUp(input: PromptInput): Promise<AcceptedCommand> {
    return this.messageCommand("followUp", input);
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
      const slot = await this.createSlot({
        ...this.baseTarget(),
        cwd: project?.cwd ?? parent?.cwd ?? current.cwd,
        parentSessionPath: parent?.path ?? current.sessionPath,
      });
      this.sessionIndex.invalidate();
      return this.select(slot);
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
        const slot = await this.createSlot({ ...this.baseTarget(), cwd: project.cwd });
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
        .filter((slot) => projectIdForCwd(slot.driver.runtimeDetails().cwd) === project.id);
      if (projectSlots.some((slot) => !slot.driver.canSleep())) {
        throw new Error("cannot remove a project with a running or attention session");
      }

      const sessions = (await SessionManager.listAll())
        .filter((session) => projectIdForCwd(session.cwd) === project.id);
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
        this.sessionIndex.remove(session.id);
        this.emitStatus(session.id, "sleeping");
      }
      await registry.remove(project.id, sessions.map((session) => session.id));
      this.sessionIndex.invalidate();
      this.emitProjectsChanged();
      return this.replacement(false);
    });
  }

  async archiveProject(input: ProjectArchiveInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      const project = registry.get(input.projectId);
      if (!project || project.archivedAt) throw new Error("project is unavailable");
      const projectSlots = [...this.slots.values()]
        .filter((slot) => projectIdForCwd(slot.driver.runtimeDetails().cwd) === project.id);
      if (projectSlots.some((slot) => !slot.driver.canSleep())) {
        throw new Error("cannot archive a project with a running or attention session");
      }
      if (projectSlots.some((slot) => slot.id === this.selectedId)) {
        const alternative = registry.list().find((candidate) => candidate.id !== project.id);
        const slot = alternative
          ? await this.slotForProject(alternative.id, alternative.cwd)
          : await this.createSlot({ ...this.baseTarget(), inMemory: true });
        await this.select(slot);
      }
      await registry.archiveProject(project.id);
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

  async archiveSession(input: SessionArchiveInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      this.assertGeneration(input.expectedGeneration);
      const registry = this.registry();
      if (registry.isSessionArchived(input.sessionId)) throw new Error("session is already archived");
      const session = await this.sessionIndex.resolve(input.sessionId);
      if (!session) throw new Error("session is unavailable");
      const project = registry.get(projectIdForCwd(session.cwd));
      if (!project || project.archivedAt) throw new Error("session project is unavailable");
      const awake = this.slots.get(input.sessionId);
      if (awake && !awake.driver.canSleep()) throw new Error("cannot archive a running or attention session");
      if (input.sessionId === this.selectedId) {
        const replacement = await this.createSlot({ ...this.baseTarget(), cwd: project.cwd });
        await this.select(replacement);
      }
      await registry.archiveSession(input.sessionId);
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
      if (registry.get(projectIdForCwd(session.cwd))?.archivedAt) throw new Error("restore the project before restoring this session");
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
      const slot = await this.createSlot({ ...this.baseTarget(), cwd: session.cwd, sessionPath: session.path });
      return this.select(slot);
    });
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before deleting it");
    if (input.sessionId === this.selectedId) throw new Error("cannot delete the currently active session");
    const awake = this.slots.get(input.sessionId);
    if (awake) {
      if (!awake.driver.canSleep()) throw new Error("cannot delete a running session");
      await this.disposeSlot(awake);
    }
    const selected = this.selected();
    await selected.driver.deleteSession({ sessionId: input.sessionId });
    this.sessionIndex.remove(input.sessionId);
    this.emitStatus(input.sessionId, "sleeping");
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    this.assertGeneration();
    if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before renaming it");
    const slot = this.slots.get(input.sessionId);
    if (slot) slot.lastActivityAt = Date.now();
    await (slot ?? this.selected()).driver.renameSession(input);
    this.sessionIndex.invalidate();
  }

  setSessionActive(input: SetSessionActiveInput): Promise<void> {
    return this.withLifecycle(async () => {
      this.assertGeneration();
      if (this.registry().isSessionArchived(input.sessionId)) throw new Error("restore the session before activating it");
      const awake = this.slots.get(input.sessionId);
      if (input.active) {
        if (awake) {
          awake.pinned = true;
          awake.lastActivityAt = Date.now();
          return;
        }
        const session = await this.sessionIndex.resolve(input.sessionId);
        if (!session) throw new Error("session is unavailable");
        const slot = await this.createSlot({ ...this.baseTarget(), cwd: session.cwd, sessionPath: session.path });
        slot.pinned = true;
        this.sessionIndex.invalidate();
        this.emitStatus(slot.id, slot.driver.runtimeState());
        return;
      }
      if (input.sessionId === this.selectedId) throw new Error("cannot deactivate the selected session");
      if (!awake) return;
      if (!awake.driver.canSleep()) throw new Error("cannot deactivate a running session");
      await this.disposeSlot(awake);
      this.emitStatus(input.sessionId, "sleeping");
    });
  }

  async fork(input: ForkInput): Promise<ReplacementResult> {
    this.assertGeneration();
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.fork(input);
    return this.replacement(false);
  }

  async setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      for (const slot of this.slots.values()) {
        if (!slot.driver.canSleep()) throw new Error("packages can only change while every session is idle");
      }
      const selected = this.selected();
      await selected.driver.setPackageEnabled(input);
      for (const slot of [...this.slots.values()]) {
        if (slot.id !== this.selectedId) await this.disposeSlot(slot);
      }
      this.sessionIndex.invalidate();
      return this.replacement(false);
    });
  }

  async updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
      for (const slot of this.slots.values()) {
        if (!slot.driver.canSleep()) throw new Error("packages can only change while every session is idle");
      }
      const selected = this.selected();
      await selected.driver.updatePackageSettings(input);
      for (const slot of [...this.slots.values()]) {
        if (slot.id !== this.selectedId) await this.disposeSlot(slot);
      }
      this.sessionIndex.invalidate();
      return this.replacement(false);
    });
  }

  async rebuildDiscoverIndex(): Promise<void> {
    this.assertGeneration();
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver.rebuildDiscoverIndex();
  }

  async setModel(input: SetModelInput): Promise<void> {
    this.assertGeneration();
    await this.selected().driver.setModel(input);
  }

  setThinkingLevel(input: SetThinkingLevelInput): void {
    this.assertGeneration();
    this.selected().driver.setThinkingLevel(input);
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

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pickerAbort?.abort();
    this.pickerAbort = undefined;
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    for (const slot of [...this.slots.values()]) await this.disposeSlot(slot);
    this.listeners.clear();
  }

  private async createSlot(target: RuntimeTarget): Promise<RuntimeSlot> {
    const driver = new SessionRuntime({ ...this.options, projectRegistry: this.registry() });
    const handle = await driver.start(target);
    const slot: RuntimeSlot = {
      id: handle.sessionId,
      driver,
      target,
      innerGeneration: handle.sessionGeneration,
      lastActivityAt: Date.now(),
      receivedInput: false,
      pinned: false,
      lastState: driver.runtimeState(),
      unsubscribe: () => undefined,
    };
    slot.unsubscribe = driver.subscribe((event) => this.onSlotEvent(slot, event));
    this.slots.set(slot.id, slot);
    return slot;
  }

  private async messageCommand(kind: "prompt" | "steer" | "followUp", input: PromptInput): Promise<AcceptedCommand> {
    this.assertGeneration(input.expectedGeneration);
    const slot = this.selected();
    slot.lastActivityAt = Date.now();
    await slot.driver[kind]({ ...input, expectedGeneration: slot.innerGeneration });
    slot.receivedInput = true;
    this.sessionIndex.invalidate();
    return { commandId: input.commandId, sessionGeneration: this.generation, accepted: true };
  }

  private async select(slot: RuntimeSlot): Promise<ReplacementResult> {
    const previousId = this.selectedId;
    this.selectedId = slot.id;
    slot.lastActivityAt = Date.now();
    this.generation++;
    const runtime = await this.selectedSnapshot();
    this.emit({ type: "session.replaced", sessionId: slot.id, sessionGeneration: this.generation, runtime });
    if (slot.pendingUi) this.emit({ type: "ui.event", sessionId: slot.id, sessionGeneration: this.generation, payload: slot.pendingUi });
    if (previousId) this.publishStatus(previousId);
    this.publishStatus(slot.id);
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
      slot.innerGeneration = event.sessionGeneration;
      slot.id = event.sessionId;
      this.slots.delete(oldId);
      this.slots.set(slot.id, slot);
      if (this.selectedId === oldId) {
        this.selectedId = slot.id;
        this.generation++;
        this.emit({ ...event, sessionId: slot.id, sessionGeneration: this.generation, runtime: this.translateSnapshot(event.runtime) });
      }
      this.sessionIndex.invalidate();
      this.publishStatus(slot.id);
      return;
    }
    if (event.type === "ui.event") {
      const request = event.payload as UiRequest;
      if (["select", "confirm", "input", "editor"].includes(request.method)) slot.pendingUi = request;
    }
    if (event.type === "ui.closed" && slot.pendingUi?.requestId === event.requestId) slot.pendingUi = undefined;
    if (slot.id === this.selectedId) {
      this.emit({ ...event, sessionId: slot.id, sessionGeneration: this.generation } as DriverEvent);
    }
    this.publishStatus(slot.id);
  }

  private publishStatus(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const state = slot.driver.runtimeState();
    if (state === slot.lastState) return;
    slot.lastState = state;
    this.emitStatus(sessionId, state);
  }

  private emitStatus(sessionId: string, state: SessionRuntimeState): void {
    if (!this.generation || !this.selectedId) return;
    this.emit({ type: "session.status", sessionId, sessionGeneration: this.generation, state });
  }

  private async selectedSnapshot(): Promise<RuntimeSnapshot> {
    return this.translateSnapshot(await this.selected().driver.snapshot());
  }

  private translateSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    return { ...snapshot, sessionGeneration: this.generation, ready: true };
  }

  private selected(): RuntimeSlot {
    const slot = this.slots.get(this.selectedId);
    if (!slot) throw new Error("runtime has not started");
    return slot;
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

  private async slotForProject(projectId: string, cwd: string): Promise<RuntimeSlot> {
    const awake = [...this.slots.values()].find((slot) => projectIdForCwd(slot.driver.runtimeDetails().cwd) === projectId);
    if (awake) return awake;
    const session = (await SessionManager.listAll())
      .filter((candidate) => projectIdForCwd(candidate.cwd) === projectId && !this.registry().isSessionArchived(candidate.id))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())[0];
    return this.createSlot(session
      ? { ...this.baseTarget(), cwd, sessionPath: session.path }
      : { ...this.baseTarget(), cwd });
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
      const sleepAfterMs = slot.receivedInput
        ? this.options.sleepAfterMs ?? SLEEP_AFTER_MS
        : this.options.viewOnlySleepAfterMs ?? VIEW_ONLY_SLEEP_AFTER_MS;
      if (slot.id === this.selectedId || slot.pinned || now - slot.lastActivityAt < sleepAfterMs || !slot.driver.canSleep()) continue;
      await this.disposeSlot(slot);
      this.emitStatus(slot.id, "sleeping");
    }
  }

  private async disposeSlot(slot: RuntimeSlot): Promise<void> {
    slot.unsubscribe();
    this.slots.delete(slot.id);
    await slot.driver.dispose();
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

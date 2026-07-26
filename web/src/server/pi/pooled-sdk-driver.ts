import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { PackageListSnapshot, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots.ts";
import { DirectSdkDriver, type DirectSdkDriverOptions } from "./direct-sdk-driver.ts";
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
import type { UiRequest, UiResponse } from "./remote-ui-context.ts";
import { SessionIndex } from "./session-index.ts";

const SLEEP_AFTER_MS = 30 * 60 * 1000;
const VIEW_ONLY_SLEEP_AFTER_MS = 60 * 1000;
const SLEEP_CHECK_MS = 60 * 1000;

export interface PooledSdkDriverOptions extends DirectSdkDriverOptions {
  sleepAfterMs?: number;
  viewOnlySleepAfterMs?: number;
  sleepCheckMs?: number;
}

interface RuntimeSlot {
  id: string;
  driver: DirectSdkDriver;
  target: RuntimeTarget;
  innerGeneration: number;
  lastActivityAt: number;
  receivedInput: boolean;
  lastState: SessionRuntimeState;
  pendingUi?: UiRequest;
  unsubscribe: () => void;
}

/** Keeps visited SDK sessions alive while preserving one server-wide selection. */
export class PooledSdkDriver implements PiDriver {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly listeners = new Set<DriverEventListener>();
  private readonly sessionIndex = new SessionIndex();
  private selectedId = "";
  private generation = 0;
  private target?: RuntimeTarget;
  private sleepTimer?: NodeJS.Timeout;
  private lifecycleBusy = false;
  private disposed = false;

  constructor(private readonly options: PooledSdkDriverOptions = {}) {}

  async start(target: RuntimeTarget): Promise<RuntimeHandle> {
    if (this.target || this.disposed) throw new Error("driver cannot be started twice");
    this.target = target;
    const slot = await this.createSlot(target);
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
      const parent = input.parentSessionId ? await this.sessionIndex.resolve(input.parentSessionId) : undefined;
      if (input.parentSessionId && !parent) throw new Error("parent session is unavailable");
      const current = this.selected().driver.runtimeDetails();
      const slot = await this.createSlot({
        ...this.baseTarget(),
        cwd: parent?.cwd ?? current.cwd,
        parentSessionPath: parent?.path ?? current.sessionPath,
      });
      this.sessionIndex.invalidate();
      return this.select(slot);
    });
  }

  async switchSession(input: SwitchSessionInput): Promise<ReplacementResult> {
    return this.withLifecycle(async () => {
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

  async setModel(input: SetModelInput): Promise<void> {
    this.assertGeneration();
    await this.selected().driver.setModel(input);
  }

  setThinkingLevel(input: SetThinkingLevelInput): void {
    this.assertGeneration();
    this.selected().driver.setThinkingLevel(input);
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
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    for (const slot of [...this.slots.values()]) await this.disposeSlot(slot);
    this.listeners.clear();
  }

  private async createSlot(target: RuntimeTarget): Promise<RuntimeSlot> {
    const driver = new DirectSdkDriver(this.options);
    const handle = await driver.start(target);
    const slot: RuntimeSlot = {
      id: handle.sessionId,
      driver,
      target,
      innerGeneration: handle.sessionGeneration,
      lastActivityAt: Date.now(),
      receivedInput: false,
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
    slot.receivedInput = false;
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
      if (slot.id === this.selectedId || now - slot.lastActivityAt < sleepAfterMs || !slot.driver.canSleep()) continue;
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

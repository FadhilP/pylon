import { useSyncExternalStore } from "react";
import type {
  AndroidCommand,
  AndroidCommandResult,
  AndroidServiceEvent,
  AndroidServiceSnapshot,
} from "../../shared/protocol/android";
import { ANDROID_EVENT_MAX_BYTES, ANDROID_PROTOCOL_VERSION } from "../../shared/protocol/android";
import { ApiClient } from "../runtime/api-client";

interface EventSourcePort {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
}

interface AndroidApi {
  bootstrap(): Promise<unknown>;
  androidSnapshot(): Promise<AndroidServiceSnapshot>;
  androidEvents(cursor: string): EventSourcePort;
  androidCommand(command: AndroidCommand): Promise<AndroidCommandResult>;
}

export interface AndroidStoreSnapshot {
  status: "idle" | "loading" | "ready" | "error";
  service?: AndroidServiceSnapshot;
  connected: boolean;
  busy?: AndroidCommand["type"];
  error?: string;
}

const initial: AndroidStoreSnapshot = { status: "idle", connected: false };

function commandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Android Runner request failed";
}

export function androidProjectForGeneration(
  service: AndroidServiceSnapshot | undefined,
  generation: number | undefined,
) {
  return generation && service?.project?.sessionGeneration === generation ? service.project : undefined;
}

export class AndroidStore {
  private snapshot = initial;
  private readonly listeners = new Set<() => void>();
  private source?: EventSourcePort;
  private started = false;
  private disposed = false;
  private reloadPromise?: Promise<void>;
  private authenticatePromise?: Promise<void>;
  private readonly activeCommands = new Map<string, AndroidCommand["type"]>();

  constructor(private readonly api: AndroidApi = new ApiClient()) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AndroidStoreSnapshot => this.snapshot;

  start(): void {
    if (this.disposed) return;
    if (!this.started) {
      this.started = true;
      this.set({ ...this.snapshot, status: "loading", error: undefined });
    }
    void this.authenticate().catch(error => this.fail(error));
  }

  dispose(): void {
    this.disposed = true;
    this.source?.close();
    this.source = undefined;
    this.listeners.clear();
  }

  refresh(): Promise<void> {
    if (!this.snapshot.connected) {
      return this.authenticate().catch(error => {
        this.fail(error);
        throw error;
      });
    }
    if (this.snapshot.service) return this.send("refresh");
    this.set({ ...this.snapshot, status: "loading", error: undefined });
    return this.authenticate().catch(error => {
      this.fail(error);
      throw error;
    });
  }

  startEmulator(avd: string): Promise<void> {
    return this.send("startEmulator", { avd });
  }

  cancelOperation(deviceId: string, deviceRevision: number): Promise<void> {
    return this.send("cancelOperation", { deviceId, deviceRevision });
  }

  stopEmulator(deviceId: string, deviceRevision: number): Promise<void> {
    return this.send("stopEmulator", { deviceId, deviceRevision });
  }

  refreshProject(expectedGeneration: number): Promise<void> {
    return this.send("refreshProject", { expectedGeneration });
  }

  saveRunConfiguration(
    expectedGeneration: number,
    expectedConfigRevision: number,
    candidateId: string,
    modulePath: string,
    variant: string,
  ): Promise<void> {
    return this.send("saveRunConfiguration", {
      expectedGeneration,
      expectedConfigRevision,
      candidateId,
      modulePath,
      variant,
    });
  }

  setWorkspaceTrust(
    expectedGeneration: number,
    expectedConfigRevision: number,
    expectedTrustRevision: number,
    trusted: boolean,
  ): Promise<void> {
    return this.send("setWorkspaceTrust", {
      expectedGeneration,
      expectedConfigRevision,
      expectedTrustRevision,
      trusted,
    });
  }

  build(expectedGeneration: number, configRevision: number, trustRevision: number): Promise<void> {
    return this.send("build", { expectedGeneration, configRevision, trustRevision });
  }

  buildAndRun(
    expectedGeneration: number,
    configRevision: number,
    trustRevision: number,
    deviceId: string,
    deviceRevision: number,
  ): Promise<void> {
    return this.send("buildAndRun", { expectedGeneration, configRevision, trustRevision, deviceId, deviceRevision });
  }

  cancelBuild(operationId: string, operationRevision: number): Promise<void> {
    return this.send("cancelBuild", { operationId, operationRevision });
  }

  stopApp(runId: string, runRevision: number): Promise<void> {
    return this.send("stopApp", { runId, runRevision });
  }

  relaunchApp(runId: string, runRevision: number): Promise<void> {
    return this.send("relaunchApp", { runId, runRevision });
  }

  startLogs(runId: string, runRevision: number): Promise<void> {
    return this.send("startLogs", { runId, runRevision });
  }

  stopLogs(runId: string, runRevision: number): Promise<void> {
    return this.send("stopLogs", { runId, runRevision });
  }

  clearRetainedOutput(runId: string, runRevision: number): Promise<void> {
    return this.send("clearRetainedOutput", { runId, runRevision });
  }

  private async send(type: AndroidCommand["type"], input: Record<string, unknown> = {}): Promise<void> {
    const service = this.snapshot.service;
    if (!service) throw new Error("Android Runner is not ready");
    const id = commandId();
    const base = { type, commandId: id, expectedServiceRevision: service.serviceRevision };
    const command = { ...base, ...input } as AndroidCommand;
    this.activeCommands.set(id, type);
    this.set({ ...this.snapshot, busy: type, error: undefined });
    try {
      const result = await this.api.androidCommand(command);
      this.adopt(result.snapshot);
    } catch (error) {
      this.set({ ...this.snapshot, error: message(error) });
      throw error;
    } finally {
      this.activeCommands.delete(id);
      const busy = [...this.activeCommands.values()].at(-1);
      if (!this.disposed) this.set({ ...this.snapshot, busy });
    }
  }

  private authenticate(): Promise<void> {
    if (this.authenticatePromise) return this.authenticatePromise;
    this.authenticatePromise = this.api
      .bootstrap()
      .then(() => this.reload())
      .finally(() => {
        this.authenticatePromise = undefined;
      });
    return this.authenticatePromise;
  }

  private reload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.api
      .androidSnapshot()
      .then(snapshot => {
        if (this.disposed) return;
        this.adopt(snapshot, true);
        this.openEvents(snapshot);
      })
      .finally(() => {
        this.reloadPromise = undefined;
      });
    return this.reloadPromise;
  }

  private openEvents(snapshot: AndroidServiceSnapshot): void {
    this.source?.close();
    const source = this.api.androidEvents(`${snapshot.serviceEpoch}:${snapshot.sequence}`);
    this.source = source;
    let opened = false;
    source.addEventListener("android.snapshot", event => {
      if (this.source === source) this.onEvent(event as MessageEvent);
    });
    source.addEventListener("android.reset-required", () => {
      if (!this.disposed && this.source === source) this.recover();
    });
    source.onopen = () => {
      if (this.disposed || this.source !== source) return;
      if (!opened) {
        opened = true;
        this.set({ ...this.snapshot, connected: true });
        return;
      }
      this.recover(true);
    };
    source.onerror = () => {
      if (!this.disposed && this.source === source) this.set({ ...this.snapshot, connected: false });
    };
    this.set({ ...this.snapshot, connected: false });
  }

  private onEvent(messageEvent: MessageEvent): void {
    if (typeof messageEvent.data !== "string" || messageEvent.data.length > ANDROID_EVENT_MAX_BYTES) {
      this.recover();
      return;
    }
    let event: AndroidServiceEvent;
    try {
      event = JSON.parse(messageEvent.data) as AndroidServiceEvent;
    } catch {
      this.recover();
      return;
    }
    const current = this.snapshot.service;
    if (
      event.protocolVersion !== ANDROID_PROTOCOL_VERSION ||
      event.type !== "android.snapshot" ||
      !current ||
      event.serviceEpoch !== current.serviceEpoch ||
      event.sequence !== current.sequence + 1
    ) {
      this.recover();
      return;
    }
    this.adopt({
      protocolVersion: event.protocolVersion,
      serviceEpoch: event.serviceEpoch,
      sequence: event.sequence,
      serviceRevision: event.serviceRevision,
      runner: event.payload.runner,
      ...(event.payload.project ? { project: event.payload.project } : {}),
      ...(event.payload.build ? { build: event.payload.build } : {}),
      ...(event.payload.run ? { run: event.payload.run } : {}),
      ...(event.payload.lastError ? { lastError: event.payload.lastError } : {}),
    });
  }

  private recover(reauthenticate = false): void {
    if (this.disposed) return;
    this.source?.close();
    this.source = undefined;
    this.set({ ...this.snapshot, connected: false });
    const recovery = reauthenticate ? this.authenticate() : this.reload();
    void recovery.catch(error => this.fail(error));
  }

  private adopt(service: AndroidServiceSnapshot, replaceEpoch = false): void {
    const current = this.snapshot.service;
    if (!replaceEpoch && current) {
      if (service.serviceEpoch !== current.serviceEpoch || service.sequence < current.sequence) return;
    }
    this.set({ status: "ready", service, connected: this.snapshot.connected, busy: this.snapshot.busy });
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.set({ ...this.snapshot, status: "error", connected: false, error: message(error) });
  }

  private set(snapshot: AndroidStoreSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const androidStore = new AndroidStore();

export function useAndroidStore(): AndroidStoreSnapshot {
  return useSyncExternalStore(androidStore.subscribe, androidStore.getSnapshot, androidStore.getSnapshot);
}

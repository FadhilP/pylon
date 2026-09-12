import { randomUUID } from "node:crypto";
import {
  ANDROID_EMULATOR_MAX_START_TIMEOUT_MS,
  AndroidEmulatorStartupCleanupError,
  AndroidSdk,
  type AndroidEmulatorStartPhase,
  type AndroidUncertainEmulator,
} from "./android-sdk.js";
import type { AndroidSpawn } from "./types.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const MAX_CLEANUP_TIMEOUT_MS = 30_000;
const MAX_DRAIN_TIMEOUT_MS = 30_000;

function boundedIssue(error: unknown): string {
  const message = error instanceof Error ? error.message : "Android discovery failed";
  return (
    message
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 500) || "Android discovery failed"
  );
}

export type AndroidRunnerLifecycle = "active" | "disposing" | "cleanup-required" | "disposed";
export type AndroidRunnerDiscoveryState = "idle" | "refreshing" | "ready" | "unavailable";
export type AndroidRunnerDeviceState =
  "starting" | "booting" | "ready" | "cancelled" | "failed" | "stopping" | "cleanup-required";

export interface AndroidRunnerDevice {
  deviceId: string;
  serial?: string;
  avd: string;
  instanceId?: string;
  ownership: "runner" | "external";
  state: AndroidRunnerDeviceState;
  revision: number;
}

export interface AndroidRunnerSnapshot {
  lifecycle: AndroidRunnerLifecycle;
  revision: number;
  discovery: AndroidRunnerDiscoveryState;
  avds: string[];
  devices: AndroidRunnerDevice[];
  issue?: string;
}

export interface AndroidRunnerEvent {
  kind: "state-changed";
  snapshot: AndroidRunnerSnapshot;
}

export interface AndroidOwnedEmulator extends AndroidUncertainEmulator {
  stop(): Promise<void>;
}

export interface AndroidSdkController {
  listAvds(signal?: AbortSignal): Promise<string[]>;
  start(
    avd: string,
    headless: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
    onPhase?: (phase: AndroidEmulatorStartPhase) => void,
  ): Promise<AndroidOwnedEmulator>;
  devices?(signal?: AbortSignal): Promise<Array<{ serial: string; state: string }>>;
  avdName?(serial: string, signal?: AbortSignal): Promise<string>;
  bootId?(serial: string, signal?: AbortSignal): Promise<string>;
}

export interface AndroidRunnerOptions {
  env?: NodeJS.ProcessEnv;
  spawnProcess?: AndroidSpawn;
  createSdk?: () => Promise<AndroidSdkController>;
  idFactory?: () => string;
  drainTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export class AndroidRunnerStartError extends Error {
  readonly deviceId: string;
  readonly cleanupRequired: boolean;

  constructor(deviceId: string, cleanupRequired: boolean, cause: unknown) {
    super(
      cleanupRequired
        ? "Android emulator startup failed and requires owned-process cleanup"
        : "Android emulator startup failed",
      { cause },
    );
    this.name = "AndroidRunnerStartError";
    this.deviceId = deviceId;
    this.cleanupRequired = cleanupRequired;
  }
}

interface ManagedDevice {
  record: AndroidRunnerDevice;
  controller?: AbortController;
  cleanup?: () => Promise<void>;
  cleanupOperation?: Promise<void>;
}

export class AndroidRunner {
  private readonly createSdk: () => Promise<AndroidSdkController>;
  private readonly idFactory: () => string;
  private readonly drainTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly devices = new Map<string, ManagedDevice>();
  private readonly listeners = new Set<(event: AndroidRunnerEvent) => void>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private sdkPromise?: Promise<AndroidSdkController>;
  private mutationTail: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private lifecycle: AndroidRunnerLifecycle = "active";
  private revision = 0;
  private discovery: AndroidRunnerDiscoveryState = "idle";
  private avds: string[] = [];
  private issue?: string;

  constructor(options: AndroidRunnerOptions = {}) {
    if (
      options.drainTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.drainTimeoutMs) ||
        options.drainTimeoutMs < 1 ||
        options.drainTimeoutMs > MAX_DRAIN_TIMEOUT_MS)
    ) {
      throw new Error(`AndroidRunner drain timeout must be between 1 and ${MAX_DRAIN_TIMEOUT_MS}ms`);
    }
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > MAX_CLEANUP_TIMEOUT_MS) {
      throw new Error(`cleanupTimeoutMs must be an integer between 1 and ${MAX_CLEANUP_TIMEOUT_MS}`);
    }
    this.createSdk = options.createSdk ?? (() => AndroidSdk.create(options.env ?? process.env, options.spawnProcess));
    this.idFactory = options.idFactory ?? randomUUID;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
  }

  snapshot(): AndroidRunnerSnapshot {
    return {
      lifecycle: this.lifecycle,
      revision: this.revision,
      discovery: this.discovery,
      avds: [...this.avds],
      devices: [...this.devices.values()].map(({ record }) => ({ ...record })),
      ...(this.issue ? { issue: this.issue } : {}),
    };
  }

  subscribe(listener: (event: AndroidRunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listAvds(signal?: AbortSignal): Promise<string[]> {
    this.requireActive();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const operationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const operation = Promise.resolve()
      .then(() => this.sdk())
      .then(sdk => sdk.listAvds(operationSignal))
      .finally(() => this.activeControllers.delete(controller));
    return this.track(operation);
  }

  refresh(signal?: AbortSignal): Promise<AndroidRunnerSnapshot> {
    this.requireActive();
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.activeControllers.add(controller);
    return this.mutate(async () => {
      this.discovery = "refreshing";
      this.issue = undefined;
      this.changed();
      try {
        const sdk = await this.sdk();
        const avds = await sdk.listAvds(operationSignal);
        if (!sdk.devices || !sdk.avdName) throw new Error("Android emulator discovery is unavailable");
        const identities: Array<{ serial: string; avd: string; instanceId?: string }> = [];
        for (const device of await sdk.devices(operationSignal)) {
          if (device.state !== "device" || !/^emulator-(?:0|[1-9]\d{0,4})$/.test(device.serial)) continue;
          const avd = await sdk.avdName(device.serial, operationSignal);
          const instanceId = sdk.bootId ? await sdk.bootId(device.serial, operationSignal) : undefined;
          identities.push({ serial: device.serial, avd, ...(instanceId ? { instanceId } : {}) });
        }
        this.avds = [...avds];
        this.reconcileExternalDevices(identities);
        this.discovery = "ready";
        this.issue = undefined;
        this.changed();
      } catch (error) {
        if (operationSignal.aborted) throw error;
        this.discovery = "unavailable";
        this.issue = boundedIssue(error);
        this.changed();
      } finally {
        this.activeControllers.delete(controller);
      }
      return this.snapshot();
    });
  }

  startEmulator(
    avd: string,
    options: { headless?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AndroidRunnerDevice> {
    this.requireActive();
    if (!avd || avd.length > 200 || /[\r\n\0]/.test(avd)) throw new Error("Android AVD name is invalid");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > ANDROID_EMULATOR_MAX_START_TIMEOUT_MS)
    ) {
      throw new Error(
        `Android emulator startup timeout must be between 1 and ${ANDROID_EMULATOR_MAX_START_TIMEOUT_MS}ms`,
      );
    }
    const deviceId = this.idFactory();
    if (!deviceId || deviceId.length > 200) throw new Error("Android device ID is invalid");
    if (this.devices.has(deviceId)) throw new Error(`Android device ID already exists: ${deviceId}`);

    const controller = new AbortController();
    const operationSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const managed: ManagedDevice = {
      controller,
      record: { deviceId, avd, ownership: "runner", state: "starting", revision: 0 },
    };
    this.devices.set(deviceId, managed);
    this.activeControllers.add(controller);

    const markCancelled = () => {
      if (managed.record.state !== "starting" && managed.record.state !== "booting") return;
      managed.record.state = "cancelled";
      this.changed(managed);
    };
    operationSignal.addEventListener("abort", markCancelled, { once: true });

    const operation = this.mutate(async () => {
      try {
        if (operationSignal.aborted) {
          this.handleStartFailure(managed, new Error("Android emulator startup cancelled"), true);
        }
        const sdk = await this.sdk().catch(error => this.handleStartFailure(managed, error, operationSignal.aborted));
        let emulator: AndroidOwnedEmulator;
        try {
          emulator = await sdk.start(avd, options.headless ?? false, operationSignal, options.timeoutMs, phase =>
            this.updateStartPhase(managed, phase),
          );
        } catch (error) {
          this.handleStartFailure(managed, error, operationSignal.aborted);
        }

        managed.record.serial = emulator!.serial;
        managed.record.avd = emulator!.avd;
        managed.cleanup = () => emulator!.stop();
        if (operationSignal.aborted) {
          managed.record.state = "cancelled";
          this.changed(managed);
          try {
            await managed.cleanup();
            this.devices.delete(deviceId);
            this.changed();
            throw new AndroidRunnerStartError(deviceId, false, new Error("Android emulator startup cancelled"));
          } catch (error) {
            if (error instanceof AndroidRunnerStartError) throw error;
            managed.record.state = "cleanup-required";
            this.changed(managed);
            throw new AndroidRunnerStartError(deviceId, true, error);
          }
        }

        managed.record.state = "ready";
        this.changed(managed);
        return { ...managed.record };
      } finally {
        operationSignal.removeEventListener("abort", markCancelled);
        managed.controller = undefined;
        this.activeControllers.delete(controller);
      }
    });
    this.changed(managed);
    if (operationSignal.aborted) markCancelled();
    return operation;
  }

  cancelOperation(deviceId: string, expectedRevision?: number): void {
    this.requireActive();
    const managed = this.devices.get(deviceId);
    if (!managed?.controller) throw new Error(`Android device operation is not cancellable: ${deviceId}`);
    this.requireDeviceRevision(managed, expectedRevision);
    managed.controller.abort();
  }

  stopEmulator(deviceId: string, expectedRevision?: number): Promise<void> {
    this.requireCleanupAvailable();
    return this.mutate(() => this.stopManaged(deviceId, expectedRevision));
  }

  dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    let resolveDispose!: () => void;
    let rejectDispose!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    this.disposePromise = gate.finally(() => {
      this.disposePromise = undefined;
    });
    this.lifecycle = "disposing";
    this.changed();
    for (const controller of this.activeControllers) controller.abort();
    void this.disposeOwnedResources().then(resolveDispose, rejectDispose);
    return this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    if (!(await this.drainActiveOperations())) {
      this.lifecycle = "cleanup-required";
      this.changed();
      throw new Error(`AndroidRunner operations did not stop within ${this.drainTimeoutMs}ms`);
    }

    const owned: string[] = [];
    for (const [deviceId, managed] of [...this.devices]) {
      if (managed.cleanup) {
        owned.push(deviceId);
      } else {
        this.devices.delete(deviceId);
        this.changed();
      }
    }

    const settled = Promise.allSettled(owned.map(deviceId => this.stopManaged(deviceId)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), this.cleanupTimeoutMs);
    });
    const outcome = await Promise.race([settled, expired]);
    if (timer) clearTimeout(timer);
    if (outcome === false) {
      for (const deviceId of owned) {
        const managed = this.devices.get(deviceId);
        if (managed?.cleanupOperation) {
          managed.record.state = "cleanup-required";
          this.changed(managed);
        }
      }
      this.lifecycle = "cleanup-required";
      this.changed();
      throw new Error(`AndroidRunner cleanup did not finish within ${this.cleanupTimeoutMs}ms`);
    }

    const failures = outcome.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) {
      this.lifecycle = "cleanup-required";
      this.changed();
      throw new AggregateError(failures, "AndroidRunner could not clean up every owned emulator");
    }
    this.lifecycle = "disposed";
    this.changed();
    this.listeners.clear();
  }

  private async drainActiveOperations(): Promise<boolean> {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.activeOperations.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const settled = Promise.allSettled([...this.activeOperations]).then(() => true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), remaining);
      });
      const completed = await Promise.race([settled, expired]);
      if (timer) clearTimeout(timer);
      if (!completed) return false;
    }
    return true;
  }

  private handleStartFailure(managed: ManagedDevice, error: unknown, cancelled: boolean): never {
    if (error instanceof AndroidEmulatorStartupCleanupError) {
      managed.record.serial = error.emulator.serial;
      managed.record.avd = error.emulator.avd;
      managed.record.state = "cleanup-required";
      managed.cleanup = () => error.emulator.cleanupUncertainStart();
      this.changed(managed);
      throw new AndroidRunnerStartError(managed.record.deviceId, true, error);
    }
    managed.record.state = cancelled ? "cancelled" : "failed";
    this.changed(managed);
    this.devices.delete(managed.record.deviceId);
    this.changed();
    throw new AndroidRunnerStartError(managed.record.deviceId, false, error);
  }

  private updateStartPhase(managed: ManagedDevice, phase: AndroidEmulatorStartPhase): void {
    if (managed.record.state === "cancelled") return;
    if (managed.record.state === phase) return;
    managed.record.state = phase;
    this.changed(managed);
  }

  private reconcileExternalDevices(identities: Array<{ serial: string; avd: string; instanceId?: string }>): void {
    const bySerial = new Map<string, { serial: string; avd: string; instanceId?: string }>();
    for (const identity of identities) {
      if (bySerial.has(identity.serial)) throw new Error(`Android emulator ${identity.serial} is ambiguous`);
      bySerial.set(identity.serial, identity);
    }
    const nextRevision = this.revision + 1;

    for (const managed of this.devices.values()) {
      if (managed.record.ownership !== "runner" || !managed.record.serial) continue;
      const identity = bySerial.get(managed.record.serial);
      if (
        identity?.avd === managed.record.avd &&
        (!managed.record.instanceId || !identity.instanceId || identity.instanceId === managed.record.instanceId)
      ) {
        if (!managed.record.instanceId && identity.instanceId) managed.record.instanceId = identity.instanceId;
        bySerial.delete(managed.record.serial);
      } else if (managed.record.state === "ready") {
        managed.record.state = "cleanup-required";
        managed.record.revision = nextRevision;
      }
    }

    for (const [deviceId, managed] of [...this.devices]) {
      if (managed.record.ownership !== "external" || !managed.record.serial) continue;
      const identity = bySerial.get(managed.record.serial);
      if (
        identity?.avd === managed.record.avd &&
        (!managed.record.instanceId || !identity.instanceId || identity.instanceId === managed.record.instanceId)
      ) {
        if (!managed.record.instanceId && identity.instanceId) managed.record.instanceId = identity.instanceId;
        bySerial.delete(managed.record.serial);
      } else {
        this.devices.delete(deviceId);
      }
    }

    for (const identity of bySerial.values()) {
      const deviceId = this.allocateDeviceId();
      this.devices.set(deviceId, {
        record: {
          deviceId,
          serial: identity.serial,
          avd: identity.avd,
          ...(identity.instanceId ? { instanceId: identity.instanceId } : {}),
          ownership: "external",
          state: "ready",
          revision: nextRevision,
        },
      });
    }
  }

  private allocateDeviceId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const deviceId = this.idFactory();
      if (deviceId && deviceId.length <= 200 && !this.devices.has(deviceId)) return deviceId;
    }
    throw new Error("Could not allocate a unique Android device ID");
  }

  private requireDeviceRevision(managed: ManagedDevice, expectedRevision?: number): void {
    if (expectedRevision === undefined) return;
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      managed.record.revision !== expectedRevision
    ) {
      throw new Error(`Android device revision is stale: ${managed.record.deviceId}`);
    }
  }

  private async sdk(): Promise<AndroidSdkController> {
    this.sdkPromise ??= Promise.resolve()
      .then(this.createSdk)
      .catch(error => {
        this.sdkPromise = undefined;
        throw error;
      });
    return this.sdkPromise;
  }

  private async stopManaged(deviceId: string, expectedRevision?: number): Promise<void> {
    const managed = this.devices.get(deviceId);
    if (!managed) throw new Error(`Android device is unavailable: ${deviceId}`);
    this.requireDeviceRevision(managed, expectedRevision);
    if (managed.record.ownership !== "runner" || !managed.cleanup) {
      throw new Error(`Android device is externally owned: ${deviceId}`);
    }
    if (managed.cleanupOperation) return managed.cleanupOperation;

    const operation = (async () => {
      managed.record.state = "stopping";
      this.changed(managed);
      try {
        await managed.cleanup!();
        this.devices.delete(deviceId);
        this.changed();
      } catch (error) {
        managed.record.state = "cleanup-required";
        this.changed(managed);
        throw error;
      }
    })();
    managed.cleanupOperation = operation;
    try {
      await operation;
    } finally {
      if (managed.cleanupOperation === operation) managed.cleanupOperation = undefined;
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return this.track(result);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => this.activeOperations.delete(tracked));
    this.activeOperations.add(tracked);
    return tracked;
  }

  private requireActive(): void {
    if (this.lifecycle !== "active") throw new Error(`AndroidRunner is ${this.lifecycle}`);
  }

  private requireCleanupAvailable(): void {
    if (this.lifecycle !== "active" && this.lifecycle !== "cleanup-required") {
      throw new Error(`AndroidRunner is ${this.lifecycle}`);
    }
  }

  private changed(managed?: ManagedDevice): void {
    this.revision += 1;
    if (managed) managed.record.revision = this.revision;
    const event: AndroidRunnerEvent = { kind: "state-changed", snapshot: this.snapshot() };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

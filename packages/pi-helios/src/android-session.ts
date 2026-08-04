import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AndroidSdk, type OwnedEmulator } from "./android-sdk.ts";
import { androidSnapshot, sameAndroidElement, type AndroidElementRef, type AndroidSnapshot } from "./android-source.ts";
import { AppiumClient, AppiumServer, resolveAppium, type AppiumInvocation } from "./appium.ts";
import type { Exec } from "./capture.ts";

export type AndroidOwnership = "owned" | "attached";
export type AndroidState = "starting" | "ready" | "cleanup-required" | "closing" | "closed";
export type AndroidAction =
  | { kind: "snapshot" }
  | { kind: "find"; text: string }
  | { kind: "screenshot" }
  | { kind: "tap"; target: string }
  | { kind: "fill"; target: string; text: string }
  | { kind: "back" }
  | { kind: "swipe"; direction: "up" | "down" | "left" | "right"; distance: number };

export interface AndroidSessionRecord {
  piSessionId: string;
  ownership: AndroidOwnership;
  state: AndroidState;
  serial: string;
  avd: string;
  packageName: string;
  appiumVersion?: string;
  createdAt: number;
}

export interface AndroidOperationResult {
  action: string;
  ownership: AndroidOwnership;
  outcome: "completed";
  serial: string;
  avd: string;
  packageName: string;
  durationMs?: number;
  snapshot?: string;
  snapshotRedactions?: number;
  snapshotTruncated?: boolean;
  snapshotOmittedLines?: number;
  snapshotOmittedBytes?: number;
  findMatches?: number;
  artifactPath?: string;
  cleanupWarnings?: string[];
}

export interface AndroidShutdownResult {
  failures: Array<{ ownership: AndroidOwnership; action: "close" | "detach"; serial: string }>;
  cleanupWarnings: string[];
}

interface SdkLike {
  start(avd: string, headless: boolean, signal?: AbortSignal): Promise<OwnedEmulator>;
  verifyAttached(serial: string, signal?: AbortSignal): Promise<{ serial: string; avd: string }>;
}
interface ServerLike { url: string; version: string; stop(): Promise<void> }
interface ClientLike {
  sessionId?: string;
  createSession(capabilities: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  deleteSession(signal?: AbortSignal): Promise<void>;
  currentPackage(signal?: AbortSignal): Promise<string>;
  source(signal?: AbortSignal): Promise<string>;
  screenshot(signal?: AbortSignal): Promise<Buffer>;
  windowRect(signal?: AbortSignal): Promise<{ width: number; height: number }>;
  tap(x: number, y: number, signal?: AbortSignal): Promise<void>;
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, signal?: AbortSignal): Promise<void>;
  findByXpath(xpath: string, signal?: AbortSignal): Promise<string>;
  fillElement(elementId: string, text: string, signal?: AbortSignal): Promise<void>;
  back(signal?: AbortSignal): Promise<void>;
}

interface Managed {
  record: AndroidSessionRecord;
  sdk?: SdkLike;
  directory?: string;
  emulator?: OwnedEmulator;
  server?: ServerLike;
  client?: ClientLike;
  references: Map<string, AndroidElementRef>;
  tail: Promise<void>;
  closingRequested: boolean;
}

export interface AndroidSessionDependencies {
  createSdk(exec: Exec): Promise<SdkLike>;
  resolveAppium(exec: Exec, signal?: AbortSignal): Promise<AppiumInvocation>;
  startServer(invocation: AppiumInvocation, signal?: AbortSignal): Promise<ServerLike>;
  createClient(endpoint: string): ClientLike;
}

const DEFAULT_DEPENDENCIES: AndroidSessionDependencies = {
  createSdk: (exec) => AndroidSdk.create(exec),
  resolveAppium,
  startServer: (invocation, signal) => AppiumServer.start(invocation, signal),
  createClient: (endpoint) => new AppiumClient(endpoint),
};

function validatePackage(value: string): string {
  if (value.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)) throw new Error("Android appPackage must be a Java-style package name");
  return value;
}

function validateActivity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 500 || /[\r\n\0]/.test(value)) throw new Error("Android appActivity is invalid");
  return value;
}

function capabilities(serial: string, packageName: string, activity?: string): Record<string, unknown> {
  return {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": serial,
    "appium:appPackage": packageName,
    ...(activity ? { "appium:appActivity": activity } : {}),
    "appium:noReset": true,
    "appium:shouldTerminateApp": false,
    "appium:autoGrantPermissions": false,
    "appium:newCommandTimeout": 300,
  };
}

function targetRef(value: string): string {
  if (!/^a[1-9]\d{0,5}$/.test(value)) throw new Error("Android target must be a current snapshot reference such as a1");
  return value;
}

export class AndroidSessionManager {
  private readonly sessions = new Map<string, Managed>();
  private readonly exec: Exec;
  private readonly dependencies: AndroidSessionDependencies;
  private shuttingDown = false;

  constructor(exec: Exec, dependencies: Partial<AndroidSessionDependencies> = {}) {
    this.exec = exec;
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  get(piSessionId: string): AndroidSessionRecord | undefined {
    const record = this.sessions.get(piSessionId)?.record;
    return record ? { ...record } : undefined;
  }

  summary(): { total: number; owned: number; attached: number; cleanupRequired: number } {
    const records = [...this.sessions.values()].map((item) => item.record);
    return {
      total: records.length,
      owned: records.filter((item) => item.ownership === "owned").length,
      attached: records.filter((item) => item.ownership === "attached").length,
      cleanupRequired: records.filter((item) => item.state === "cleanup-required").length,
    };
  }

  async start(piSessionId: string, avd: string, packageName: string, activity?: string, headless = false, signal?: AbortSignal): Promise<AndroidOperationResult> {
    packageName = validatePackage(packageName);
    activity = validateActivity(activity);
    if (!avd || avd.length > 200 || /[\r\n\0]/.test(avd)) throw new Error("Android AVD name is invalid");
    const managed = this.reserve(piSessionId, "owned", packageName);
    return this.serialized(managed, async () => {
      try {
        await this.prepare(managed);
        this.assertStartupActive(managed);
        managed.emulator = await managed.sdk!.start(avd, headless, signal);
        managed.record.serial = managed.emulator.serial;
        managed.record.avd = managed.emulator.avd;
        this.assertStartupActive(managed);
        return await this.startAutomation(managed, activity, signal);
      } catch (error) {
        await this.cleanupFailedStart(managed);
        if (managed.record.state === "cleanup-required" && error instanceof Error) error.message += "; Android cleanup is uncertain, retry close";
        throw error;
      }
    });
  }

  async attach(piSessionId: string, serial: string, packageName: string, activity?: string, signal?: AbortSignal): Promise<AndroidOperationResult> {
    packageName = validatePackage(packageName);
    activity = validateActivity(activity);
    const managed = this.reserve(piSessionId, "attached", packageName);
    return this.serialized(managed, async () => {
      try {
        await this.prepare(managed);
        this.assertStartupActive(managed);
        const attached = await managed.sdk!.verifyAttached(serial, signal);
        managed.record.serial = attached.serial;
        managed.record.avd = attached.avd;
        this.assertStartupActive(managed);
        return await this.startAutomation(managed, activity, signal);
      } catch (error) {
        await this.cleanupFailedStart(managed);
        if (managed.record.state === "cleanup-required" && error instanceof Error) error.message += "; Android cleanup is uncertain, retry detach";
        throw error;
      }
    });
  }

  private reserve(piSessionId: string, ownership: AndroidOwnership, packageName: string): Managed {
    if (this.shuttingDown) throw new Error("Helios Android manager is shutting down");
    if (this.sessions.has(piSessionId)) throw new Error("Pi session already has an active Helios Android session");
    const record: AndroidSessionRecord = {
      piSessionId, ownership, state: "starting", serial: "pending", avd: "pending", packageName, createdAt: Date.now(),
    };
    const managed: Managed = { record, references: new Map(), tail: Promise.resolve(), closingRequested: false };
    this.sessions.set(piSessionId, managed);
    return managed;
  }

  private async prepare(managed: Managed): Promise<void> {
    managed.sdk = await this.dependencies.createSdk(this.exec);
    this.assertStartupActive(managed);
    managed.directory = await mkdtemp(join(tmpdir(), "pi-helios-android-"));
    await chmod(managed.directory, 0o700).catch(() => {});
  }

  private assertStartupActive(managed: Managed): void {
    if (managed.closingRequested || this.shuttingDown) throw new Error("Android startup interrupted by cleanup");
  }

  private async startAutomation(managed: Managed, activity: string | undefined, signal?: AbortSignal): Promise<AndroidOperationResult> {
    const startedAt = Date.now();
    const invocation = await this.dependencies.resolveAppium(this.exec, signal);
    this.assertStartupActive(managed);
    managed.server = await this.dependencies.startServer(invocation, signal);
    managed.record.appiumVersion = managed.server.version;
    this.assertStartupActive(managed);
    managed.client = this.dependencies.createClient(managed.server.url);
    await managed.client.createSession(capabilities(managed.record.serial, managed.record.packageName, activity), signal);
    this.assertStartupActive(managed);
    const snapshot = androidSnapshot(await this.checkedSource(managed, signal), managed.record.packageName);
    this.assertStartupActive(managed);
    managed.references = snapshot.refs;
    managed.record.state = "ready";
    return this.result(managed, managed.record.ownership === "owned" ? "start" : "attach", snapshot, startedAt);
  }

  async operate(piSessionId: string, action: AndroidAction, signal?: AbortSignal): Promise<AndroidOperationResult> {
    const managed = this.requireManaged(piSessionId);
    return this.serialized(managed, async () => {
      if (managed.record.state !== "ready" || managed.closingRequested) throw new Error(`Android session is ${managed.closingRequested ? "closing" : managed.record.state}`);
      const startedAt = Date.now();
      const client = managed.client!;
      if (action.kind === "snapshot" || action.kind === "find") {
        const snapshot = androidSnapshot(await this.checkedSource(managed, signal), managed.record.packageName, action.kind === "find" ? { text: action.text } : undefined);
        managed.references = snapshot.refs;
        return this.result(managed, action.kind, snapshot, startedAt);
      }
      if (action.kind === "screenshot") {
        await this.assertExpectedPackage(managed, signal);
        const image = await client.screenshot(signal);
        await this.assertCurrentPackage(managed, signal);
        const artifactPath = join(managed.directory!, `screenshot-${randomUUID()}.png`);
        await writeFile(artifactPath, image, { mode: 0o600, flag: "wx" });
        return { ...this.result(managed, action.kind, undefined, startedAt), artifactPath };
      }
      if (action.kind === "tap" || action.kind === "fill") {
        const ref = targetRef(action.target);
        const target = managed.references.get(ref);
        if (!target) throw new Error(`Android element reference ${ref} is stale or was not returned by latest snapshot`);
        const current = androidSnapshot(await this.checkedSource(managed, signal), managed.record.packageName);
        const verified = sameAndroidElement(current, target);
        if (!verified) { managed.references.clear(); throw new Error(`Android element reference ${ref} is stale`); }
        if (!verified.enabled) throw new Error(`Android element reference ${ref} is disabled`);
        const rect = await client.windowRect(signal);
        const x = Math.floor((verified.bounds.left + verified.bounds.right) / 2);
        const y = Math.floor((verified.bounds.top + verified.bounds.bottom) / 2);
        if (verified.bounds.left < 0 || verified.bounds.top < 0 || verified.bounds.right > rect.width || verified.bounds.bottom > rect.height
          || x < 0 || y < 0 || x >= rect.width || y >= rect.height) throw new Error(`Android element reference ${ref} is outside the current viewport`);
        try {
          if (action.kind === "tap") {
            await this.assertCurrentPackage(managed, signal);
            await client.tap(x, y, signal);
          } else {
            if (!verified.editable) throw new Error(`Android element reference ${ref} is not editable`);
            if (action.text.length > 10_000) throw new Error("Android fill text exceeds 10000 characters");
            const latest = androidSnapshot(await this.checkedSource(managed, signal), managed.record.packageName);
            const latestTarget = sameAndroidElement(latest, target);
            if (!latestTarget) throw new Error(`Android element reference ${ref} changed before fill`);
            const elementId = await client.findByXpath(latestTarget.xpath, signal);
            await this.assertCurrentPackage(managed, signal);
            await client.fillElement(elementId, action.text, signal);
          }
          return this.result(managed, action.kind, undefined, startedAt);
        } finally {
          managed.references.clear();
        }
      }
      await this.assertExpectedPackage(managed, signal);
      try {
        if (action.kind === "back") {
          await this.assertCurrentPackage(managed, signal);
          await client.back(signal);
        } else {
          if (!Number.isInteger(action.distance) || action.distance < 10 || action.distance > 90) throw new Error("Android swipe distance must be an integer percentage from 10 to 90");
          const rect = await client.windowRect(signal);
          const center = { x: Math.floor(rect.width / 2), y: Math.floor(rect.height / 2) };
          const amount = Math.floor((action.direction === "up" || action.direction === "down" ? rect.height : rect.width) * action.distance / 200);
          const from = { ...center }, to = { ...center };
          if (action.direction === "up") { from.y += amount; to.y -= amount; }
          if (action.direction === "down") { from.y -= amount; to.y += amount; }
          if (action.direction === "left") { from.x += amount; to.x -= amount; }
          if (action.direction === "right") { from.x -= amount; to.x += amount; }
          await this.assertCurrentPackage(managed, signal);
          await client.swipe(from, to, signal);
        }
        return this.result(managed, action.kind, undefined, startedAt);
      } finally {
        managed.references.clear();
      }
    });
  }

  private async assertCurrentPackage(managed: Managed, signal?: AbortSignal): Promise<void> {
    const current = await managed.client!.currentPackage(signal);
    if (current !== managed.record.packageName) throw new Error(`Android UI left expected package ${managed.record.packageName}; current package: ${current}`);
  }

  private async checkedSource(managed: Managed, signal?: AbortSignal): Promise<string> {
    await this.assertCurrentPackage(managed, signal);
    return managed.client!.source(signal);
  }

  private async assertExpectedPackage(managed: Managed, signal?: AbortSignal): Promise<void> {
    androidSnapshot(await this.checkedSource(managed, signal), managed.record.packageName);
  }

  async close(piSessionId: string, requested: "close" | "detach", _signal?: AbortSignal): Promise<AndroidOperationResult> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios Android session");
    if (requested === "close" && managed.record.ownership !== "owned") throw new Error("Attached Android emulators may only be detached");
    if (requested === "detach" && managed.record.ownership !== "attached") throw new Error("Owned Android emulators must be closed");
    if (managed.closingRequested) throw new Error("Android session is closing");
    managed.closingRequested = true;
    return this.serialized(managed, () => this.finishCleanup(managed, requested));
  }

  async shutdown(): Promise<AndroidShutdownResult> {
    this.shuttingDown = true;
    const summary: AndroidShutdownResult = { failures: [], cleanupWarnings: [] };
    await Promise.all([...this.sessions.values()].map(async (managed) => {
      const action = managed.record.ownership === "owned" ? "close" : "detach";
      managed.closingRequested = true;
      try {
        const result = await this.serialized(managed, () => this.finishCleanup(managed, action));
        summary.cleanupWarnings.push(...(result.cleanupWarnings ?? []));
      } catch {
        summary.failures.push({ ownership: managed.record.ownership, action, serial: managed.record.serial });
      }
    }));
    return summary;
  }

  private async finishCleanup(managed: Managed, action: "close" | "detach"): Promise<AndroidOperationResult> {
    const startedAt = Date.now();
    managed.record.state = "closing";
    const { warnings, failure } = await this.cleanupResources(managed);
    if (failure) {
      managed.record.state = "cleanup-required";
      managed.closingRequested = false;
      throw failure;
    }
    if (managed.directory) {
      try { await rm(managed.directory, { recursive: true, force: true }); }
      catch (error) {
        managed.record.state = "cleanup-required";
        managed.closingRequested = false;
        throw error;
      }
    }
    managed.record.state = "closed";
    if (this.sessions.get(managed.record.piSessionId) === managed) this.sessions.delete(managed.record.piSessionId);
    return { ...this.result(managed, action, undefined, startedAt), cleanupWarnings: warnings.length ? warnings : undefined };
  }

  private async cleanupResources(managed: Managed): Promise<{ warnings: string[]; failure?: unknown }> {
    const warnings: string[] = [];
    await managed.client?.deleteSession().catch(() => warnings.push("Could not delete Appium session before server shutdown"));
    let serverFailure: unknown;
    try { await managed.server?.stop(); } catch (error) { serverFailure = error; }
    let emulatorFailure: unknown;
    if (managed.record.ownership === "owned") {
      try { await managed.emulator?.stop(); } catch (error) { emulatorFailure = error; }
    }
    return { warnings, failure: emulatorFailure ?? serverFailure };
  }

  private requireManaged(piSessionId: string): Managed {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios Android session; use start or attach first");
    return managed;
  }

  private async cleanupFailedStart(managed: Managed): Promise<void> {
    const warnings: unknown[] = [];
    await managed.client?.deleteSession().catch((error) => warnings.push(error));
    await managed.server?.stop().catch((error) => warnings.push(error));
    if (managed.record.ownership === "owned") await managed.emulator?.cleanupUncertainStart().catch((error) => warnings.push(error));
    if (warnings.length) {
      managed.record.state = "cleanup-required";
      return;
    }
    if (managed.closingRequested) {
      managed.record.state = "closing";
      return;
    }
    if (managed.directory) {
      try { await rm(managed.directory, { recursive: true, force: true }); }
      catch {
        managed.record.state = "cleanup-required";
        return;
      }
    }
    managed.record.state = "closed";
    if (this.sessions.get(managed.record.piSessionId) === managed) this.sessions.delete(managed.record.piSessionId);
  }

  private result(managed: Managed, action: string, snapshot?: AndroidSnapshot, startedAt = Date.now()): AndroidOperationResult {
    return {
      action,
      ownership: managed.record.ownership,
      outcome: "completed",
      serial: managed.record.serial,
      avd: managed.record.avd,
      packageName: managed.record.packageName,
      durationMs: Date.now() - startedAt,
      snapshot: snapshot?.text,
      snapshotRedactions: snapshot?.redactions,
      snapshotTruncated: snapshot?.truncated,
      snapshotOmittedLines: snapshot?.omittedLines,
      snapshotOmittedBytes: snapshot?.omittedBytes,
      findMatches: snapshot?.matches,
    };
  }

  private serialized<T>(managed: Managed, operation: () => Promise<T>): Promise<T> {
    const result = managed.tail.then(operation, operation);
    managed.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

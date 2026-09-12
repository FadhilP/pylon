import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createAndroidExec } from "./android-exec.js";
import type { AndroidGradleBuildInput, AndroidGradleBuildResult } from "./gradle-runner.js";
import { runAndroidGradleBuild } from "./gradle-runner.js";
import {
  AndroidAppDevice,
  type AndroidBuildTools,
  type InspectedApk,
  type ApkDiscoveryInput,
  type StagedApkArtifact,
  discoverAndroidApk,
  inspectAndroidApk,
  resolveAndroidBuildTools,
  stageAndroidApk,
} from "./apk-artifact.js";
import { terminateProcessTree } from "./process.js";
import type { AndroidExec, AndroidProcessTerminator, AndroidSpawn } from "./types.js";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 5_000;
const MAX_LOG_LINE_BYTES = 16 * 1024;
const MAX_LOG_PIDS = 64;
const LOG_MARKER = "[pylon log output truncated]";
const outputLocks = new Map<string, Promise<void>>();
export type AndroidBuildRunPhase =
  | "building"
  | "finding-artifact"
  | "staging"
  | "inspecting"
  | "installing"
  | "launching"
  | "complete"
  | "install-uncertain";
export interface AndroidBuildAndRunInput {
  readonly build: AndroidGradleBuildInput;
  readonly sdkRoot: string;
  readonly buildToolsVersion?: string;
  readonly stagingRoot: string;
  readonly serial: string;
  readonly signal?: AbortSignal;
  readonly revalidate?: () => Promise<void> | void;
  readonly onPhase?: (phase: AndroidBuildRunPhase) => void;
  readonly artifact?: ApkDiscoveryInput;
}
export interface AndroidDeployedArtifact extends InspectedApk {
  readonly sha256: string;
  readonly bytes: number;
}
export interface AndroidBuildAndRunResult {
  readonly artifact: AndroidDeployedArtifact;
  readonly installed: boolean;
  readonly replaced: boolean;
  readonly installationIdentity: string;
}
export class AndroidBuildAndRunError extends Error {
  readonly artifact?: AndroidDeployedArtifact;
  readonly replaced: boolean;
  readonly installationIdentity?: string;
  constructor(
    readonly phase: AndroidBuildRunPhase,
    readonly installUncertain: boolean,
    readonly installed: boolean,
    cause: unknown,
    artifact?: AndroidDeployedArtifact,
    replaced = false,
    installationIdentity?: string,
  ) {
    super(`Android build and run failed during ${phase}`, { cause });
    this.name = "AndroidBuildAndRunError";
    this.artifact = artifact;
    this.replaced = replaced;
    this.installationIdentity = installationIdentity;
  }
}
export interface AndroidBuildAndRunOptions {
  readonly device: AndroidAppDevice;
  readonly exec?: AndroidExec;
  readonly buildRunner?: (input: AndroidGradleBuildInput) => Promise<AndroidGradleBuildResult>;
  readonly resolveTools?: (root: string, version?: string) => Promise<AndroidBuildTools>;
  readonly stage?: typeof stageAndroidApk;
}
function signalFor(input: AndroidBuildAndRunInput): AbortSignal | undefined {
  return input.signal ?? input.build.signal;
}
async function waitForOutputLock(prior: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return prior;
  if (signal.aborted) throw new Error("Android build and run was cancelled");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new Error("Android build and run was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    prior.then(
      () => {
        cleanup();
        resolve();
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}
function ensureLive(input: AndroidBuildAndRunInput): void {
  if (signalFor(input)?.aborted) throw new Error("Android build and run was cancelled");
}
function announce(input: AndroidBuildAndRunInput, phase: AndroidBuildRunPhase): void {
  try {
    input.onPhase?.(phase);
  } catch {}
}
async function gate(input: AndroidBuildAndRunInput, phase: AndroidBuildRunPhase): Promise<void> {
  ensureLive(input);
  await input.revalidate?.();
  ensureLive(input);
  announce(input, phase);
}
/** Owns ordering and authorization gates; a host need not implement command execution. */
export async function runAndroidBuildAndRun(
  input: AndroidBuildAndRunInput,
  options: AndroidBuildAndRunOptions,
): Promise<AndroidBuildAndRunResult> {
  let phase: AndroidBuildRunPhase = "building",
    staged: StagedApkArtifact | undefined,
    inspected: InspectedApk | undefined,
    installed = false,
    replaced = false,
    installationIdentity: string | undefined,
    stagedSha256 = "",
    stagedBytes = 0;
  const signal = signalFor(input);
  const exec = options.exec ?? createAndroidExec();
  const lockKey = input.artifact?.outputRoot;
  const priorLock = lockKey ? outputLocks.get(lockKey) : undefined;
  let releaseLock: (() => void) | undefined;
  const lock = lockKey
    ? new Promise<void>(resolve => {
        releaseLock = resolve;
      })
    : undefined;
  if (lockKey && lock) outputLocks.set(lockKey, lock);
  let releaseAfterPrior = false;
  try {
    if (priorLock) {
      try {
        await waitForOutputLock(priorLock, signal);
      } catch (error) {
        releaseAfterPrior = true;
        throw error;
      }
    }
    await gate(input, phase);
    const build = await (options.buildRunner ?? runAndroidGradleBuild)({ ...input.build, signal });
    if (!build.succeeded || build.cancelled) throw new Error("Android Gradle build did not succeed");
    phase = "finding-artifact";
    await gate(input, phase);
    const artifact = await discoverAndroidApk(
      input.artifact ?? {
        workspaceRoot: input.build.workspace.canonicalRoot,
        modulePath: input.build.workspace.modulePath,
        variant: input.build.workspace.variant,
      },
    );
    phase = "staging";
    await gate(input, phase);
    staged = await (options.stage ?? stageAndroidApk)(artifact.sourcePath, input.stagingRoot, artifact.sourceIdentity);
    stagedSha256 = staged.sha256;
    stagedBytes = staged.bytes;
    phase = "inspecting";
    await gate(input, phase);
    const tools = await (options.resolveTools ?? resolveAndroidBuildTools)(input.sdkRoot, input.buildToolsVersion);
    inspected = await inspectAndroidApk(staged, tools, exec, signal, artifact.packageName);
    phase = "installing";
    await gate(input, phase);
    await staged.revalidate();
    replaced = await options.device.isPackageInstalled(input.serial, inspected.packageName, signal);
    const deploymentArtifact = (): AndroidDeployedArtifact | undefined =>
      inspected ? { ...inspected, sha256: stagedSha256, bytes: stagedBytes } : undefined;
    let installError: AndroidBuildAndRunError | undefined;
    try {
      await options.device.install(input.serial, staged.path, signal);
      installed = true;
      installationIdentity = await options.device.installationIdentity(input.serial, inspected.packageName, signal);
      ensureLive(input);
    } catch (error) {
      if (!installed) announce(input, "install-uncertain");
      installError = new AndroidBuildAndRunError(
        "installing",
        !installed,
        installed,
        error,
        deploymentArtifact(),
        replaced,
        installationIdentity,
      );
    }
    const completedStaging = staged;
    staged = undefined;
    const cleanupError = await completedStaging.cleanup().then(
      () => undefined,
      error => error,
    );
    if (installError) throw installError;
    if (cleanupError) {
      throw new AndroidBuildAndRunError(
        "installing",
        false,
        true,
        cleanupError,
        deploymentArtifact(),
        replaced,
        installationIdentity,
      );
    }
    phase = "launching";
    await gate(input, phase);
    try {
      await options.device.launch(input.serial, inspected.launchableComponent, signal);
    } catch (error) {
      throw new AndroidBuildAndRunError(
        "launching",
        false,
        true,
        error,
        deploymentArtifact(),
        replaced,
        installationIdentity,
      );
    }
    announce(input, "complete");
    return { artifact: deploymentArtifact()!, installed, replaced, installationIdentity: installationIdentity! };
  } catch (error) {
    if (error instanceof AndroidBuildAndRunError) throw error;
    const uncertain = phase === "installing";
    if (uncertain) announce(input, "install-uncertain");
    throw new AndroidBuildAndRunError(
      phase,
      uncertain,
      installed,
      error,
      inspected ? { ...inspected, sha256: stagedSha256, bytes: stagedBytes } : undefined,
      replaced,
      installationIdentity,
    );
  } finally {
    const release = () => {
      if (lockKey && outputLocks.get(lockKey) === lock) outputLocks.delete(lockKey);
      releaseLock?.();
    };
    if (releaseAfterPrior && priorLock) {
      void priorLock.then(release, release);
    } else {
      try {
        if (staged) await staged.cleanup();
      } finally {
        release();
      }
    }
  }
}

export type AndroidLogcatState = "idle" | "running" | "stopped" | "disposed";
export interface AndroidLogcatOptions {
  readonly adb: string;
  readonly serial: string;
  readonly pid?: number;
  readonly pids?: readonly number[];
  readonly spawnProcess?: AndroidSpawn;
  readonly terminateProcess?: AndroidProcessTerminator;
}
/** PID-scoped Logcat. It never starts a broad Logcat process or falls back to one. */
export class AndroidPidLogcat extends EventEmitter {
  private child: ChildProcess | undefined;
  private lines: string[] = [];
  private pending = "";
  private truncated = false;
  private value: AndroidLogcatState = "idle";
  private pids: number[];
  constructor(private readonly options: AndroidLogcatOptions) {
    super();
    validateSerial(options.serial);
    this.pids = normalizePids(options.pids ?? (options.pid === undefined ? [] : [options.pid]));
  }
  get state(): AndroidLogcatState {
    return this.value;
  }
  private setState(state: AndroidLogcatState): void {
    if (this.value !== state) {
      this.value = state;
      this.emit("state", state);
    }
  }
  start(): void {
    if (this.value === "disposed") throw new Error("Android logcat is disposed");
    if (this.child) throw new Error("Android logcat is already running");
    const args = ["-s", this.options.serial, "logcat", ...this.pids.map(pid => `--pid=${pid}`), "-v", "brief"];
    const child = (this.options.spawnProcess ?? spawn)(this.options.adb, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.setState("running");
    child.stdout?.on("data", data => this.append(data));
    child.stderr?.on("data", data => this.append(data));
    child.once("close", () => {
      if (this.child === child) {
        this.child = undefined;
        if (this.value !== "disposed") this.setState("stopped");
      }
    });
    child.once("error", error => this.emit("error", error));
  }
  private retainedBytes(): number {
    const values = [...this.lines, ...(this.pending ? [this.pending] : [])];
    return (
      Buffer.byteLength(this.truncated ? `${LOG_MARKER}\n` : "") +
      values.reduce((total, line) => total + Buffer.byteLength(line), 0) +
      Math.max(0, values.length - 1)
    );
  }
  private trim(): void {
    while (this.lines.length > MAX_LOG_LINES || this.retainedBytes() > MAX_LOG_BYTES) {
      if (!this.lines.length) {
        this.pending = "";
        break;
      }
      this.lines.shift();
      this.truncated = true;
    }
  }
  private append(data: Buffer | string): void {
    const plain = Buffer.from(data)
      .toString("utf8")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
    const pieces = (this.pending + plain).split("\n");
    this.pending = pieces.pop()!.replace(/\r$/, "");
    for (const piece of pieces) {
      const line = piece.replace(/\r$/, "");
      this.lines.push(Buffer.from(line).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8"));
      if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) this.truncated = true;
    }
    if (Buffer.byteLength(this.pending) > MAX_LOG_LINE_BYTES) {
      this.pending = Buffer.from(this.pending).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8");
      this.truncated = true;
    }
    this.trim();
    this.emit("data", this.tail());
  }
  tail(): string {
    const values = [...this.lines, ...(this.pending ? [this.pending] : [])];
    return `${this.truncated ? `${LOG_MARKER}\n` : ""}${values.join("\n")}`;
  }
  clear(): void {
    this.lines = [];
    this.pending = "";
    this.truncated = false;
    this.emit("data", "");
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await (this.options.terminateProcess ?? terminateProcessTree)(child, "Android logcat", 500, 2_000);
    if (this.child === child) this.child = undefined;
    if (this.value !== "disposed") this.setState("stopped");
  }
  async refreshPids(pids: readonly number[]): Promise<void> {
    const next = normalizePids(pids);
    if (next.join(",") === this.pids.join(",")) return;
    const running = !!this.child;
    if (running) await this.stop();
    this.pids = next;
    if (running) this.start();
  }
  async dispose(): Promise<void> {
    if (this.value === "disposed") return;
    await this.stop();
    this.clear();
    this.setState("disposed");
  }
}
function validateSerial(serial: string): void {
  if (!/^(?!-)[A-Za-z0-9._:-]{1,128}$/.test(serial)) throw new Error("Android device serial is invalid");
}
function normalizePids(values: readonly number[]): number[] {
  const result = [...new Set(values)];
  if (
    !result.length ||
    result.length > MAX_LOG_PIDS ||
    result.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647)
  )
    throw new Error("Android logcat PID set is invalid");
  return result.sort((a, b) => a - b);
}

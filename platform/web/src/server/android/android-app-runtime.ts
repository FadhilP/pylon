import { lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveAndroidSdk } from "pylon-android/android-sdk";
import { AndroidAppDevice, cleanupStaleAndroidStaging } from "pylon-android/apk-artifact";
import { AndroidBuildAndRunError, AndroidPidLogcat, runAndroidBuildAndRun } from "pylon-android/app-runner";
import { createAndroidExec } from "pylon-android/android-exec";
import type {
  AndroidHostAppRuntime,
  AndroidHostBuildAndRunInput,
  AndroidHostBuildAndRunResult,
  AndroidHostLogcat,
} from "./pylon-android-host.ts";

const PID_REFRESH_MS = 2_000;
const EVENT_INTERVAL_MS = 100;

function artifact(value: {
  sha256: string;
  bytes: number;
  packageName: string;
  versionCode: string;
  versionName: string;
  minSdk: number;
  targetSdk: number;
  certificateSha256: string;
  launchableComponent: string;
  debuggable: boolean;
}) {
  return {
    sha256: value.sha256,
    bytes: value.bytes,
    packageName: value.packageName,
    versionCode: value.versionCode,
    ...(value.versionName ? { versionName: value.versionName } : {}),
    minSdk: String(value.minSdk),
    targetSdk: String(value.targetSdk),
    signingCertificateSha256: value.certificateSha256,
    launcherComponent: value.launchableComponent,
    debuggable: value.debuggable,
  };
}

export async function refreshPackageLogcatPids(
  device: Pick<AndroidAppDevice, "packagePids">,
  logcat: Pick<AndroidPidLogcat, "refreshPids" | "start" | "state" | "stop">,
  serial: string,
  packageName: string,
  signal?: AbortSignal,
): Promise<void> {
  const pids = await device.packagePids(serial, packageName, signal);
  if (signal?.aborted) return;
  if (!pids.length) {
    await logcat.stop();
    return;
  }
  await logcat.refreshPids(pids);
  if (!signal?.aborted && logcat.state === "stopped") logcat.start();
}

class PylonPackageLogcat implements AndroidHostLogcat {
  private readonly listeners = new Set<() => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private refreshController?: AbortController;
  private refreshPromise?: Promise<void>;
  private issue?: string;
  private stopped = false;

  private constructor(
    private readonly device: AndroidAppDevice,
    private readonly logcat: AndroidPidLogcat,
    private readonly serial: string,
    private readonly packageName: string,
  ) {
    const notify = () => this.scheduleNotify();
    logcat.on("data", notify);
    logcat.on("state", notify);
    logcat.on("error", error => {
      this.issue = error instanceof Error ? error.message.slice(0, 500) : "Android Logcat failed";
      this.scheduleNotify();
    });
    this.timer = setInterval(() => this.scheduleRefresh(), PID_REFRESH_MS);
    this.timer.unref?.();
  }

  static async start(device: AndroidAppDevice, adb: string, serial: string, packageName: string, signal?: AbortSignal) {
    const pids = await device.packagePids(serial, packageName, signal);
    if (!pids.length) throw new Error("Android app has no running package process");
    const logcat = new AndroidPidLogcat({ adb, serial, pids });
    const managed = new PylonPackageLogcat(device, logcat, serial, packageName);
    logcat.start();
    return managed;
  }

  snapshot() {
    return {
      output: this.logcat.tail(),
      truncated: this.logcat.tail().startsWith("[pylon log output truncated]"),
      state: this.issue
        ? ("unavailable" as const)
        : this.stopped || this.logcat.state !== "running"
          ? ("stopped" as const)
          : ("running" as const),
      ...(this.issue ? { issue: this.issue } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.logcat.clear();
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      clearInterval(this.timer);
      this.refreshController?.abort();
      await this.refreshPromise?.catch(() => undefined);
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
    }
    await this.logcat.stop();
    this.notify();
  }

  private scheduleRefresh(): void {
    if (this.stopped || this.refreshPromise) return;
    const controller = new AbortController();
    this.refreshController = controller;
    this.refreshPromise = this.refreshPids(controller.signal).finally(() => {
      if (this.refreshController === controller) this.refreshController = undefined;
      this.refreshPromise = undefined;
    });
  }

  private async refreshPids(signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) return;
    try {
      await refreshPackageLogcatPids(this.device, this.logcat, this.serial, this.packageName, signal);
    } catch (error) {
      if (this.stopped || signal.aborted) return;
      this.issue = error instanceof Error ? error.message.slice(0, 500) : "Android Logcat refresh failed";
      this.stopped = true;
      clearInterval(this.timer);
      await this.logcat.stop().catch(() => undefined);
      this.notify();
    }
  }

  private scheduleNotify(): void {
    if (this.notifyTimer || this.stopped) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.notify();
    }, EVENT_INTERVAL_MS);
    this.notifyTimer.unref?.();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.issue = error instanceof Error ? error.message.slice(0, 500) : "Android Logcat publication failed";
        this.stopped = true;
        clearInterval(this.timer);
        void this.logcat.stop().catch(() => undefined);
        break;
      }
    }
  }
}

export async function cleanupPylonAndroidStagingBase(base: string): Promise<void> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const rootState = await lstat(base);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error("Android staging root is unsafe");
  const canonicalRoot = await realpath(base);
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const path = join(canonicalRoot, entry.name);
    const state = await lstat(path);
    if (state.isSymbolicLink()) await unlink(path);
    else if (state.isDirectory()) await cleanupStaleAndroidStaging(path);
  }
}

export class PylonAndroidAppRuntime implements AndroidHostAppRuntime {
  private readonly exec = createAndroidExec();
  private context?: Promise<{ sdkRoot: string; adb: string; device: AndroidAppDevice }>;
  private readonly cleanedStaging = new Set<string>();

  async buildAndRun(input: AndroidHostBuildAndRunInput): Promise<AndroidHostBuildAndRunResult> {
    const context = await this.getContext();
    if (!this.cleanedStaging.has(input.stagingRoot)) {
      await cleanupStaleAndroidStaging(input.stagingRoot);
      this.cleanedStaging.add(input.stagingRoot);
    }
    try {
      const result = await runAndroidBuildAndRun(
        {
          build: input.build,
          ...(input.artifact ? { artifact: input.artifact } : {}),
          sdkRoot: context.sdkRoot,
          stagingRoot: input.stagingRoot,
          serial: input.serial,
          signal: input.build.signal,
          revalidate: input.revalidate,
          onPhase: input.onPhase,
        },
        { device: context.device, exec: this.exec },
      );
      return {
        artifact: artifact(result.artifact),
        installed: result.installed,
        replacementInstall: result.replaced,
        installationIdentity: result.installationIdentity,
      };
    } catch (error) {
      if (error instanceof AndroidBuildAndRunError && error.artifact) {
        Object.assign(error, { artifact: artifact(error.artifact) });
      }
      throw error;
    }
  }

  async forceStop(serial: string, packageName: string, signal?: AbortSignal): Promise<void> {
    const { device } = await this.getContext();
    await device.forceStop(serial, packageName, signal);
  }

  async relaunch(serial: string, component: string, signal?: AbortSignal): Promise<void> {
    const { device } = await this.getContext();
    await device.launch(serial, component, signal);
  }

  async validateInstallation(
    serial: string,
    packageName: string,
    identity: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { device } = await this.getContext();
    if ((await device.installationIdentity(serial, packageName, signal)) !== identity) {
      throw new Error("Android installation identity changed");
    }
  }

  async startLogs(serial: string, packageName: string, signal?: AbortSignal): Promise<AndroidHostLogcat> {
    const { adb, device } = await this.getContext();
    return PylonPackageLogcat.start(device, adb, serial, packageName, signal);
  }

  private getContext() {
    this.context ??= resolveAndroidSdk().then(paths => ({
      sdkRoot: paths.root,
      adb: paths.adb,
      device: new AndroidAppDevice(paths.adb, this.exec),
    }));
    return this.context;
  }
}

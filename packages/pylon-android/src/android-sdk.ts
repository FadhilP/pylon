import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { terminateProcessTree, waitForExit } from "./process.js";
import { reserveAndroidPort, type PortReservation } from "./port-reservation.js";
import type { AndroidExec, AndroidExecResult, AndroidProcessTerminator, AndroidSpawn } from "./types.js";

const EMULATOR_SERIAL = /^emulator-(\d{4,5})$/;
export const ANDROID_EMULATOR_START_TIMEOUT_MS = 180_000;
export const ANDROID_EMULATOR_MAX_START_TIMEOUT_MS = 300_000;
const MAX_PACKAGE_OUTPUT_BYTES = 128 * 1024;
const MAX_INSTALLED_PACKAGES = 4_096;
const MAX_ADB_OUTPUT_BYTES = 256 * 1024;
const MAX_AVD_OUTPUT_BYTES = 64 * 1024;
const MAX_AVDS = 1_024;
const MAX_DEVICES = 512;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

export type AndroidEmulatorStartPhase = "starting" | "booting";

export interface AndroidUncertainEmulator {
  readonly serial: string;
  readonly avd: string;
  cleanupUncertainStart(): Promise<void>;
}

export class AndroidEmulatorStartupCleanupError extends Error {
  readonly emulator: AndroidUncertainEmulator;
  readonly startupError: unknown;
  readonly cleanupError: unknown;

  constructor(emulator: AndroidUncertainEmulator, startupError: unknown, cleanupError: unknown) {
    super("Android emulator startup failed and its owned process could not be cleaned up", { cause: startupError });
    this.name = "AndroidEmulatorStartupCleanupError";
    this.emulator = emulator;
    this.startupError = startupError;
    this.cleanupError = cleanupError;
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export interface AndroidDevice {
  serial: string;
  state: string;
}
export interface AndroidSdkPaths {
  root: string;
  adb: string;
  emulator: string;
}
export interface AndroidPackageInventory {
  serial: string;
  avd: string;
  packages: string[];
}

function platformDefaultRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("Android SDK location is unknown; set ANDROID_SDK_ROOT");
    return join(env.LOCALAPPDATA, "Android", "Sdk");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Android", "sdk");
  return join(homedir(), "Android", "Sdk");
}

async function canonicalFile(path: string, label: string): Promise<string> {
  const original = await lstat(path).catch(() => {
    throw new Error(`${label} is unavailable at ${path}`);
  });
  if (!original.isFile() || original.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file`);
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  await access(canonical);
  return canonical;
}

export async function resolveAndroidSdk(env: NodeJS.ProcessEnv = process.env): Promise<AndroidSdkPaths> {
  const configured = env.ANDROID_SDK_ROOT || env.ANDROID_HOME;
  const rootInput = configured || platformDefaultRoot(env);
  if (!isAbsolute(rootInput)) throw new Error("Android SDK root must be absolute");
  const root = await realpath(rootInput).catch(() => {
    throw new Error(`Android SDK root is unavailable at ${rootInput}`);
  });
  const executable = process.platform === "win32" ? ".exe" : "";
  const adb = await canonicalFile(join(root, "platform-tools", `adb${executable}`), "adb");
  const emulator = await canonicalFile(join(root, "emulator", `emulator${executable}`), "Android emulator");
  for (const [label, path] of [
    ["adb", adb],
    ["Android emulator", emulator],
  ] as const) {
    const withinRoot = relative(root, path);
    if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot))
      throw new Error(`${label} resolves outside Android SDK root`);
  }
  return { root, adb, emulator };
}

function commandError(command: string, stderr: string): Error {
  return new Error(
    `${command} failed: ${
      stderr
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 500) || "no diagnostic output"
    }`,
  );
}

function checkedCommandOutput(
  label: string,
  result: AndroidExecResult,
  maxBytes: number,
  signal?: AbortSignal,
): string {
  if (signal?.aborted || result.killed) throw new Error(`${label} was cancelled`);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxBytes) {
    throw new Error(`${label} output exceeds ${Math.floor(maxBytes / 1024)}KB limit`);
  }
  if (result.code !== 0) throw commandError(label, result.stderr);
  return result.stdout;
}

function appendTail(current: string, data: Buffer): string {
  if (data.length >= 8_192) return data.subarray(-8_192).toString("utf8");
  const prior = Buffer.from(current);
  const next = Buffer.concat([prior, data], prior.length + data.length);
  return next.length <= 8_192 ? next.toString("utf8") : next.subarray(-8_192).toString("utf8");
}

export function validateEmulatorSerial(serial: string): number {
  const match = serial.match(EMULATOR_SERIAL);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 5554 || port > 5682 || port % 2)
    throw new Error("Android attachment requires an emulator serial with an even console port, such as emulator-5554");
  return port;
}

export function parseInstalledPackages(output: string): string[] {
  if (Buffer.byteLength(output) > MAX_PACKAGE_OUTPUT_BYTES)
    throw new Error("Android package inventory exceeds 128KB limit");
  const lines = output.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const packages = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^package:(.+)$/);
    if (!match || match[1].length > 255 || !PACKAGE_ID.test(match[1]))
      throw new Error("Android package manager returned malformed inventory");
    packages.add(match[1]);
    if (packages.size > MAX_INSTALLED_PACKAGES)
      throw new Error(`Android package inventory exceeds ${MAX_INSTALLED_PACKAGES} packages`);
  }
  return [...packages].sort();
}

async function portsAvailable(...ports: number[]): Promise<boolean> {
  for (const port of ports) {
    const available = await new Promise<boolean>(resolveAvailable => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveAvailable(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
    });
    if (!available) return false;
  }
  return true;
}

export class OwnedEmulator {
  readonly child: ChildProcess;
  readonly serial: string;
  readonly avd: string;
  private readonly sdk: AndroidSdk;
  private stdout = "";
  private stderr = "";
  private startError?: string;

  constructor(sdk: AndroidSdk, child: ChildProcess, serial: string, avd: string) {
    this.sdk = sdk;
    this.child = child;
    this.serial = serial;
    this.avd = avd;
    child.stdout?.on("data", (data: Buffer) => {
      this.stdout = appendTail(this.stdout, data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr = appendTail(this.stderr, data);
    });
    child.once("error", error => {
      this.startError = error.message;
    });
  }

  diagnostic(): string {
    return (this.startError || this.stderr || this.stdout)
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(-500);
  }
  startFailure(): string | undefined {
    return this.startError;
  }

  async stop(): Promise<void> {
    if (isRunning(this.child)) {
      const identity = await this.sdk.avdName(this.serial).catch(() => undefined);
      if (identity === this.avd && isRunning(this.child)) {
        await this.sdk.runAdb(["-s", this.serial, "emu", "kill"], 15_000).catch(() => undefined);
      }
      if (!(await waitForExit(this.child, identity === this.avd ? 10_000 : 0))) {
        await this.sdk.terminateOwnedProcess(this.child, "Android emulator", 1_000, 5_000);
      }
    }
    await this.sdk.verifySerialGone(this.serial);
  }

  async cleanupUncertainStart(): Promise<void> {
    if (isRunning(this.child)) {
      // Until startup succeeds, a serial/AVD response is not sufficient proof that
      // the responding emulator belongs to this child. Only kill the retained tree.
      await this.sdk.terminateOwnedProcess(this.child, "Android emulator", 500, 5_000);
    }
    await this.sdk.verifySerialGone(this.serial);
  }
}

export class AndroidSdk {
  readonly paths: AndroidSdkPaths;
  private readonly exec: AndroidExec | undefined;
  private readonly spawnProcess: AndroidSpawn;
  private readonly terminateProcess: AndroidProcessTerminator;

  constructor(
    paths: AndroidSdkPaths,
    exec?: AndroidExec,
    spawnProcess: AndroidSpawn = spawn,
    terminateProcess: AndroidProcessTerminator = terminateProcessTree,
  ) {
    this.paths = paths;
    this.exec = exec;
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;
  }

  static async create(env: NodeJS.ProcessEnv = process.env, spawnProcess: AndroidSpawn = spawn): Promise<AndroidSdk> {
    return new AndroidSdk(await resolveAndroidSdk(env), undefined, spawnProcess);
  }

  async runAdb(args: string[], timeout = 10_000, signal?: AbortSignal): Promise<string> {
    return this.runProcessBounded(this.paths.adb, args, MAX_ADB_OUTPUT_BYTES, timeout, signal, "adb");
  }

  async terminateOwnedProcess(
    child: ChildProcess,
    label: string,
    gracefulMs?: number,
    forceMs?: number,
  ): Promise<void> {
    await this.terminateProcess(child, label, gracefulMs, forceMs);
  }

  private async runProcessBounded(
    command: string,
    args: string[],
    maxBytes: number,
    timeout: number,
    signal: AbortSignal | undefined,
    label: string,
    forceSpawn = false,
  ): Promise<string> {
    if (signal?.aborted) throw new Error(`${label} was cancelled`);
    if (this.exec && !forceSpawn) {
      const result = await this.exec(command, args, { timeout, signal, maxOutputBytes: maxBytes });
      return checkedCommandOutput(label, result, maxBytes, signal);
    }

    const child = this.spawnProcess(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let overflow = false;
    let spawnError: Error | undefined;
    let stopReason: "cancelled" | "overflow" | "spawn-error" | undefined;
    let requestStop!: () => void;
    const stopped = new Promise<void>(resolve => {
      requestStop = resolve;
    });
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      requestStop();
    };
    const capture = (value: Buffer | string, stdout: boolean) => {
      if (stopReason) return;
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + data.length > maxBytes) {
        overflow = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        stop("overflow");
        return;
      }
      bytes += data.length;
      if (stdout) chunks.push(data);
      else stderr = appendTail(stderr, data);
    };
    child.stdout?.on("data", (value: Buffer | string) => capture(value, true));
    child.stderr?.on("data", (value: Buffer | string) => capture(value, false));
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.once("error", error => {
      spawnError = error;
      stop("spawn-error");
    });
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const outcome: "closed" | "stop" | "timeout" = await Promise.race([
      closed.then(() => "closed" as const),
      stopped.then(() => "stop" as const),
      delay(timeout, "timeout" as const, { ref: false }),
    ]);
    let terminationError: unknown;
    if (outcome !== "closed" && child.pid) {
      try {
        await this.terminateProcess(child, `${label} command`, 500, 5_000);
      } catch (error) {
        terminationError = error;
      }
    }
    signal?.removeEventListener("abort", cancel);
    if (terminationError) throw new Error(`${label} could not be terminated safely`);
    if (stopReason === "cancelled") throw new Error(`${label} was cancelled`);
    if (overflow) throw new Error(`${label} output exceeds ${Math.floor(maxBytes / 1024)}KB limit`);
    if (outcome === "timeout") throw new Error(`${label} timed out`);
    if (spawnError) throw new Error(`${label} is unavailable`);
    if (outcome !== "closed") throw new Error(`${label} stopped unexpectedly`);
    if (child.exitCode !== 0) throw commandError(label, stderr);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new Error(`${label} returned invalid UTF-8`);
    }
  }

  async listInstalledPackages(serial: string, signal?: AbortSignal): Promise<AndroidPackageInventory> {
    if (signal?.aborted) throw new Error("Android package listing cancelled");
    const identity = await this.verifyAttached(serial, signal);
    const output = await this.runProcessBounded(
      this.paths.adb,
      ["-s", identity.serial, "shell", "pm", "list", "packages"],
      MAX_PACKAGE_OUTPUT_BYTES,
      30_000,
      signal,
      "Android package inventory",
      true,
    );
    const packages = parseInstalledPackages(output);
    return { ...identity, packages };
  }

  async listAvds(signal?: AbortSignal): Promise<string[]> {
    const output = await this.runProcessBounded(
      this.paths.emulator,
      ["-list-avds"],
      MAX_AVD_OUTPUT_BYTES,
      15_000,
      signal,
      "Android emulator",
    );
    const lines = output.split(/\r?\n/);
    while (lines.at(-1) === "") lines.pop();
    if (lines.length > MAX_AVDS) throw new Error(`Android AVD inventory exceeds ${MAX_AVDS} entries`);
    const avds = new Set<string>();
    for (const line of lines) {
      const avd = line.trim();
      if (!avd || avd.length > 200 || /[\r\n\0]/.test(avd)) {
        throw new Error("Android emulator returned malformed AVD inventory");
      }
      avds.add(avd);
    }
    return [...avds];
  }

  async devices(signal?: AbortSignal): Promise<AndroidDevice[]> {
    const output = await this.runAdb(["devices", "-l"], 10_000, signal);
    const devices: AndroidDevice[] = [];
    for (const line of output.split(/\r?\n/).slice(1)) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match) devices.push({ serial: match[1], state: match[2] });
      if (devices.length > MAX_DEVICES) throw new Error(`Android device inventory exceeds ${MAX_DEVICES} entries`);
    }
    return devices;
  }

  validateSerial(serial: string): number {
    return validateEmulatorSerial(serial);
  }

  async avdName(serial: string, signal?: AbortSignal): Promise<string> {
    this.validateSerial(serial);
    const output = await this.runAdb(["-s", serial, "emu", "avd", "name"], 10_000, signal);
    const name = output
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(item => item && item !== "OK");
    if (!name || name.length > 200 || /[\r\n\0]/.test(name)) throw new Error(`Could not identify AVD for ${serial}`);
    return name;
  }

  async verifyAttached(serial: string, signal?: AbortSignal): Promise<{ serial: string; avd: string }> {
    this.validateSerial(serial);
    const matching = (await this.devices(signal)).filter(item => item.serial === serial);
    if (matching.length !== 1 || matching[0].state !== "device")
      throw new Error(`Android emulator ${serial} is not ready or is ambiguous`);
    return { serial, avd: await this.avdName(serial, signal) };
  }

  async bootId(serial: string, signal?: AbortSignal): Promise<string> {
    this.validateSerial(serial);
    const value = (await this.runAdb(["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], 5_000, signal))
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      throw new Error(`Could not identify Android emulator instance ${serial}`);
    }
    return value;
  }

  private async occupiedAvds(signal?: AbortSignal): Promise<Map<string, string>> {
    const occupied = new Map<string, string>();
    for (const device of await this.devices(signal)) {
      if (!EMULATOR_SERIAL.test(device.serial)) continue;
      const avd = await this.avdName(device.serial, signal).catch(() => undefined);
      if (avd) occupied.set(avd, device.serial);
    }
    return occupied;
  }

  private async selectPort(signal?: AbortSignal): Promise<PortReservation> {
    const serials = new Set((await this.devices(signal)).map(item => item.serial));
    const offset = Math.floor(Math.random() * 20) * 2;
    for (let step = 0; step <= 128; step += 2) {
      const port = 5554 + ((offset + step) % 130);
      if (serials.has(`emulator-${port}`)) continue;
      const reservation = await reserveAndroidPort(port);
      if (!reservation) continue;
      if (await portsAvailable(port, port + 1)) return reservation;
      await reservation.release();
    }
    throw new Error("No Android emulator console port is available");
  }

  async start(
    avd: string,
    headless: boolean,
    signal?: AbortSignal,
    timeoutMs = ANDROID_EMULATOR_START_TIMEOUT_MS,
    onPhase?: (phase: AndroidEmulatorStartPhase) => void,
  ): Promise<OwnedEmulator> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ANDROID_EMULATOR_MAX_START_TIMEOUT_MS) {
      throw new Error(
        `Android emulator startup timeout must be between 1 and ${ANDROID_EMULATOR_MAX_START_TIMEOUT_MS}ms`,
      );
    }
    if (signal?.aborted) throw new Error("Android emulator startup cancelled");
    const reportPhase = (phase: AndroidEmulatorStartPhase) => {
      try {
        onPhase?.(phase);
      } catch {}
    };
    const avds = await this.listAvds(signal);
    if (!avds.includes(avd)) throw new Error(`Unknown Android AVD: ${avd}`);
    const occupied = await this.occupiedAvds(signal);
    if (occupied.has(avd))
      throw new Error(`Android AVD ${avd} is already running as ${occupied.get(avd)}; use attach instead`);
    const reservation = await this.selectPort(signal);
    const { port } = reservation;
    const serial = `emulator-${port}`;
    const args = [
      "-avd",
      avd,
      "-port",
      String(port),
      "-no-snapshot-save",
      "-no-boot-anim",
      ...(headless ? ["-no-window", "-no-audio"] : []),
    ];
    let owned: OwnedEmulator | undefined;
    try {
      if (signal?.aborted) throw new Error("Android emulator startup cancelled");
      const child = this.spawnProcess(this.paths.emulator, args, {
        shell: false,
        windowsHide: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      owned = new OwnedEmulator(this, child, serial, avd);
      reportPhase("starting");
      await this.waitForBoot(owned, signal, timeoutMs, reportPhase);
      return owned;
    } catch (error) {
      const startupError = signal?.aborted ? new Error("Android emulator startup cancelled") : error;
      const diagnostic = owned?.diagnostic();
      if (diagnostic && startupError instanceof Error) startupError.message += `: ${diagnostic}`;
      if (owned) {
        try {
          await owned.cleanupUncertainStart();
        } catch (cleanupError) {
          throw new AndroidEmulatorStartupCleanupError(owned, startupError, cleanupError);
        }
      }
      throw startupError;
    } finally {
      await reservation.release();
    }
  }

  async verifySerialGone(serial: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (!(await this.devices()).some(device => device.serial === serial)) return;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    if (lastError) throw new Error(`Could not verify Android emulator ${serial} stopped`);
    throw new Error(`Android emulator ${serial} remained connected after cleanup`);
  }

  private async waitForBoot(
    owned: OwnedEmulator,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onPhase: (phase: AndroidEmulatorStartPhase) => void,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let bootingReported = false;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Android emulator startup cancelled");
      if (owned.startFailure()) throw new Error(`Android emulator could not start: ${owned.startFailure()}`);
      if (!isRunning(owned.child)) throw new Error("Android emulator exited during startup");
      try {
        const state = (await this.runAdb(["-s", owned.serial, "get-state"], 5_000, signal)).trim();
        const booted = (
          await this.runAdb(["-s", owned.serial, "shell", "getprop", "sys.boot_completed"], 5_000, signal)
        ).trim();
        const name = await this.avdName(owned.serial, signal);
        if (state === "device" && name === owned.avd) {
          if (!bootingReported) {
            bootingReported = true;
            onPhase("booting");
          }
          if (signal?.aborted) throw new Error("Android emulator startup cancelled");
          if (booted === "1") return;
        }
      } catch {}
      await delay(1_000, undefined, { signal }).catch(() => {
        throw new Error("Android emulator startup cancelled");
      });
    }
    throw new Error(`Android emulator ${owned.avd} did not boot within ${timeoutMs / 1000} seconds`);
  }
}

export async function diagnoseAndroid(): Promise<{ sdk: AndroidSdk; avds: string[]; adbVersion: string }> {
  const sdk = await AndroidSdk.create();
  const avds = await sdk.listAvds();
  const version = await sdk.runAdb(["version"], 10_000);
  return { sdk, avds, adbVersion: version.split(/\r?\n/, 1)[0].slice(0, 200) };
}

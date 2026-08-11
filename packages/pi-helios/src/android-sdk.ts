import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Exec } from "./capture.ts";
import type { SpawnProcess } from "./appium.ts";
import { terminateProcessTree, waitForExit } from "./process.ts";
import { reserveHeliosPort, type PortReservation } from "./port-reservation.ts";

const EMULATOR_SERIAL = /^emulator-(\d{4,5})$/;
const START_TIMEOUT_MS = 180_000;
const MAX_PACKAGE_OUTPUT_BYTES = 128 * 1024;
const MAX_INSTALLED_PACKAGES = 4_096;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

export interface AndroidDevice { serial: string; state: string }
export interface AndroidSdkPaths { root: string; adb: string; emulator: string }
export interface AndroidPackageInventory { serial: string; avd: string; packages: string[] }

function platformDefaultRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("Android SDK location is unknown; set ANDROID_SDK_ROOT");
    return join(env.LOCALAPPDATA, "Android", "Sdk");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Android", "sdk");
  return join(homedir(), "Android", "Sdk");
}

async function canonicalFile(path: string, label: string): Promise<string> {
  const original = await lstat(path).catch(() => { throw new Error(`${label} is unavailable at ${path}`); });
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
  const root = await realpath(rootInput).catch(() => { throw new Error(`Android SDK root is unavailable at ${rootInput}`); });
  const executable = process.platform === "win32" ? ".exe" : "";
  const adb = await canonicalFile(join(root, "platform-tools", `adb${executable}`), "adb");
  const emulator = await canonicalFile(join(root, "emulator", `emulator${executable}`), "Android emulator");
  for (const [label, path] of [["adb", adb], ["Android emulator", emulator]] as const) {
    const withinRoot = relative(root, path);
    if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot)) throw new Error(`${label} resolves outside Android SDK root`);
  }
  return { root, adb, emulator };
}

function commandError(command: string, stderr: string): Error {
  return new Error(`${command} failed: ${stderr.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "no diagnostic output"}`);
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
  if (!match || !Number.isInteger(port) || port < 5554 || port > 5682 || port % 2) throw new Error("Android attachment requires an emulator serial with an even console port, such as emulator-5554");
  return port;
}

export function parseInstalledPackages(output: string): string[] {
  if (Buffer.byteLength(output) > MAX_PACKAGE_OUTPUT_BYTES) throw new Error("Android package inventory exceeds 128KB limit");
  const lines = output.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const packages = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^package:(.+)$/);
    if (!match || match[1].length > 255 || !PACKAGE_ID.test(match[1])) throw new Error("Android package manager returned malformed inventory");
    packages.add(match[1]);
    if (packages.size > MAX_INSTALLED_PACKAGES) throw new Error(`Android package inventory exceeds ${MAX_INSTALLED_PACKAGES} packages`);
  }
  return [...packages].sort();
}

async function portsAvailable(...ports: number[]): Promise<boolean> {
  for (const port of ports) {
    const available = await new Promise<boolean>((resolveAvailable) => {
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
    child.stdout?.on("data", (data: Buffer) => { this.stdout = appendTail(this.stdout, data); });
    child.stderr?.on("data", (data: Buffer) => { this.stderr = appendTail(this.stderr, data); });
    child.once("error", (error) => { this.startError = error.message; });
  }

  diagnostic(): string { return (this.startError || this.stderr || this.stdout).replace(/[\r\n]+/g, " ").trim().slice(-500); }
  startFailure(): string | undefined { return this.startError; }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) {
      const identity = await this.sdk.avdName(this.serial).catch(() => undefined);
      if (identity === this.avd && this.child.exitCode === null) {
        await this.sdk.runAdb(["-s", this.serial, "emu", "kill"], 15_000).catch(() => undefined);
      }
      if (!await waitForExit(this.child, identity === this.avd ? 10_000 : 0)) {
        await terminateProcessTree(this.child, "Android emulator", 1_000, 5_000);
      }
    }
    await this.sdk.verifySerialGone(this.serial);
  }

  async cleanupUncertainStart(): Promise<void> {
    if (this.child.exitCode === null) {
      const identity = await this.sdk.avdName(this.serial).catch(() => undefined);
      if (identity === this.avd) await this.sdk.runAdb(["-s", this.serial, "emu", "kill"], 10_000).catch(() => undefined);
      await terminateProcessTree(this.child, "Android emulator", 500, 5_000);
    }
    await this.sdk.verifySerialGone(this.serial);
  }
}

export class AndroidSdk {
  readonly paths: AndroidSdkPaths;
  private readonly exec: Exec;
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateProcess: typeof terminateProcessTree;

  constructor(paths: AndroidSdkPaths, exec: Exec, spawnProcess: SpawnProcess = spawn, terminateProcess: typeof terminateProcessTree = terminateProcessTree) {
    this.paths = paths;
    this.exec = exec;
    this.spawnProcess = spawnProcess;
    this.terminateProcess = terminateProcess;
  }

  static async create(exec: Exec, env: NodeJS.ProcessEnv = process.env, spawnProcess: SpawnProcess = spawn): Promise<AndroidSdk> {
    return new AndroidSdk(await resolveAndroidSdk(env), exec, spawnProcess);
  }

  async runAdb(args: string[], timeout = 10_000, signal?: AbortSignal): Promise<string> {
    const result = await this.exec(this.paths.adb, args, { timeout, signal });
    if (result.code !== 0) throw commandError("adb", result.stderr);
    return result.stdout;
  }


  private async runAdbBounded(args: string[], maxBytes: number, timeout: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error("Android package listing cancelled");
    const child = this.spawnProcess(this.paths.adb, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let overflow = false;
    let spawnError: Error | undefined;
    let stopReason: "cancelled" | "overflow" | "spawn-error" | undefined;
    let requestStop!: () => void;
    const stopped = new Promise<void>((resolve) => { requestStop = resolve; });
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      requestStop();
    };
    child.stdout?.on("data", (value: Buffer | string) => {
      if (stopReason) return;
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + data.length > maxBytes) {
        overflow = true;
        child.stdout?.destroy();
        stop("overflow");
        return;
      }
      bytes += data.length;
      chunks.push(data);
    });
    child.stderr?.on("data", (value: Buffer | string) => { stderr = appendTail(stderr, Buffer.isBuffer(value) ? value : Buffer.from(value)); });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("error", (error) => { spawnError = error; stop("spawn-error"); });
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
      try { await this.terminateProcess(child, "adb package listing", 500, 5_000); }
      catch (error) { terminationError = error; }
    }
    signal?.removeEventListener("abort", cancel);
    if (terminationError) throw new Error("adb package listing could not be terminated safely");
    if (stopReason === "cancelled") throw new Error("Android package listing cancelled");
    if (overflow) throw new Error("Android package inventory exceeds 128KB limit");
    if (outcome === "timeout") throw new Error("Android package listing timed out");
    if (spawnError) throw new Error("adb package listing is unavailable");
    if (outcome !== "closed") throw new Error("adb package listing stopped unexpectedly");
    if (child.exitCode !== 0) throw commandError("adb", stderr);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw new Error("Android package manager returned invalid UTF-8"); }
  }

  async listInstalledPackages(serial: string, signal?: AbortSignal): Promise<AndroidPackageInventory> {
    if (signal?.aborted) throw new Error("Android package listing cancelled");
    const identity = await this.verifyAttached(serial, signal);
    const output = await this.runAdbBounded(["-s", identity.serial, "shell", "pm", "list", "packages"], MAX_PACKAGE_OUTPUT_BYTES, 30_000, signal);
    return { ...identity, packages: parseInstalledPackages(output) };
  }

  async listAvds(signal?: AbortSignal): Promise<string[]> {
    const result = await this.exec(this.paths.emulator, ["-list-avds"], { timeout: 15_000, signal });
    if (result.code !== 0) throw commandError("Android emulator", result.stderr);
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && item.length <= 200 && !/[\r\n\0]/.test(item));
  }

  async devices(signal?: AbortSignal): Promise<AndroidDevice[]> {
    const output = await this.runAdb(["devices", "-l"], 10_000, signal);
    const devices: AndroidDevice[] = [];
    for (const line of output.split(/\r?\n/).slice(1)) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match) devices.push({ serial: match[1], state: match[2] });
    }
    return devices;
  }

  validateSerial(serial: string): number {
    return validateEmulatorSerial(serial);
  }

  async avdName(serial: string, signal?: AbortSignal): Promise<string> {
    this.validateSerial(serial);
    const output = await this.runAdb(["-s", serial, "emu", "avd", "name"], 10_000, signal);
    const name = output.split(/\r?\n/).map((item) => item.trim()).find((item) => item && item !== "OK");
    if (!name || name.length > 200) throw new Error(`Could not identify AVD for ${serial}`);
    return name;
  }

  async verifyAttached(serial: string, signal?: AbortSignal): Promise<{ serial: string; avd: string }> {
    this.validateSerial(serial);
    const matching = (await this.devices(signal)).filter((item) => item.serial === serial);
    if (matching.length !== 1 || matching[0].state !== "device") throw new Error(`Android emulator ${serial} is not ready or is ambiguous`);
    return { serial, avd: await this.avdName(serial, signal) };
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
    const serials = new Set((await this.devices(signal)).map((item) => item.serial));
    const offset = Math.floor(Math.random() * 20) * 2;
    for (let step = 0; step <= 128; step += 2) {
      const port = 5554 + (offset + step) % 130;
      if (serials.has(`emulator-${port}`)) continue;
      const reservation = await reserveHeliosPort(port);
      if (!reservation) continue;
      if (await portsAvailable(port, port + 1)) return reservation;
      await reservation.release();
    }
    throw new Error("No Android emulator console port is available");
  }

  async start(avd: string, headless: boolean, signal?: AbortSignal): Promise<OwnedEmulator> {
    const avds = await this.listAvds(signal);
    if (!avds.includes(avd)) throw new Error(`Unknown Android AVD: ${avd}`);
    const occupied = await this.occupiedAvds(signal);
    if (occupied.has(avd)) throw new Error(`Android AVD ${avd} is already running as ${occupied.get(avd)}; use attach instead`);
    const reservation = await this.selectPort(signal);
    const { port } = reservation;
    const serial = `emulator-${port}`;
    const args = ["-avd", avd, "-port", String(port), "-no-snapshot-save", "-no-boot-anim", ...(headless ? ["-no-window", "-no-audio"] : [])];
    const child = this.spawnProcess(this.paths.emulator, args, {
      shell: false, windowsHide: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const owned = new OwnedEmulator(this, child, serial, avd);
    try {
      await this.waitForBoot(owned, signal);
      return owned;
    } catch (error) {
      await owned.cleanupUncertainStart();
      if (signal?.aborted) throw new Error("Android emulator startup cancelled");
      const diagnostic = owned.diagnostic();
      if (diagnostic && error instanceof Error) error.message += `: ${diagnostic}`;
      throw error;
    } finally {
      await reservation.release();
    }
  }

  async verifySerialGone(serial: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (!(await this.devices()).some((device) => device.serial === serial)) return;
        lastError = undefined;
      } catch (error) { lastError = error; }
      await delay(100);
    }
    if (lastError) throw new Error(`Could not verify Android emulator ${serial} stopped`);
    throw new Error(`Android emulator ${serial} remained connected after cleanup`);
  }

  private async waitForBoot(owned: OwnedEmulator, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Android emulator startup cancelled");
      if (owned.startFailure()) throw new Error(`Android emulator could not start: ${owned.startFailure()}`);
      if (owned.child.exitCode !== null) throw new Error("Android emulator exited during startup");
      try {
        const state = (await this.runAdb(["-s", owned.serial, "get-state"], 5_000, signal)).trim();
        const booted = (await this.runAdb(["-s", owned.serial, "shell", "getprop", "sys.boot_completed"], 5_000, signal)).trim();
        const name = await this.avdName(owned.serial, signal);
        if (state === "device" && booted === "1" && name === owned.avd) return;
      } catch {}
      await delay(1_000, undefined, { signal }).catch(() => { throw new Error("Android emulator startup cancelled"); });
    }
    throw new Error(`Android emulator ${owned.avd} did not boot within ${START_TIMEOUT_MS / 1000} seconds`);
  }
}

export async function diagnoseAndroid(exec: Exec): Promise<{ sdk: AndroidSdk; avds: string[]; adbVersion: string }> {
  const sdk = await AndroidSdk.create(exec);
  const avds = await sdk.listAvds();
  const version = await sdk.runAdb(["version"], 10_000);
  return { sdk, avds, adbVersion: version.split(/\r?\n/, 1)[0].slice(0, 200) };
}

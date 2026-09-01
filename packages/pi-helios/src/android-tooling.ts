import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  MANAGED_APPIUM_VERSION,
  MANAGED_UIAUTOMATOR2_VERSION,
  managedAndroidToolingDirectory,
  managedAppiumEnvironment,
  resolveManagedAppiumAt,
  windowsNpmCli,
} from "./appium.ts";
import { terminateProcessTree } from "./process.ts";

const TEMPLATE_DIRECTORY = fileURLToPath(new URL("../tooling/android", import.meta.url));
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_BYTES = 16 * 1024;

export type AndroidToolingState = "missing" | "ready" | "invalid" | "busy";
export interface AndroidToolingStatus {
  state: AndroidToolingState;
  appiumVersion: string;
  driverVersion: string;
  message?: string;
}

type RunOptions = { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal };
type RunCommand = (command: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;

function tail(current: string, chunk: Buffer): string {
  if (chunk.length >= OUTPUT_BYTES) return chunk.subarray(-OUTPUT_BYTES).toString("utf8");
  const data = Buffer.concat([Buffer.from(current), chunk]);
  return (data.length <= OUTPUT_BYTES ? data : data.subarray(-OUTPUT_BYTES)).toString("utf8");
}

async function runCommand(command: string, args: string[], options: RunOptions): Promise<{ stdout: string }> {
  if (options.signal?.aborted) throw new Error("Android tooling setup cancelled");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout?.on("data", (data: Buffer) => {
    stdout = tail(stdout, data);
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr = tail(stderr, data);
  });
  child.once("error", error => {
    spawnError = error;
  });
  const closed = new Promise<"closed">(resolve => child.once("close", () => resolve("closed")));
  let abort!: () => void;
  const aborted = new Promise<"aborted">(resolve => {
    abort = () => resolve("aborted");
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const outcome = await Promise.race([closed, aborted, delay(options.timeout, "timeout" as const, { ref: false })]);
  if (outcome !== "closed" && child.pid) await terminateProcessTree(child, "Android tooling setup", 1_000, 5_000);
  options.signal?.removeEventListener("abort", abort);
  if (outcome === "aborted") throw new Error("Android tooling setup cancelled");
  if (outcome === "timeout") throw new Error("Android tooling setup timed out");
  if (spawnError) throw new Error("Android tooling setup process could not start");
  if (child.exitCode !== 0)
    throw new Error(
      `Android tooling setup failed: ${
        (stderr || stdout)
          .replace(/[\r\n]+/g, " ")
          .trim()
          .slice(-500) || "no diagnostic output"
      }`,
    );
  return { stdout };
}

function concise(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireOwnedDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a managed directory`);
  return realpath(path);
}

export class AndroidToolingManager {
  private readonly agentDir: string;
  private readonly templateDirectory: string;
  private readonly run: RunCommand;
  private readonly env: NodeJS.ProcessEnv;
  private mutating = false;

  constructor(
    options: { agentDir?: string; templateDirectory?: string; run?: RunCommand; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.templateDirectory = options.templateDirectory ?? TEMPLATE_DIRECTORY;
    this.run = options.run ?? runCommand;
    this.env = options.env ?? process.env;
  }

  isMutating(): boolean {
    return this.mutating;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    const agent = await requireOwnedDirectory(this.agentDir, "Pylon agent directory");
    const heliosPath = join(agent, "pi-helios");
    await mkdir(heliosPath, { recursive: true, mode: 0o700 });
    const helios = await requireOwnedDirectory(heliosPath, "Helios data directory");
    const rootPath = join(helios, "android-tooling");
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const root = await requireOwnedDirectory(rootPath, "Android tooling root");
    if (relative(agent, root) !== join("pi-helios", "android-tooling"))
      throw new Error("Android tooling root resolves outside the Pylon agent directory");
    const configured = await realpath(this.paths().root);
    if (relative(root, configured) !== "") throw new Error("Android tooling root is not canonical");
  }

  private async staleLock(lock: string): Promise<boolean> {
    try {
      await requireOwnedDirectory(lock, "Android tooling lock");
      const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid?: unknown };
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
      if (owner.pid === process.pid) return false;
      try {
        process.kill(owner.pid as number, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      return false;
    }
  }

  private async claimLock(lock: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
        } catch (error) {
          await rm(lock, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 0 && (await this.staleLock(lock))) {
          const stale = `${lock}.stale-${randomUUID()}`;
          try {
            await rename(lock, stale);
            await rm(stale, { recursive: true, force: true });
            continue;
          } catch {
            /* another process changed the lock */
          }
        }
        throw new Error("Android tooling setup is locked by another Pylon process");
      }
    }
  }

  private paths() {
    const current = managedAndroidToolingDirectory(this.agentDir);
    const root = dirname(current);
    return {
      root,
      current,
      previous: join(root, "previous"),
      lock: join(root, "operation.lock"),
      usage: join(root, "usage"),
    };
  }

  private async activeUsageLeases(): Promise<number> {
    const { usage } = this.paths();
    try {
      await mkdir(usage, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await requireOwnedDirectory(usage, "Android tooling usage directory");
    let active = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        active++;
        continue;
      }
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(join(candidate, "owner.json"), "utf8")) as { pid?: unknown };
        if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && owner.pid !== process.pid) {
          try {
            process.kill(owner.pid as number, 0);
          } catch (error) {
            stale = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await exists(candidate))) continue;
      }
      if (!stale) {
        active++;
        continue;
      }
      const abandoned = `${candidate}.stale-${randomUUID()}`;
      try {
        await rename(candidate, abandoned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        active++;
        continue;
      }
      await rm(abandoned, { recursive: true, force: true });
    }
    return active;
  }

  async acquireUsageLease(): Promise<() => Promise<void>> {
    await this.ensureRoot();
    const { lock, usage } = this.paths();
    if (await exists(lock))
      throw new Error("Android tooling setup is running; wait before starting an Android session");
    try {
      await mkdir(usage, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await requireOwnedDirectory(usage, "Android tooling usage directory");
    const lease = join(usage, `lease-${process.pid}-${randomUUID()}`);
    await mkdir(lease, { mode: 0o700 });
    try {
      await writeFile(join(lease, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    } catch (error) {
      await rm(lease, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (await exists(lock)) {
      await rm(lease, { recursive: true, force: true });
      throw new Error("Android tooling setup is running; wait before starting an Android session");
    }
    let released = false;
    return async () => {
      if (released) return;
      if (await exists(lease)) {
        await requireOwnedDirectory(lease, "Android tooling usage lease");
        await rm(lease, { recursive: true, force: true });
      }
      released = true;
    };
  }

  async status(): Promise<AndroidToolingStatus> {
    const { lock, current, previous } = this.paths();
    if (this.mutating || (await exists(lock)))
      return { state: "busy", appiumVersion: MANAGED_APPIUM_VERSION, driverVersion: MANAGED_UIAUTOMATOR2_VERSION };
    if (!(await exists(current)) && (await exists(previous)))
      return {
        state: "invalid",
        appiumVersion: MANAGED_APPIUM_VERSION,
        driverVersion: MANAGED_UIAUTOMATOR2_VERSION,
        message: "Managed Android tooling recovery is incomplete. Use Repair to restore it.",
      };
    try {
      const invocation = await resolveManagedAppiumAt(current, this.env);
      return invocation
        ? { state: "ready", appiumVersion: invocation.version, driverVersion: invocation.driverVersion! }
        : { state: "missing", appiumVersion: MANAGED_APPIUM_VERSION, driverVersion: MANAGED_UIAUTOMATOR2_VERSION };
    } catch {
      return {
        state: "invalid",
        appiumVersion: MANAGED_APPIUM_VERSION,
        driverVersion: MANAGED_UIAUTOMATOR2_VERSION,
        message: "Managed Android tooling is invalid or incomplete. Use Repair to replace it.",
      };
    }
  }

  private async acquire(): Promise<() => Promise<void>> {
    if (this.mutating) throw new Error("Android tooling setup is already running");
    this.mutating = true;
    const { lock } = this.paths();
    let claimed = false;
    try {
      await this.ensureRoot();
      await this.claimLock(lock);
      claimed = true;
      if (await this.activeUsageLeases())
        throw new Error("Close active Helios Android sessions before changing managed tooling");
      return async () => {
        try {
          await rm(lock, { recursive: true, force: true });
        } finally {
          this.mutating = false;
        }
      };
    } catch (error) {
      if (claimed) await rm(lock, { recursive: true, force: true }).catch(() => {});
      this.mutating = false;
      throw error;
    }
  }

  private async recover(): Promise<void> {
    const { root, current, previous } = this.paths();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !entry.name.startsWith("stage-") &&
        !entry.name.startsWith("removed-") &&
        !entry.name.startsWith("operation.lock.stale-")
      )
        continue;
      const candidate = join(root, entry.name);
      await requireOwnedDirectory(candidate, "Abandoned Android tooling data");
      await rm(candidate, { recursive: true, force: true });
    }
    if (!(await exists(current)) && (await exists(previous))) await rename(previous, current);
    if ((await exists(current)) && (await exists(previous))) {
      await requireOwnedDirectory(previous, "Previous Android tooling");
      await rm(previous, { recursive: true, force: true });
    }
  }

  async install(
    activeSessions = 0,
    signal?: AbortSignal,
    installTimeoutMs = INSTALL_TIMEOUT_MS,
  ): Promise<AndroidToolingStatus> {
    const release = await this.acquire();
    const { root, current, previous } = this.paths();
    const stage = join(root, `stage-${process.pid}-${randomUUID()}`);
    try {
      if (activeSessions > 0) throw new Error("Close active Helios Android sessions before repairing managed tooling");
      await this.recover();
      const template = JSON.parse(await readFile(join(this.templateDirectory, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      if (
        template.dependencies?.appium !== MANAGED_APPIUM_VERSION ||
        template.dependencies?.["appium-uiautomator2-driver"] !== MANAGED_UIAUTOMATOR2_VERSION
      )
        throw new Error("Bundled Android tooling versions are invalid");
      await mkdir(stage, { mode: 0o700 });
      for (const file of ["package.json", "package-lock.json"]) {
        await copyFile(join(this.templateDirectory, file), join(stage, file));
        await chmod(join(stage, file), 0o600).catch(() => {});
      }
      const npm =
        process.platform === "win32"
          ? { command: process.execPath, args: [await windowsNpmCli(this.env)] }
          : { command: "npm", args: [] };
      const env = managedAppiumEnvironment(this.env, stage);
      const npmUserConfig = join(stage, ".npmrc-user");
      const npmGlobalConfig = join(stage, ".npmrc-global");
      await Promise.all([
        writeFile(npmUserConfig, "", { mode: 0o600 }),
        writeFile(npmGlobalConfig, "", { mode: 0o600 }),
      ]);
      await this.run(
        npm.command,
        [
          ...npm.args,
          "ci",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--userconfig",
          npmUserConfig,
          "--globalconfig",
          npmGlobalConfig,
        ],
        { cwd: stage, env, timeout: installTimeoutMs, signal },
      );
      const invocation = await resolveManagedAppiumAt(stage, env);
      if (!invocation) throw new Error("Managed Android tooling verification failed");
      const version = await this.run(invocation.command, [...invocation.args, "--version"], {
        cwd: stage,
        env,
        timeout: 30_000,
        signal,
      });
      if (version.stdout.trim() !== MANAGED_APPIUM_VERSION)
        throw new Error("Managed Appium version verification failed");
      const drivers = await this.run(
        invocation.command,
        [...invocation.args, "driver", "list", "--installed", "--json"],
        { cwd: stage, env, timeout: 60_000, signal },
      );
      let driver: Record<string, unknown> | undefined;
      try {
        driver = (JSON.parse(drivers.stdout) as Record<string, Record<string, unknown>>).uiautomator2;
      } catch {}
      if (
        !driver ||
        driver.installed !== true ||
        driver.pkgName !== "appium-uiautomator2-driver" ||
        driver.version !== MANAGED_UIAUTOMATOR2_VERSION ||
        typeof driver.installPath !== "string"
      )
        throw new Error("Managed UiAutomator2 verification failed");
      const installPath = await realpath(driver.installPath);
      const fromStage = relative(await realpath(stage), installPath);
      if (!fromStage || fromStage.startsWith("..") || isAbsolute(fromStage))
        throw new Error("Managed UiAutomator2 resolves outside the staged installation");
      if (signal?.aborted) throw new Error("Android tooling setup cancelled");
      if (await exists(current)) {
        await requireOwnedDirectory(current, "Current Android tooling");
        await rename(current, previous);
      }
      try {
        await rename(stage, current);
      } catch (error) {
        if ((await exists(previous)) && !(await exists(current))) {
          try {
            await rename(previous, current);
          } catch {
            throw new Error(
              "Android tooling promotion failed and the previous installation could not be restored. Use Repair to recover it.",
            );
          }
        }
        throw error;
      }
      if (await exists(previous)) await rm(previous, { recursive: true, force: true });
      return { state: "ready", appiumVersion: MANAGED_APPIUM_VERSION, driverVersion: MANAGED_UIAUTOMATOR2_VERSION };
    } finally {
      try {
        if (await exists(stage)) await rm(stage, { recursive: true, force: true }).catch(() => {});
      } finally {
        await release();
      }
    }
  }

  async remove(activeSessions: number, signal?: AbortSignal): Promise<AndroidToolingStatus> {
    const release = await this.acquire();
    const { current, previous, root } = this.paths();
    try {
      if (activeSessions > 0) throw new Error("Close active Helios Android sessions before removing managed tooling");
      if (signal?.aborted) throw new Error("Android tooling removal cancelled");
      await this.recover();
      if (signal?.aborted) throw new Error("Android tooling removal cancelled");
      if (await exists(current)) {
        await requireOwnedDirectory(current, "Current Android tooling");
        const removed = join(root, `removed-${process.pid}-${randomUUID()}`);
        await rename(current, removed);
        await rm(removed, { recursive: true, force: true });
      }
      if (await exists(previous)) throw new Error("Previous Android tooling recovery is incomplete");
      return { state: "missing", appiumVersion: MANAGED_APPIUM_VERSION, driverVersion: MANAGED_UIAUTOMATOR2_VERSION };
    } finally {
      await release();
    }
  }
}

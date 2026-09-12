import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const MAX_CLEANUP_WAIT_MS = 30_000;

class TaskkillHelperCleanupError extends Error {}

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function validateWait(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CLEANUP_WAIT_MS) {
    throw new Error(`${label} must be between 0 and ${MAX_CLEANUP_WAIT_MS}ms`);
  }
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  validateWait(timeoutMs, "Process exit timeout");
  if (exited(child)) return true;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", closed);
      child.off("exit", closed);
      resolve(value || exited(child));
    };
    const closed = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", closed);
    child.once("exit", closed);
    if (exited(child)) finish(true);
  });
}

async function runTaskkill(
  pid: number,
  force: boolean,
  timeoutMs: number,
  options: ProcessTreeTerminationOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const root = env.SystemRoot || env.WINDIR;
  if (!root) throw new Error("Windows system directory is unavailable for process cleanup");
  const executable = join(root, "System32", "taskkill.exe");
  const spawnProcess = options.spawnProcess ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const killer = spawnProcess(executable, ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.off("error", failed);
      killer.off("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => finish(error);
    const closed = (code: number | null) =>
      code === 0 || code === 128 ? finish() : finish(new Error(`taskkill failed with exit code ${code}`));
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        killer.off("error", failed);
        killer.off("close", closed);
        killer.once("error", () => {});
        void (async () => {
          try {
            killer.kill("SIGKILL");
          } catch {}
          const reapMs = Math.min(1_000, Math.max(50, timeoutMs));
          const reaped = await waitForExit(killer, reapMs);
          reject(
            reaped
              ? new Error(`taskkill did not exit within ${timeoutMs}ms`)
              : new TaskkillHelperCleanupError(
                  `taskkill did not exit within ${timeoutMs}ms and could not be reaped within ${reapMs}ms`,
                ),
          );
        })();
      },
      Math.max(1, timeoutMs),
    );
    killer.once("error", failed);
    killer.once("close", closed);
  });
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || exited(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  label: string,
  gracefulMs = 2_000,
  forceMs = 5_000,
  options: ProcessTreeTerminationOptions = {},
): Promise<void> {
  validateWait(gracefulMs, "Graceful cleanup timeout");
  validateWait(forceMs, "Forced cleanup timeout");
  if (exited(child)) return;
  if (!child.pid) throw new Error(`${label} process has no PID`);
  const platform = options.platform ?? process.platform;
  let helperFailure: TaskkillHelperCleanupError | undefined;
  if (platform === "win32") {
    try {
      await runTaskkill(child.pid, false, gracefulMs, options);
    } catch (error) {
      if (error instanceof TaskkillHelperCleanupError) helperFailure = error;
    }
  } else signalTree(child, "SIGTERM");
  if (await waitForExit(child, gracefulMs)) {
    if (helperFailure) throw helperFailure;
    return;
  }
  if (platform === "win32") {
    try {
      await runTaskkill(child.pid, true, forceMs, options);
    } catch (error) {
      if (helperFailure) throw new AggregateError([helperFailure, error], `${label} cleanup helpers failed`);
      throw error;
    }
  } else signalTree(child, "SIGKILL");
  if (!(await waitForExit(child, forceMs))) throw new Error(`${label} process tree did not terminate`);
  if (helperFailure) throw helperFailure;
}

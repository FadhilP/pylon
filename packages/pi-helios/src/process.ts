import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise<boolean>((resolve) => {
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

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root)
    throw new Error(
      "Windows system directory is unavailable for process cleanup",
    );
  const executable = join(root, "System32", "taskkill.exe");
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(
      executable,
      ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
      {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", reject);
    killer.once("close", (code) =>
      code === 0 || code === 128
        ? resolve()
        : reject(new Error(`taskkill failed with exit code ${code}`)),
    );
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
): Promise<void> {
  if (exited(child)) return;
  if (!child.pid) throw new Error(`${label} process has no PID`);
  if (process.platform === "win32")
    await runTaskkill(child.pid, false).catch(() => {});
  else signalTree(child, "SIGTERM");
  if (await waitForExit(child, gracefulMs)) return;
  if (process.platform === "win32") await runTaskkill(child.pid, true);
  else signalTree(child, "SIGKILL");
  if (!(await waitForExit(child, forceMs)))
    throw new Error(`${label} process tree did not terminate`);
}

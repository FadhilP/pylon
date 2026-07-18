import { spawn, type ChildProcess } from "node:child_process";
export function shellInvocation(command: string) {
  return process.platform === "win32"
    ? { command, args: [], shell: true }
    : {
        command: process.env.SHELL || "/bin/sh",
        args: ["-lc", command],
        shell: false,
      };
}
export function killTree(child: ChildProcess, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {}
}

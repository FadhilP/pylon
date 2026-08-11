import { spawn, type ChildProcess } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export function shellInvocation(command: string, shellPath?: string) {
  const config = getShellConfig(shellPath);
  const stdin = config.commandTransport === "stdin" ? command : undefined;
  return {
    command: config.shell,
    args: stdin === undefined ? [...config.args, command] : config.args,
    shell: false,
    stdin,
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

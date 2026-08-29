import { spawn } from "node:child_process";

export type ExecutableProbe = (command: string, signal?: AbortSignal) => Promise<boolean>;

export const executableAvailable: ExecutableProbe = (command, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const child = spawn(command, ["--version"], { shell: false, stdio: "ignore", signal });
    child.once("spawn", () => {
      child.kill();
      resolve(true);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });

import { execFile } from "node:child_process";

/** Runs git and resolves trimmed stdout; rejects with bounded stderr. */
export function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) =>
        error
          ? reject(Error(String(stderr || error.message).slice(0, 8192)))
          : resolve(String(stdout).replace(/\r?\n$/, "")),
    ),
  );
}

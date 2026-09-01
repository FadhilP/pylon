import { execFile } from "node:child_process";

let timeoutMs = 120_000;
/** Timeline sets this once at session start so all package git operations share that session's snapshot. */
export const setGitTimeoutMs = (value: number) => {
  timeoutMs = value;
};
export function git(cwd: string, args: string[], env: Record<string, string> = {}) {
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

export async function symbolicHead(cwd: string): Promise<string | null> {
  const ref = await git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  return ref === "HEAD" ? null : ref;
}

import { git as runGit } from "pylon-core/git";

let timeoutMs = 120_000;
/** Timeline sets this once at session start so all package git operations share that session's snapshot. */
export const setGitTimeoutMs = (value: number) => {
  timeoutMs = value;
};
export const git = (cwd: string, args: string[], env: Record<string, string> = {}) => runGit(cwd, args, env, timeoutMs);

export async function symbolicHead(cwd: string): Promise<string | null> {
  const ref = await git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  return ref === "HEAD" ? null : ref;
}

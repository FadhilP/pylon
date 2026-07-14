import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const result = await exec("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return String(result.stdout).replace(/\r?\n$/, "");
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]),
      head = await git(root, ["rev-parse", "HEAD"]),
      status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status) return `${root}\n${head}\nclean`;

    const indexTree = await git(root, ["write-tree"]),
      dir = await mkdtemp(join(tmpdir(), "pi-continuity-")),
      index = join(dir, "index"),
      env = { GIT_INDEX_FILE: index };
    try {
      await git(root, ["read-tree", "HEAD"], env);
      await git(root, ["add", "-A", "--", "."], env);
      const worktreeTree = await git(root, ["write-tree"], env);
      return `${root}\n${head}\n${indexTree}\n${worktreeTree}`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return undefined;
  }
}

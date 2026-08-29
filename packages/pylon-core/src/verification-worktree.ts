import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export type CommandResult = { code: number | null; stdout: string; stderr: string };
export type CommandExecutor = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout: number },
) => Promise<CommandResult>;

/** Content-sensitive worktree identity shared by Verify and verification consumers. */
export async function verificationWorktreeState(exec: CommandExecutor, cwd: string, signal?: AbortSignal) {
  try {
    const options = { cwd, signal, timeout: 15_000 };
    const [head, status, index, paths] = await Promise.all([
      exec("git", ["rev-parse", "HEAD"], options),
      exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], options),
      exec("git", ["diff", "--cached", "--raw", "-z", "HEAD", "--"], options),
      exec("git", ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"], options),
    ]);
    if ([head, status, index, paths].some(result => result.code !== 0)) return undefined;
    const changedPaths = [...new Set(paths.stdout.split("\0").filter(Boolean))].sort();
    const content = createHash("sha256")
      .update(head.stdout.trim())
      .update("\0")
      .update(status.stdout)
      .update("\0")
      .update(index.stdout)
      .update("\0");
    for (let offset = 0; offset < changedPaths.length; offset += 64) {
      const existing = (
        await Promise.all(
          changedPaths.slice(offset, offset + 64).map(
            async path =>
              await lstat(join(cwd, path)).then(
                () => path,
                () => undefined,
              ),
          ),
        )
      ).filter((path): path is string => path !== undefined);
      if (!existing.length) continue;
      const hashes = await exec("git", ["hash-object", "--no-filters", "--", ...existing], options);
      if (hashes.code !== 0) return undefined;
      content.update(existing.map((path, index) => `${path}\0${hashes.stdout.split(/\r?\n/)[index] ?? ""}\0`).join(""));
    }
    return { id: content.digest("hex").slice(0, 16), dirty: Boolean(status.stdout.trim()), status: status.stdout };
  } catch {
    return undefined;
  }
}

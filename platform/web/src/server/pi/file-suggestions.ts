import { execFile } from "node:child_process";
import { basename } from "node:path";
import { collectPlainWorkspaceFiles } from "pylon-core/src/worktree.ts";

const CACHE_MS = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_PATHS = 20_000;
const MAX_CACHES = 25;

interface CacheEntry {
  expiresAt: number;
  paths?: string[];
}

const cache = new Map<string, CacheEntry>();

export async function suggestGitFiles(cwd: string, query: string, limit = 15): Promise<{ available: boolean; paths: string[] }> {
  const paths = await inventory(cwd);
  if (!paths) return { available: false, paths: [] };
  return {
    available: true,
    paths: rankFilePaths(paths, query).slice(0, Math.max(1, Math.min(20, limit))),
  };
}

export function invalidateFileSuggestions(cwd: string): void {
  cache.delete(cwd);
}

export function rankFilePaths(paths: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return paths
    .flatMap((path) => {
      if (!validRelativePath(path)) return [];
      if (!needle) return [{ path, rank: 5 }];
      const lower = path.toLowerCase();
      const name = basename(lower);
      const rank = name === needle ? 0
        : name.startsWith(needle) ? 1
          : lower.split("/").some((part) => part.startsWith(needle)) ? 2
            : lower.startsWith(needle) ? 3
              : lower.includes(needle) ? 4
                : -1;
      return rank < 0 ? [] : [{ path, rank }];
    })
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .map((item) => item.path);
}

function validRelativePath(path: string): boolean {
  return path.length > 0
    && path.length <= 500
    && !path.startsWith("/")
    && !/^[A-Za-z]:/.test(path)
    && !path.includes("\\")
    && !path.includes("\0")
    && !path.split("/").some((part) => part === "." || part === ".." || part === "");
}

async function inventory(cwd: string): Promise<string[] | undefined> {
  const existing = cache.get(cwd);
  if (existing && existing.expiresAt > Date.now()) return existing.paths;

  const paths = await gitFiles(cwd)
    ?? (await collectPlainWorkspaceFiles({ cwd })).files.map((file) => file.path);
  if (cache.size >= MAX_CACHES) cache.delete(cache.keys().next().value!);
  cache.set(cwd, { expiresAt: Date.now() + CACHE_MS, paths });
  return paths;
}

function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, windowsHide: true, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || "code" in error && error.code === 128) {
            resolve(undefined);
            return;
          }
          reject(error);
          return;
        }
        const paths = stdout.split("\0").filter(validRelativePath);
        resolve(paths.length > MAX_PATHS ? paths.slice(0, MAX_PATHS) : paths);
      },
    );
  });
}

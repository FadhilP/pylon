import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { collectPlainWorkspaceFiles } from "pylon-core/src/worktree.ts";

const CACHE_MS = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_PATHS = 20_000;
const MAX_CACHES = 25;
const MAX_EMBEDDED_REPO_DEPTH = 4;

interface CacheEntry {
  expiresAt: number;
  paths?: string[];
}

const cache = new Map<string, CacheEntry>();

export async function suggestGitFiles(
  cwd: string,
  query: string,
  limit = 15,
): Promise<{ available: boolean; paths: string[] }> {
  const paths = await inventory(cwd);
  if (!paths) return { available: false, paths: [] };
  return { available: true, paths: rankFilePaths(paths, query).slice(0, Math.max(1, Math.min(20, limit))) };
}

export function invalidateFileSuggestions(cwd: string): void {
  cache.delete(cwd);
}

export function rankFilePaths(paths: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return paths
    .flatMap(path => {
      if (!validRelativePath(path)) return [];
      if (!needle) return [{ path, rank: 5 }];
      const lower = path.toLowerCase();
      const name = basename(lower.endsWith("/") ? lower.slice(0, -1) : lower);
      const rank =
        name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : lower.split("/").some(part => part.startsWith(needle))
              ? 2
              : lower.startsWith(needle)
                ? 3
                : lower.includes(needle)
                  ? 4
                  : -1;
      return rank < 0 ? [] : [{ path, rank }];
    })
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .map(item => item.path);
}

function validRelativePath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    path.length <= 500 &&
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized.includes("\\") &&
    !normalized.includes("\0") &&
    !normalized.split("/").some(part => part === "." || part === ".." || part === "")
  );
}

function includeDirectories(paths: string[]): string[] {
  const entries = new Set(paths);
  for (const path of paths) {
    for (let separator = path.indexOf("/"); separator >= 0; separator = path.indexOf("/", separator + 1)) {
      entries.add(path.slice(0, separator + 1));
      if (entries.size >= MAX_PATHS * 2) return [...entries];
    }
  }
  return [...entries];
}

async function inventory(cwd: string): Promise<string[] | undefined> {
  const existing = cache.get(cwd);
  if (existing && existing.expiresAt > Date.now()) return existing.paths;

  const files = (await gitFiles(cwd)) ?? (await collectPlainWorkspaceFiles({ cwd })).files.map(file => file.path);
  const paths = includeDirectories(files.slice(0, MAX_PATHS));
  if (cache.size >= MAX_CACHES) cache.delete(cache.keys().next().value!);
  cache.set(cwd, { expiresAt: Date.now() + CACHE_MS, paths });
  return paths;
}

async function gitFiles(cwd: string, depth = 0): Promise<string[] | undefined> {
  const stdout = await new Promise<string | undefined>((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, windowsHide: true, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, output) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || ("code" in error && error.code === 128)) {
            resolve(undefined);
            return;
          }
          reject(error);
          return;
        }
        resolve(output);
      },
    );
  });
  if (stdout === undefined) return undefined;
  const paths: string[] = [];
  for (const entry of stdout.split("\0").filter(path => path.length > 0)) {
    if (entry.endsWith("/") && depth < MAX_EMBEDDED_REPO_DEPTH) {
      // Collapsed embedded repository: list it from its own checkout.
      const nested = await gitFiles(join(cwd, entry), depth + 1);
      if (nested !== undefined) paths.push(...nested.map(path => entry + path));
      continue;
    }
    if (!validRelativePath(entry)) continue;
    paths.push(entry);
  }
  return paths.length > MAX_PATHS ? paths.slice(0, MAX_PATHS) : paths;
}

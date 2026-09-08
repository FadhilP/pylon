import { execFile } from "node:child_process";
import { join } from "node:path";
import { rankFilePaths, validRelativePath } from "../../shared/workspace/file-search.ts";
export { rankFilePaths } from "../../shared/workspace/file-search.ts";
import { collectPlainWorkspaceFiles } from "pylon-core/src/worktree.ts";

const CACHE_MS = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_PATHS = 20_000;
const MAX_CACHES = 25;
const MAX_EMBEDDED_REPO_DEPTH = 4;

interface CacheEntry {
  expiresAt: number;
  paths?: string[];
  pending?: Promise<string[]>;
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
  if (existing?.pending) return existing.pending;
  if (existing && existing.expiresAt > Date.now()) return existing.paths;

  const entry: CacheEntry = { expiresAt: 0 };
  cache.delete(cwd);
  if (cache.size >= MAX_CACHES) cache.delete(cache.keys().next().value!);
  cache.set(cwd, entry);
  entry.pending = (async () => {
    const files = (await gitFiles(cwd)) ?? (await collectPlainWorkspaceFiles({ cwd })).files.map(file => file.kind ? `${file.path}/` : file.path);
    return includeDirectories(files.slice(0, MAX_PATHS));
  })().then(paths => {
    if (cache.get(cwd) === entry) {
      entry.paths = paths;
      entry.expiresAt = Date.now() + CACHE_MS;
      entry.pending = undefined;
    }
    return paths;
  }, error => {
    if (cache.get(cwd) === entry) cache.delete(cwd);
    throw error;
  });
  return entry.pending;
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

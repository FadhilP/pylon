import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { rankFilePaths, validRelativePath } from "../../shared/workspace/file-search.ts";
export { rankFilePaths } from "../../shared/workspace/file-search.ts";
import { collectPlainWorkspaceFiles } from "pylon-core/src/worktree.ts";

const CACHE_MS = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_PATHS = 20_000;
const MAX_CACHES = 25;
const MAX_EMBEDDED_REPO_DEPTH = 4;
const MAX_REPOSITORIES = 64;

interface GitTraversal {
  root: string;
  visited: Set<string>;
  remainingPaths: number;
}

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

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise<string | undefined>((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, output) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || ("code" in error && error.code === 128)) {
            resolveOutput(undefined);
            return;
          }
          reject(error);
          return;
        }
        resolveOutput(output);
      },
    );
  });
}

const canonicalPath = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

function outside(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

async function childRepository(
  cwd: string,
  path: string,
  traversal: GitTraversal,
): Promise<string | undefined> {
  if (!validRelativePath(path)) return undefined;
  const absolute = resolve(cwd, path.endsWith("/") ? path.slice(0, -1) : path);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return undefined;
  const physical = await realpath(absolute).catch(() => undefined);
  if (!physical || outside(traversal.root, physical)) return undefined;
  const reported = (await gitOutput(physical, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!reported) return undefined;
  const topLevel = await realpath(reported).catch(() => undefined);
  const identity = canonicalPath(physical);
  if (!topLevel || canonicalPath(topLevel) !== identity || traversal.visited.has(identity)) return undefined;
  if (traversal.visited.size >= MAX_REPOSITORIES) return undefined;
  traversal.visited.add(identity);
  return physical;
}

function stagedGitlinks(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const record of stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const space = record.indexOf(" ");
    if (tab < 0 || space < 0 || record.slice(0, space) !== "160000") continue;
    const path = record.slice(tab + 1);
    if (validRelativePath(path)) paths.add(path);
  }
  return paths;
}

async function gitFiles(cwd: string, depth = 0, state?: GitTraversal): Promise<string[] | undefined> {
  const stdout = await gitOutput(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (stdout === undefined) return undefined;
  const staged = await gitOutput(cwd, ["ls-files", "--stage", "-z"]);
  if (staged === undefined) return [];
  const physicalCwd = await realpath(cwd);
  const traversal = state ?? {
    root: physicalCwd,
    visited: new Set([canonicalPath(physicalCwd)]),
    remainingPaths: MAX_PATHS,
  };
  const paths: string[] = [];
  const links = stagedGitlinks(staged);
  const handledLinks = new Set<string>();
  const addPath = (path: string) => {
    if (traversal.remainingPaths <= 0) return false;
    paths.push(path);
    traversal.remainingPaths--;
    return true;
  };
  const addNested = async (path: string, marker: boolean) => {
    const prefix = path.endsWith("/") ? path.slice(0, -1) : path;
    if (marker && !addPath(`${prefix}/`)) return;
    if (depth >= MAX_EMBEDDED_REPO_DEPTH || traversal.remainingPaths <= 0) {
      if (!marker) addPath(`${prefix}/`);
      return;
    }
    const child = await childRepository(physicalCwd, path, traversal);
    if (!child) return;
    const nested = await gitFiles(child, depth + 1, traversal);
    if (nested !== undefined) paths.push(...nested.map(childPath => `${prefix}/${childPath}`));
  };

  for (const entry of stdout.split("\0").filter(Boolean)) {
    if (traversal.remainingPaths <= 0) break;
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (links.has(normalized)) {
      if (!handledLinks.has(normalized)) {
        handledLinks.add(normalized);
        await addNested(normalized, true);
      }
      continue;
    }
    if (!validRelativePath(entry)) continue;
    if (entry.endsWith("/")) await addNested(entry, false);
    else addPath(entry);
  }
  for (const link of links) {
    if (traversal.remainingPaths <= 0) break;
    if (!handledLinks.has(link)) await addNested(link, true);
  }
  return paths;
}

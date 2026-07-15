import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";

export type WorktreeSnapshot = {
  available: boolean;
  paths: Map<string, string>;
  root?: string;
  head?: string;
  error?: string;
};

export type Exec = (command: string, args: string[], options?: any) => Promise<{ code: number; stdout: string; stderr: string }>;

export function parsePorcelainZ(output: string): string[] {
  const records = output.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.add(record.slice(3));
    if (/[RC]/.test(status)) {
      const original = records[++index];
      if (original) paths.add(original);
    }
  }
  return [...paths].sort();
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

async function fileFingerprint(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
    if (!info.isFile()) return `other:${info.mode}:${info.size}`;
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } catch (error: any) {
    return error?.code === "ENOENT" ? "missing" : `error:${error?.code ?? "unknown"}`;
  }
}

export async function captureWorktree(exec: Exec, cwd: string): Promise<WorktreeSnapshot> {
  try {
    const rootResult = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    if (rootResult.code !== 0) return { available: false, paths: new Map(), error: rootResult.stderr.trim() || "not a Git worktree" };
    const root = rootResult.stdout.trim();
    const [status, headResult] = await Promise.all([
      exec("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 10_000 }),
      exec("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 10_000 }),
    ]);
    if (status.code !== 0) return { available: false, paths: new Map(), root, error: status.stderr.trim() || "git status failed" };
    if (headResult.code !== 0) return { available: false, paths: new Map(), root, error: "Git repository has no HEAD commit" };
    const dirtyPaths = parsePorcelainZ(status.stdout);
    const fingerprints = await mapConcurrent(dirtyPaths, 8, (path) => fileFingerprint(root, path));
    const paths = new Map(dirtyPaths.map((path, index) => [path, fingerprints[index]]));
    return { available: true, paths, root, head: headResult.stdout.trim() };
  } catch (error: any) {
    return { available: false, paths: new Map(), error: error?.message ?? String(error) };
  }
}

export async function compareWorktrees(before: WorktreeSnapshot, after: WorktreeSnapshot, cwd = before.root ?? ""): Promise<{
  changedPaths: string[];
  preExistingDirtyTouched: string[];
}> {
  if (!before.available || !after.available) return { changedPaths: [], preExistingDirtyTouched: [] };
  const root = before.root ?? after.root ?? cwd;
  const candidates = new Set([...before.paths.keys(), ...after.paths.keys()]);
  const changedPaths: string[] = [];
  const preExistingDirtyTouched: string[] = [];
  for (const path of candidates) {
    const beforeFingerprint = before.paths.get(path);
    const afterFingerprint = after.paths.get(path) ?? await fileFingerprint(root, path);
    if (beforeFingerprint === undefined || beforeFingerprint !== afterFingerprint) {
      changedPaths.push(path);
      if (beforeFingerprint !== undefined) preExistingDirtyTouched.push(path);
    }
  }
  return { changedPaths: changedPaths.sort(), preExistingDirtyTouched: preExistingDirtyTouched.sort() };
}

import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { captureWorktree, compareWorktrees, type Exec, type WorktreeSnapshot } from "./worktree.ts";

export type IsolatedWorktree = {
  parentRoot: string;
  parentCwd: string;
  workerRoot: string;
  workerCwd: string;
  temporaryRoot: string;
  parentBaseline: WorktreeSnapshot;
  workerHead: string;
  isolationVerified: true;
  releaseTransaction: () => void;
};

const transactionQueues = new Map<string, Promise<void>>();

async function acquireTransaction(key: string, signal?: AbortSignal): Promise<() => void> {
  const previous = transactionQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  transactionQueues.set(key, tail);
  await previous;
  if (signal?.aborted) {
    release();
    if (transactionQueues.get(key) === tail) transactionQueues.delete(key);
    throw new Error("Grunt aborted while waiting for repository transaction");
  }
  return () => {
    release();
    if (transactionQueues.get(key) === tail) transactionQueues.delete(key);
  };
}

function failure(label: string, result: { code: number; stderr: string }): Error {
  return new Error(`${label}: ${result.stderr.trim() || `exit ${result.code}`}`);
}

async function mirrorPath(sourceRoot: string, targetRoot: string, path: string): Promise<void> {
  const source = join(sourceRoot, path);
  const target = join(targetRoot, path);
  let info;
  try {
    info = await lstat(source);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      await rm(target, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported tracked or untracked path: ${path}`);
  await copyFile(source, target);
  await chmod(target, info.mode);
}

async function mapConcurrent<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}

export async function createIsolatedWorktree(exec: Exec, cwd: string, signal?: AbortSignal): Promise<IsolatedWorktree> {
  const initial = await captureWorktree(exec, cwd);
  if (!initial.available || !initial.root || !initial.head)
    throw new Error(initial.error ?? "Grunt requires a Git worktree with a HEAD commit");
  const parentRoot = initial.root;
  const releaseTransaction = await acquireTransaction(parentRoot, signal);
  let temporaryRoot: string | undefined;
  let workerRoot: string | undefined;
  let added = false;
  try {
    const parentBaseline = await captureWorktree(exec, cwd);
    if (!parentBaseline.available || !parentBaseline.root || !parentBaseline.head)
      throw new Error(parentBaseline.error ?? "Grunt requires a Git worktree with a HEAD commit");
    const relativeCwd = relative(parentRoot, cwd);
    if (relativeCwd.startsWith("..")) throw new Error("Current directory is outside the Git worktree");

    temporaryRoot = await mkdtemp(join(tmpdir(), "pi-grunt-"));
    workerRoot = join(temporaryRoot, "worktree");
    const disabledHooks = join(temporaryRoot, "disabled-hooks");
    await mkdir(disabledHooks);
    const add = await exec("git", [
      "-c", `core.hooksPath=${disabledHooks}`, "-C", parentRoot,
      "worktree", "add", "--detach", workerRoot, parentBaseline.head,
    ], { timeout: 60_000, signal });
    if (add.code !== 0) throw failure("Unable to create isolated worktree", add);
    added = true;

    // Worktree add already checked out every clean tracked file. Mirror only dirty/deleted
    // tracked paths and ordinary untracked paths captured in the parent baseline.
    await mapConcurrent([...parentBaseline.paths.keys()], 8, (path) => mirrorPath(parentRoot, workerRoot!, path));

    const addBaseline = await exec("git", ["-C", workerRoot, "add", "-A"], { timeout: 60_000, signal });
    if (addBaseline.code !== 0) throw failure("Unable to stage isolated baseline", addBaseline);
    const commit = await exec("git", [
      "-c", `core.hooksPath=${disabledHooks}`, "-C", workerRoot,
      "-c", "user.name=pi-grunt", "-c", "user.email=pi-grunt@local",
      "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", "pi-grunt isolated baseline",
    ], { timeout: 60_000, signal });
    if (commit.code !== 0) throw failure("Unable to commit isolated baseline", commit);

    const parentChanges = await parentChangesSinceBaseline(exec, {
      parentRoot, parentBaseline,
    } as IsolatedWorktree);
    if (parentChanges.length) throw new Error(`Parent changed while creating isolation: ${parentChanges.join(", ")}`);

    const workerCwd = relativeCwd ? join(workerRoot, relativeCwd) : workerRoot;
    await mkdir(workerCwd, { recursive: true });
    const [topLevel, workerHeadResult] = await Promise.all([
      exec("git", ["-C", workerCwd, "rev-parse", "--show-toplevel"], { timeout: 10_000, signal }),
      exec("git", ["-C", workerCwd, "rev-parse", "HEAD"], { timeout: 10_000, signal }),
    ]);
    if (topLevel.code !== 0 || workerHeadResult.code !== 0)
      throw new Error("Unable to verify isolated worker Git context");
    const [actualWorkerRoot, expectedWorkerRoot, actualParentRoot] = await Promise.all([
      realpath(topLevel.stdout.trim()), realpath(workerRoot), realpath(parentRoot),
    ]);
    if (actualWorkerRoot !== expectedWorkerRoot || actualWorkerRoot === actualParentRoot)
      throw new Error("Worker Git context is not the isolated worktree");

    return {
      parentRoot, parentCwd: cwd, workerRoot, workerCwd, temporaryRoot, parentBaseline,
      workerHead: workerHeadResult.stdout.trim(), isolationVerified: true, releaseTransaction,
    };
  } catch (error) {
    if (added && workerRoot) await exec("git", ["-C", parentRoot, "worktree", "remove", "--force", workerRoot], { timeout: 60_000 }).catch(() => {});
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    releaseTransaction();
    throw error;
  }
}

export async function collectWorkerPatch(exec: Exec, isolated: IsolatedWorktree): Promise<{
  patch: string;
  changedPaths: string[];
}> {
  const intent = await exec("git", ["-C", isolated.workerRoot, "add", "-N", "--", "."], { timeout: 60_000 });
  if (intent.code !== 0) throw failure("Unable to inspect worker changes", intent);
  const [diff, names] = await Promise.all([
    exec("git", ["-C", isolated.workerRoot, "diff", "--binary", isolated.workerHead, "--"], { timeout: 60_000 }),
    exec("git", ["-C", isolated.workerRoot, "diff", "--name-only", "-z", isolated.workerHead, "--"], { timeout: 60_000 }),
  ]);
  if (diff.code !== 0) throw failure("Unable to create worker patch", diff);
  if (names.code !== 0) throw failure("Unable to derive worker paths", names);
  return { patch: diff.stdout, changedPaths: names.stdout.split("\0").filter(Boolean).sort() };
}

export async function parentChangesSinceBaseline(exec: Exec, isolated: IsolatedWorktree): Promise<string[]> {
  const current = await captureWorktree(exec, isolated.parentRoot);
  if (!current.available) return ["<parent unavailable>"];
  if (current.head !== isolated.parentBaseline.head) return ["<HEAD changed>"];
  return (await compareWorktrees(isolated.parentBaseline, current, isolated.parentRoot)).changedPaths;
}

export async function applyWorkerPatch(exec: Exec, isolated: IsolatedWorktree, patch: string): Promise<void> {
  if (!patch) return;
  const parentChanges = await parentChangesSinceBaseline(exec, isolated);
  if (parentChanges.length) throw new Error(`Parent changed immediately before patch apply: ${parentChanges.join(", ")}`);
  const patchPath = join(isolated.temporaryRoot, "worker.patch");
  await writeFile(patchPath, patch, { mode: 0o600 });
  const apply = await exec("git", ["-C", isolated.parentRoot, "apply", "--binary", "--whitespace=nowarn", patchPath], { timeout: 60_000 });
  if (apply.code !== 0) throw failure("Unable to apply worker patch", apply);
}

export async function persistPatchArtifact(patch: string): Promise<string | undefined> {
  if (!patch) return;
  const directory = join(getAgentDir(), "pi-grunt", "artifacts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${Date.now()}-${randomUUID()}.patch`);
  await writeFile(path, patch, { mode: 0o600 });
  return path;
}

export async function removeIsolatedWorktree(exec: Exec, isolated: IsolatedWorktree): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const result = await exec("git", ["-C", isolated.parentRoot, "worktree", "remove", "--force", isolated.workerRoot], { timeout: 60_000 });
    if (result.code !== 0) warnings.push(`worktree cleanup: ${result.stderr.trim() || `exit ${result.code}`}`);
  } catch (error: any) {
    warnings.push(`worktree cleanup: ${error?.message ?? String(error)}`);
  }
  try {
    await rm(isolated.temporaryRoot, { recursive: true, force: true });
  } catch (error: any) {
    warnings.push(`temporary cleanup: ${error?.message ?? String(error)}`);
  } finally {
    isolated.releaseTransaction();
  }
  return warnings;
}

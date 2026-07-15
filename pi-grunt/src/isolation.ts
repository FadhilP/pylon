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
};

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

export async function createIsolatedWorktree(exec: Exec, cwd: string): Promise<IsolatedWorktree> {
  const parentBaseline = await captureWorktree(exec, cwd);
  if (!parentBaseline.available || !parentBaseline.root || !parentBaseline.head)
    throw new Error(parentBaseline.error ?? "Grunt requires a Git worktree with a HEAD commit");
  const parentRoot = parentBaseline.root;
  const relativeCwd = relative(parentRoot, cwd);
  if (relativeCwd.startsWith("..")) throw new Error("Current directory is outside the Git worktree");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-grunt-"));
  const workerRoot = join(temporaryRoot, "worktree");
  let added = false;
  try {
    const add = await exec("git", ["-C", parentRoot, "worktree", "add", "--detach", workerRoot, parentBaseline.head], { timeout: 60_000 });
    if (add.code !== 0) throw failure("Unable to create isolated worktree", add);
    added = true;

    const files = await exec("git", ["-C", parentRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { timeout: 60_000 });
    if (files.code !== 0) throw failure("Unable to enumerate parent snapshot", files);
    for (const path of files.stdout.split("\0").filter(Boolean)) await mirrorPath(parentRoot, workerRoot, path);

    const addBaseline = await exec("git", ["-C", workerRoot, "add", "-A"], { timeout: 60_000 });
    if (addBaseline.code !== 0) throw failure("Unable to stage isolated baseline", addBaseline);
    const commit = await exec("git", [
      "-C", workerRoot, "-c", "user.name=pi-grunt", "-c", "user.email=pi-grunt@local",
      "commit", "--no-gpg-sign", "--allow-empty", "-m", "pi-grunt isolated baseline",
    ], { timeout: 60_000 });
    if (commit.code !== 0) throw failure("Unable to commit isolated baseline", commit);

    const workerCwd = relativeCwd ? join(workerRoot, relativeCwd) : workerRoot;
    await mkdir(workerCwd, { recursive: true });
    const [topLevel, workerHeadResult] = await Promise.all([
      exec("git", ["-C", workerCwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 }),
      exec("git", ["-C", workerCwd, "rev-parse", "HEAD"], { timeout: 10_000 }),
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
      workerHead: workerHeadResult.stdout.trim(), isolationVerified: true,
    };
  } catch (error) {
    if (added) await exec("git", ["-C", parentRoot, "worktree", "remove", "--force", workerRoot], { timeout: 60_000 }).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function collectWorkerPatch(exec: Exec, isolated: IsolatedWorktree): Promise<{
  patch: string;
  changedPaths: string[];
}> {
  const intent = await exec("git", ["-C", isolated.workerRoot, "add", "-N", "--", "."], { timeout: 60_000 });
  if (intent.code !== 0) throw failure("Unable to inspect worker changes", intent);
  const [diff, snapshot] = await Promise.all([
    exec("git", ["-C", isolated.workerRoot, "diff", "--binary", "HEAD", "--"], { timeout: 60_000 }),
    captureWorktree(exec, isolated.workerRoot),
  ]);
  if (diff.code !== 0) throw failure("Unable to create worker patch", diff);
  if (!snapshot.available) throw new Error(snapshot.error ?? "Unable to inspect isolated worktree");
  return { patch: diff.stdout, changedPaths: [...snapshot.paths.keys()].sort() };
}

export async function parentChangesSinceBaseline(exec: Exec, isolated: IsolatedWorktree): Promise<string[]> {
  const current = await captureWorktree(exec, isolated.parentRoot);
  if (!current.available) return ["<parent unavailable>"];
  if (current.head !== isolated.parentBaseline.head) return ["<HEAD changed>"];
  return (await compareWorktrees(isolated.parentBaseline, current, isolated.parentRoot)).changedPaths;
}

export async function applyWorkerPatch(exec: Exec, isolated: IsolatedWorktree, patch: string): Promise<void> {
  if (!patch) return;
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

export async function removeIsolatedWorktree(exec: Exec, isolated: IsolatedWorktree): Promise<void> {
  await exec("git", ["-C", isolated.parentRoot, "worktree", "remove", "--force", isolated.workerRoot], { timeout: 60_000 }).catch(() => {});
  await rm(isolated.temporaryRoot, { recursive: true, force: true });
}

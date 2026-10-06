import { copyFile, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.ts";
import { type GitWorkspace } from "./worktree-types.ts";

/** Shared Git plumbing for the worktree modules; not part of the public worktree API. */

export const ident = {
  GIT_AUTHOR_NAME: "Pylon",
  GIT_AUTHOR_EMAIL: "pylon@local",
  GIT_COMMITTER_NAME: "Pylon",
  GIT_COMMITTER_EMAIL: "pylon@local",
};
export const objectId = /^[0-9a-f]{40,64}$/i;
export const worktreeId = /^[A-Za-z0-9._-]{8,80}$/;
export const ownedWorktreeBranch =
  /^refs\/heads\/(?:pylon-(?:worktree|checkout)-[A-Za-z0-9._-]{8,80}|pylon\/sessions\/[A-Za-z0-9._-]{1,80}|pylon-session-[A-Za-z0-9._-]{8,80})$/;
export const ownedTurnRef = /^refs\/pylon\/turns\/[A-Za-z0-9._-]{8,80}$/;
export const canonical = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
const rootCache = new Map<string, string>();
export const revisionCache = new Map<string, { head: string; tree: string }>();
export const snapshotRetryDelaysMs = [25, 50, 100, 200] as const;
export async function repositoryRoot(cwd: string): Promise<string> {
  const key = canonical(cwd);
  const cached = rootCache.get(key);
  if (
    cached &&
    (await stat(join(cached, ".git"))
      .then(() => true)
      .catch(() => false))
  )
    return cached;
  rootCache.delete(key);
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (canonical(root) === key) rootCache.set(key, root);
  return root;
}
export const outside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path);
};
export const splitNul = (value: string) => value.split("\0").filter(Boolean);

function fieldTail(record: string, fieldCount: number): string | undefined {
  let offset = 0;
  for (let field = 0; field < fieldCount; field++) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) return undefined;
    offset++;
  }
  return record.slice(offset) || undefined;
}

export function parseWorktreeStatus(status: string): { head: string; dirty: boolean; paths: string[] } {
  const records = splitNul(status);
  const head = records.find(record => record.startsWith("# branch.oid "))?.slice(13) ?? "";
  const paths = new Set<string>();
  let dirty = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# ")) continue;
    dirty = true;
    const path = record.startsWith("1 ")
      ? fieldTail(record, 8)
      : record.startsWith("2 ")
        ? fieldTail(record, 9)
        : record.startsWith("u ")
          ? fieldTail(record, 10)
          : record.startsWith("? ")
            ? record.slice(2)
            : undefined;
    if (path) paths.add(path);
    if (record.startsWith("2 ") && records[index + 1]) paths.add(records[++index]!);
  }
  return { head, dirty, paths: [...paths] };
}

export async function temporaryIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pylon-worktree-"));
  try {
    return await run({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function currentIndexTree(root: string, runGit = git): Promise<string> {
  const source = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  return temporaryIndex(async env => {
    const target = env.GIT_INDEX_FILE!;
    try {
      await copyFile(source, target);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await runGit(root, ["read-tree", "--empty"], env);
    }
    return runGit(root, ["write-tree"], env);
  });
}

export async function currentTree(root: string, head?: string, changedPaths?: string[], runGit = git): Promise<string> {
  return temporaryIndex(async env => {
    await runGit(root, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    const boundedPaths =
      changedPaths?.length &&
      changedPaths.length <= 500 &&
      changedPaths.reduce((size, path) => size + path.length + 1, 0) <= 24_000
        ? changedPaths.map(path => `:(literal)${path}`)
        : ["."];
    await runGit(root, ["add", "-A", "--", ...boundedPaths], env);
    return runGit(root, ["write-tree"], env);
  });
}

export async function head(root: string): Promise<string | undefined> {
  return git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
}

export async function headRef(root: string): Promise<string | undefined> {
  return git(root, ["symbolic-ref", "-q", "HEAD"]).catch(() => undefined);
}

export async function commonDirectory(root: string): Promise<string> {
  const value = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpath(value);
}

export function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!validSummaryPath(normalized)) throw Error("Unsafe workspace path.");
  return normalized;
}

export async function confinedFile(root: string, path: string): Promise<string> {
  const normalized = safeRelativePath(path);
  const absolute = resolve(root, normalized);
  if (outside(root, absolute)) throw Error("Unsafe workspace path.");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Only regular workspace files can be read.");
  const physical = await realpath(absolute);
  if (outside(await realpath(root), physical)) throw Error("Workspace file escapes its checkout.");
  return physical;
}

export async function assertSafeCheckout(workspace: GitWorkspace): Promise<void> {
  if ((await git(workspace.root, ["rev-parse", "--is-bare-repository"])) === "true") {
    throw Error("Bare repositories are unsupported.");
  }
  if ((await git(workspace.root, ["ls-files", "-u"])).trim()) {
    throw Error("Unmerged Git index is unsupported.");
  }
  const gitDir = await git(workspace.root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
    if (
      await stat(join(gitDir, name))
        .then(() => true)
        .catch(() => false)
    ) {
      throw Error("A Git operation is already in progress.");
    }
  }
  const paths = splitNul(await git(workspace.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const physicalRoot = await realpath(workspace.root);
  for (const path of paths.slice(0, 100_000)) {
    const safe = safeRelativePath(path);
    const absolute = resolve(workspace.root, safe);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isSymbolicLink()) continue;
    const target = await realpath(absolute);
    if (outside(physicalRoot, target)) throw Error(`External symlink is unsupported: ${safe}`);
  }
}

export const MAX_TURN_REPOSITORIES = 64;
export const MAX_SUBMODULE_DEPTH = 16;
export function validSummaryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.includes("\\") &&
    !path.split("/").some(part => !part || part === "." || part === "..")
  );
}

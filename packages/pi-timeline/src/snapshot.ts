import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, symbolicHead } from "./git.ts";
import { preflight, type RepositoryState } from "./safety.ts";

export type RepositorySnapshot = {
  prefix: string;
  gitRoot: string;
  head: string;
  headRef: string | null;
  worktreeRef: string;
  indexRef: string;
  worktreeTree: string;
  indexTree: string;
};
export type Snapshot = Omit<RepositorySnapshot, "prefix"> & {
  snapshotId: string;
  nested?: RepositorySnapshot[];
};
const ident = {
  GIT_AUTHOR_NAME: "pi-timeline",
  GIT_AUTHOR_EMAIL: "pi-timeline@local",
  GIT_COMMITTER_NAME: "pi-timeline",
  GIT_COMMITTER_EMAIL: "pi-timeline@local",
};

async function trees(repository: RepositoryState) {
  const dir = await mkdtemp(join(tmpdir(), "pi-timeline-")),
    index = join(dir, "index"), env = { GIT_INDEX_FILE: index };
  try {
    const indexTree = await git(repository.root, ["write-tree"]);
    await git(repository.root, ["read-tree", "HEAD"], env);
    await git(repository.root, ["add", "-A", "--", "."], env);
    return { indexTree, worktreeTree: await git(repository.root, ["write-tree"], env) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const { repositories } = await preflight(cwd),
      statuses = await Promise.all(repositories.map((repository) =>
        git(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"])));
    if (statuses.every((status) => !status))
      return repositories.map(({ prefix, root, head }) => `${prefix}\n${root}\n${head}\nclean`).join("\n");
    const values = await Promise.all(repositories.map(async (repository) => ({
      repository,
      ...await trees(repository),
    })));
    return values.map(({ repository, indexTree, worktreeTree }) =>
      `${repository.prefix}\n${repository.root}\n${repository.head}\n${indexTree}\n${worktreeTree}`).join("\n");
  } catch {
    return undefined;
  }
}

async function captureRepository(repository: RepositoryState, sessionId: string, id: string) {
  const { indexTree, worktreeTree } = await trees(repository),
    headRef = await symbolicHead(repository.root),
    wc = await git(repository.root, [
      "commit-tree", worktreeTree, "-p", repository.head, "-m", "pi-timeline worktree checkpoint",
    ], ident),
    ic = await git(repository.root, [
      "commit-tree", indexTree, "-p", repository.head, "-m", "pi-timeline index checkpoint",
    ], ident),
    owner = createHash("sha256").update(sessionId).digest("hex").slice(0, 16),
    base = `refs/pi-timeline/${owner}/${id}`,
    worktreeRef = `${base}/worktree`, indexRef = `${base}/index`;
  await git(repository.root, ["update-ref", worktreeRef, wc]);
  try {
    await git(repository.root, ["update-ref", indexRef, ic]);
  } catch (error) {
    await git(repository.root, ["update-ref", "-d", worktreeRef]).catch(() => {});
    throw error;
  }
  return {
    prefix: repository.prefix,
    gitRoot: repository.root,
    head: repository.head,
    headRef,
    worktreeRef,
    indexRef,
    worktreeTree,
    indexTree,
  } satisfies RepositorySnapshot;
}

async function deleteRefs(repository: RepositorySnapshot) {
  await git(repository.gitRoot, ["update-ref", "-d", repository.worktreeRef]).catch(() => {});
  await git(repository.gitRoot, ["update-ref", "-d", repository.indexRef]).catch(() => {});
}

export async function capture(
  cwd: string,
  sessionId: string,
  beforeRepository?: (root: string) => Promise<void>,
): Promise<Snapshot> {
  const initial = await preflight(cwd), id = randomBytes(6).toString("hex"),
    captured: RepositorySnapshot[] = [];
  try {
    for (const repository of initial.repositories) {
      await beforeRepository?.(repository.root);
      captured.push(await captureRepository(repository, sessionId, id));
    }
    const final = await preflight(cwd);
    if (final.repositories.length !== initial.repositories.length || final.repositories.some((repository, index) =>
      repository.root !== initial.repositories[index].root ||
      repository.prefix !== initial.repositories[index].prefix ||
      repository.head !== initial.repositories[index].head))
      throw Error("Repository graph changed during checkpoint.");
    const [root, ...nested] = captured;
    return {
      snapshotId: id,
      gitRoot: root.gitRoot,
      head: root.head,
      headRef: root.headRef,
      worktreeRef: root.worktreeRef,
      indexRef: root.indexRef,
      worktreeTree: root.worktreeTree,
      indexTree: root.indexTree,
      ...(nested.length ? { nested } : {}),
    };
  } catch (error) {
    await Promise.all(captured.map(deleteRefs));
    throw error;
  }
}

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, symbolicHead } from "./git.ts";
import { preflight, type RepositoryState } from "./safety.ts";

export type RepositorySnapshot = {
  prefix: string;
  gitRoot: string;
  commonDir?: string;
  head: string;
  headRef: string | null;
  worktreeRef: string;
  indexRef: string;
  worktreeTree: string;
  indexTree: string;
};
export type Snapshot = Omit<RepositorySnapshot, "prefix"> & { snapshotId: string; nested?: RepositorySnapshot[] };
const canonical = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
const ident = {
  GIT_AUTHOR_NAME: "pi-timeline",
  GIT_AUTHOR_EMAIL: "pi-timeline@local",
  GIT_COMMITTER_NAME: "pi-timeline",
  GIT_COMMITTER_EMAIL: "pi-timeline@local",
};

async function trees(repository: RepositoryState) {
  const dir = await mkdtemp(join(tmpdir(), "pi-timeline-")),
    index = join(dir, "index"),
    env = { GIT_INDEX_FILE: index };
  try {
    const indexTree = await git(repository.root, ["write-tree"]);
    await git(repository.root, ["read-tree", "HEAD"], env);
    await git(repository.root, ["add", "-A", "--", "."], env);
    return { indexTree, worktreeTree: await git(repository.root, ["write-tree"], env) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type FingerprintTrees = Pick<RepositorySnapshot, "indexTree" | "worktreeTree">;

async function headTrees(repository: RepositoryState): Promise<FingerprintTrees> {
  const tree = await git(repository.root, ["rev-parse", `${repository.head}^{tree}`]);
  return { indexTree: tree, worktreeTree: tree };
}

async function fingerprintTrees(repositories: RepositoryState[], statuses: string[]): Promise<FingerprintTrees[]> {
  const values = new Array<FingerprintTrees>(repositories.length);
  const groups = new Map<string, number[]>();
  for (let index = 0; index < repositories.length; index++) {
    const key = canonical(repositories[index]!.commonDir);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  const batches = [...groups.values()];
  let next = 0;
  // Keep linked worktrees (which share an object store and index locks) serial,
  // while limiting independent dirty-tree construction to two repositories.
  await Promise.all(
    Array.from({ length: Math.min(2, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        for (const index of batch) {
          const repository = repositories[index]!;
          values[index] = statuses[index] ? await trees(repository) : await headTrees(repository);
        }
      }
    }),
  );
  return values;
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const { repositories } = await preflight(cwd),
      statuses = await Promise.all(
        repositories.map(repository => git(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"])),
      ),
      values = await fingerprintTrees(repositories, statuses);
    // Always use content identities. A repository whose status changes without
    // changing either tree (for example a dirty submodule marker) remains stable.
    return values
      .map(
        ({ indexTree, worktreeTree }, index) =>
          `${repositories[index]!.prefix}\n${repositories[index]!.root}\n${repositories[index]!.head}\n${indexTree}\n${worktreeTree}`,
      )
      .join("\n");
  } catch {
    return undefined;
  }
}

async function captureRepository(repository: RepositoryState, sessionId: string, id: string) {
  const [treeResult, headResult] = await Promise.allSettled([trees(repository), symbolicHead(repository.root)]);
  if (treeResult.status === "rejected") throw treeResult.reason;
  if (headResult.status === "rejected") throw headResult.reason;
  const { indexTree, worktreeTree } = treeResult.value;
  const headRef = headResult.value;
  const wc = await git(
      repository.root,
      ["commit-tree", worktreeTree, "-p", repository.head, "-m", "pi-timeline worktree checkpoint"],
      ident,
    ),
    ic = await git(
      repository.root,
      ["commit-tree", indexTree, "-p", repository.head, "-m", "pi-timeline index checkpoint"],
      ident,
    ),
    owner = createHash("sha256").update(sessionId).digest("hex").slice(0, 16),
    base = `refs/pi-timeline/${owner}/${id}`,
    worktreeRef = `${base}/worktree`,
    indexRef = `${base}/index`;
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
    commonDir: repository.commonDir,
    head: repository.head,
    headRef,
    worktreeRef,
    indexRef,
    worktreeTree,
    indexTree,
  } satisfies RepositorySnapshot;
}

/** Assembles a Snapshot from the captured repositories, root first. */
function toSnapshot(snapshotId: string, repositories: RepositorySnapshot[]): Snapshot {
  const [root, ...nested] = repositories;
  return {
    snapshotId,
    gitRoot: root.gitRoot,
    commonDir: root.commonDir,
    head: root.head,
    headRef: root.headRef,
    worktreeRef: root.worktreeRef,
    indexRef: root.indexRef,
    worktreeTree: root.worktreeTree,
    indexTree: root.indexTree,
    ...(nested.length ? { nested } : {}),
  };
}

/** Best-effort cleanup for a partial capture; failures are ignored deliberately. */
async function discardRepositoryRefs(repository: RepositorySnapshot) {
  await git(repository.gitRoot, ["update-ref", "-d", repository.worktreeRef]).catch(() => {});
  await git(repository.gitRoot, ["update-ref", "-d", repository.indexRef]).catch(() => {});
}

export async function capture(
  cwd: string,
  sessionId: string,
  beforeRepository?: (root: string) => Promise<void>,
): Promise<Snapshot> {
  const initial = await preflight(cwd),
    id = randomBytes(6).toString("hex"),
    captured: RepositorySnapshot[] = [];
  try {
    // Independent repositories may capture together; linked worktrees sharing a Git
    // directory stay serial. Keep owner registration ordered before any ref writes.
    const commonDirs = initial.repositories.map(repository => canonical(repository.commonDir));
    const width = new Set(commonDirs).size === commonDirs.length ? 2 : 1;
    for (let offset = 0; offset < initial.repositories.length; offset += width) {
      const batch = initial.repositories.slice(offset, offset + width);
      for (const repository of batch) await beforeRepository?.(repository.root);
      const outcomes = await Promise.allSettled(batch.map(repository => captureRepository(repository, sessionId, id)));
      for (const outcome of outcomes) if (outcome.status === "fulfilled") captured.push(outcome.value);
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    const final = await preflight(cwd);
    if (
      final.repositories.length !== initial.repositories.length ||
      final.repositories.some(
        (repository, index) =>
          repository.root !== initial.repositories[index].root ||
          repository.prefix !== initial.repositories[index].prefix ||
          repository.head !== initial.repositories[index].head,
      )
    )
      throw Error("Repository graph changed during checkpoint.");
    return toSnapshot(id, captured);
  } catch (error) {
    await Promise.all(captured.map(discardRepositoryRefs));
    throw error;
  }
}

export async function makePortable(snapshot: Snapshot, cwd: string): Promise<Snapshot> {
  const current = await preflight(cwd);
  const expected: RepositorySnapshot[] = [
    {
      prefix: "",
      gitRoot: snapshot.gitRoot,
      commonDir: snapshot.commonDir,
      head: snapshot.head,
      headRef: snapshot.headRef,
      worktreeRef: snapshot.worktreeRef,
      indexRef: snapshot.indexRef,
      worktreeTree: snapshot.worktreeTree,
      indexTree: snapshot.indexTree,
    },
    ...(snapshot.nested ?? []),
  ];
  if (current.repositories.length !== expected.length) {
    throw Error("Nested repository graph changed since checkpoint.");
  }
  const portable = expected.map((repository, index) => {
    const actual = current.repositories[index];
    if (repository.prefix !== actual.prefix || repository.head !== actual.head) {
      throw Error("Checkpoint repository graph or HEAD changed.");
    }
    if (repository.commonDir) {
      if (canonical(repository.commonDir) !== canonical(actual.commonDir)) {
        throw Error("Checkpoint belongs to a different Git repository.");
      }
    } else if (canonical(repository.gitRoot) !== canonical(actual.root)) {
      throw Error("Version 3 checkpoint must be migrated from its original checkout.");
    }
    return { ...repository, gitRoot: actual.root, commonDir: actual.commonDir };
  });
  return toSnapshot(snapshot.snapshotId, portable);
}

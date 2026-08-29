import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalPath, escapesRoot, boundedError, SEARCH_TIMEOUT_MS } from "./search-common.ts";
import { extractSymbols, languageFor, type SymbolRow } from "./symbols.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_NESTED_REPOSITORIES = 100;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type IndexExecutor = (command: string, args: string[], options: { timeout: number }) => Promise<ExecResult>;
export type RepositoryIdentity = { root: string; rootKey: string; head: string; branch: string };
export type RepositorySnapshot = RepositoryIdentity & { dirty: Set<string> };
export type IndexedRepository = RepositorySnapshot & { prefix: string };
export type PreparedFile = {
  path: string;
  language: string;
  content: string;
  hash: string;
  size: number;
  dirty: boolean;
  symbols: SymbolRow[];
};

export function parseNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function statusSnapshot(root: string, value: string): RepositorySnapshot {
  let head: string | undefined;
  let branch = "";
  const dirty = new Set<string>();
  const tokens = parseNul(value);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice(13);
      head = oid === "(initial)" ? "unborn" : oid;
    } else if (token.startsWith("# branch.head ")) {
      const name = token.slice(14);
      branch = name === "(detached)" ? "" : name;
    } else if (token.startsWith("? ")) {
      dirty.add(token.slice(2));
    } else {
      const match =
        token[0] === "1"
          ? /^1 (?:\S+ ){7}([\s\S]+)$/.exec(token)
          : token[0] === "2"
            ? /^2 (?:\S+ ){8}([\s\S]+)$/.exec(token)
            : token[0] === "u"
              ? /^u (?:\S+ ){9}([\s\S]+)$/.exec(token)
              : undefined;
      if (match) {
        dirty.add(match[1]);
        if (token[0] === "2") {
          const original = tokens[++index];
          if (!original) throw new Error("git status rename record did not include its original path");
          dirty.add(original);
        }
      } else if (token[0] === "1" || token[0] === "2" || token[0] === "u") {
        throw new Error("git status returned a malformed file record");
      }
    }
  }
  if (!head) throw new Error("git status did not report a branch HEAD");
  return { root, rootKey: canonicalPath(root), head, branch, dirty };
}

export function sameSnapshot(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  return (
    left.head === right.head &&
    left.branch === right.branch &&
    left.dirty.size === right.dirty.size &&
    [...left.dirty].every(path => right.dirty.has(path))
  );
}

/** Reads git state and file contents for a workspace root and its nested repositories. */
export class RepositoryScanner {
  private resolvedRoot?: string;
  private readonly cwd: string;
  private readonly exec: IndexExecutor;

  constructor(cwd: string, exec: IndexExecutor) {
    this.cwd = cwd;
    this.exec = exec;
  }

  /** Workspace root, available once `snapshot()` has run at least once. */
  get root(): string {
    if (!this.resolvedRoot) throw new Error("pi-discover repository root has not been resolved yet");
    return this.resolvedRoot;
  }

  private async gitAt(cwd: string, args: string[]): Promise<ExecResult> {
    const result = await this.exec("git", ["-C", cwd, ...args], { timeout: SEARCH_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${boundedError(result.stderr || result.stdout)}`);
    return result;
  }

  async snapshotAt(root: string): Promise<RepositorySnapshot> {
    const result = await this.gitAt(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    return statusSnapshot(root, result.stdout);
  }

  async snapshot(): Promise<RepositorySnapshot> {
    if (!this.resolvedRoot)
      this.resolvedRoot = await realpath((await this.gitAt(this.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim());
    return this.snapshotAt(this.resolvedRoot);
  }

  /** Every tracked file and untracked-but-not-ignored file in one repository. */
  async inventory(root: string): Promise<Set<string>> {
    return new Set(
      parseNul((await this.gitAt(root, ["ls-files", "--full-name", "-co", "--exclude-standard", "-z"])).stdout),
    );
  }

  /** Gitlink children of one repository, resolved and snapshotted. */
  private async childRepositories(
    repository: IndexedRepository,
    physicalRoots: Set<string>,
  ): Promise<Array<{ path: string; snapshot: RepositorySnapshot }>> {
    const children: Array<{ path: string; snapshot: RepositorySnapshot }> = [];
    for (const entry of parseNul((await this.gitAt(repository.root, ["ls-files", "--stage", "-z"])).stdout)) {
      const match = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
      if (!match) continue;
      const gitlinkPath = match[1].replaceAll("\\", "/");
      let childRoot: string;
      try {
        childRoot = await realpath(resolve(repository.root, gitlinkPath));
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (escapesRoot(this.root, childRoot)) continue;
      const rootKey = canonicalPath(childRoot);
      let topLevel: string;
      try {
        topLevel = await realpath((await this.gitAt(childRoot, ["rev-parse", "--show-toplevel"])).stdout.trim());
      } catch (error) {
        if (!existsSync(join(childRoot, ".git"))) continue;
        throw error;
      }
      if (canonicalPath(topLevel) !== rootKey) continue;
      if (!physicalRoots.has(rootKey) && physicalRoots.size >= MAX_NESTED_REPOSITORIES)
        throw new Error("pi-discover nested repository limit exceeded");
      physicalRoots.add(rootKey);
      children.push({ path: gitlinkPath, snapshot: await this.snapshotAt(childRoot) });
    }
    return children;
  }

  /** The root repository plus every nested repository reachable from it, each with its path prefix. */
  async indexedRepositories(root: RepositorySnapshot): Promise<IndexedRepository[]> {
    const repositories: IndexedRepository[] = [{ ...root, prefix: "" }];
    const queue = [{ repository: repositories[0], ancestors: new Set([root.rootKey]) }];
    const physicalRoots = new Set([root.rootKey]);
    const childrenByRoot = new Map<string, Array<{ path: string; snapshot: RepositorySnapshot }>>();
    const prefixes = new Set([""]);
    for (let index = 0; index < queue.length; index++) {
      const { repository, ancestors } = queue[index];
      let children = childrenByRoot.get(repository.rootKey);
      if (!children) {
        children = await this.childRepositories(repository, physicalRoots);
        childrenByRoot.set(repository.rootKey, children);
      }
      for (const child of children) {
        if (ancestors.has(child.snapshot.rootKey)) continue;
        const prefix = repository.prefix ? `${repository.prefix}/${child.path}` : child.path;
        if (prefixes.has(prefix)) continue;
        prefixes.add(prefix);
        const member = { ...child.snapshot, prefix };
        repositories.push(member);
        queue.push({ repository: member, ancestors: new Set([...ancestors, child.snapshot.rootKey]) });
      }
    }
    return repositories;
  }

  /** Read and symbol-extract one candidate file, or undefined when it is not indexable. */
  private async prepare(root: string, path: string, dirty: boolean): Promise<PreparedFile | undefined> {
    const language = languageFor(path);
    if (!language) return undefined;
    const absolute = resolve(root, path);
    if (escapesRoot(root, absolute)) return undefined;
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined;
      const data = await readFile(absolute);
      if (data.includes(0)) return undefined;
      const content = data.toString("utf8");
      return {
        path: path.replaceAll("\\", "/"),
        language,
        content,
        size: stat.size,
        dirty,
        hash: createHash("sha256").update(data).digest("hex"),
        symbols: extractSymbols(content, language),
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Prepare every candidate path with a small worker pool. Paths that cannot be indexed
   * become removals so a file that stopped qualifying is dropped from the index.
   */
  async prepareAll(
    root: string,
    candidates: string[],
    dirty: Set<string>,
  ): Promise<{ prepared: PreparedFile[]; removals: string[] }> {
    const outcomes = new Array<PreparedFile | undefined>(candidates.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= candidates.length) return;
        outcomes[index] = await this.prepare(root, candidates[index]!, dirty.has(candidates[index]!));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));
    const prepared: PreparedFile[] = [];
    const removals: string[] = [];
    for (const [index, file] of outcomes.entries()) {
      if (file) prepared.push(file);
      else removals.push(candidates[index]!.replaceAll("\\", "/"));
    }
    return { prepared, removals };
  }
}

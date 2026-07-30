import { isAbsolute } from "node:path";
import { git } from "./git.ts";
import type { RepositorySnapshot, Snapshot } from "./snapshot.ts";

export interface TimelineFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TimelineChangeSet {
  fileCount: number;
  additions: number;
  deletions: number;
  binaryCount: number;
  files: TimelineFileChange[];
  truncated: boolean;
}

export interface TimelineFileDiff {
  path: string;
  state: "text" | "binary" | "unavailable" | "oversized";
  text?: string;
  truncated?: boolean;
}

const repositories = (snapshot: Snapshot): RepositorySnapshot[] => [{
  prefix: "",
  gitRoot: snapshot.gitRoot,
  commonDir: snapshot.commonDir,
  head: snapshot.head,
  headRef: snapshot.headRef,
  worktreeRef: snapshot.worktreeRef,
  indexRef: snapshot.indexRef,
  worktreeTree: snapshot.worktreeTree,
  indexTree: snapshot.indexTree,
}, ...(snapshot.nested ?? [])];

const canonical = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const safePath = (value: string) => {
  const path = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!path || path.length > 500 || path.includes("\0") || isAbsolute(path))
    return undefined;
  if (path.split("/").some((part) => part === "..")) return undefined;
  return path;
};

const compatibleRepositories = (
  current: Snapshot,
  previous?: Snapshot,
): Array<{ current: RepositorySnapshot; previous?: RepositorySnapshot }> => {
  const currentRepositories = repositories(current);
  if (!previous) return currentRepositories.map((item) => ({ current: item }));
  const previousRepositories = repositories(previous);
  if (currentRepositories.length !== previousRepositories.length)
    throw Error("Checkpoint repository graph is incompatible.");
  return currentRepositories.map((item, index) => {
    const earlier = previousRepositories[index];
    const currentIdentity = item.commonDir ?? item.gitRoot;
    const earlierIdentity = earlier.commonDir ?? earlier.gitRoot;
    if (item.prefix !== earlier.prefix
      || item.head !== earlier.head
      || canonical(currentIdentity) !== canonical(earlierIdentity))
      throw Error("Checkpoint repository graph is incompatible.");
    return { current: item, previous: earlier };
  });
};

const parseNumstat = (value: string) => {
  const rows = new Map<string, Pick<TimelineFileChange, "additions" | "deletions" | "binary">>();
  for (const row of value.split("\0")) {
    if (!row) continue;
    const [added, deleted, rawPath] = row.split("\t");
    const path = safePath(rawPath ?? "");
    if (!path) continue;
    const binary = added === "-" || deleted === "-";
    rows.set(path, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return rows;
};

const parseStatuses = (value: string) => {
  const parts = value.split("\0").filter(Boolean);
  const statuses = new Map<string, TimelineFileChange["status"]>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const path = safePath(parts[index + 1]);
    if (!path) continue;
    statuses.set(path, parts[index].startsWith("A")
      ? "added"
      : parts[index].startsWith("D")
        ? "deleted"
        : "modified");
  }
  return statuses;
};

export async function checkpointChanges(
  current: Snapshot,
  previous?: Snapshot,
): Promise<TimelineChangeSet> {
  const files: TimelineFileChange[] = [];
  for (const pair of compatibleRepositories(current, previous)) {
    const before = pair.previous?.worktreeTree ?? pair.current.head;
    const after = pair.current.worktreeTree;
    const [numstat, nameStatus] = await Promise.all([
      git(pair.current.gitRoot, ["diff", "--numstat", "-z", "--no-renames", before, after]),
      git(pair.current.gitRoot, ["diff", "--name-status", "-z", "--no-renames", before, after]),
    ]);
    const stats = parseNumstat(numstat);
    const statuses = parseStatuses(nameStatus);
    for (const [relativePath, stat] of stats) {
      const path = safePath(`${pair.current.prefix}${relativePath}`);
      if (!path) continue;
      files.push({
        path,
        status: statuses.get(relativePath) ?? "modified",
        ...stat,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: files.length,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
    binaryCount: files.filter((item) => item.binary).length,
    files: files.slice(0, 200),
    truncated: files.length > 200,
  };
}

export async function checkpointFileDiff(
  current: Snapshot,
  previous: Snapshot | undefined,
  requestedPath: string,
): Promise<TimelineFileDiff> {
  const path = safePath(requestedPath);
  if (!path) return { path: requestedPath.slice(0, 500), state: "unavailable" };
  const pair = compatibleRepositories(current, previous)
    .sort((left, right) => right.current.prefix.length - left.current.prefix.length)
    .find(({ current: item }) => !item.prefix || path.startsWith(item.prefix));
  if (!pair) return { path, state: "unavailable" };
  const relativePath = pair.current.prefix
    ? path.slice(pair.current.prefix.length)
    : path;
  const before = pair.previous?.worktreeTree ?? pair.current.head;
  const after = pair.current.worktreeTree;
  const text = await git(pair.current.gitRoot, [
    "diff", "--no-ext-diff", "--no-renames", "--unified=3",
    before, after, "--", relativePath,
  ]).catch(() => "");
  if (!text) return { path, state: "unavailable" };
  if (/^Binary files /m.test(text)) return { path, state: "binary" };
  const lines = text.split(/\r?\n/);
  const oversized = Buffer.byteLength(text) > 2 * 1024 * 1024;
  const truncated = oversized || lines.length > 20_000;
  if (oversized) return { path, state: "oversized" };
  return {
    path,
    state: "text",
    text: lines.slice(0, 20_000).join("\n"),
    ...(truncated ? { truncated: true } : {}),
  };
}

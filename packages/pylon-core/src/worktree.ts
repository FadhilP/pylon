import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) =>
      error
        ? reject(Error(String(stderr || error.message).slice(0, 8192)))
        : resolve(String(stdout).replace(/\r?\n$/, "")),
    ),
  );
}

export interface WorktreeSnapshot {
  root: string;
  tree: string;
  fingerprint: string;
}

export interface WorktreeFileChange {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export const WORKTREE_SUMMARY_ENTRY_TYPE = "pylon-worktree-summary";
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_SUMMARY_FILES = 100;

export interface PersistedWorktreeSummary {
  version: 1;
  assistantEntryId: string;
  files: WorktreeFileChange[];
}

function validSummaryPath(path: string): boolean {
  return path.length > 0
    && path.length <= 500
    && !path.startsWith("/")
    && !/^[A-Za-z]:\//.test(path)
    && !path.includes("\\")
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

export function createWorktreeSummary(
  assistantEntryId: string,
  values: WorktreeFileChange[],
): PersistedWorktreeSummary | undefined {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(assistantEntryId)) return undefined;
  const summary: PersistedWorktreeSummary = { version: 1, assistantEntryId, files: [] };
  for (const value of values.slice(0, MAX_SUMMARY_FILES)) {
    const path = value.path.replaceAll("\\", "/").slice(0, 500);
    if (!validSummaryPath(path)) continue;
    const file = value.binary === true
      ? { path, binary: true as const }
      : Number.isSafeInteger(value.additions) && Number.isSafeInteger(value.deletions)
        ? {
            path,
            additions: Math.min(1_000_000, Math.max(0, value.additions!)),
            deletions: Math.min(1_000_000, Math.max(0, value.deletions!)),
          }
        : undefined;
    if (!file) continue;
    const candidate = { ...summary, files: [...summary.files, file] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_SUMMARY_BYTES) break;
    summary.files.push(file);
  }
  return summary;
}

export function parseWorktreeSummary(value: unknown): PersistedWorktreeSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SUMMARY_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1
    || typeof raw.assistantEntryId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.assistantEntryId)
    || !Array.isArray(raw.files)
    || raw.files.length === 0
    || raw.files.length > MAX_SUMMARY_FILES) return undefined;

  const files: WorktreeFileChange[] = [];
  for (const value of raw.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const file = value as Record<string, unknown>;
    if (typeof file.path !== "string" || !validSummaryPath(file.path)) return undefined;
    if (file.binary === true) {
      files.push({ path: file.path, binary: true });
      continue;
    }
    if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)
      || Number(file.additions) < 0 || Number(file.additions) > 1_000_000
      || Number(file.deletions) < 0 || Number(file.deletions) > 1_000_000) return undefined;
    files.push({
      path: file.path,
      additions: Number(file.additions),
      deletions: Number(file.deletions),
    });
  }
  return { version: 1, assistantEntryId: raw.assistantEntryId, files };
}

export function readPersistedWorktreeSummaries(
  session: { getBranch(): unknown[]; getEntries(): unknown[] },
): Map<string, WorktreeFileChange[]> {
  const activeAssistants = new Set(session.getBranch().flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const message = entry.message as Record<string, unknown> | undefined;
    return entry.type === "message" && message?.role === "assistant" && typeof entry.id === "string"
      ? [entry.id]
      : [];
  }));
  const summaries = new Map<string, WorktreeFileChange[]>();
  for (const value of session.getEntries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== WORKTREE_SUMMARY_ENTRY_TYPE) continue;
    const summary = parseWorktreeSummary(entry.data);
    if (!summary || !activeAssistants.has(summary.assistantEntryId)) continue;
    summaries.set(summary.assistantEntryId, summary.files);
  }
  return summaries;
}

export async function worktreeSnapshot(cwd: string): Promise<WorktreeSnapshot | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [head, status] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    if (!status) {
      const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
      return { root, tree, fingerprint: `${root}\n${head}\nclean` };
    }

    const indexTree = await git(root, ["write-tree"]);
    const dir = await mkdtemp(join(tmpdir(), "pylon-worktree-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await git(root, ["read-tree", "HEAD"], env);
      await git(root, ["add", "-A", "--", "."], env);
      const tree = await git(root, ["write-tree"], env);
      return { root, tree, fingerprint: `${root}\n${head}\n${indexTree}\n${tree}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return undefined;
  }
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  return (await worktreeSnapshot(cwd))?.fingerprint;
}

export async function worktreeDiff(before: WorktreeSnapshot, after: WorktreeSnapshot): Promise<WorktreeFileChange[] | undefined> {
  if (before.root !== after.root) return undefined;
  try {
    const output = await git(before.root, ["diff", "--numstat", "-z", "--no-renames", before.tree, after.tree]);
    const files: WorktreeFileChange[] = [];
    for (const record of output.split("\0").filter(Boolean).slice(0, 500)) {
      const first = record.indexOf("\t");
      const second = record.indexOf("\t", first + 1);
      if (first < 0 || second < 0) continue;
      const added = record.slice(0, first);
      const deleted = record.slice(first + 1, second);
      const path = record.slice(second + 1);
      if (!path || path.length > 1_000) continue;
      if (added === "-" || deleted === "-") {
        files.push({ path, binary: true });
        continue;
      }
      const additions = Number(added);
      const deletions = Number(deleted);
      if (Number.isSafeInteger(additions) && Number.isSafeInteger(deletions)) {
        files.push({ path, additions, deletions });
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

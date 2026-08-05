import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import type { NotebookNote } from "./memory.ts";
import { semanticIdentity } from "./memory.ts";
import type { Workspace } from "./workspace.ts";

const exec = promisify(execFile);
export const OWNER_REASSOCIATION_GRACE_MS = 24 * 60 * 60 * 1_000;
export const MAX_REASSOCIATION_NOTES = 100;

async function pathIsMissing(path: string) {
  try { await lstat(path); return false; }
  catch (error: any) { return error?.code === "ENOENT"; }
}

async function objectIdLength(cwd: string) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-object-format"], {
      timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    const format = String(stdout).trim();
    return format === "sha256" ? 64 : format === "sha1" ? 40 : undefined;
  } catch { return undefined; }
}

async function resolveCommit(cwd: string, commit: string, length: number) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(commit)) return;
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--verify", `${commit}^{commit}`], {
      timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    const resolved = String(stdout).trim();
    return new RegExp(`^[0-9a-f]{${length}}$`).test(resolved) ? resolved : undefined;
  } catch { return; }
}

/** Fail-closed moved-repository detection. Two retained commit OIDs prove shared Git history. */
export async function findMovedProjectOwner(
  cwd: string,
  currentOwner: string,
  workspaces: Workspace[],
  notes: NotebookNote[],
  now = Date.now(),
) {
  const oidLength = await objectIdLength(cwd);
  if (!oidLength) return;
  const owners = [...new Set(notes.filter((note) => note.scope === "project" && note.owner !== currentOwner).map((note) => note.owner))];
  const matches: string[] = [];
  for (const owner of owners) {
    const owned = notes.filter((note) => note.scope === "project" && note.owner === owner);
    const homes = workspaces.filter((item) => item.projectOwner === owner);
    if (!homes.length || owned.length > MAX_REASSOCIATION_NOTES) continue;
    if (homes.some((item) => !Number.isFinite(Date.parse(item.lastSeenAt)) || now - Date.parse(item.lastSeenAt) < OWNER_REASSOCIATION_GRACE_MS)) continue;
    const missing = await Promise.all(homes.map((item) => pathIsMissing(item.canonicalPath)));
    if (missing.some((value) => !value)) continue;
    const commits = [...new Set(owned.flatMap((note) => note.sourceRefs.flatMap((ref) => (ref.type === "repository" || ref.type === "migration") && ref.captureCommit ? [ref.captureCommit] : [])))];
    if (commits.length < 2) continue;
    const resolvedCommits = await Promise.all(commits.map((commit) => resolveCommit(cwd, commit, oidLength)));
    if (resolvedCommits.some((commit) => !commit) || new Set(resolvedCommits).size < 2) continue;
    matches.push(owner);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function reassociateOwnerNotes(oldOwner: string, currentOwner: string, notes: NotebookNote[], now = new Date().toISOString()) {
  const current = new Set(notes.filter((note) => note.scope === "project" && note.owner === currentOwner).map((note) => semanticIdentity(note.trigger, note.guidance)));
  const moved: NotebookNote[] = [], suppressed: NotebookNote[] = [];
  const next = notes.flatMap((note) => {
    if (note.scope !== "project" || note.owner !== oldOwner) return [note];
    const identity = semanticIdentity(note.trigger, note.guidance);
    if (current.has(identity)) { suppressed.push(note); return []; }
    const updated = { ...note, owner: currentOwner, revision: note.revision + 1, updatedAt: now };
    moved.push(note); return [updated];
  });
  return { notes: next, moved, suppressed };
}

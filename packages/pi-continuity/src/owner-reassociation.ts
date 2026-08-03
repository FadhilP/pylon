import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Fact, PendingCandidate } from "./memory.ts";
import type { Workspace } from "./workspace.ts";
import { captureEvidence } from "./worktree.ts";

const exec = promisify(execFile);
export const OWNER_REASSOCIATION_GRACE_MS = 24 * 60 * 60 * 1_000;
export const MAX_REASSOCIATION_RECORDS = 100;

type OwnedRecord = Pick<Fact | PendingCandidate, "scope" | "owner" | "key" | "captureCommit" | "evidencePaths">;
export type OwnerReassociationMarker = {
  version: 1;
  status: "prepared" | "records-moved" | "complete";
  createdAt: string;
  oldOwner: string;
  currentOwner: string;
  facts: Fact[];
  candidates: PendingCandidate[];
};
export function isOwnerReassociationMarker(value: any): value is OwnerReassociationMarker {
  return value?.version === 1 &&
    ["prepared", "records-moved", "complete"].includes(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.oldOwner === "string" && value.oldOwner.length > 0 &&
    typeof value.currentOwner === "string" && value.currentOwner.length > 0 &&
    Array.isArray(value.facts) && Array.isArray(value.candidates) &&
    value.facts.length + value.candidates.length <= MAX_REASSOCIATION_RECORDS;
}

async function pathIsMissing(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

async function objectIdLength(cwd: string) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-object-format"], {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    return String(stdout).trim() === "sha256" ? 64 : String(stdout).trim() === "sha1" ? 40 : undefined;
  } catch {
    return undefined;
  }
}

async function commitExists(cwd: string, commit: string, length: number) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(commit)) return false;
  try {
    const { stdout } = await exec("git", ["-C", cwd, "cat-file", "-t", commit], {
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    return String(stdout).trim() === "commit";
  } catch {
    return false;
  }
}

async function hasMatchingEvidence(cwd: string, records: OwnedRecord[]) {
  for (const record of records) {
    for (const evidence of record.evidencePaths ?? []) {
      try {
        const [current] = await captureEvidence(cwd, [evidence.path]);
        if (current?.sha256 === evidence.sha256) return true;
      } catch {
        // Missing, changed, sensitive, or symlinked evidence cannot prove reassociation.
      }
    }
  }
  return false;
}

export async function findMovedProjectOwner(
  cwd: string,
  currentOwner: string,
  workspaces: Workspace[],
  facts: Fact[],
  candidates: PendingCandidate[],
  now = Date.now(),
) {
  const oidLength = await objectIdLength(cwd);
  if (!oidLength) return;
  const records = [...facts, ...candidates].filter((item) =>
    item.scope === "project" && item.owner && item.owner !== currentOwner);
  const owners = [...new Set(records.map((item) => item.owner!))];
  const matches: string[] = [];
  for (const owner of owners) {
    const owned = records.filter((item) => item.owner === owner);
    const homes = workspaces.filter((item) => item.projectOwner === owner);
    if (!homes.length || owned.length > MAX_REASSOCIATION_RECORDS) continue;
    if (homes.some((item) => now - Date.parse(item.lastSeenAt) < OWNER_REASSOCIATION_GRACE_MS)) continue;
    const missing = await Promise.all(homes.map((item) => pathIsMissing(item.canonicalPath)));
    if (missing.some((value) => !value)) continue;
    const commits = [...new Set(owned.map((item) => item.captureCommit).filter((value): value is string => Boolean(value)))];
    if (commits.length !== owned.length && owned.some((item) => !item.captureCommit)) continue;
    if (!(await Promise.all(commits.map((commit) => commitExists(cwd, commit, oidLength)))).every(Boolean)) continue;
    if (commits.length < 2 && !(await hasMatchingEvidence(cwd, owned))) continue;
    matches.push(owner);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

const key = (item: Pick<Fact | PendingCandidate, "scope" | "owner" | "key">) =>
  `${item.scope}\0${item.owner}\0${item.key}`;

export function reassociateOwnerRecords(
  oldOwner: string,
  currentOwner: string,
  facts: Fact[],
  candidates: PendingCandidate[],
) {
  const currentFactKeys = new Set(facts
    .filter((item) => item.scope === "project" && item.owner === currentOwner)
    .map(key));
  const currentCandidateKeys = new Set(candidates
    .filter((item) => item.scope === "project" && item.owner === currentOwner)
    .map(key));
  const movedFacts = facts.flatMap((item) => {
    if (item.scope !== "project" || item.owner !== oldOwner) return [item];
    const moved = { ...item, owner: currentOwner };
    return currentFactKeys.has(key(moved)) ? [] : [moved];
  });
  const movedCandidates = candidates.flatMap((item) => {
    if (item.scope !== "project" || item.owner !== oldOwner) return [item];
    const moved = { ...item, owner: currentOwner };
    return currentCandidateKeys.has(key(moved)) ? [] : [moved];
  });
  return {
    facts: movedFacts,
    candidates: movedCandidates,
    backup: {
      version: 1,
      oldOwner,
      currentOwner,
      facts: facts.filter((item) => item.scope === "project" && item.owner === oldOwner),
      candidates: candidates.filter((item) => item.scope === "project" && item.owner === oldOwner),
    },
  };
}

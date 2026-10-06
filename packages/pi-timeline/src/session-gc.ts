import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  liveSessionLeases,
  readSessionArtifactLockOwner,
  startSessionLease,
  withSessionArtifactLock,
} from "pylon-core/session-lease";
import { git } from "./git.ts";

type Owner = { sessionId: string; gitRoot: string };
type Catalog = { version: 1; owners: Owner[] };

function isCatalog(value: any): value is Catalog {
  return (
    value?.version === 1 &&
    Array.isArray(value.owners) &&
    value.owners.every(
      (owner: any) =>
        typeof owner?.sessionId === "string" && owner.sessionId && typeof owner.gitRoot === "string" && owner.gitRoot,
    )
  );
}

export const readLockOwner = (path: string, read?: (path: string) => Promise<string>) =>
  readSessionArtifactLockOwner(path, "timeline", read);

const withLock = <T>(root: string, task: () => Promise<T>) => withSessionArtifactLock(root, "timeline", task);

const catalogPath = (root: string) => join(root, "session-artifacts.json");
async function readCatalog(root: string): Promise<Catalog | undefined> {
  try {
    const value = JSON.parse(await readFile(catalogPath(root), "utf8"));
    return isCatalog(value) ? value : undefined;
  } catch (error: any) {
    return error?.code === "ENOENT" ? { version: 1, owners: [] } : undefined;
  }
}
async function writeCatalog(root: string, catalog: Catalog) {
  const path = catalogPath(root),
    temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
const ownerPrefix = (sessionId: string) =>
  `refs/pi-timeline/${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}/`;

async function canonicalGitRoot(path: string) {
  const reported = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpath(reported);
}
async function canonicalCommonDir(path: string) {
  const reported = await git(path, ["--git-dir", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpath(reported);
}
async function deleteOwnedRefs(owner: Owner) {
  const commonDir = await canonicalCommonDir(owner.gitRoot).catch(() => canonicalGitRoot(owner.gitRoot));
  const prefix = ownerPrefix(owner.sessionId);
  const refs = (await git(commonDir, ["--git-dir", commonDir, "for-each-ref", "--format=%(refname)", prefix]))
    .split(/\r?\n/)
    .filter(ref => ref.startsWith(prefix));
  for (const ref of refs) await git(commonDir, ["--git-dir", commonDir, "update-ref", "-d", ref]);
}
/**
 * Drops every owner `keep` rejects, deleting its refs first. An owner whose refs cannot
 * be deleted is retained so the next run can retry rather than leaking them silently.
 */
async function pruneOwners(catalog: Catalog, keep: (owner: Owner) => boolean): Promise<Catalog> {
  const remaining: Owner[] = [];
  for (const owner of catalog.owners) {
    if (keep(owner)) {
      remaining.push(owner);
      continue;
    }
    try {
      await deleteOwnedRefs(owner);
    } catch {
      remaining.push(owner);
    }
  }
  return { version: 1, owners: remaining };
}

const deleteSessionOwners = (catalog: Catalog, sessionId: string) =>
  pruneOwners(catalog, owner => owner.sessionId !== sessionId);

/** Deletes a session's refs from the catalog. Assumes the lock is held. */
async function deleteSessionRefs(root: string, sessionId: string) {
  const catalog = await readCatalog(root);
  if (!catalog) return;
  const next = await deleteSessionOwners(catalog, sessionId);
  if (next.owners.length !== catalog.owners.length) await writeCatalog(root, next);
}

export async function recordTimelineOwner(root: string, sessionId: string, gitRoot: string) {
  await withLock(root, async () => {
    const catalog = await readCatalog(root);
    if (!catalog) throw Error("Unreadable timeline artifact catalog.");
    const canonicalRoot = await canonicalGitRoot(gitRoot);
    if (!catalog.owners.some(owner => owner.sessionId === sessionId && owner.gitRoot === canonicalRoot)) {
      catalog.owners.push({ sessionId, gitRoot: canonicalRoot });
      await writeCatalog(root, catalog);
    }
  });
}

export async function cleanupTimelineSession(root: string, sessionId: string) {
  await withLock(root, async () => {
    const leases = await liveSessionLeases(root);
    if (leases.safe && !leases.sessionIds.has(sessionId)) await deleteSessionRefs(root, sessionId);
  });
}

export async function startSessionGc(
  root: string,
  sessionId: string,
  listSessions?: () => Promise<Array<{ id: string }>>,
) {
  const release = await startSessionLease(
    root,
    sessionId,
    "timeline",
    async live => {
      const catalog = await readCatalog(root);
      if (!catalog) return;
      const livePrefixes = new Set([...live].map(ownerPrefix));
      const next = await pruneOwners(
        catalog,
        owner => live.has(owner.sessionId) || livePrefixes.has(ownerPrefix(owner.sessionId)),
      );
      if (next.owners.length !== catalog.owners.length) await writeCatalog(root, next);
    },
    listSessions,
  );
  return Object.assign(
    (cleanupIfLast = false) => release(cleanupIfLast ? () => deleteSessionRefs(root, sessionId) : undefined),
    { collect: release.collect, cancel: release.cancel },
  );
}

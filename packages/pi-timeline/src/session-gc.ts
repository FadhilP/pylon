import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listSessionInventory } from "pylon-core/session-inventory";
import { git } from "./git.ts";

const LEASE_VERSION = 1;
type Lease = { version: 1; sessionId: string; pid: number; token: string };
type LockOwner = { version: 1; pid: number; token: string };
type Owner = { sessionId: string; gitRoot: string };
type Catalog = { version: 1; owners: Owner[] };

function isLease(value: any): value is Lease {
  return value?.version === LEASE_VERSION && typeof value.sessionId === "string" &&
    Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string";
}
function isLockOwner(value: any): value is LockOwner {
  return value?.version === 1 && Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.token === "string";
}
function isCatalog(value: any): value is Catalog {
  return value?.version === 1 && Array.isArray(value.owners) && value.owners.every(
    (owner: any) => typeof owner?.sessionId === "string" && owner.sessionId &&
      typeof owner.gitRoot === "string" && owner.gitRoot,
  );
}
function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}
async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readLockOwner(path: string, read: (path: string) => Promise<string> = (value) => readFile(value, "utf8")): Promise<LockOwner | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const owner: unknown = JSON.parse(await read(path));
      if (isLockOwner(owner)) return owner;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
    }
    if (attempt < 2) await delay(10);
  }
  throw Error("Unreadable timeline session-artifact lock.");
}

async function withLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const lock = join(root, "session-artifacts.lock"), recoveryLock = `${lock}.recovery`,
    token = randomUUID(), claim = join(root, `.session-artifacts-claim-${process.pid}-${token}`),
    owner: LockOwner = { version: 1, pid: process.pid, token };
  await mkdir(root, { recursive: true });
  await writeFile(claim, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  const recoverDeadOwner = async () => {
    try {
      await link(claim, recoveryLock);
    } catch (error: any) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
    try {
      const active = await readLockOwner(lock);
      if (!active) return true;
      if (processIsAlive(active.pid)) return false;
      await rm(lock, { force: true });
      return true;
    } finally {
      const recoveryOwner = await readJson(recoveryLock);
      if (isLockOwner(recoveryOwner) && recoveryOwner.token === token)
        await rm(recoveryLock, { force: true });
    }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(claim, lock);
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST" || attempt >= 100) throw error;
        if (await recoverDeadOwner()) continue;
        await delay(50);
      }
    }
  } finally {
    await rm(claim, { force: true });
  }
  try {
    return await task();
  } finally {
    const active = await readJson(lock);
    if (isLockOwner(active) && active.token === token) await rm(lock, { force: true });
  }
}

async function readLease(path: string): Promise<Lease | undefined> {
  const value = await readJson(path);
  return isLease(value) ? value : undefined;
}
async function liveLeases(directory: string) {
  const sessionIds = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name), active = await readLease(path);
    if (!active) return { safe: false, sessionIds };
    if (!processIsAlive(active.pid)) {
      await rm(path, { force: true });
      continue;
    }
    sessionIds.add(active.sessionId);
  }
  return { safe: true, sessionIds };
}

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
  const path = catalogPath(root), temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
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
    .split(/\r?\n/).filter((ref) => ref.startsWith(prefix));
  for (const ref of refs) await git(commonDir, ["--git-dir", commonDir, "update-ref", "-d", ref]);
}
async function deleteSessionOwners(catalog: Catalog, sessionId: string) {
  const keep: Owner[] = [];
  for (const owner of catalog.owners) {
    if (owner.sessionId !== sessionId) {
      keep.push(owner);
      continue;
    }
    try {
      await deleteOwnedRefs(owner);
    } catch {
      keep.push(owner);
    }
  }
  return { version: 1 as const, owners: keep };
}

export async function recordTimelineOwner(root: string, sessionId: string, gitRoot: string) {
  await withLock(root, async () => {
    const catalog = await readCatalog(root);
    if (!catalog) throw Error("Unreadable timeline artifact catalog.");
    const canonicalRoot = await canonicalGitRoot(gitRoot);
    if (!catalog.owners.some((owner) => owner.sessionId === sessionId && owner.gitRoot === canonicalRoot)) {
      catalog.owners.push({ sessionId, gitRoot: canonicalRoot });
      await writeCatalog(root, catalog);
    }
  });
}

export async function cleanupTimelineSession(root: string, sessionId: string) {
  await withLock(root, async () => {
    const leases = await liveLeases(join(root, "session-artifacts"));
    if (!leases.safe || leases.sessionIds.has(sessionId)) return;
    const catalog = await readCatalog(root);
    if (!catalog) return;
    const next = await deleteSessionOwners(catalog, sessionId);
    if (next.owners.length !== catalog.owners.length) await writeCatalog(root, next);
  });
}

export async function startSessionGc(
  root: string,
  sessionId: string,
  listSessions: () => Promise<Array<{ id: string }>> = () => listSessionInventory(undefined, { strict: true }),
) {
  const leases = join(root, "session-artifacts"), token = randomUUID(),
    leasePath = join(leases, `${encodeURIComponent(sessionId)}.${token}.json`),
    lease: Lease = { version: LEASE_VERSION, sessionId, pid: process.pid, token };
  await withLock(root, async () => {
    await mkdir(leases, { recursive: true });
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    let sessions: Array<{ id: string }>;
    try {
      sessions = await listSessions();
    } catch {
      return;
    }
    const active = await liveLeases(leases), catalog = await readCatalog(root);
    if (!active.safe || !catalog) return;
    const live = new Set(sessions.map((item) => item.id));
    live.add(sessionId);
    for (const id of active.sessionIds) live.add(id);
    const livePrefixes = new Set([...live].map(ownerPrefix));
    const keep: Owner[] = [];
    for (const owner of catalog.owners) {
      if (live.has(owner.sessionId) || livePrefixes.has(ownerPrefix(owner.sessionId))) {
        keep.push(owner);
        continue;
      }
      try {
        await deleteOwnedRefs(owner);
      } catch {
        keep.push(owner);
      }
    }
    if (keep.length !== catalog.owners.length) await writeCatalog(root, { version: 1, owners: keep });
  });
  return async (cleanupIfLast = false) => withLock(root, async () => {
    const owned = await readLease(leasePath);
    if (owned?.token !== token) return;
    await rm(leasePath, { force: true });
    if (!cleanupIfLast) return;
    const active = await liveLeases(leases);
    if (!active.safe || active.sessionIds.has(sessionId)) return;
    const catalog = await readCatalog(root);
    if (!catalog) return;
    const next = await deleteSessionOwners(catalog, sessionId);
    if (next.owners.length !== catalog.owners.length) await writeCatalog(root, next);
  });
}

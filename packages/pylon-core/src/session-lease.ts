import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listSessionInventory } from "./session-inventory.ts";
import { createSessionMaintenance } from "./session-maintenance.ts";

/**
 * Per-session leases over a package's shared artifact root. Each live session holds a lease
 * file; maintenance and last-session cleanup run under one cross-process lock so a package
 * never deletes artifacts a live session still owns. `name` labels lock errors.
 */

const LEASE_VERSION = 1;
const MAX_LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 50;
type Lease = { version: 1; sessionId: string; pid: number; token: string };
type LockOwner = { version: 1; pid: number; token: string };

function isLease(value: any): value is Lease {
  return (
    value?.version === LEASE_VERSION &&
    typeof value.sessionId === "string" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string"
  );
}
function isLockOwner(value: any): value is LockOwner {
  return value?.version === 1 && Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string";
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

/** Reads the lock owner, retrying briefly over torn writes; throws when it stays unreadable. */
export async function readSessionArtifactLockOwner(
  path: string,
  name: string,
  read: (path: string) => Promise<string> = value => readFile(value, "utf8"),
): Promise<LockOwner | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const owner: unknown = JSON.parse(await read(path));
      if (isLockOwner(owner)) return owner;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
    }
    if (attempt < 2) await delay(10);
  }
  throw Error(`Unreadable ${name} session-artifact lock.`);
}

/**
 * Clears `lock` when its recorded owner process is gone. A second `.recovery` lock keeps
 * concurrent recoverers from racing. Returns whether the lock is now free to claim.
 */
async function recoverDeadLockOwner(lock: string, claim: string, token: string, name: string) {
  const recoveryLock = `${lock}.recovery`;
  try {
    await link(claim, recoveryLock);
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    const active = await readSessionArtifactLockOwner(lock, name);
    if (!active) return true;
    if (processIsAlive(active.pid)) return false;
    await rm(lock, { force: true });
    return true;
  } finally {
    const recoveryOwner = await readJson(recoveryLock);
    if (isLockOwner(recoveryOwner) && recoveryOwner.token === token) await rm(recoveryLock, { force: true });
  }
}

/** Takes the lock by hard-linking our claim file onto it, retrying while another live process holds it. */
async function acquireLock(lock: string, claim: string, token: string, name: string) {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(claim, lock);
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST" || attempt >= MAX_LOCK_ATTEMPTS) throw error;
        if (await recoverDeadLockOwner(lock, claim, token, name)) continue;
        await delay(LOCK_RETRY_MS);
      }
    }
  } finally {
    await rm(claim, { force: true });
  }
}

/** Releases the lock only if we still hold it; a recoverer may have taken it from us. */
async function releaseLock(lock: string, token: string) {
  const active = await readJson(lock);
  if (isLockOwner(active) && active.token === token) await rm(lock, { force: true });
}

export async function withSessionArtifactLock<T>(root: string, name: string, task: () => Promise<T>): Promise<T> {
  const lock = join(root, "session-artifacts.lock"),
    token = randomUUID(),
    claim = join(root, `.session-artifacts-claim-${process.pid}-${token}`),
    owner: LockOwner = { version: 1, pid: process.pid, token };
  await mkdir(root, { recursive: true });
  await writeFile(claim, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await acquireLock(lock, claim, token, name);
  try {
    return await task();
  } finally {
    await releaseLock(lock, token);
  }
}

async function readLease(path: string): Promise<Lease | undefined> {
  const value = await readJson(path);
  return isLease(value) ? value : undefined;
}

/** Session ids holding a live lease, pruning dead ones. `safe` is false when any lease is unreadable. */
export async function liveSessionLeases(root: string) {
  const directory = join(root, "session-artifacts");
  const sessionIds = new Set<string>();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    return { safe: error?.code === "ENOENT", sessionIds };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name),
      active = await readLease(path);
    if (!active) return { safe: false, sessionIds };
    if (!processIsAlive(active.pid)) {
      await rm(path, { force: true });
      continue;
    }
    sessionIds.add(active.sessionId);
  }
  return { safe: true, sessionIds };
}

/**
 * Leases `root` for `sessionId` and schedules maintenance. `collect` runs under the lock with
 * every session id that is still live (listed, leased, or this one), and is skipped when the
 * session list or the leases cannot be read. The returned release drops this session's lease;
 * `cleanupIfLast` then runs under the same lock when no live lease remains for the session.
 */
export async function startSessionLease(
  root: string,
  sessionId: string,
  name: string,
  collect: (liveSessionIds: ReadonlySet<string>) => Promise<void>,
  listSessions: () => Promise<Array<{ id: string }>> = () => listSessionInventory(undefined, { strict: true }),
) {
  const token = randomUUID(),
    leases = join(root, "session-artifacts"),
    leasePath = join(leases, `${encodeURIComponent(sessionId)}.${token}.json`),
    lease: Lease = { version: LEASE_VERSION, sessionId, pid: process.pid, token };
  const withLock = <T>(task: () => Promise<T>) => withSessionArtifactLock(root, name, task);

  await withLock(async () => {
    await mkdir(leases, { recursive: true });
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  });

  const maintenance = createSessionMaintenance(root, () =>
    withLock(async () => {
      let sessions: Array<{ id: string }>;
      try {
        sessions = await listSessions();
      } catch {
        return;
      }
      const active = await liveSessionLeases(root);
      if (!active.safe) return;
      const live = new Set(sessions.map(item => item.id));
      live.add(sessionId);
      for (const id of active.sessionIds) live.add(id);
      await collect(live);
    }),
  );

  return Object.assign(
    async (cleanupIfLast?: () => Promise<void>) => {
      await maintenance.stop();
      await withLock(async () => {
        const owned = await readLease(leasePath);
        if (owned?.token !== token) return;
        await rm(leasePath, { force: true });
        if (!cleanupIfLast) return;
        const active = await liveSessionLeases(root);
        if (active.safe && !active.sessionIds.has(sessionId)) await cleanupIfLast();
      });
    },
    { collect: maintenance.collect, cancel: maintenance.cancel },
  );
}

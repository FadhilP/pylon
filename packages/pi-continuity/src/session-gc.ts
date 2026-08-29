import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listSessionInventory } from "pylon-core/session-inventory";

const LEASE_VERSION = 1;
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
  return (
    value?.version === 1 &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string"
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

async function withLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const lock = join(root, "session-artifacts.lock"),
    recoveryLock = `${lock}.recovery`,
    token = randomUUID(),
    claim = join(root, `.session-artifacts-claim-${process.pid}-${token}`),
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
      let active: unknown;
      try {
        active = JSON.parse(await readFile(lock, "utf8"));
      } catch (error: any) {
        if (error?.code === "ENOENT") return true;
        throw Error("Unreadable continuity session-artifact lock.");
      }
      if (!isLockOwner(active))
        throw Error("Unreadable continuity session-artifact lock.");
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
    if (isLockOwner(active) && active.token === token)
      await rm(lock, { force: true });
  }
}

async function readLease(path: string): Promise<Lease | undefined> {
  const value = await readJson(path);
  return isLease(value) ? value : undefined;
}

async function liveLeases(directory: string) {
  const sessionIds = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
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

export async function startSessionGc(
  root: string,
  sessionId: string,
  cleanup: (liveSessionIds: ReadonlySet<string>) => Promise<void>,
  listSessions: () => Promise<Array<{ id: string }>> = () =>
    listSessionInventory(undefined, { strict: true }),
) {
  const leases = join(root, "session-artifacts"),
    token = randomUUID(),
    leasePath = join(leases, `${encodeURIComponent(sessionId)}.${token}.json`),
    lease: Lease = {
      version: LEASE_VERSION,
      sessionId,
      pid: process.pid,
      token,
    };

  await withLock(root, async () => {
    await mkdir(leases, { recursive: true });
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    let sessions: Array<{ id: string }>;
    try {
      sessions = await listSessions();
    } catch {
      return;
    }
    const active = await liveLeases(leases);
    if (!active.safe) return;
    const live = new Set(sessions.map((item) => item.id));
    live.add(sessionId);
    for (const id of active.sessionIds) live.add(id);
    await cleanup(live);
  });

  return async (cleanupIfLast?: () => Promise<void>) =>
    withLock(root, async () => {
      const owned = await readLease(leasePath);
      if (owned?.token !== token) return;
      await rm(leasePath, { force: true });
      if (!cleanupIfLast) return;
      const active = await liveLeases(leases);
      if (active.safe && !active.sessionIds.has(sessionId))
        await cleanupIfLast();
    });
}

export async function pruneOrphanWorkFiles(
  root: string,
  liveSessionIds: ReadonlySet<string>,
) {
  const workspaces = join(root, "workspaces");
  for (const workspace of await readdir(workspaces, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!workspace.isDirectory()) continue;
    const sessions = join(workspaces, workspace.name, "sessions");
    for (const entry of await readdir(sessions, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const encoded = entry.name.slice(0, -5);
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      if (
        `${encodeURIComponent(sessionId)}.json` !== entry.name ||
        liveSessionIds.has(sessionId)
      )
        continue;
      await rm(join(sessions, entry.name), { force: true });
    }
  }
}

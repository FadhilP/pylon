import { randomUUID } from "node:crypto";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_LOCK_BYTES = 1_024;

interface LockOwner {
  pid: number;
  token?: string;
}

export interface PortReservation {
  port: number;
  release(): Promise<void>;
}

function lockPath(port: number): string {
  // Keep the legacy namespace while Helios migrates so both callers coordinate.
  return join(tmpdir(), `pi-helios-port-${port}.lock`);
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return undefined;
  let data: Buffer;
  try {
    const info = await file.stat();
    if (info.size <= 0 || info.size > MAX_LOCK_BYTES) return undefined;
    data = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) return undefined;
  } finally {
    await file.close().catch(() => {});
  }
  const text = data.toString("utf8").trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || value.pid! <= 0) return undefined;
    if (typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)) return undefined;
    return { pid: value.pid!, token: value.token };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function createLock(path: string, token: string): Promise<FileHandle> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

export async function reserveAndroidPort(port: number): Promise<PortReservation | undefined> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Android port is invalid");
  const path = lockPath(port);
  const token = randomUUID();
  let handle: FileHandle;
  try {
    handle = await createLock(path, token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale takeover. A crashed reclaimer can strand only this one
    // candidate port; automatic reclaim of the reclaim lock would recreate the
    // same check/delete race this guard prevents.
    const reclaimPath = `${path}.reclaim`;
    let reclaim: FileHandle;
    try {
      reclaim = await open(reclaimPath, "wx", 0o600);
    } catch {
      return undefined;
    }
    try {
      await reclaim.writeFile(`${process.pid}\n`);
    } catch {
      await reclaim.close().catch(() => {});
      await rm(reclaimPath, { force: true }).catch(() => {});
      return undefined;
    }
    try {
      const age = await stat(path)
        .then(info => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age <= STALE_LOCK_MS) return undefined;
      const owner = await readOwner(path);
      if (owner && processIsAlive(owner.pid)) return undefined;
      await rm(path, { force: true }).catch(() => {});
      try {
        handle = await createLock(path, token);
      } catch {
        return undefined;
      }
    } finally {
      await reclaim.close().catch(() => {});
      await rm(reclaimPath, { force: true }).catch(() => {});
    }
  }

  let released = false;
  return {
    port,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => {});
      const owner = await readOwner(path);
      if (owner?.token === token) await rm(path, { force: true }).catch(() => {});
    },
  };
}

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type LockOwner = { version: 1; token: string; pid: number; createdAt: string };
const LOCK_WAIT_ATTEMPTS = 200;
const LOCK_STALE_MS = 30_000;
const ownerFile = (lock: string) => join(lock, "owner.json");

const processAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
};

async function readLockOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerFile(lock), "utf8"));
    return value?.version === 1 &&
      typeof value.token === "string" &&
      Number.isSafeInteger(value.pid) &&
      typeof value.createdAt === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

async function removeStaleLock(lock: string) {
  const before = await readLockOwner(lock);
  const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
  if (age <= LOCK_STALE_MS || (before && processAlive(before.pid))) return false;
  const after = await readLockOwner(lock);
  if ((before?.token ?? "") !== (after?.token ?? "")) return false;
  await rm(lock, { recursive: true, force: true });
  return true;
}

/**
 * Runs `task` while holding a cross-process `${path}.lock` directory. A lock older than 30s
 * whose owner process is gone is treated as stale and removed. `name` labels errors.
 */
export async function withDirectoryLock<T>(
  path: string,
  task: () => Promise<T>,
  { name, retryMs = 50 }: { name: string; retryMs?: number },
): Promise<T> {
  const lock = `${path}.lock`,
    token = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error: any) {
      if (attempt >= LOCK_WAIT_ATTEMPTS) throw Error(`Unable to lock ${name}: ${path}`, { cause: error });
      if (error?.code === "EEXIST") {
        if (!(await removeStaleLock(lock))) await delay(retryMs);
        continue;
      }
      // Windows can report EPERM instead of EEXIST while another process is
      // removing the lock directory. Retry acquisition, but never treat it as
      // ownership or use it to remove a possibly live lock.
      if (process.platform === "win32" && error?.code === "EPERM") {
        await delay(retryMs);
        continue;
      }
      throw Error(`Unable to lock ${name}: ${path}`, { cause: error });
    }
    try {
      await writeFile(
        ownerFile(lock),
        JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        } satisfies LockOwner),
        { mode: 0o600, flag: "wx" },
      );
      break;
    } catch (error) {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
      throw Error(`Unable to initialize ${name} lock: ${path}`, { cause: error });
    }
  }
  try {
    return await task();
  } finally {
    const owner = await readLockOwner(lock);
    if (owner?.token === token) await rm(lock, { recursive: true, force: true });
  }
}

/** Writes durably: fsyncs a private temporary file, renames it into place, then fsyncs the directory. */
export async function writeBytesAtomic(path: string, value: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r").catch(() => undefined);
    if (directory)
      try {
        await directory.sync().catch(() => {});
      } finally {
        await directory.close();
      }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

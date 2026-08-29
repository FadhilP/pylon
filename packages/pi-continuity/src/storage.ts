import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const defaultRoot = () => join(getAgentDir(), "pi-continuity");

const invalidData = (message: string) =>
  Object.assign(new Error(message), { code: "PI_CONTINUITY_INVALID_DATA" });
const recoverableDataError = (error: any) =>
  error instanceof SyntaxError || error?.code === "PI_CONTINUITY_INVALID_DATA";

/** Missing files use the fallback. Malformed data is quarantined; I/O and permission errors fail closed. */
export async function readJson<T>(
  path: string,
  fallback: T,
  valid: (x: any) => boolean = () => true,
): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!valid(value)) throw invalidData("invalid JSON state");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    if (!recoverableDataError(error)) throw error;
    await rename(path, `${path}.corrupt-${randomUUID()}`);
    return structuredClone(fallback);
  }
}

/** Missing files use the fallback. Unsupported/malformed state is backed up; operational failures propagate. */
export async function readVersionedJson<T>(
  path: string,
  fallback: T,
  valid: (x: any) => boolean,
): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!valid(value)) throw invalidData("unsupported schema");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    if (!recoverableDataError(error)) throw error;
    await rename(path, `${path}.reset-unsupported-${randomUUID()}`);
    return structuredClone(fallback);
  }
}

type LockOwner = { version: 1; token: string; pid: number; createdAt: string };
const LOCK_WAIT_ATTEMPTS = 200;
const LOCK_RETRY_MS = 50;
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
  const age =
    Date.now() -
    (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
  if (age <= LOCK_STALE_MS || (before && processAlive(before.pid)))
    return false;
  const after = await readLockOwner(lock);
  if ((before?.token ?? "") !== (after?.token ?? "")) return false;
  await rm(lock, { recursive: true, force: true });
  return true;
}
export async function withFileLock<T>(
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`,
    token = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
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
    } catch (error: any) {
      if (error?.code !== "EEXIST" || attempt >= LOCK_WAIT_ATTEMPTS)
        throw Error(`Unable to lock continuity state: ${path}`);
      if (!(await removeStaleLock(lock))) await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await task();
  } finally {
    const owner = await readLockOwner(lock);
    if (owner?.token === token)
      await rm(lock, { recursive: true, force: true });
  }
}

export const serializedJson = (value: any) =>
  JSON.stringify(value, null, 2) + "\n";
export async function writeBytesAtomic(
  path: string,
  value: string | Uint8Array,
) {
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
export async function writeJsonAtomic(path: string, value: any) {
  await writeBytesAtomic(path, serializedJson(value));
}
export async function writeJson(path: string, value: any) {
  await withFileLock(path, () => writeJsonAtomic(path, value));
}
export async function withStateLock<T>(
  directory: string,
  task: () => Promise<T>,
): Promise<T> {
  return withFileLock(join(directory, "state"), task);
}
export async function updateJson<T>(
  path: string,
  fallback: T,
  update: (value: T) => T,
  valid: (value: any) => boolean = () => true,
): Promise<T> {
  return withFileLock(path, async () => {
    const next = update(await readJson(path, fallback, valid));
    await writeJsonAtomic(path, next);
    return next;
  });
}
export { rm };

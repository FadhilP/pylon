import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const defaultRoot = () => join(getAgentDir(), "pi-continuity");
export async function readJson<T>(
  path: string,
  fallback: T,
  valid: (x: any) => boolean = () => true,
): Promise<T> {
  try {
    const x = JSON.parse(await readFile(path, "utf8"));
    if (!valid(x)) throw Error("invalid");
    return x;
  } catch (e: any) {
    if (e?.code !== "ENOENT")
      await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return structuredClone(fallback);
  }
}

/** Versioned state deliberately resets rather than attempting a silent migration. */
export async function readVersionedJson<T>(
  path: string,
  fallback: T,
  valid: (x: any) => boolean,
): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!valid(value)) throw Error("unsupported schema");
    return value;
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      await rename(path, `${path}.reset-unsupported-${randomUUID()}`);
    return structuredClone(fallback);
  }
}
async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST" || attempt >= 100)
        throw Error(`Unable to lock continuity state: ${path}`);
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 30_000) await rm(lock, { recursive: true, force: true });
      else await delay(50);
    }
  }
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function writeUnlocked(path: string, value: any) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJson(path: string, value: any) {
  await withLock(path, () => writeUnlocked(path, value));
}

export async function withStateLock<T>(
  directory: string,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(join(directory, "state"), task);
}

export async function updateJson<T>(
  path: string,
  fallback: T,
  update: (value: T) => T,
  valid: (value: any) => boolean = () => true,
): Promise<T> {
  return withLock(path, async () => {
    const next = update(await readJson(path, fallback, valid));
    await writeUnlocked(path, next);
    return next;
  });
}
export { rm };

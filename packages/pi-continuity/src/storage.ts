import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withDirectoryLock, writeBytesAtomic } from "pylon-core/file-lock";

export { writeBytesAtomic };
export const defaultRoot = () => join(getAgentDir(), "pi-continuity");

const invalidData = (message: string) => Object.assign(new Error(message), { code: "PI_CONTINUITY_INVALID_DATA" });
const recoverableDataError = (error: any) =>
  error instanceof SyntaxError || error?.code === "PI_CONTINUITY_INVALID_DATA";

/** Missing files use the fallback. Malformed data is quarantined; I/O and permission errors fail closed. */
export async function readJson<T>(path: string, fallback: T, valid: (x: any) => boolean = () => true): Promise<T> {
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

/** Missing files use the fallback. Malformed files are backed up; unsupported parsed state is preserved and refused. */
export async function readVersionedJson<T>(path: string, fallback: T, valid: (x: any) => boolean): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await rename(path, `${path}.corrupt-${randomUUID()}`);
    return structuredClone(fallback);
  }
  if (!valid(value)) throw invalidData("unsupported versioned JSON state");
  return value as T;
}

/** Refuse to replace versioned state created by a newer incompatible generation. */
export async function assertVersionedJsonWritable(
  path: string,
  field: "version" | "schemaVersion",
  currentVersion: number,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Number.isSafeInteger(value?.[field]) && Number(value[field]) > currentVersion)
      throw invalidData(`stored ${field} is newer than supported version ${currentVersion}`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

export const withFileLock = <T>(path: string, task: () => Promise<T>): Promise<T> =>
  withDirectoryLock(path, task, { name: "continuity state" });

export const serializedJson = (value: any) => JSON.stringify(value, null, 2) + "\n";
export async function writeJsonAtomic(path: string, value: any) {
  await writeBytesAtomic(path, serializedJson(value));
}
export async function writeJson(path: string, value: any) {
  await withFileLock(path, () => writeJsonAtomic(path, value));
}
export async function withStateLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Load a valid config or fall back, quarantining malformed supported files for recovery. */
export async function loadJsonConfig<T>(
  path: string,
  parse: (value: any) => T | undefined,
  fallback: () => T,
  currentVersion?: number,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") await quarantine(path);
    return fallback();
  }
  try {
    const value = JSON.parse(raw);
    const parsed = parse(value);
    if (parsed !== undefined) return parsed;
    if (currentVersion !== undefined && Number.isSafeInteger(value?.version) && value.version > currentVersion)
      return fallback();
  } catch {
    /* Fall through to quarantine malformed data. */
  }
  await quarantine(path);
  return fallback();
}

const quarantine = (path: string) => rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});

/** Refuse to replace a valid config written by a newer incompatible generation. */
export async function assertJsonConfigWritable(path: string, currentVersion: number): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    if (Number.isSafeInteger(value?.version) && value.version > currentVersion)
      throw new Error(`Config version ${value.version} is newer than supported version ${currentVersion}`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

/** Writes a config atomically and owner-readable only, leaving no temporary file behind on failure. */
export async function saveJsonConfig(config: unknown, path: string): Promise<void> {
  const version = (config as { version?: unknown } | null)?.version;
  if (Number.isSafeInteger(version)) await assertJsonConfigWritable(path, Number(version));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Load/save for the per-package JSON config files under the agent directory.
 *
 * The read path fails soft on purpose: a config that is missing, unparseable, or
 * structurally wrong must never stop the agent from starting. Anything present but
 * invalid is renamed aside rather than deleted, so a hand-edited file can be recovered.
 */

/**
 * Reads and validates a config. `parse` returns the accepted value, or undefined to
 * reject the file — a rejected (but present) file is quarantined before `fallback` is used.
 */
export async function loadJsonConfig<T>(
  path: string,
  parse: (value: any) => T | undefined,
  fallback: () => T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") await quarantine(path);
    return fallback();
  }
  try {
    const parsed = parse(JSON.parse(raw));
    if (parsed !== undefined) return parsed;
  } catch {
    /* Fall through to quarantine; a corrupt file is not an error worth raising. */
  }
  await quarantine(path);
  return fallback();
}

const quarantine = (path: string) =>
  rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});

/** Writes a config atomically and owner-readable only, leaving no temporary file behind on failure. */
export async function saveJsonConfig(
  config: unknown,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

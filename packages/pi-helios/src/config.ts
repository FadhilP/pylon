import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type HeliosConfig = { version: 1; headed?: boolean };
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-helios", "config.json");

export async function loadConfig(path = configPath()): Promise<HeliosConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1 || value.headed !== undefined && typeof value.headed !== "boolean") {
      throw new Error("invalid config");
    }
    return { version: 1, ...(value.headed !== undefined ? { headed: value.headed } : {}) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1 };
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return { version: 1 };
  }
}

export async function saveConfig(config: HeliosConfig, path = configPath()): Promise<void> {
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

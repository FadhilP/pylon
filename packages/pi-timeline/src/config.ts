import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TimelineConfig {
  version: 1;
  editRollbackDefault: boolean;
}

export const defaultConfig = (): TimelineConfig => ({ version: 1, editRollbackDefault: false });

export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-timeline", "config.json");

export async function loadConfig(path = configPath()): Promise<TimelineConfig> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
  const value = JSON.parse(serialized);
  if (value?.version !== 1 || typeof value.editRollbackDefault !== "boolean") {
    throw new Error("invalid pi-timeline config");
  }
  return { version: 1, editRollbackDefault: value.editRollbackDefault };
}

export async function saveConfig(config: TimelineConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

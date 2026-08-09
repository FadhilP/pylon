import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PylonCoreConfig = {
  version: 1;
  lineEditEnabled: boolean;
};

export const defaultConfig = (): PylonCoreConfig => ({ version: 1, lineEditEnabled: false });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pylon-core", "config.json");

export async function loadConfig(path = configPath()): Promise<PylonCoreConfig> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
  try {
    const value = JSON.parse(serialized);
    if (value?.version !== 1 || typeof value.lineEditEnabled !== "boolean") throw new Error("invalid config");
    return { version: 1, lineEditEnabled: value.lineEditEnabled };
  } catch (error) {
    try {
      await rename(path, `${path}.corrupt-${randomUUID()}`);
    } catch (quarantineError: any) {
      throw new Error(
        `Could not quarantine invalid pylon-core config: ${quarantineError?.message ?? String(quarantineError)}`,
        { cause: error },
      );
    }
    return defaultConfig();
  }
}

export async function saveConfig(config: PylonCoreConfig, path = configPath()): Promise<void> {
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

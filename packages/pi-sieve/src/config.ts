import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SIEVE_THRESHOLD } from "./sieve.ts";

export const MIN_SIEVE_THRESHOLD = 1_000;
export const MAX_SIEVE_THRESHOLD = 50_000;

export type ProjectionMode = "stable" | "legacy";

export type SieveConfig = {
  version: 1;
  activePruning?: boolean;
  threshold?: number;
  projectionMode?: ProjectionMode;
};

export const defaultConfig = (): SieveConfig => ({ version: 1 });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-sieve", "config.json");

export function configuredActivePruning(config: SieveConfig): boolean {
  return config.activePruning ?? true;
}

export function configuredThreshold(config: SieveConfig): number {
  return config.threshold ?? SIEVE_THRESHOLD;
}

export function configuredProjectionMode(config: SieveConfig): ProjectionMode {
  return config.projectionMode ?? "stable";
}

export async function loadConfig(path = configPath()): Promise<SieveConfig> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }

  try {
    const value = JSON.parse(serialized);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      (value.activePruning !== undefined && typeof value.activePruning !== "boolean") ||
      (value.projectionMode !== undefined && value.projectionMode !== "stable" && value.projectionMode !== "legacy") ||
      (value.threshold !== undefined &&
        (!Number.isInteger(value.threshold) ||
          value.threshold < MIN_SIEVE_THRESHOLD ||
          value.threshold > MAX_SIEVE_THRESHOLD))
    )
      throw new Error("invalid config");
    return {
      version: 1,
      ...(value.activePruning !== undefined ? { activePruning: value.activePruning } : {}),
      ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
      ...(value.projectionMode !== undefined ? { projectionMode: value.projectionMode } : {}),
    };
  } catch (error) {
    try {
      await rename(path, `${path}.corrupt-${randomUUID()}`);
    } catch (quarantineError: any) {
      throw new Error(
        `Could not quarantine invalid pi-sieve config: ${quarantineError?.message ?? String(quarantineError)}`,
        { cause: error },
      );
    }
    return defaultConfig();
  }
}

export async function saveConfig(config: SieveConfig, path = configPath()): Promise<void> {
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ROLLOVER_HIGH_MULTIPLIER, DEFAULT_ROLLOVER_LOW_MULTIPLIER, SIEVE_THRESHOLD } from "./sieve.ts";

export const MIN_SIEVE_THRESHOLD = 1_000;
export const MAX_SIEVE_THRESHOLD = 50_000;
export const MIN_ROLLOVER_MULTIPLIER = 1;
export const MAX_ROLLOVER_MULTIPLIER = 64;

export type ProjectionMode = "stable" | "standard-v2" | "legacy";

export type SieveConfig = {
  version: 1;
  activePruning?: boolean;
  threshold?: number;
  projectionMode?: ProjectionMode;
  rolloverHighMultiplier?: number;
  rolloverLowMultiplier?: number;
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
  return config.projectionMode ?? "standard-v2";
}

export function configuredRolloverHighMultiplier(config: SieveConfig): number {
  return config.rolloverHighMultiplier ?? DEFAULT_ROLLOVER_HIGH_MULTIPLIER;
}

export function configuredRolloverLowMultiplier(config: SieveConfig): number {
  return config.rolloverLowMultiplier ?? DEFAULT_ROLLOVER_LOW_MULTIPLIER;
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
      (value.projectionMode !== undefined
        && value.projectionMode !== "stable"
        && value.projectionMode !== "standard-v2"
        && value.projectionMode !== "legacy") ||
      (value.threshold !== undefined &&
        (!Number.isInteger(value.threshold) ||
          value.threshold < MIN_SIEVE_THRESHOLD ||
          value.threshold > MAX_SIEVE_THRESHOLD)) ||
      (value.rolloverHighMultiplier !== undefined &&
        (!Number.isInteger(value.rolloverHighMultiplier) ||
          value.rolloverHighMultiplier < MIN_ROLLOVER_MULTIPLIER ||
          value.rolloverHighMultiplier > MAX_ROLLOVER_MULTIPLIER)) ||
      (value.rolloverLowMultiplier !== undefined &&
        (!Number.isInteger(value.rolloverLowMultiplier) ||
          value.rolloverLowMultiplier < MIN_ROLLOVER_MULTIPLIER ||
          value.rolloverLowMultiplier > MAX_ROLLOVER_MULTIPLIER)) ||
      (value.rolloverHighMultiplier ?? DEFAULT_ROLLOVER_HIGH_MULTIPLIER)
        <= (value.rolloverLowMultiplier ?? DEFAULT_ROLLOVER_LOW_MULTIPLIER)
    )
      throw new Error("invalid config");
    return {
      version: 1,
      ...(value.activePruning !== undefined ? { activePruning: value.activePruning } : {}),
      ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
      ...(value.projectionMode !== undefined ? { projectionMode: value.projectionMode } : {}),
      ...(value.rolloverHighMultiplier !== undefined ? { rolloverHighMultiplier: value.rolloverHighMultiplier } : {}),
      ...(value.rolloverLowMultiplier !== undefined ? { rolloverLowMultiplier: value.rolloverLowMultiplier } : {}),
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

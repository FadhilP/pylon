import { configPath, configuredActivePruning, configuredProjectionMode, configuredRolloverHighMultiplier, configuredRolloverLowMultiplier, configuredThreshold, loadConfig, MAX_ROLLOVER_MULTIPLIER, MAX_SIEVE_THRESHOLD, MIN_ROLLOVER_MULTIPLIER, MIN_SIEVE_THRESHOLD, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "sieve",
    activePruning: configuredActivePruning(config),
    threshold: configuredThreshold(config),
    projectionMode: configuredProjectionMode(config),
    rolloverHighMultiplier: configuredRolloverHighMultiplier(config),
    rolloverLowMultiplier: configuredRolloverLowMultiplier(config),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "sieve" || typeof value.activePruning !== "boolean"
    || (value.projectionMode !== "stable" && value.projectionMode !== "standard-v2" && value.projectionMode !== "legacy")
    || !Number.isInteger(value.threshold)
    || value.threshold < MIN_SIEVE_THRESHOLD
    || value.threshold > MAX_SIEVE_THRESHOLD
    || !Number.isInteger(value.rolloverHighMultiplier)
    || !Number.isInteger(value.rolloverLowMultiplier)
    || value.rolloverLowMultiplier < MIN_ROLLOVER_MULTIPLIER
    || value.rolloverHighMultiplier > MAX_ROLLOVER_MULTIPLIER
    || value.rolloverHighMultiplier <= value.rolloverLowMultiplier) {
    throw new Error("invalid Sieve settings");
  }
  await saveConfig({
    version: 1,
    activePruning: value.activePruning,
    threshold: value.threshold,
    projectionMode: value.projectionMode,
    rolloverHighMultiplier: value.rolloverHighMultiplier,
    rolloverLowMultiplier: value.rolloverLowMultiplier,
  }, configPath(agentDir));
}

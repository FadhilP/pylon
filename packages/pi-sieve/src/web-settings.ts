import { configPath, configuredActivePruning, configuredProjectionMode, configuredThreshold, loadConfig, MAX_SIEVE_THRESHOLD, MIN_SIEVE_THRESHOLD, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "sieve",
    activePruning: configuredActivePruning(config),
    threshold: configuredThreshold(config),
    projectionMode: configuredProjectionMode(config),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "sieve" || typeof value.activePruning !== "boolean"
    || (value.projectionMode !== "stable" && value.projectionMode !== "legacy")
    || !Number.isInteger(value.threshold)
    || value.threshold < MIN_SIEVE_THRESHOLD
    || value.threshold > MAX_SIEVE_THRESHOLD) {
    throw new Error("invalid Sieve settings");
  }
  await saveConfig({ version: 1, activePruning: value.activePruning, threshold: value.threshold, projectionMode: value.projectionMode }, configPath(agentDir));
}

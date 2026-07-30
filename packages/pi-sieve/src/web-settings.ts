import { configPath, configuredActivePruning, configuredThreshold, loadConfig, MAX_SIEVE_THRESHOLD, MIN_SIEVE_THRESHOLD, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "sieve",
    activePruning: configuredActivePruning(config),
    threshold: configuredThreshold(config),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "sieve" || typeof value.activePruning !== "boolean"
    || !Number.isInteger(value.threshold)
    || value.threshold < MIN_SIEVE_THRESHOLD
    || value.threshold > MAX_SIEVE_THRESHOLD) {
    throw new Error("invalid Sieve settings");
  }
  await saveConfig({ version: 1, activePruning: value.activePruning, threshold: value.threshold }, configPath(agentDir));
}

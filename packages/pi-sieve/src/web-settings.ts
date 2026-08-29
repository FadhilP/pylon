import {
  configPath,
  configuredActivePruning,
  configuredProjectionMode,
  configuredRolloverHighMultiplier,
  configuredRolloverLowMultiplier,
  configuredThreshold,
  loadConfig,
  saveConfig,
  validProjectionMode,
  validRolloverMultiplier,
  validSieveThreshold,
} from "./config.ts";

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
  if (
    value?.kind !== "sieve" ||
    typeof value.activePruning !== "boolean" ||
    !validProjectionMode(value.projectionMode) ||
    !validSieveThreshold(value.threshold) ||
    !validRolloverMultiplier(value.rolloverHighMultiplier) ||
    !validRolloverMultiplier(value.rolloverLowMultiplier) ||
    value.rolloverHighMultiplier <= value.rolloverLowMultiplier
  ) {
    throw new Error("invalid Sieve settings");
  }
  await saveConfig(
    {
      version: 1,
      activePruning: value.activePruning,
      threshold: value.threshold,
      projectionMode: value.projectionMode,
      rolloverHighMultiplier: value.rolloverHighMultiplier,
      rolloverLowMultiplier: value.rolloverLowMultiplier,
    },
    configPath(agentDir),
  );
}

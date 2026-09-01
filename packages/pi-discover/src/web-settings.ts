import { extractPackageSettingsUpdate, effectivePackageSettingsReadModel } from "pylon-core/package-settings";
import { configPath, discoverSettings, loadConfig, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  return effectivePackageSettingsReadModel(discoverSettings, await loadConfig(configPath(agentDir)));
}

export async function updateSettings(value: unknown, { agentDir }: { agentDir: string }): Promise<void> {
  const values = extractPackageSettingsUpdate(discoverSettings, value);
  await saveConfig({ version: 1, ...values }, configPath(agentDir));
}

import { extractPackageSettingsUpdate, effectivePackageSettingsReadModel } from "pylon-core/package-settings";
import { configPath, heliosSettings, loadConfig, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  return effectivePackageSettingsReadModel(heliosSettings, await loadConfig(configPath(agentDir)));
}

export async function updateSettings(value: unknown, { agentDir }: { agentDir: string }): Promise<void> {
  const values = extractPackageSettingsUpdate(heliosSettings, value);
  await saveConfig({ version: 1, ...values }, configPath(agentDir));
}

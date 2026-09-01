import { extractPackageSettingsUpdate, effectivePackageSettingsReadModel } from "./package-settings.ts";
import { configPath, loadConfig, pylonCoreSettings, saveConfig, type PylonCoreConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  return effectivePackageSettingsReadModel(pylonCoreSettings, await loadConfig(configPath(agentDir)));
}

export async function updateSettings(value: unknown, { agentDir }: { agentDir: string }): Promise<void> {
  const values = extractPackageSettingsUpdate(pylonCoreSettings, value);
  await saveConfig({ version: 1, ...values } as PylonCoreConfig, configPath(agentDir));
}

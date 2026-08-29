import { configPath, loadConfig, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return { kind: "helios", headed: config.headed ?? false };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "helios" || typeof value.headed !== "boolean") {
    throw new Error("invalid Helios settings");
  }
  await saveConfig({ version: 1, headed: value.headed }, configPath(agentDir));
}

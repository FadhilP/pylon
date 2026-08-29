import { configPath, loadConfig, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return { kind: "timeline", editRollbackDefault: config.editRollbackDefault };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "timeline" || typeof value.editRollbackDefault !== "boolean") {
    throw new Error("invalid Timeline settings");
  }
  await saveConfig({ version: 1, editRollbackDefault: value.editRollbackDefault }, configPath(agentDir));
}

import { configPath, loadConfig, saveConfig } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return { kind: "pylon-core", lineEditEnabled: config.lineEditEnabled };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "pylon-core" || typeof value.lineEditEnabled !== "boolean")
    throw new Error("invalid Pylon Core settings");
  await saveConfig({ version: 1, lineEditEnabled: value.lineEditEnabled }, configPath(agentDir));
}

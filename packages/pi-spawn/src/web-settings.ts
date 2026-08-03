import { configPath, loadConfig, saveConfig, toolAvailabilities, type ToolAvailability } from "./config.ts";

const validAvailability = (value: unknown): value is ToolAvailability =>
  toolAvailabilities.includes(value as ToolAvailability);

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "spawn",
    agentAvailability: config.agentAvailability,
    sessionAvailability: config.sessionAvailability,
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "spawn" || !validAvailability(value.agentAvailability)
    || !validAvailability(value.sessionAvailability)) {
    throw new Error("invalid Spawn settings");
  }
  await saveConfig({
    version: 1,
    agentAvailability: value.agentAvailability,
    sessionAvailability: value.sessionAvailability,
  }, configPath(agentDir));
}

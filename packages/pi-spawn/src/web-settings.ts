import {
  configPath, loadConfig, saveConfig, thinkingLevels, toolAvailabilities,
  type ThinkingLevel, type ToolAvailability,
} from "./config.ts";

const validAvailability = (value: unknown): value is ToolAvailability =>
  toolAvailabilities.includes(value as ToolAvailability);
const validModels = (value: unknown): value is string[] => value === undefined || Array.isArray(value)
  && value.length > 0 && new Set(value).size === value.length
  && value.every((model) => typeof model === "string" && Boolean(model.trim()));
const validThinking = (value: unknown): value is ThinkingLevel[] => Array.isArray(value)
  && value.length > 0 && new Set(value).size === value.length
  && value.every((level) => thinkingLevels.includes(level as ThinkingLevel));

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "spawn",
    agentAvailability: config.agentAvailability,
    sessionAvailability: config.sessionAvailability,
    ...(config.models ? { models: config.models } : {}),
    agentThinkingLevels: config.agentThinkingLevels ?? [...thinkingLevels],
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "spawn" || !validAvailability(value.agentAvailability)
    || !validAvailability(value.sessionAvailability) || !validModels(value.models)
    || !validThinking(value.agentThinkingLevels)) {
    throw new Error("invalid Spawn settings");
  }
  await saveConfig({
    version: 1,
    agentAvailability: value.agentAvailability,
    sessionAvailability: value.sessionAvailability,
    ...(value.models ? { models: value.models.map((model: string) => model.trim()) } : {}),
    agentThinkingLevels: value.agentThinkingLevels,
  }, configPath(agentDir));
}

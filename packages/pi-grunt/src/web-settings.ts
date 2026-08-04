import { configPath, gruntModes, gruntThinkingLevels, loadConfig, saveConfig, thinkingLevels, type ThinkingLevel } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "grunt",
    mode: config.disabled === true ? "disabled" : config.model ? "model" : config.disabled === false ? "session" : "disabled",
    ...(config.model ? { model: config.model } : {}),
    executionMode: config.mode ?? "isolated",
    thinkingLevels: gruntThinkingLevels(config),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "grunt" || !["disabled", "session", "model"].includes(value.mode)
    || !gruntModes.includes(value.executionMode)
    || !Array.isArray(value.thinkingLevels) || !value.thinkingLevels.length
    || new Set(value.thinkingLevels).size !== value.thinkingLevels.length
    || !value.thinkingLevels.every((level: unknown) => thinkingLevels.includes(level as ThinkingLevel))
    || value.mode === "model" && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error("invalid Grunt settings");
  }
  await saveConfig({
    version: 1,
    disabled: value.mode === "disabled",
    mode: value.executionMode,
    thinkingLevels: value.thinkingLevels,
    ...(value.mode === "model" ? { model: value.model.trim() } : {}),
  }, configPath(agentDir));
}

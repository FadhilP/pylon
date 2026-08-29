import {
  configPath,
  loadConfig,
  saveConfig,
  thinkingLevels,
} from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "advisor",
    mode: config.advisorModel
      ? "model"
      : config.useMainModel
        ? "session"
        : "disabled",
    ...(config.advisorModel ? { model: config.advisorModel } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
  };
}

export async function updateSettings(
  value: any,
  { agentDir }: { agentDir: string },
): Promise<void> {
  if (
    value?.kind !== "advisor" ||
    !["disabled", "session", "model"].includes(value.mode) ||
    (value.thinking !== undefined &&
      !thinkingLevels.includes(value.thinking)) ||
    (value.mode === "model" &&
      (typeof value.model !== "string" || !value.model.trim()))
  ) {
    throw new Error("invalid Advisor settings");
  }
  await saveConfig(
    {
      version: 1,
      ...(value.mode === "session" ? { useMainModel: true } : {}),
      ...(value.mode === "model" ? { advisorModel: value.model.trim() } : {}),
      ...(value.mode !== "disabled" && value.thinking
        ? { thinking: value.thinking }
        : {}),
    },
    configPath(agentDir),
  );
}

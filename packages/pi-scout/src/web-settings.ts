import { configPath, loadConfig, saveConfig, thinkingLevels } from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "scout",
    mode:
      config.disabled === true
        ? "disabled"
        : config.model
          ? "model"
          : config.disabled === false
            ? "session"
            : "disabled",
    ...(config.model ? { model: config.model } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    webSearch: config.webSearch === true,
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "scout" ||
    !["disabled", "session", "model"].includes(value.mode) ||
    (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
    (value.webSearch !== undefined && typeof value.webSearch !== "boolean") ||
    (value.mode === "model" && (typeof value.model !== "string" || !value.model.trim()))
  ) {
    throw new Error("invalid Scout settings");
  }
  await saveConfig(
    {
      version: 1,
      disabled: value.mode === "disabled",
      webSearch: value.webSearch === true,
      ...(value.mode === "model" ? { model: value.model.trim() } : {}),
      ...(value.mode !== "disabled" && value.thinking ? { thinking: value.thinking } : {}),
    },
    configPath(agentDir),
  );
}

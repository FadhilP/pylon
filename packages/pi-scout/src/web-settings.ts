import { packageSettingDefaults, validPackageSettingValue } from "pylon-core/package-settings";
import {
  configPath,
  loadConfig,
  repoTimeoutMs,
  saveConfig,
  scoutMaxCostUsd,
  scoutPrompt,
  scoutSettingFields,
  thinkingLevels,
  webSearchResults,
} from "./config.ts";
import { REPO_SCOUT_PROMPT, WEB_SCOUT_PROMPT } from "./prompts.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "scout" as const,
    defaults: packageSettingDefaults(scoutSettingFields),
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
    repoTimeoutMs: repoTimeoutMs(config.repoTimeoutMs),
    maxCostUsd: scoutMaxCostUsd(config.maxCostUsd) ?? 0,
    webSearchResults: webSearchResults(config.webSearchResults),
    prompt: scoutPrompt(config.prompt),
    promptDefaultText: `Repository Scout:\n${REPO_SCOUT_PROMPT}\n\nWeb Scout:\n${WEB_SCOUT_PROMPT}`,
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "scout" ||
    !["disabled", "session", "model"].includes(value.mode) ||
    (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
    (value.webSearch !== undefined && typeof value.webSearch !== "boolean") ||
    !Object.entries(scoutSettingFields).every(([key, field]) => validPackageSettingValue(field, value[key])) ||
    (value.mode === "model" && (typeof value.model !== "string" || !value.model.trim()))
  ) {
    throw new Error("invalid Scout settings");
  }
  const config = await loadConfig(configPath(agentDir));
  const { model: _model, thinking: _thinking, disabled: _disabled, webSearch: _webSearch, ...preserved } = config;
  await saveConfig(
    {
      ...preserved,
      version: 1,
      disabled: value.mode === "disabled",
      webSearch: value.webSearch === true,
      repoTimeoutMs: value.repoTimeoutMs,
      maxCostUsd: value.maxCostUsd,
      webSearchResults: value.webSearchResults,
      prompt: value.prompt,
      ...(value.mode === "model" ? { model: value.model.trim() } : {}),
      ...(value.mode !== "disabled" && value.thinking ? { thinking: value.thinking } : {}),
    },
    configPath(agentDir),
  );
}

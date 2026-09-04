import { packageSettingDefaults, validPackageSettingValue } from "pylon-core/package-settings";
import {
  advisorInputTokenBudget,
  advisorMaxCalls,
  advisorMaxCostUsd,
  advisorMaxOutputTokens,
  advisorPrompt,
  advisorSettingFields,
  advisorTimeoutMs,
  configPath,
  loadConfig,
  saveConfig,
  thinkingLevels,
} from "./config.ts";
import { ADVISOR_PROMPT } from "./prompts.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "advisor" as const,
    defaults: packageSettingDefaults(advisorSettingFields),
    mode: config.advisorModel ? "model" : config.useMainModel ? "session" : "disabled",
    ...(config.advisorModel ? { model: config.advisorModel } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    maxCalls: advisorMaxCalls(config.maxCalls),
    timeoutMs: advisorTimeoutMs(config.timeoutMs),
    maxCostUsd: advisorMaxCostUsd(config.maxCostUsd),
    maxOutputTokens: advisorMaxOutputTokens(config.maxOutputTokens),
    inputTokenBudget: advisorInputTokenBudget(config.inputTokenBudget),
    prompt: advisorPrompt(config.prompt),
    promptDefaultText: ADVISOR_PROMPT,
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "advisor" ||
    !["disabled", "session", "model"].includes(value.mode) ||
    (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
    !Object.entries(advisorSettingFields).every(([key, field]) => validPackageSettingValue(field, value[key])) ||
    (value.mode === "model" && (typeof value.model !== "string" || !value.model.trim()))
  ) {
    throw new Error("invalid Advisor settings");
  }
  const config = await loadConfig(configPath(agentDir));
  const { advisorModel: _advisorModel, useMainModel: _useMainModel, thinking: _thinking, ...preserved } = config;
  await saveConfig(
    {
      ...preserved,
      version: 1,
      maxCalls: value.maxCalls,
      timeoutMs: value.timeoutMs,
      maxCostUsd: value.maxCostUsd,
      maxOutputTokens: value.maxOutputTokens,
      inputTokenBudget: value.inputTokenBudget,
      prompt: value.prompt,
      ...(value.mode === "session" ? { useMainModel: true } : {}),
      ...(value.mode === "model" ? { advisorModel: value.model.trim() } : {}),
      ...(value.mode !== "disabled" && value.thinking ? { thinking: value.thinking } : {}),
    },
    configPath(agentDir),
  );
}

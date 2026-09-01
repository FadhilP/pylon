import { validPackageSettingValue } from "pylon-core/package-settings";
import {
  configPath,
  gruntMaxCostUsd,
  gruntMaxTurns,
  gruntModes,
  gruntParentContextChars,
  gruntSettingFields,
  gruntThinkingLevels,
  gruntTimeoutMs,
  loadConfig,
  saveConfig,
  thinkingLevels,
  type ThinkingLevel,
} from "./config.ts";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "grunt",
    mode:
      config.disabled === true
        ? "disabled"
        : config.model
          ? "model"
          : config.disabled === false
            ? "session"
            : "disabled",
    ...(config.model ? { model: config.model } : {}),
    executionMode: config.mode ?? "isolated",
    thinkingLevels: gruntThinkingLevels(config),
    timeoutMs: gruntTimeoutMs(config.timeoutMs),
    maxTurns: gruntMaxTurns(config.maxTurns),
    maxCostUsd: gruntMaxCostUsd(config.maxCostUsd),
    parentContextChars: gruntParentContextChars(config.parentContextChars),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "grunt" ||
    !["disabled", "session", "model"].includes(value.mode) ||
    !gruntModes.includes(value.executionMode) ||
    !Object.entries(gruntSettingFields).every(([key, field]) => validPackageSettingValue(field, value[key])) ||
    !Array.isArray(value.thinkingLevels) ||
    !value.thinkingLevels.length ||
    new Set(value.thinkingLevels).size !== value.thinkingLevels.length ||
    !value.thinkingLevels.every((level: unknown) => thinkingLevels.includes(level as ThinkingLevel)) ||
    (value.mode === "model" && (typeof value.model !== "string" || !value.model.trim()))
  ) {
    throw new Error("invalid Grunt settings");
  }
  await saveConfig(
    {
      version: 1,
      disabled: value.mode === "disabled",
      mode: value.executionMode,
      thinkingLevels: value.thinkingLevels,
      timeoutMs: value.timeoutMs,
      maxTurns: value.maxTurns,
      maxCostUsd: value.maxCostUsd,
      parentContextChars: value.parentContextChars,
      ...(value.mode === "model" ? { model: value.model.trim() } : {}),
    },
    configPath(agentDir),
  );
}

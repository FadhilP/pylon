import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
  type PackageSettingField,
} from "pylon-core/package-settings";
import { saveJsonConfig } from "pylon-core/json-config";

export { parseModelRef } from "pylon-core/model-ref";

export const timelineSettingFields = {
  gitTimeoutMs: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "gitTimeoutMs",
    label: "Git timeout",
    type: "integer",
    defaultValue: 120_000,
    min: 1_000,
    max: 600_000,
    unit: "ms",
    env: "PI_TIMELINE_GIT_TIMEOUT_MS",
    apply: "next-session",
  },
  titleTimeoutMs: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "titleTimeoutMs",
    label: "Title generation timeout",
    type: "integer",
    defaultValue: 30_000,
    min: 1_000,
    max: 300_000,
    unit: "ms",
    env: "PI_TIMELINE_TITLE_TIMEOUT_MS",
    apply: "next-session",
  },
  titleMaxTokens: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "titleMaxTokens",
    label: "Title maximum output",
    type: "integer",
    defaultValue: 32,
    min: 8,
    max: 256,
    unit: "tokens",
    env: "PI_TIMELINE_TITLE_MAX_TOKENS",
    apply: "next-session",
  },
  titleChangedFiles: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "titleChangedFiles",
    label: "Changed files in title prompt",
    type: "integer",
    defaultValue: 20,
    min: 1,
    max: 200,
    unit: "files",
    env: "PI_TIMELINE_TITLE_CHANGED_FILES",
    apply: "next-session",
  },
  prompt: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "prompt",
    label: "Timeline naming instructions",
    type: "prompt",
    defaultValue: { mode: "default", text: "" },
    allowedModes: ["default", "append"],
    maxBytes: 32_768,
    description: "Additional instructions for session and checkpoint naming. Output and parser contracts remain fixed.",
    apply: "next-session",
  },
} satisfies Record<string, PackageSettingField>;
export const timelineSettings = definePackageSettings({
  version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  packageId: "pi-timeline",
  fields: Object.values(timelineSettingFields),
});

export interface TimelineConfig {
  version: 1;
  editRollbackDefault: boolean;
  checkpointTitleModel?: string;
  useSessionModelForCheckpointTitles?: boolean;
  gitTimeoutMs?: number;
  titleTimeoutMs?: number;
  titleMaxTokens?: number;
  titleChangedFiles?: number;
  prompt?: import("pylon-core/package-settings").PromptPackageSettingValue;
}
export type TimelineRuntimeSettings = { [K in Exclude<keyof typeof timelineSettingFields, "prompt">]: number };
export const effectiveTimelineSettings = (config: TimelineConfig): TimelineRuntimeSettings => ({
  gitTimeoutMs: effectivePackageSettingValue(timelineSettingFields.gitTimeoutMs, config.gitTimeoutMs, process.env),
  titleTimeoutMs: effectivePackageSettingValue(
    timelineSettingFields.titleTimeoutMs,
    config.titleTimeoutMs,
    process.env,
  ),
  titleMaxTokens: effectivePackageSettingValue(
    timelineSettingFields.titleMaxTokens,
    config.titleMaxTokens,
    process.env,
  ),
  titleChangedFiles: effectivePackageSettingValue(
    timelineSettingFields.titleChangedFiles,
    config.titleChangedFiles,
    process.env,
  ),
});

export const defaultConfig = (): TimelineConfig => ({ version: 1, editRollbackDefault: false });

export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-timeline", "config.json");

export async function loadConfig(path = configPath()): Promise<TimelineConfig> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
  const value = JSON.parse(serialized);
  if (Number.isSafeInteger(value?.version) && value.version > 1) return defaultConfig();
  const validModel =
    value.checkpointTitleModel === undefined ||
    (typeof value.checkpointTitleModel === "string" && !!value.checkpointTitleModel.trim());
  if (
    value?.version !== 1 ||
    typeof value.editRollbackDefault !== "boolean" ||
    !validModel ||
    (value.useSessionModelForCheckpointTitles !== undefined &&
      typeof value.useSessionModelForCheckpointTitles !== "boolean") ||
    (value.checkpointTitleModel && value.useSessionModelForCheckpointTitles) ||
    !Object.entries(timelineSettingFields).every(
      ([key, field]) => value[key] === undefined || validPackageSettingValue(field, value[key]),
    )
  ) {
    throw new Error("invalid pi-timeline config");
  }
  return {
    version: 1,
    editRollbackDefault: value.editRollbackDefault,
    ...(value.checkpointTitleModel ? { checkpointTitleModel: value.checkpointTitleModel.trim() } : {}),
    ...(value.useSessionModelForCheckpointTitles ? { useSessionModelForCheckpointTitles: true } : {}),
    ...(value.gitTimeoutMs !== undefined ? { gitTimeoutMs: value.gitTimeoutMs } : {}),
    ...(value.titleTimeoutMs !== undefined ? { titleTimeoutMs: value.titleTimeoutMs } : {}),
    ...(value.titleMaxTokens !== undefined ? { titleMaxTokens: value.titleMaxTokens } : {}),
    ...(value.titleChangedFiles !== undefined ? { titleChangedFiles: value.titleChangedFiles } : {}),
    ...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
  };
}

export const saveConfig = (config: TimelineConfig, path = configPath()) => saveJsonConfig(config, path);

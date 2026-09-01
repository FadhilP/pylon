import { configPath, effectiveTimelineSettings, loadConfig, saveConfig, timelineSettingFields } from "./config.ts";
import { validPackageSettingValue } from "pylon-core/package-settings";

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "timeline",
    editRollbackDefault: config.editRollbackDefault,
    checkpointTitleMode: config.checkpointTitleModel
      ? "model"
      : config.useSessionModelForCheckpointTitles
        ? "session"
        : "disabled",
    ...(config.checkpointTitleModel ? { checkpointTitleModel: config.checkpointTitleModel } : {}),
    ...effectiveTimelineSettings(config),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "timeline" ||
    typeof value.editRollbackDefault !== "boolean" ||
    !["disabled", "session", "model"].includes(value.checkpointTitleMode) ||
    (value.checkpointTitleMode === "model" &&
      (typeof value.checkpointTitleModel !== "string" || !value.checkpointTitleModel.trim())) ||
    !Object.entries(timelineSettingFields).every(([key, field]) => validPackageSettingValue(field, value[key]))
  ) {
    throw new Error("invalid Timeline settings");
  }
  await saveConfig(
    {
      version: 1,
      editRollbackDefault: value.editRollbackDefault,
      ...(value.checkpointTitleMode === "session" ? { useSessionModelForCheckpointTitles: true } : {}),
      ...(value.checkpointTitleMode === "model" ? { checkpointTitleModel: value.checkpointTitleModel.trim() } : {}),
      gitTimeoutMs: value.gitTimeoutMs,
      titleTimeoutMs: value.titleTimeoutMs,
      titleMaxTokens: value.titleMaxTokens,
      titleChangedFiles: value.titleChangedFiles,
    },
    configPath(agentDir),
  );
}

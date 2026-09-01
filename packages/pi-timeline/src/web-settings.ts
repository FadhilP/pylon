import { configPath, effectiveTimelineSettings, loadConfig, saveConfig, timelineSettingFields } from "./config.ts";
import { validPackageSettingValue } from "pylon-core/package-settings";
import { CHECKPOINT_TITLE_PROMPT, SESSION_TITLE_PROMPT } from "./prompts.ts";

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
    prompt: config.prompt ?? { mode: "default", text: "" },
    promptDefaultText: `Session titles:\n${SESSION_TITLE_PROMPT}\n\nCheckpoint titles:\n${CHECKPOINT_TITLE_PROMPT}`,
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
      prompt: value.prompt,
    },
    configPath(agentDir),
  );
}

import {
  DEFAULT_KEEP_RECENT_TOKENS,
  configPath,
  loadConfig,
  updateConfig,
  thinkingLevels,
  validKeepRecentTokens,
  type ModelProfile,
} from "./config.ts";

function profile(value: any): ModelProfile | undefined {
  if (value === undefined) return undefined;
  if (typeof value?.model !== "string" || !value.model.trim()
    || value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) {
    throw new Error("invalid Continuity model profile");
  }
  return { model: value.model.trim(), ...(value.thinking ? { thinking: value.thinking } : {}) };
}

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "continuity",
    memoryEnabled: config.memoryEnabled !== false,
    keepRecentTokens: config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    ...(config.planner ? { planner: config.planner } : {}),
    ...(config.executor ? { executor: config.executor } : {}),
    ...(config.memoryReviewer ? { memoryReviewer: config.memoryReviewer } : {}),
    ...(config.compactionReviewer ? { compactionReviewer: config.compactionReviewer } : {}),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (value?.kind !== "continuity" || typeof value.memoryEnabled !== "boolean" || !validKeepRecentTokens(value.keepRecentTokens))
    throw new Error("invalid Continuity settings");
  const planner = profile(value.planner);
  const executor = profile(value.executor);
  const memoryReviewer = profile(value.memoryReviewer);
  const compactionReviewer = profile(value.compactionReviewer);
  await updateConfig(() => ({
    version: 2, memoryEnabled: value.memoryEnabled, keepRecentTokens: value.keepRecentTokens,
    ...(planner ? { planner } : {}), ...(executor ? { executor } : {}), ...(memoryReviewer ? { memoryReviewer } : {}),
    ...(compactionReviewer ? { compactionReviewer } : {}),
  }), configPath(agentDir));
}

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readVersionedJson, updateJson, writeJson } from "./storage.ts";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ModelProfile = { model: string; thinking?: ThinkingLevel };
export type ContinuityConfig = { version: 2; memoryEnabled?: boolean; planner?: ModelProfile; executor?: ModelProfile; memoryReviewer?: ModelProfile; compactionReviewer?: ModelProfile };
export const defaultConfig = (): ContinuityConfig => ({ version: 2, memoryEnabled: true });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-continuity", "config.json");
const isProfile = (value: any): value is ModelProfile => Boolean(value && typeof value.model === "string" && value.model.trim() && Object.keys(value).every((key) => key === "model" || key === "thinking") && (value.thinking === undefined || thinkingLevels.includes(value.thinking)));
const normalizeConfig = (value: any): ContinuityConfig | undefined => {
  if (![1, 2].includes(value?.version) || Object.keys(value).some((key) => !["version", "memoryEnabled", "planner", "executor", "memoryReviewer", "compactionReviewer"].includes(key))
    || (value.memoryEnabled !== undefined && typeof value.memoryEnabled !== "boolean") || (value.planner !== undefined && !isProfile(value.planner))
    || (value.executor !== undefined && !isProfile(value.executor)) || (value.memoryReviewer !== undefined && !isProfile(value.memoryReviewer))
    || (value.compactionReviewer !== undefined && !isProfile(value.compactionReviewer))) return;
  return { version: 2, memoryEnabled: value.memoryEnabled ?? true, ...(value.planner ? { planner: value.planner } : {}), ...(value.executor ? { executor: value.executor } : {}), ...(value.memoryReviewer ? { memoryReviewer: value.memoryReviewer } : {}), ...(value.compactionReviewer ? { compactionReviewer: value.compactionReviewer } : {}) };
};
export const isContinuityConfig = (value: any) => normalizeConfig(value) !== undefined;
export async function loadConfig(path = configPath()): Promise<ContinuityConfig> {
  return normalizeConfig(await readVersionedJson(path, defaultConfig(), (value) => normalizeConfig(value) !== undefined))!;
}
export async function saveConfig(config: ContinuityConfig, path = configPath()): Promise<void> {
  const normalized = normalizeConfig({ ...config, version: 2 });
  if (!normalized) throw Error("invalid Continuity config");
  await writeJson(path, normalized);
}
export async function updateConfig(update: (config: ContinuityConfig) => ContinuityConfig, path = configPath()): Promise<ContinuityConfig> {
  return updateJson(path, defaultConfig(), (current) => {
    const normalizedCurrent = normalizeConfig(current);
    const next = normalizedCurrent && normalizeConfig({ ...update(normalizedCurrent), version: 2 });
    if (!next) throw Error("invalid Continuity config update");
    return next;
  }, isContinuityConfig);
}
export function parseModelRef(ref: string): { provider: string; id: string; thinking?: ThinkingLevel } | undefined {
  const slash = ref.indexOf("/"); if (slash < 1 || slash === ref.length - 1) return;
  const colon = ref.lastIndexOf(":"), suffix = ref.slice(colon + 1) as ThinkingLevel, hasThinking = colon > slash && thinkingLevels.includes(suffix);
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1, hasThinking ? colon : undefined), ...(hasThinking ? { thinking: suffix } : {}) };
}

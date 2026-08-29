import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ScoutConfig = {
  version: 1;
  model?: string;
  thinking?: ThinkingLevel;
  disabled?: boolean;
  webSearch?: boolean;
};
export const isScoutEnabled = (config: ScoutConfig): boolean =>
  config.disabled === false || (config.disabled !== true && Boolean(config.model));
export const defaultConfig = (): ScoutConfig => ({ version: 1 });
export const DEFAULT_REPO_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SCOUT_MAX_COST_USD = 1.0;
export function repoTimeoutMs(value = process.env.PI_SCOUT_TIMEOUT_MS): number {
  if (value === undefined) return DEFAULT_REPO_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 7_200_000)
    throw new Error("PI_SCOUT_TIMEOUT_MS must be an integer between 1 and 7200000");
  return timeout;
}

export function scoutMaxCostUsd(value = process.env.PI_SCOUT_MAX_COST_USD): number | undefined {
  if (value === undefined) return DEFAULT_SCOUT_MAX_COST_USD;
  const cost = typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(cost) || cost < 0)
    throw new Error("PI_SCOUT_MAX_COST_USD must be a finite number greater than or equal to 0");
  return cost || undefined;
}
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-scout", "config.json");

export async function loadConfig(path = configPath()): Promise<ScoutConfig> {
  return loadJsonConfig(
    path,
    value => {
      if (
        value?.version !== 1 ||
        (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) ||
        (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
        (value.disabled !== undefined && typeof value.disabled !== "boolean") ||
        (value.webSearch !== undefined && typeof value.webSearch !== "boolean")
      )
        return undefined;
      return {
        version: 1,
        ...(value.model ? { model: value.model } : {}),
        ...(value.thinking ? { thinking: value.thinking } : {}),
        ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
        ...(value.webSearch !== undefined ? { webSearch: value.webSearch } : {}),
      } satisfies ScoutConfig;
    },
    defaultConfig,
  );
}

export const saveConfig = (config: ScoutConfig, path = configPath()) => saveJsonConfig(config, path);

export async function resetConfig(path = configPath()): Promise<void> {
  await rm(path, { force: true });
}

export function parseModelRef(ref: string): { provider: string; id: string; thinking?: ThinkingLevel } | undefined {
  const slash = ref.indexOf("/");
  if (slash < 1 || slash === ref.length - 1) return undefined;
  const colon = ref.lastIndexOf(":");
  const suffix = ref.slice(colon + 1) as ThinkingLevel;
  const hasThinking = colon > slash && thinkingLevels.includes(suffix);
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1, hasThinking ? colon : undefined),
    ...(hasThinking ? { thinking: suffix } : {}),
  };
}

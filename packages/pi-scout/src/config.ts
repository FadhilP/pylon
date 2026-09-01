import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
  type PackageSettingField,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export const DEFAULT_REPO_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SCOUT_MAX_COST_USD = 1.0;
export const DEFAULT_WEB_SEARCH_RESULTS = 5;

/** Shared inert definitions consumed by Scout's runtime and web settings adapter. */
export const scoutSettingFields = {
  repoTimeoutMs: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "repoTimeoutMs",
    label: "Repository scout timeout",
    type: "integer",
    defaultValue: DEFAULT_REPO_TIMEOUT_MS,
    min: 1,
    max: 7_200_000,
    env: "PI_SCOUT_TIMEOUT_MS",
    apply: "next-operation",
  },
  maxCostUsd: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxCostUsd",
    label: "Maximum scout cost",
    type: "number",
    defaultValue: DEFAULT_SCOUT_MAX_COST_USD,
    min: 0,
    max: 100,
    step: 0.01,
    env: "PI_SCOUT_MAX_COST_USD",
    apply: "next-operation",
  },
  webSearchResults: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "webSearchResults",
    label: "Web search results",
    type: "integer",
    defaultValue: DEFAULT_WEB_SEARCH_RESULTS,
    min: 1,
    max: 8,
    apply: "next-operation",
  },
} satisfies Record<string, PackageSettingField>;
export const scoutSettings = definePackageSettings({
  version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  packageId: "pi-scout",
  fields: Object.values(scoutSettingFields),
});

export type ScoutConfig = {
  version: 1;
  model?: string;
  thinking?: ThinkingLevel;
  disabled?: boolean;
  webSearch?: boolean;
  repoTimeoutMs?: number;
  maxCostUsd?: number;
  webSearchResults?: number;
};
export const isScoutEnabled = (config: ScoutConfig): boolean =>
  config.disabled === false || (config.disabled !== true && Boolean(config.model));
export const defaultConfig = (): ScoutConfig => ({ version: 1 });
export const repoTimeoutMs = (value?: unknown): number =>
  effectivePackageSettingValue(scoutSettingFields.repoTimeoutMs, value, process.env);
/** Zero retains Scout's established unlimited-cost semantics. */
export const scoutMaxCostUsd = (value?: unknown): number | undefined => {
  try {
    const cost = effectivePackageSettingValue(scoutSettingFields.maxCostUsd, value, process.env);
    return cost || undefined;
  } catch {
    throw new Error("PI_SCOUT_MAX_COST_USD must be a finite number greater than or equal to 0");
  }
};
export const webSearchResults = (value?: unknown): number =>
  effectivePackageSettingValue(scoutSettingFields.webSearchResults, value, process.env);
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
        (value.webSearch !== undefined && typeof value.webSearch !== "boolean") ||
        !Object.entries(scoutSettingFields).every(
          ([key, field]) => value[key] === undefined || validPackageSettingValue(field, value[key]),
        )
      )
        return undefined;
      return {
        version: 1,
        ...(value.model ? { model: value.model } : {}),
        ...(value.thinking ? { thinking: value.thinking } : {}),
        ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
        ...(value.webSearch !== undefined ? { webSearch: value.webSearch } : {}),
        ...(value.repoTimeoutMs !== undefined ? { repoTimeoutMs: value.repoTimeoutMs } : {}),
        ...(value.maxCostUsd !== undefined ? { maxCostUsd: value.maxCostUsd } : {}),
        ...(value.webSearchResults !== undefined ? { webSearchResults: value.webSearchResults } : {}),
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

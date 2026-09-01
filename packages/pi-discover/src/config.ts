import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const discoverSettings = definePackageSettings({
  version: 1,
  packageId: "pi-discover",
  fields: [
    { version: 1, key: "searchTimeoutMs", label: "Search timeout", type: "integer", defaultValue: 30_000, min: 1_000, max: 300_000, step: 1_000, unit: "ms", apply: "reload" },
    { version: 1, key: "symbolResults", label: "Symbol search results", type: "integer", defaultValue: 30, min: 1, max: 100, apply: "reload" },
    { version: 1, key: "codeResults", label: "Code search results", type: "integer", defaultValue: 10, min: 1, max: 100, apply: "reload" },
    { version: 1, key: "relationshipResults", label: "Relationship map results", type: "integer", defaultValue: 40, min: 1, max: 100, apply: "reload" }
  ],
} as const);

export type DiscoverConfig = { version: 1; searchTimeoutMs?: number; symbolResults?: number; codeResults?: number; relationshipResults?: number };
export type EffectiveDiscoverConfig = { version: 1; searchTimeoutMs: number; symbolResults: number; codeResults: number; relationshipResults: number };
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-discover", "config.json");

const fields = Object.fromEntries(discoverSettings.fields.map(field => [field.key, field]));
export function effectiveConfig(config: DiscoverConfig): EffectiveDiscoverConfig {
  return {
    version: 1,
    searchTimeoutMs: effectivePackageSettingValue(fields.searchTimeoutMs, config.searchTimeoutMs) as number,
    symbolResults: effectivePackageSettingValue(fields.symbolResults, config.symbolResults) as number,
    codeResults: effectivePackageSettingValue(fields.codeResults, config.codeResults) as number,
    relationshipResults: effectivePackageSettingValue(fields.relationshipResults, config.relationshipResults) as number,
  };
}

export function defaultConfig(): DiscoverConfig {
  return { version: 1 };
}

export async function loadConfig(path = configPath()): Promise<DiscoverConfig> {
  return loadJsonConfig(path, value => {
    if (value?.version !== 1 || typeof value !== "object") return undefined;
    const config: DiscoverConfig = { version: 1 };
    for (const field of discoverSettings.fields) {
      const setting = value[field.key];
      if (setting !== undefined && !validPackageSettingValue(field, setting)) return undefined;
      if (setting !== undefined) (config as Record<string, unknown>)[field.key] = setting;
    }
    return config;
  }, defaultConfig);
}

export const saveConfig = (config: DiscoverConfig, path = configPath()) => saveJsonConfig(config, path);

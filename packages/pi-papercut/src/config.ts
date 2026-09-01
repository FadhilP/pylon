import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const papercutSettings = definePackageSettings({
  version: 1,
  packageId: "pi-papercut",
  fields: [
    { version: 1, key: "listDefaultLimit", label: "Default list limit", type: "integer", defaultValue: 50, min: 1, max: 100, apply: "next-session" },
    { version: 1, key: "queryDefaultLimit", label: "Default query limit", type: "integer", defaultValue: 25, min: 1, max: 100, apply: "next-session" },
  ],
} as const);

export type PapercutConfig = { version: 1; listDefaultLimit?: number; queryDefaultLimit?: number };
export type EffectivePapercutConfig = { version: 1; listDefaultLimit: number; queryDefaultLimit: number };
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-papercut", "config.json");

const fields = Object.fromEntries(papercutSettings.fields.map(field => [field.key, field]));
export function effectiveConfig(config: PapercutConfig): EffectivePapercutConfig {
  return {
    version: 1,
    listDefaultLimit: effectivePackageSettingValue(fields.listDefaultLimit, config.listDefaultLimit) as number,
    queryDefaultLimit: effectivePackageSettingValue(fields.queryDefaultLimit, config.queryDefaultLimit) as number,
  };
}

export function defaultConfig(): PapercutConfig {
  return { version: 1 };
}

export async function loadConfig(path = configPath()): Promise<PapercutConfig> {
  return loadJsonConfig(path, value => {
    if (value?.version !== 1 || typeof value !== "object") return undefined;
    const config: PapercutConfig = { version: 1 };
    for (const field of papercutSettings.fields) {
      const setting = value[field.key];
      if (setting !== undefined && !validPackageSettingValue(field, setting)) return undefined;
      if (setting !== undefined) (config as Record<string, unknown>)[field.key] = setting;
    }
    return config;
  }, defaultConfig);
}

export const saveConfig = (config: PapercutConfig, path = configPath()) => saveJsonConfig(config, path);

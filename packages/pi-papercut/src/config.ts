import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettings,
  parsePackageSettingsConfig,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const papercutSettings = definePackageSettings({
  version: 1,
  packageId: "pi-papercut",
  fields: [
    {
      version: 1,
      key: "listDefaultLimit",
      label: "Default list limit",
      type: "integer",
      defaultValue: 50,
      min: 1,
      max: 100,
      apply: "next-session",
    },
    {
      version: 1,
      key: "queryDefaultLimit",
      label: "Default query limit",
      type: "integer",
      defaultValue: 25,
      min: 1,
      max: 100,
      apply: "next-session",
    },
  ],
} as const);

export type PapercutConfig = { version: 1; listDefaultLimit?: number; queryDefaultLimit?: number };
export type EffectivePapercutConfig = { version: 1; listDefaultLimit: number; queryDefaultLimit: number };
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-papercut", "config.json");

export function effectiveConfig(config: PapercutConfig): EffectivePapercutConfig {
  return effectivePackageSettings(papercutSettings, config);
}

export function defaultConfig(): PapercutConfig {
  return { version: 1 };
}

export async function loadConfig(path = configPath()): Promise<PapercutConfig> {
  return loadJsonConfig(path, value => parsePackageSettingsConfig(papercutSettings, value), defaultConfig, 1);
}

export const saveConfig = (config: PapercutConfig, path = configPath()) => saveJsonConfig(config, path);

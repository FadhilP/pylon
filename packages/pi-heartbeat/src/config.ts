import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const heartbeatSettings = definePackageSettings({
  version: 1,
  packageId: "pi-heartbeat",
  fields: [
    { version: 1, key: "defaultJobTimeoutMs", label: "Default job timeout", type: "integer", defaultValue: 1_800_000, min: 1_000, max: 7_200_000, step: 1_000, unit: "ms", apply: "next-session" },
    { version: 1, key: "completedJobRetention", label: "Completed job retention", type: "integer", defaultValue: 20, min: 1, max: 100, apply: "next-session" },
  ],
} as const);

export type HeartbeatConfig = { version: 1; defaultJobTimeoutMs?: number; completedJobRetention?: number };
export type EffectiveHeartbeatConfig = { version: 1; defaultJobTimeoutMs: number; completedJobRetention: number };
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-heartbeat", "config.json");

const fields = Object.fromEntries(heartbeatSettings.fields.map(field => [field.key, field]));
export function effectiveConfig(config: HeartbeatConfig): EffectiveHeartbeatConfig {
  return {
    version: 1,
    defaultJobTimeoutMs: effectivePackageSettingValue(fields.defaultJobTimeoutMs, config.defaultJobTimeoutMs) as number,
    completedJobRetention: effectivePackageSettingValue(fields.completedJobRetention, config.completedJobRetention) as number,
  };
}

export function defaultConfig(): HeartbeatConfig {
  return { version: 1 };
}

export async function loadConfig(path = configPath()): Promise<HeartbeatConfig> {
  return loadJsonConfig(path, value => {
    if (value?.version !== 1 || typeof value !== "object") return undefined;
    const config: HeartbeatConfig = { version: 1 };
    for (const field of heartbeatSettings.fields) {
      const setting = value[field.key];
      if (setting !== undefined && !validPackageSettingValue(field, setting)) return undefined;
      if (setting !== undefined) (config as Record<string, unknown>)[field.key] = setting;
    }
    return config;
  }, defaultConfig);
}

export const saveConfig = (config: HeartbeatConfig, path = configPath()) => saveJsonConfig(config, path);

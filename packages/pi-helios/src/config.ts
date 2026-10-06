import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettings,
  parsePackageSettingsConfig,
} from "pylon-core/package-settings";
import { loadJsonConfig, saveJsonConfig } from "pylon-core/json-config";

export const heliosSettings = definePackageSettings({
  version: 1,
  packageId: "pi-helios",
  fields: [
    {
      version: 1,
      key: "headed",
      label: "Future owned browsers",
      type: "boolean",
      defaultValue: false,
      apply: "next-operation",
    },
    {
      version: 1,
      key: "androidStartTimeoutMs",
      label: "Android startup timeout",
      type: "integer",
      defaultValue: 180_000,
      min: 1_000,
      max: 600_000,
      step: 1_000,
      unit: "ms",
      apply: "next-operation",
    },
    {
      version: 1,
      key: "androidInstallTimeoutMs",
      label: "Android tooling install timeout",
      type: "integer",
      defaultValue: 600_000,
      min: 1_000,
      max: 1_800_000,
      step: 1_000,
      unit: "ms",
      apply: "next-operation",
    },
    {
      version: 1,
      key: "browserLeaseIdleMs",
      label: "Browser control lease idle time",
      type: "integer",
      defaultValue: 5_000,
      min: 0,
      max: 60_000,
      step: 1_000,
      unit: "ms",
      apply: "next-operation",
    },
    {
      version: 1,
      key: "browserResultTabs",
      label: "Browser result tabs",
      type: "integer",
      defaultValue: 20,
      min: 1,
      max: 100,
      apply: "next-operation",
    },
  ],
} as const);

export type HeliosConfig = {
  version: 1;
  headed?: boolean;
  androidStartTimeoutMs?: number;
  androidInstallTimeoutMs?: number;
  browserLeaseIdleMs?: number;
  browserResultTabs?: number;
};
export type EffectiveHeliosConfig = {
  version: 1;
  headed: boolean;
  androidStartTimeoutMs: number;
  androidInstallTimeoutMs: number;
  browserLeaseIdleMs: number;
  browserResultTabs: number;
};
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-helios", "config.json");

export function effectiveConfig(config: HeliosConfig): EffectiveHeliosConfig {
  return effectivePackageSettings(heliosSettings, config);
}

export async function loadConfig(path = configPath()): Promise<HeliosConfig> {
  return loadJsonConfig(
    path,
    value => parsePackageSettingsConfig(heliosSettings, value),
    () => ({ version: 1 }),
    1,
  );
}

export const saveConfig = (config: HeliosConfig, path = configPath()) => saveJsonConfig(config, path);

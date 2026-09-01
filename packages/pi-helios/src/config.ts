import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
} from "pylon-core/package-settings";

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

const fields = Object.fromEntries(heliosSettings.fields.map(field => [field.key, field]));
export function effectiveConfig(config: HeliosConfig): EffectiveHeliosConfig {
  return {
    version: 1,
    headed: effectivePackageSettingValue(fields.headed, config.headed) as boolean,
    androidStartTimeoutMs: effectivePackageSettingValue(
      fields.androidStartTimeoutMs,
      config.androidStartTimeoutMs,
    ) as number,
    androidInstallTimeoutMs: effectivePackageSettingValue(
      fields.androidInstallTimeoutMs,
      config.androidInstallTimeoutMs,
    ) as number,
    browserLeaseIdleMs: effectivePackageSettingValue(fields.browserLeaseIdleMs, config.browserLeaseIdleMs) as number,
    browserResultTabs: effectivePackageSettingValue(fields.browserResultTabs, config.browserResultTabs) as number,
  };
}

export async function loadConfig(path = configPath()): Promise<HeliosConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1 || typeof value !== "object") throw new Error("invalid config");
    const config: HeliosConfig = { version: 1 };
    for (const field of heliosSettings.fields) {
      const setting = value[field.key];
      if (setting !== undefined && !validPackageSettingValue(field, setting)) throw new Error("invalid config");
      if (setting !== undefined) (config as any)[field.key] = setting;
    }
    return config;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1 };
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return { version: 1 };
  }
}

export async function saveConfig(config: HeliosConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

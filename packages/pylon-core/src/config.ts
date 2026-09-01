import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { definePackageSettings, effectivePackageSettingValue, validPackageSettingValue } from "./package-settings.ts";

export const pylonCoreSettings = definePackageSettings({
  version: 1,
  packageId: "pylon-core",
  fields: [
    {
      version: 1,
      key: "lineEditEnabled",
      label: "Revision-guarded numbered edits",
      type: "boolean",
      defaultValue: true,
      apply: "next-session",
    },
    {
      version: 1,
      key: "lineEditPriceRatio",
      label: "Line-edit price ratio",
      type: "number",
      defaultValue: 3,
      min: 1,
      max: 100,
      step: 0.1,
      apply: "next-session",
    },
    {
      version: 1,
      key: "delegateMaxAttempts",
      label: "Delegate maximum attempts",
      type: "integer",
      defaultValue: 3,
      min: 1,
      max: 10,
      apply: "next-operation",
    },
    {
      version: 1,
      key: "delegateRetryBaseMs",
      label: "Delegate retry base delay",
      type: "integer",
      defaultValue: 1_000,
      min: 100,
      max: 30_000,
      step: 100,
      unit: "ms",
      apply: "next-operation",
    },
    {
      version: 1,
      key: "delegateNamingModel",
      label: "Delegate naming model",
      type: "model",
      defaultValue: "",
      description: "Optional background model that assigns short semantic names to delegated agents.",
      apply: "next-session",
    },
    {
      version: 1,
      key: "delegateNamingPrompt",
      label: "Delegate naming instructions",
      type: "prompt",
      defaultValue: { mode: "default", text: "" },
      allowedModes: ["default", "append"],
      maxBytes: 32_768,
      description: "Additional instructions for delegate naming. Output and parser contracts remain fixed.",
      apply: "next-session",
    },
    {
      version: 1,
      key: "mainPrompt",
      label: "Main agent system prompt",
      type: "prompt",
      defaultValue: { mode: "default", text: "" },
      allowedModes: ["default", "append", "replace"],
      maxBytes: 32_768,
      description: "Customize Pi's system prompt. Replace mode overrides SYSTEM.md; APPEND_SYSTEM.md remains additive.",
      apply: "next-session",
    },
  ],
} as const);

export type PylonCoreConfig = {
  version: 1;
  lineEditEnabled: boolean;
  lineEditPriceRatio?: number;
  delegateMaxAttempts?: number;
  delegateRetryBaseMs?: number;
  delegateNamingModel?: string;
  delegateNamingPrompt?: import("./package-settings.ts").PromptPackageSettingValue;
  mainPrompt?: import("./package-settings.ts").PromptPackageSettingValue;
};
export type EffectivePylonCoreConfig = {
  version: 1;
  lineEditEnabled: boolean;
  lineEditPriceRatio: number;
  delegateMaxAttempts: number;
  delegateRetryBaseMs: number;
  delegateNamingModel: string;
  delegateNamingPrompt: import("./package-settings.ts").PromptPackageSettingValue;
  mainPrompt: import("./package-settings.ts").PromptPackageSettingValue;
};
export const defaultConfig = (): PylonCoreConfig => ({ version: 1, lineEditEnabled: true });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pylon-core", "config.json");
const fields = Object.fromEntries(pylonCoreSettings.fields.map(field => [field.key, field]));
export function effectiveConfig(config: PylonCoreConfig): EffectivePylonCoreConfig {
  return {
    version: 1,
    lineEditEnabled: effectivePackageSettingValue(fields.lineEditEnabled, config.lineEditEnabled) as boolean,
    lineEditPriceRatio: effectivePackageSettingValue(fields.lineEditPriceRatio, config.lineEditPriceRatio) as number,
    delegateMaxAttempts: effectivePackageSettingValue(fields.delegateMaxAttempts, config.delegateMaxAttempts) as number,
    delegateRetryBaseMs: effectivePackageSettingValue(fields.delegateRetryBaseMs, config.delegateRetryBaseMs) as number,
    delegateNamingModel: effectivePackageSettingValue(fields.delegateNamingModel, config.delegateNamingModel) as string,
    delegateNamingPrompt: effectivePackageSettingValue(fields.delegateNamingPrompt, config.delegateNamingPrompt) as import("./package-settings.ts").PromptPackageSettingValue,
    mainPrompt: effectivePackageSettingValue(fields.mainPrompt, config.mainPrompt) as import("./package-settings.ts").PromptPackageSettingValue,
  };
}

export async function loadConfig(path = configPath()): Promise<PylonCoreConfig> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
  try {
    const value = JSON.parse(serialized);
    if (value?.version !== 1 || typeof value.lineEditEnabled !== "boolean") throw new Error("invalid config");
    const config: PylonCoreConfig = { version: 1, lineEditEnabled: value.lineEditEnabled };
    for (const field of pylonCoreSettings.fields.slice(1)) {
      if (value[field.key] !== undefined && !validPackageSettingValue(field, value[field.key]))
        throw new Error("invalid config");
      if (value[field.key] !== undefined) (config as any)[field.key] = value[field.key];
    }
    return config;
  } catch (error) {
    try {
      await rename(path, `${path}.corrupt-${randomUUID()}`);
    } catch (quarantineError: any) {
      throw new Error(
        `Could not quarantine invalid pylon-core config: ${quarantineError?.message ?? String(quarantineError)}`,
        { cause: error },
      );
    }
    return defaultConfig();
  }
}

export async function saveConfig(config: PylonCoreConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

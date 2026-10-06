import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { saveJsonConfig } from "./json-config.ts";
import { definePackageSettings, effectivePackageSettings, validPackageSettingValue } from "./package-settings.ts";

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
      key: "codemodeEnabled",
      label: "Web codemode",
      type: "boolean",
      defaultValue: false,
      description: "Opt into bounded native JavaScript batches of active coding/search tools in Pylon Web. Workflow controls remain direct calls; script model APIs are disabled.",
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
      key: "mainAgentModel",
      label: "Default main agent model",
      type: "model",
      defaultValue: "",
      description: "Optional default for new main agent sessions. Existing sessions keep their selected model.",
      apply: "next-session",
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
  codemodeEnabled?: boolean;
  lineEditPriceRatio?: number;
  delegateMaxAttempts?: number;
  delegateRetryBaseMs?: number;
  mainAgentModel?: string;
  delegateNamingModel?: string;
  delegateNamingPrompt?: import("./package-settings.ts").PromptPackageSettingValue;
  mainPrompt?: import("./package-settings.ts").PromptPackageSettingValue;
};
export type EffectivePylonCoreConfig = {
  version: 1;
  lineEditEnabled: boolean;
  codemodeEnabled: boolean;
  lineEditPriceRatio: number;
  delegateMaxAttempts: number;
  delegateRetryBaseMs: number;
  mainAgentModel: string;
  delegateNamingModel: string;
  delegateNamingPrompt: import("./package-settings.ts").PromptPackageSettingValue;
  mainPrompt: import("./package-settings.ts").PromptPackageSettingValue;
};
export const defaultConfig = (): PylonCoreConfig => ({ version: 1, lineEditEnabled: true });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pylon-core", "config.json");
export function effectiveConfig(config: PylonCoreConfig): EffectivePylonCoreConfig {
  return effectivePackageSettings(pylonCoreSettings, config);
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
    if (Number.isSafeInteger(value?.version) && value.version > 1) return defaultConfig();
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

export function saveConfig(config: PylonCoreConfig, path = configPath()): Promise<void> {
  return saveJsonConfig(config, path);
}

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
export const defaultThinkingLevels: ThinkingLevel[] = ["medium", "high"];
export const gruntModes = ["isolated", "direct", "dynamic"] as const;
export type GruntMode = (typeof gruntModes)[number];
export const DEFAULT_GRUNT_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_GRUNT_MAX_TURNS = 40;
export const DEFAULT_GRUNT_MAX_COST_USD = 2;
export const DEFAULT_GRUNT_PARENT_CONTEXT_CHARS = 0;

/** Shared inert definitions consumed by Grunt's runtime and web settings adapter. */
export const gruntSettingFields = {
  timeoutMs: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "timeoutMs",
    label: "Worker timeout",
    type: "integer",
    defaultValue: DEFAULT_GRUNT_TIMEOUT_MS,
    min: 1,
    max: 7_200_000,
    env: "PI_GRUNT_TIMEOUT_MS",
    apply: "next-operation",
  },
  maxTurns: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxTurns",
    label: "Maximum tool-call turns",
    type: "integer",
    defaultValue: DEFAULT_GRUNT_MAX_TURNS,
    min: 1,
    max: 1_000,
    env: "PI_GRUNT_MAX_TURNS",
    apply: "next-operation",
  },
  maxCostUsd: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxCostUsd",
    label: "Maximum worker cost",
    type: "number",
    defaultValue: DEFAULT_GRUNT_MAX_COST_USD,
    min: 0.01,
    max: 100,
    step: 0.01,
    env: "PI_GRUNT_MAX_COST_USD",
    apply: "next-operation",
  },
  parentContextChars: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "parentContextChars",
    label: "Parent context",
    type: "integer",
    defaultValue: DEFAULT_GRUNT_PARENT_CONTEXT_CHARS,
    min: 0,
    max: 12_000,
    env: "PI_GRUNT_PARENT_CONTEXT_CHARS",
    apply: "next-operation",
  },
  prompt: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "prompt",
    label: "System prompt",
    type: "prompt",
    defaultValue: { mode: "default", text: "" },
    allowedModes: ["default", "append", "replace"],
    maxBytes: 32_768,
    apply: "next-operation",
  },
} satisfies Record<string, PackageSettingField>;
export const gruntSettings = definePackageSettings({
  version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  packageId: "pi-grunt",
  fields: Object.values(gruntSettingFields),
});

export type GruntConfig = {
  version: 1;
  model?: string;
  disabled?: boolean;
  mode?: GruntMode;
  thinkingLevels?: ThinkingLevel[];
  timeoutMs?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  parentContextChars?: number;
  prompt?: { mode: "default" | "append" | "replace"; text: string };
};
export const gruntThinkingLevels = (config: GruntConfig): ThinkingLevel[] =>
  config.thinkingLevels ?? defaultThinkingLevels;
export const gruntMode = (config: GruntConfig): GruntMode => config.mode ?? "isolated";
export const isGruntEnabled = (config: GruntConfig): boolean =>
  config.disabled === false || (config.disabled !== true && Boolean(config.model));
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-grunt", "config.json");

export const gruntTimeoutMs = (value?: unknown): number =>
  effectivePackageSettingValue(gruntSettingFields.timeoutMs, value, process.env);
export const gruntMaxTurns = (value?: unknown): number =>
  effectivePackageSettingValue(gruntSettingFields.maxTurns, value, process.env);
export const gruntMaxCostUsd = (value?: unknown): number =>
  effectivePackageSettingValue(gruntSettingFields.maxCostUsd, value, process.env);
export const gruntParentContextChars = (value?: unknown): number =>
  effectivePackageSettingValue(gruntSettingFields.parentContextChars, value, process.env);
export const gruntPrompt = (value?: unknown) => effectivePackageSettingValue(gruntSettingFields.prompt, value);

export async function loadConfig(path = configPath()): Promise<GruntConfig> {
  return loadJsonConfig(
    path,
    value => {
      if (
        value?.version !== 1 ||
        (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) ||
        (value.disabled !== undefined && typeof value.disabled !== "boolean") ||
        (value.mode !== undefined && !gruntModes.includes(value.mode)) ||
        (value.thinkingLevels !== undefined &&
          (!Array.isArray(value.thinkingLevels) ||
            !value.thinkingLevels.length ||
            new Set(value.thinkingLevels).size !== value.thinkingLevels.length ||
            !value.thinkingLevels.every((level: unknown) => thinkingLevels.includes(level as ThinkingLevel)))) ||
        !Object.entries(gruntSettingFields).every(
          ([key, field]) => value[key] === undefined || validPackageSettingValue(field, value[key]),
        )
      )
        return undefined;
      return {
        version: 1,
        ...(value.model ? { model: value.model } : {}),
        ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
        ...(value.mode !== undefined ? { mode: value.mode } : {}),
        ...(value.thinkingLevels !== undefined ? { thinkingLevels: value.thinkingLevels } : {}),
        ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
        ...(value.maxTurns !== undefined ? { maxTurns: value.maxTurns } : {}),
        ...(value.maxCostUsd !== undefined ? { maxCostUsd: value.maxCostUsd } : {}),
        ...(value.parentContextChars !== undefined ? { parentContextChars: value.parentContextChars } : {}),
        ...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
      } satisfies GruntConfig;
    },
    () => ({ version: 1 }),
  );
}

export const saveConfig = (config: GruntConfig, path = configPath()) => saveJsonConfig(config, path);

export async function resetConfig(path = configPath()): Promise<void> {
  await rm(path, { force: true });
}

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash < 1 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

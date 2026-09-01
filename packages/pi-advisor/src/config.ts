import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  definePackageSettings,
  effectivePackageSettingValue,
  validPackageSettingValue,
  type PackageSettingField,
} from "pylon-core/package-settings";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export const ADVISOR_MAX_CALLS = 3;
export const ADVISOR_TIMEOUT_MS = 15 * 60 * 1000;
export const ADVISOR_MAX_COST_USD = 0.5;
export const ADVISOR_MAX_OUTPUT_TOKENS = 8_192;
export const ADVISOR_INPUT_TOKEN_BUDGET = 32_768;

/** Shared inert definitions consumed by Advisor's runtime and web settings adapter. */
export const advisorSettingFields = {
  maxCalls: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxCalls",
    label: "Maximum consultations",
    type: "integer",
    defaultValue: ADVISOR_MAX_CALLS,
    min: 1,
    max: 10,
    env: "PI_ADVISOR_MAX_CALLS",
    apply: "next-operation",
  },
  timeoutMs: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "timeoutMs",
    label: "Consultation timeout",
    type: "integer",
    defaultValue: ADVISOR_TIMEOUT_MS,
    min: 1_000,
    max: 7_200_000,
    env: "PI_ADVISOR_TIMEOUT_MS",
    apply: "next-operation",
  },
  maxCostUsd: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxCostUsd",
    label: "Maximum consultation cost",
    type: "number",
    defaultValue: ADVISOR_MAX_COST_USD,
    min: 0.01,
    max: 100,
    step: 0.01,
    env: "PI_ADVISOR_MAX_COST_USD",
    apply: "next-operation",
  },
  maxOutputTokens: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "maxOutputTokens",
    label: "Maximum output tokens",
    type: "integer",
    defaultValue: ADVISOR_MAX_OUTPUT_TOKENS,
    min: 256,
    max: 65_536,
    env: "PI_ADVISOR_MAX_OUTPUT_TOKENS",
    apply: "next-operation",
  },
  inputTokenBudget: {
    version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
    key: "inputTokenBudget",
    label: "Input context budget",
    type: "integer",
    defaultValue: ADVISOR_INPUT_TOKEN_BUDGET,
    min: 1_000,
    max: 1_000_000,
    env: "PI_ADVISOR_INPUT_TOKEN_BUDGET",
    apply: "next-operation",
  },
} satisfies Record<string, PackageSettingField>;
export const advisorSettings = definePackageSettings({
  version: PACKAGE_SETTINGS_DESCRIPTOR_VERSION,
  packageId: "pi-advisor",
  fields: Object.values(advisorSettingFields),
});

export type AdvisorConfig = {
  version: 1;
  advisorModel?: string;
  thinking?: ThinkingLevel;
  useMainModel?: boolean;
  maxCalls?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
  maxOutputTokens?: number;
  inputTokenBudget?: number;
};
export const advisorMaxCalls = (value?: unknown): number =>
  effectivePackageSettingValue(advisorSettingFields.maxCalls, value, process.env);
export const advisorTimeoutMs = (value?: unknown): number =>
  effectivePackageSettingValue(advisorSettingFields.timeoutMs, value, process.env);
export const advisorMaxCostUsd = (value?: unknown): number =>
  effectivePackageSettingValue(advisorSettingFields.maxCostUsd, value, process.env);
export const advisorMaxOutputTokens = (value?: unknown): number =>
  effectivePackageSettingValue(advisorSettingFields.maxOutputTokens, value, process.env);
export const advisorInputTokenBudget = (value?: unknown): number =>
  effectivePackageSettingValue(advisorSettingFields.inputTokenBudget, value, process.env);

export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-advisor", "config.json");
export async function loadConfig(path = configPath()): Promise<AdvisorConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value?.version !== 1 ||
      (value.advisorModel !== undefined && (typeof value.advisorModel !== "string" || !value.advisorModel.trim())) ||
      (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
      (value.useMainModel !== undefined && typeof value.useMainModel !== "boolean") ||
      !Object.entries(advisorSettingFields).every(
        ([key, field]) => value[key] === undefined || validPackageSettingValue(field, value[key]),
      )
    )
      throw new Error("invalid config");
    return {
      version: 1,
      ...(value.advisorModel ? { advisorModel: value.advisorModel } : {}),
      ...(value.thinking ? { thinking: value.thinking } : {}),
      ...(value.useMainModel ? { useMainModel: true } : {}),
      ...(value.maxCalls !== undefined ? { maxCalls: value.maxCalls } : {}),
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
      ...(value.maxCostUsd !== undefined ? { maxCostUsd: value.maxCostUsd } : {}),
      ...(value.maxOutputTokens !== undefined ? { maxOutputTokens: value.maxOutputTokens } : {}),
      ...(value.inputTokenBudget !== undefined ? { inputTokenBudget: value.inputTokenBudget } : {}),
    } satisfies AdvisorConfig;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1 };
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return { version: 1 };
  }
}
export async function saveConfig(config: AdvisorConfig, path = configPath()): Promise<void> {
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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { definePackageSettings, effectivePackageSettingValue, validPackageSettingValue } from "pylon-core/package-settings";

export const toolAvailabilities = ["deferred", "active"] as const;
export type ToolAvailability = (typeof toolAvailabilities)[number];
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export const spawnSettings = definePackageSettings({
  version: 1,
  packageId: "pi-spawn",
  fields: [
    { version: 1, key: "spawnTimeoutMs", label: "Spawn timeout", type: "integer", defaultValue: 0, min: 0, max: 7_200_000, step: 1_000, unit: "ms", env: "PI_SPAWN_TIMEOUT_MS", apply: "reload" },
    { version: 1, key: "recentThreadLimit", label: "Recent thread message limit", type: "integer", defaultValue: 8, min: 1, max: 50, apply: "reload" },
    { version: 1, key: "recentThreadMaxChars", label: "Recent thread message characters", type: "integer", defaultValue: 800, min: 100, max: 10_000, step: 100, unit: "characters", apply: "reload" },
    { version: 1, key: "recentThreadTotalChars", label: "Recent thread total characters", type: "integer", defaultValue: 12_000, min: 1_000, max: 100_000, step: 1_000, unit: "characters", apply: "reload" },
  ],
} as const);

export type SpawnConfig = { version: 1; agentAvailability: ToolAvailability; sessionAvailability: ToolAvailability; models?: string[]; agentThinkingLevels?: ThinkingLevel[]; spawnTimeoutMs?: number; recentThreadLimit?: number; recentThreadMaxChars?: number; recentThreadTotalChars?: number };
export type EffectiveSpawnConfig = { version: 1; agentAvailability: ToolAvailability; sessionAvailability: ToolAvailability; models?: string[]; agentThinkingLevels: ThinkingLevel[]; spawnTimeoutMs: number; recentThreadLimit: number; recentThreadMaxChars: number; recentThreadTotalChars: number };
export const defaultConfig = (): SpawnConfig => ({ version: 1, agentAvailability: "deferred", sessionAvailability: "deferred" });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-spawn", "config.json");
const fields = Object.fromEntries(spawnSettings.fields.map(field => [field.key, field]));
const validAvailability = (value: unknown): value is ToolAvailability => toolAvailabilities.includes(value as ToolAvailability);
const validModels = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(model => typeof model === "string" && Boolean(model.trim()));
const validThinkingLevels = (value: unknown): value is ThinkingLevel[] => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(level => thinkingLevels.includes(level as ThinkingLevel));

export function effectiveConfig(config: SpawnConfig): EffectiveSpawnConfig {
  const models = config.models;
  return {
    version: 1,
    agentAvailability: config.agentAvailability,
    sessionAvailability: config.sessionAvailability,
    ...(models?.length ? { models: [...models] } : {}),
    agentThinkingLevels: config.agentThinkingLevels ?? [...thinkingLevels],
    spawnTimeoutMs: effectivePackageSettingValue(fields.spawnTimeoutMs, config.spawnTimeoutMs) as number,
    recentThreadLimit: effectivePackageSettingValue(fields.recentThreadLimit, config.recentThreadLimit) as number,
    recentThreadMaxChars: effectivePackageSettingValue(fields.recentThreadMaxChars, config.recentThreadMaxChars) as number,
    recentThreadTotalChars: effectivePackageSettingValue(fields.recentThreadTotalChars, config.recentThreadTotalChars) as number,
  };
}

export async function loadConfig(path = configPath()): Promise<SpawnConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1) throw new Error("invalid config");
    if (value.toolAvailability !== undefined) {
      if (value.agentAvailability !== undefined || value.sessionAvailability !== undefined || !validAvailability(value.toolAvailability)) throw new Error("invalid config");
      return { version: 1, agentAvailability: value.toolAvailability, sessionAvailability: value.toolAvailability };
    }
    if (!validAvailability(value.agentAvailability) || !validAvailability(value.sessionAvailability) || (value.models !== undefined && !validModels(value.models)) || (value.agentThinkingLevels !== undefined && !validThinkingLevels(value.agentThinkingLevels))) throw new Error("invalid config");
    const config: SpawnConfig = { version: 1, agentAvailability: value.agentAvailability, sessionAvailability: value.sessionAvailability, ...(value.models ? { models: value.models } : {}), ...(value.agentThinkingLevels ? { agentThinkingLevels: value.agentThinkingLevels } : {}) };
    for (const field of spawnSettings.fields) {
      if (value[field.key] !== undefined && !validPackageSettingValue(field, value[field.key])) throw new Error("invalid config");
      if (value[field.key] !== undefined) (config as any)[field.key] = value[field.key];
    }
    return config;
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return defaultConfig();
  }
}

export async function saveConfig(config: SpawnConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try { await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

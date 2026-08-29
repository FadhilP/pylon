import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const toolAvailabilities = ["deferred", "active"] as const;
export type ToolAvailability = (typeof toolAvailabilities)[number];
export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type SpawnConfig = {
  version: 1;
  agentAvailability: ToolAvailability;
  sessionAvailability: ToolAvailability;
  models?: string[];
  agentThinkingLevels?: ThinkingLevel[];
};

export const defaultConfig = (): SpawnConfig => ({
  version: 1,
  agentAvailability: "deferred",
  sessionAvailability: "deferred",
});
export const configPath = (agentDir = getAgentDir()) =>
  join(agentDir, "pi-spawn", "config.json");
const validAvailability = (value: unknown): value is ToolAvailability =>
  toolAvailabilities.includes(value as ToolAvailability);
const validModels = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((model) => typeof model === "string" && Boolean(model.trim()));
const validThinkingLevels = (value: unknown): value is ThinkingLevel[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((level) => thinkingLevels.includes(level as ThinkingLevel));

export async function loadConfig(path = configPath()): Promise<SpawnConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1) throw new Error("invalid config");
    if (value.toolAvailability !== undefined) {
      if (
        value.agentAvailability !== undefined ||
        value.sessionAvailability !== undefined ||
        !validAvailability(value.toolAvailability)
      )
        throw new Error("invalid config");
      return {
        version: 1,
        agentAvailability: value.toolAvailability,
        sessionAvailability: value.toolAvailability,
      };
    }
    if (
      !validAvailability(value.agentAvailability) ||
      !validAvailability(value.sessionAvailability) ||
      (value.models !== undefined && !validModels(value.models)) ||
      (value.agentThinkingLevels !== undefined &&
        !validThinkingLevels(value.agentThinkingLevels))
    ) {
      throw new Error("invalid config");
    }
    return {
      version: 1,
      agentAvailability: value.agentAvailability,
      sessionAvailability: value.sessionAvailability,
      ...(value.models ? { models: value.models } : {}),
      ...(value.agentThinkingLevels
        ? { agentThinkingLevels: value.agentThinkingLevels }
        : {}),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return defaultConfig();
  }
}

export async function saveConfig(
  config: SpawnConfig,
  path = configPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

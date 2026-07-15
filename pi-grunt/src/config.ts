import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const thinkingLevels = ["medium", "high"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type GruntConfig = { version: 1; model?: string; disabled?: boolean };
export const isGruntEnabled = (config: GruntConfig): boolean =>
  config.disabled === false || (config.disabled !== true && Boolean(config.model));
export const DEFAULT_GRUNT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_GRUNT_MAX_TURNS = 32;
export const DEFAULT_GRUNT_MAX_COST_USD = 4;
export const DEFAULT_GRUNT_PARENT_CONTEXT_CHARS = 0;
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "pi-grunt", "config.json");

export function gruntTimeoutMs(value = process.env.PI_GRUNT_TIMEOUT_MS): number {
  if (value === undefined) return DEFAULT_GRUNT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 7_200_000)
    throw new Error("PI_GRUNT_TIMEOUT_MS must be an integer between 1 and 7200000");
  return timeout;
}

export function gruntMaxTurns(value = process.env.PI_GRUNT_MAX_TURNS): number {
  if (value === undefined) return DEFAULT_GRUNT_MAX_TURNS;
  const turns = Number(value);
  if (!Number.isInteger(turns) || turns < 1 || turns > 100)
    throw new Error("PI_GRUNT_MAX_TURNS must be an integer between 1 and 100");
  return turns;
}

export function gruntMaxCostUsd(value = process.env.PI_GRUNT_MAX_COST_USD): number {
  if (value === undefined) return DEFAULT_GRUNT_MAX_COST_USD;
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0 || cost > 100)
    throw new Error("PI_GRUNT_MAX_COST_USD must be a number greater than 0 and at most 100");
  return cost;
}

export function gruntParentContextChars(value = process.env.PI_GRUNT_PARENT_CONTEXT_CHARS): number {
  if (value === undefined) return DEFAULT_GRUNT_PARENT_CONTEXT_CHARS;
  const chars = Number(value);
  if (!Number.isInteger(chars) || chars < 0 || chars > 12_000)
    throw new Error("PI_GRUNT_PARENT_CONTEXT_CHARS must be an integer between 0 and 12000");
  return chars;
}

export async function loadConfig(path = configPath()): Promise<GruntConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value?.version !== 1 ||
      (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) ||
      (value.disabled !== undefined && typeof value.disabled !== "boolean")
    ) throw new Error("invalid config");
    return {
      version: 1,
      ...(value.model ? { model: value.model } : {}),
      ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1 };
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return { version: 1 };
  }
}

export async function saveConfig(config: GruntConfig, path = configPath()): Promise<void> {
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

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash < 1 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ScoutConfig = { version: 1; model?: string; thinking?: ThinkingLevel; disabled?: boolean };
export const isScoutEnabled = (config: ScoutConfig): boolean =>
  config.disabled === false || (config.disabled !== true && Boolean(config.model));
export const defaultConfig = (): ScoutConfig => ({ version: 1 });
export const DEFAULT_REPO_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_SCOUT_MAX_COST_USD = 0.5;
export function repoTimeoutMs(value = process.env.PI_SCOUT_TIMEOUT_MS): number {
  if (value === undefined) return DEFAULT_REPO_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 7_200_000)
    throw new Error(
      "PI_SCOUT_TIMEOUT_MS must be an integer between 1 and 7200000",
    );
  return timeout;
}

export function scoutMaxCostUsd(
  value = process.env.PI_SCOUT_MAX_COST_USD,
): number | undefined {
  if (value === undefined) return DEFAULT_SCOUT_MAX_COST_USD;
  const cost = typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(cost) || cost < 0)
    throw new Error("PI_SCOUT_MAX_COST_USD must be a finite number greater than or equal to 0");
  return cost || undefined;
}
export const configPath = (agentDir = getAgentDir()) =>
  join(agentDir, "pi-scout", "config.json");

export async function loadConfig(path = configPath()): Promise<ScoutConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value?.version !== 1 ||
      (value.model !== undefined &&
        (typeof value.model !== "string" || !value.model.trim())) ||
      (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
      (value.disabled !== undefined && typeof value.disabled !== "boolean")
    )
      throw new Error("invalid config");
    return {
      version: 1,
      ...(value.model ? { model: value.model } : {}),
      ...(value.thinking ? { thinking: value.thinking } : {}),
      ...(value.disabled !== undefined ? { disabled: value.disabled } : {}),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return defaultConfig();
  }
}

export async function saveConfig(
  config: ScoutConfig,
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

export async function resetConfig(path = configPath()): Promise<void> {
  await rm(path, { force: true });
}

export function parseModelRef(
  ref: string,
): { provider: string; id: string; thinking?: ThinkingLevel } | undefined {
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

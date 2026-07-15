import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type AdvisorConfig = { version: 1; advisorModel?: string; thinking?: ThinkingLevel; useMainModel?: boolean };
export const configPath = (agentDir = getAgentDir()) =>
  join(agentDir, "pi-advisor", "config.json");
export async function loadConfig(path = configPath()): Promise<AdvisorConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const legacy = value?.version === undefined && value?.schemaVersion === 1;
    if (
      (value?.version !== 1 && !legacy) ||
      (value.advisorModel !== undefined &&
        (typeof value.advisorModel !== "string" || !value.advisorModel.trim())) ||
      (value.thinking !== undefined && !thinkingLevels.includes(value.thinking)) ||
      (value.useMainModel !== undefined && typeof value.useMainModel !== "boolean")
    )
      throw new Error("invalid config");
    const config: AdvisorConfig = {
      version: 1,
      ...(value.advisorModel ? { advisorModel: value.advisorModel } : {}),
      ...(value.thinking ? { thinking: value.thinking } : {}),
      ...(value.useMainModel ? { useMainModel: true } : {}),
    };
    if (legacy) await saveConfig(config, path).catch(() => {});
    return config;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1 };
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return { version: 1 };
  }
}
export async function saveConfig(
  config: AdvisorConfig,
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

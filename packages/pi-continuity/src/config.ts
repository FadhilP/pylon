import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
export type ModelProfile = { model: string; thinking?: ThinkingLevel };
export type ContinuityConfig = {
  version: 1;
  planner?: ModelProfile;
  executor?: ModelProfile;
};

export const defaultConfig = (): ContinuityConfig => ({ version: 1 });
export const configPath = (agentDir = getAgentDir()) =>
  join(agentDir, "pi-continuity", "config.json");

const isProfile = (value: any): value is ModelProfile =>
  Boolean(
    value &&
      typeof value.model === "string" &&
      value.model.trim() &&
      (value.thinking === undefined || thinkingLevels.includes(value.thinking)),
  );

export async function loadConfig(path = configPath()): Promise<ContinuityConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value?.version !== 1 ||
      (value.planner !== undefined && !isProfile(value.planner)) ||
      (value.executor !== undefined && !isProfile(value.executor))
    )
      throw new Error("invalid config");
    return {
      version: 1,
      ...(value.planner ? { planner: value.planner } : {}),
      ...(value.executor ? { executor: value.executor } : {}),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return defaultConfig();
    await rename(path, `${path}.corrupt-${randomUUID()}`).catch(() => {});
    return defaultConfig();
  }
}

export async function saveConfig(
  config: ContinuityConfig,
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

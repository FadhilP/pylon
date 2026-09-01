import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  compactionReviewerMaxOutputTokens,
  compactionReviewTimeoutMs,
  continuityPrompt,
  configPath,
  continuitySettingFields,
  loadConfig,
  updateConfig,
  thinkingLevels,
  validKeepRecentTokens,
  type ModelProfile,
} from "./config.ts";
import { validPackageSettingValue } from "pylon-core/package-settings";
import { withFileLock, writeJsonAtomic } from "./storage.ts";
import { MEMORY_REVIEWER_PROMPT } from "./memory-review.ts";
import { MIGRATION_REVIEWER_PROMPT } from "./memory-migration.ts";

const validReserveTokens = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1_000 && (value as number) <= 1_000_000;
const object = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const piSettingsPath = (agentDir: string) => join(agentDir, "settings.json");
type ReserveState = { value: number; explicit: boolean; compactionPresent: boolean };
async function readPiSettings(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!object(value) || (value.compaction !== undefined && !object(value.compaction)))
      throw new Error("invalid Pi settings");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
function reserveState(settings: Record<string, any>): ReserveState {
  const explicit = settings.compaction?.reserveTokens !== undefined;
  const value = explicit ? settings.compaction.reserveTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  if (!validReserveTokens(value)) throw new Error("invalid Pi compaction reserve");
  return { value, explicit, compactionPresent: settings.compaction !== undefined };
}
async function readReserveState(agentDir: string): Promise<ReserveState> {
  return reserveState(await readPiSettings(piSettingsPath(agentDir)));
}
async function updateReserveState(agentDir: string, next: ReserveState, expected: ReserveState): Promise<void> {
  const path = piSettingsPath(agentDir);
  await withFileLock(path, async () => {
    const settings = await readPiSettings(path);
    const current = reserveState(settings);
    if (
      current.value !== expected.value ||
      current.explicit !== expected.explicit ||
      current.compactionPresent !== expected.compactionPresent
    )
      throw new Error("Pi compaction settings changed; reload and try again");
    if (
      current.value === next.value &&
      current.explicit === next.explicit &&
      current.compactionPresent === next.compactionPresent
    )
      return;
    const updated = { ...settings };
    const compaction = { ...settings.compaction };
    if (next.explicit) compaction.reserveTokens = next.value;
    else delete compaction.reserveTokens;
    if (!next.compactionPresent && !Object.keys(compaction).length) delete updated.compaction;
    else updated.compaction = compaction;
    await writeJsonAtomic(path, updated);
  });
}

function profile(value: any): ModelProfile | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value?.model !== "string" ||
    !value.model.trim() ||
    (value.thinking !== undefined && !thinkingLevels.includes(value.thinking))
  ) {
    throw new Error("invalid Continuity model profile");
  }
  return { model: value.model.trim(), ...(value.thinking ? { thinking: value.thinking } : {}) };
}

export async function readSettings({ agentDir }: { agentDir: string }) {
  const config = await loadConfig(configPath(agentDir));
  return {
    kind: "continuity",
    memoryEnabled: config.memoryEnabled !== false,
    reserveTokens: (await readReserveState(agentDir)).value,
    keepRecentTokens: config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    compactionReviewTimeoutMs: compactionReviewTimeoutMs(config.compactionReviewTimeoutMs),
    compactionReviewerMaxOutputTokens: compactionReviewerMaxOutputTokens(config.compactionReviewerMaxOutputTokens),
    prompt: config.prompt ?? { mode: "default", text: "" },
    promptDefaultText: `Memory review:\n${MEMORY_REVIEWER_PROMPT}\n\nMemory migration:\n${MIGRATION_REVIEWER_PROMPT}`,
    ...(config.planner ? { planner: config.planner } : {}),
    ...(config.executor ? { executor: config.executor } : {}),
    ...(config.memoryReviewer ? { memoryReviewer: config.memoryReviewer } : {}),
    ...(config.compactionReviewer ? { compactionReviewer: config.compactionReviewer } : {}),
  };
}

export async function updateSettings(value: any, { agentDir }: { agentDir: string }): Promise<void> {
  if (
    value?.kind !== "continuity" ||
    typeof value.memoryEnabled !== "boolean" ||
    !validReserveTokens(value.reserveTokens) ||
    !validKeepRecentTokens(value.keepRecentTokens) ||
    !Object.entries(continuitySettingFields).every(([key, field]) => validPackageSettingValue(field, value[key]))
  )
    throw new Error("invalid Continuity settings");
  const planner = profile(value.planner);
  const executor = profile(value.executor);
  const memoryReviewer = profile(value.memoryReviewer);
  const compactionReviewer = profile(value.compactionReviewer);
  const previousReserve = await readReserveState(agentDir);
  const updatedReserve = { value: value.reserveTokens, explicit: true, compactionPresent: true };
  await updateReserveState(agentDir, updatedReserve, previousReserve);
  try {
    await updateConfig(
      () => ({
        version: 2,
        memoryEnabled: value.memoryEnabled,
        keepRecentTokens: value.keepRecentTokens,
        ...(planner ? { planner } : {}),
        ...(executor ? { executor } : {}),
        ...(memoryReviewer ? { memoryReviewer } : {}),
        ...(compactionReviewer ? { compactionReviewer } : {}),
        compactionReviewTimeoutMs: value.compactionReviewTimeoutMs,
        compactionReviewerMaxOutputTokens: value.compactionReviewerMaxOutputTokens,
        prompt: value.prompt,
      }),
      configPath(agentDir),
    );
  } catch (error) {
    await updateReserveState(agentDir, previousReserve, updatedReserve).catch(() => undefined);
    throw error;
  }
}

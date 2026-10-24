import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
  type ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { withDirectoryLock, writeBytesAtomic } from "pylon-core/file-lock";
import type { ModelCompactionInput } from "../../shared/protocol/commands.ts";
import type { ModelOptionReadModel, SessionMetricsReadModel } from "../../shared/protocol/events.ts";

const object = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const validReserve = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function contextUsageMetrics(
  usage: ContextUsage | undefined,
  compaction: { enabled: boolean; reserveTokens: number },
): Pick<SessionMetricsReadModel, "contextTokens" | "contextLimit" | "contextBudget" | "contextPercent"> {
  const tokens = usage?.tokens ?? 0;
  const window = usage?.contextWindow ?? 0;
  const contextTokens = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  const contextLimit = Number.isFinite(window) ? Math.max(0, window) : 0;
  const trigger = contextLimit - compaction.reserveTokens;
  const useTrigger = compaction.enabled && trigger > 0 && trigger <= contextLimit;
  const contextBudget = useTrigger ? trigger : contextLimit;
  return {
    contextTokens,
    contextLimit,
    contextBudget,
    contextPercent: contextBudget > 0 ? (contextTokens / contextBudget) * 100 : 0,
  };
}

export function modelCompactionSettings(
  model: { provider: string; id: string; contextWindow: number },
  global: CompactionSettings | undefined,
  effective: CompactionSettings | undefined,
): ModelOptionReadModel["compaction"] {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return undefined;
  const key = `${model.provider}/${model.id}`;
  const globalEntry = global?.modelOverrides?.[key];
  const effectiveEntry = effective?.modelOverrides?.[key];
  if (globalEntry !== undefined && !object(globalEntry)) return undefined;
  if (effectiveEntry !== undefined && !object(effectiveEntry)) return undefined;
  const reserveTokens = globalEntry?.reserveTokens === undefined ? null : globalEntry.reserveTokens;
  const defaultReserve =
    global?.reserveTokens === undefined ? DEFAULT_COMPACTION_SETTINGS.reserveTokens : global.reserveTokens;
  const ordinaryReserve =
    effective?.reserveTokens === undefined ? DEFAULT_COMPACTION_SETTINGS.reserveTokens : effective.reserveTokens;
  const effectiveReserveTokens =
    effectiveEntry?.reserveTokens === undefined ? ordinaryReserve : effectiveEntry.reserveTokens;
  if (reserveTokens !== null && !validReserve(reserveTokens)) return undefined;
  if (!validReserve(defaultReserve) || !validReserve(ordinaryReserve) || !validReserve(effectiveReserveTokens))
    return undefined;
  return {
    reserveTokens,
    triggerTokens: model.contextWindow - (reserveTokens ?? defaultReserve),
    defaultTriggerTokens: model.contextWindow - defaultReserve,
    effectiveTriggerTokens: model.contextWindow - effectiveReserveTokens,
  };
}

export async function updateModelCompaction(
  agentDir: string,
  contextWindow: number,
  input: ModelCompactionInput,
): Promise<void> {
  const path = join(agentDir, "settings.json");
  await withDirectoryLock(
    path,
    async () => {
      let settings: Record<string, any>;
      try {
        settings = JSON.parse(await readFile(path, "utf8"));
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        settings = {};
      }
      if (!object(settings)) throw new Error("invalid Pi settings");
      if (settings.compaction !== undefined && !object(settings.compaction))
        throw new Error("invalid Pi compaction settings");
      const compaction = { ...settings.compaction };
      if (compaction.modelOverrides !== undefined && !object(compaction.modelOverrides))
        throw new Error("invalid Pi compaction model overrides");
      const overrides = { ...compaction.modelOverrides };
      const key = `${input.provider}/${input.modelId}`;
      if (overrides[key] !== undefined && !object(overrides[key]))
        throw new Error("invalid Pi model compaction settings");
      const entry = { ...overrides[key] };
      const current = entry.reserveTokens === undefined ? null : entry.reserveTokens;
      if (entry.reserveTokens !== undefined && !validReserve(current))
        throw new Error("invalid Pi model compaction reserve");
      if (current !== input.expectedReserveTokens)
        throw new Error("Model compaction settings changed; reload and try again");
      if (input.compactAtTokens === null) {
        delete entry.reserveTokens;
      } else {
        const defaultReserve =
          compaction.reserveTokens === undefined ? DEFAULT_COMPACTION_SETTINGS.reserveTokens : compaction.reserveTokens;
        if (!validReserve(defaultReserve)) throw new Error("invalid Pi compaction reserve");
        if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
          throw new Error("model context window is unavailable");
        if (
          !Number.isSafeInteger(input.compactAtTokens) ||
          input.compactAtTokens <= 0 ||
          input.compactAtTokens > contextWindow - defaultReserve
        )
          throw new Error("Compaction trigger must be a positive whole token count no later than the default trigger");
        // shortcut: catalog capacity changes move the trigger; use a native trigger setting when Pi supports one.
        entry.reserveTokens = contextWindow - input.compactAtTokens;
      }
      if (Object.keys(entry).length) overrides[key] = entry;
      else delete overrides[key];
      if (Object.keys(overrides).length) compaction.modelOverrides = overrides;
      else delete compaction.modelOverrides;
      if (Object.keys(compaction).length) settings.compaction = compaction;
      else delete settings.compaction;
      await writeBytesAtomic(path, JSON.stringify(settings, null, 2) + "\n");
    },
    { name: "Pi compaction settings" },
  );
}

import type { ModelOptionReadModel, ThinkingLevelReadModel } from "./protocol/events.ts";

export const THINKING_LEVEL_ORDER: readonly ThinkingLevelReadModel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportedLevels(model: ModelOptionReadModel): ThinkingLevelReadModel[] {
  const supported = new Set(model.thinkingLevels?.length ? model.thinkingLevels : ["off"]);
  return THINKING_LEVEL_ORDER.filter((level) => supported.has(level));
}

export function matrixThinkingAxis(models: ModelOptionReadModel[]): ThinkingLevelReadModel[] {
  const supported = new Set(models.flatMap((model) => supportedLevels(model)));
  const axis = THINKING_LEVEL_ORDER.filter((level) => supported.has(level));
  return axis.length ? axis : ["off"];
}

export function nearestModelThinkingLevel(
  model: ModelOptionReadModel,
  axis: ThinkingLevelReadModel[],
  targetIndex: number,
): ThinkingLevelReadModel {
  const available = supportedLevels(model);
  let nearest = available[0] ?? "off";
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const level of available) {
    const index = axis.indexOf(level);
    if (index < 0) continue;
    const distance = Math.abs(index - targetIndex);
    if (distance < nearestDistance) {
      nearest = level;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function matrixSelectionAtPoint(
  models: ModelOptionReadModel[],
  axis: ThinkingLevelReadModel[],
  xRatio: number,
  yRatio: number,
): { modelIndex: number; model: ModelOptionReadModel; level: ThinkingLevelReadModel } | undefined {
  if (!models.length || !axis.length) return undefined;
  const x = Math.max(0, Math.min(1, xRatio));
  const y = Math.max(0, Math.min(1, yRatio));
  const modelIndex = Math.min(models.length - 1, Math.floor(y * models.length));
  const targetIndex = Math.round(x * (axis.length - 1));
  const model = models[modelIndex];
  return { modelIndex, model, level: nearestModelThinkingLevel(model, axis, targetIndex) };
}

export function moveMatrixSelection(
  models: ModelOptionReadModel[],
  axis: ThinkingLevelReadModel[],
  modelIndex: number,
  level: ThinkingLevelReadModel,
  modelOffset: number,
  levelOffset: number,
): { modelIndex: number; model: ModelOptionReadModel; level: ThinkingLevelReadModel } | undefined {
  if (!models.length || !axis.length) return undefined;
  const nextModelIndex = Math.max(0, Math.min(models.length - 1, modelIndex + modelOffset));
  const model = models[nextModelIndex];
  if (modelOffset) {
    const targetIndex = Math.max(0, axis.indexOf(level));
    return { modelIndex: nextModelIndex, model, level: nearestModelThinkingLevel(model, axis, targetIndex) };
  }
  const available = supportedLevels(model);
  const currentIndex = Math.max(0, available.indexOf(level));
  const nextLevelIndex = Math.max(0, Math.min(available.length - 1, currentIndex + levelOffset));
  return { modelIndex: nextModelIndex, model, level: available[nextLevelIndex] ?? "off" };
}

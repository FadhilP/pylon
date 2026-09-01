import type { ModelOptionReadModel } from "./protocol/events.ts";

export function modelKey(model: Pick<ModelOptionReadModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function visibleModels(models: ModelOptionReadModel[], hidden: Set<string>): ModelOptionReadModel[] {
  return models.filter(model => !hidden.has(modelKey(model)));
}

/** Keeps hidden models out of selectors while retaining an existing selection so it can be changed or cleared. */
export function selectableModels(
  models: ModelOptionReadModel[],
  hidden: Set<string>,
  selectedKeys: readonly string[] = [],
): ModelOptionReadModel[] {
  const selected = new Set(selectedKeys);
  return models.filter(model => !hidden.has(modelKey(model)) || selected.has(modelKey(model)));
}

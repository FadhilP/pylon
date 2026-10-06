export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

type ModelLike = { provider: string; id: string };

export const modelName = (model: ModelLike) => `${model.provider}/${model.id}`;

/** Parses `provider/model`; everything after the first slash is the model id. */
export function parseModelRef(ref: string): ModelLike | undefined {
  const slash = ref.indexOf("/");
  if (slash < 1 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Parses `provider/model[:thinking]`; an unknown suffix stays part of the model id. */
export function parseThinkingModelRef(ref: string): (ModelLike & { thinking?: ThinkingLevel }) | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed) return undefined;
  const colon = parsed.id.lastIndexOf(":");
  const suffix = parsed.id.slice(colon + 1) as ThinkingLevel;
  if (colon < 0 || !thinkingLevels.includes(suffix)) return parsed;
  return { ...parsed, id: parsed.id.slice(0, colon), thinking: suffix };
}

/** Names offered by a model picker: the session's scoped models, else every available model. */
export function selectableModelNames(ctx: any): string[] {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }: { model: ModelLike }) => model)
    : ctx.modelRegistry.getAvailable();
  return models.map(modelName);
}

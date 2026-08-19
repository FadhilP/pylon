export interface ComposerDraft {
  sessionId: string;
  projectId: string;
  text: string;
  updatedAt: number;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem">;

export const COMPOSER_DRAFTS_KEY = "pylon-composer-drafts-v1";

export function readComposerDrafts(storage: DraftStorage): Map<string, ComposerDraft> {
  try {
    const value: unknown = JSON.parse(storage.getItem(COMPOSER_DRAFTS_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Map();
    const drafts = value.filter((item): item is ComposerDraft => Boolean(item)
      && typeof item === "object"
      && typeof item.sessionId === "string"
      && Boolean(item.sessionId)
      && typeof item.projectId === "string"
      && typeof item.text === "string"
      && Boolean(item.text)
      && typeof item.updatedAt === "number"
      && Number.isFinite(item.updatedAt));
    return new Map(drafts.map((draft) => [draft.sessionId, draft]));
  } catch {
    return new Map();
  }
}

export function writeComposerDrafts(storage: DraftStorage, drafts: Map<string, ComposerDraft>): void {
  storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify([...drafts.values()]));
}

export function latestProjectDraft(drafts: Map<string, ComposerDraft>, projectId: string): ComposerDraft | undefined {
  return [...drafts.values()]
    .filter((draft) => draft.projectId === projectId && Boolean(draft.text.trim()))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

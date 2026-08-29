import { useSyncExternalStore } from "react";
import type { ModelOptionReadModel } from "../shared/protocol/events";

const STORAGE_KEY = "pylon-hidden-models";

export function modelKey(model: Pick<ModelOptionReadModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function readHiddenModels(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

let hiddenModelKeys = readHiddenModels();
const listeners = new Set<() => void>();

export function setHiddenModelVisible(key: string, visible: boolean): void {
  const next = new Set(hiddenModelKeys);
  if (visible) next.delete(key);
  else next.add(key);
  hiddenModelKeys = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHiddenModels(): Set<string> {
  return useSyncExternalStore(subscribe, () => hiddenModelKeys);
}

export function visibleModels(models: ModelOptionReadModel[], hidden: Set<string>): ModelOptionReadModel[] {
  return models.filter(model => !hidden.has(modelKey(model)));
}

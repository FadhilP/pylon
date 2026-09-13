import { useSyncExternalStore } from "react";
import { runtimeStore } from "../runtime/event-store";
import { modelKey } from "./model-options.ts";
export { modelKey, selectableModels, visibleModels } from "./model-options.ts";

const STORAGE_KEY = "pylon-hidden-models";
function readFallback(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const values: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(values)
        ? values.filter(
            (value): value is string => typeof value === "string" && value.includes("/") && value.length <= 512,
          )
        : [],
    );
  } catch {
    return new Set();
  }
}
let fallback = readFallback();
let cachedRevision = -1;
let cached = fallback;
const listeners = new Set<() => void>();
function current(): Set<string> {
  const preferences = runtimeStore.getSnapshot().hostPreferences;
  if (!preferences) return fallback;
  if (preferences.revision !== cachedRevision) {
    cachedRevision = preferences.revision;
    cached = new Set(preferences.hiddenModels.map(model => modelKey(model)));
  }
  return cached;
}
export function setHiddenModelVisible(key: string, visible: boolean): void {
  const next = new Set(current());
  if (visible) next.delete(key);
  else next.add(key);
  const preferences = runtimeStore.getSnapshot().hostPreferences;
  if (!preferences) {
    fallback = next;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      /* The in-memory choice still applies until host preferences load. */
    }
    listeners.forEach(listener => listener());
    return;
  }
  const hiddenModels = [...next].flatMap(value => {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) return [];
    return [{ provider: value.slice(0, slash), id: value.slice(slash + 1) }];
  });
  void runtimeStore.patchHostPreferences({ hiddenModels }).catch(() => undefined);
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = runtimeStore.subscribe(listener);
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}
export function useHiddenModels(): Set<string> {
  return useSyncExternalStore(subscribe, current, current);
}

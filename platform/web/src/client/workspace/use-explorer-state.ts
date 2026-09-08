import { useSyncExternalStore } from "react";
import {
  applyExplorerChange,
  DEFAULT_EXPLORER_STATE,
  readExplorerStates,
  writeExplorerStates,
  type ExplorerState,
} from "./explorer-state.ts";

/**
 * Where the tree files its state before the project is known — the session list
 * arrives after the first paint, so without this a folder clicked in the interim
 * would go nowhere. Held in memory only, never written to storage.
 */
const UNFILED = "\u0000unfiled";

/**
 * The file tree's open folders and change filter, kept per project rather than
 * per session: a new session in a project opens exactly as the last one left it.
 *
 * Both the inspector's Changes panel and the workspace explorer read this, so
 * they stay in step while they are mounted at once.
 */
let states = load();
const listeners = new Set<() => void>();

function load(): Map<string, ExplorerState> {
  try {
    return readExplorerStates(localStorage);
  } catch {
    return new Map();
  }
}

function update(projectId: string | undefined, change: Partial<ExplorerState>): void {
  states = applyExplorerChange(states, projectId || UNFILED, change);
  if (projectId) {
    const persisted = new Map(states);
    persisted.delete(UNFILED);
    try {
      writeExplorerStates(localStorage, persisted);
    } catch {
      /* The tree still behaves for the current page when storage is unavailable or full. */
    }
  }
  listeners.forEach(listener => listener());
}

export function revealExplorerPath(projectId: string | undefined, path: string): void {
  const current = (projectId && states.get(projectId)) || states.get(UNFILED) || DEFAULT_EXPLORER_STATE;
  const parts = path.split("/").slice(0, -1);
  update(projectId, { open: [...new Set([...current.open, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))])] });
}

export function reconcileExplorerPaths(projectId: string | undefined, path: string, destination?: string): void {
  const current = (projectId && states.get(projectId)) || states.get(UNFILED) || DEFAULT_EXPLORER_STATE;
  const affected = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  update(projectId, { open: current.open.flatMap(candidate =>
    affected(candidate) ? destination ? [destination + candidate.slice(path.length)] : [] : [candidate]) });
}

export function setExplorerOpen(projectId: string | undefined, open: Set<string>): void {
  update(projectId, { open: [...open] });
}

export function setExplorerChangesOnly(projectId: string | undefined, changesOnly: boolean): void {
  update(projectId, { changesOnly });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExplorerState(projectId?: string): ExplorerState {
  const all = useSyncExternalStore(subscribe, () => states);
  // A project with nothing stored inherits whatever was done before it resolved,
  // so folders opened during load are not thrown away when the session list lands.
  return (projectId && all.get(projectId)) || all.get(UNFILED) || DEFAULT_EXPLORER_STATE;
}

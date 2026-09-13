import { useEffect, useSyncExternalStore } from "react";
import { applyExplorerChange, DEFAULT_EXPLORER_STATE, type ExplorerState } from "./explorer-state.ts";
import { runtimeStore } from "../runtime/event-store";
import { ApiHttpError } from "../runtime/api-client";
import { isExplorerWebStateEvent } from "../../shared/settings/web-state";

const UNFILED = "\u0000unfiled";
let states = new Map<string, ExplorerState>();
const revisions = new Map<string, number>();
const changes = new Map<string, number>();
const dirty = new Set<string>();
const loaded = new Set<string>();
const timers = new Map<string, number>();
const writing = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function applyServer(value: unknown, preserveDirty = true): void {
  if (!isExplorerWebStateEvent(value) || (preserveDirty && dirty.has(value.projectId))) return;
  const currentRevision = revisions.get(value.projectId) ?? -1;
  if (!value.state) {
    revisions.delete(value.projectId);
    if (states.has(value.projectId)) {
      const next = new Map(states);
      next.delete(value.projectId);
      states = next;
      emit();
    }
    return;
  }
  if (value.state.revision <= currentRevision) return;
  revisions.set(value.projectId, value.state.revision);
  const next = new Map(states);
  next.set(value.projectId, { open: value.state.open, changesOnly: value.state.changesOnly });
  states = next;
  emit();
}
runtimeStore.subscribeWebState("explorer", applyServer);

async function load(projectId: string): Promise<void> {
  if (loaded.has(projectId)) return;
  loaded.add(projectId);
  try {
    const response = await runtimeStore.explorerState(projectId);
    if (response.state) applyServer(response);
    else if (!dirty.has(projectId)) revisions.set(projectId, -1);
  } catch {
    loaded.delete(projectId);
  }
}

function schedule(projectId: string): void {
  const timer = timers.get(projectId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.set(
    projectId,
    window.setTimeout(() => {
      timers.delete(projectId);
      void flush(projectId);
    }, 300),
  );
}

async function flush(projectId: string): Promise<void> {
  if (writing.has(projectId)) return;
  const state = states.get(projectId) ?? DEFAULT_EXPLORER_STATE;
  const change = changes.get(projectId) ?? 0;
  const revision = revisions.get(projectId);
  writing.add(projectId);
  try {
    const response = await runtimeStore.saveExplorerState(revision === undefined || revision < 0 ? null : revision, {
      projectId,
      ...state,
    });
    if (response.state) revisions.set(projectId, response.state.revision);
    else revisions.set(projectId, -1);
    if ((changes.get(projectId) ?? 0) === change) {
      dirty.delete(projectId);
      applyServer(response, false);
    }
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 409) {
      const response = await runtimeStore.explorerState(projectId).catch(() => undefined);
      if (response) {
        const unchanged = (changes.get(projectId) ?? 0) === change;
        if (unchanged) {
          dirty.delete(projectId);
          applyServer(response, false);
        } else if (response.state) revisions.set(projectId, response.state.revision);
        else revisions.set(projectId, -1);
      }
    }
  } finally {
    writing.delete(projectId);
    if (dirty.has(projectId) && (changes.get(projectId) ?? 0) !== change) schedule(projectId);
  }
}

function update(projectId: string | undefined, change: Partial<ExplorerState>): void {
  const id = projectId || UNFILED;
  states = applyExplorerChange(states, id, change);
  emit();
  if (projectId) {
    changes.set(projectId, (changes.get(projectId) ?? 0) + 1);
    dirty.add(projectId);
    schedule(projectId);
  }
}

export function revealExplorerPath(projectId: string | undefined, path: string): void {
  const current = (projectId && states.get(projectId)) || states.get(UNFILED) || DEFAULT_EXPLORER_STATE;
  const parts = path.split("/").slice(0, -1);
  update(projectId, {
    open: [...new Set([...current.open, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))])],
  });
}

export function reconcileExplorerPaths(projectId: string | undefined, path: string, destination?: string): void {
  const current = (projectId && states.get(projectId)) || states.get(UNFILED) || DEFAULT_EXPLORER_STATE;
  const affected = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  update(projectId, {
    open: current.open.flatMap(candidate =>
      affected(candidate) ? (destination ? [destination + candidate.slice(path.length)] : []) : [candidate],
    ),
  });
}

export function setExplorerOpen(projectId: string | undefined, open: Set<string>): void {
  update(projectId, { open: [...open] });
}
export function setExplorerChangesOnly(projectId: string | undefined, changesOnly: boolean): void {
  update(projectId, { changesOnly });
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useExplorerState(projectId?: string): ExplorerState {
  const all = useSyncExternalStore(subscribe, () => states, () => states);
  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId]);
  return (projectId && all.get(projectId)) || all.get(UNFILED) || DEFAULT_EXPLORER_STATE;
}

import type { WorkspaceSearchQuery } from "../../shared/workspace/workspace-search.ts";
import type { FileReference } from "./file-reference.ts";

export type FileWorkspaceRequest = FileReference & {
  requestId: number;
  sessionId?: string;
  view?: FileWorkspaceView;
  searchQuery?: WorkspaceSearchQuery;
};

export type FileWorkspaceView = "current" | "base" | "diff";

export interface FileWorkspaceState {
  sessionId: string;
  query: string;
  openPaths: string[];
  /** Paths opened as diffs from the change filter; closed automatically when leaving the session. */
  changedPaths: string[];
  views: Record<string, FileWorkspaceView>;
  selectedPath?: string;
  selectedLine?: number;
  view: FileWorkspaceView;
  /** Submitted project-search context for the selected working-copy file only. */
  searchQuery?: WorkspaceSearchQuery;
  requestedPathId?: number;
}

export function workspaceStateForSession(
  states: Map<string, FileWorkspaceState>,
  sessionId: string,
): FileWorkspaceState {
  return states.get(sessionId) ?? { sessionId, query: "", openPaths: [], changedPaths: [], views: {}, view: "current" };
}

/** Navigation requests are consumed once per surface/session, not replayed on every remount. */
export function openRequestedFile(state: FileWorkspaceState, request?: FileWorkspaceRequest): FileWorkspaceState {
  if (!request || !state.sessionId || (request.sessionId && request.sessionId !== state.sessionId) ||
    state.requestedPathId === request.requestId) return state;
  return { ...openFileTab(state, request.path, request.view ?? "current", request.line, false, request.searchQuery), requestedPathId: request.requestId };
}

export function openFileTab(
  state: FileWorkspaceState,
  path: string,
  view: FileWorkspaceView = "current",
  selectedLine?: number,
  fromChanges = false,
  searchQuery?: WorkspaceSearchQuery,
): FileWorkspaceState {
  return {
    ...state,
    openPaths: state.openPaths.includes(path) ? state.openPaths : [...state.openPaths, path],
    changedPaths: fromChanges
      ? [...new Set([...state.changedPaths, path])]
      : view === "current" ? state.changedPaths.filter(candidate => candidate !== path) : state.changedPaths,
    views: { ...state.views, [path]: view },
    selectedPath: path,
    selectedLine,
    view,
    searchQuery,
  };
}

export function selectFileTab(state: FileWorkspaceState, path: string): FileWorkspaceState {
  return { ...state, selectedPath: path, selectedLine: undefined, view: state.views[path] ?? "current", searchQuery: undefined };
}

export function setFileTabView(state: FileWorkspaceState, path: string, view: FileWorkspaceView): FileWorkspaceState {
  return { ...state, views: { ...state.views, [path]: view }, view, searchQuery: view === "current" ? state.searchQuery : undefined };
}

export function closeFileTab(state: FileWorkspaceState, path: string): FileWorkspaceState {
  const index = state.openPaths.indexOf(path);
  const openPaths = state.openPaths.filter(candidate => candidate !== path);
  const views = { ...state.views };
  delete views[path];
  const selectedPath =
    state.selectedPath === path ? openPaths[Math.max(0, Math.min(index, openPaths.length - 1))] : state.selectedPath;
  return {
    ...state,
    openPaths,
    changedPaths: state.changedPaths.filter(candidate => candidate !== path),
    views,
    selectedPath,
    selectedLine: undefined,
    searchQuery: undefined,
    view: selectedPath ? (views[selectedPath] ?? "current") : "current",
  };
}

/** Closes every tab that was opened from the Changes tab, keeping regular file tabs open. */
export function closeChangedFileTabs(state: FileWorkspaceState): FileWorkspaceState {
  return state.changedPaths.reduce(closeFileTab, state);
}

/** Reconcile every descendant tab after a filesystem rename/move or deletion. */
export function reconcileFileTabs(state: FileWorkspaceState, path: string, destination?: string): FileWorkspaceState {
  const affected = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  if (!destination) return state.openPaths.filter(affected).reduce(closeFileTab, state);
  const moved = (candidate: string) => affected(candidate) ? destination + candidate.slice(path.length) : candidate;
  return {
    ...state,
    openPaths: [...new Set(state.openPaths.map(moved))],
    changedPaths: [...new Set(state.changedPaths.map(moved))],
    views: Object.fromEntries(Object.entries(state.views).map(([key, view]) => [moved(key), view])),
    selectedPath: state.selectedPath ? moved(state.selectedPath) : undefined,
    searchQuery: undefined,
  };
}

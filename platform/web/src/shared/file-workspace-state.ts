export type FileWorkspaceView = "current" | "base" | "diff";

export interface FileWorkspaceState {
  sessionId: string;
  tab: "changes" | "files";
  query: string;
  openPaths: string[];
  /** Paths opened from the Changes tab; closed automatically when leaving the session. */
  changedPaths: string[];
  views: Record<string, FileWorkspaceView>;
  selectedPath?: string;
  selectedLine?: number;
  view: FileWorkspaceView;
}

export function workspaceStateForSession(
  states: Map<string, FileWorkspaceState>,
  sessionId: string,
): FileWorkspaceState {
  return (
    states.get(sessionId) ?? {
      sessionId,
      tab: "files",
      query: "",
      openPaths: [],
      changedPaths: [],
      views: {},
      view: "current",
    }
  );
}

export function openFileTab(
  state: FileWorkspaceState,
  path: string,
  view: FileWorkspaceView,
  selectedLine?: number,
  fromChanges = false,
): FileWorkspaceState {
  return {
    ...state,
    openPaths: state.openPaths.includes(path) ? state.openPaths : [...state.openPaths, path],
    changedPaths:
      fromChanges && !state.changedPaths.includes(path) ? [...state.changedPaths, path] : state.changedPaths,
    views: { ...state.views, [path]: view },
    selectedPath: path,
    selectedLine,
    view,
  };
}

export function selectFileTab(state: FileWorkspaceState, path: string): FileWorkspaceState {
  return { ...state, selectedPath: path, selectedLine: undefined, view: state.views[path] ?? "current" };
}

export function setFileTabView(state: FileWorkspaceState, path: string, view: FileWorkspaceView): FileWorkspaceState {
  return { ...state, views: { ...state.views, [path]: view }, view };
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
    view: selectedPath ? (views[selectedPath] ?? "current") : "current",
  };
}

/** Closes every tab that was opened from the Changes tab, keeping regular file tabs open. */
export function closeChangedFileTabs(state: FileWorkspaceState): FileWorkspaceState {
  return state.changedPaths.reduce(closeFileTab, state);
}

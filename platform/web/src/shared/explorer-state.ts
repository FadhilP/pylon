/** How one project's file tree was left: which folders are open, and whether the
    footer's "N changed" filter is on. Shared by every session in that project. */
export interface ExplorerState {
  open: string[];
  changesOnly: boolean;
}

type ExplorerStorage = Pick<Storage, "getItem" | "setItem">;

export const EXPLORER_STATE_KEY = "pylon-explorer-state-v1";
export const DEFAULT_EXPLORER_STATE: ExplorerState = { open: [], changesOnly: false };

export function readExplorerStates(storage: ExplorerStorage): Map<string, ExplorerState> {
  try {
    const value: unknown = JSON.parse(storage.getItem(EXPLORER_STATE_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Map();
    const entries = value.filter(
      (item): item is ExplorerState & { projectId: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.projectId === "string" &&
        Boolean(item.projectId) &&
        Array.isArray(item.open) &&
        item.open.every((path: unknown) => typeof path === "string") &&
        typeof item.changesOnly === "boolean",
    );
    return new Map(entries.map(entry => [entry.projectId, { open: entry.open, changesOnly: entry.changesOnly }]));
  } catch {
    return new Map();
  }
}

export function writeExplorerStates(storage: ExplorerStorage, states: Map<string, ExplorerState>): void {
  storage.setItem(
    EXPLORER_STATE_KEY,
    JSON.stringify([...states].map(([projectId, state]) => ({ projectId, ...state }))),
  );
}

/**
 * The tree's state after one change, as a new map. Kept pure and separate from
 * storage because responsiveness must not depend on persistence: a change with
 * no project still has to land somewhere, or the tree stops responding.
 */
export function applyExplorerChange(
  states: Map<string, ExplorerState>,
  projectId: string,
  change: Partial<ExplorerState>,
): Map<string, ExplorerState> {
  const next = new Map(states);
  next.set(projectId, { ...(states.get(projectId) ?? DEFAULT_EXPLORER_STATE), ...change });
  return next;
}

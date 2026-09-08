import type { WorkspaceFileReadModel } from "../../shared/protocol/snapshots.ts";
import { pathWithin, validWorkspacePath, type WorkspaceEntry, type WorkspaceMutation } from "../../shared/workspace/workspace-mutations.ts";
import { ancestors } from "./workspace-tree-model.ts";
import { workspaceDrafts, type WorkspaceDraftStore } from "./workspace-edit-state.ts";
import { topLevelPaths } from "./workspace-selection.ts";
import type { MovePlan } from "./workspace-move-history.ts";

export const WORKSPACE_ENTRY_DRAG_TYPE = "application/x-pylon-workspace-entry";

export function workspaceMoveInventory(files: WorkspaceFileReadModel[]) {
  const folders = new Set<string>([""]);
  const occupied = new Set<string>();
  const submodules = files.filter(file => file.kind === "submodule").map(file => file.path);
  for (const file of files) {
    if (file.status === "deleted") continue;
    occupied.add(file.path);
    for (const folder of ancestors(file.path)) folders.add(folder);
    if (file.kind) folders.add(file.path);
  }
  for (const folder of folders) occupied.add(folder);
  return {
    folders: [...folders].filter(folder => (!folder || validWorkspacePath(folder)) && !submodules.some(path => pathWithin(folder, path))).sort(),
    occupied,
    submodules,
  };
}

type MoveInventory = ReturnType<typeof workspaceMoveInventory>;

export function moveDestination(path: string, folder: string): string {
  return folder ? `${folder}/${path.split("/").at(-1)}` : path.split("/").at(-1)!;
}

export function moveTargetError(path: string, folder: string, inventory: MoveInventory): string | undefined {
  if (!validWorkspacePath(path) || (folder && !validWorkspacePath(folder)) || !validWorkspacePath(moveDestination(path, folder)))
    return "Enter a valid workspace-relative folder, or / for workspace root.";
  const destination = moveDestination(path, folder);
  if (destination.toLowerCase() === path.toLowerCase()) return "Choose a different folder.";
  if (pathWithin(folder.toLowerCase(), path.toLowerCase())) return "Cannot move a folder into itself or its descendants.";
  if (inventory.submodules.some(module => pathWithin(path, module) || pathWithin(module, path) || pathWithin(folder, module)))
    return "Submodules cannot be modified here.";
  if (inventory.occupied.has(folder) && !inventory.folders.includes(folder)) return "Choose a folder, not a file.";
  if (inventory.occupied.has(destination)) return "Destination already exists. Choose another folder.";
  return undefined;
}

export function moveFolderSuggestions(path: string, inventory: MoveInventory): string[] {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return inventory.folders.filter(folder => folder.toLowerCase() !== parent.toLowerCase() && !pathWithin(folder.toLowerCase(), path.toLowerCase()));
}

export function planFolderMove(paths: string[], folder: string, inventory: MoveInventory): MovePlan[] {
  const targets = new Set<string>();
  return topLevelPaths(paths).map(path => {
    const error = moveTargetError(path, folder, inventory);
    if (error) throw new Error(error);
    const destination = moveDestination(path, folder);
    if (targets.has(destination.toLowerCase())) throw new Error("Selected entries have conflicting destination names.");
    targets.add(destination.toLowerCase());
    return { path, destination };
  });
}

export interface WorkspaceDragSource {
  path: string;
  paths?: string[];
  scope: string;
}

/** Only a drag started in this tree and this session generation may mutate it. */
export function workspaceDropDestination(source: WorkspaceDragSource | undefined, scope: string | undefined, folder: string | undefined, inventory: MoveInventory): string | undefined {
  if (!source || source.scope !== scope || !inventory.occupied.has(source.path) || folder === undefined || !inventory.folders.includes(folder) || moveTargetError(source.path, folder, inventory)) return undefined;
  return moveDestination(source.path, folder);
}

export async function moveWorkspaceEntry(
  request: { path: string; destination: string; sessionId: string; generation: number; expectedVersion?: string },
  runtime: {
    workspaceEntry(path: string, sessionId: string, generation: number): Promise<WorkspaceEntry>;
    mutateWorkspace(mutation: WorkspaceMutation, sessionId: string, generation: number): Promise<unknown>;
  },
  drafts: Pick<WorkspaceDraftStore, "dirty"> = workspaceDrafts,
): Promise<Extract<WorkspaceMutation, { action: "move" }>> {
  const { path, destination, sessionId, generation } = request;
  const checkDrafts = () => {
    if (drafts.dirty(sessionId, path)) throw new Error("Save or discard affected drafts first.");
    if (drafts.dirty(sessionId, destination)) throw new Error("Save or discard destination drafts first.");
  };
  checkDrafts();
  const expectedVersion = request.expectedVersion ?? (await runtime.workspaceEntry(path, sessionId, generation)).version;
  // Entry inspection is asynchronous: an editor may have become dirty while it was pending.
  checkDrafts();
  const mutation = { action: "move" as const, path, destination, expectedVersion };
  await runtime.mutateWorkspace(mutation, sessionId, generation);
  return mutation;
}

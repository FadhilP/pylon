import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface AndroidWorkspaceSelection {
  projectId: string;
  sessionId: string;
  sessionGeneration: number;
  root: string;
  registeredRoot: string;
  workspaceKind: "local" | "project-folder" | "session-worktree";
  workspaceLabel: string;
}

export interface ResolvedAndroidWorkspace extends Omit<AndroidWorkspaceSelection, "root" | "registeredRoot"> {
  canonicalRoot: string;
  canonicalRegisteredRoot: string;
}

export type AndroidWorkspaceProvider = (
  expectedGeneration: number,
) => AndroidWorkspaceSelection | Promise<AndroidWorkspaceSelection>;

function validIdentity(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value);
}

export async function resolveAndroidWorkspace(
  provider: AndroidWorkspaceProvider,
  expectedGeneration: number,
): Promise<ResolvedAndroidWorkspace> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new Error("Android workspace generation is invalid");
  }
  const selected = await provider(expectedGeneration);
  if (
    selected.sessionGeneration !== expectedGeneration ||
    !validIdentity(selected.projectId, 200) ||
    !validIdentity(selected.sessionId, 200) ||
    !validIdentity(selected.workspaceLabel, 200) ||
    !isAbsolute(selected.root) ||
    !isAbsolute(selected.registeredRoot) ||
    selected.root.length > 4096 ||
    selected.registeredRoot.length > 4096 ||
    !["local", "project-folder", "session-worktree"].includes(selected.workspaceKind)
  ) {
    throw new Error("Android workspace selection is stale or invalid");
  }
  const [canonicalRoot, canonicalRegisteredRoot] = await Promise.all([
    realpath(selected.root),
    realpath(selected.registeredRoot),
  ]);
  const [rootState, registeredState] = await Promise.all([lstat(canonicalRoot), lstat(canonicalRegisteredRoot)]);
  if (
    !rootState.isDirectory() ||
    rootState.isSymbolicLink() ||
    !registeredState.isDirectory() ||
    registeredState.isSymbolicLink()
  ) {
    throw new Error("Android workspace is unavailable");
  }
  return {
    projectId: selected.projectId,
    sessionId: selected.sessionId,
    sessionGeneration: selected.sessionGeneration,
    canonicalRoot,
    canonicalRegisteredRoot,
    workspaceKind: selected.workspaceKind,
    workspaceLabel: selected.workspaceLabel,
  };
}

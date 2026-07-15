import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, relative, sep, join } from "node:path";
import { updateJson } from "./storage.ts";
export type Workspace = {
  id: string;
  canonicalPath: string;
  parentId?: string;
  projectOwner?: string;
  createdAt: string;
  lastSeenAt: string;
};
export function isWorkspace(value: any): value is Workspace {
  return value && typeof value.id === "string" && value.id &&
    typeof value.canonicalPath === "string" && value.canonicalPath &&
    typeof value.createdAt === "string" && typeof value.lastSeenAt === "string" &&
    (value.parentId === undefined || typeof value.parentId === "string") &&
    (value.projectOwner === undefined || typeof value.projectOwner === "string");
}
function isAncestor(parent: Workspace, child: Workspace) {
  const path = relative(parent.canonicalPath, child.canonicalPath);
  return path && !path.startsWith("..") && !path.startsWith(sep);
}
function repairParents(all: Workspace[]) {
  for (const workspace of all) {
    const parent = all
      .filter((candidate) => candidate.id !== workspace.id && isAncestor(candidate, workspace))
      .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
    if (parent) workspace.parentId = parent.id;
    else delete workspace.parentId;
  }
}
export async function registerWorkspace(root: string, cwd: string) {
  const path = await realpath(cwd).catch(() => resolve(cwd));
  const file = join(root, "workspaces.json");
  let workspace!: Workspace;
  const all = await updateJson<Workspace[]>(file, [], (loaded) => {
    const valid = Array.isArray(loaded) ? loaded.filter(isWorkspace) : [];
    workspace = valid.find((item) => item.canonicalPath === path)!;
    const now = new Date().toISOString();
    if (!workspace) {
      workspace = {
        id: randomUUID(),
        canonicalPath: path,
        createdAt: now,
        lastSeenAt: now,
      };
      valid.push(workspace);
    } else workspace.lastSeenAt = now;
    repairParents(valid);
    return valid;
  }, Array.isArray);
  return { workspace, all, dir: join(root, "workspaces", workspace.id) };
}

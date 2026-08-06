import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, resolve, relative, sep, join } from "node:path";
import { readJson, updateJson } from "./storage.ts";
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
  const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const byPath = new Map(all.map((workspace) => [key(workspace.canonicalPath), workspace]));
  for (const workspace of all) {
    let path = dirname(workspace.canonicalPath);
    let parent: Workspace | undefined;
    for (;;) {
      parent = byPath.get(key(path));
      if (parent && parent.id !== workspace.id && isAncestor(parent, workspace)) break;
      const next = dirname(path);
      if (next === path) { parent = undefined; break; }
      path = next;
    }
    if (parent) workspace.parentId = parent.id;
    else delete workspace.parentId;
  }
}
export async function registerWorkspace(root: string, cwd: string) {
  const path = await realpath(cwd).catch(() => resolve(cwd));
  const file = join(root, "workspaces.json");
  const cutoff = Date.now() - 180 * 24 * 60 * 60_000;
  const staleIds = new Set((await Promise.all(
    (await readJson<Workspace[]>(file, [], Array.isArray))
      .filter(isWorkspace)
      .filter((item) => !item.projectOwner && Date.parse(item.lastSeenAt) < cutoff && item.canonicalPath !== path)
      .map(async (item) => {
        const [workspaceMissing, stateMissing] = await Promise.all([
          stat(item.canonicalPath).then(() => false, (error: any) => error?.code === "ENOENT"),
          stat(join(root, "workspaces", item.id)).then(() => false, (error: any) => error?.code === "ENOENT"),
        ]);
        return workspaceMissing && stateMissing ? item.id : undefined;
      }),
  )).filter((id): id is string => id !== undefined));
  let workspace!: Workspace;
  const all = await updateJson<Workspace[]>(file, [], (loaded) => {
    const valid = (Array.isArray(loaded) ? loaded.filter(isWorkspace) : []).filter((item) => !staleIds.has(item.id));
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

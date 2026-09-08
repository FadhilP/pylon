import type { WorkspaceFileReadModel } from "../../shared/protocol/snapshots.ts";

export interface WorkspaceTreeNode {
  /** Full path from the workspace root; "" for the root node. */
  path: string;
  name: string;
  directory: boolean;
  children: WorkspaceTreeNode[];
  /** The file this row stands for, absent on directories and submodule chains. */
  file?: WorkspaceFileReadModel;
  /** Subtree totals, so a collapsed folder can still say what changed inside it. */
  additions: number;
  deletions: number;
  changedCount: number;
}

const directory = (path: string, name: string): WorkspaceTreeNode => ({
  path,
  name,
  directory: true,
  children: [],
  additions: 0,
  deletions: 0,
  changedCount: 0,
});

export function buildWorkspaceTree(files: WorkspaceFileReadModel[]): WorkspaceTreeNode {
  const root = directory("", "");
  const directories = new Map<string, WorkspaceTreeNode>([["", root]]);
  const descend = (parent: WorkspaceTreeNode, name: string) => {
    const path = parent.path ? `${parent.path}/${name}` : name;
    let node = directories.get(path);
    if (!node) {
      node = directory(path, name);
      directories.set(path, node);
      parent.children.push(node);
    }
    return node;
  };

  for (const file of files) {
    const parts = file.path.split("/");
    // Explicit directories include empty folders and registered submodules.
    const folders = file.kind ? parts : parts.slice(0, -1);
    let node = root;
    for (const part of folders) {
      node = descend(node, part);
      node.additions += file.additions ?? 0;
      node.deletions += file.deletions ?? 0;
      if (file.status) node.changedCount++;
    }
    if (file.kind) continue;
    node.children.push({
      path: file.path,
      name: parts.at(-1)!,
      directory: false,
      children: [],
      file,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changedCount: file.status ? 1 : 0,
    });
  }

  const sort = (node: WorkspaceTreeNode) => {
    node.children.sort((left, right) =>
      left.directory === right.directory ? left.name.localeCompare(right.name) : left.directory ? -1 : 1,
    );
    for (const child of node.children) if (child.directory) sort(child);
  };
  sort(root);
  return root;
}

/** Subsequence match, so "fic" finds "file-icon.ts". */
export function subsequenceMatch(query: string, text: string): boolean {
  if (!query) return true;
  const haystack = text.toLocaleLowerCase();
  let at = 0;
  for (const character of query.toLocaleLowerCase()) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

/** Every folder on the way to a path, outermost first: "a/b/c.ts" -> ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

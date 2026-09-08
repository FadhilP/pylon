import {
  defaultFileIcon,
  defaultFolderIcon,
  fileIconExtensions,
  fileIconNames,
  folderIconNames,
} from "./file-icon-map.ts";

// The tree renders every row it is given — up to 10,000 — so remember what a
// path resolved to rather than re-splitting it on each render.
const resolved = new Map<string, string>();

/** Material Icon Theme icon id for a path, served from /file-icons/<id>.svg. */
export function fileIconId(path: string): string {
  const cached = resolved.get(path);
  if (cached) return cached;
  const icon = lookup(path);
  resolved.set(path, icon);
  return icon;
}

function lookup(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const named = fileIconNames[name];
  if (named) return named;
  // Longest suffix first, so "component.test.tsx" prefers "test.tsx" over "tsx".
  const parts = name.split(".");
  for (let index = 1; index < parts.length; index++) {
    const extension = fileIconExtensions[parts.slice(index).join(".")];
    if (extension) return extension;
  }
  return defaultFileIcon;
}

const resolvedFolders = new Map<string, string>();

/** Material Icon Theme icon id for a directory, served from /file-icons/<id>.svg.
    Every expanded icon is its closed name plus "-open", so only one table ships. */
export function folderIconId(name: string, open: boolean): string {
  const key = `${open ? "+" : "-"}${name}`;
  const cached = resolvedFolders.get(key);
  if (cached) return cached;
  const base = folderIconNames[name.toLocaleLowerCase()] ?? defaultFolderIcon;
  const icon = open ? `${base}-open` : base;
  resolvedFolders.set(key, icon);
  return icon;
}

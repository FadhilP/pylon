import { ancestors } from "./workspace-tree-model.ts";

export function topLevelPaths(paths: string[]): string[] {
  const unique = new Set(paths);
  return [...unique].filter(path => !ancestors(path).some(parent => unique.has(parent)));
}

export function selectWorkspacePaths(
  selected: string[], anchor: string | undefined, path: string, visible: string[],
  modifiers: { toggle: boolean; range: boolean },
): { paths: string[]; anchor: string } {
  const visibleSet = new Set(visible);
  const existing = selected.filter(item => visibleSet.has(item));
  const start = anchor === undefined ? -1 : visible.indexOf(anchor);
  const end = visible.indexOf(path);
  if (modifiers.range && start >= 0 && end >= 0) {
    const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { paths: modifiers.toggle ? [...new Set([...existing, ...range])] : range, anchor: anchor! };
  }
  return {
    paths: modifiers.toggle ? existing.includes(path) ? existing.filter(item => item !== path) : [...existing, path] : [path],
    anchor: path,
  };
}

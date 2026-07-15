export const INSPECTION = new Set([
  "read",
  "rg",
  "fd",
  "grep",
  "find",
  "ls",
  "continuity_update",
  "repo_scout",
  "advisor",
]);
export function blocked(planning: boolean, tool: string) {
  return planning && !INSPECTION.has(tool);
}
export function planningTools() {
  return [...INSPECTION];
}

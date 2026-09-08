export const MAX_EDIT_BYTES = 1024 * 1024;

export interface WorkspaceEntry {
  sessionGeneration: number;
  sessionId: string;
  path: string;
  absolutePath?: string;
  version: string;
  /** Path-independent identity/content guard; deliberately excludes timestamps. */
  moveFingerprint?: string;
  /** Echoed only after a read-only destination preflight succeeds. */
  moveDestination?: string;
  kind: "file" | "directory";
  entries: number;
  /** LF-normalized, BOM-free text. Absent when lossless text editing is unsupported. */
  text?: string;
  /** LF-normalized index blob; empty for untracked files, absent when comparison is unavailable. */
  gitIndexText?: string;
  readOnlyReason?: string;
}

export interface WorkspaceGitIndex {
  sessionId: string;
  sessionGeneration: number;
  text?: string;
}
export interface WorkspaceMutationResult { savedVersion: string }

export type WorkspaceMutation =
  | { action: "createFile" | "createDirectory"; path: string }
  | { action: "save"; path: string; expectedVersion: string; text: string }
  | { action: "copy"; path: string; expectedVersion: string; destination: string }
  | { action: "move"; path: string; expectedVersion: string; destination: string }
  | { action: "delete"; path: string; expectedVersion: string; confirmed: true };

export interface WorkspaceMutationInput {
  sessionId: string;
  expectedGeneration: number;
  mutation: WorkspaceMutation;
}

/** Portable names only: reject Windows aliases/streams even on POSIX. */
export function validWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 &&
    !/[\\\x00-\x1f\x7f<>:"|?*]/.test(value) && value.split("/").every(part =>
      part.length > 0 && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
      !/^(\.git|\.gitmodules|\.pylon|\.pi)$/i.test(part));
}

export function validWorkspaceMutation(value: unknown): value is WorkspaceMutation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!validWorkspacePath(item.path)) return false;
  if (item.action === "createFile" || item.action === "createDirectory") return true;
  if (typeof item.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(item.expectedVersion)) return false;
  if (item.action === "save") return typeof item.text === "string" && item.text.length <= MAX_EDIT_BYTES;
  if (item.action === "move" || item.action === "copy") return validWorkspacePath(item.destination);
  return item.action === "delete" && item.confirmed === true;
}

export function pathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

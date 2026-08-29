import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, SessionManager, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "./workspace.ts";

export const MAX_PROJECT_RECALL_SESSIONS = 20;
export const MAX_PROJECT_RECALL_WORKSPACES = 20;
export const MAX_PROJECT_RECALL_CANDIDATES = 100;
export const MAX_PROJECT_RECALL_CANDIDATES_PER_WORKSPACE = 100;
export const MAX_PROJECT_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_RECALL_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_SESSION_ENTRIES = 50_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

export type ProjectRecallSession = { sessionId: string; modifiedAt: string; entries: SessionEntry[] };
export type ProjectRecallLoadResult = { sessions: ProjectRecallSession[]; skipped: number; truncated: boolean };
export type ProjectSessionSource = {
  list(cwd: string, sessionDir: string): Promise<SessionInfo[]>;
  read(path: string, remainingBytes: number): Promise<{ content: string; bytes: number } | undefined>;
};

const canonical = (path: string) => {
  let value = resolve(path);
  try {
    value = realpathSync.native(value);
  } catch {
    /* Historical paths may no longer exist. */
  }
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const withinSessionDir = (sessionDir: string, path: string) => {
  const rel = relative(resolve(sessionDir), resolve(path));
  return !!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) && !rel.includes(sep);
};
const safeId = (value: unknown) => typeof value === "string" && value.length <= 200 && SAFE_ID.test(value);

export function defaultPiSessionDir(cwd: string) {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

const defaultSource: ProjectSessionSource = {
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  async read(path, remainingBytes) {
    const info = await lstat(path).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_PROJECT_SESSION_FILE_BYTES ||
      info.size > remainingBytes
    )
      return;
    const data = await readFile(path).catch(() => undefined);
    if (!data || data.byteLength > MAX_PROJECT_SESSION_FILE_BYTES || data.byteLength > remainingBytes) return;
    try {
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(data), bytes: data.byteLength };
    } catch {
      return;
    }
  },
};

export function parseProjectSession(
  content: string,
  expected: { sessionId: string; cwd: string },
): SessionEntry[] | undefined {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > MAX_PROJECT_SESSION_ENTRIES + 1) return;
  let parsed: any[];
  try {
    parsed = lines.map(line => JSON.parse(line));
  } catch {
    return;
  }
  const [header, ...rawEntries] = parsed;
  if (
    header?.type !== "session" ||
    (header.version !== 2 && header.version !== 3) ||
    !safeId(header.id) ||
    header.id !== expected.sessionId ||
    typeof header.cwd !== "string" ||
    canonical(header.cwd) !== canonical(expected.cwd)
  )
    return;
  const entries = rawEntries as SessionEntry[];
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !ENTRY_TYPES.has(entry.type) ||
      !safeId(entry.id) ||
      header.id.length + entry.id.length + 1 > 200 ||
      byId.has(entry.id) ||
      !(entry.parentId === null || safeId(entry.parentId)) ||
      typeof entry.timestamp !== "string" ||
      !Number.isFinite(Date.parse(entry.timestamp))
    )
      return;
    byId.set(entry.id, entry);
  }
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) return;
  }
  if (branch.at(-1)?.parentId !== null) return;
  branch.reverse();
  return branch;
}

export async function loadProjectRecallSessions(
  input: {
    projectOwner: string;
    workspaces: Workspace[];
    currentSessionId: string;
    currentSessionFile?: string;
    currentCwd: string;
    signal?: AbortSignal;
  },
  source: ProjectSessionSource = defaultSource,
): Promise<ProjectRecallLoadResult> {
  const currentCwd = canonical(input.currentCwd);
  const owned = input.workspaces
    .filter(item => item.projectOwner === input.projectOwner || (!item.projectOwner && item.id === input.projectOwner))
    .sort(
      (left, right) =>
        Number(canonical(right.canonicalPath) === currentCwd) - Number(canonical(left.canonicalPath) === currentCwd) ||
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    );
  const workspaceOverflow = owned.length > MAX_PROJECT_RECALL_WORKSPACES;
  const cwdByCanonical = new Map(
    owned
      .slice(0, MAX_PROJECT_RECALL_WORKSPACES)
      .map(item => [canonical(item.canonicalPath), item.canonicalPath] as const),
  );
  const cwdSet = new Set(cwdByCanonical.keys());
  const directories = [...cwdByCanonical.values()].map(cwd => ({ cwd, sessionDir: defaultPiSessionDir(cwd) }));
  const currentFile = input.currentSessionFile && canonical(input.currentSessionFile);
  const unique = new Map<string, SessionInfo>();
  let metadataSkipped = 0,
    metadataOverflow = false;
  for (const { cwd, sessionDir } of directories) {
    if (input.signal?.aborted) throw new DOMException("Project session recall aborted", "AbortError");
    const listed = await source.list(cwd, sessionDir).catch(() => []);
    metadataOverflow ||= listed.length > MAX_PROJECT_RECALL_CANDIDATES_PER_WORKSPACE;
    for (const session of listed.slice(0, MAX_PROJECT_RECALL_CANDIDATES_PER_WORKSPACE)) {
      const path = canonical(session.path),
        modified = session.modified.getTime();
      if (session.id === input.currentSessionId || path === currentFile) continue;
      if (
        !withinSessionDir(sessionDir, session.path) ||
        !Number.isFinite(modified) ||
        !session.cwd ||
        !cwdSet.has(canonical(session.cwd))
      ) {
        metadataSkipped++;
        continue;
      }
      unique.set(path, session);
    }
  }
  const discovered = [...unique.values()].sort(
    (left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
  );
  const candidates = discovered.slice(0, MAX_PROJECT_RECALL_CANDIDATES);
  const sessions: ProjectRecallSession[] = [];
  let fileSkipped = 0,
    bytes = 0;
  for (const info of candidates) {
    if (sessions.length >= MAX_PROJECT_RECALL_SESSIONS || bytes >= MAX_PROJECT_RECALL_BYTES) break;
    if (input.signal?.aborted) throw new DOMException("Project session recall aborted", "AbortError");
    const loaded = await source.read(info.path, MAX_PROJECT_RECALL_BYTES - bytes);
    if (!loaded) {
      fileSkipped++;
      continue;
    }
    bytes += loaded.bytes;
    const entries = parseProjectSession(loaded.content, { sessionId: info.id, cwd: info.cwd });
    if (!entries) {
      fileSkipped++;
      continue;
    }
    sessions.push({ sessionId: info.id, modifiedAt: info.modified.toISOString(), entries });
  }
  return {
    sessions,
    skipped: metadataSkipped + fileSkipped,
    truncated:
      workspaceOverflow ||
      metadataOverflow ||
      discovered.length > candidates.length ||
      candidates.length > sessions.length + fileSkipped ||
      bytes >= MAX_PROJECT_RECALL_BYTES,
  };
}

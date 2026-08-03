import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getAgentDir,
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

type ParentSessionManager = Pick<SessionManager, "getSessionFile" | "getSessionId" | "getBranch">;

export const AGENT_MARKER = "pi-spawn-agent";
export const SESSION_MARKER = "pi-spawn-session";

export type AgentPolicy = {
  version: 1;
  ownerSessionId: string;
  ownerSessionFile: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  tools?: string[];
  disableSpecialists: boolean;
  createdAt: string;
};

export type SpawnHooks = {
  sessionStart?: { customType: string; content: string };
  beforeAgentStart?: string;
};

export type SpawnMarker = {
  version: 1;
  ownerSessionId: string;
  ownerSessionFile: string;
  model?: string;
  hooks?: SpawnHooks;
  createdAt: string;
};

export type SpawnKind = "agent" | "session";
export type SpawnThreadInfo = {
  id: string;
  kind: SpawnKind;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
};

const canonical = (path: string) => {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
};

export function requireParent(manager: ParentSessionManager): { id: string; file: string } {
  const file = manager.getSessionFile();
  if (!file) throw new Error("pi-spawn requires a persisted parent session.");
  return { id: manager.getSessionId(), file };
}

export function privateAgentDir(parentSessionId: string, agentDir = getAgentDir()): string {
  return join(agentDir, "pi-spawn", "agents", encodeURIComponent(parentSessionId));
}

export function resultDetails(kind: SpawnKind, id: string) {
  return { piSpawn: { version: 1, kind, id } };
}

export function branchSpawnIds(manager: ParentSessionManager, kind: SpawnKind): Set<string> {
  const ids = new Set<string>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const value = (entry.message.details as any)?.piSpawn;
    if (value?.version === 1 && value.kind === kind && typeof value.id === "string") ids.add(value.id);
  }
  return ids;
}

function materialize(manager: SessionManager): void {
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  if (!path || !header) throw new Error("Unable to create spawned session file.");
  const records = [header, ...manager.getEntries()];
  writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
}

function customData<T>(manager: SessionManager, customType: string): T[] {
  const result: T[] = [];
  for (const entry of manager.getEntries()) {
    if (entry.type === "custom" && entry.customType === customType) result.push(entry.data as T);
  }
  return result;
}

const boundedText = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const validHooks = (value: any): value is SpawnHooks => value !== undefined
  && typeof value === "object" && !Array.isArray(value)
  && (value.beforeAgentStart === undefined || boundedText(value.beforeAgentStart, 300 * 1024))
  && (value.sessionStart === undefined || boundedText(value.sessionStart?.customType, 128)
    && boundedText(value.sessionStart?.content, 300 * 1024));

function validMarker(value: any): value is SpawnMarker {
  return value?.version === 1
    && boundedText(value.ownerSessionId, 128)
    && boundedText(value.ownerSessionFile, 32_768)
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && (value.model === undefined || boundedText(value.model, 300))
    && (value.hooks === undefined || validHooks(value.hooks));
}

function validOwner(value: any, parent: { id: string; file: string }): boolean {
  return validMarker(value)
    && value.ownerSessionId === parent.id
    && canonical(value.ownerSessionFile) === canonical(parent.file);
}

function ownedBy(manager: SessionManager, markerType: string, parent: { id: string; file: string }): boolean {
  const markers = customData<any>(manager, markerType);
  return markers.length > 0 && markers.every((marker) => validOwner(marker, parent));
}

export class SessionAdoptionError extends Error {
  readonly code: "not_found" | "invalid" | "owned";

  constructor(code: "not_found" | "invalid" | "owned", message: string) {
    super(message);
    this.name = "SessionAdoptionError";
    this.code = code;
  }
}

export async function findSessionForAdoption(
  cwd: string,
  id: string,
  parent: { id: string; file: string },
): Promise<SessionInfo> {
  const matches = (await SessionManager.list(cwd)).filter((session) => session.id === id);
  if (matches.length === 0) throw new SessionAdoptionError("not_found", "Existing session was not found in the selected project.");
  if (matches.length > 1) throw new SessionAdoptionError("invalid", "Existing session ID is ambiguous.");
  const info = matches[0];
  if (info.id === parent.id || canonical(info.path) === canonical(parent.file))
    throw new SessionAdoptionError("invalid", "The active parent session cannot adopt itself.");
  return info;
}

export function claimSpawnedSession(
  path: string,
  expectedId: string,
  parent: { id: string; file: string },
  hooks?: SpawnHooks,
): void {
  const manager = SessionManager.open(path);
  if (manager.getSessionId() !== expectedId || canonical(manager.getSessionFile() ?? path) !== canonical(path))
    throw new SessionAdoptionError("invalid", "Existing session identity changed before adoption.");
  if (manager.getSessionId() === parent.id || canonical(path) === canonical(parent.file))
    throw new SessionAdoptionError("invalid", "The active parent session cannot adopt itself.");
  if (customData(manager, AGENT_MARKER).length > 0)
    throw new SessionAdoptionError("owned", "Existing session has incompatible pi-spawn ownership metadata.");
  const markers = customData<any>(manager, SESSION_MARKER);
  if (markers.length > 0) {
    if (markers.every((marker) => validOwner(marker, parent))) return;
    throw new SessionAdoptionError("owned", "Existing session is already owned by another pi-spawn parent or has invalid ownership metadata.");
  }
  manager.appendCustomEntry(SESSION_MARKER, {
    version: 1,
    ownerSessionId: parent.id,
    ownerSessionFile: parent.file,
    ...(hooks ? { hooks } : {}),
    createdAt: new Date().toISOString(),
  } satisfies SpawnMarker);
}

export function createPrivateAgent(
  cwd: string,
  parent: { id: string; file: string },
  policy: Omit<AgentPolicy, "version" | "ownerSessionId" | "ownerSessionFile" | "createdAt">,
  name: string,
  agentDir = getAgentDir(),
): { manager: SessionManager; info: SessionInfo; policy: AgentPolicy } {
  const manager = SessionManager.create(cwd, privateAgentDir(parent.id, agentDir), { parentSession: parent.file });
  const stored: AgentPolicy = {
    version: 1,
    ownerSessionId: parent.id,
    ownerSessionFile: parent.file,
    ...policy,
    createdAt: new Date().toISOString(),
  };
  manager.appendCustomEntry(AGENT_MARKER, stored);
  manager.appendSessionInfo(name);
  materialize(manager);
  const path = manager.getSessionFile()!;
  return {
    manager,
    policy: stored,
    info: {
      path,
      id: manager.getSessionId(),
      cwd,
      name,
      parentSessionPath: parent.file,
      created: new Date(stored.createdAt),
      modified: new Date(stored.createdAt),
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    },
  };
}

export function createSpawnedSession(
  cwd: string,
  parent: { id: string; file: string },
  name: string,
  options: { model?: string; hooks?: SpawnHooks } = {},
): { manager: SessionManager; info: SessionInfo; policy: SpawnMarker } {
  const manager = SessionManager.create(cwd, undefined, { parentSession: parent.file });
  const marker: SpawnMarker = {
    version: 1,
    ownerSessionId: parent.id,
    ownerSessionFile: parent.file,
    ...(options.model ? { model: options.model } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    createdAt: new Date().toISOString(),
  };
  manager.appendCustomEntry(SESSION_MARKER, marker);
  manager.appendSessionInfo(name);
  materialize(manager);
  const path = manager.getSessionFile()!;
  return {
    manager,
    policy: marker,
    info: {
      path,
      id: manager.getSessionId(),
      cwd,
      name,
      parentSessionPath: parent.file,
      created: new Date(marker.createdAt),
      modified: new Date(marker.createdAt),
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
    },
  };
}

async function authorized(
  sessions: SessionInfo[],
  allowedIds: Set<string>,
  parent: { id: string; file: string },
  markerType: string,
): Promise<Array<{ info: SessionInfo; manager: SessionManager }>> {
  const result: Array<{ info: SessionInfo; manager: SessionManager }> = [];
  for (const info of sessions) {
    if (!allowedIds.has(info.id)) continue;
    try {
      const manager = SessionManager.open(info.path);
      if (ownedBy(manager, markerType, parent)) result.push({ info, manager });
    } catch { /* Ignore deleted or malformed child sessions. */ }
  }
  return result;
}

export async function listPrivateAgents(
  cwd: string,
  parent: { id: string; file: string },
  allowedIds: Set<string>,
  agentDir = getAgentDir(),
) {
  return authorized(await SessionManager.list(cwd, privateAgentDir(parent.id, agentDir)), allowedIds, parent, AGENT_MARKER);
}

export async function listSpawnedSessions(
  parent: { id: string; file: string },
  allowedIds: Set<string>,
) {
  return authorized(await SessionManager.listAll(), allowedIds, parent, SESSION_MARKER);
}

export function agentPolicy(manager: SessionManager, parent: { id: string; file: string }): AgentPolicy | undefined {
  const policies = customData<AgentPolicy>(manager, AGENT_MARKER);
  return policies.length > 0 && policies.every((policy) => validOwner(policy, parent)) ? policies[0] : undefined;
}

export function sessionPolicy(manager: SessionManager, parent: { id: string; file: string }): SpawnMarker | undefined {
  const policies = customData<SpawnMarker>(manager, SESSION_MARKER);
  return policies.length > 0 && policies.every((policy) => validOwner(policy, parent)) ? policies.at(-1) : undefined;
}

export function spawnedHooks(manager: ParentSessionManager): SpawnHooks | undefined {
  const policies: SpawnMarker[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type === "custom" && entry.customType === SESSION_MARKER && validMarker(entry.data)) policies.push(entry.data);
  }
  return policies.length > 0 ? policies.at(-1)?.hooks : undefined;
}

export function threadInfo(kind: SpawnKind, info: SessionInfo): SpawnThreadInfo {
  return {
    id: info.id,
    kind,
    ...(info.name ? { name: info.name } : {}),
    createdAt: info.created.toISOString(),
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
  };
}

export class SpawnBusyError extends Error {}

const activeThreads = new Set<string>();
const abortError = () => new DOMException("Spawned thread turn was aborted.", "AbortError");

export async function withThreadLock<T>(sessionPath: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError();
  const key = canonical(sessionPath);
  if (activeThreads.has(key)) throw new SpawnBusyError("Spawned thread is already running in this Pi process.");
  activeThreads.add(key);
  try {
    if (signal?.aborted) throw abortError();
    return await run();
  } finally {
    activeThreads.delete(key);
  }
}

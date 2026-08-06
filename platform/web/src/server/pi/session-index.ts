import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, ArchivedProjectSummary, ArchivedSessionSummary, SessionListSnapshot, SessionProjectPage, SessionSummary } from "../../shared/protocol/snapshots.ts";
import type { SessionListQuery } from "../../shared/protocol/snapshots.ts";
import { projectIdForCwd, type ProjectRegistry } from "./project-registry.ts";
import { SessionSummaryCache, type SessionFileMetadata } from "./session-summary-cache.ts";

const REFRESH_MS = 60_000;
const SPAWN_SESSION_MARKER = "pi-spawn-session";
const canonicalPath = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

type SpawnOwner = { id: string; file: string };

const boundedText = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const validHooks = (value: any) => value !== undefined && value !== null
  && typeof value === "object" && !Array.isArray(value)
  && (value.beforeAgentStart === undefined || boundedText(value.beforeAgentStart, 300 * 1024))
  && (value.sessionStart === undefined || boundedText(value.sessionStart?.customType, 128)
    && boundedText(value.sessionStart?.content, 300 * 1024));

function markerOwner(value: any): SpawnOwner | undefined {
  if (value?.version !== 1
    || !boundedText(value.ownerSessionId, 128)
    || !boundedText(value.ownerSessionFile, 32_768)
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
    || value.model !== undefined && !boundedText(value.model, 300)
    || value.hooks !== undefined && !validHooks(value.hooks)) return;
  return { id: value.ownerSessionId, file: value.ownerSessionFile };
}

function readSpawnOwner(entries: ReturnType<SessionManager["getEntries"]>): SpawnOwner | undefined {
  const owners = entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === SPAWN_SESSION_MARKER ? [markerOwner(entry.data)] : []);
  const owner = owners[0];
  return owner && owners.every((candidate) => candidate?.id === owner.id
    && canonicalPath(candidate.file) === canonicalPath(owner.file)) ? owner : undefined;
}

export { projectIdForCwd } from "./project-registry.ts";

function encodeCursor(sessionId: string): string {
  return Buffer.from(sessionId).toString("base64url");
}

export function decodeSessionCursor(cursor: string): string | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    return decoded && encodeCursor(decoded) === cursor ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionIndexOptions {
  activeId: string;
  generation: number;
  stateFor: (sessionId: string) => SessionRuntimeState;
  activeFor?: (sessionId: string) => boolean;
  pinnedFor?: (sessionId: string) => boolean;
  activeFallback?: SessionInfo;
  fallbacks?: SessionInfo[];
  userCountFor?: (sessionId: string) => number | undefined;
  workStartedAtFor?: (sessionId: string) => string | undefined;
}

export class SessionIndex {
  private sessions: SessionInfo[] = [];
  private metadata = new Map<string, SessionFileMetadata>();
  private dirtySessions = new Map<string, { path: string; cwd: string }>();
  private scannedAt = 0;
  private scan?: Promise<void>;
  private cache?: SessionSummaryCache;

  constructor(private registry?: ProjectRegistry, agentDir = process.env.PI_CODING_AGENT_DIR) {
    if (agentDir) this.cache = new SessionSummaryCache(agentDir);
  }

  setAgentDir(agentDir: string): void {
    this.cache = new SessionSummaryCache(agentDir);
    this.sessions = [];
    this.metadata.clear();
    this.dirtySessions.clear();
    this.invalidate();
  }

  setProjectRegistry(registry: ProjectRegistry): void {
    this.registry = registry;
    this.invalidate();
  }

  async resolve(sessionId: string): Promise<SessionInfo | undefined> {
    await this.refresh();
    return this.sessions.find((session) => session.id === sessionId);
  }

  invalidate(): void {
    this.scannedAt = 0;
  }

  invalidateSession(sessionId: string, path?: string, cwd?: string): void {
    const current = this.sessions.find((session) => session.id === sessionId);
    const sessionPath = path || current?.path;
    const sessionCwd = cwd || current?.cwd;
    if (!sessionPath || !sessionCwd) {
      this.invalidate();
      return;
    }
    this.dirtySessions.set(sessionId, { path: sessionPath, cwd: sessionCwd });
  }

  remove(sessionId: string): void {
    const current = this.sessions.find((session) => session.id === sessionId);
    if (current) this.dirtySessions.set(sessionId, { path: current.path, cwd: current.cwd });
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    this.metadata.delete(sessionId);
  }

  async list(input: SessionListQuery, options: SessionIndexOptions): Promise<SessionListSnapshot> {
    await this.refresh();
    const registered = this.registry?.list();
    const registeredById = registered ? new Map(registered.map((project) => [project.id, project])) : undefined;
    const registeredIds = registeredById ? new Set(registeredById.keys()) : undefined;
    const workspaceProjectIds = new Map(this.registry?.listSessionWorkspaces().map((record) => [record.sessionId, record.projectId]));
    const archivedIds = new Set(this.registry?.listArchivedSessions().map((record) => record.id));
    const projectIdFor = (session: Pick<SessionInfo, "id" | "cwd">) => workspaceProjectIds.get(session.id) ?? projectIdForCwd(session.cwd);
    const projectFor = (session: Pick<SessionInfo, "id" | "cwd">) => registeredById?.get(projectIdFor(session));
    const fallbacks = options.fallbacks ?? (options.activeFallback ? [options.activeFallback] : []);
    const missing = fallbacks.filter((fallback) => {
      if (this.sessions.some((session) => session.id === fallback.id)) return false;
      return (options.userCountFor?.(fallback.id) ?? fallback.messageCount) > 0;
    });
    const source = [...missing, ...this.sessions]
      .filter((session) => !registeredIds || registeredIds.has(projectIdFor(session)))
      .filter((session) => !archivedIds.has(session.id))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime());
    const query = input.query?.trim().toLowerCase() ?? "";
    const filtered = query
      ? source.filter((session) => `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase().includes(query))
      : source;
    const grouped = new Map<string, SessionInfo[]>();
    for (const session of filtered) {
      const projectId = projectIdFor(session);
      if (input.projectId && projectId !== input.projectId) continue;
      const group = grouped.get(projectId) ?? [];
      group.push(session);
      grouped.set(projectId, group);
    }
    const labels = this.projectLabels(source, projectIdFor);
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const limit = Math.min(100, Math.max(1, input.limit ?? 10));
    const projects: SessionProjectPage[] = [];
    const sessionLookup = this.sessionLookup();
    const projectEntries = registered
      ? registered
          .filter((project) => !input.projectId || project.id === input.projectId)
          .filter((project) => !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query) || grouped.has(project.id))
          .map((project) => [project.id, grouped.get(project.id) ?? [], project.label, project.cwd] as const)
      : [...grouped].slice(0, 100).map(([id, sessions]) => [id, sessions, labels.get(id), sessions[0]!.cwd] as const);
    for (const [id, sessions, registeredLabel, cwd] of projectEntries) {
      const offset = cursorId ? sessions.findIndex((session) => session.id === cursorId) + 1 : 0;
      if (cursorId && offset === 0) continue;
      const page = sessions.slice(offset, offset + limit);
      projects.push({
        id,
        label: registeredLabel ?? labels.get(id) ?? (basename(sessions[0]?.cwd ?? "") || "Workspace"),
        cwd,
        totalCount: sessions.length,
        sessions: page.map((session) => this.summary(session, options, sessionLookup, projectIdFor, projectFor)),
        ...(offset + page.length < sessions.length && page.length
          ? { nextCursor: encodeCursor(page.at(-1)!.id) }
          : {}),
      });
    }
    const activeOrder = new Map((this.registry?.listActiveSessionOrder() ?? []).map((id, index) => [id, index]));
    const activeSessions = source
      .filter((session) => options.activeFor?.(session.id) ?? options.stateFor(session.id) !== "sleeping")
      .sort((left, right) => {
        const leftOrder = activeOrder.get(left.id);
        const rightOrder = activeOrder.get(right.id);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          if (leftOrder === undefined) return 1;
          if (rightOrder === undefined) return -1;
          return leftOrder - rightOrder;
        }
        return right.modified.getTime() - left.modified.getTime();
      })
      .slice(0, 100)
      .map((session) => this.summary(session, options, sessionLookup, projectIdFor, projectFor));
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: options.generation, activeSessions, projects };
  }

  async listArchived(input: ArchiveListQuery, options: SessionIndexOptions): Promise<ArchiveListSnapshot> {
    await this.refresh();
    const registry = this.registry;
    if (!registry) {
      return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: options.generation, projects: [], sessions: [], totalSessionCount: 0 };
    }
    const query = input.query?.trim().toLowerCase() ?? "";
    const archivedProjects = registry.listArchived();
    const archivedProjectIds = new Set(archivedProjects.map((project) => project.id));
    const workspaceProjectIds = new Map(registry.listSessionWorkspaces().map((record) => [record.sessionId, record.projectId]));
    const projectById = new Map(registry.list().map((project) => [project.id, project]));
    const projectIdFor = (session: Pick<SessionInfo, "id" | "cwd">) => workspaceProjectIds.get(session.id) ?? projectIdForCwd(session.cwd);
    const projectFor = (session: Pick<SessionInfo, "id" | "cwd">) => projectById.get(projectIdFor(session));
    const projects: ArchivedProjectSummary[] = archivedProjects
      .filter((project) => !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query))
      .map((project) => ({
        id: project.id,
        label: project.label,
        sessionCount: this.sessions.filter((session) => projectIdFor(session) === project.id).length,
        archivedAt: project.archivedAt!,
      }));
    const archiveRecords = new Map(registry.listArchivedSessions().map((record) => [record.id, record.archivedAt]));
    const source = this.sessions
      .filter((session) => archiveRecords.has(session.id))
      .filter((session) => !archivedProjectIds.has(projectIdFor(session)))
      .filter((session) => !query || `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase().includes(query))
      .sort((left, right) => Date.parse(archiveRecords.get(right.id)!) - Date.parse(archiveRecords.get(left.id)!));
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const offset = cursorId ? source.findIndex((session) => session.id === cursorId) + 1 : 0;
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const page = cursorId && offset === 0 ? [] : source.slice(offset, offset + limit);
    const sessionLookup = this.sessionLookup();
    const sessions: ArchivedSessionSummary[] = page.map((session) => ({
      ...this.summary(session, options, sessionLookup, projectIdFor, projectFor),
      active: false,
      runtimeState: "sleeping",
      archivedAt: archiveRecords.get(session.id)!,
    }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: options.generation,
      projects,
      sessions,
      totalSessionCount: source.length,
      ...(offset + page.length < source.length && page.length ? { nextCursor: encodeCursor(page.at(-1)!.id) } : {}),
    };
  }

  private async refresh(): Promise<void> {
    if (this.scan) return this.scan;
    if (this.scannedAt && Date.now() - this.scannedAt < REFRESH_MS && !this.dirtySessions.size) return;
    this.scan = this.refreshPending().finally(() => {
      this.scan = undefined;
    });
    return this.scan;
  }

  private async refreshPending(): Promise<void> {
    while (true) {
      if (!this.scannedAt || Date.now() - this.scannedAt >= REFRESH_MS) {
        if (this.cache) {
          const cache = this.cache;
          const indexed = await cache.scan();
          if (cache !== this.cache) continue;
          this.sessions = indexed.map((item) => item.session);
          this.metadata = new Map(indexed.map((item) => [item.session.id, item.metadata]));
        } else {
          this.sessions = await SessionManager.listAll();
        }
        this.scannedAt = Date.now();
        continue;
      }
      if (!this.dirtySessions.size) return;
      const pending = [...this.dirtySessions.entries()];
      this.dirtySessions.clear();
      for (const [sessionId, target] of pending) {
        if (!this.cache) {
          const sessions = await SessionManager.list(target.cwd, dirname(target.path));
          const previousIds = this.sessions
            .filter((session) => session.id === sessionId || dirname(session.path) === dirname(target.path))
            .map((session) => session.id);
          this.sessions = [
            ...this.sessions.filter((session) => !previousIds.includes(session.id)),
            ...sessions,
          ];
          const currentIds = new Set(sessions.map((session) => session.id));
          for (const id of previousIds) if (!currentIds.has(id)) this.metadata.delete(id);
          continue;
        }
        const cache = this.cache;
        const indexed = await cache.refresh(sessionId, target.path);
        if (cache !== this.cache) continue;
        const replacementId = indexed?.session.id;
        const removedIds = this.sessions
          .filter((session) => session.id === sessionId || replacementId && session.id === replacementId)
          .map((session) => session.id);
        this.sessions = this.sessions.filter((session) => !removedIds.includes(session.id));
        for (const id of removedIds) this.metadata.delete(id);
        if (indexed) {
          this.sessions.push(indexed.session);
          this.metadata.set(indexed.session.id, indexed.metadata);
        }
      }
    }
  }

  private summary(
    session: SessionInfo,
    options: SessionIndexOptions,
    sessionLookup: Map<string, SessionInfo>,
    projectIdFor: (session: Pick<SessionInfo, "id" | "cwd">) => string = (value) => this.projectId(value),
    projectFor: (session: Pick<SessionInfo, "id" | "cwd">) => { label: string } | undefined = (value) => this.registry?.projectForSession(value.id, value.cwd),
  ): SessionSummary {
    let manager: SessionManager | undefined;
    const open = () => manager ??= SessionManager.open(session.path);
    const metadata = this.metadataFor(session, open);
    const userMessageCount = options.userCountFor?.(session.id) ?? metadata.userMessageCount;
    const owner = metadata.owner;
    const project = projectFor(session);
    const workStartedAt = options.workStartedAtFor?.(session.id);
    const parent = owner
      ? sessionLookup.get(this.sessionKey(owner.id, session.cwd, owner.file))
      : undefined;
    const parentTitle = parent ? (parent.name || parent.firstMessage || "Untitled session").slice(0, 200) : undefined;
    return {
      id: session.id.slice(0, 128),
      projectId: projectIdFor(session),
      ...(session.name ? { name: session.name.slice(0, 200) } : {}),
      ...(parent && parentTitle ? { parentSession: { id: parent.id.slice(0, 128), title: parentTitle } } : {}),
      cwdLabel: project?.label ?? (basename(session.cwd) || "Workspace"),
      createdAt: session.created.toISOString(),
      modifiedAt: session.modified.toISOString(),
      ...(workStartedAt ? { workStartedAt } : {}),
      userMessageCount,
      preview: session.firstMessage.slice(0, 500),
      active: session.id === options.activeId,
      pinned: options.pinnedFor?.(session.id) ?? false,
      runtimeState: options.stateFor(session.id),
    };
  }

  private metadataFor(session: SessionInfo, open: () => SessionManager) {
    try {
      const file = statSync(session.path);
      const cached = this.metadata.get(session.id);
      if (cached?.path === session.path && cached.mtimeMs === file.mtimeMs && cached.ctimeMs === file.ctimeMs && cached.size === file.size) return cached;
      const entries = open().getEntries();
      const owner = readSpawnOwner(entries);
      const metadata = {
        path: session.path,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        size: file.size,
        userMessageCount: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
        ...(owner ? { owner } : {}),
      };
      this.metadata.set(session.id, metadata);
      return metadata;
    } catch {
      return { path: session.path, mtimeMs: 0, ctimeMs: 0, size: 0, userMessageCount: 0 };
    }
  }

  private sessionKey(id: string, cwd: string, path: string): string {
    return `${id}\0${canonicalPath(cwd)}\0${canonicalPath(path)}`;
  }

  private sessionLookup(): Map<string, SessionInfo> {
    return new Map(this.sessions.map((session) => [this.sessionKey(session.id, session.cwd, session.path), session]));
  }

  private projectLabels(sessions: SessionInfo[], projectIdFor: (session: Pick<SessionInfo, "id" | "cwd">) => string = (session) => this.projectId(session)): Map<string, string> {
    const rawLabels = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const id = projectIdFor(session);
      if (rawLabels.has(id)) continue;
      const label = basename(session.cwd) || "Workspace";
      rawLabels.set(id, label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    const indexes = new Map<string, number>();
    for (const [id, label] of rawLabels) {
      if ((counts.get(label) ?? 0) === 1) {
        labels.set(id, label);
        continue;
      }
      const index = (indexes.get(label) ?? 0) + 1;
      indexes.set(label, index);
      labels.set(id, `${label} (${index})`);
    }
    return labels;
  }

  private projectId(session: Pick<SessionInfo, "id" | "cwd">): string {
    return this.registry?.projectForSession(session.id, session.cwd)?.id ?? projectIdForCwd(session.cwd);
  }
}

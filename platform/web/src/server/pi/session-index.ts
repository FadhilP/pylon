import { basename } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, ArchivedProjectSummary, ArchivedSessionSummary, SessionListSnapshot, SessionProjectPage, SessionSummary } from "../../shared/protocol/snapshots.ts";
import type { SessionListQuery } from "../../shared/protocol/snapshots.ts";
import { projectIdForCwd, type ProjectRegistry } from "./project-registry.ts";

const REFRESH_MS = 60_000;

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
  activeFallback?: SessionInfo;
  fallbacks?: SessionInfo[];
  userCountFor?: (sessionId: string) => number | undefined;
}

export class SessionIndex {
  private sessions: SessionInfo[] = [];
  private userCounts = new Map<string, number>();
  private scannedAt = 0;
  private scan?: Promise<void>;

  constructor(private registry?: ProjectRegistry) {}

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

  remove(sessionId: string): void {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    this.userCounts.delete(sessionId);
  }

  async list(input: SessionListQuery, options: SessionIndexOptions): Promise<SessionListSnapshot> {
    await this.refresh();
    const registered = this.registry?.list();
    const registeredIds = registered ? new Set(registered.map((project) => project.id)) : undefined;
    const fallbacks = options.fallbacks ?? (options.activeFallback ? [options.activeFallback] : []);
    const missing = fallbacks.filter((fallback) => {
      if (this.sessions.some((session) => session.id === fallback.id)) return false;
      return (options.userCountFor?.(fallback.id) ?? fallback.messageCount) > 0;
    });
    const source = [...missing, ...this.sessions]
      .filter((session) => !registeredIds || registeredIds.has(this.projectId(session)))
      .filter((session) => !this.registry?.isSessionArchived(session.id))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime());
    const query = input.query?.trim().toLowerCase() ?? "";
    const filtered = query
      ? source.filter((session) => `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase().includes(query))
      : source;
    const grouped = new Map<string, SessionInfo[]>();
    for (const session of filtered) {
      const projectId = this.projectId(session);
      if (input.projectId && projectId !== input.projectId) continue;
      const group = grouped.get(projectId) ?? [];
      group.push(session);
      grouped.set(projectId, group);
    }
    const labels = this.projectLabels(source);
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const limit = Math.min(100, Math.max(1, input.limit ?? 10));
    const projects: SessionProjectPage[] = [];
    const projectEntries = registered
      ? registered
          .filter((project) => !input.projectId || project.id === input.projectId)
          .filter((project) => !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query) || grouped.has(project.id))
          .map((project) => [project.id, grouped.get(project.id) ?? [], project.label] as const)
      : [...grouped].slice(0, 100).map(([id, sessions]) => [id, sessions, labels.get(id)] as const);
    for (const [id, sessions, registeredLabel] of projectEntries) {
      const offset = cursorId ? sessions.findIndex((session) => session.id === cursorId) + 1 : 0;
      if (cursorId && offset === 0) continue;
      const page = sessions.slice(offset, offset + limit);
      projects.push({
        id,
        label: registeredLabel ?? labels.get(id) ?? (basename(sessions[0]?.cwd ?? "") || "Workspace"),
        totalCount: sessions.length,
        sessions: page.map((session) => this.summary(session, options)),
        ...(offset + page.length < sessions.length && page.length
          ? { nextCursor: encodeCursor(page.at(-1)!.id) }
          : {}),
      });
    }
    const activeSessions = source
      .filter((session) => options.activeFor?.(session.id) ?? options.stateFor(session.id) !== "sleeping")
      .slice(0, 100)
      .map((session) => this.summary(session, options));
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
    const projects: ArchivedProjectSummary[] = archivedProjects
      .filter((project) => !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query))
      .map((project) => ({
        id: project.id,
        label: project.label,
        sessionCount: this.sessions.filter((session) => this.projectId(session) === project.id).length,
        archivedAt: project.archivedAt!,
      }));
    const archiveRecords = new Map(registry.listArchivedSessions().map((record) => [record.id, record.archivedAt]));
    const source = this.sessions
      .filter((session) => archiveRecords.has(session.id))
      .filter((session) => !archivedProjectIds.has(this.projectId(session)))
      .filter((session) => !query || `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase().includes(query))
      .sort((left, right) => Date.parse(archiveRecords.get(right.id)!) - Date.parse(archiveRecords.get(left.id)!));
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const offset = cursorId ? source.findIndex((session) => session.id === cursorId) + 1 : 0;
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const page = cursorId && offset === 0 ? [] : source.slice(offset, offset + limit);
    const sessions: ArchivedSessionSummary[] = page.map((session) => ({
      ...this.summary(session, options),
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
    if (this.sessions.length && Date.now() - this.scannedAt < REFRESH_MS) return;
    if (this.scan) return this.scan;
    this.scan = SessionManager.listAll().then((sessions) => {
      this.sessions = sessions;
      this.scannedAt = Date.now();
    }).finally(() => {
      this.scan = undefined;
    });
    return this.scan;
  }

  private summary(session: SessionInfo, options: SessionIndexOptions): SessionSummary {
    let userMessageCount = options.userCountFor?.(session.id) ?? this.userCounts.get(session.id);
    if (userMessageCount === undefined) {
      try {
        userMessageCount = SessionManager.open(session.path).getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "user").length;
      } catch {
        userMessageCount = 0;
      }
      this.userCounts.set(session.id, userMessageCount);
    }
    const project = this.registry?.projectForSession(session.id, session.cwd);
    return {
      id: session.id.slice(0, 128),
      projectId: this.projectId(session),
      ...(session.name ? { name: session.name.slice(0, 200) } : {}),
      cwdLabel: project?.label ?? (basename(session.cwd) || "Workspace"),
      createdAt: session.created.toISOString(),
      modifiedAt: session.modified.toISOString(),
      userMessageCount,
      preview: session.firstMessage.slice(0, 500),
      active: session.id === options.activeId,
      runtimeState: options.stateFor(session.id),
    };
  }

  private projectLabels(sessions: SessionInfo[]): Map<string, string> {
    const rawLabels = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const id = this.projectId(session);
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

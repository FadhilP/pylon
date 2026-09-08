import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type {
  ArchiveListQuery,
  ArchiveListSnapshot,
  ArchiveSourceSummary,
  ArchivedProjectSummary,
  ArchivedSessionSummary,
  SessionListSnapshot,
  SessionProjectPage,
  SessionSummary,
  UsageQuery,
  UsageSnapshot,
} from "../../shared/protocol/snapshots.ts";
import type { SessionListQuery } from "../../shared/protocol/snapshots.ts";
import { projectIdForCwd, type ProjectRegistry } from "../workspace/project-registry.ts";
import {
  mapLimit,
  readSessionMetadata,
  SessionSummaryCache,
  type SessionFileMetadata,
} from "./session-summary-cache.ts";
import { aggregateUsage, type UsageRateLookup } from "../usage/usage-aggregation.ts";
import type { PersistedUsageAtom } from "../usage/usage-history.ts";

const REFRESH_MS = 60_000;
const canonicalPath = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

export { projectIdForCwd } from "../workspace/project-registry.ts";

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

function filterSessionsByQuery(sessions: SessionInfo[], query: string): SessionInfo[] {
  if (!query) return sessions;
  const exact = sessions.find(session => session.id.toLowerCase() === query);
  if (exact) return [exact];
  return sessions.filter(
    session =>
      session.id.toLowerCase().includes(query) ||
      `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`
        .toLowerCase()
        .includes(query),
  );
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
  /** Model pricing, used to split a delegated total that was logged without one. */
  rates?: UsageRateLookup;
  workStartedAtFor?: (sessionId: string) => string | undefined;
  todoProgressFor?: (sessionId: string) => SessionSummary["todoProgress"];
  runningUnderParentSessionIdFor?: (sessionId: string) => string | undefined;
}

export class SessionIndex {
  private sessions: SessionInfo[] = [];
  private metadata = new Map<string, SessionFileMetadata>();
  private usageBySession = new Map<string, PersistedUsageAtom[]>();
  private dirtySessions = new Map<string, { path: string; cwd: string }>();
  private scannedAt = 0;
  private scan?: Promise<void>;
  private cache?: SessionSummaryCache;
  private agentDir?: string;
  private epoch = 0;
  private retiring = new Set<Promise<void>>();
  private retirementError?: unknown;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private registry?: ProjectRegistry,
    agentDir = process.env.PI_CODING_AGENT_DIR,
  ) {
    this.agentDir = agentDir;
    if (agentDir) this.cache = this.createCache(agentDir);
  }

  setAgentDir(agentDir: string): void {
    const previous = this.cache;
    this.epoch++;
    this.agentDir = agentDir;
    this.cache = this.closed ? undefined : this.createCache(agentDir);
    if (previous) this.retire(previous);
    this.sessions = [];
    this.metadata.clear();
    this.usageBySession.clear();
    this.dirtySessions.clear();
    this.scan = undefined;
    this.invalidate();
  }

  setProjectRegistry(registry: ProjectRegistry): void {
    this.registry = registry;
    this.invalidate();
  }

  async resolve(sessionId: string): Promise<SessionInfo | undefined> {
    await this.refresh();
    return this.sessions.find(session => session.id === sessionId);
  }

  async all(): Promise<SessionInfo[]> {
    await this.refresh();
    return [...this.sessions];
  }

  async usage(input: UsageQuery, options: SessionIndexOptions): Promise<UsageSnapshot> {
    await this.refresh();
    const workspaceProjectIds = new Map(
      this.registry?.listSessionWorkspaces().map(record => [record.sessionId, record.projectId]),
    );
    return aggregateUsage(
      this.sessions.map(session => ({ session, usage: this.usageBySession.get(session.id) ?? [] })),
      input,
      options.generation,
      (sessionId, cwd) => {
        const id = workspaceProjectIds.get(sessionId) ?? projectIdForCwd(cwd);
        const project = this.registry?.get(id);
        return { id, label: project?.label ?? (basename(cwd) || "Workspace") };
      },
      new Date(),
      this.cache?.unreadableFileCount() ?? 0,
      options.rates,
    );
  }

  invalidate(): void {
    this.scannedAt = 0;
  }

  invalidateSession(sessionId: string, path?: string, cwd?: string): void {
    const current = this.sessions.find(session => session.id === sessionId);
    const sessionPath = path || current?.path;
    const sessionCwd = cwd || current?.cwd;
    if (!sessionPath || !sessionCwd) {
      this.invalidate();
      return;
    }
    this.dirtySessions.set(sessionId, { path: sessionPath, cwd: sessionCwd });
  }

  remove(sessionId: string): void {
    const current = this.sessions.find(session => session.id === sessionId);
    if (current) this.dirtySessions.set(sessionId, { path: current.path, cwd: current.cwd });
    this.sessions = this.sessions.filter(session => session.id !== sessionId);
    this.metadata.delete(sessionId);
    this.usageBySession.delete(sessionId);
  }

  async list(input: SessionListQuery, options: SessionIndexOptions): Promise<SessionListSnapshot> {
    await this.refresh();
    const registered = this.registry ? [...this.registry.list(), this.registry.generalProject()] : undefined;
    const registeredById = registered ? new Map(registered.map(project => [project.id, project])) : undefined;
    const registeredIds = registeredById ? new Set(registeredById.keys()) : undefined;
    const workspaceProjectIds = new Map(
      this.registry?.listSessionWorkspaces().map(record => [record.sessionId, record.projectId]),
    );
    const archivedIds = new Set(this.registry?.listArchivedSessions().map(record => record.id));
    const projectIdFor = (session: Pick<SessionInfo, "id" | "cwd">) =>
      workspaceProjectIds.get(session.id) ?? projectIdForCwd(session.cwd);
    const projectFor = (session: Pick<SessionInfo, "id" | "cwd">) => registeredById?.get(projectIdFor(session));
    const fallbacks = options.fallbacks ?? (options.activeFallback ? [options.activeFallback] : []);
    const missing = fallbacks.filter(fallback => {
      if (this.sessions.some(session => session.id === fallback.id)) return false;
      return (options.userCountFor?.(fallback.id) ?? fallback.messageCount) > 0;
    });
    const source = [...missing, ...this.sessions]
      .filter(session => !registeredIds || registeredIds.has(projectIdFor(session)))
      .filter(session => !archivedIds.has(session.id));
    const query = input.query?.trim().toLowerCase() ?? "";
    const filtered = filterSessionsByQuery(source, query).sort(
      (left, right) => right.modified.getTime() - left.modified.getTime(),
    );
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
    const sessionLookup = this.sessionLookup();
    const projectEntries = registered
      ? registered
          .filter(project => !input.projectId || project.id === input.projectId)
          .filter(
            project =>
              !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query) || grouped.has(project.id),
          )
          .map(project => [project.id, grouped.get(project.id) ?? [], project.label, project.cwd] as const)
      : [...grouped].slice(0, 100).map(([id, sessions]) => [id, sessions, labels.get(id), sessions[0]!.cwd] as const);
    const pages = projectEntries.flatMap(([id, sessions, registeredLabel, cwd]) => {
      const offset = cursorId ? sessions.findIndex(session => session.id === cursorId) + 1 : 0;
      return cursorId && offset === 0
        ? []
        : [{ id, sessions, registeredLabel, cwd, offset, page: sessions.slice(offset, offset + limit) }];
    });
    const activeOrder = new Map((this.registry?.listActiveSessionOrder() ?? []).map((id, index) => [id, index]));
    const active = source
      .filter(session => options.activeFor?.(session.id) ?? options.stateFor(session.id) !== "sleeping")
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
      .slice(0, 100);
    const metadata = await this.preloadMetadata([...pages.flatMap(item => item.page), ...active]);
    const projects: SessionProjectPage[] = pages.map(({ id, sessions, registeredLabel, cwd, offset, page }) => ({
      id,
      label: registeredLabel ?? labels.get(id) ?? (basename(sessions[0]?.cwd ?? "") || "Workspace"),
      cwd,
      totalCount: sessions.length,
      sessions: page.map(session => this.summary(session, options, sessionLookup, metadata, projectIdFor, projectFor)),
      ...(offset + page.length < sessions.length && page.length ? { nextCursor: encodeCursor(page.at(-1)!.id) } : {}),
    }));
    const activeSessions = active.map(session =>
      this.summary(session, options, sessionLookup, metadata, projectIdFor, projectFor),
    );
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: options.generation, activeSessions, projects };
  }

  async listArchived(input: ArchiveListQuery, options: SessionIndexOptions): Promise<ArchiveListSnapshot> {
    await this.refresh();
    const registry = this.registry;
    if (!registry) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        sessionGeneration: options.generation,
        projects: [],
        sessions: [],
        sources: [],
        totalSessionCount: 0,
      };
    }
    const query = input.query?.trim().toLowerCase() ?? "";
    const archivedProjects = registry.listArchived();
    const archivedProjectIds = new Set(archivedProjects.map(project => project.id));
    const workspaceProjectIds = new Map(
      registry.listSessionWorkspaces().map(record => [record.sessionId, record.projectId]),
    );
    const projectById = new Map([...registry.list(), registry.generalProject()].map(project => [project.id, project]));
    const projectIdFor = (session: Pick<SessionInfo, "id" | "cwd">) =>
      workspaceProjectIds.get(session.id) ?? projectIdForCwd(session.cwd);
    const projectFor = (session: Pick<SessionInfo, "id" | "cwd">) => projectById.get(projectIdFor(session));
    const projects: ArchivedProjectSummary[] = archivedProjects
      .filter(project => !query || `${project.label} ${project.cwd}`.toLowerCase().includes(query))
      .map(project => ({
        id: project.id,
        label: project.label,
        sessionCount: this.sessions.filter(session => projectIdFor(session) === project.id).length,
        archivedAt: project.archivedAt!,
      }));
    const archiveRecords = new Map(registry.listArchivedSessions().map(record => [record.id, record.archivedAt]));
    const archivedSessions = this.sessions.filter(session => archiveRecords.has(session.id));
    const matching = filterSessionsByQuery(archivedSessions, query)
      .filter(session => !archivedProjectIds.has(projectIdFor(session)))
      .sort((left, right) => Date.parse(archiveRecords.get(right.id)!) - Date.parse(archiveRecords.get(left.id)!));
    /* The sources are counted over everything the search matched, not over the
       page — a count that only described one page would promise rows the next
       press cannot show. */
    const counts = new Map<string, ArchiveSourceSummary>();
    for (const session of matching) {
      const id = projectIdFor(session);
      const existing = counts.get(id);
      if (existing) existing.count++;
      else counts.set(id, { id, label: projectFor(session)?.label ?? basename(session.cwd), count: 1 });
    }
    const sources = [...counts.values()].sort((left, right) => left.label.localeCompare(right.label));
    const source = input.projectId ? matching.filter(session => projectIdFor(session) === input.projectId) : matching;
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const offset = cursorId ? source.findIndex(session => session.id === cursorId) + 1 : 0;
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const page = cursorId && offset === 0 ? [] : source.slice(offset, offset + limit);
    const sessionLookup = this.sessionLookup();
    const metadata = await this.preloadMetadata(page);
    const sessions: ArchivedSessionSummary[] = page.map(session => ({
      ...this.summary(session, options, sessionLookup, metadata, projectIdFor, projectFor),
      active: false,
      runtimeState: "sleeping",
      archivedAt: archiveRecords.get(session.id)!,
    }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: options.generation,
      /* A chosen source is a project's sessions, so the archived-projects
         section is not part of that answer. */
      projects: input.projectId ? [] : projects,
      sessions,
      sources,
      totalSessionCount: source.length,
      ...(offset + page.length < source.length && page.length ? { nextCursor: encodeCursor(page.at(-1)!.id) } : {}),
    };
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.epoch++;
    const active = this.cache;
    this.cache = undefined;
    if (active) this.retire(active);
    this.closePromise = (async () => {
      const settled = await Promise.allSettled([...this.retiring]);
      const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failed) throw failed.reason;
      if (this.retirementError) throw this.retirementError;
    })();
    return this.closePromise;
  }

  private createCache(agentDir: string): SessionSummaryCache {
    return new SessionSummaryCache(agentDir, { deferredPersistence: true });
  }

  private retire(cache: SessionSummaryCache): void {
    const closing = cache.close();
    this.retiring.add(closing);
    // A directory switch is synchronous, so observe this rejection immediately.
    void closing.then(
      () => this.retiring.delete(closing),
      error => {
        this.retiring.delete(closing);
        this.retirementError ??= error;
        console.error("Retired session summary cache failed to persist", error);
      },
    );
  }

  private async awaitRetiring(): Promise<void> {
    // A successor reading the same destination should not race a retired writer.
    await Promise.allSettled([...this.retiring]);
  }

  private async refresh(): Promise<void> {
    if (this.closed) throw new Error("session index is closed");
    if (this.scan) return this.scan;
    if (this.scannedAt && Date.now() - this.scannedAt < REFRESH_MS && !this.dirtySessions.size) return;
    const epoch = this.epoch;
    let scan: Promise<void>;
    scan = this.refreshPending(epoch).then(() => {
      if (epoch !== this.epoch || this.closed) throw new Error("Session index changed while loading sessions");
    }).finally(() => {
      if (this.scan === scan) this.scan = undefined;
    });
    this.scan = scan;
    return scan;
  }

  private async refreshPending(epoch: number): Promise<void> {
    await this.awaitRetiring();
    while (epoch === this.epoch && !this.closed) {
      if (!this.scannedAt || Date.now() - this.scannedAt >= REFRESH_MS) {
        const cache = this.cache;
        if (cache) {
          const indexed = await cache.scan();
          if (epoch !== this.epoch || cache !== this.cache) return;
          this.sessions = indexed.map(item => item.session);
          this.metadata = new Map(indexed.map(item => [item.session.id, item.metadata]));
          this.usageBySession = new Map(indexed.map(item => [item.session.id, item.usage]));
        } else {
          const sessions = await SessionManager.listAll();
          if (epoch !== this.epoch) return;
          this.sessions = sessions;
          this.usageBySession.clear();
        }
        this.scannedAt = Date.now();
        continue;
      }
      if (!this.dirtySessions.size) return;
      const pending = [...this.dirtySessions.entries()];
      this.dirtySessions.clear();
      const cache = this.cache;
      const indexedPending = cache
        ? await cache.refreshMany(pending.map(([sessionId, target]) => ({ sessionId, path: target.path })))
        : undefined;
      if (epoch !== this.epoch || cache !== this.cache) return;
      for (const [pendingIndex, [sessionId, target]] of pending.entries()) {
        if (!cache) {
          const sessions = await SessionManager.list(target.cwd, dirname(target.path));
          if (epoch !== this.epoch || cache !== this.cache) return;
          const previousIds = this.sessions
            .filter(session => session.id === sessionId || dirname(session.path) === dirname(target.path))
            .map(session => session.id);
          this.sessions = [...this.sessions.filter(session => !previousIds.includes(session.id)), ...sessions];
          const currentIds = new Set(sessions.map(session => session.id));
          for (const id of previousIds) if (!currentIds.has(id)) this.metadata.delete(id);
          for (const id of previousIds) this.usageBySession.delete(id);
          continue;
        }
        const indexed = indexedPending![pendingIndex];
        const replacementId = indexed?.session.id;
        const removedIds = this.sessions
          .filter(session => session.id === sessionId || (replacementId && session.id === replacementId))
          .map(session => session.id);
        this.sessions = this.sessions.filter(session => !removedIds.includes(session.id));
        for (const id of removedIds) this.metadata.delete(id);
        for (const id of removedIds) this.usageBySession.delete(id);
        if (indexed) {
          this.sessions.push(indexed.session);
          this.metadata.set(indexed.session.id, indexed.metadata);
          this.usageBySession.set(indexed.session.id, indexed.usage);
        }
      }
    }
  }

  private async preloadMetadata(sessions: SessionInfo[]): Promise<Map<string, SessionFileMetadata | undefined>> {
    const epoch = this.epoch;
    const priorMetadata = this.metadata;
    const unique = new Map<string, SessionInfo>();
    for (const session of sessions) unique.set(this.sessionKey(session.id, session.path), session);
    const values = await mapLimit([...unique.values()], async session => {
      const candidate = priorMetadata.get(session.id);
      const cached = candidate?.path === session.path ? candidate : undefined;
      try {
        const file = await stat(session.path);
        if (
          cached &&
          cached.path === session.path &&
          cached.mtimeMs === file.mtimeMs &&
          cached.ctimeMs === file.ctimeMs &&
          cached.size === file.size
        )
          return cached;
        const metadata = await readSessionMetadata(session.path, session.id);
        // A read failure is not evidence that a session was deleted. Keep a
        // prior value and let the authoritative cache scan reconcile it later.
        if (!metadata) return cached;
        if (epoch === this.epoch && !this.closed) this.metadata.set(session.id, metadata);
        return metadata;
      } catch {
        return cached;
      }
    });
    if (epoch !== this.epoch || this.closed) throw new Error("Session index changed while loading metadata");
    const result = new Map<string, SessionFileMetadata | undefined>();
    for (const [index, session] of [...unique.values()].entries()) {
      result.set(this.sessionKey(session.id, session.path), values[index]);
    }
    return result;
  }

  private summary(
    session: SessionInfo,
    options: SessionIndexOptions,
    sessionLookup: Map<string, SessionInfo | undefined>,
    metadataBySession: Map<string, SessionFileMetadata | undefined>,
    projectIdFor: (session: Pick<SessionInfo, "id" | "cwd">) => string = value => this.projectId(value),
    projectFor: (session: Pick<SessionInfo, "id" | "cwd">) => { label: string } | undefined = value =>
      this.registry?.projectForSession(value.id, value.cwd),
  ): SessionSummary {
    const metadata = metadataBySession.get(this.sessionKey(session.id, session.path));
    const userMessageCount = options.userCountFor?.(session.id) ?? metadata?.userMessageCount ?? 0;
    const owner = metadata?.owner;
    const project = projectFor(session);
    const workStartedAt = options.workStartedAtFor?.(session.id);
    const todoProgress = options.todoProgressFor?.(session.id);
    const runningUnderParentSessionId = options.runningUnderParentSessionIdFor?.(session.id);
    const parent = owner ? this.parentSession(owner, sessionLookup) : undefined;
    const parentTitle = parent ? (parent.name || parent.firstMessage || "Untitled session").slice(0, 200) : undefined;
    return {
      id: session.id.slice(0, 128),
      projectId: projectIdFor(session),
      ...(session.name ? { name: session.name.slice(0, 200) } : {}),
      ...(parent && parentTitle ? { parentSession: { id: parent.id.slice(0, 128), title: parentTitle } } : {}),
      ...(runningUnderParentSessionId
        ? { runningUnderParentSessionId: runningUnderParentSessionId.slice(0, 128) }
        : {}),
      cwdLabel: project?.label ?? (basename(session.cwd) || "Workspace"),
      createdAt: session.created.toISOString(),
      modifiedAt: session.modified.toISOString(),
      ...(workStartedAt ? { workStartedAt } : {}),
      ...(todoProgress ? { todoProgress } : {}),
      userMessageCount,
      preview: session.firstMessage.slice(0, 500),
      active: session.id === options.activeId,
      pinned: options.pinnedFor?.(session.id) ?? false,
      runtimeState: options.stateFor(session.id),
    };
  }

  private sessionKey(id: string, path: string): string {
    return `${id}\0${canonicalPath(path)}`;
  }

  private parentSession(
    owner: NonNullable<SessionFileMetadata["owner"]>,
    sessions: Map<string, SessionInfo | undefined>,
  ): SessionInfo | undefined {
    const exact = sessions.get(this.sessionKey(owner.id, owner.file));
    if (exact) return exact;
    const migratedPath = this.migratedOwnerPath(owner.file);
    return migratedPath ? sessions.get(this.sessionKey(owner.id, migratedPath)) : undefined;
  }

  private migratedOwnerPath(path: string): string | undefined {
    if (!this.agentDir) return;
    const agentDir = canonicalPath(this.agentDir);
    if (basename(agentDir) !== "agent" || basename(dirname(agentDir)) !== ".pylon") return;
    const legacyAgentDir = resolve(dirname(dirname(agentDir)), ".pi", "agent");
    const remainder = relative(canonicalPath(legacyAgentDir), canonicalPath(path));
    if (!remainder || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) return;
    return resolve(agentDir, remainder);
  }

  private sessionLookup(): Map<string, SessionInfo | undefined> {
    const result = new Map<string, SessionInfo | undefined>();
    for (const session of this.sessions) {
      const key = this.sessionKey(session.id, session.path);
      result.set(key, result.has(key) ? undefined : session);
    }
    return result;
  }

  private projectLabels(
    sessions: SessionInfo[],
    projectIdFor: (session: Pick<SessionInfo, "id" | "cwd">) => string = session => this.projectId(session),
  ): Map<string, string> {
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

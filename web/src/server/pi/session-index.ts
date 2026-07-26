import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { SessionListSnapshot, SessionProjectPage, SessionSummary } from "../../shared/protocol/snapshots.ts";
import type { SessionListQuery } from "../../shared/protocol/snapshots.ts";

const REFRESH_MS = 60_000;

export function projectIdForCwd(cwd: string): string {
  if (!cwd) return "project-legacy";
  const normalized = resolve(cwd).replaceAll("\\", "/");
  const identity = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `project-${createHash("sha256").update(identity).digest("base64url").slice(0, 22)}`;
}

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
  activeFallback?: SessionInfo;
  fallbacks?: SessionInfo[];
  userCountFor?: (sessionId: string) => number | undefined;
}

export class SessionIndex {
  private sessions: SessionInfo[] = [];
  private userCounts = new Map<string, number>();
  private scannedAt = 0;
  private scan?: Promise<void>;

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
    const fallbacks = options.fallbacks ?? (options.activeFallback ? [options.activeFallback] : []);
    const missing = fallbacks.filter((fallback) => !this.sessions.some((session) => session.id === fallback.id));
    const source = [...missing, ...this.sessions].sort((left, right) => right.modified.getTime() - left.modified.getTime());
    const query = input.query?.trim().toLowerCase() ?? "";
    const filtered = query
      ? source.filter((session) => `${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase().includes(query))
      : source;
    const grouped = new Map<string, SessionInfo[]>();
    for (const session of filtered) {
      const projectId = projectIdForCwd(session.cwd);
      if (input.projectId && projectId !== input.projectId) continue;
      const group = grouped.get(projectId) ?? [];
      group.push(session);
      grouped.set(projectId, group);
    }
    const labels = this.projectLabels(source);
    const cursorId = input.cursor ? decodeSessionCursor(input.cursor) : undefined;
    const limit = Math.min(100, Math.max(1, input.limit ?? 10));
    const projects: SessionProjectPage[] = [];
    for (const [id, sessions] of [...grouped].slice(0, 100)) {
      const offset = cursorId ? sessions.findIndex((session) => session.id === cursorId) + 1 : 0;
      if (cursorId && offset === 0) continue;
      const page = sessions.slice(offset, offset + limit);
      projects.push({
        id,
        label: labels.get(id) ?? (basename(sessions[0]?.cwd ?? "") || "Workspace"),
        totalCount: sessions.length,
        sessions: page.map((session) => this.summary(session, options)),
        ...(offset + page.length < sessions.length && page.length
          ? { nextCursor: encodeCursor(page.at(-1)!.id) }
          : {}),
      });
    }
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: options.generation, projects };
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
    return {
      id: session.id.slice(0, 128),
      projectId: projectIdForCwd(session.cwd),
      ...(session.name ? { name: session.name.slice(0, 200) } : {}),
      cwdLabel: basename(session.cwd) || "Workspace",
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
      const id = projectIdForCwd(session.cwd);
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
}

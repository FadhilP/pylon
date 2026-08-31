import { resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { UsageQuery, UsageRecord, UsageSnapshot } from "../../shared/protocol/snapshots.ts";
import type { PersistedUsageAtom } from "./usage-history.ts";

const MAX_RECORDS = 50_000;
const MAX_SESSIONS = 10_000;
export const MAX_USAGE_DAYS = 90;
const safeAdd = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
const DAY_MS = 24 * 60 * 60 * 1_000;
const canonicalPath = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
export function usageWindow(input: UsageQuery, now = new Date()): { fromInclusive: number; toExclusive: number } {
  if (input.days !== undefined && (input.from !== undefined || input.through !== undefined))
    throw new Error("days cannot be combined with calendar bounds");
  if (input.from === undefined && input.through === undefined) {
    const days = input.days ?? 30;
    return { fromInclusive: now.getTime() - days * DAY_MS, toExclusive: now.getTime() };
  }
  if (input.from === undefined || input.through === undefined) throw new Error("from and through are both required");
  const parse = (value: string): number => {
    if (!calendarDate.test(value)) throw new Error("invalid calendar date");
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
      throw new Error("invalid calendar date");
    return parsed;
  };
  const from = parse(input.from);
  const through = parse(input.through);
  const today = new Date(now.getTime());
  today.setUTCHours(0, 0, 0, 0);
  if (from > through) throw new Error("calendar bounds are inverted");
  if (from > today.getTime() || through > today.getTime()) throw new Error("calendar bounds cannot be in the future");
  if ((through - from) / DAY_MS + 1 > MAX_USAGE_DAYS)
    throw new Error(`calendar range cannot exceed ${MAX_USAGE_DAYS} days`);
  return { fromInclusive: from, toExclusive: through + DAY_MS };
}
export interface UsageProject {
  id: string;
  label: string;
}

export interface UsageIndexedSession {
  session: SessionInfo;
  usage: readonly PersistedUsageAtom[];
}

export function aggregateUsage(
  indexed: readonly UsageIndexedSession[],
  input: UsageQuery,
  generation: number,
  projectFor: (sessionId: string, cwd: string) => UsageProject,
  now = new Date(),
  unreadableFiles = 0,
): UsageSnapshot {
  const { fromInclusive, toExclusive } = usageWindow(input, now);
  const sessions = [...indexed].sort(
    (left, right) =>
      left.session.created.getTime() - right.session.created.getTime() ||
      canonicalPath(left.session.path).localeCompare(canonicalPath(right.session.path)),
  );
  const seen = new Map<string, string>();
  const records = new Map<string, UsageRecord>();
  let conflictingDuplicates = 0;
  let unknownCostRecords = 0;
  let unknownAttributionRecords = 0;

  for (const indexedSession of sessions) {
    const session = indexedSession.session;
    const project = projectFor(session.id, session.cwd);
    for (const atom of indexedSession.usage) {
      const previous = seen.get(atom.identity);
      if (previous !== undefined) {
        if (previous !== atom.signature) conflictingDuplicates++;
        continue;
      }
      seen.set(atom.identity, atom.signature);
      const occurredAt = Date.parse(atom.timestamp);
      if (!Number.isFinite(occurredAt) || occurredAt < fromInclusive || occurredAt >= toExclusive) continue;
      if (!atom.costKnown) unknownCostRecords++;
      if (atom.provider === "unknown" || atom.model === "unknown" || atom.agent === "unknown")
        unknownAttributionRecords++;
      const day = new Date(occurredAt).toISOString().slice(0, 10);
      const key = JSON.stringify([day, session.id, project.id, atom.provider, atom.model, atom.agent]);
      const current = records.get(key) ?? {
        day,
        sessionId: session.id.slice(0, 128),
        projectId: project.id.slice(0, 128),
        projectLabel: project.label.slice(0, 256) || "Workspace",
        provider: atom.provider,
        model: atom.model,
        agent: atom.agent,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costKnown: true,
      };
      current.calls = safeAdd(current.calls, atom.calls);
      current.input = safeAdd(current.input, atom.input);
      current.output = safeAdd(current.output, atom.output);
      current.cacheRead = safeAdd(current.cacheRead, atom.cacheRead);
      current.cacheWrite = safeAdd(current.cacheWrite, atom.cacheWrite);
      current.cost = safeAdd(current.cost, atom.cost);
      current.costKnown = current.costKnown && atom.costKnown;
      records.set(key, current);
    }
  }

  const allRecords = [...records.values()].sort(
    (left, right) =>
      left.day.localeCompare(right.day) ||
      left.projectLabel.localeCompare(right.projectLabel) ||
      left.sessionId.localeCompare(right.sessionId) ||
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model) ||
      left.agent.localeCompare(right.agent),
  );
  let truncated = allRecords.length > MAX_RECORDS;
  let visibleRecords = truncated ? allRecords.slice(0, MAX_RECORDS) : allRecords;
  const visibleSessionIds = new Set<string>();
  visibleRecords = visibleRecords.filter(record => {
    if (visibleSessionIds.has(record.sessionId)) return true;
    if (visibleSessionIds.size >= MAX_SESSIONS) {
      truncated = true;
      return false;
    }
    visibleSessionIds.add(record.sessionId);
    return true;
  });

  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: generation,
    generatedAt: now.toISOString(),
    fromInclusive: new Date(fromInclusive).toISOString(),
    toExclusive: new Date(toExclusive).toISOString(),
    records: visibleRecords,
    sessions: sessions
      .filter(item => visibleSessionIds.has(item.session.id))
      .map(({ session }) => {
        const project = projectFor(session.id, session.cwd);
        return {
          id: session.id.slice(0, 128),
          projectId: project.id.slice(0, 128),
          projectLabel: project.label.slice(0, 256) || "Workspace",
          title: (session.name || session.firstMessage || "Untitled session").slice(0, 500),
          createdAt: session.created.toISOString(),
          modifiedAt: session.modified.toISOString(),
          elapsedMs: Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(0, session.modified.getTime() - session.created.getTime()),
          ),
        };
      })
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.id.localeCompare(right.id)),
    diagnostics: { unreadableFiles, conflictingDuplicates, unknownCostRecords, unknownAttributionRecords, truncated },
  };
}

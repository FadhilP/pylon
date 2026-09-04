import type { SessionListQuery, SessionListSnapshot, SessionProjectPage, SessionSummary } from "./protocol/snapshots.ts";

export const SESSION_LIST_INITIAL_LIMIT = 3;
export const SESSION_LIST_MORE_LIMIT = 5;

type ListSessions = (input: SessionListQuery, signal?: AbortSignal) => Promise<SessionListSnapshot>;

export async function listSessionsPreservingPages(
  listSessions: ListSessions,
  previousPages: SessionProjectPage[],
  query: string,
  signal?: AbortSignal,
): Promise<SessionListSnapshot> {
  const requestQuery = query ? { query } : {};
  const expandedPages = previousPages.filter(page => page.sessions.length > SESSION_LIST_INITIAL_LIMIT);
  const [initial, ...expanded] = await Promise.all([
    listSessions({ ...requestQuery, limit: SESSION_LIST_INITIAL_LIMIT }, signal),
    ...expandedPages.map(page =>
      listSessions({ ...requestQuery, projectId: page.id, limit: page.sessions.length }, signal),
    ),
  ]);
  if (!expanded.length) return initial;

  const pages = new Map(expanded.flatMap(result => result.projects.map(page => [page.id, page] as const)));
  return { ...initial, projects: initial.projects.map(page => pages.get(page.id) ?? page) };
}

export interface SessionSwitcherCatalog {
  activeSessions: SessionSummary[];
  projects: SessionProjectPage[];
}

export interface SessionSwitcherGroups {
  active: SessionSummary[];
  inactive: SessionSummary[];
  inactiveLimited: boolean;
}

/** Builds the compact composer list while preserving the catalog's existing order. */
export function groupSessionSwitcherSessions(
  catalog: SessionSwitcherCatalog,
  query = "",
  currentProjectId?: string,
  inactiveLimit = 5,
): SessionSwitcherGroups {
  const projectLabels = new Map(catalog.projects.map(project => [project.id, project.label.toLocaleLowerCase()]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (session: SessionSummary) =>
    !normalizedQuery ||
    (session.name || session.preview || "Untitled session").toLocaleLowerCase().includes(normalizedQuery) ||
    (projectLabels.get(session.projectId) ?? session.cwdLabel.toLocaleLowerCase()).includes(normalizedQuery);
  const prioritizeSearchResults = (sessions: SessionSummary[]) => {
    if (!normalizedQuery) return sessions;
    return [...sessions].sort((left, right) => {
      const leftCurrent = left.projectId === currentProjectId;
      const rightCurrent = right.projectId === currentProjectId;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
    });
  };
  const activeIds = new Set(catalog.activeSessions.map(session => session.id));
  const seen = new Set<string>();
  const active = prioritizeSearchResults(
    catalog.activeSessions.filter(session => {
      if (seen.has(session.id) || !matches(session)) return false;
      seen.add(session.id);
      return true;
    }),
  );
  const inactiveCandidates = prioritizeSearchResults(
    catalog.projects.flatMap(project =>
      project.sessions.filter(session => {
        if (activeIds.has(session.id) || seen.has(session.id) || !matches(session)) return false;
        seen.add(session.id);
        return true;
      }),
    ),
  );
  const inactiveLimited =
    !normalizedQuery &&
    (inactiveCandidates.length > inactiveLimit || catalog.projects.some(project => Boolean(project.nextCursor)));
  return {
    active,
    inactive: normalizedQuery ? inactiveCandidates : inactiveCandidates.slice(0, inactiveLimit),
    inactiveLimited,
  };
}

import type { SessionListQuery, SessionListSnapshot, SessionProjectPage } from "./protocol/snapshots.ts";

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

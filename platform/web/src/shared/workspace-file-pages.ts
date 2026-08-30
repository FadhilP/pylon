import type { WorkspaceFilePage, WorkspaceFileReadModel, WorkspaceReadModel } from "./protocol/snapshots.ts";

export function workspaceInventoryCacheIsFresh(
  cachedRevision: string | undefined,
  expiresAt: number,
  workspaceRevision: string | undefined,
  now = Date.now(),
): boolean {
  return expiresAt > now && cachedRevision === workspaceRevision;
}

export function workspaceInventoryCacheState(
  cached: { generation: number; mode: WorkspaceReadModel["mode"] | undefined; revision?: string; expiresAt: number },
  current: { generation: number; mode: WorkspaceReadModel["mode"] | undefined; revision?: string },
  now = Date.now(),
): "hidden" | "stale" | "fresh" {
  if (cached.mode !== current.mode) return "hidden";
  return cached.generation === current.generation &&
    workspaceInventoryCacheIsFresh(cached.revision, cached.expiresAt, current.revision, now)
    ? "fresh"
    : "stale";
}
export async function drainWorkspaceFiles(
  fetchPage: (cursor?: string) => Promise<WorkspaceFilePage>,
  signal: AbortSignal,
  publish: (files: WorkspaceFileReadModel[], truncated: boolean) => void,
  progress?: (loaded: number, total: number) => void,
): Promise<WorkspaceFileReadModel[]> {
  const files = new Map<string, WorkspaceFileReadModel>();
  let cursor: string | undefined;
  let sincePublish = 0;
  let truncated = false;
  do {
    signal.throwIfAborted();
    const page = await fetchPage(cursor);
    signal.throwIfAborted();
    for (const file of page.files) files.set(file.path, file);
    sincePublish += page.files.length;
    cursor = page.nextCursor;
    truncated ||= page.truncated;
    progress?.(files.size, page.totalCount);
    if (sincePublish >= 1_000 || !cursor) {
      publish([...files.values()], truncated);
      sincePublish = 0;
    }
  } while (cursor);
  return [...files.values()];
}

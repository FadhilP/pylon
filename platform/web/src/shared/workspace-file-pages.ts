import type { WorkspaceFilePage, WorkspaceFileReadModel } from "./protocol/snapshots.ts";

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

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { startSessionLease } from "pylon-core/session-lease";

export const startSessionGc = (
  root: string,
  sessionId: string,
  cleanup: (liveSessionIds: ReadonlySet<string>) => Promise<void>,
  listSessions?: () => Promise<Array<{ id: string }>>,
) => startSessionLease(root, sessionId, "continuity", cleanup, listSessions);

export async function pruneOrphanWorkFiles(root: string, liveSessionIds: ReadonlySet<string>) {
  const workspaces = join(root, "workspaces");
  for (const workspace of await readdir(workspaces, { withFileTypes: true }).catch(() => [])) {
    if (!workspace.isDirectory()) continue;
    const sessions = join(workspaces, workspace.name, "sessions");
    for (const entry of await readdir(sessions, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const encoded = entry.name.slice(0, -5);
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      if (`${encodeURIComponent(sessionId)}.json` !== entry.name || liveSessionIds.has(sessionId)) continue;
      await rm(join(sessions, entry.name), { force: true });
    }
  }
}

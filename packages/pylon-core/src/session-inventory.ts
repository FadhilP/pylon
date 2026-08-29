import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONCURRENCY = 16;
const MAX_HEADER_BYTES = 64 * 1024;

export type SessionInventoryEntry = { id: string; cwd: string; path: string; modified: Date };

export type SessionInventoryOptions = { strict?: boolean };

async function mapLimit<T, R>(items: T[], transform: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await transform(items[index]!);
      }
    }),
  );
  return results;
}

async function sessionFiles(root: string, strict: boolean): Promise<string[]> {
  let directories;
  try {
    directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    if (strict) throw error;
    return [];
  }
  return (
    await mapLimit(directories, async directory => {
      try {
        return (await readdir(join(root, directory.name), { withFileTypes: true }))
          .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map(entry => join(root, directory.name, entry.name));
      } catch (error) {
        if (strict) throw error;
        return [];
      }
    })
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
}

async function readHeader(path: string): Promise<SessionInventoryEntry | undefined> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = content.split("\n");
    if (bytesRead === buffer.length && !content.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.type !== "session") return;
      if (typeof value.id !== "string" || !value.id || typeof value.cwd !== "string") return;
      return { id: value.id, cwd: value.cwd, path, modified: (await file.stat()).mtime };
    }
  } finally {
    await file.close();
  }
}

export async function listSessionInventory(
  agentDir = getAgentDir(),
  options: SessionInventoryOptions = {},
): Promise<SessionInventoryEntry[]> {
  const strict = options.strict ?? false;
  const files = await sessionFiles(resolve(agentDir, "sessions"), strict);
  const entries = await mapLimit(files, async path => {
    try {
      const entry = await readHeader(path);
      if (!entry && strict) throw new Error(`invalid or oversized session header: ${path}`);
      return entry;
    } catch (error) {
      if (strict) throw error;
      return;
    }
  });
  return entries
    .filter((entry): entry is SessionInventoryEntry => Boolean(entry))
    .sort((left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path));
}

export async function resolveUniqueSession(
  sessionId: string,
  agentDir = getAgentDir(),
): Promise<SessionInventoryEntry | undefined> {
  const matches = (await listSessionInventory(agentDir)).filter(session => session.id === sessionId);
  if (matches.length > 1) throw new Error("session id is ambiguous");
  return matches[0];
}

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { UsageHistoryAccumulator, type PersistedUsageAtom } from "./usage-history.ts";

const VERSION = 3;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const CONCURRENCY = 16;
const CACHE_FILE = "session-summaries-v3.json";
const canonicalPath = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

export interface SessionOwner {
  id: string;
  file: string;
}

export interface SessionFileMetadata {
  path: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  userMessageCount: number;
  owner?: SessionOwner;
}

interface Fingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface PersistedSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

interface CacheRecord {
  fingerprint: Fingerprint;
  session: PersistedSessionInfo;
  userMessageCount: number;
  owner?: SessionOwner;
  usage: PersistedUsageAtom[];
}

interface CacheFile {
  version: typeof VERSION;
  records: CacheRecord[];
}

export interface IndexedSession {
  session: SessionInfo;
  metadata: SessionFileMetadata;
  usage: PersistedUsageAtom[];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validText(value: unknown, max = 32_768): value is string {
  return typeof value === "string" && value.length <= max;
}

function parseOwner(value: unknown): SessionOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const owner = value as Record<string, unknown>;
  return validText(owner.id, 128) && owner.id.length > 0 && validText(owner.file) && owner.file.length > 0
    ? { id: owner.id, file: owner.file }
    : undefined;
}

function parseFingerprint(value: unknown): Fingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  return finite(item.dev) &&
    finite(item.ino) &&
    finite(item.size) &&
    item.size >= 0 &&
    finite(item.mtimeMs) &&
    finite(item.ctimeMs)
    ? { dev: item.dev, ino: item.ino, size: item.size, mtimeMs: item.mtimeMs, ctimeMs: item.ctimeMs }
    : undefined;
}

function parseUsageAtom(value: unknown): PersistedUsageAtom | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  const tokens = (candidate: unknown) => Number.isSafeInteger(candidate) && Number(candidate) >= 0;
  const cost = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1_000_000;
  if (
    !validText(item.identity, 64) ||
    !/^[a-f0-9]{64}$/.test(item.identity) ||
    !validText(item.signature, 64) ||
    !/^[a-f0-9]{64}$/.test(item.signature) ||
    !validText(item.sessionId, 128) ||
    !item.sessionId ||
    !validText(item.timestamp, 100) ||
    Number.isNaN(Date.parse(item.timestamp)) ||
    !validText(item.provider, 256) ||
    !item.provider ||
    !validText(item.model, 256) ||
    !item.model ||
    !["main", "advisor", "grunt", "scout", "private", "unknown"].includes(String(item.agent)) ||
    !Number.isSafeInteger(item.calls) ||
    Number(item.calls) < 1 ||
    !tokens(item.input) ||
    !tokens(item.output) ||
    !tokens(item.cacheRead) ||
    !tokens(item.cacheWrite) ||
    !cost(item.cost) ||
    typeof item.costKnown !== "boolean" ||
    !["assistant", "compaction", "branch-summary", "delegated", "telemetry"].includes(String(item.source))
  )
    return;
  return item as unknown as PersistedUsageAtom;
}

function parseRecord(value: unknown): CacheRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  const raw = item.session;
  const fingerprint = parseFingerprint(item.fingerprint);
  if (!fingerprint || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const session = raw as Record<string, unknown>;
  if (
    !validText(session.path) ||
    !session.path ||
    !validText(session.id, 128) ||
    !session.id ||
    !validText(session.cwd) ||
    !validText(session.created, 100) ||
    Number.isNaN(Date.parse(session.created)) ||
    !validText(session.modified, 100) ||
    Number.isNaN(Date.parse(session.modified)) ||
    !Number.isSafeInteger(session.messageCount) ||
    Number(session.messageCount) < 0 ||
    typeof session.firstMessage !== "string" ||
    typeof session.allMessagesText !== "string" ||
    (session.name !== undefined && !validText(session.name, 10_000)) ||
    (session.parentSessionPath !== undefined && !validText(session.parentSessionPath)) ||
    !Number.isSafeInteger(item.userMessageCount) ||
    Number(item.userMessageCount) < 0
  )
    return;
  const owner = item.owner === undefined ? undefined : parseOwner(item.owner);
  if (item.owner !== undefined && !owner) return;
  if (!Array.isArray(item.usage) || item.usage.length > 100_000) return;
  const usage = item.usage.map(parseUsageAtom);
  if (usage.some(atom => !atom)) return;
  return {
    fingerprint,
    session: {
      path: session.path,
      id: session.id,
      cwd: session.cwd,
      ...(typeof session.name === "string" ? { name: session.name } : {}),
      ...(typeof session.parentSessionPath === "string" ? { parentSessionPath: session.parentSessionPath } : {}),
      created: session.created,
      modified: session.modified,
      messageCount: Number(session.messageCount),
      firstMessage: session.firstMessage,
      allMessagesText: session.allMessagesText,
    },
    userMessageCount: Number(item.userMessageCount),
    ...(owner ? { owner } : {}),
    usage: usage as PersistedUsageAtom[],
  };
}

function hydrate(record: CacheRecord): IndexedSession {
  const session = record.session;
  return {
    session: { ...session, created: new Date(session.created), modified: new Date(session.modified) },
    metadata: {
      path: session.path,
      mtimeMs: record.fingerprint.mtimeMs,
      ctimeMs: record.fingerprint.ctimeMs,
      size: record.fingerprint.size,
      userMessageCount: record.userMessageCount,
      ...(record.owner ? { owner: record.owner } : {}),
    },
    usage: record.usage,
  };
}

function fingerprint(value: Awaited<ReturnType<typeof stat>>): Fingerprint {
  return {
    dev: Number(value.dev) || 0,
    ino: Number(value.ino) || 0,
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
    ctimeMs: Number(value.ctimeMs),
  };
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

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

async function sessionFiles(root: string): Promise<Array<{ path: string; fingerprint: Fingerprint }>> {
  let directories;
  try {
    directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch {
    return [];
  }
  const files = (
    await mapLimit(directories, async directory => {
      const path = join(root, directory.name);
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map(entry => join(path, entry.name));
      } catch {
        return [];
      }
    })
  ).flat();
  return (
    await mapLimit(files, async path => {
      try {
        return { path, fingerprint: fingerprint(await stat(path)) };
      } catch {
        return undefined;
      }
    })
  )
    .filter((value): value is { path: string; fingerprint: Fingerprint } => Boolean(value))
    .sort((left, right) => canonicalPath(left.path).localeCompare(canonicalPath(right.path)));
}

function textContent(message: Record<string, any>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join(" ");
}

const boundedText = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const validHooks = (value: any) =>
  value !== undefined &&
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value.beforeAgentStart === undefined || boundedText(value.beforeAgentStart, 300 * 1024)) &&
  (value.sessionStart === undefined ||
    (boundedText(value.sessionStart?.customType, 128) && boundedText(value.sessionStart?.content, 300 * 1024)));

function ownerMarker(value: any): SessionOwner | undefined {
  if (
    value?.version !== 1 ||
    !boundedText(value.ownerSessionId, 128) ||
    !boundedText(value.ownerSessionFile, 32_768) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.model !== undefined && !boundedText(value.model, 300)) ||
    (value.hooks !== undefined && !validHooks(value.hooks))
  )
    return;
  return { id: value.ownerSessionId, file: value.ownerSessionFile };
}

async function parseSession(path: string, before: Fingerprint, retries = 1): Promise<CacheRecord | undefined> {
  let header: any;
  let name: string | undefined;
  let messageCount = 0;
  let userMessageCount = 0;
  let firstMessage = "";
  let lastActivityTime: number | undefined;
  const allMessages: string[] = [];
  const owners: Array<SessionOwner | undefined> = [];
  let usage: UsageHistoryAccumulator | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (!header) {
        if (entry.type !== "session") return;
        header = entry;
        usage = typeof entry.id === "string" && entry.id ? new UsageHistoryAccumulator(entry.id) : undefined;
        continue;
      }
      usage?.accept(entry);
      if (entry.type === "session_info")
        name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      if (entry.type === "custom" && entry.customType === "pi-spawn-session") owners.push(ownerMarker(entry.data));
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      if (message.role === "user") userMessageCount++;
      if ((message.role !== "user" && message.role !== "assistant") || !("content" in message)) continue;
      const activity = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(activity)) lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
      const text = textContent(message);
      if (!text) continue;
      allMessages.push(text);
      if (!firstMessage && message.role === "user") firstMessage = text;
    }
    if (!header || typeof header.id !== "string" || !header.id || typeof header.timestamp !== "string") return;
    const after = fingerprint(await stat(path));
    if (!sameFingerprint(before, after)) return retries > 0 ? parseSession(path, after, retries - 1) : undefined;
    const owner = owners[0];
    const consistentOwner =
      owner &&
      owners.every(
        candidate => candidate?.id === owner.id && canonicalPath(candidate.file) === canonicalPath(owner.file),
      )
        ? owner
        : undefined;
    const headerTime = Date.parse(header.timestamp);
    const created = new Date(header.timestamp);
    if (Number.isNaN(created.getTime())) return;
    return {
      fingerprint: after,
      session: {
        path,
        id: header.id,
        cwd: typeof header.cwd === "string" ? header.cwd : "",
        ...(name ? { name } : {}),
        ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
        created: created.toISOString(),
        modified: new Date(
          lastActivityTime && lastActivityTime > 0
            ? lastActivityTime
            : Number.isNaN(headerTime)
              ? after.mtimeMs
              : headerTime,
        ).toISOString(),
        messageCount,
        firstMessage: firstMessage || "(no messages)",
        allMessagesText: allMessages.join(" "),
      },
      userMessageCount,
      ...(consistentOwner ? { owner: consistentOwner } : {}),
      usage: usage?.result() ?? [],
    };
  } catch {
    return;
  }
}

export class SessionSummaryCache {
  private readonly cachePath: string;
  private readonly sessionsRoot: string;
  private records = new Map<string, CacheRecord>();
  private unreadablePaths = new Set<string>();
  private loaded = false;

  constructor(private readonly agentDir: string) {
    this.cachePath = resolve(agentDir, "pylon-web", CACHE_FILE);
    // SessionManager follows PI_CODING_AGENT_DIR even when Pylon receives a distinct package/config directory.
    this.sessionsRoot = resolve(process.env.PI_CODING_AGENT_DIR || agentDir, "sessions");
  }

  async scan(): Promise<IndexedSession[]> {
    await this.load();
    const files = await sessionFiles(this.sessionsRoot);
    const previous = this.records;
    const next = new Map<string, CacheRecord>();
    let changed = files.length !== previous.size;
    const unreadablePaths = new Set<string>();
    const parsed = await mapLimit(files, async file => {
      const key = canonicalPath(file.path);
      const cached = previous.get(key);
      if (cached && sameFingerprint(cached.fingerprint, file.fingerprint)) return cached;
      changed = true;
      const record = await parseSession(file.path, file.fingerprint);
      if (!record) unreadablePaths.add(key);
      return record ?? cached;
    });
    const byId = new Map<string, { key: string; record: CacheRecord }>();
    for (let index = 0; index < files.length; index++) {
      const record = parsed[index];
      if (!record) continue;
      const key = canonicalPath(files[index]!.path);
      const existing = byId.get(record.session.id);
      const modified = Date.parse(record.session.modified);
      const existingModified = existing ? Date.parse(existing.record.session.modified) : Number.NEGATIVE_INFINITY;
      if (!existing || modified > existingModified || (modified === existingModified && key < existing.key)) {
        if (existing) changed = true;
        byId.set(record.session.id, { key, record });
      } else {
        changed = true;
      }
    }
    for (const { key, record } of byId.values()) next.set(key, record);
    this.records = next;
    this.unreadablePaths = unreadablePaths;
    if (changed) await this.save();
    return [...next.values()].map(hydrate);
  }

  unreadableFileCount(): number {
    return this.unreadablePaths.size;
  }

  async refresh(sessionId: string, path: string): Promise<IndexedSession | undefined> {
    await this.load();
    const key = canonicalPath(path);
    let record: CacheRecord | undefined;
    let exists = false;
    try {
      const current = fingerprint(await stat(path));
      exists = true;
      record = await parseSession(path, current);
    } catch {
      // Missing files remove the prior record for this session below.
    }
    if (exists && !record) {
      this.unreadablePaths.add(key);
      const previous = this.records.get(key) ?? [...this.records.values()].find(item => item.session.id === sessionId);
      return previous ? hydrate(previous) : undefined;
    }
    this.unreadablePaths.delete(key);
    for (const [candidate, value] of this.records) {
      if (candidate === key || value.session.id === sessionId || (record && value.session.id === record.session.id))
        this.records.delete(candidate);
    }
    if (record) this.records.set(key, record);
    await this.save();
    return record ? hydrate(record) : undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if ((await stat(this.cachePath)).size > MAX_CACHE_BYTES) return;
      const value = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<CacheFile>;
      if (value.version !== VERSION || !Array.isArray(value.records)) return;
      for (const valueRecord of value.records) {
        const record = parseRecord(valueRecord);
        if (record) this.records.set(canonicalPath(record.session.path), record);
      }
    } catch {
      // Missing, corrupt, and outdated caches rebuild from source session files.
    }
  }

  private async save(): Promise<void> {
    const directory = dirname(this.cachePath);
    const temporary = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      const value: CacheFile = { version: VERSION, records: [...this.records.values()] };
      // The cache is disposable: concurrent writers are last-writer-wins, and fingerprints repair stale records on the next scan.
      await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.cachePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

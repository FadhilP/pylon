import { createHash, randomUUID } from "node:crypto";

const SERVICE = "works.earendil.pylon.stateql";
const REFERENCE_PATTERN = /^pylon:stateql:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_LENGTH = 8_192;
const MAX_PAYLOAD_LENGTH = 16_384;
const MAX_PASSWORD_LENGTH = 4_096;
const SECRET_QUERY_KEYS = new Set(["password", "pwd"]);
const PASSWORD_TARGET_QUERY_OVERRIDES = new Set([
  "password",
  "pwd",
  "user",
  "username",
  "host",
  "port",
  "database",
  "dbname",
]);
const TLS_QUERY_KEYS = new Set([
  "sslmode",
  "ssl",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "rejectunauthorized",
  "uselibpqcompat",
  "sslnegotiation",
]);

interface KeyringEntry {
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

interface StoredCredentialV1 {
  version: 1;
  fingerprint: string;
  source: string;
  stale?: true;
}

interface StoredCredentialV2 {
  version: 2;
  fingerprint: string;
  password: string;
  stale?: true;
}

type StoredCredential = StoredCredentialV1 | StoredCredentialV2;

export interface StateQLCredentialVault {
  save(reference: string, target: string | undefined, source: string, signal?: AbortSignal): Promise<boolean>;
  resolve(reference: string, target?: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Optional while callers may still inject v1-only vault implementations. */
  savePassword?(reference: string, target: string, password: string, signal?: AbortSignal): Promise<boolean>;
  /** Optional while callers may still inject v1-only vault implementations. */
  resolvePassword?(reference: string, target: string, signal?: AbortSignal): Promise<string | undefined>;
  invalidate(reference: string, signal?: AbortSignal): Promise<boolean>;
  forget(reference: string, signal?: AbortSignal): Promise<boolean>;
}

function normalizedProtocol(protocol: string): string {
  return protocol === "postgresql:" ? "postgres:" : protocol;
}

function defaultPort(protocol: string): string {
  if (protocol === "postgres:") return "5432";
  if (protocol === "mysql:") return "3306";
  if (protocol === "mongodb:") return "27017";
  if (protocol === "redis:" || protocol === "rediss:") return "6379";
  return "";
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function connectionIdentity(source: string): string | undefined {
  if (!source || source.length > MAX_SOURCE_LENGTH || hasControlCharacters(source)) return undefined;
  try {
    const url = new URL(source);
    const protocol = normalizedProtocol(url.protocol.toLowerCase());
    if (
      !["postgres:", "mysql:", "mongodb:", "mongodb+srv:", "redis:", "rediss:"].includes(protocol) ||
      !url.hostname ||
      url.hash
    )
      return undefined;
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !SECRET_QUERY_KEYS.has(key.toLowerCase()))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
      );
    return JSON.stringify({
      protocol,
      username: url.username,
      hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
      port: url.port || defaultPort(protocol),
      database: url.pathname,
      query,
    });
  } catch {
    return undefined;
  }
}

function hasEmbeddedPassword(source: string): boolean {
  const authorityStart = source.indexOf("://");
  if (authorityStart < 0) return false;
  const start = authorityStart + 3;
  const end = source.slice(start).search(/[/?#]/u);
  const authority = source.slice(start, end < 0 ? source.length : start + end);
  const at = authority.lastIndexOf("@");
  return at >= 0 && authority.slice(0, at).includes(":");
}

function decodedPart(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return hasControlCharacters(decoded) ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * v2 fingerprints deliberately omit TLS settings. They are connection options,
 * rather than destination identity, and must not cause credential replacement.
 */
function passwordConnectionIdentity(target: string, allowEmbeddedPassword = false): string | undefined {
  if (
    typeof target !== "string" ||
    !target ||
    target.length > MAX_SOURCE_LENGTH ||
    hasControlCharacters(target) ||
    /%(?![0-9a-f]{2})/iu.test(target) ||
    (!allowEmbeddedPassword && hasEmbeddedPassword(target))
  )
    return undefined;
  try {
    const url = new URL(target);
    const protocol = normalizedProtocol(url.protocol.toLowerCase());
    if (
      !["postgres:", "mysql:", "mongodb:", "mongodb+srv:", "redis:", "rediss:"].includes(protocol) ||
      !url.hostname ||
      url.hash
    )
      return undefined;

    const username = decodedPart(url.username);
    const database = decodedPart(url.pathname);
    if (username === undefined || database === undefined || hasControlCharacters(url.hostname)) return undefined;

    const query: [string, string][] = [];
    for (const [key, value] of url.searchParams.entries()) {
      const normalizedKey = key.toLowerCase();
      if (
        hasControlCharacters(key) ||
        hasControlCharacters(value) ||
        PASSWORD_TARGET_QUERY_OVERRIDES.has(normalizedKey)
      )
        return undefined;
      if (!TLS_QUERY_KEYS.has(normalizedKey)) query.push([key, value]);
    }
    query.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );
    return JSON.stringify({
      protocol,
      username,
      hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
      port: url.port || defaultPort(protocol),
      database,
      query,
    });
  } catch {
    return undefined;
  }
}

function passwordFingerprint(target: string, allowEmbeddedPassword = false): string | undefined {
  const identity = passwordConnectionIdentity(target, allowEmbeddedPassword);
  return identity ? createHash("sha256").update(identity).digest("hex") : undefined;
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH && !hasControlCharacters(password);
}

export function stateqlCredentialFingerprint(source: string): string | undefined {
  const identity = connectionIdentity(source);
  return identity ? createHash("sha256").update(identity).digest("hex") : undefined;
}

export function createStateQLCredentialReference(): string {
  return `pylon:stateql:v1:${randomUUID()}`;
}

export function isStateQLCredentialReference(value: string): boolean {
  return REFERENCE_PATTERN.test(value);
}

function storedCredentialV1(value: string): StoredCredentialV1 | undefined {
  if (!value || value.length > MAX_PAYLOAD_LENGTH) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCredentialV1>;
    return parsed.version === 1 &&
      typeof parsed.fingerprint === "string" &&
      FINGERPRINT_PATTERN.test(parsed.fingerprint) &&
      typeof parsed.source === "string" &&
      parsed.source.length > 0 &&
      parsed.source.length <= MAX_SOURCE_LENGTH &&
      (parsed.stale === undefined || parsed.stale === true)
      ? {
          version: 1,
          fingerprint: parsed.fingerprint,
          source: parsed.source,
          ...(parsed.stale ? { stale: true as const } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function storedCredentialV2(value: string): StoredCredentialV2 | undefined {
  if (!value || value.length > MAX_PAYLOAD_LENGTH) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (!Object.keys(record).every(key => ["version", "fingerprint", "password", "stale"].includes(key)))
      return undefined;
    return record.version === 2 &&
      typeof record.fingerprint === "string" &&
      FINGERPRINT_PATTERN.test(record.fingerprint) &&
      typeof record.password === "string" &&
      validPassword(record.password) &&
      (record.stale === undefined || record.stale === true)
      ? {
          version: 2,
          fingerprint: record.fingerprint,
          password: record.password,
          ...(record.stale ? { stale: true as const } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function storedCredential(value: string): StoredCredential | undefined {
  return storedCredentialV1(value) ?? storedCredentialV2(value);
}

function legacyPassword(source: string): string | undefined {
  try {
    const password = decodedPart(new URL(source).password);
    return password !== undefined && validPassword(password) ? password : undefined;
  } catch {
    return undefined;
  }
}

export class OsStateQLCredentialVault implements StateQLCredentialVault {
  constructor(private readonly entry: KeyringEntryFactory) {}

  async save(reference: string, target: string | undefined, source: string, signal?: AbortSignal): Promise<boolean> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return false;
    const actual = stateqlCredentialFingerprint(source);
    const expected = target === undefined ? actual : stateqlCredentialFingerprint(target);
    if (!expected || actual !== expected) return false;
    try {
      await this.entry(SERVICE, reference).setPassword(
        JSON.stringify({ version: 1, fingerprint: expected, source } satisfies StoredCredentialV1),
        signal,
      );
      return !signal?.aborted;
    } catch {
      return false;
    }
  }

  async resolve(reference: string, target?: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return undefined;
    const expected = target === undefined ? undefined : stateqlCredentialFingerprint(target);
    if (target !== undefined && !expected) return undefined;
    try {
      // v2 records intentionally cannot be resolved through the legacy URL API.
      const stored = storedCredentialV1((await this.entry(SERVICE, reference).getPassword(signal)) ?? "");
      const actual = stored && stateqlCredentialFingerprint(stored.source);
      if (
        !stored ||
        stored.stale ||
        !actual ||
        stored.fingerprint !== actual ||
        (expected && stored.fingerprint !== expected)
      )
        return undefined;
      return signal?.aborted ? undefined : stored.source;
    } catch {
      return undefined;
    }
  }

  async savePassword(reference: string, target: string, password: string, signal?: AbortSignal): Promise<boolean> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted || !validPassword(password)) return false;
    const fingerprint = passwordFingerprint(target);
    if (!fingerprint) return false;
    try {
      await this.entry(SERVICE, reference).setPassword(
        JSON.stringify({ version: 2, fingerprint, password } satisfies StoredCredentialV2),
        signal,
      );
      return !signal?.aborted;
    } catch {
      return false;
    }
  }

  async resolvePassword(reference: string, target: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return undefined;
    const expected = passwordFingerprint(target);
    if (!expected) return undefined;
    try {
      const value = (await this.entry(SERVICE, reference).getPassword(signal)) ?? "";
      const v2 = storedCredentialV2(value);
      if (v2) return !v2.stale && v2.fingerprint === expected && !signal?.aborted ? v2.password : undefined;

      // Read v1 without migration: it remains a full-URL record for legacy callers.
      const v1 = storedCredentialV1(value);
      const actualV1Fingerprint = v1 && stateqlCredentialFingerprint(v1.source);
      const actualDestinationFingerprint = v1 && passwordFingerprint(v1.source, true);
      if (
        !v1 ||
        v1.stale ||
        !actualV1Fingerprint ||
        v1.fingerprint !== actualV1Fingerprint ||
        !actualDestinationFingerprint ||
        actualDestinationFingerprint !== expected ||
        signal?.aborted
      )
        return undefined;
      return legacyPassword(v1.source);
    } catch {
      return undefined;
    }
  }

  async invalidate(reference: string, signal?: AbortSignal): Promise<boolean> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return false;
    try {
      const entry = this.entry(SERVICE, reference);
      const stored = storedCredential((await entry.getPassword(signal)) ?? "");
      if (!stored || signal?.aborted) return false;
      await entry.setPassword(JSON.stringify({ ...stored, stale: true }), signal);
      return !signal?.aborted;
    } catch {
      return false;
    }
  }

  async forget(reference: string, signal?: AbortSignal): Promise<boolean> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return false;
    try {
      const deleted = await this.entry(SERVICE, reference).deleteCredential(signal);
      return deleted && !signal?.aborted;
    } catch {
      return false;
    }
  }
}

export async function createOsStateQLCredentialVault(): Promise<StateQLCredentialVault | undefined> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new OsStateQLCredentialVault((service, account) => new AsyncEntry(service, account));
  } catch {
    return undefined;
  }
}

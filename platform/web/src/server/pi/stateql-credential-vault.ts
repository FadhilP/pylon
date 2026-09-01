import { createHash, randomUUID } from "node:crypto";

const SERVICE = "works.earendil.pylon.stateql";
const REFERENCE_PATTERN = /^pylon:stateql:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_LENGTH = 8_192;
const MAX_PAYLOAD_LENGTH = 16_384;
const SECRET_QUERY_KEYS = new Set(["password", "pwd"]);

interface KeyringEntry {
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

interface StoredCredential {
  version: 1;
  fingerprint: string;
  source: string;
  stale?: true;
}

export interface StateQLCredentialVault {
  save(reference: string, target: string | undefined, source: string, signal?: AbortSignal): Promise<boolean>;
  resolve(reference: string, target?: string, signal?: AbortSignal): Promise<string | undefined>;
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
  return "";
}

function connectionIdentity(source: string): string | undefined {
  if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/u.test(source)) return undefined;
  try {
    const url = new URL(source);
    const protocol = normalizedProtocol(url.protocol.toLowerCase());
    if (!["postgres:", "mysql:", "mongodb:", "mongodb+srv:"].includes(protocol) || !url.hostname || url.hash)
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

function storedCredential(value: string): StoredCredential | undefined {
  if (!value || value.length > MAX_PAYLOAD_LENGTH) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCredential>;
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

export class OsStateQLCredentialVault implements StateQLCredentialVault {
  constructor(private readonly entry: KeyringEntryFactory) {}

  async save(reference: string, target: string | undefined, source: string, signal?: AbortSignal): Promise<boolean> {
    if (!isStateQLCredentialReference(reference) || signal?.aborted) return false;
    const actual = stateqlCredentialFingerprint(source);
    const expected = target === undefined ? actual : stateqlCredentialFingerprint(target);
    if (!expected || actual !== expected) return false;
    try {
      await this.entry(SERVICE, reference).setPassword(
        JSON.stringify({ version: 1, fingerprint: expected, source } satisfies StoredCredential),
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
      const stored = storedCredential((await this.entry(SERVICE, reference).getPassword(signal)) ?? "");
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
      return await this.entry(SERVICE, reference).deleteCredential(signal);
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

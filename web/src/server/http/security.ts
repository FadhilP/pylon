import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_JSON_BODY_BYTES = 128 * 1024;
export const SESSION_COOKIE = "pylon_session";

export interface SecurityOptions {
  allowedHosts: readonly string[];
  secureCookies?: boolean;
}

export interface BrowserSession {
  secret: string;
  csrfToken: string;
  tabs: Set<string>;
}

export class SessionStore {
  private readonly sessions = new Map<string, { session: BrowserSession; touchedAt: number }>();
  get(request: IncomingMessage): BrowserSession | undefined {
    this.prune();
    const secret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const stored = secret ? this.sessions.get(secret) : undefined;
    if (stored) stored.touchedAt = Date.now();
    return stored?.session;
  }
  create(response: ServerResponse, secure = false): BrowserSession {
    this.prune();
    const secret = randomToken();
    const session = { secret, csrfToken: randomToken(), tabs: new Set<string>() };
    this.sessions.set(secret, { session, touchedAt: Date.now() });
    while (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value as string);
    response.setHeader("set-cookie", `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`);
    return session;
  }
  private prune(now = Date.now()): void {
    for (const [secret, stored] of this.sessions) {
      if (now - stored.touchedAt > 24 * 60 * 60_000) this.sessions.delete(secret);
    }
  }
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}

export function hostAllowed(request: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const host = request.headers.host;
  return typeof host === "string" && allowedHosts.includes(host);
}

export function requestAllowed(request: IncomingMessage, options: SecurityOptions): boolean {
  if (!hostAllowed(request, options.allowedHosts)) return false;
  const host = request.headers.host as string;
  const origin = request.headers.origin;
  const scheme = options.secureCookies ? "https" : "http";
  if (origin && origin !== `${scheme}://${host}`) return false;
  const site = request.headers["sec-fetch-site"];
  return site !== "cross-site" && site !== "cross-origin";
}

export function validCsrf(session: BrowserSession | undefined, supplied: string | undefined): boolean {
  if (!session || !supplied) return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validTabId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function readJson(request: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw httpError(415, "application/json content type required");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw httpError(413, "request body too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw httpError(400, "invalid JSON"); }
}

export interface HttpError extends Error { statusCode: number; }
export function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError; error.statusCode = statusCode; return error;
}
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([key, value]) => key && value).map(([key, value]) => [key, value]));
}

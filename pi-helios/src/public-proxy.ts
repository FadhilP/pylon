import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, connect as netConnect } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type PublicProxyOptions = { resolver?: Resolver; maxRequests?: number; maxBytes?: number };

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28],
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blockedV6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string, family: 4 | 6 = isIP(address) as 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (family === 4 && isIP(normalized) === 4) return !blockedV4.check(normalized, "ipv4");
  if (family !== 6 || isIP(normalized) !== 6) return false;
  if (normalized.toLowerCase().startsWith("::ffff:")) return false;
  return globalV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true }) as ResolvedAddress[];
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolvePublicHost(hostname: string, resolver: Resolver = defaultResolver): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host.includes("%")) throw new Error("Web Scout blocked invalid destination host");
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : await withTimeout(resolver(host), 5_000, "Web Scout destination lookup timed out");
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new Error("Web Scout blocked non-public destination");
  }
  return addresses[0];
}

export function validatePublicWebUrl(value: string): URL {
  if (value.length > 2048) throw new Error("Web Scout URL exceeds 2048 character limit");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Web Scout permits only HTTP(S) URLs");
  if (url.username || url.password) throw new Error("Web Scout URLs must not contain credentials");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") throw new Error("Web Scout permits only ports 80 and 443");
  return url;
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class PublicNetworkProxy {
  readonly username = "web-scout";
  readonly password = randomBytes(24).toString("base64url");
  private readonly resolver: Resolver;
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  private active = 0;
  private requests = 0;
  private bytes = 0;
  private port = 0;
  private closed = false;

  private constructor(options: PublicProxyOptions) {
    this.resolver = options.resolver ?? defaultResolver;
    this.maxRequests = options.maxRequests ?? 500;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => this.fail(response, 502));
    });
    this.server.on("connect", (request, socket, head) => {
      void this.handleConnect(request, socket, head).catch(() => {
        if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
    });
    this.server.on("upgrade", (_request, socket) => socket.destroy());
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: Resolver | PublicProxyOptions = {}): Promise<PublicNetworkProxy> {
    const proxy = new PublicNetworkProxy(typeof options === "function" ? { resolver: options } : options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", () => {
        proxy.server.off("error", reject);
        resolve();
      });
    });
    const address = proxy.server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind Web Scout proxy");
    proxy.port = address.port;
    return proxy;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    return sameSecret(request.headers["proxy-authorization"], expected);
  }

  private fail(response: ServerResponse, status: 403 | 407 | 429 | 502): void {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, {
      "content-type": "text/plain",
      "connection": "close",
      ...(status === 407 ? { "proxy-authenticate": "Basic realm=\"Web Scout\"" } : {}),
    });
    response.end("Web Scout proxy blocked request");
  }

  private enter(): boolean {
    if (this.active >= 64 || this.requests >= this.maxRequests) return false;
    this.active++;
    this.requests++;
    return true;
  }

  private account = (chunk: Buffer | string): void => {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes <= this.maxBytes) return;
    for (const socket of this.sockets) socket.destroy();
  };

  private leave = (): void => { this.active = Math.max(0, this.active - 1); };

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) return this.fail(response, 407);
    if (!this.enter()) return this.fail(response, 429);
    response.once("close", this.leave);
    let url: URL;
    try { url = validatePublicWebUrl(request.url ?? ""); }
    catch { return this.fail(response, 403); }
    if (url.protocol !== "http:") return this.fail(response, 403);
    let target: ResolvedAddress;
    try { target = await resolvePublicHost(url.hostname, this.resolver); }
    catch { return this.fail(response, 403); }
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"]; 
    request.on("data", this.account);
    const outgoing = httpRequest({
      host: target.address,
      family: target.family,
      port: Number(url.port || "80"),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: 15_000,
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.on("data", this.account);
      upstream.pipe(response);
    });
    outgoing.once("timeout", () => outgoing.destroy());
    outgoing.once("error", () => this.fail(response, 502));
    request.pipe(outgoing);
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Web Scout\"\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!this.enter()) {
      client.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    client.once("close", this.leave);
    let url: URL;
    try { url = new URL(`https://${request.url}`); }
    catch { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    if ((url.port || "443") !== "443" || url.username || url.password) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    let target: ResolvedAddress;
    try { target = await resolvePublicHost(url.hostname, this.resolver); }
    catch { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream = netConnect({ host: target.address, family: target.family, port: 443 });
    client.on("data", this.account);
    upstream.on("data", this.account);
    this.sockets.add(upstream);
    upstream.once("close", () => this.sockets.delete(upstream));
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }
}

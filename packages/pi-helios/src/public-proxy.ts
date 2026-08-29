import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, connect as netConnect, type Socket } from "node:net";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type PublicProxyOptions = {
  resolver?: Resolver;
  connector?: (options: { host: string; family: 4 | 6; port: number }) => Socket;
  maxRequests?: number;
  maxBytes?: number;
  maxTunnels?: number;
};

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string, family: 4 | 6 = isIP(address) as 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (family === 4 && isIP(normalized) === 4) return !blockedV4.check(normalized, "ipv4");
  if (family !== 6 || isIP(normalized) !== 6) return false;
  if (normalized.toLowerCase().startsWith("::ffff:")) return false;
  return globalV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  return (await lookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];
}

function randomLoopbackAddress(): string {
  const octets = randomBytes(3);
  return `127.${1 + (octets[0] % 254)}.${1 + (octets[1] % 254)}.${1 + (octets[2] % 254)}`;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolvePublicHost(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host.includes("%")) throw new Error("Web Scout blocked invalid destination host");
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : await withTimeout(resolver(host), 5_000, "Web Scout destination lookup timed out");
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address, item.family))) {
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
// Chromium's credentialed proxy path enables request interception and can deadlock
// Google-hosted navigations. The random loopback address and ephemeral port form a
// run-scoped capability that is never exposed to page content.
export class PublicNetworkProxy {
  private readonly resolver: Resolver;
  private readonly server: Server;
  private readonly connector: NonNullable<PublicProxyOptions["connector"]>;
  private readonly sockets = new Set<Duplex>();
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  private readonly maxTunnels: number;
  private active = 0;
  private requests = 0;
  private bytes = 0;
  private tunnels = 0;
  private port = 0;
  private host = "";
  private closed = false;

  private constructor(options: PublicProxyOptions) {
    this.resolver = options.resolver ?? defaultResolver;
    this.connector = options.connector ?? (connectOptions => netConnect(connectOptions));
    this.maxRequests = options.maxRequests ?? 500;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.maxTunnels = options.maxTunnels ?? 256;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => this.fail(response, 502));
    });
    this.server.on("connect", (request, socket, head) => {
      void this.handleConnect(request, socket, head).catch(() => {
        if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
    });
    this.server.on("upgrade", (_request, socket) => socket.destroy());
    this.server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: Resolver | PublicProxyOptions = {}): Promise<PublicNetworkProxy> {
    const normalized = typeof options === "function" ? { resolver: options } : options;
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      const proxy = new PublicNetworkProxy(normalized);
      const host = randomLoopbackAddress();
      try {
        await new Promise<void>((resolve, reject) => {
          proxy.server.once("error", reject);
          proxy.server.listen(0, host, () => {
            proxy.server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      const address = proxy.server.address();
      if (!address || typeof address === "string") throw new Error("Could not bind Web Scout proxy");
      proxy.host = host;
      proxy.port = address.port;
      return proxy;
    }
    throw new Error("Could not bind private Web Scout proxy endpoint", { cause: lastError });
  }
  get serverUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private fail(response: ServerResponse, status: 403 | 429 | 502): void {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { "content-type": "text/plain", connection: "close" });
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

  private leave = (): void => {
    this.active = Math.max(0, this.active - 1);
  };

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.enter()) return this.fail(response, 429);
    response.once("close", this.leave);
    let url: URL;
    try {
      url = validatePublicWebUrl(request.url ?? "");
    } catch {
      return this.fail(response, 403);
    }
    if (url.protocol !== "http:") return this.fail(response, 403);
    let target: ResolvedAddress;
    try {
      target = await resolvePublicHost(url.hostname, this.resolver);
    } catch {
      return this.fail(response, 403);
    }
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    request.on("data", this.account);
    const outgoing = httpRequest(
      {
        host: target.address,
        family: target.family,
        port: Number(url.port || "80"),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: 15_000,
      },
      upstream => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.on("data", this.account);
        upstream.pipe(response);
      },
    );
    outgoing.once("timeout", () => outgoing.destroy());
    outgoing.once("error", () => this.fail(response, 502));
    request.pipe(outgoing);
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.enter()) {
      client.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    let establishing = true;
    let tunnelReserved = false;
    let upstream: Socket | undefined;
    const releaseEstablishment = () => {
      if (!establishing) return;
      establishing = false;
      this.leave();
    };
    const releaseTunnel = () => {
      if (!tunnelReserved) return;
      tunnelReserved = false;
      this.tunnels = Math.max(0, this.tunnels - 1);
    };
    const reject = (status: 403 | 429) => {
      releaseEstablishment();
      releaseTunnel();
      client.end(`HTTP/1.1 ${status === 403 ? "403 Forbidden" : "429 Too Many Requests"}\r\nConnection: close\r\n\r\n`);
    };
    client.once("close", () => {
      releaseEstablishment();
      releaseTunnel();
      upstream?.destroy();
    });
    let url: URL;
    try {
      url = new URL(`https://${request.url}`);
    } catch {
      reject(403);
      return;
    }
    if ((url.port || "443") !== "443" || url.username || url.password) {
      reject(403);
      return;
    }
    let target: ResolvedAddress;
    try {
      target = await resolvePublicHost(url.hostname, this.resolver);
    } catch {
      reject(403);
      return;
    }
    if (this.tunnels >= this.maxTunnels) {
      reject(429);
      return;
    }
    this.tunnels++;
    tunnelReserved = true;
    upstream = this.connector({ host: target.address, family: target.family, port: 443 });
    client.on("data", this.account);
    upstream.on("data", this.account);
    this.sockets.add(upstream);
    upstream.once("close", () => {
      this.sockets.delete(upstream!);
      releaseEstablishment();
      releaseTunnel();
      if (!client.destroyed) client.destroy();
    });
    upstream.setTimeout(15_000, () => upstream?.destroy());
    client.on("error", () => upstream?.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      if (client.destroyed) {
        upstream?.destroy();
        return;
      }
      releaseEstablishment();
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream?.write(head);
      client.pipe(upstream!);
      upstream!.pipe(client);
    });
  }
}

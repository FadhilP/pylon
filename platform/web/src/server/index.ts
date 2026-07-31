import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RuntimeCoordinator } from "./pi/runtime-coordinator.ts";
import type { PiDriver } from "./pi/pi-driver.ts";
import { ServerTransport } from "./http/router.ts";
import { applySecurityHeaders, hostAllowed } from "./http/security.ts";
import { createAssetHost } from "./http/static.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(packageRoot, "platform/web");

export interface PylonServerOptions {
  cwd?: string;
  repositoryRoot?: string;
  agentDir?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  driver?: PiDriver;
  development?: boolean;
}

export interface RunningPylonServer {
  server: Server;
  transport: ServerTransport;
  close(): Promise<void>;
}

/** Starts the local-only API host. Browser assets may be served separately in development. */
export async function startPylonServer(options: PylonServerOptions = {}): Promise<RunningPylonServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Pylon server must bind to a loopback address");
  const port = options.port ?? 3141;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("invalid server port");
  const driver = options.driver ?? new RuntimeCoordinator();
  const repositoryRoot = options.repositoryRoot ?? resolve(webRoot, "../..");
  await driver.start({
    cwd: options.cwd ?? repositoryRoot,
    repositoryRoot,
    agentDir: options.agentDir ?? getAgentDir(),
  }).catch(async (error) => {
    await driver.dispose().catch(() => undefined);
    throw error;
  });
  const assets = await createAssetHost(webRoot, options.development ?? process.env.NODE_ENV !== "production").catch(async (error) => {
    await driver.dispose().catch(() => undefined);
    throw error;
  });
  let transport: ServerTransport | undefined;
  let allowedHost: string | undefined;
  const server = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 10_000,
    requestTimeout: 30_000,
  }, (request, response) => {
    if (!allowedHost || !hostAllowed(request, [allowedHost])) {
      applySecurityHeaders(response);
      response.statusCode = allowedHost ? 403 : 503;
      response.end();
      return;
    }
    if ((request.url ?? "").startsWith("/api/")) {
      if (transport) void transport.handle(request, response);
      else { response.statusCode = 503; response.end(); }
      return;
    }
    void assets.handle(request, response);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
    allowedHost = host === "::1" ? `[::1]:${address.port}` : `${host}:${address.port}`;
    transport = await ServerTransport.create(driver, { allowedHosts: [allowedHost] });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assets.close();
    await driver.dispose();
    throw error;
  }
  if (!transport) throw new Error("transport did not initialize");
  const readyTransport = transport;
  server.on("upgrade", readyTransport.handleUpgrade);
  let closePromise: Promise<void> | undefined;
  return {
    server,
    transport: readyTransport,
    close() {
      return closePromise ??= (async () => {
        server.off("upgrade", readyTransport.handleUpgrade);
        readyTransport.dispose();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await assets.close();
        await driver.dispose();
      })();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.argv.includes("--production");
  const running = await startPylonServer({
    development: !production,
    cwd: process.env.PYLON_CWD,
    port: process.env.PYLON_PORT ? Number(process.env.PYLON_PORT) : undefined,
  });
  const address = running.server.address();
  if (address && typeof address !== "string") console.log(`Pylon web: http://127.0.0.1:${address.port}`);
  const shutdown = () => void running.close().finally(() => process.exit());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

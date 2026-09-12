import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AndroidRunner } from "pylon-android/android-runner";
import { RuntimeCoordinator } from "./runtime/runtime-coordinator.ts";
import type { PiDriver } from "./runtime/pi-driver.ts";
import { ServerTransport } from "./http/router.ts";
import { applySecurityHeaders, hostAllowed } from "./http/security.ts";
import { createAssetHost } from "./http/static.ts";
import { PylonAndroidHost } from "./android/pylon-android-host.ts";
import { cleanupPylonAndroidStagingBase, PylonAndroidAppRuntime } from "./android/android-app-runtime.ts";

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
  androidHost?: PylonAndroidHost;
}

export interface RunningPylonServer {
  server: Server;
  transport: ServerTransport;
  androidHost: PylonAndroidHost;
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
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const androidStagingDirectory = resolve(agentDir, "pylon-web/android-staging");
  if (!options.androidHost) await cleanupPylonAndroidStagingBase(androidStagingDirectory);
  const androidHost =
    options.androidHost ??
    new PylonAndroidHost(new AndroidRunner(), {
      settingsPath: resolve(agentDir, "pylon-web/android.sqlite"),
      buildStateDirectory: resolve(agentDir, "pylon-web/android-gradle"),
      stagingStateDirectory: androidStagingDirectory,
      appRuntime: new PylonAndroidAppRuntime(),
      workspaceProvider: expectedGeneration => {
        if (!driver.androidWorkspaceContext) throw new Error("Android workspace resolution is unavailable");
        return driver.androidWorkspaceContext(expectedGeneration);
      },
      workspaceValidator: workspace => {
        if (!driver.validateAndroidWorkspaceContext) {
          throw new Error("Android workspace validation is unavailable");
        }
        return driver.validateAndroidWorkspaceContext({
          projectId: workspace.projectId,
          sessionId: workspace.sessionId,
          sessionGeneration: workspace.sessionGeneration,
          root: workspace.canonicalRoot,
          registeredRoot: workspace.canonicalRegisteredRoot,
          workspaceKind: workspace.workspaceKind,
          workspaceLabel: workspace.workspaceLabel,
        });
      },
    });
  await driver.start({ cwd: options.cwd ?? repositoryRoot, repositoryRoot, agentDir }).catch(async error => {
    const cleanup = await Promise.allSettled([driver.dispose(), androidHost.dispose()]);
    const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "Pylon startup and cleanup failed");
    throw error;
  });
  const assets = await createAssetHost(webRoot, options.development ?? process.env.NODE_ENV !== "production").catch(
    async error => {
      const cleanup = await Promise.allSettled([driver.dispose(), androidHost.dispose()]);
      const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError([error, ...failures], "Pylon startup and cleanup failed");
      throw error;
    },
  );
  let transport: ServerTransport | undefined;
  let allowedHost: string | undefined;
  const server = createServer(
    { maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 },
    (request, response) => {
      if (!allowedHost || !hostAllowed(request, [allowedHost])) {
        applySecurityHeaders(response);
        response.statusCode = allowedHost ? 403 : 503;
        response.end();
        return;
      }
      if ((request.url ?? "").startsWith("/api/")) {
        if (transport) void transport.handle(request, response);
        else {
          response.statusCode = 503;
          response.end();
        }
        return;
      }
      void assets.handle(request, response);
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
    allowedHost = host === "::1" ? `[::1]:${address.port}` : `${host}:${address.port}`;
    transport = await ServerTransport.create(driver, {
      allowedHosts: [allowedHost],
      keyboardSettingsPath: resolve(agentDir, "pylon-web/settings.sqlite"),
      androidHost,
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([
      new Promise<void>(resolve => server.close(() => resolve())),
      assets.close(),
      androidHost.dispose(),
      driver.dispose(),
    ]);
    const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "Pylon startup and cleanup failed");
    throw error;
  }
  if (!transport) throw new Error("transport did not initialize");
  const readyTransport = transport;
  server.on("upgrade", readyTransport.handleUpgrade);
  let closePromise: Promise<void> | undefined;
  return {
    server,
    transport: readyTransport,
    androidHost,
    close() {
      return (closePromise ??= (async () => {
        const failures: unknown[] = [];
        server.off("upgrade", readyTransport.handleUpgrade);
        readyTransport.quiesceAndroid();
        try {
          await androidHost.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          readyTransport.dispose();
        } catch (error) {
          failures.push(error);
        }
        for (const cleanup of [
          () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
          () => assets.close(),
          () => driver.dispose(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, "Pylon server cleanup failed");
      })());
    },
  };
}

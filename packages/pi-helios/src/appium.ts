import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./capture.ts";
import { terminateProcessTree } from "./process.ts";
import { reserveHeliosPort, type PortReservation } from "./port-reservation.ts";
import { loopbackUrl, validatePng } from "./capture.ts";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_JSON_BYTES = 36 * 1024 * 1024;

export const MANAGED_APPIUM_VERSION = "3.6.0";
export const MANAGED_UIAUTOMATOR2_VERSION = "8.2.2";
export type SpawnProcess = typeof spawn;
export interface AppiumInvocation {
  command: string;
  args: string[];
  version: string;
  driverVersion?: string;
  env?: NodeJS.ProcessEnv;
  managed?: boolean;
}

const MANAGED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_USER_HOME",
  "ADB_VENDOR_KEYS",
  "JAVA_HOME",
  "GRADLE_HOME",
  "GRADLE_USER_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_STRICT_SSL",
]);

export function managedAppiumEnvironment(env: NodeJS.ProcessEnv, appiumHome: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase();
    if (value !== undefined && (MANAGED_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith("LC_")))
      result[key] = value;
  }
  result.APPIUM_HOME = appiumHome;
  return result;
}

async function regularCanonicalFile(path: string, label = "Appium CLI path"): Promise<string> {
  const original = await lstat(path);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error(`${label} must be a non-symlink regular file`);
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  return canonical;
}

export async function windowsNpmCli(env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = env.npm_execpath;
  if (explicit) {
    if (!isAbsolute(explicit) || basename(explicit).toLowerCase() !== "npm-cli.js")
      throw new Error("npm_execpath must be an absolute npm-cli.js path");
    return regularCanonicalFile(explicit, "npm CLI path");
  }
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(env.PATH ?? env.Path ?? "")
      .split(delimiter)
      .filter(directory => directory && isAbsolute(directory))
      .map(directory => join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await regularCanonicalFile(candidate, "npm CLI path");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error("npm CLI candidate exists but could not be validated");
    }
  }
  throw new Error("npm CLI is unavailable; set APPIUM_PATH to Appium's CLI JavaScript file");
}

export function managedAndroidToolingDirectory(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-helios", "android-tooling", "current");
}

export async function resolveManagedAppiumAt(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppiumInvocation | undefined> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Managed Android tooling directory is invalid; repair it in Settings");
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (
    manifest.dependencies?.appium !== MANAGED_APPIUM_VERSION ||
    manifest.dependencies?.["appium-uiautomator2-driver"] !== MANAGED_UIAUTOMATOR2_VERSION
  ) {
    throw new Error("Managed Android tooling versions are invalid; repair them in Settings");
  }
  const appiumDirectory = await realpath(join(root, "node_modules", "appium"));
  const driverDirectory = await realpath(join(root, "node_modules", "appium-uiautomator2-driver"));
  for (const dependency of [appiumDirectory, driverDirectory]) {
    const fromRoot = relative(root, dependency);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot))
      throw new Error("Managed Android tooling dependency resolves outside its directory");
  }
  const appiumManifest = JSON.parse(await readFile(join(appiumDirectory, "package.json"), "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  const driverManifest = JSON.parse(await readFile(join(driverDirectory, "package.json"), "utf8")) as {
    version?: string;
  };
  if (appiumManifest.version !== MANAGED_APPIUM_VERSION || driverManifest.version !== MANAGED_UIAUTOMATOR2_VERSION)
    throw new Error("Managed Android tooling package versions are invalid; repair them in Settings");
  const binPath = typeof appiumManifest.bin === "string" ? appiumManifest.bin : appiumManifest.bin?.appium;
  if (!binPath) throw new Error("Managed Appium has no CLI entrypoint");
  const cli = await regularCanonicalFile(resolve(appiumDirectory, binPath));
  const fromPackage = relative(appiumDirectory, cli);
  if (!fromPackage || fromPackage.startsWith("..") || isAbsolute(fromPackage))
    throw new Error("Managed Appium CLI resolves outside its package");
  return {
    command: process.execPath,
    args: [cli],
    version: appiumManifest.version,
    driverVersion: driverManifest.version,
    env: managedAppiumEnvironment(env, root),
    managed: true,
  };
}

export async function resolveManagedAppium(
  agentDir = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppiumInvocation | undefined> {
  const current = managedAndroidToolingDirectory(agentDir);
  const invocation = await resolveManagedAppiumAt(current, env);
  if (invocation) return invocation;
  try {
    await lstat(join(dirname(current), "previous"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  throw new Error("Managed Android tooling recovery is incomplete; repair it in Settings");
}

export async function resolveAppium(
  exec: Exec,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppiumInvocation> {
  const cancelled = () => {
    if (signal?.aborted) throw new Error("Appium diagnostic cancelled");
  };
  cancelled();
  if (!env.APPIUM_PATH) {
    const managed = await resolveManagedAppium(getAgentDir(), env);
    if (managed) return managed;
  }
  let cli: string | undefined;
  if (env.APPIUM_PATH) {
    if (!isAbsolute(env.APPIUM_PATH)) throw new Error("APPIUM_PATH must be absolute");
    cli = await regularCanonicalFile(env.APPIUM_PATH);
  } else {
    const root =
      process.platform === "win32"
        ? await exec(process.execPath, [await windowsNpmCli(env), "root", "-g"], { timeout: 10_000, signal })
        : await exec("npm", ["root", "-g"], { timeout: 10_000, signal });
    cancelled();
    if (root.killed || root.code !== 0 || !root.stdout.trim())
      throw new Error("Appium is unavailable; install Appium globally or set APPIUM_PATH to its CLI JavaScript file");
    const packageDirectory = await realpath(resolve(root.stdout.trim(), "appium")).catch(() => {
      throw new Error("Appium is unavailable; install Appium globally or set APPIUM_PATH to its CLI JavaScript file");
    });
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binPath = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.appium;
    if (!binPath) throw new Error("Installed Appium package has no CLI entrypoint");
    const candidate = resolve(packageDirectory, binPath);
    if (!candidate.startsWith(`${resolve(packageDirectory)}${process.platform === "win32" ? "\\" : "/"}`))
      throw new Error("Installed Appium CLI entrypoint is invalid");
    cli = await regularCanonicalFile(candidate);
    const fromPackage = relative(packageDirectory, cli);
    if (!fromPackage || fromPackage.startsWith("..") || isAbsolute(fromPackage))
      throw new Error("Installed Appium CLI resolves outside its package");
  }
  const versionResult = await exec(process.execPath, [cli, "--version"], { timeout: 10_000, signal });
  cancelled();
  if (versionResult.killed || versionResult.code !== 0 || !versionResult.stdout.trim())
    throw new Error("Appium CLI could not start");
  const driverResult = await exec(process.execPath, [cli, "driver", "list", "--installed"], {
    timeout: 20_000,
    signal,
  });
  cancelled();
  if (driverResult.killed || driverResult.code !== 0 || !/uiautomator2/i.test(driverResult.stdout))
    throw new Error("Appium UiAutomator2 driver is not installed; run: appium driver install uiautomator2");
  return {
    command: process.execPath,
    args: [cli],
    version: versionResult.stdout
      .trim()
      .replace(/[\r\n]+/g, " ")
      .slice(0, 100),
  };
}

async function reservePort(): Promise<PortReservation> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = randomInt(40_000, 49_999);
    const reservation = await reserveHeliosPort(port);
    if (!reservation) continue;
    const available = await new Promise<boolean>(resolveAvailable => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveAvailable(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
    });
    if (available) return reservation;
    await reservation.release();
  }
  throw new Error("Could not allocate a loopback port for Appium");
}

function tail(value: string, chunk: Buffer, maximum = 8_192): string {
  const next = value + chunk.toString("utf8");
  return Buffer.byteLength(next) <= maximum ? next : Buffer.from(next).subarray(-maximum).toString("utf8");
}

export class AppiumServer {
  readonly child: ChildProcess;
  readonly url: string;
  readonly version: string;
  private stdout = "";
  private stderr = "";
  private startError?: string;

  private constructor(child: ChildProcess, port: number, version: string) {
    this.child = child;
    this.url = `http://127.0.0.1:${port}/`;
    this.version = version;
    child.stdout?.on("data", (data: Buffer) => {
      this.stdout = tail(this.stdout, data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr = tail(this.stderr, data);
    });
    child.once("error", error => {
      this.startError = error.message;
    });
  }

  static async start(
    invocation: AppiumInvocation,
    signal?: AbortSignal,
    spawnProcess: SpawnProcess = spawn,
  ): Promise<AppiumServer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = await reservePort();
      const { port } = reservation;
      const child = spawnProcess(
        invocation.command,
        [
          ...invocation.args,
          "--address",
          "127.0.0.1",
          "--port",
          String(port),
          "--base-path",
          "/",
          "--log-level",
          "error",
        ],
        {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          ...(invocation.env ? { env: invocation.env } : {}),
        },
      );
      const server = new AppiumServer(child, port, invocation.version);
      try {
        await server.waitReady(signal);
        return server;
      } catch (error) {
        await server.stop().catch(() => {});
        if (attempt === 2 || signal?.aborted) throw error;
      } finally {
        await reservation.release();
      }
    }
    throw new Error("Could not start Appium server");
  }

  private async waitReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Appium startup cancelled");
      if (this.startError) throw new Error(`Appium server could not start: ${compactError(this.startError)}`);
      if (this.child.exitCode !== null)
        throw new Error(`Appium server exited during startup: ${compactError(this.stderr || this.stdout)}`);
      try {
        await new AppiumClient(this.url).status(signal);
        return;
      } catch {}
      await delay(250, undefined, { signal }).catch(() => {
        throw new Error("Appium startup cancelled");
      });
    }
    throw new Error(`Appium server did not become ready: ${compactError(this.stderr || this.stdout)}`);
  }

  async stop(): Promise<void> {
    await terminateProcessTree(this.child, "Appium server");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await new AppiumClient(this.url).status(AbortSignal.timeout(500));
      } catch {
        return;
      }
      await delay(100);
    }
    throw new Error("Appium endpoint remained reachable after process cleanup");
  }
}

function compactError(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(-500) || "no diagnostic output"
  );
}

async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Appium response is oversized");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Appium response is oversized");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export class AppiumClient {
  readonly baseUrl: URL;
  sessionId?: string;

  constructor(endpoint: string) {
    const url = loopbackUrl(endpoint, ["http:"]);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
      throw new Error("Appium endpoint must be a loopback HTTP origin");
    url.pathname = "/";
    this.baseUrl = url;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    maximum = MAX_JSON_BYTES,
    timeoutMs = 30_000,
  ): Promise<any> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal(signal, timeoutMs),
    });
    const bytes = await responseBytes(response, maximum);
    let payload: any;
    try {
      payload = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
    } catch {
      throw new Error("Appium returned malformed JSON");
    }
    const value = payload?.value;
    if (!response.ok || value?.error)
      throw new Error(
        `Appium ${value?.error || response.status}: ${String(value?.message || response.statusText)
          .replace(/[\r\n]+/g, " ")
          .slice(0, 500)}`,
      );
    return payload;
  }

  async status(signal?: AbortSignal): Promise<void> {
    const payload = await this.request("GET", "status", undefined, signal, MAX_JSON_BYTES, 5_000);
    if (payload?.value?.ready !== true) throw new Error("Appium server is not ready");
  }

  async createSession(capabilities: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const payload = await this.request(
      "POST",
      "session",
      { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
      signal,
      MAX_JSON_BYTES,
      120_000,
    );
    const id = payload.sessionId ?? payload.value?.sessionId;
    if (typeof id !== "string" || !id || id.length > 200) throw new Error("Appium returned no valid session ID");
    this.sessionId = id;
    return id;
  }

  private path(suffix = ""): string {
    if (!this.sessionId) throw new Error("No active Appium session");
    return `session/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  async deleteSession(signal?: AbortSignal): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    try {
      await this.request("DELETE", `session/${encodeURIComponent(id)}`, undefined, signal, MAX_JSON_BYTES, 15_000);
    } finally {
      this.sessionId = undefined;
    }
  }

  async currentPackage(signal?: AbortSignal): Promise<string> {
    const payload = await this.request("GET", this.path("/appium/device/current_package"), undefined, signal);
    if (
      typeof payload.value !== "string" ||
      !payload.value ||
      payload.value.length > 255 ||
      /[\r\n\0]/.test(payload.value)
    )
      throw new Error("Appium returned an invalid current package");
    return payload.value;
  }

  async source(signal?: AbortSignal): Promise<string> {
    const payload = await this.request("GET", this.path("/source"), undefined, signal, MAX_JSON_BYTES, 30_000);
    if (typeof payload.value !== "string") throw new Error("Appium returned invalid Android source");
    return payload.value;
  }

  async screenshot(signal?: AbortSignal): Promise<Buffer> {
    const payload = await this.request(
      "GET",
      this.path("/screenshot"),
      undefined,
      signal,
      MAX_SCREENSHOT_JSON_BYTES,
      45_000,
    );
    if (
      typeof payload.value !== "string" ||
      payload.value.length > 35 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/=\r\n]+$/.test(payload.value)
    )
      throw new Error("Appium returned an invalid screenshot");
    const image = Buffer.from(payload.value, "base64");
    validatePng(image);
    return image;
  }

  async windowRect(signal?: AbortSignal): Promise<{ width: number; height: number }> {
    const payload = await this.request("GET", this.path("/window/rect"), undefined, signal);
    const width = Number(payload.value?.width),
      height = Number(payload.value?.height);
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16_384))
      throw new Error("Appium returned an invalid window size");
    return { width, height };
  }

  async tap(x: number, y: number, signal?: AbortSignal): Promise<void> {
    await this.request(
      "POST",
      this.path("/actions"),
      {
        actions: [
          {
            type: "pointer",
            id: "finger",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", x, y },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: 100 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      },
      signal,
    );
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    await this.request(
      "POST",
      this.path("/actions"),
      {
        actions: [
          {
            type: "pointer",
            id: "finger",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", ...from },
              { type: "pointerDown", button: 0 },
              { type: "pointerMove", duration: 500, origin: "viewport", ...to },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      },
      signal,
    );
  }

  async findByXpath(xpath: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.request("POST", this.path("/element"), { using: "xpath", value: xpath }, signal);
    const id = payload.value?.[ELEMENT_KEY] ?? payload.value?.ELEMENT;
    if (typeof id !== "string" || !id || id.length > 500)
      throw new Error("Appium returned an invalid element reference");
    return id;
  }

  async fillElement(elementId: string, text: string, signal?: AbortSignal): Promise<void> {
    const element = `${this.path("/element/")}${encodeURIComponent(elementId)}`;
    await this.request("POST", `${element}/clear`, {}, signal);
    await this.request("POST", `${element}/value`, { text, value: Array.from(text) }, signal);
  }

  async back(signal?: AbortSignal): Promise<void> {
    await this.request("POST", this.path("/back"), {}, signal);
  }
}

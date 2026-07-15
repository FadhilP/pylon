import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { validatePngFile, type Exec } from "./capture.ts";

const CLI_PATH = fileURLToPath(import.meta.resolve("@playwright/cli/playwright-cli.js"));
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_SNAPSHOT_LINES = 500;
const MAX_SNAPSHOT_BYTES = 50 * 1024;
const SESSION_NAME = /^helios-[a-f0-9]{12}-[a-f0-9]{12}$/;
const ELEMENT_REF = /^e\d+$/;

export type BrowserOwnership = "owned" | "cdp-attached" | "extension-attached";
export type BrowserAction =
  | { kind: "open"; url?: string; profileDirectory: string; headed: boolean }
  | { kind: "attach-cdp"; endpoint: string }
  | { kind: "attach-extension"; browser: "chrome" | "msedge" }
  | { kind: "navigate"; url: string }
  | { kind: "link-url"; target: string }
  | { kind: "snapshot"; target?: string; depth?: number }
  | { kind: "screenshot"; target?: string; fullPage?: boolean }
  | { kind: "click" | "hover" | "check" | "uncheck"; target: string }
  | { kind: "fill"; target: string; text: string }
  | { kind: "press"; key: string }
  | { kind: "select"; target: string; value: string }
  | { kind: "back" | "forward" | "reload" | "tab-list" | "detach" | "close" | "list" }
  | { kind: "tab-new"; url?: string }
  | { kind: "tab-select" | "tab-close"; index: number };

export interface CliResult {
  value: Record<string, unknown>;
  snapshot?: string;
  snapshotRedactions?: number;
  snapshotTruncated?: boolean;
  snapshotOmittedLines?: number;
  snapshotOmittedBytes?: number;
  artifactPath?: string;
}

export type HeliosCliErrorCategory = "cancelled" | "timeout" | "unavailable" | "invalid-output" | "command-failed" | "session-missing";

export class HeliosCliError extends Error {
  readonly category: HeliosCliErrorCategory;

  constructor(category: HeliosCliErrorCategory, message: string) {
    super(message);
    this.category = category;
    this.name = "HeliosCliError";
  }
}

export async function diagnosePlaywrightCli(exec: Exec): Promise<string> {
  await access(CLI_PATH).catch(() => { throw new HeliosCliError("unavailable", "Pinned @playwright/cli executable is unavailable; reinstall pi-helios"); });
  const result = await exec(process.execPath, [CLI_PATH, "--version"], { timeout: 10_000 });
  if (result.killed) throw new HeliosCliError("timeout", "Playwright CLI diagnostic timed out");
  if (result.code !== 0) throw new HeliosCliError("unavailable", "Pinned @playwright/cli could not start; reinstall pi-helios");
  const version = result.stdout.trim().replace(/[\r\n]+/g, " ").slice(0, 100);
  if (!version) throw new HeliosCliError("invalid-output", "Playwright CLI returned no version");
  return version;
}

export function validateNavigationUrl(value: string): string {
  if (value === "about:blank") return value;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Helios browser navigation permits only HTTP(S) URLs or about:blank");
  if (url.username || url.password) throw new Error("Helios browser URLs must not contain credentials");
  if (value.length > 4096) throw new Error("Browser URL exceeds 4096 character limit");
  return url.href;
}

function target(value: string): string {
  if (!ELEMENT_REF.test(value)) throw new Error("Browser element target must be a current snapshot reference such as e12");
  return value;
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
  /\b(?:authorization|api[_-]?key|token|password|secret|cookie)\s*[:=]\s*[^\r\n]+/gi,
  /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

interface BoundedSnapshot {
  content: string;
  redactions: number;
  truncated: boolean;
  omittedLines: number;
  omittedBytes: number;
}

export interface PlaywrightCliOptions {
  maxSnapshotLines?: number;
  maxSnapshotBytes?: number;
}

function boundedSnapshot(value: string, options: PlaywrightCliOptions): BoundedSnapshot {
  let redactions = 0;
  let redacted = value.replace(/(\b(?:textbox|searchbox|combobox|spinbutton)\b.*\[ref=e\d+\])\s*:.+$/gim, (_match, field: string) => {
    redactions++;
    return `${field}: [value redacted]`;
  });
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactions++;
      return "[possible credential redacted]";
    });
  }
  const lines = redacted.split(/\r?\n/);
  let bytes = 0;
  let index = 0;
  const kept: string[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    const size = Buffer.byteLength(line) + (kept.length ? 1 : 0);
    if (kept.length >= (options.maxSnapshotLines ?? MAX_SNAPSHOT_LINES) || bytes + size > (options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES)) break;
    kept.push(line);
    bytes += size;
  }
  const truncated = index < lines.length;
  if (truncated) kept.push("[Snapshot truncated by Helios]");
  return {
    content: kept.join("\n"),
    redactions,
    truncated,
    omittedLines: lines.length - index,
    omittedBytes: truncated ? Buffer.byteLength(lines.slice(index).join("\n")) : 0,
  };
}

function parseJson(result: ExecResult, privateDirectory: string, sessionName: string): Record<string, unknown> {
  if (Buffer.byteLength(result.stdout) > MAX_STDOUT_BYTES) throw new HeliosCliError("invalid-output", "Playwright CLI output exceeded 256KB limit");
  if (Buffer.byteLength(result.stderr) > MAX_STDERR_BYTES) throw new HeliosCliError("invalid-output", "Playwright CLI error output exceeded 16KB limit");
  if (result.killed) throw new HeliosCliError("timeout", "Playwright CLI command timed out");
  if (result.code !== 0 && !result.stdout.trim()) throw new HeliosCliError("command-failed", "Playwright CLI command failed");
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new HeliosCliError("invalid-output", "Playwright CLI returned malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HeliosCliError("invalid-output", "Playwright CLI returned an unexpected result");
  const object = value as Record<string, unknown>;
  if (result.code !== 0 || object.isError === true) {
    const raw = typeof object.error === "string" ? object.error : "Playwright CLI command failed";
    const sanitized = raw.replaceAll(privateDirectory, "<private Helios directory>").replace(/[\r\n]+/g, " ").slice(0, 500);
    const category = raw === `The browser '${sessionName}' is not open, please run open first` ? "session-missing" : "command-failed";
    throw new HeliosCliError(category, sanitized);
  }
  return object;
}

export class PlaywrightCli {
  private readonly exec: Exec;
  readonly directory: string;
  private readonly configPath: string;
  private readonly options: PlaywrightCliOptions;
  private configReady?: Promise<void>;

  private constructor(exec: Exec, directory: string, configPath: string, options: PlaywrightCliOptions) {
    this.exec = exec;
    this.directory = directory;
    this.configPath = configPath;
    this.options = options;
  }

  static async create(exec: Exec, options: PlaywrightCliOptions = {}): Promise<PlaywrightCli> {
    await access(CLI_PATH).catch(() => { throw new HeliosCliError("unavailable", "Pinned @playwright/cli executable is unavailable; reinstall pi-helios"); });
    const directory = await mkdtemp(join(tmpdir(), "pi-helios-browser-"));
    await chmod(directory, 0o700).catch(() => {});
    const outputDirectory = join(directory, "artifacts");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    return new PlaywrightCli(exec, directory, join(directory, "cli.config.json"), options);
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  async configureOwned(profileDirectory: string, headed: boolean, webIsolation?: { proxy: { server: string; username: string; password: string } }): Promise<void> {
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await this.writeConfig({
      outputDir: join(this.directory, "artifacts"),
      outputMode: "stdout",
      codegen: "none",
      browser: {
        isolated: true,
        launchOptions: {
          headless: !headed,
          ...(webIsolation ? {
            proxy: webIsolation.proxy,
            args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
          } : {}),
        },
        ...(webIsolation ? { contextOptions: { acceptDownloads: false, serviceWorkers: "block" } } : {}),
      },
    });
  }

  async run(sessionName: string, action: BrowserAction, signal?: AbortSignal): Promise<CliResult> {
    if (!SESSION_NAME.test(sessionName)) throw new Error("Unsafe Playwright CLI session name");
    if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
    await this.ensureConfig();
    const { command, args, artifactPath, timeout } = this.arguments(action);
    const invocation = [CLI_PATH, "--json", `-s=${sessionName}`, command, ...args];
    let result: ExecResult;
    try {
      result = await this.exec(process.execPath, invocation, { signal, timeout, cwd: this.directory });
    } catch (error) {
      if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
      throw new HeliosCliError("unavailable", error instanceof Error ? error.message.slice(0, 300) : "Could not start Playwright CLI");
    }
    if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
    const value = parseJson(result, this.directory, sessionName);
    const nested = value.result && typeof value.result === "object" ? value.result as Record<string, unknown> : undefined;
    const rawSnapshot = typeof value.snapshot === "string" ? value.snapshot : typeof nested?.snapshot === "string" ? nested.snapshot : undefined;
    delete value.snapshot;
    if (nested) delete nested.snapshot;
    if (artifactPath) {
      try { await validatePngFile(artifactPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HeliosCliError("invalid-output", "Playwright CLI produced no screenshot file");
        throw error;
      }
    }
    const snapshot = rawSnapshot === undefined ? undefined : boundedSnapshot(rawSnapshot, this.options);
    return {
      value,
      snapshot: snapshot?.content,
      snapshotRedactions: snapshot?.redactions,
      snapshotTruncated: snapshot?.truncated,
      snapshotOmittedLines: snapshot?.omittedLines,
      snapshotOmittedBytes: snapshot?.omittedBytes,
      artifactPath,
    };
  }

  private ensureConfig(): Promise<void> {
    return this.configReady ?? this.writeConfig({ outputDir: join(this.directory, "artifacts"), outputMode: "stdout", codegen: "none" });
  }

  private writeConfig(config: Record<string, unknown>): Promise<void> {
    const writing = writeFile(this.configPath, JSON.stringify(config), { mode: 0o600 });
    this.configReady = writing.catch((error) => { this.configReady = undefined; throw error; });
    return this.configReady;
  }

  private arguments(action: BrowserAction): { command: string; args: string[]; artifactPath?: string; timeout: number } {
    const normal = 20_000;
    switch (action.kind) {
      case "open": return { command: "open", args: [...(action.url ? [validateNavigationUrl(action.url)] : []), ...(action.headed ? ["--headed"] : []), `--config=${this.configPath}`], timeout: 75_000 };
      case "attach-cdp": return { command: "attach", args: [`--cdp=${action.endpoint}`, `--config=${this.configPath}`], timeout: 45_000 };
      case "attach-extension": return { command: "attach", args: [`--extension=${action.browser}`, `--config=${this.configPath}`], timeout: 45_000 };
      case "navigate": return { command: "goto", args: [validateNavigationUrl(action.url)], timeout: 75_000 };
      case "link-url": return { command: "eval", args: ["el => el instanceof HTMLAnchorElement ? el.href : ''", target(action.target)], timeout: normal };
      case "snapshot": {
        if (action.depth !== undefined && (!Number.isInteger(action.depth) || action.depth < 1 || action.depth > 20)) throw new Error("Snapshot depth must be an integer from 1 to 20");
        return { command: "snapshot", args: [...(action.target ? [target(action.target)] : []), ...(action.depth ? [`--depth=${action.depth}`] : [])], timeout: normal };
      }
      case "screenshot": {
        const artifactPath = join(this.directory, "artifacts", `screenshot-${Date.now()}-${crypto.randomUUID()}.png`);
        return { command: "screenshot", args: [...(action.target ? [target(action.target)] : []), `--filename=${artifactPath}`, ...(action.fullPage ? ["--full-page"] : [])], artifactPath, timeout: 45_000 };
      }
      case "click": case "hover": case "check": case "uncheck": return { command: action.kind, args: [target(action.target)], timeout: normal };
      case "fill":
        if (action.text.length > 10_000) throw new Error("Fill text exceeds 10000 character limit");
        return { command: "fill", args: [target(action.target), action.text], timeout: normal };
      case "press":
        if (!action.key || action.key.length > 64 || !/^[\w +\-]+$/u.test(action.key)) throw new Error("Unsupported browser key");
        return { command: "press", args: [action.key], timeout: normal };
      case "select":
        if (!action.value || action.value.length > 1000) throw new Error("Select value must contain 1 to 1000 characters");
        return { command: "select", args: [target(action.target), action.value], timeout: normal };
      case "back": return { command: "go-back", args: [], timeout: 75_000 };
      case "forward": return { command: "go-forward", args: [], timeout: 75_000 };
      case "reload": return { command: "reload", args: [], timeout: 75_000 };
      case "tab-list": return { command: "tab-list", args: [], timeout: normal };
      case "tab-new": return { command: "tab-new", args: action.url ? [validateNavigationUrl(action.url)] : [], timeout: 75_000 };
      case "tab-select": case "tab-close":
        if (!Number.isInteger(action.index) || action.index < 0 || action.index > 100) throw new Error("Tab index must be an integer from 0 to 100");
        return { command: action.kind, args: [String(action.index)], timeout: normal };
      case "detach": case "close": case "list": return { command: action.kind, args: [], timeout: normal };
    }
  }
}

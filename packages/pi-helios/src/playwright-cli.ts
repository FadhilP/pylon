import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { validatePngFile, type Exec } from "./capture.ts";
import { elementReferences, ELEMENT_REF_FRAGMENT, isElementReference } from "./element-ref.ts";
import { PlaywrightClient, PlaywrightClientError } from "./playwright-client.ts";

const CLI_PATH = fileURLToPath(new URL("./playwright-thin-cli.mjs", import.meta.url));
const PINNED_CLI_PATH = fileURLToPath(import.meta.resolve("@playwright/cli/playwright-cli.js"));
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_SNAPSHOT_LINES = 200;
const MAX_SNAPSHOT_BYTES = 20 * 1024;
const MAX_FIND_LINES = 80;
const MAX_FIND_BYTES = 8 * 1024;
const MAX_ACTION_SNAPSHOT_LINES = 60;
const MAX_ACTION_SNAPSHOT_BYTES = 6 * 1024;
const SNAPSHOT_FILE_SETTLE_ATTEMPTS = 20;
const SNAPSHOT_FILE_SETTLE_MS = 25;
const PAGE_TEXT_MAX_CHARS = 32 * 1024;
const PAGE_TEXT_EXPRESSION = `() => { const text = document.body?.innerText ?? document.documentElement?.textContent ?? ''; return JSON.stringify({ contentType: document.contentType, text: text.slice(0, ${PAGE_TEXT_MAX_CHARS}), truncated: text.length > ${PAGE_TEXT_MAX_CHARS} }); }`;
const SESSION_NAME = /^helios-[a-f0-9]{12}-[a-f0-9]{12}$/;
const CONTINUATION_CURSOR = /^hc_[a-f0-9]{32}$/;
const MAX_CONTINUATIONS_PER_SESSION = 20;
const MAX_CONTINUATIONS = 32;
const MAX_CONTINUATION_BYTES = 4 * 1024 * 1024;
const CLEARS_CONTINUATIONS = new Set(["open", "attach-cdp", "attach-extension", "close", "detach"]);
const INVALIDATES_CONTINUATIONS = new Set([
  "navigate",
  "click",
  "fill",
  "press",
  "hover",
  "select",
  "check",
  "uncheck",
  "mouse-move",
  "mouse-down",
  "mouse-up",
  "mouse-wheel",
  "key-down",
  "key-up",
  "resize",
  "back",
  "forward",
  "reload",
  "tab-new",
  "tab-select",
  "tab-close",
]);

const BROWSER_NAMED_KEYS = [
  "Alt",
  "AltGraph",
  "AltLeft",
  "AltRight",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "AudioVolumeDown",
  "AudioVolumeMute",
  "AudioVolumeUp",
  "Backquote",
  "Backslash",
  "Backspace",
  "BracketLeft",
  "BracketRight",
  "CapsLock",
  "Comma",
  "ContextMenu",
  "Control",
  "ControlLeft",
  "ControlOrMeta",
  "ControlRight",
  "Delete",
  "End",
  "Enter",
  "Equal",
  "Escape",
  "Home",
  "Insert",
  "MediaPlayPause",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "Meta",
  "MetaLeft",
  "MetaRight",
  "Minus",
  "NumLock",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadMultiply",
  "NumpadSubtract",
  "PageDown",
  "PageUp",
  "Pause",
  "Period",
  "PrintScreen",
  "Quote",
  "ScrollLock",
  "Semicolon",
  "Shift",
  "ShiftLeft",
  "ShiftRight",
  "Slash",
  "Space",
  "Tab",
] as const;
const CANONICAL_BROWSER_NAMED_KEY = new Map(BROWSER_NAMED_KEYS.map(key => [key.toLowerCase(), key]));

export type BrowserOwnership = "owned" | "cdp-attached" | "extension-attached";
export type BrowserAction =
  | { kind: "open"; url?: string; profileDirectory: string; headed: boolean }
  | { kind: "attach-cdp"; endpoint: string }
  | { kind: "attach-extension"; browser: "chrome" | "msedge" }
  | { kind: "navigate"; url: string }
  | { kind: "link-url"; target: string }
  | { kind: "base-url" }
  | { kind: "page-text" }
  | { kind: "snapshot"; target?: string; depth?: number; snapshotMode?: "compact" | "full" }
  | { kind: "continue"; cursor: string }
  | { kind: "find"; text?: string; regex?: string }
  | { kind: "screenshot"; target?: string; fullPage?: boolean }
  | { kind: "click" | "hover" | "check" | "uncheck"; target: string }
  | { kind: "fill"; target: string; text: string }
  | { kind: "press"; key: string }
  | { kind: "select"; target: string; value: string }
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-down" | "mouse-up"; button: "left" | "middle" | "right" }
  | { kind: "mouse-wheel"; deltaX: number; deltaY: number }
  | { kind: "key-down" | "key-up"; key: string }
  | { kind: "resize"; width: number; height: number }
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
  findMatches?: number;
  snapshotContinuation?: string;
  snapshotLinks?: Record<string, string>;
  artifactPath?: string;
  baseUrl?: string;
  textContentType?: string;
  textContentTruncated?: boolean;
}

export type HeliosCliErrorCategory =
  "cancelled" | "timeout" | "unavailable" | "invalid-output" | "command-failed" | "session-missing";

export class HeliosCliError extends Error {
  readonly category: HeliosCliErrorCategory;
  readonly uncertainOutcome: boolean;

  constructor(category: HeliosCliErrorCategory, message: string, uncertainOutcome = false) {
    super(message);
    this.category = category;
    this.uncertainOutcome = uncertainOutcome;
    this.name = "HeliosCliError";
  }
}

export async function diagnosePlaywrightCli(exec: Exec): Promise<string> {
  await access(CLI_PATH).catch(() => {
    throw new HeliosCliError("unavailable", "Pinned @playwright/cli executable is unavailable; reinstall pi-helios");
  });
  const result = await exec(process.execPath, [CLI_PATH, "--version"], { timeout: 10_000 });
  if (result.killed) throw new HeliosCliError("timeout", "Playwright CLI diagnostic timed out");
  if (result.code !== 0)
    throw new HeliosCliError("unavailable", "Pinned @playwright/cli could not start; reinstall pi-helios");
  const version = result.stdout
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
  if (!version) throw new HeliosCliError("invalid-output", "Playwright CLI returned no version");
  return version;
}

export function validateNavigationUrl(value: string): string {
  if (value.length > 4096) throw new Error("Browser URL exceeds 4096 character limit");
  if (value === "about:blank") return value;
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Helios browser URLs must not contain credentials");
  if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  if (url.protocol !== "file:")
    throw new Error("Helios browser navigation permits only HTTP(S) URLs, local HTML file URLs, or about:blank");
  if (url.hostname) throw new Error("Helios browser local files must not use remote hosts");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("Helios browser local HTML file URL has invalid percent-encoding");
  }
  if (/^[\\/]{2}/u.test(pathname)) throw new Error("Helios browser local files must not use network paths");
  if (!/\.html?$/iu.test(pathname)) throw new Error("Helios browser local file URLs must point to an HTML file");
  return url.href;
}

function target(value: string): string {
  if (!isElementReference(value))
    throw new Error("Browser element target must be a current snapshot reference such as e12 or f1e12");
  return value;
}

function canonicalBrowserKeyToken(key: string): string {
  if (key.length <= 1) return key;
  const lower = key.toLowerCase();
  const named = CANONICAL_BROWSER_NAMED_KEY.get(lower);
  if (named) return named;
  if (/^f(?:[1-9]|1[0-2])$/u.test(lower)) return lower.toUpperCase();
  const code = /^(digit|key|numpad)([a-z0-9])$/u.exec(lower);
  if (!code) return key;
  return `${code[1][0].toUpperCase()}${code[1].slice(1)}${code[2].toUpperCase()}`;
}

function canonicalBrowserKey(key: string): string {
  let result = "";
  let token = "";
  for (const character of key) {
    if (character === "+" && token) {
      result += `${canonicalBrowserKeyToken(token)}+`;
      token = "";
    } else {
      token += character;
    }
  }
  return result + canonicalBrowserKeyToken(token);
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
  /\b(?:authorization|api[_-]?key|token|password|secret|cookie)\s*[:=]\s*[^\r\n]+/gi,
  /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

interface BoundedSnapshot {
  content: string;
  truncated: boolean;
  omittedLines: number;
  omittedBytes: number;
  nextIndex?: number;
}

interface RedactedSnapshot {
  lines: string[];
  redactions: number;
}

interface PendingContinuation {
  sessionName: string;
  lines: string[];
  nextIndex: number;
  limits: { lines: number; bytes: number };
  links: Record<string, string>;
  bytes: number;
}

function snapshotScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function snapshotLinkTargets(lines: string[]): Record<string, string> {
  const links: Record<string, string> = {};
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!/^\s*- link\b/i.test(line)) continue;
    const ref = elementReferences(line)[0];
    if (!ref) continue;
    const indentation = line.length - line.trimStart().length;
    for (let child = index + 1; child < lines.length; child++) {
      const childLine = lines[child];
      const childIndentation = childLine.length - childLine.trimStart().length;
      if (childLine.trim() && childIndentation <= indentation) break;
      const url = /^\s*- \/url:\s*(.+)\s*$/.exec(childLine)?.[1];
      if (!url) continue;
      links[ref] = snapshotScalar(url);
      break;
    }
  }
  return links;
}

function linksForSnapshot(
  snapshot: string | undefined,
  links: Record<string, string>,
): Record<string, string> | undefined {
  if (!snapshot) return undefined;
  const entries = elementReferences(snapshot).flatMap(ref =>
    links[ref] === undefined ? [] : ([[ref, links[ref]]] as const),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

interface PersistentClient {
  run(
    sessionName: string,
    command: string,
    args: string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ExecResult>;
  dispose(): Promise<void>;
}

export interface PlaywrightCliOptions {
  maxSnapshotLines?: number;
  preserveContinuationsAcrossActions?: boolean;
  maxSnapshotBytes?: number;
  maxActionSnapshotLines?: number;
  maxActionSnapshotBytes?: number;
  persistentClient?: boolean;
  clientFactory?: (directory: string) => Promise<PersistentClient>;
}

function validateOptions(options: PlaywrightCliOptions): void {
  for (const name of [
    "maxSnapshotLines",
    "maxSnapshotBytes",
    "maxActionSnapshotLines",
    "maxActionSnapshotBytes",
  ] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    const minimum = name.endsWith("Lines") ? 1 : 4;
    if (value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  }
  if (
    options.preserveContinuationsAcrossActions !== undefined &&
    typeof options.preserveContinuationsAcrossActions !== "boolean"
  )
    throw new Error("preserveContinuationsAcrossActions must be a boolean");
  if (options.persistentClient !== undefined && typeof options.persistentClient !== "boolean")
    throw new Error("persistentClient must be a boolean");
}

function snapshotLimits(action: BrowserAction, options: PlaywrightCliOptions): { lines: number; bytes: number } {
  if (action.kind === "find")
    return { lines: options.maxSnapshotLines ?? MAX_FIND_LINES, bytes: options.maxSnapshotBytes ?? MAX_FIND_BYTES };
  if (action.kind === "snapshot")
    return {
      lines: options.maxSnapshotLines ?? MAX_SNAPSHOT_LINES,
      bytes: options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES,
    };
  return {
    lines: options.maxActionSnapshotLines ?? options.maxSnapshotLines ?? MAX_ACTION_SNAPSHOT_LINES,
    bytes: options.maxActionSnapshotBytes ?? options.maxSnapshotBytes ?? MAX_ACTION_SNAPSHOT_BYTES,
  };
}

function findMatchCount(value: string): number | undefined {
  const firstLine = value.split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^Found (\d+) match(?:es)?\b/);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : undefined;
}

function pageTextResult(value: unknown): { contentType: string; text: string; truncated: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.contentType !== "string" ||
    typeof record.text !== "string" ||
    typeof record.truncated !== "boolean"
  )
    return undefined;
  const contentType = record.contentType.split(";", 1)[0].trim().toLowerCase();
  if (
    contentType !== "text/plain" &&
    contentType !== "text/markdown" &&
    contentType !== "application/markdown" &&
    contentType !== "application/json" &&
    !contentType.endsWith("+json")
  )
    return undefined;
  return { contentType, text: record.text, truncated: record.truncated };
}

function redactSnapshot(value: string): RedactedSnapshot {
  let redactions = 0;
  let redacted = value.replace(
    new RegExp(`(\\b(?:textbox|searchbox|combobox|spinbutton)\\b.*\\[ref=${ELEMENT_REF_FRAGMENT}\\])\\s*:.+$`, "gim"),
    (_match, field: string) => {
      redactions++;
      return `${field}: [value redacted]`;
    },
  );
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactions++;
      return "[possible credential redacted]";
    });
  }
  return { lines: redacted.split(/\r?\n/), redactions };
}

export function compactSnapshotLines(lines: string[]): string[] {
  const indentation = lines.map(line => line.match(/^\s*/u)?.[0] ?? "");
  if (lines.some((line, index) => line.trim() && (/[^ ]/u.test(indentation[index]) || indentation[index].length % 2)))
    return lines;

  const wrapper = new RegExp(`^( *)- generic \\[ref=(${ELEMENT_REF_FRAGMENT})\\](:?)$`);
  const removed: number[] = [];
  const compacted: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      compacted.push(line);
      continue;
    }
    const indent = indentation[index].length;
    while (removed.length && indent <= removed.at(-1)!) removed.pop();
    const match = line.match(wrapper);
    if (match) {
      if (match[3]) removed.push(indent);
      continue;
    }
    compacted.push(line.slice(removed.length * 2));
  }
  return compacted;
}

function splitOversizedLines(lines: string[], maxBytes: number): string[] {
  const output: string[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) <= maxBytes) {
      output.push(line);
      continue;
    }
    let chunk = "";
    let bytes = 0;
    for (const character of line) {
      const size = Buffer.byteLength(character);
      if (chunk && bytes + size > maxBytes) {
        output.push(chunk);
        chunk = "";
        bytes = 0;
      }
      chunk += character;
      bytes += size;
    }
    if (chunk) output.push(chunk);
  }
  return output;
}

function boundedSnapshot(lines: string[], start: number, limits: { lines: number; bytes: number }): BoundedSnapshot {
  let bytes = 0;
  let index = start;
  const kept: string[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    const size = Buffer.byteLength(line) + (kept.length ? 1 : 0);
    if (kept.length >= limits.lines || bytes + size > limits.bytes) break;
    kept.push(line);
    bytes += size;
  }
  const truncated = index < lines.length;
  return {
    content: kept.join("\n"),
    truncated,
    omittedLines: lines.length - index,
    omittedBytes: truncated ? Buffer.byteLength(lines.slice(index).join("\n")) : 0,
    nextIndex: truncated ? index : undefined,
  };
}

function commandFailureMessage(stderr: string): string {
  if (
    /\bBrowser "(chrome|chromium|firefox|webkit|msedge)" is not installed\. Run `playwright-cli install-browser \1` to install\b/.test(
      stderr,
    )
  ) {
    return "Playwright browser is not installed; run the matching `playwright-cli install-browser` setup command";
  }
  return "Playwright CLI command failed; run /helios doctor browser for diagnostics";
}

type SnapshotSource = string | { file: string };

function snapshotSource(value: unknown): SnapshotSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.file === "string" && object.file)
      return { file: object.file };
  }
  throw new HeliosCliError("invalid-output", "Playwright CLI returned an invalid snapshot");
}

function parseJson(result: ExecResult, privateDirectory: string, sessionName: string): Record<string, unknown> {
  if (Buffer.byteLength(result.stdout) > MAX_STDOUT_BYTES)
    throw new HeliosCliError("invalid-output", "Playwright CLI output exceeded 256KB limit");
  if (Buffer.byteLength(result.stderr) > MAX_STDERR_BYTES)
    throw new HeliosCliError("invalid-output", "Playwright CLI error output exceeded 16KB limit");
  if (result.killed) throw new HeliosCliError("timeout", "Playwright CLI command timed out");
  if (result.code !== 0 && !result.stdout.trim())
    throw new HeliosCliError("command-failed", commandFailureMessage(result.stderr));
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new HeliosCliError("invalid-output", "Playwright CLI returned malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HeliosCliError("invalid-output", "Playwright CLI returned an unexpected result");
  const object = value as Record<string, unknown>;
  const nested =
    object.result && typeof object.result === "object" && !Array.isArray(object.result)
      ? (object.result as Record<string, unknown>)
      : undefined;
  if (result.code !== 0 || object.isError === true || nested?.isError === true) {
    const raw =
      typeof object.error === "string"
        ? object.error
        : nested?.isError === true && typeof nested.error === "string"
          ? nested.error
          : "Playwright CLI command failed";
    const sanitized = raw
      .replaceAll(privateDirectory, "<private Helios directory>")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
    const category =
      raw === `The browser '${sessionName}' is not open, please run open first` ? "session-missing" : "command-failed";
    throw new HeliosCliError(category, sanitized);
  }
  return object;
}

export class PlaywrightCli {
  private readonly exec: Exec;
  readonly directory: string;
  private readonly configPath: string;
  private readonly options: PlaywrightCliOptions;
  private readonly continuations = new Map<string, PendingContinuation>();
  private continuationBytes = 0;
  private configReady?: Promise<void>;
  private client?: Promise<PersistentClient | undefined>;
  private clientUnavailable = false;

  private constructor(exec: Exec, directory: string, configPath: string, options: PlaywrightCliOptions) {
    this.exec = exec;
    this.directory = directory;
    this.configPath = configPath;
    this.options = options;
  }

  static async create(exec: Exec, options: PlaywrightCliOptions = {}): Promise<PlaywrightCli> {
    validateOptions(options);
    await Promise.all([access(CLI_PATH), access(PINNED_CLI_PATH)]).catch(() => {
      throw new HeliosCliError("unavailable", "Pinned @playwright/cli executable is unavailable; reinstall pi-helios");
    });
    const directory = await mkdtemp(join(tmpdir(), "pi-helios-browser-"));
    await chmod(directory, 0o700).catch(() => {});
    const outputDirectory = join(directory, "artifacts");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    return new PlaywrightCli(exec, directory, join(directory, "cli.config.json"), options);
  }

  async dispose(): Promise<void> {
    this.clearContinuations();
    const client = await this.client?.catch(() => undefined);
    await client?.dispose().catch(() => {});
    this.client = undefined;
    await rm(this.directory, { recursive: true, force: true });
  }

  private artifactPath(path: string): string {
    const artifactDirectory = resolve(this.directory, "artifacts");
    const resolved = resolve(this.directory, path);
    if (dirname(resolved) !== artifactDirectory) throw new Error("Invalid Helios artifact path");
    return resolved;
  }

  async readArtifact(path: string, maximumBytes: number): Promise<Buffer> {
    const resolved = this.artifactPath(path);
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid Helios artifact path");
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes)
      throw new Error("Helios artifact is invalid or oversized");
    const handle = await open(resolved, "r");
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size <= 0 || current.size > maximumBytes)
        throw new Error("Helios artifact is invalid or oversized");
      const buffer = Buffer.allocUnsafe(maximumBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead <= 0 || bytesRead > maximumBytes) throw new Error("Helios artifact is invalid or oversized");
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async readSnapshot(source: SnapshotSource | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (source === undefined || typeof source === "string") return source;
    let path: string;
    try {
      path = this.artifactPath(source.file);
    } catch {
      throw new HeliosCliError("invalid-output", "Playwright CLI returned an invalid snapshot artifact");
    }
    try {
      let previousSize = -1;
      let emptyObservations = 0;
      for (let attempt = 0; attempt < SNAPSHOT_FILE_SETTLE_ATTEMPTS; attempt++) {
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STDOUT_BYTES)
            throw new Error("Invalid snapshot artifact");
          if (info.size === 0) {
            if (++emptyObservations >= 3) return "";
          } else {
            emptyObservations = 0;
            if (info.size === previousSize) {
              const data = await this.readArtifact(path, MAX_STDOUT_BYTES);
              try {
                return new TextDecoder("utf-8", { fatal: true }).decode(data);
              } catch {
                throw new HeliosCliError("invalid-output", "Playwright CLI returned an invalid snapshot artifact");
              }
            }
          }
          previousSize = info.size;
        }
        if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
        await delay(SNAPSHOT_FILE_SETTLE_MS);
      }
      if (previousSize === 0) {
        const final = await lstat(path);
        if (final.isFile() && !final.isSymbolicLink() && final.size === 0) return "";
      }
      throw new Error("Snapshot artifact did not settle");
    } catch (error) {
      if (error instanceof HeliosCliError) throw error;
      throw new HeliosCliError("invalid-output", "Playwright CLI returned an invalid snapshot artifact");
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }

  async configureOwned(
    profileDirectory: string,
    headed: boolean,
    webIsolation?: { proxy: { server: string } },
  ): Promise<void> {
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    await this.writeConfig({
      outputDir: join(this.directory, "artifacts"),
      outputMode: "stdout",
      codegen: "none",
      allowUnrestrictedFileAccess: !webIsolation,
      browser: {
        isolated: false,
        userDataDir: profileDirectory,
        launchOptions: {
          headless: !headed,
          args: [
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            ...(webIsolation
              ? [
                  "--proxy-bypass-list=<-loopback>",
                  "--disable-quic",
                  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                ]
              : []),
          ],
          ...(webIsolation ? { proxy: webIsolation.proxy } : {}),
        },
        contextOptions: {
          viewport: { width: 1440, height: 900 },
          ...(webIsolation ? { acceptDownloads: false, serviceWorkers: "block" as const } : {}),
        },
      },
    });
  }

  async run(sessionName: string, action: BrowserAction, signal?: AbortSignal): Promise<CliResult> {
    if (!SESSION_NAME.test(sessionName)) throw new Error("Unsafe Playwright CLI session name");
    if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
    if (action.kind === "continue") return this.continueSnapshot(sessionName, action.cursor);
    if (CLEARS_CONTINUATIONS.has(action.kind)) this.clearContinuations(sessionName);
    else if (
      !this.options.preserveContinuationsAcrossActions &&
      (INVALIDATES_CONTINUATIONS.has(action.kind) || action.kind === "snapshot" || action.kind === "find")
    )
      this.clearContinuations(sessionName);
    await this.ensureConfig();
    const { command, args, artifactPath, timeout } = this.arguments(action);
    const result = await this.execute(action, sessionName, command, args, timeout, signal);
    if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
    const value = parseJson(result, this.directory, sessionName);
    const nested =
      value.result && typeof value.result === "object" ? (value.result as Record<string, unknown>) : undefined;
    const source = snapshotSource(value.snapshot !== undefined ? value.snapshot : nested?.snapshot);
    delete value.snapshot;
    if (nested) delete nested.snapshot;
    const textResult = action.kind === "page-text" ? pageTextResult(value.result) : undefined;
    if (action.kind === "page-text" && !textResult)
      throw new HeliosCliError("invalid-output", "Browser text fallback unavailable");
    const rawSnapshot =
      (await this.readSnapshot(source, signal)) ??
      textResult?.text ??
      (action.kind === "find" && typeof value.result === "string" ? value.result : undefined);
    if (action.kind === "find" && typeof value.result === "string") delete value.result;
    if (rawSnapshot !== undefined && !this.options.preserveContinuationsAcrossActions)
      this.clearContinuations(sessionName);
    if (artifactPath) {
      try {
        await validatePngFile(artifactPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new HeliosCliError("invalid-output", "Playwright CLI produced no screenshot file");
        throw error;
      }
    }
    const limits = snapshotLimits(action, this.options);
    const redacted = rawSnapshot === undefined ? undefined : redactSnapshot(rawSnapshot);
    const snapshotLines =
      redacted === undefined || (action.kind === "snapshot" && action.snapshotMode === "full")
        ? redacted?.lines
        : compactSnapshotLines(redacted.lines);
    const lines =
      snapshotLines === undefined ? undefined : splitOversizedLines(snapshotLines, Math.max(4, limits.bytes));
    const snapshot = lines === undefined ? undefined : boundedSnapshot(lines, 0, limits);
    const snapshotLinks = lines === undefined ? {} : snapshotLinkTargets(lines);
    const snapshotContinuation =
      snapshot?.nextIndex === undefined
        ? undefined
        : this.storeContinuation(sessionName, lines!, snapshot.nextIndex, limits, snapshotLinks);
    return {
      value,
      snapshot: snapshot?.content,
      snapshotRedactions: redacted?.redactions,
      snapshotTruncated: snapshot?.truncated,
      snapshotOmittedLines: snapshot?.omittedLines,
      snapshotOmittedBytes: snapshot?.omittedBytes,
      findMatches: action.kind === "find" && rawSnapshot !== undefined ? findMatchCount(rawSnapshot) : undefined,
      baseUrl: action.kind === "base-url" && typeof value.result === "string" ? value.result : undefined,
      snapshotContinuation,
      snapshotLinks: linksForSnapshot(snapshot?.content, snapshotLinks),
      artifactPath,
      textContentType: textResult?.contentType,
      textContentTruncated: textResult?.truncated,
    };
  }

  private continueSnapshot(sessionName: string, cursor: string): CliResult {
    if (!CONTINUATION_CURSOR.test(cursor))
      throw new Error("Snapshot continuation cursor is stale; request one new snapshot and use only its cursor");
    const pending = this.continuations.get(cursor);
    if (!pending || pending.sessionName !== sessionName)
      throw new Error("Snapshot continuation cursor is stale; request one new snapshot and use only its cursor");
    this.deleteContinuation(cursor);
    const snapshot = boundedSnapshot(pending.lines, pending.nextIndex, pending.limits);
    const snapshotContinuation =
      snapshot.nextIndex === undefined
        ? undefined
        : this.storeContinuation(sessionName, pending.lines, snapshot.nextIndex, pending.limits, pending.links);
    return {
      value: {},
      snapshot: snapshot.content,
      snapshotTruncated: snapshot.truncated,
      snapshotOmittedLines: snapshot.omittedLines,
      snapshotOmittedBytes: snapshot.omittedBytes,
      snapshotContinuation,
      snapshotLinks: linksForSnapshot(snapshot.content, pending.links),
    };
  }

  private deleteContinuation(cursor: string): void {
    const pending = this.continuations.get(cursor);
    if (!pending) return;
    this.continuations.delete(cursor);
    this.continuationBytes -= pending.bytes;
  }

  private clearContinuations(sessionName?: string): void {
    for (const [cursor, pending] of this.continuations) {
      if (sessionName === undefined || pending.sessionName === sessionName) this.deleteContinuation(cursor);
    }
  }

  private storeContinuation(
    sessionName: string,
    lines: string[],
    nextIndex: number,
    limits: { lines: number; bytes: number },
    links: Record<string, string>,
  ): string | undefined {
    const bytes =
      lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0) +
      Object.entries(links).reduce((total, [ref, url]) => total + Buffer.byteLength(ref) + Buffer.byteLength(url), 0);
    if (bytes > MAX_CONTINUATION_BYTES) return undefined;
    const sessionEntries = () =>
      [...this.continuations.values()].filter(item => item.sessionName === sessionName).length;
    while (sessionEntries() >= MAX_CONTINUATIONS_PER_SESSION) {
      const oldest = [...this.continuations].find(([, item]) => item.sessionName === sessionName);
      if (!oldest) break;
      this.deleteContinuation(oldest[0]);
    }
    while (this.continuations.size >= MAX_CONTINUATIONS || this.continuationBytes + bytes > MAX_CONTINUATION_BYTES) {
      const oldest = this.continuations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deleteContinuation(oldest);
    }
    const token = `hc_${randomBytes(16).toString("hex")}`;
    this.continuations.set(token, { sessionName, lines, nextIndex, limits, links, bytes });
    this.continuationBytes += bytes;
    return token;
  }

  private usesPersistentClient(action: BrowserAction): boolean {
    return !["open", "attach-cdp", "attach-extension", "close", "detach", "list"].includes(action.kind);
  }

  private async persistentClient(): Promise<PersistentClient | undefined> {
    if (!this.options.persistentClient || this.clientUnavailable) return undefined;
    if (!this.client) {
      const factory = this.options.clientFactory ?? PlaywrightClient.create;
      const pending = factory(this.directory).catch(() => {
        if (this.client === pending) this.client = undefined;
        this.clientUnavailable = true;
        return undefined;
      });
      this.client = pending;
    }
    return this.client;
  }

  private async execute(
    action: BrowserAction,
    sessionName: string,
    command: string,
    args: string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (this.usesPersistentClient(action)) {
      const client = await this.persistentClient();
      if (client) {
        try {
          return await client.run(sessionName, command, args, signal, timeout);
        } catch (error) {
          this.client = undefined;
          await client.dispose().catch(() => {});
          if (error instanceof PlaywrightClientError) {
            if (!error.dispatched) {
              if (error.reason === "cancelled") throw new HeliosCliError("cancelled", "Browser action cancelled");
              if (error.reason === "timeout")
                throw new HeliosCliError("timeout", "Playwright persistent client command timed out");
              return this.executeThin(sessionName, command, args, timeout, signal);
            }
            this.continuations.delete(sessionName);
            if (error.reason === "cancelled")
              throw new HeliosCliError(
                "cancelled",
                "Browser action cancelled after dispatch; outcome is uncertain, request a fresh snapshot",
                true,
              );
            if (error.reason === "timeout")
              throw new HeliosCliError(
                "timeout",
                "Playwright command timed out after dispatch; outcome is uncertain, request a fresh snapshot",
                true,
              );
          }
          this.continuations.delete(sessionName);
          throw new HeliosCliError(
            "unavailable",
            "Playwright persistent client failed after dispatch; browser action outcome is uncertain, request a fresh snapshot",
            true,
          );
        }
      }
    }
    return this.executeThin(sessionName, command, args, timeout, signal);
  }

  private async executeThin(
    sessionName: string,
    command: string,
    args: string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const invocation = [CLI_PATH, "--json", `-s=${sessionName}`, command, ...args];
    try {
      return await this.exec(process.execPath, invocation, { signal, timeout, cwd: this.directory });
    } catch (error) {
      if (signal?.aborted) throw new HeliosCliError("cancelled", "Browser action cancelled");
      throw new HeliosCliError(
        "unavailable",
        error instanceof Error ? error.message.slice(0, 300) : "Could not start Playwright CLI",
      );
    }
  }

  private ensureConfig(): Promise<void> {
    return (
      this.configReady ??
      this.writeConfig({ outputDir: join(this.directory, "artifacts"), outputMode: "stdout", codegen: "none" })
    );
  }

  private writeConfig(config: Record<string, unknown>): Promise<void> {
    const writing = writeFile(this.configPath, JSON.stringify(config), { mode: 0o600 });
    this.configReady = writing.catch(error => {
      this.configReady = undefined;
      throw error;
    });
    return this.configReady;
  }

  private arguments(action: BrowserAction): {
    command: string;
    args: string[];
    artifactPath?: string;
    timeout: number;
  } {
    const normal = 20_000;
    switch (action.kind) {
      case "open":
        return {
          command: "open",
          args: [
            ...(action.url ? [validateNavigationUrl(action.url)] : []),
            ...(action.headed ? ["--headed"] : []),
            `--config=${this.configPath}`,
          ],
          timeout: 75_000,
        };
      case "attach-cdp":
        return {
          command: "attach",
          args: [`--cdp=${action.endpoint}`, `--config=${this.configPath}`],
          timeout: 45_000,
        };
      case "attach-extension":
        return {
          command: "attach",
          args: [`--extension=${action.browser}`, `--config=${this.configPath}`],
          timeout: 45_000,
        };
      case "navigate":
        return { command: "goto", args: [validateNavigationUrl(action.url)], timeout: 75_000 };
      case "link-url":
        return {
          command: "eval",
          args: ["el => el instanceof HTMLAnchorElement ? el.href : ''", target(action.target)],
          timeout: normal,
        };
      case "base-url":
        return { command: "eval", args: ["() => document.baseURI"], timeout: normal };
      case "page-text":
        return { command: "eval", args: [PAGE_TEXT_EXPRESSION], timeout: normal };
      case "snapshot": {
        if (action.depth !== undefined && (!Number.isInteger(action.depth) || action.depth < 1 || action.depth > 20))
          throw new Error("Snapshot depth must be an integer from 1 to 20");
        return {
          command: "snapshot",
          args: [
            ...(action.target ? [target(action.target)] : []),
            ...(action.depth ? [`--depth=${action.depth}`] : []),
            "--filename=<auto>",
          ],
          timeout: normal,
        };
      }
      case "continue":
        throw new Error("Browser continuation must not invoke Playwright CLI");
      case "find": {
        if (Boolean(action.text) === Boolean(action.regex))
          throw new Error("Browser find requires exactly one of text or regex");
        const query = action.text ?? action.regex!;
        if (query.length > 500) throw new Error("Browser find query exceeds 500 characters");
        return { command: "find", args: action.regex ? ["--regex", query] : [query], timeout: normal };
      }
      case "screenshot": {
        const artifactPath = join(this.directory, "artifacts", `screenshot-${Date.now()}-${crypto.randomUUID()}.png`);
        return {
          command: "screenshot",
          args: [
            ...(action.target ? [target(action.target)] : []),
            `--filename=${artifactPath}`,
            ...(action.fullPage ? ["--full-page"] : []),
          ],
          artifactPath,
          timeout: 45_000,
        };
      }
      case "click":
      case "hover":
      case "check":
      case "uncheck":
        return { command: action.kind, args: [target(action.target)], timeout: normal };
      case "fill":
        if (action.text.length > 10_000) throw new Error("Fill text exceeds 10000 character limit");
        return { command: "fill", args: [target(action.target), action.text], timeout: normal };
      case "press":
        if (!action.key || action.key.length > 64 || !/^[\w +\-]+$/u.test(action.key))
          throw new Error("Unsupported browser key");
        return { command: "press", args: [canonicalBrowserKey(action.key)], timeout: normal };
      case "select":
        if (!action.value || action.value.length > 1000)
          throw new Error("Select value must contain 1 to 1000 characters");
        return { command: "select", args: [target(action.target), action.value], timeout: normal };
      case "mouse-move":
        if (![action.x, action.y].every(value => Number.isInteger(value) && value >= 0 && value <= 4096))
          throw new Error("Mouse coordinates must be integers from 0 to 4096");
        return { command: "mousemove", args: [String(action.x), String(action.y)], timeout: normal };
      case "mouse-down":
      case "mouse-up":
        if (!["left", "middle", "right"].includes(action.button)) throw new Error("Unsupported mouse button");
        return {
          command: action.kind === "mouse-down" ? "mousedown" : "mouseup",
          args: [action.button],
          timeout: normal,
        };
      case "mouse-wheel":
        if (![action.deltaX, action.deltaY].every(value => Number.isInteger(value) && Math.abs(value) <= 5000))
          throw new Error("Mouse wheel deltas must be integers from -5000 to 5000");
        return { command: "mousewheel", args: [String(action.deltaX), String(action.deltaY)], timeout: normal };
      case "key-down":
      case "key-up":
        if (!action.key || action.key.length > 64 || /[\r\n\0]/u.test(action.key))
          throw new Error("Unsupported browser key");
        return {
          command: action.kind === "key-down" ? "keydown" : "keyup",
          args: [canonicalBrowserKey(action.key)],
          timeout: normal,
        };
      case "resize":
        if (
          !Number.isInteger(action.width) ||
          action.width < 320 ||
          action.width > 1920 ||
          !Number.isInteger(action.height) ||
          action.height < 240 ||
          action.height > 1080
        )
          throw new Error("Browser viewport must be 320-1920 by 240-1080 pixels");
        return { command: "resize", args: [String(action.width), String(action.height)], timeout: normal };
      case "back":
        return { command: "go-back", args: [], timeout: 75_000 };
      case "forward":
        return { command: "go-forward", args: [], timeout: 75_000 };
      case "reload":
        return { command: "reload", args: [], timeout: 75_000 };
      case "tab-list":
        return { command: "tab-list", args: [], timeout: normal };
      case "tab-new":
        return { command: "tab-new", args: action.url ? [validateNavigationUrl(action.url)] : [], timeout: 75_000 };
      case "tab-select":
      case "tab-close":
        if (!Number.isInteger(action.index) || action.index < 0 || action.index > 100)
          throw new Error("Tab index must be an integer from 0 to 100");
        return { command: action.kind, args: [String(action.index)], timeout: normal };
      case "detach":
      case "close":
      case "list":
        return { command: action.kind, args: [], timeout: normal };
    }
  }
}

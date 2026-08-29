import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { ExecutableProbe } from "pylon-core/executable";
import { truncateUtf8 } from "pylon-core/utf8";

export const SEARCH_TIMEOUT_MS = 30_000;

/** True when `absolute` is neither `root` itself nor a descendant of it. */
export function escapesRoot(root: string, absolute: string): boolean {
  const within = relative(root, absolute);
  return (
    within === ".." ||
    within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(within)
  );
}

/** Compare paths the way the host filesystem does; `realpath` resolves symlinks first. */
export function canonicalPath(path: string, { realpath = false } = {}): string {
  let value = resolve(path);
  if (realpath) {
    try {
      value = realpathSync.native(value);
    } catch {
      /* Missing path: compare the resolved form. */
    }
  }
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function workspacePath(cwd: string, input = "."): string {
  const clean = input.replace(/^@/, "") || ".";
  const root = resolve(cwd);
  const absolute = resolve(cwd, clean);
  if (escapesRoot(root, absolute))
    throw new Error("Search path must stay within workspace");
  return relative(root, absolute) || ".";
}

function fit(text: string, maxBytes: number): string {
  return truncateUtf8(text, maxBytes);
}

export function bounded(output: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const result = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes,
  });
  if (!result.truncated) return result.content;
  const notice = `\n\n[Output truncated; omitted output after ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Cap: ${formatSize(maxBytes)}.]`;
  return `${fit(result.content, maxBytes - Buffer.byteLength(notice, "utf8"))}${notice}`;
}

export function boundedError(error: unknown, maxBytes = 4 * 1024): string {
  return fit(String(error).trim(), maxBytes);
}

export type SearchExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

/** A search command either ran (`ok`/`empty`) or its executable is not installed (`missing`). */
export type SearchOutcome =
  | { status: "ok"; result: SearchExecResult }
  | { status: "empty"; result: SearchExecResult }
  | { status: "missing"; error: string };

export type SearchRunOptions = {
  probe: ExecutableProbe;
  signal?: AbortSignal;
  /** Name used in thrown errors; defaults to the command. */
  label?: string;
  /** Exit code meaning "ran fine, matched nothing"; null when the command has no such code. */
  noMatchCode?: number | null;
  /** Confirm the executable exists before trusting `noMatchCode`, so an absent binary falls back instead. */
  verifyNoMatch?: boolean;
};

/**
 * Run one search command and classify the result. Every failure is re-checked against the
 * probe so a missing executable becomes `missing` for the caller to degrade, not an error.
 */
export async function runSearch(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: SearchRunOptions,
): Promise<SearchOutcome> {
  const {
    probe,
    signal,
    label = command,
    noMatchCode = 1,
    verifyNoMatch = false,
  } = options;
  let result: SearchExecResult;
  try {
    result = await pi.exec(command, args, {
      signal,
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (error) {
    if (await probe(command, signal)) throw error;
    return { status: "missing", error: boundedError(error) };
  }
  if (result.code === 0) return { status: "ok", result };
  if (result.code === noMatchCode && !verifyNoMatch)
    return { status: "empty", result };
  if (!(await probe(command, signal)))
    return { status: "missing", error: boundedError(result.stderr) };
  if (result.code === noMatchCode) return { status: "empty", result };
  throw new Error(
    `${label} failed (${result.code}): ${boundedError(result.stderr)}`,
  );
}

/**
 * Serialize the largest prefix of `count` items that fits in `maxBytes`.
 * `build` renders a payload for a given item count; `fallbacks` are progressively
 * smaller shapes tried when even zero items are too large. The returned `count` is
 * how many items the payload actually carries.
 */
export function fitJson(
  build: (count: number) => unknown,
  count: number,
  maxBytes: number,
  fallbacks: readonly unknown[] = [],
): { text: string; count: number } {
  for (let returned = count; returned >= 0; returned--) {
    const text = JSON.stringify(build(returned));
    if (Buffer.byteLength(text, "utf8") <= maxBytes)
      return { text, count: returned };
  }
  for (const shape of fallbacks) {
    const text = JSON.stringify(shape);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, count: 0 };
  }
  return { text: "{}", count: 0 };
}

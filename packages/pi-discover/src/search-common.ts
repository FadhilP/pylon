import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export const SEARCH_TIMEOUT_MS = 30_000;

export function workspacePath(cwd: string, input = "."): string {
  const clean = input.replace(/^@/, "") || ".";
  const absolute = resolve(cwd, clean);
  const within = relative(resolve(cwd), absolute);
  if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within))
    throw new Error("Search path must stay within workspace");
  return within || ".";
}

function fit(text: string, maxBytes: number): string {
  let value = text;
  while (Buffer.byteLength(value, "utf8") > maxBytes) value = value.slice(0, -1);
  return value;
}

export function bounded(output: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  if (!result.truncated) return result.content;
  const notice = `\n\n[Output truncated; omitted output after ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Cap: ${formatSize(maxBytes)}.]`;
  return `${fit(result.content, maxBytes - Buffer.byteLength(notice, "utf8"))}${notice}`;
}

export function unavailable(error: unknown): boolean {
  return /ENOENT|not recognized|not found|cannot find/i.test(String(error));
}

export function boundedError(error: unknown, maxBytes = 4 * 1024): string {
  return fit(String(error).trim(), maxBytes);
}

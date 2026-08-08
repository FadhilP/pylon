import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { executableAvailable, type ExecutableProbe } from "pylon-core/executable";
import { Type } from "typebox";
import { bounded, boundedError, SEARCH_TIMEOUT_MS } from "./search-common.ts";

const MAX_MATCHES_PER_FILE = 20;
const MAX_MATCHING_FILES = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

type SearchParams = { pattern: string; glob?: string; mode?: "lines" | "files" };

function limitedGrepLines(output: string) {
  const selected = new Set<string>();
  const lines: string[] = [];
  let truncatedFiles = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const file = line.match(/^(.*):\d+:/)?.[1] ?? line;
    if (!selected.has(file)) {
      if (selected.size >= MAX_MATCHING_FILES) {
        truncatedFiles = true;
        continue;
      }
      selected.add(file);
    }
    lines.push(line);
  }
  const notice = truncatedFiles ? `\n[Search limited to first ${MAX_MATCHING_FILES} matching files.]` : "";
  return { text: `${lines.join("\n")}${notice}`, matchingFiles: selected.size, truncatedFiles };
}

async function grepFallback(
  pi: ExtensionAPI,
  params: SearchParams,
  path: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
  probe: ExecutableProbe,
) {
  const args = params.mode === "files"
    ? ["-r", "-l", "--binary-files=without-match"]
    : ["-r", "-n", "-H", "--binary-files=without-match", "-m", String(MAX_MATCHES_PER_FILE)];
  if (params.glob) args.push(`--include=${params.glob}`);
  args.push("--", params.pattern, path);
  const unavailable = () => ({
    content: [{ type: "text" as const, text: "ripgrep and grep unavailable; no search was run." }],
    details: { unavailable: true },
  });
  let result;
  try {
    // ponytail: grep is a degraded fallback; stream it if fallback memory becomes material.
    result = await pi.exec("grep", args, { signal, timeout: SEARCH_TIMEOUT_MS });
  } catch (error) {
    if (await probe("grep", signal)) throw error;
    return unavailable();
  }
  if (result.code === 1) {
    if (!await probe("grep", signal)) return unavailable();
    return { content: [{ type: "text" as const, text: "No matches found" }], details: { code: 1, command: "grep", fallback: true } };
  }
  if (result.code !== 0) {
    if (!await probe("grep", signal)) return unavailable();
    throw new Error(`grep failed (${result.code}): ${boundedError(result.stderr)}`);
  }
  if (params.mode === "files") {
    const files = result.stdout.split(/\r?\n/).filter(Boolean);
    const selected = files.slice(0, MAX_MATCHING_FILES);
    const notice = files.length > selected.length
      ? `\n[Search limited to first ${selected.length} of ${files.length} matching files.]`
      : "";
    return {
      content: [{ type: "text" as const, text: bounded(`${selected.join("\n")}${notice}`, maxBytes) || "No matches found" }],
      details: { code: 0, command: "grep", fallback: true, matchingFiles: files.length, truncatedFiles: files.length > selected.length },
    };
  }
  const limited = limitedGrepLines(result.stdout);
  return {
    content: [{ type: "text" as const, text: bounded(limited.text, maxBytes) || "No matches found" }],
    details: { code: 0, command: "grep", fallback: true, matchingFiles: limited.matchingFiles, truncatedFiles: limited.truncatedFiles },
  };
}

export function registerRg(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES, probe: ExecutableProbe = executableAvailable) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description: `Fast read-only content search with line numbers or matching file paths in any accessible directory. Falls back to system grep when ripgrep is unavailable. Line mode searches at most ${MAX_MATCHING_FILES} files with ${MAX_MATCHES_PER_FILE} matches each; files over ${formatSize(MAX_SEARCH_FILE_BYTES)} are skipped by ripgrep. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Fast read-only content search, including outside the workspace, with line-numbered matches or matching file paths",
    promptGuidelines: ["Prefer rg for content search, including outside the workspace. Narrow by path or glob; use mode files for broad discovery, then refine truncated output."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search" }),
      path: Type.Optional(Type.String({ description: "File or directory; relative paths resolve from the working directory, and outside-workspace paths are allowed; default ." })),
      glob: Type.Optional(Type.String({ description: "Optional file glob, such as *.ts" })),
      mode: Type.Optional(StringEnum(["lines", "files"] as const, { description: "Return line-numbered matches (default) or only matching file paths" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = resolve(ctx.cwd, params.path?.replace(/^@/, "") || ".");
      const base = ["--no-config", "--color=never", "--max-filesize", String(MAX_SEARCH_FILE_BYTES)];
      const withQuery = (args: string[], paths: string[]) => {
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", params.pattern, ...paths);
        return args;
      };
      const fallback = () => grepFallback(pi, params, path, signal, maxBytes, probe);
      const runRg = async (args: string[]) => {
        try {
          return await pi.exec("rg", args, { signal, timeout: SEARCH_TIMEOUT_MS });
        } catch (error) {
          if (await probe("rg", signal)) throw error;
          return undefined;
        }
      };
      if (params.mode === "files") {
        const result = await runRg(withQuery([...base, "--files-with-matches"], [path]));
        if (!result) return fallback();
        if (result.code === 1) return await probe("rg", signal)
          ? { content: [{ type: "text" as const, text: "No matches found" }], details: { code: 1 } }
          : fallback();
        if (result.code !== 0) {
          if (!await probe("rg", signal)) return fallback();
          throw new Error(`ripgrep failed (${result.code}): ${boundedError(result.stderr)}`);
        }
        return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) || "No matches found" }], details: { code: 0 } };
      }

      const args = withQuery([
        ...base, "--json", "--max-columns=500", "--max-columns-preview",
        "--max-count", String(MAX_MATCHES_PER_FILE), "--sort", "path",
      ], [path]);
      const result = await runRg(args);
      if (!result) return fallback();
      if (result.code === 1 && !await probe("rg", signal)) return fallback();
      if (result.code !== 0 && result.code !== 1) {
        if (!await probe("rg", signal)) return fallback();
        throw new Error(`ripgrep failed (${result.code}): ${boundedError(result.stderr)}`);
      }
      const matchingFiles = new Set<string>();
      const selectedFiles = new Set<string>();
      const lines: string[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type !== "match" || typeof event.data?.path?.text !== "string") continue;
        const file = event.data.path.text;
        matchingFiles.add(file);
        if (!selectedFiles.has(file) && selectedFiles.size < MAX_MATCHING_FILES) selectedFiles.add(file);
        if (!selectedFiles.has(file)) continue;
        const lineNumber = Number(event.data.line_number) || 0;
        const text = String(event.data.lines?.text ?? "").replace(/\r?\n$/, "");
        lines.push(`${file}:${lineNumber}:${text}`);
      }
      if (!matchingFiles.size && result.stdout.trim()) {
        return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) }], details: { code: result.code, matchingFiles: 0, searchedFiles: 0, truncatedFiles: false } };
      }
      const searchedFiles = selectedFiles.size;
      const truncatedFiles = matchingFiles.size > MAX_MATCHING_FILES;
      const fileNotice = truncatedFiles
        ? `\n[Search limited to first ${searchedFiles} of ${matchingFiles.size} matching files.]`
        : "";
      return {
        content: [{ type: "text" as const, text: bounded(`${lines.join("\n")}${fileNotice}`, maxBytes) || "No matches found" }],
        details: { code: result.code, matchingFiles: matchingFiles.size, searchedFiles, truncatedFiles },
      };
    },
  });
}

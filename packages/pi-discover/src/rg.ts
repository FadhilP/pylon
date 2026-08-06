import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { bounded, boundedError, SEARCH_TIMEOUT_MS, unavailable, workspacePath } from "./search-common.ts";

const MAX_MATCHES_PER_FILE = 20;
const MAX_MATCHING_FILES = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

export function registerRg(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description: `Fast read-only content search with line numbers or matching file paths. Line mode searches at most ${MAX_MATCHING_FILES} files with ${MAX_MATCHES_PER_FILE} matches each; files over ${formatSize(MAX_SEARCH_FILE_BYTES)} are skipped. Output capped at ${formatSize(maxBytes)}. Use grep if ripgrep is unavailable.`,
    promptSnippet: "Fast read-only repository content search with line-numbered matches or matching file paths",
    promptGuidelines: ["Prefer rg for repository content search; use grep when unavailable. Narrow by path or glob; use mode files for broad discovery, then refine truncated output."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search" }),
      path: Type.Optional(Type.String({ description: "Workspace-relative file or directory; default ." })),
      glob: Type.Optional(Type.String({ description: "Optional file glob, such as *.ts" })),
      mode: Type.Optional(StringEnum(["lines", "files"] as const, { description: "Return line-numbered matches (default) or only matching file paths" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = workspacePath(ctx.cwd, params.path);
      const base = ["--no-config", "--color=never", "--max-filesize", String(MAX_SEARCH_FILE_BYTES)];
      const withQuery = (args: string[], paths: string[]) => {
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", params.pattern, ...paths);
        return args;
      };
      try {
        if (params.mode === "files") {
          const result = await pi.exec("rg", withQuery([...base, "--files-with-matches"], [path]), { signal, timeout: SEARCH_TIMEOUT_MS });
          if (result.code === 1) return { content: [{ type: "text" as const, text: "No matches found" }], details: { code: 1 } };
          if (result.code !== 0) {
            if (unavailable(result.stderr)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
            throw new Error(`ripgrep failed (${result.code}): ${boundedError(result.stderr)}`);
          }
          return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) || "No matches found" }], details: { code: 0 } };
        }

        const args = withQuery([
          ...base, "--json", "--max-columns=500", "--max-columns-preview",
          "--max-count", String(MAX_MATCHES_PER_FILE), "--sort", "path",
        ], [path]);
        const result = await pi.exec("rg", args, { signal, timeout: SEARCH_TIMEOUT_MS });
        if (result.code !== 0 && result.code !== 1) {
          if (unavailable(result.stderr)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
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
      } catch (error) {
        if (unavailable(error)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
        throw error;
      }
    },
  });
}

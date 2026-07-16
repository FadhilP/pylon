import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;

export function workspacePath(cwd: string, input = "."): string {
  const clean = input.replace(/^@/, "") || ".";
  const absolute = resolve(cwd, clean);
  const within = relative(resolve(cwd), absolute);
  if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
    throw new Error("Search path must stay within workspace");
  }
  return within || ".";
}

function bounded(output: string): string {
  const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return result.truncated
    ? `${result.content}\n\n[Output truncated to ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}.]`
    : result.content;
}

function unavailable(error: unknown): boolean {
  return /ENOENT|not recognized|not found|cannot find/i.test(String(error));
}

export default function scoutSearchToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description: `Fast read-only content search with line numbers or matching file paths. Output capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Use grep if ripgrep is unavailable.`,
    promptSnippet: "Fast read-only repository content search with line-numbered matches or matching file paths",
    promptGuidelines: ["Prefer rg for repository content search; use grep when rg reports it is unavailable. Narrow searches with path or glob when reliable anchors exist. When locations are unknown and a normal search may be broad, use mode files to discover matching paths, then search selected files or directories for line-level evidence. If output is broad or truncated, refine the next search instead of repeating it."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search" }),
      path: Type.Optional(Type.String({ description: "Workspace-relative file or directory; default ." })),
      glob: Type.Optional(Type.String({ description: "Optional file glob, such as *.ts" })),
      mode: Type.Optional(StringEnum(["lines", "files"] as const, { description: "Return line-numbered matches (default) or only matching file paths" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = workspacePath(ctx.cwd, params.path);
      const args = params.mode === "files"
        ? ["--files-with-matches", "--color=never"]
        : ["--line-number", "--color=never", "--max-columns=500", "--max-columns-preview", "--max-count=200"];
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.pattern, path);
      try {
        const result = await pi.exec("rg", args, { signal, timeout: TIMEOUT_MS });
        if (result.code === 1) return { content: [{ type: "text" as const, text: "No matches found" }], details: { code: 1 } };
        if (result.code !== 0) {
          if (unavailable(result.stderr)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
          throw new Error(`ripgrep failed (${result.code}): ${result.stderr.trim()}`);
        }
        return { content: [{ type: "text" as const, text: bounded(result.stdout) || "No matches found" }], details: { code: 0 } };
      } catch (error) {
        if (unavailable(error)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Fast read-only file-name/path search. Output capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Use find if fd/fdfind is unavailable.`,
    promptSnippet: "Fast read-only repository file-name and path search",
    promptGuidelines: ["Prefer fd for repository file-name/path search; use find when fd reports it is unavailable."],
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "Regular expression; default lists all entries" })),
      path: Type.Optional(Type.String({ description: "Workspace-relative directory; default ." })),
      glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = workspacePath(ctx.cwd, params.path);
      const args = ["--color", "never", "--max-results", String(DEFAULT_MAX_LINES)];
      if (params.glob) args.push("--glob");
      args.push(params.pattern || ".", path);
      let lastError = "";
      for (const command of ["fd", "fdfind"]) {
        try {
          const result = await pi.exec(command, args, { signal, timeout: TIMEOUT_MS });
          if (result.code === 0) return { content: [{ type: "text" as const, text: bounded(result.stdout) || "No files found" }], details: { command } };
          lastError = result.stderr;
          if (!unavailable(result.stderr)) throw new Error(`${command} failed (${result.code}): ${result.stderr.trim()}`);
        } catch (error) {
          if (!unavailable(error)) throw error;
          lastError = String(error);
        }
      }
      return { content: [{ type: "text" as const, text: "fd/fdfind unavailable; use find instead." }], details: { unavailable: true, error: lastError } };
    },
  });
}

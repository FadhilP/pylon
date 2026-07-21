import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { bounded, boundedError, SEARCH_TIMEOUT_MS, unavailable, workspacePath } from "./search-common.ts";

const MAX_MATCHES = 200;

export function registerRg(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description: `Fast read-only content search with line numbers or matching file paths. Output capped at ${formatSize(maxBytes)}. Use grep if ripgrep is unavailable.`,
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
      const args = params.mode === "files"
        ? ["--files-with-matches", "--color=never"]
        : ["--line-number", "--color=never", "--max-columns=500", "--max-columns-preview", "--max-count", String(MAX_MATCHES)];
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.pattern, path);
      try {
        const result = await pi.exec("rg", args, { signal, timeout: SEARCH_TIMEOUT_MS });
        if (result.code === 1) return { content: [{ type: "text" as const, text: "No matches found" }], details: { code: 1 } };
        if (result.code !== 0) {
          if (unavailable(result.stderr)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
          throw new Error(`ripgrep failed (${result.code}): ${boundedError(result.stderr)}`);
        }
        return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) || "No matches found" }], details: { code: 0 } };
      } catch (error) {
        if (unavailable(error)) return { content: [{ type: "text" as const, text: "ripgrep unavailable; use grep instead." }], details: { unavailable: true } };
        throw error;
      }
    },
  });
}

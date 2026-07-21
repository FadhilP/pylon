import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bounded, boundedError, SEARCH_TIMEOUT_MS, unavailable, workspacePath } from "./search-common.ts";

export function registerFd(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Fast read-only file-name/path search. Output capped at ${formatSize(maxBytes)}. Use find if fd/fdfind is unavailable.`,
    promptSnippet: "Fast read-only repository file-name/path search",
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
          const result = await pi.exec(command, args, { signal, timeout: SEARCH_TIMEOUT_MS });
          if (result.code === 0) return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) || "No files found" }], details: { command } };
          lastError = boundedError(result.stderr);
          if (!unavailable(result.stderr)) throw new Error(`${command} failed (${result.code}): ${lastError}`);
        } catch (error) {
          if (!unavailable(error)) throw error;
          lastError = boundedError(error);
        }
      }
      return { content: [{ type: "text" as const, text: "fd/fdfind unavailable; use find instead." }], details: { unavailable: true, error: lastError } };
    },
  });
}

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { executableAvailable, type ExecutableProbe } from "pylon-core/executable";
import { bounded, boundedError, SEARCH_TIMEOUT_MS } from "./search-common.ts";

export function registerFd(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES, probe: ExecutableProbe = executableAvailable) {
  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Fast read-only file-name/path search in any accessible directory. Tries fd, then fdfind. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Fast read-only file-name/path search, including outside the workspace",
    promptGuidelines: ["Prefer fd for file-name/path search, including outside the workspace; use bash when fd reports that neither backend is available."],
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "Regular expression; default lists all entries" })),
      path: Type.Optional(Type.String({ description: "Directory path; relative paths resolve from the working directory, and outside-workspace paths are allowed; default ." })),
      glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = resolve(ctx.cwd, params.path?.replace(/^@/, "") || ".");
      const args = ["--color", "never", "--max-results", String(DEFAULT_MAX_LINES)];
      if (params.glob) args.push("--glob");
      args.push("--", params.pattern || ".", path);
      let lastError = "";
      for (const command of ["fd", "fdfind"]) {
        let result;
        try {
          result = await pi.exec(command, args, { signal, timeout: SEARCH_TIMEOUT_MS });
        } catch (error) {
          if (await probe(command, signal)) throw error;
          lastError = boundedError(error);
          continue;
        }
        if (result.code === 0) return { content: [{ type: "text" as const, text: bounded(result.stdout, maxBytes) || "No files found" }], details: { command } };
        lastError = boundedError(result.stderr);
        if (await probe(command, signal)) throw new Error(`${command} failed (${result.code}): ${lastError}`);
      }
      return { content: [{ type: "text" as const, text: "fd/fdfind unavailable; use bash instead." }], details: { unavailable: true, error: lastError } };
    },
  });
}

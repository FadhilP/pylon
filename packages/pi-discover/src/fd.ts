import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { basename, matchesGlob, relative, resolve } from "node:path";
import { Type } from "typebox";
import { executableAvailable, type ExecutableProbe } from "pylon-core/executable";
import { bounded, boundedError, SEARCH_TIMEOUT_MS } from "./search-common.ts";

export function registerFd(
  pi: ExtensionAPI,
  maxBytes = DEFAULT_MAX_BYTES,
  probe: ExecutableProbe = executableAvailable,
  platform: NodeJS.Platform = process.platform,
) {
  pi.registerTool({
    name: "fd",
    label: "fd",
    description: `Fast read-only file-name/path search in any accessible directory. Tries fd, then fdfind, then falls back to system find on POSIX. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Fast read-only file-name/path search, including outside the workspace",
    promptGuidelines: ["Prefer fd for file-name/path search, including outside the workspace."],
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
      const unavailable = () => ({
        content: [{ type: "text" as const, text: platform === "win32"
          ? "fd/fdfind unavailable; system find fallback is unsupported on Windows."
          : "fd, fdfind, and find unavailable; no search was run." }],
        details: { unavailable: true, error: lastError },
      });
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
      if (platform === "win32") return unavailable();

      const pattern = params.pattern || ".";
      const regex = params.glob ? undefined : new RegExp(pattern);
      const matches = (entry: string) => {
        const candidate = relative(path, entry).replaceAll("\\", "/");
        if (!candidate) return false;
        return params.glob
          ? matchesGlob(candidate, pattern) || matchesGlob(basename(candidate), pattern)
          : regex!.test(candidate);
      };
      let result;
      try {
        // ponytail: find is a degraded fallback; stream it if fallback memory becomes material.
        result = await pi.exec("find", [path], { signal, timeout: SEARCH_TIMEOUT_MS });
      } catch (error) {
        if (await probe("find", signal)) throw error;
        lastError = boundedError(error);
        return unavailable();
      }
      if (result.code !== 0) {
        lastError = boundedError(result.stderr);
        throw new Error(`find failed (${result.code}): ${lastError}`);
      }
      const output = result.stdout.split(/\r?\n/).filter(Boolean).filter(matches).join("\n");
      return {
        content: [{ type: "text" as const, text: bounded(output, maxBytes) || "No files found" }],
        details: { command: "find", fallback: true },
      };
    },
  });
}

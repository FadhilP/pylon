import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import {
  executableAvailable,
  type ExecutableProbe,
} from "pylon-core/executable";
import { Type } from "typebox";
import { bounded, runSearch, type SearchRunOptions } from "./search-common.ts";

const MAX_MATCHES_PER_FILE = 20;
const MAX_MATCHING_FILES = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

type SearchParams = {
  pattern: string;
  glob?: string;
  mode?: "lines" | "files";
};

const UNAVAILABLE = {
  content: [
    {
      type: "text" as const,
      text: "ripgrep and grep unavailable; no search was run.",
    },
  ],
  details: { unavailable: true },
};

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
  const notice = truncatedFiles
    ? `\n[Search limited to first ${MAX_MATCHING_FILES} matching files.]`
    : "";
  return {
    text: `${lines.join("\n")}${notice}`,
    matchingFiles: selected.size,
    truncatedFiles,
  };
}

async function grepFallback(
  pi: ExtensionAPI,
  params: SearchParams,
  path: string,
  run: SearchRunOptions,
  maxBytes: number,
) {
  const args =
    params.mode === "files"
      ? ["-r", "-l", "--binary-files=without-match"]
      : [
          "-r",
          "-n",
          "-H",
          "--binary-files=without-match",
          "-m",
          String(MAX_MATCHES_PER_FILE),
        ];
  if (params.glob) args.push(`--include=${params.glob}`);
  args.push("--", params.pattern, path);
  // ponytail: grep is a degraded fallback; stream it if fallback memory becomes material.
  const outcome = await runSearch(pi, "grep", args, run);
  if (outcome.status === "missing") return UNAVAILABLE;
  if (outcome.status === "empty")
    return {
      content: [{ type: "text" as const, text: "No matches found" }],
      details: { code: 1, command: "grep", fallback: true },
    };
  if (params.mode === "files") {
    const files = outcome.result.stdout.split(/\r?\n/).filter(Boolean);
    const selected = files.slice(0, MAX_MATCHING_FILES);
    const notice =
      files.length > selected.length
        ? `\n[Search limited to first ${selected.length} of ${files.length} matching files.]`
        : "";
    return {
      content: [
        {
          type: "text" as const,
          text:
            bounded(`${selected.join("\n")}${notice}`, maxBytes) ||
            "No matches found",
        },
      ],
      details: {
        code: 0,
        command: "grep",
        fallback: true,
        matchingFiles: files.length,
        truncatedFiles: files.length > selected.length,
      },
    };
  }
  const limited = limitedGrepLines(outcome.result.stdout);
  return {
    content: [
      {
        type: "text" as const,
        text: bounded(limited.text, maxBytes) || "No matches found",
      },
    ],
    details: {
      code: 0,
      command: "grep",
      fallback: true,
      matchingFiles: limited.matchingFiles,
      truncatedFiles: limited.truncatedFiles,
    },
  };
}

/** Turn ripgrep's `--json` event stream into `path:line:text` lines, capped at MAX_MATCHING_FILES files. */
function parseRgLines(output: string) {
  const matchingFiles = new Set<string>();
  const selectedFiles = new Set<string>();
  const lines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "match" || typeof event.data?.path?.text !== "string")
      continue;
    const file = event.data.path.text;
    matchingFiles.add(file);
    if (!selectedFiles.has(file) && selectedFiles.size < MAX_MATCHING_FILES)
      selectedFiles.add(file);
    if (!selectedFiles.has(file)) continue;
    const lineNumber = Number(event.data.line_number) || 0;
    const text = String(event.data.lines?.text ?? "").replace(/\r?\n$/, "");
    lines.push(`${file}:${lineNumber}:${text}`);
  }
  return {
    lines,
    matchingFiles: matchingFiles.size,
    searchedFiles: selectedFiles.size,
  };
}

export function registerRg(
  pi: ExtensionAPI,
  maxBytes = DEFAULT_MAX_BYTES,
  probe: ExecutableProbe = executableAvailable,
) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description: `Fast read-only content search with line numbers or matching file paths in any accessible directory. Falls back to system grep when ripgrep is unavailable. Line mode searches at most ${MAX_MATCHING_FILES} files with ${MAX_MATCHES_PER_FILE} matches each; files over ${formatSize(MAX_SEARCH_FILE_BYTES)} are skipped by ripgrep. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet:
      "Fast read-only content search, including outside the workspace, with line-numbered matches or matching file paths",
    promptGuidelines: [
      "Prefer rg for content search, including outside the workspace. Narrow by path or glob; use mode files for broad discovery, then refine truncated output.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search" }),
      path: Type.Optional(
        Type.String({
          description:
            "File or directory; relative paths resolve from the working directory, and outside-workspace paths are allowed; default .",
        }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Optional file glob, such as *.ts" }),
      ),
      mode: Type.Optional(
        StringEnum(["lines", "files"] as const, {
          description:
            "Return line-numbered matches (default) or only matching file paths",
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = resolve(ctx.cwd, params.path?.replace(/^@/, "") || ".");
      const withQuery = (args: string[]) => {
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", params.pattern, path);
        return args;
      };
      const base = [
        "--no-config",
        "--color=never",
        "--max-filesize",
        String(MAX_SEARCH_FILE_BYTES),
      ];
      // ripgrep exits 1 with no output when absent from PATH too, so no-match needs confirming.
      const run: SearchRunOptions = {
        probe,
        signal,
        label: "ripgrep",
        verifyNoMatch: true,
      };
      const fallback = () =>
        grepFallback(
          pi,
          params,
          path,
          { probe, signal, verifyNoMatch: true },
          maxBytes,
        );

      if (params.mode === "files") {
        const outcome = await runSearch(
          pi,
          "rg",
          withQuery([...base, "--files-with-matches"]),
          run,
        );
        if (outcome.status === "missing") return fallback();
        if (outcome.status === "empty")
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: { code: 1 },
          };
        return {
          content: [
            {
              type: "text" as const,
              text:
                bounded(outcome.result.stdout, maxBytes) || "No matches found",
            },
          ],
          details: { code: 0 },
        };
      }

      const outcome = await runSearch(
        pi,
        "rg",
        withQuery([
          ...base,
          "--json",
          "--max-columns=500",
          "--max-columns-preview",
          "--max-count",
          String(MAX_MATCHES_PER_FILE),
          "--sort",
          "path",
        ]),
        run,
      );
      if (outcome.status === "missing") return fallback();
      const { result } = outcome;
      const { lines, matchingFiles, searchedFiles } = parseRgLines(
        result.stdout,
      );
      if (!matchingFiles && result.stdout.trim()) {
        return {
          content: [
            { type: "text" as const, text: bounded(result.stdout, maxBytes) },
          ],
          details: {
            code: result.code,
            matchingFiles: 0,
            searchedFiles: 0,
            truncatedFiles: false,
          },
        };
      }
      const truncatedFiles = matchingFiles > MAX_MATCHING_FILES;
      const fileNotice = truncatedFiles
        ? `\n[Search limited to first ${searchedFiles} of ${matchingFiles} matching files.]`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              bounded(`${lines.join("\n")}${fileNotice}`, maxBytes) ||
              "No matches found",
          },
        ],
        details: {
          code: result.code,
          matchingFiles,
          searchedFiles,
          truncatedFiles,
        },
      };
    },
  });
}

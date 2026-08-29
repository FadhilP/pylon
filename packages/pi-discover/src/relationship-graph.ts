import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executableAvailable, type ExecutableProbe } from "pylon-core/executable";
import { Type } from "typebox";
import { fitJson, runSearch, workspacePath, type SearchRunOptions } from "./search-common.ts";

const MAX_GRAPH_RESULTS = 100;
const DEFAULT_GRAPH_RESULTS = 40;
const MAX_GRAPH_SOURCE_CHARS = 240;
const MAX_MATCHES_PER_FILE = 5;
const MAX_MATCHING_FILES = 100;
const MAX_PARSED_EVENTS = 1_000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

type RelationshipRole = "possible_definition" | "possible_import" | "possible_export" | "possible_call" | "reference";
type RelationshipMatch = { path: string; line: number; text: string; roles: RelationshipRole[] };
type RelationshipFile = { path: string; locations: Array<Omit<RelationshipMatch, "path">> };

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function relationshipRoles(query: string, source: string): RelationshipRole[] {
  const symbol = regexpEscape(query);
  const roles: RelationshipRole[] = [];
  if (
    new RegExp(
      `\\b(?:function|class|interface|type|enum|namespace|const|let|var|def|fn)\\s+${symbol}(?:\\b|\\s*[:=(<])`,
    ).test(source) ||
    new RegExp(`\\bfunc(?:\\s*\\([^)]*\\))?\\s+${symbol}\\s*\\(`).test(source) ||
    new RegExp(
      `^\\s*(?:(?:public|private|protected|static|abstract|async|override)\\s+)*(?:[A-Za-z_$][\\w$<>,.?\\[\\]]*\\s+)?${symbol}\\s*\\([^;{}]*\\)\\s*(?::[^;{=]+)?\\s*(?:\\{|=>)`,
    ).test(source)
  )
    roles.push("possible_definition");
  if (/\b(?:import|from|require|use|using|include)\b/.test(source)) roles.push("possible_import");
  if (/\bexport\b/.test(source)) roles.push("possible_export");
  if (!roles.includes("possible_definition") && new RegExp(`${symbol}\\s*(?:\\?\\.)?\\(`).test(source))
    roles.push("possible_call");
  return roles.length ? roles : ["reference"];
}

function parseRelationshipMatches(
  output: string,
  query: string,
  perFileLimit: number,
): { matches: RelationshipMatch[]; observed: number; malformed: number; searchMayBeTruncated: boolean } {
  const matches: RelationshipMatch[] = [];
  const seen = new Set<string>();
  const pathCounts = new Map<string, number>();
  let observed = 0;
  let malformed = 0;
  let parsedEvents = 0;
  let parserTruncated = false;
  for (const raw of output.split(/\r?\n/)) {
    if (!raw) continue;
    if (++parsedEvents > MAX_PARSED_EVENTS) {
      parserTruncated = true;
      break;
    }
    try {
      const event = JSON.parse(raw);
      if (event.type !== "match") continue;
      const path = event.data?.path?.text;
      const line = event.data?.line_number;
      const source = event.data?.lines?.text;
      if (typeof path !== "string" || typeof line !== "number" || typeof source !== "string") {
        malformed++;
        continue;
      }
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
      const key = `${path}\0${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observed++;
      const text = source.replace(/[\r\n]+$/, "").slice(0, MAX_GRAPH_SOURCE_CHARS);
      matches.push({ path, line, text, roles: relationshipRoles(query, text) });
    } catch {
      malformed++;
    }
  }
  return {
    matches,
    observed,
    malformed,
    searchMayBeTruncated: parserTruncated || [...pathCounts.values()].some(count => count >= perFileLimit),
  };
}

function groupMatches(matches: RelationshipMatch[]): RelationshipFile[] {
  const files = new Map<string, RelationshipFile>();
  for (const { path, ...location } of matches) {
    let file = files.get(path);
    if (!file) {
      file = { path, locations: [] };
      files.set(path, file);
    }
    file.locations.push(location);
  }
  return [...files.values()];
}

/** Everything the rendered map needs, so the size-fitting loop stays a single argument wide. */
type RelationshipReport = {
  query: string;
  scope: string;
  matches: RelationshipMatch[];
  requested: number;
  observed: number;
  malformed: number;
  searchMayBeTruncated: boolean;
  matchingFileCount: number;
  searchedFileCount: number;
};

function relationshipValue(report: RelationshipReport, returned: number) {
  const selected = report.matches.slice(0, returned);
  return {
    query: report.query,
    scope: report.scope,
    heuristic: true,
    files: groupMatches(selected),
    metadata: {
      observedMatchCount: report.observed,
      returnedCount: selected.length,
      truncated: selected.length < report.observed || report.searchMayBeTruncated,
      searchMayBeTruncated: report.searchMayBeTruncated,
      malformedEvents: report.malformed,
      matchingFileCount: report.matchingFileCount,
      searchedFileCount: report.searchedFileCount,
      perFileMatchLimit: Math.min(report.requested, MAX_MATCHES_PER_FILE),
      sourceFileSizeCapBytes: MAX_SEARCH_FILE_BYTES,
    },
  };
}

function relationshipMap(report: RelationshipReport, maxBytes: number) {
  const fitted = fitJson(
    returned => relationshipValue(report, returned),
    Math.min(report.requested, report.matches.length),
    maxBytes,
    [{ files: [], metadata: { returnedCount: 0, truncated: true } }, { files: [] }],
  );
  return { value: relationshipValue(report, fitted.count), text: fitted.text };
}

export function registerRelationshipGraph(
  pi: ExtensionAPI,
  maxBytes = DEFAULT_MAX_BYTES,
  probe: ExecutableProbe = executableAvailable,
) {
  pi.registerTool({
    name: "relationship_graph",
    label: "Relationship map",
    description:
      "Build a bounded grouped heuristic map of files and source locations mentioning a function, type, variable, command, or token. Roles are candidates, not semantic resolution; confirm important relationships from source before relying on them.",
    promptSnippet: "Map a query token to grouped file and source-location relationships",
    promptGuidelines: [
      "Use relationship_graph to orient around a known symbol or token. Treat roles as heuristics; confirm important relationships from source.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "Exact symbol or token to map",
        }),
        path: Type.Optional(
          Type.String({ maxLength: 500, description: "Workspace-relative file or directory; default ." }),
        ),
        glob: Type.Optional(Type.String({ maxLength: 200, description: "Optional file glob, such as *.ts" })),
        max_results: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_GRAPH_RESULTS,
            description: `Maximum locations; default ${DEFAULT_GRAPH_RESULTS}`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const query = params.query.trim();
      if (!query) throw new Error("Relationship query must contain a non-whitespace token");
      const path = workspacePath(ctx.cwd, params.path);
      const maxResults = params.max_results ?? DEFAULT_GRAPH_RESULTS;
      const perFileLimit = Math.min(maxResults, MAX_MATCHES_PER_FILE);
      const common = [
        "--no-config",
        "--fixed-strings",
        "--color=never",
        "--sort",
        "path",
        "--max-filesize",
        String(MAX_SEARCH_FILE_BYTES),
      ];
      const addQuery = (args: string[], paths: string[]) => {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(query)) args.push("--word-regexp");
        if (params.glob) args.push("--glob", params.glob);
        args.push("--", query, ...paths);
        return args;
      };
      const unavailableResult = () => ({
        content: [{ type: "text" as const, text: "ripgrep unavailable; relationship map was not built." }],
        details: { unavailable: true },
      });
      // rg reporting no matches is trusted here; probing on every empty map is not worth the spawn.
      const run: SearchRunOptions = { probe, signal, label: "ripgrep" };

      const fileOutcome = await runSearch(
        pi,
        "rg",
        addQuery([...common, "--files-with-matches", "--null"], [path]),
        run,
      );
      if (fileOutcome.status === "missing") return unavailableResult();
      const matchingFiles = fileOutcome.status === "empty" ? [] : fileOutcome.result.stdout.split("\0").filter(Boolean);
      const files = matchingFiles.slice(0, MAX_MATCHING_FILES);
      let parsed = { matches: [] as RelationshipMatch[], observed: 0, malformed: 0, searchMayBeTruncated: false };
      if (files.length) {
        const outcome = await runSearch(
          pi,
          "rg",
          addQuery(
            [
              ...common,
              "--json",
              "--line-number",
              "--max-columns=500",
              "--max-columns-preview",
              "--max-count",
              String(perFileLimit),
            ],
            files,
          ),
          run,
        );
        if (outcome.status === "missing") return unavailableResult();
        if (outcome.status === "ok") parsed = parseRelationshipMatches(outcome.result.stdout, query, perFileLimit);
      }
      parsed.searchMayBeTruncated ||= matchingFiles.length > files.length;
      const { value, text } = relationshipMap(
        {
          query,
          scope: path,
          matches: parsed.matches,
          requested: maxResults,
          observed: parsed.observed,
          malformed: parsed.malformed,
          searchMayBeTruncated: parsed.searchMayBeTruncated,
          matchingFileCount: matchingFiles.length,
          searchedFileCount: files.length,
        },
        maxBytes,
      );
      return { content: [{ type: "text" as const, text }], details: value.metadata };
    },
  });
}

import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedError, SEARCH_TIMEOUT_MS, unavailable, workspacePath } from "./search-common.ts";

const MAX_GRAPH_RESULTS = 100;
const DEFAULT_GRAPH_RESULTS = 40;
const MAX_GRAPH_SOURCE_CHARS = 300;

type RelationshipRole = "possible_definition" | "possible_import" | "possible_export" | "possible_call" | "reference";
type RelationshipMatch = { path: string; line: number; text: string; roles: RelationshipRole[] };

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function relationshipRoles(query: string, source: string): RelationshipRole[] {
  const symbol = regexpEscape(query);
  const roles: RelationshipRole[] = [];
  if (new RegExp(`\\b(?:function|class|interface|type|enum|namespace|const|let|var|def|fn)\\s+${symbol}(?:\\b|\\s*[:=(<])`).test(source)
    || new RegExp(`\\bfunc(?:\\s*\\([^)]*\\))?\\s+${symbol}\\s*\\(`).test(source)) roles.push("possible_definition");
  if (/\b(?:import|from|require|use|using|include)\b/.test(source)) roles.push("possible_import");
  if (/\bexport\b/.test(source)) roles.push("possible_export");
  if (!roles.includes("possible_definition") && new RegExp(`${symbol}\\s*(?:\\?\\.)?\\(`).test(source)) roles.push("possible_call");
  return roles.length ? roles : ["reference"];
}

function parseRelationshipMatches(output: string, query: string, perFileLimit: number): { matches: RelationshipMatch[]; malformed: number; searchMayBeTruncated: boolean } {
  const matches: RelationshipMatch[] = [];
  const seen = new Set<string>();
  const pathCounts = new Map<string, number>();
  let malformed = 0;
  for (const raw of output.split(/\r?\n/)) {
    if (!raw) continue;
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
      const text = source.replace(/[\r\n]+$/, "").slice(0, MAX_GRAPH_SOURCE_CHARS);
      matches.push({ path, line, text, roles: relationshipRoles(query, text) });
    } catch {
      malformed++;
    }
  }
  return { matches, malformed, searchMayBeTruncated: [...pathCounts.values()].some((count) => count >= perFileLimit) };
}

function relationshipGraph(query: string, scope: string, matches: RelationshipMatch[], requested: number, malformed: number, searchMayBeTruncated: boolean, maxBytes: number) {
  let returned = Math.min(requested, matches.length);
  while (true) {
    const selected = matches.slice(0, returned);
    const files = [...new Set(selected.map((match) => match.path))];
    const graph = {
      query,
      scope,
      heuristic: true,
      nodes: [
        { id: `query:${query}`, kind: "query", label: query },
        ...files.map((path) => ({ id: `file:${path}`, kind: "file", label: path })),
        ...selected.map((match) => ({
          id: `location:${match.path}:${match.line}`,
          kind: "location",
          path: match.path,
          line: match.line,
          text: match.text,
          roles: match.roles,
        })),
      ],
      edges: selected.flatMap((match) => [
        { from: `file:${match.path}`, to: `location:${match.path}:${match.line}`, type: "contains" },
        { from: `location:${match.path}:${match.line}`, to: `query:${query}`, type: "mentions" },
      ]),
      metadata: {
        observedMatchCount: matches.length,
        returnedCount: selected.length,
        truncated: selected.length < matches.length || searchMayBeTruncated,
        searchMayBeTruncated,
        malformedEvents: malformed,
      },
    };
    const text = JSON.stringify(graph);
    if (Buffer.byteLength(text, "utf8") <= maxBytes || returned === 0) return { graph, text };
    returned--;
  }
}

export function registerRelationshipGraph(pi: ExtensionAPI, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "relationship_graph",
    label: "Relationship graph",
    description: "Build a bounded read-only heuristic graph of files and source locations mentioning a function, type, variable, command, or other query token. Roles are candidates, not semantic resolution.",
    promptSnippet: "Map a query token to bounded file and source-location relationships",
    promptGuidelines: ["Use relationship_graph to orient around a known symbol or token. Treat possible_definition, possible_import, possible_export, and possible_call as heuristics; confirm important relationships from source."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "Exact symbol or token to map" }),
      path: Type.Optional(Type.String({ maxLength: 500, description: "Workspace-relative file or directory; default ." })),
      glob: Type.Optional(Type.String({ maxLength: 200, description: "Optional file glob, such as *.ts" })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GRAPH_RESULTS, description: `Maximum location nodes; default ${DEFAULT_GRAPH_RESULTS}` })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const query = params.query.trim();
      if (!query) throw new Error("Relationship query must contain a non-whitespace token");
      const path = workspacePath(ctx.cwd, params.path);
      const maxResults = params.max_results ?? DEFAULT_GRAPH_RESULTS;
      const args = [
        "--no-config", "--json", "--fixed-strings", "--line-number", "--color=never", "--sort", "path",
        "--max-columns=500", "--max-columns-preview", "--max-count", String(maxResults),
      ];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(query)) args.push("--word-regexp");
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", query, path);
      try {
        const result = await pi.exec("rg", args, { signal, timeout: SEARCH_TIMEOUT_MS });
        if (result.code !== 0 && result.code !== 1) {
          if (unavailable(result.stderr)) return {
            content: [{ type: "text" as const, text: "ripgrep unavailable; relationship graph was not built." }],
            details: { unavailable: true },
          };
          throw new Error(`ripgrep failed (${result.code}): ${boundedError(result.stderr)}`);
        }
        const parsed = result.code === 1
          ? { matches: [], malformed: 0, searchMayBeTruncated: false }
          : parseRelationshipMatches(result.stdout, query, maxResults);
        const { graph, text } = relationshipGraph(query, path, parsed.matches, maxResults, parsed.malformed, parsed.searchMayBeTruncated, maxBytes);
        return { content: [{ type: "text" as const, text }], details: graph.metadata };
      } catch (error) {
        if (unavailable(error)) return {
          content: [{ type: "text" as const, text: "ripgrep unavailable; relationship graph was not built." }],
          details: { unavailable: true },
        };
        throw error;
      }
    },
  });
}

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DISCOVER_CHILD_TOOL_NAMES } from "../src/discover-child-tools.ts";
import { registerFd } from "../src/fd.ts";
import { registerRelationshipGraph } from "../src/relationship-graph.ts";
import { registerRg } from "../src/rg.ts";

const MAX_RESULT_CHARS = 2_000;
const discoverChildToolsExtension = fileURLToPath(new URL("../src/discover-child-tools.ts", import.meta.url));

export { workspacePath } from "../src/search-common.ts";
export { relationshipRoles } from "../src/relationship-graph.ts";

export type ToolMetadata = {
  name: string;
  description?: string;
  aliases?: readonly string[];
  capabilities?: readonly string[];
};
export type ToolDiscoveryResult = {
  error?: string;
  selected?: string[];
  blocked?: string[];
};
export type ToolDiscoveryCapability = {
  eligible(): string[];
  select(names: string[]): ToolDiscoveryResult;
  reset(): ToolDiscoveryResult;
};

function keywords(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

export function normalizedQuery(query: string): string {
  return keywords(query).sort().join(" ");
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Deterministically rank exact names and structured capabilities before description overlap. */
export function keywordRankTools(tools: readonly ToolMetadata[], query: string, limit = 3): ToolMetadata[] {
  const queryKey = normalizedQuery(query);
  const terms = queryKey.split(" ").filter(Boolean);
  if (!terms.length) return [];
  return tools
    .map((tool) => {
      const name = normalizedQuery(tool.name);
      const nameTerms = new Set(keywords(tool.name));
      const structured = [...(tool.aliases ?? []), ...(tool.capabilities ?? [])]
        .map(normalizedQuery)
        .filter(Boolean);
      const rank = [
        Number(name === queryKey),
        Number(structured.includes(queryKey)),
        terms.filter((term) => structured.includes(term)).length,
        terms.filter((term) => nameTerms.has(term)).length,
        terms.filter((term) => name.includes(term)).length,
        terms.filter((term) => structured.some((value) => value.includes(term))).length,
        terms.filter((term) => (tool.description ?? "").toLowerCase().includes(term)).length,
      ];
      return { tool, rank };
    })
    .filter(({ rank }) => rank.some(Boolean))
    .sort((a, b) => compareRank(a.rank, b.rank) || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => tool);
}

/** Rank only inactive tools, excluding search_tools itself. */
export function rankInactiveTools(tools: readonly ToolMetadata[], activeNames: readonly string[], query: string, limit = 3): ToolMetadata[] {
  const active = new Set(activeNames);
  return keywordRankTools(tools.filter((tool) => tool.name !== "search_tools" && !active.has(tool.name)), query, limit);
}

function discoveryCapability(pi: ExtensionAPI): ToolDiscoveryCapability | undefined {
  const responses: unknown[] = [];
  pi.events.emit("pylon:tool-discovery", { version: 1, respond: (capability: unknown) => responses.push(capability) });
  if (responses.length !== 1) return undefined;
  const capability = responses[0] as Partial<ToolDiscoveryCapability>;
  if (typeof capability?.eligible !== "function" || typeof capability.select !== "function" || typeof capability.reset !== "function") return undefined;
  return capability as ToolDiscoveryCapability;
}

function fit(text: string, maxBytes: number): string {
  let value = text;
  while (Buffer.byteLength(value, "utf8") > maxBytes) value = value.slice(0, -1);
  return value;
}

function resultText(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return fit(text ?? "", MAX_RESULT_CHARS);
}

export default function discoverExtension(pi: ExtensionAPI) {
  registerRg(pi);
  registerFd(pi);
  registerRelationshipGraph(pi);

  type CachedSearch = { names: string[]; missMarker?: { query: string; inventory: string } };
  const searchCache = new Map<string, CachedSearch>();
  const offered = new Map<string, number>();
  const selected = new Map<string, number>();
  const blocked = new Map<string, number>();
  const invoked = new Map<string, number>();
  const selectedTools = new Set<string>();
  const metrics = { searches: 0, cacheHits: 0, misses: 0, repeatedMisses: 0, selectionFailures: 0 };
  const increment = (counts: Map<string, number>, names: readonly string[]) => {
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const clearTurnState = () => searchCache.clear();
  const clearSessionState = () => {
    clearTurnState();
    offered.clear();
    selected.clear();
    blocked.clear();
    invoked.clear();
    selectedTools.clear();
    Object.assign(metrics, { searches: 0, cacheHits: 0, misses: 0, repeatedMisses: 0, selectionFailures: 0 });
  };
  const countText = (counts: Map<string, number>) => [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ") || "none";

  const disposeChildCapability = pi.events.on("pi-discover:child-tools-capability", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond(Object.freeze({
      version: 1,
      owner: "pi-discover",
      childExtensionPath: discoverChildToolsExtension,
      toolNames: Object.freeze([...DISCOVER_CHILD_TOOL_NAMES]),
    }));
  });
  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond({
      version: 1,
      owner: "pi-discover",
      label: "Discover",
      lines: [
        `Searches: ${metrics.searches}; cache hits: ${metrics.cacheHits}; misses: ${metrics.misses}; repeated misses: ${metrics.repeatedMisses}`,
        `Offered: ${countText(offered)}`,
        `Selected: ${countText(selected)}; blocked: ${countText(blocked)}; later invoked: ${countText(invoked)}; selection failures: ${metrics.selectionFailures}`,
      ],
      warning: false,
    });
  });
  pi.on("session_start", clearSessionState);
  pi.on("turn_end", clearTurnState);
  pi.on("tool_call", (event: any) => {
    if (selectedTools.has(event?.toolName)) increment(invoked, [event.toolName]);
  });
  pi.on("session_shutdown", () => {
    disposeChildCapability();
    disposeHealth();
    clearSessionState();
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search tools",
    description: "Find inactive Pi tools by keyword and ask Pylon to activate matching tools for the next model turn.",
    promptSnippet: "Find and activate inactive tools by keyword for the next turn",
    promptGuidelines: ["Use search_tools when a relevant Pi tool is inactive. Activated definitions become callable next model turn; do not assume they are callable in this turn."],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["search", "reset"] as const)),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Keywords to match against inactive tool names and descriptions" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Maximum matching tools to activate; default 3" })),
    }, { additionalProperties: false }),
    async execute(_id, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }> {
      const capability = discoveryCapability(pi);
      if (!capability) return {
        content: [{ type: "text" as const, text: "Pylon tool coordination is unavailable; no tools were activated." }],
        details: { failureCode: "coordination_unavailable" },
      };
      if ((params.action ?? "search") === "reset") {
        const reset = capability.reset();
        if (reset.error) {
          metrics.selectionFailures++;
          return {
            content: [{ type: "text" as const, text: `Pylon tool selection reset failed: ${reset.error}` }],
            details: { action: "reset", failureCode: "selection_failed" },
          };
        }
        clearTurnState();
        selectedTools.clear();
        const result = resultText(reset);
        return {
          content: [{ type: "text" as const, text: `Pylon tool selection reset.${result ? ` ${result}` : ""} Definitions update next model turn.` }],
          details: { action: "reset" },
        };
      }
      const query = params.query?.trim() ?? "";
      const queryKey = normalizedQuery(query);
      if (!queryKey) return {
        content: [{ type: "text" as const, text: "Provide query keywords to search inactive tools." }],
        details: { action: "search", matches: [] },
      };
      metrics.searches++;
      const eligible = [...new Set(capability.eligible())].sort();
      const eligibleSet = new Set(eligible);
      const active = [...new Set(pi.getActiveTools())].sort();
      const candidates = [...new Map(
        ((pi.getAllTools?.() ?? []) as ToolMetadata[])
          .filter((tool) => eligibleSet.has(tool.name))
          .map((tool) => [tool.name, tool] as const),
      ).values()];
      const limit = params.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 6) return {
        content: [{ type: "text" as const, text: "Tool search limit must be an integer from 1 to 6." }],
        details: { action: "search", matches: [], failureCode: "invalid_limit" },
      };
      const inventory = JSON.stringify(candidates.map((tool) => [
        tool.name, tool.description ?? "", [...(tool.aliases ?? [])].sort(), [...(tool.capabilities ?? [])].sort(),
      ]).sort(([a], [b]) => String(a).localeCompare(String(b))));
      const cacheKey = JSON.stringify([queryKey, limit, eligible, active, inventory]);
      let cached = searchCache.get(cacheKey);
      const cacheHit = Boolean(cached);
      if (cacheHit) metrics.cacheHits++;
      else {
        const names = rankInactiveTools(candidates, active, queryKey, limit).map((tool) => tool.name);
        cached = { names };
        if (!names.length) cached.missMarker = {
          query: createHash("sha256").update(queryKey).digest("hex").slice(0, 16),
          inventory: createHash("sha256").update(JSON.stringify([eligible, active, inventory])).digest("hex").slice(0, 16),
        };
        searchCache.set(cacheKey, cached);
      }
      const result = cached!;
      const { names } = result;
      if (!names.length) {
        const alreadySearched = cacheHit;
        if (alreadySearched) metrics.repeatedMisses++;
        else metrics.misses++;
        return {
          content: [{ type: "text" as const, text: `No eligible inactive tools matched.${alreadySearched ? " Already searched this tool inventory." : ""}` }],
          details: { action: "search", matches: [], alreadySearched, missMarker: result.missMarker },
        };
      }
      increment(offered, names);
      const selection = capability.select(names);
      if (selection.error) {
        metrics.selectionFailures++;
        return {
          content: [{ type: "text" as const, text: `Tool activation failed: ${selection.error}` }],
          details: { action: "search", matches: names, cacheHit, failureCode: "selection_failed" },
        };
      }
      const requested = new Set(names);
      const selectedNames = Array.isArray(selection.selected)
        ? [...new Set(selection.selected.filter((name) => requested.has(name)))]
        : names;
      const blockedNames = Array.isArray(selection.blocked)
        ? [...new Set(selection.blocked.filter((name) => requested.has(name)))]
        : [];
      const blockedSet = new Set(blockedNames);
      increment(selected, selectedNames);
      increment(blocked, blockedNames);
      selectedTools.clear();
      for (const name of selectedNames) if (!blockedSet.has(name)) selectedTools.add(name);
      const extra = resultText(selection);
      const summary = selectedNames.length ? `Selected: ${selectedNames.join(", ")}.` : "No tools selected.";
      const blockedSummary = blockedNames.length ? ` Blocked by current policy: ${blockedNames.join(", ")}.` : "";
      return {
        content: [{ type: "text" as const, text: `${summary}${blockedSummary} Callable definitions update next model turn.${extra ? ` ${extra}` : ""}` }],
        details: { action: "search", matches: names, selected: selectedNames, cacheHit, blocked: blockedNames },
      };
    },
  });
}

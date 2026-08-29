import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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
export type ToolDiscoveryCatalogEntry = { name: string; usage?: string };
export type ToolDiscoveryCapability = {
  eligible(): string[];
  catalog?(): ToolDiscoveryCatalogEntry[];
  select(names: string[]): ToolDiscoveryResult;
  reset(): ToolDiscoveryResult;
};

const MAX_DISCOVERY_GUIDANCE_CHARS = 1_000;
const MAX_DISCOVERY_GUIDANCE_ENTRIES = 20;

function normalizedUsage(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117).trimEnd()}...`;
}

export function formatToolDiscoveryGuidance(
  entries: readonly ToolDiscoveryCatalogEntry[],
  maxChars = MAX_DISCOVERY_GUIDANCE_CHARS,
  maxEntries = MAX_DISCOVERY_GUIDANCE_ENTRIES,
): string | undefined {
  const prefix = "search_tools can activate deferred capabilities for: ";
  const suffix =
    ". Call search_tools with the relevant capability phrase when needed.";
  const omittedNote =
    " Some additional deferred capabilities remain searchable.";
  const budget = maxChars - prefix.length - suffix.length - omittedNote.length;
  if (budget < 1 || maxEntries < 1) return undefined;
  const phrases: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  let omitted = false;
  for (const { usage } of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const phrase = normalizedUsage(usage);
    if (!phrase || seen.has(phrase)) continue;
    const addedLength = (phrases.length ? 2 : 0) + phrase.length;
    if (phrases.length >= maxEntries || length + addedLength > budget) {
      omitted = true;
      continue;
    }
    phrases.push(phrase);
    seen.add(phrase);
    length += addedLength;
  }
  if (!phrases.length) return undefined;
  return `${prefix}${phrases.join("; ")}${omitted ? omittedNote : ""}${suffix}`;
}

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
export function keywordRankTools(
  tools: readonly ToolMetadata[],
  query: string,
  limit = 3,
): ToolMetadata[] {
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
        terms.filter((term) => structured.some((value) => value.includes(term)))
          .length,
        terms.filter((term) =>
          (tool.description ?? "").toLowerCase().includes(term),
        ).length,
      ];
      return { tool, rank };
    })
    .filter(({ rank }) => rank.some(Boolean))
    .sort(
      (a, b) =>
        compareRank(a.rank, b.rank) || a.tool.name.localeCompare(b.tool.name),
    )
    .slice(0, limit)
    .map(({ tool }) => tool);
}

/** Rank only inactive tools, excluding search_tools itself. */
export function rankInactiveTools(
  tools: readonly ToolMetadata[],
  activeNames: readonly string[],
  query: string,
  limit = 3,
): ToolMetadata[] {
  const active = new Set(activeNames);
  return keywordRankTools(
    tools.filter(
      (tool) => tool.name !== "search_tools" && !active.has(tool.name),
    ),
    query,
    limit,
  );
}

function discoveryCapability(
  pi: ExtensionAPI,
): ToolDiscoveryCapability | undefined {
  const responses: unknown[] = [];
  pi.events.emit("pylon:tool-discovery", {
    version: 1,
    respond: (capability: unknown) => responses.push(capability),
  });
  if (responses.length !== 1) return undefined;
  const capability = responses[0] as Partial<ToolDiscoveryCapability>;
  if (
    typeof capability?.eligible !== "function" ||
    typeof capability.select !== "function" ||
    typeof capability.reset !== "function"
  )
    return undefined;
  if (
    capability.catalog !== undefined &&
    typeof capability.catalog !== "function"
  )
    return undefined;
  return capability as ToolDiscoveryCapability;
}

function discoveryInventory(
  pi: ExtensionAPI,
  capability: ToolDiscoveryCapability,
) {
  const eligible = [...new Set(capability.eligible())].sort();
  const active = new Set(pi.getActiveTools());
  const inactive = eligible.filter((name) => !active.has(name));
  const eligibleSet = new Set(eligible);
  let catalog: ToolDiscoveryCatalogEntry[] = [];
  try {
    const value = capability.catalog?.();
    if (Array.isArray(value)) catalog = value;
  } catch {
    /* Fall back to registered tool descriptions. */
  }
  const usageByName = new Map(
    catalog
      .filter((entry) => entry && eligibleSet.has(entry.name))
      .map((entry) => [entry.name, normalizedUsage(entry.usage)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const registered = new Map(
    ((pi.getAllTools?.() ?? []) as ToolMetadata[])
      .filter((tool) => eligibleSet.has(tool.name))
      .map((tool) => [tool.name, tool] as const),
  );
  const candidates = [...registered.values()].map((tool) => {
    const usage = usageByName.get(tool.name);
    return usage
      ? { ...tool, capabilities: [...(tool.capabilities ?? []), usage] }
      : tool;
  });
  const guidance = inactive.map((name) => ({
    name,
    usage:
      usageByName.get(name) ??
      normalizedUsage(registered.get(name)?.description),
  }));
  return { eligible, candidates, guidance };
}

export type ToolDiscovery = {
  /** Extra system-prompt guidance listing deferred capabilities, or undefined when there is none. */
  guidanceFor(event: any): { systemPrompt: string } | undefined;
  /** Record that a previously activated tool was actually called. */
  noteToolCall(toolName: string): void;
  clearTurnState(): void;
  clearSessionState(): void;
  healthLines(): string[];
};

/** Registers `search_tools` and owns its per-turn cache and per-session counters. */
export function createToolDiscovery(pi: ExtensionAPI): ToolDiscovery {
  type CachedSearch = {
    names: string[];
    missMarker?: { query: string; inventory: string };
  };
  const searchCache = new Map<string, CachedSearch>();
  const offered = new Map<string, number>();
  const selected = new Map<string, number>();
  const blocked = new Map<string, number>();
  const invoked = new Map<string, number>();
  const selectedTools = new Set<string>();
  const metrics = {
    searches: 0,
    cacheHits: 0,
    misses: 0,
    repeatedMisses: 0,
    selectionFailures: 0,
  };

  const increment = (counts: Map<string, number>, names: readonly string[]) => {
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const clearTurnState = () => searchCache.clear();
  const countText = (counts: Map<string, number>) =>
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([name, count]) => `${name}=${count}`)
      .join(", ") || "none";

  const reply = (text: string, details: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text }],
    details,
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search tools",
    description:
      "Find inactive Pi tools by keyword and ask Pylon to activate matching tools for the next model turn.",
    promptSnippet:
      "Find and activate inactive tools by keyword for the next turn",
    promptGuidelines: [
      "Use search_tools when a relevant Pi tool is inactive. Activated definitions become callable next model turn; do not assume they are callable in this turn.",
    ],
    parameters: Type.Object(
      {
        action: Type.Optional(StringEnum(["search", "reset"] as const)),
        query: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description:
              "Keywords to match against inactive tool names, advertised usages, and descriptions",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 6,
            description: "Maximum matching tools to activate; default 3",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _id,
      params,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }> {
      const capability = discoveryCapability(pi);
      if (!capability)
        return reply(
          "Pylon tool coordination is unavailable; no tools were activated.",
          { failureCode: "coordination_unavailable" },
        );

      if ((params.action ?? "search") === "reset") {
        const reset = capability.reset();
        if (reset.error) {
          metrics.selectionFailures++;
          return reply(`Pylon tool selection reset failed: ${reset.error}`, {
            action: "reset",
            failureCode: "selection_failed",
          });
        }
        clearTurnState();
        selectedTools.clear();
        return reply(
          "Pylon tool selection reset. Definitions update next model turn.",
          { action: "reset", coordinator: reset },
        );
      }

      const queryKey = normalizedQuery(params.query?.trim() ?? "");
      if (!queryKey)
        return reply("Provide query keywords to search inactive tools.", {
          action: "search",
          matches: [],
        });
      metrics.searches++;
      const limit = params.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 6)
        return reply("Tool search limit must be an integer from 1 to 6.", {
          action: "search",
          matches: [],
          failureCode: "invalid_limit",
        });

      const { eligible, candidates } = discoveryInventory(pi, capability);
      const active = [...new Set(pi.getActiveTools())].sort();
      const inventory = JSON.stringify(
        candidates
          .map((tool) => [
            tool.name,
            tool.description ?? "",
            [...(tool.aliases ?? [])].sort(),
            [...(tool.capabilities ?? [])].sort(),
          ])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
      const cacheKey = JSON.stringify([
        queryKey,
        limit,
        eligible,
        active,
        inventory,
      ]);
      const buildSearch = (): CachedSearch => {
        const names = rankInactiveTools(
          candidates,
          active,
          queryKey,
          limit,
        ).map((tool) => tool.name);
        if (names.length) return { names };
        return {
          names,
          missMarker: {
            query: createHash("sha256")
              .update(queryKey)
              .digest("hex")
              .slice(0, 16),
            inventory: createHash("sha256")
              .update(JSON.stringify([eligible, active, inventory]))
              .digest("hex")
              .slice(0, 16),
          },
        };
      };
      const cached = searchCache.get(cacheKey);
      const cacheHit = Boolean(cached);
      if (cacheHit) metrics.cacheHits++;
      const result = cached ?? buildSearch();
      if (!cacheHit) searchCache.set(cacheKey, result);

      const { names } = result;
      if (!names.length) {
        if (cacheHit) metrics.repeatedMisses++;
        else metrics.misses++;
        return reply(
          `No eligible inactive tools matched.${cacheHit ? " Already searched this tool inventory." : ""}`,
          {
            action: "search",
            matches: [],
            alreadySearched: cacheHit,
            missMarker: result.missMarker,
          },
        );
      }

      increment(offered, names);
      const selection = capability.select(names);
      if (selection.error) {
        metrics.selectionFailures++;
        return reply(`Tool activation failed: ${selection.error}`, {
          action: "search",
          matches: names,
          cacheHit,
          failureCode: "selection_failed",
        });
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
      for (const name of selectedNames)
        if (!blockedSet.has(name)) selectedTools.add(name);
      const summary = selectedNames.length
        ? `Selected: ${selectedNames.join(", ")}.`
        : "No tools selected.";
      const blockedSummary = blockedNames.length
        ? ` Blocked by current policy: ${blockedNames.join(", ")}.`
        : "";
      return reply(
        `${summary}${blockedSummary} Callable definitions update next model turn.`,
        {
          action: "search",
          matches: names,
          selected: selectedNames,
          cacheHit,
          blocked: blockedNames,
          coordinator: selection,
        },
      );
    },
  });

  return {
    clearTurnState,
    clearSessionState() {
      clearTurnState();
      offered.clear();
      selected.clear();
      blocked.clear();
      invoked.clear();
      selectedTools.clear();
      Object.assign(metrics, {
        searches: 0,
        cacheHits: 0,
        misses: 0,
        repeatedMisses: 0,
        selectionFailures: 0,
      });
    },
    noteToolCall(toolName: string) {
      if (selectedTools.has(toolName)) increment(invoked, [toolName]);
    },
    guidanceFor(event: any) {
      if (!event.systemPromptOptions?.selectedTools?.includes("search_tools"))
        return undefined;
      const capability = discoveryCapability(pi);
      if (!capability) return undefined;
      const guidance = formatToolDiscoveryGuidance(
        discoveryInventory(pi, capability).guidance,
      );
      if (!guidance) return undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\nDeferred tool discovery:\n- ${guidance}`,
      };
    },
    healthLines: () => [
      `Searches: ${metrics.searches}; cache hits: ${metrics.cacheHits}; misses: ${metrics.misses}; repeated misses: ${metrics.repeatedMisses}`,
      `Offered: ${countText(offered)}`,
      `Selected: ${countText(selected)}; blocked: ${countText(blocked)}; later invoked: ${countText(invoked)}; selection failures: ${metrics.selectionFailures}`,
    ],
  };
}

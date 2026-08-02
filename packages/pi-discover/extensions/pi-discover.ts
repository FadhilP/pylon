import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DISCOVER_CHILD_TOOL_NAMES } from "../src/discover-child-tools.ts";
import { registerFd } from "../src/fd.ts";
import { registerIndexTools, WorkspaceIndex } from "../src/index.ts";
import { registerRelationshipGraph } from "../src/relationship-graph.ts";
import { registerRg } from "../src/rg.ts";
import { boundedError } from "../src/search-common.ts";
import { registerSessionSearch } from "../src/sessions.ts";

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
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}...`;
}

export function formatToolDiscoveryGuidance(
  entries: readonly ToolDiscoveryCatalogEntry[],
  maxChars = MAX_DISCOVERY_GUIDANCE_CHARS,
  maxEntries = MAX_DISCOVERY_GUIDANCE_ENTRIES,
): string | undefined {
  const prefix = "search_tools can activate deferred capabilities for: ";
  const suffix = ". Call search_tools with the relevant capability phrase when needed.";
  const omittedNote = " Some additional deferred capabilities remain searchable.";
  const budget = maxChars - prefix.length - suffix.length - omittedNote.length;
  if (budget < 1 || maxEntries < 1) return undefined;
  const phrases: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  let omitted = false;
  for (const { usage } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
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
  if (capability.catalog !== undefined && typeof capability.catalog !== "function") return undefined;
  return capability as ToolDiscoveryCapability;
}

function discoveryInventory(pi: ExtensionAPI, capability: ToolDiscoveryCapability) {
  const eligible = [...new Set(capability.eligible())].sort();
  const eligibleSet = new Set(eligible);
  let catalog: ToolDiscoveryCatalogEntry[] = [];
  try {
    const value = capability.catalog?.();
    if (Array.isArray(value)) catalog = value;
  } catch { /* Fall back to registered tool descriptions. */ }
  const usageByName = new Map(
    catalog
      .filter((entry) => entry && eligibleSet.has(entry.name))
      .map((entry) => [entry.name, normalizedUsage(entry.usage)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const candidates = [...new Map(
    ((pi.getAllTools?.() ?? []) as ToolMetadata[])
      .filter((tool) => eligibleSet.has(tool.name))
      .map((tool) => {
        const usage = usageByName.get(tool.name);
        return [tool.name, usage ? {
          ...tool,
          capabilities: [...(tool.capabilities ?? []), usage],
        } : tool] as const;
      }),
  ).values()];
  const guidance = eligible.map((name) => ({ name, usage: usageByName.get(name) }));
  return { eligible, candidates, guidance };
}

export default function discoverExtension(pi: ExtensionAPI) {
  registerRg(pi);
  registerFd(pi);
  registerRelationshipGraph(pi);
  registerSessionSearch(pi);
  const indexes = new Map<string, WorkspaceIndex>();
  const indexFor = (cwd: string) => {
    let index = indexes.get(cwd);
    if (!index) {
      index = new WorkspaceIndex(cwd, async (command, args, options) => {
        const result = await pi.exec(command, args, options);
        return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      });
      indexes.set(cwd, index);
    }
    return index;
  };
  registerIndexTools(pi, indexFor);
  const configureDeferredTools = () => {
    let coordinated = false;
    const deferredTools = ["relationship_graph", "index_status", "search_sessions"];
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-discover",
      managedTools: deferredTools,
      enabledTools: deferredTools,
      deferredTools,
      deferredToolUsage: {
        relationship_graph: "map source symbols or tokens to related files and source locations",
        index_status: "inspect local repository code-index status",
        search_sessions: "search historical Pi sessions when explicitly requested",
      },
      acknowledge: () => { coordinated = true; },
    });
    if (!coordinated) pi.setActiveTools(pi.getActiveTools().filter((name) => !deferredTools.includes(name)));
  };

  type CachedSearch = { names: string[]; missMarker?: { query: string; inventory: string } };
  const searchCache = new Map<string, CachedSearch>();
  const offered = new Map<string, number>();
  const selected = new Map<string, number>();
  const blocked = new Map<string, number>();
  const invoked = new Map<string, number>();
  const selectedTools = new Set<string>();
  const metrics = { searches: 0, cacheHits: 0, misses: 0, repeatedMisses: 0, selectionFailures: 0 };
  let latestIndexError: string | undefined;
  let indexReady = false;
  let activeCwd = "";
  let indexing = false;
  let pendingRefreshCwd: string | undefined;
  let backgroundRefresh: Promise<void> | undefined;
  let shuttingDown = false;
  const publishIndexState = async (cwd = activeCwd) => {
    if (!cwd) return;
    if (indexing) {
      pi.events.emit("pi-discover:index-state", { version: 1, available: true, state: "indexing" });
      return;
    }
    if (latestIndexError) {
      pi.events.emit("pi-discover:index-state", { version: 1, available: true, state: "error", error: latestIndexError });
      return;
    }
    try {
      const status = await indexFor(cwd).status() as Record<string, unknown>;
      const indexedAt = Number.isSafeInteger(status.indexed_at) && (status.indexed_at as number) >= 0
        ? new Date(status.indexed_at as number).toISOString()
        : undefined;
      pi.events.emit("pi-discover:index-state", {
        version: 1,
        available: true,
        state: "idle",
        files: status.files,
        symbols: status.symbols,
        indexedAt,
      });
    } catch (error) {
      latestIndexError = boundedError(error);
      pi.events.emit("pi-discover:index-state", { version: 1, available: true, state: "error", error: latestIndexError });
    }
  };
  const refreshIndex = async (ctx?: { cwd?: string }) => {
    if (!ctx?.cwd) return;
    activeCwd = ctx.cwd;
    indexing = true;
    await publishIndexState();
    try {
      await indexFor(ctx.cwd).refresh();
      latestIndexError = undefined;
      indexReady = true;
    } catch (error) {
      latestIndexError = boundedError(error);
    } finally {
      indexing = false;
      await publishIndexState();
    }
  };
  const scheduleIndexRefresh = (ctx?: { cwd?: string }) => {
    if (!ctx?.cwd || shuttingDown) return;
    activeCwd = ctx.cwd;
    pendingRefreshCwd = ctx.cwd;
    if (backgroundRefresh) return;
    backgroundRefresh = (async () => {
      while (pendingRefreshCwd && !shuttingDown) {
        const cwd = pendingRefreshCwd;
        pendingRefreshCwd = undefined;
        await refreshIndex({ cwd });
      }
    })().catch((error) => {
      latestIndexError = boundedError(error);
      indexing = false;
      pi.events.emit("pi-discover:index-state", { version: 1, available: true, state: "error", error: latestIndexError });
    }).finally(() => {
      backgroundRefresh = undefined;
      if (pendingRefreshCwd && !shuttingDown) scheduleIndexRefresh({ cwd: pendingRefreshCwd });
    });
  };
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
    if (request?.version !== 2 || typeof request.respond !== "function") return;
    request.respond(Object.freeze({
      version: 2,
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
        `Index: ${latestIndexError ? `refresh failed: ${latestIndexError}` : indexReady ? "ready" : "not initialized"}`,
      ],
      warning: Boolean(latestIndexError),
    });
  });
  const disposeIndexActions = pi.events.on("pi-discover:index-action", (request: any) => {
    if (request?.version !== 1 || request.action !== "rebuild"
      || typeof request.acknowledge !== "function"
      || typeof request.resolve !== "function"
      || typeof request.reject !== "function") return;
    request.acknowledge();
    void (async () => {
      if (!activeCwd || indexing) throw new Error(indexing ? "the index is already rebuilding" : "pi-discover has no active workspace");
      indexing = true;
      await publishIndexState();
      let failure: Error | undefined;
      try {
        await indexFor(activeCwd).rebuild();
        latestIndexError = undefined;
        indexReady = true;
      } catch (error) {
        latestIndexError = boundedError(error);
        failure = new Error(latestIndexError);
      } finally {
        indexing = false;
        await publishIndexState();
      }
      if (failure) request.reject(failure);
      else request.resolve();
    })().catch((error) => request.reject(error));
  });
  pi.on("session_start", (_event, ctx) => {
    clearSessionState();
    configureDeferredTools();
    scheduleIndexRefresh(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    clearTurnState();
    scheduleIndexRefresh(ctx);
  });
  pi.on("before_agent_start", (event: any) => {
    if (!event.systemPromptOptions?.selectedTools?.includes("search_tools")) return;
    const capability = discoveryCapability(pi);
    if (!capability) return;
    const guidance = formatToolDiscoveryGuidance(discoveryInventory(pi, capability).guidance);
    if (!guidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\nDeferred tool discovery:\n- ${guidance}` };
  });
  pi.on("tool_call", (event: any) => {
    if (selectedTools.has(event?.toolName)) increment(invoked, [event.toolName]);
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    pendingRefreshCwd = undefined;
    await backgroundRefresh;
    disposeChildCapability();
    disposeHealth();
    disposeIndexActions();
    pi.events.emit("pi-discover:index-state", { version: 1, available: false });
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-discover" });
    clearSessionState();
    await Promise.all([...indexes.values()].map((index) => index.close()));
    indexes.clear();
  });

  pi.registerCommand("discover-index", {
    description: "Refresh, rebuild, prune, or report the local pi-discover index",
    async handler(args, ctx) {
      const action = args.trim() || "refresh";
      if (!["refresh", "rebuild", "prune", "status"].includes(action)) {
        ctx.ui.notify("Usage: /discover-index [refresh|rebuild|prune|status]", "error");
        return;
      }
      await ctx.waitForIdle?.();
      if (indexing) {
        ctx.ui.notify("pi-discover indexing is already in progress.", "warning");
        return;
      }
      const activity = action === "status" ? "Reading index status..." : action === "prune" ? "Pruning stale index entries..." : `${action === "rebuild" ? "Rebuilding" : "Refreshing"} index...`;
      ctx.ui.setStatus("pi-discover-index", activity);
      activeCwd = ctx.cwd;
      indexing = action !== "status";
      await publishIndexState();
      try {
        const index = indexFor(ctx.cwd);
        let result;
        if (action === "prune") result = await index.prune();
        else {
          if (action === "refresh") await index.refresh();
          else if (action === "rebuild") await index.rebuild();
          result = await index.status();
        }
        latestIndexError = undefined;
        indexReady = true;
        ctx.ui.notify(`pi-discover index ${action === "status" ? "status" : `${action} complete`}: ${JSON.stringify(result)}`, "info");
      } catch (error) {
        latestIndexError = boundedError(error);
        ctx.ui.notify(`pi-discover index ${action} failed: ${latestIndexError}`, "error");
      } finally {
        indexing = false;
        await publishIndexState();
        ctx.ui.setStatus("pi-discover-index", undefined);
      }
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search tools",
    description: "Find inactive Pi tools by keyword and ask Pylon to activate matching tools for the next model turn.",
    promptSnippet: "Find and activate inactive tools by keyword for the next turn",
    promptGuidelines: ["Use search_tools when a relevant Pi tool is inactive. Activated definitions become callable next model turn; do not assume they are callable in this turn."],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["search", "reset"] as const)),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Keywords to match against inactive tool names, advertised usages, and descriptions" })),
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
        return {
          content: [{ type: "text" as const, text: "Pylon tool selection reset. Definitions update next model turn." }],
          details: { action: "reset", coordinator: reset },
        };
      }
      const query = params.query?.trim() ?? "";
      const queryKey = normalizedQuery(query);
      if (!queryKey) return {
        content: [{ type: "text" as const, text: "Provide query keywords to search inactive tools." }],
        details: { action: "search", matches: [] },
      };
      metrics.searches++;
      const { eligible, candidates } = discoveryInventory(pi, capability);
      const active = [...new Set(pi.getActiveTools())].sort();
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
      const summary = selectedNames.length ? `Selected: ${selectedNames.join(", ")}.` : "No tools selected.";
      const blockedSummary = blockedNames.length ? ` Blocked by current policy: ${blockedNames.join(", ")}.` : "";
      return {
        content: [{ type: "text" as const, text: `${summary}${blockedSummary} Callable definitions update next model turn.` }],
        details: { action: "search", matches: names, selected: selectedNames, cacheHit, blocked: blockedNames, coordinator: selection },
      };
    },
  });
}

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

export type ToolMetadata = { name: string; description?: string };
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

/** Deterministically rank tools by query keywords in their name and description. */
export function keywordRankTools(tools: readonly ToolMetadata[], query: string, limit = 3): ToolMetadata[] {
  const terms = keywords(query);
  if (!terms.length) return [];
  return tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = (tool.description ?? "").toLowerCase();
      const score = terms.reduce((total, term) => total
        + (name === term ? 16 : name.includes(term) ? 8 : 0)
        + (description.includes(term) ? 2 : 0), 0);
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
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

  const disposeChildCapability = pi.events.on("pi-discover:child-tools-capability", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond(Object.freeze({
      version: 1,
      owner: "pi-discover",
      childExtensionPath: discoverChildToolsExtension,
      toolNames: Object.freeze([...DISCOVER_CHILD_TOOL_NAMES]),
    }));
  });
  pi.on("session_shutdown", () => disposeChildCapability());

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
        if (reset.error) return {
          content: [{ type: "text" as const, text: `Pylon tool selection reset failed: ${reset.error}` }],
          details: { action: "reset", failureCode: "selection_failed" },
        };
        const result = resultText(reset);
        return {
          content: [{ type: "text" as const, text: `Pylon tool selection reset.${result ? ` ${result}` : ""} Definitions update next model turn.` }],
          details: { action: "reset" },
        };
      }
      const query = params.query?.trim() ?? "";
      if (!query) return {
        content: [{ type: "text" as const, text: "Provide query keywords to search inactive tools." }],
        details: { action: "search", matches: [] },
      };
      const eligible = [...new Set(capability.eligible())].sort();
      const eligibleSet = new Set(eligible);
      const matches = rankInactiveTools(
        ((pi.getAllTools?.() ?? []) as ToolMetadata[]).filter((tool) => eligibleSet.has(tool.name)),
        pi.getActiveTools(), query, params.limit ?? 3,
      );
      const names = matches.map((tool) => tool.name);
      if (!names.length) return {
        content: [{ type: "text" as const, text: `No eligible inactive tools matched "${query}".` }],
        details: { action: "search", query, matches: [] },
      };
      const selection = capability.select(names);
      if (selection.error) return {
        content: [{ type: "text" as const, text: `Tool activation failed: ${selection.error}` }],
        details: { action: "search", query, matches: names, failureCode: "selection_failed" },
      };
      const extra = resultText(selection);
      return {
        content: [{ type: "text" as const, text: `Activated: ${names.join(", ")}. Their definitions become callable next model turn.${extra ? ` ${extra}` : ""}` }],
        details: { action: "search", query, matches: names, blocked: selection.blocked ?? [] },
      };
    },
  });
}

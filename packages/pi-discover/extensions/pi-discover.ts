import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISCOVER_CHILD_TOOL_NAMES } from "../src/discover-child-tools.ts";
import { registerFd } from "../src/fd.ts";
import { createIndexRegistry, registerIndexTools } from "../src/index.ts";
import { createIndexLifecycle } from "../src/index-lifecycle.ts";
import { registerRelationshipGraph } from "../src/relationship-graph.ts";
import { registerRg } from "../src/rg.ts";
import { registerSessionSearch, registerSessionStats } from "../src/sessions.ts";
import { createToolDiscovery } from "../src/tool-discovery.ts";

const discoverChildToolsExtension = fileURLToPath(new URL("../src/discover-child-tools.ts", import.meta.url));

export { workspacePath } from "../src/search-common.ts";
export { relationshipRoles } from "../src/relationship-graph.ts";
export {
  formatToolDiscoveryGuidance,
  keywordRankTools,
  normalizedQuery,
  rankInactiveTools,
  type ToolDiscoveryCapability,
  type ToolDiscoveryCatalogEntry,
  type ToolDiscoveryResult,
  type ToolMetadata,
} from "../src/tool-discovery.ts";

/** Tools this extension owns, and the capability phrase each advertises to search_tools. */
const TOOL_USAGE: Record<string, string> = {
  search_tools: "find and activate inactive tools by capability",
  symbol_search: "search local repository symbols by name, kind, language, or path",
  fd: "find files and directories by path pattern",
  rg: "search file contents with regex and line-numbered matches",
  code_search: "search indexed source with ranked lexical snippets",
  relationship_graph: "map source symbols or tokens to related files and source locations",
  index_status: "inspect local repository code-index status",
  search_sessions: "search within exact historical Pi session IDs or assistant tool calls when explicitly requested",
  session_stats: "inspect historical Pi session usage and tool-call statistics when explicitly requested",
};
const MANAGED_TOOLS = Object.keys(TOOL_USAGE);
/** Managed tools that stay inactive until search_tools activates them; search_tools, fd, and rg are always on. */
const DEFERRED_TOOLS = [
  "symbol_search",
  "code_search",
  "relationship_graph",
  "index_status",
  "search_sessions",
  "session_stats",
];

export default function discoverExtension(pi: ExtensionAPI) {
  registerRg(pi);
  registerFd(pi);
  registerRelationshipGraph(pi);
  registerSessionSearch(pi);
  registerSessionStats(pi);
  const { indexFor, closeAll: closeIndexes } = createIndexRegistry(pi);
  registerIndexTools(pi, indexFor);
  const index = createIndexLifecycle(pi, indexFor);
  const discovery = createToolDiscovery(pi);

  /** Ask Pylon to manage this extension's tools; without a coordinator, hide the deferred ones. */
  const configureDeferredTools = () => {
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-discover",
      managedTools: MANAGED_TOOLS,
      enabledTools: MANAGED_TOOLS,
      deferredTools: DEFERRED_TOOLS,
      toolUsage: TOOL_USAGE,
      acknowledge: () => {
        coordinated = true;
      },
    });
    if (!coordinated) pi.setActiveTools(pi.getActiveTools().filter(name => !DEFERRED_TOOLS.includes(name)));
  };

  const disposeChildCapability = pi.events.on("pi-discover:child-tools-capability", (request: any) => {
    if (request?.version !== 2 || typeof request.respond !== "function") return;
    request.respond(
      Object.freeze({
        version: 2,
        owner: "pi-discover",
        childExtensionPath: discoverChildToolsExtension,
        toolNames: Object.freeze([...DISCOVER_CHILD_TOOL_NAMES]),
      }),
    );
  });
  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond({
      version: 1,
      owner: "pi-discover",
      label: "Discover",
      lines: [...discovery.healthLines(), index.healthLine()],
      warning: index.hasError(),
    });
  });
  const disposeIndexActions = pi.events.on("pi-discover:index-action", index.handleAction);

  pi.on("session_start", (_event, ctx) => {
    discovery.clearSessionState();
    configureDeferredTools();
    index.scheduleRefresh(ctx);
  });
  pi.on("turn_end", () => discovery.clearTurnState());
  pi.on("before_agent_start", (event: any) => discovery.guidanceFor(event));
  pi.on("tool_call", (event: any) => discovery.noteToolCall(event?.toolName));
  pi.on("session_shutdown", async () => {
    await index.stop();
    disposeChildCapability();
    disposeHealth();
    disposeIndexActions();
    index.publishUnavailable();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-discover" });
    discovery.clearSessionState();
    await closeIndexes();
  });

  pi.registerCommand("discover-index", {
    description: "Refresh, rebuild, prune, or report the local pi-discover index",
    handler: (args, ctx) => index.runCommand(args, ctx),
  });
}

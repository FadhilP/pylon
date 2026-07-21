import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFd } from "./fd.ts";
import { registerRelationshipGraph } from "./relationship-graph.ts";
import { registerRg } from "./rg.ts";

export const DISCOVER_CHILD_TOOL_NAMES = ["rg", "fd", "relationship_graph"] as const;
export const DISCOVER_CHILD_MAX_BYTES = 24 * 1024;

export default function discoverChildToolsExtension(pi: ExtensionAPI) {
  registerRg(pi, DISCOVER_CHILD_MAX_BYTES);
  registerFd(pi, DISCOVER_CHILD_MAX_BYTES);
  registerRelationshipGraph(pi, DISCOVER_CHILD_MAX_BYTES);
}

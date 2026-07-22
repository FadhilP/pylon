import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFd } from "./fd.ts";
import { registerIndexTools, WorkspaceIndex } from "./index.ts";
import { registerRelationshipGraph } from "./relationship-graph.ts";
import { registerRg } from "./rg.ts";

export const DISCOVER_CHILD_TOOL_NAMES = ["rg", "fd", "relationship_graph", "symbol_search", "code_search", "index_status"] as const;
export const DISCOVER_CHILD_MAX_BYTES = 24 * 1024;

export default function discoverChildToolsExtension(pi: ExtensionAPI) {
  registerRg(pi, DISCOVER_CHILD_MAX_BYTES);
  registerFd(pi, DISCOVER_CHILD_MAX_BYTES);
  registerRelationshipGraph(pi, DISCOVER_CHILD_MAX_BYTES);
  const indexes = new Map<string, WorkspaceIndex>();
  registerIndexTools(pi, (cwd) => {
    let index = indexes.get(cwd);
    if (!index) {
      index = new WorkspaceIndex(cwd, async (command, args, options) => {
        const result = await pi.exec(command, args, options);
        return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      });
      indexes.set(cwd, index);
    }
    return index;
  }, DISCOVER_CHILD_MAX_BYTES);
}

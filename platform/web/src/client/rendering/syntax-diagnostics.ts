import type { Tree } from "@lezer/common";
import type { Diagnostic } from "@codemirror/lint";

/** Bounded recovery-node hints, shared by file grammars and the small JSON query worker. */
export function treeDiagnostics(text: string, tree: Tree): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  tree.iterate({
    enter(node) {
      if (diagnostics.length >= 100) return false;
      if (!node.type.isError) return;
      const from = node.from === text.length ? Math.max(0, node.from - 1) : node.from;
      diagnostics.push({ from, to: Math.min(text.length, Math.max(from + 1, node.to)), severity: "error",
        message: node.from === node.to ? "Incomplete or missing syntax." : "Unexpected syntax.", source: "Syntax" });
      return false;
    },
  });
  return diagnostics;
}

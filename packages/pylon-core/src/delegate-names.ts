import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PREFIXES: Record<string, "A" | "G" | "S"> = { advisor: "A", grunt: "G", repo_scout: "S", web_scout: "S" };

/**
 * Hands each delegate tool call a short stable display name (A1, G2, S3…).
 * Names already present in the branch are reused so a resumed session keeps its numbering.
 */
export function createDelegateNames(pi: ExtensionAPI) {
  const names = new Map<string, string>();
  const counts = { A: 0, G: 0, S: 0 };

  const dispose = pi.events.on("pylon:delegate-name", (request: any) => {
    if (request?.version !== 1 || typeof request.callId !== "string" || typeof request.respond !== "function") return;
    const prefix = PREFIXES[request.kind];
    if (!prefix) return;
    let name = names.get(request.callId);
    if (!name) {
      name = `${prefix}${++counts[prefix]}`;
      names.set(request.callId, name);
    }
    request.respond(name);
  });

  return {
    rebuild(ctx: any) {
      names.clear();
      counts.A = counts.G = counts.S = 0;
      for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
        const message = entry?.message;
        const name = message?.details?.agentName;
        const match = typeof name === "string" ? /^(A|G|S)(\d+)$/.exec(name) : undefined;
        if (!match) continue;
        const prefix = match[1] as keyof typeof counts;
        counts[prefix] = Math.max(counts[prefix], Number(match[2]));
        if (typeof message?.toolCallId === "string") names.set(message.toolCallId, name);
      }
    },
    clear() {
      names.clear();
    },
    dispose,
  };
}

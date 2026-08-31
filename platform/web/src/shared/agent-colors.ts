import { agentColorId } from "./format.ts";

export type AgentIdentity = { id: string; threadId?: string };

function stableHue(identity: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 360;
}

export function assignAgentColorHues(
  previous: ReadonlyMap<string, number>,
  agents: AgentIdentity[],
): Map<string, number> {
  const identities = [...new Set(agents.map(agentColorId))];
  const active = new Set(identities);
  const next = new Map([...previous].filter(([identity]) => active.has(identity)));
  const used = new Set(next.values());
  for (const identity of identities) {
    if (next.has(identity)) continue;
    let hue = stableHue(identity);
    while (used.has(hue)) hue = (hue + 137) % 360;
    next.set(identity, hue);
    used.add(hue);
  }
  return next;
}

export function agentColorTokens(hue: number): { color: string; soft: string } {
  return {
    color: `light-dark(hsl(${hue} 72% 40%), hsl(${hue} 76% 70%))`,
    soft: `light-dark(hsl(${hue} 72% 40% / 0.12), hsl(${hue} 76% 70% / 0.15))`,
  };
}

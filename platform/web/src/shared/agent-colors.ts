import { agentColorId } from "./format.ts";

export type AgentIdentity = { id: string; threadId?: string };

export function assignAgentColorSlots(previous: ReadonlyMap<string, number>, agents: AgentIdentity[]): Map<string, number> {
  const identities = [...new Set(agents.map(agentColorId))];
  const active = new Set(identities);
  const next = new Map([...previous].filter(([identity]) => active.has(identity)));
  const used = new Set(next.values());
  for (const identity of identities) {
    if (next.has(identity)) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    next.set(identity, slot);
    used.add(slot);
  }
  return next;
}

export function agentColorTokens(slot: number): { color: string; soft: string } {
  const hue = (slot * 137) % 360;
  return {
    color: `hsl(${hue} 24% 56%)`,
    soft: `hsl(${hue} 24% 56% / 0.15)`,
  };
}

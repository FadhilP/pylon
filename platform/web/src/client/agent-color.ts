import { useRef, type CSSProperties } from "react";
import { agentColorId } from "../shared/format.ts";
import { agentColorTokens, assignAgentColorSlots, type AgentIdentity } from "../shared/agent-colors.ts";

export type AgentColorMap = ReadonlyMap<string, CSSProperties>;

const colorForSlot = (slot: number): CSSProperties => {
  const { color, soft } = agentColorTokens(slot);
  return { "--agent-color": color, "--agent-soft": soft } as CSSProperties;
};

function agentColorMap(slots: ReadonlyMap<string, number>): AgentColorMap {
  return new Map([...slots].map(([identity, slot]) => [identity, colorForSlot(slot)]));
}

export function useAgentColors(sessionId: string | undefined, agents: AgentIdentity[]): AgentColorMap {
  const registry = useRef<{ sessionId?: string; slots: Map<string, number> }>({ slots: new Map() });
  if (registry.current.sessionId !== sessionId) registry.current = { sessionId, slots: new Map() };
  registry.current.slots = assignAgentColorSlots(registry.current.slots, agents);
  return agentColorMap(registry.current.slots);
}

export function agentColor(agent: AgentIdentity, colors: AgentColorMap): CSSProperties {
  return colors.get(agentColorId(agent)) ?? colorForSlot(0);
}

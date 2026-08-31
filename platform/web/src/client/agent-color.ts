import { useRef, type CSSProperties } from "react";
import { agentColorId } from "../shared/format.ts";
import { agentColorTokens, assignAgentColorHues, type AgentIdentity } from "../shared/agent-colors.ts";

export type AgentColorMap = ReadonlyMap<string, CSSProperties>;

const colorForHue = (hue: number): CSSProperties => {
  const { color, soft } = agentColorTokens(hue);
  return { "--agent-color": color, "--agent-soft": soft } as CSSProperties;
};

function agentColorMap(hues: ReadonlyMap<string, number>): AgentColorMap {
  return new Map([...hues].map(([identity, hue]) => [identity, colorForHue(hue)]));
}

export function useAgentColors(sessionId: string | undefined, agents: AgentIdentity[]): AgentColorMap {
  const registry = useRef<{ sessionId?: string; hues: Map<string, number> }>({ hues: new Map() });
  if (registry.current.sessionId !== sessionId) registry.current = { sessionId, hues: new Map() };
  registry.current.hues = assignAgentColorHues(registry.current.hues, agents);
  return agentColorMap(registry.current.hues);
}

export function agentColor(agent: AgentIdentity, colors: AgentColorMap): CSSProperties {
  return colors.get(agentColorId(agent)) ?? colorForHue(0);
}

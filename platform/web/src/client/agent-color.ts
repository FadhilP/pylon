import type { CSSProperties } from "react";

const colors = [
  ["#7089a8", "#7089a826"],
  ["#8c78a8", "#8c78a826"],
  ["#628e82", "#628e8226"],
  ["#9a7866", "#9a786626"],
  ["#8f8260", "#8f826026"],
] as const;

export function agentColor(id: string): CSSProperties {
  let hash = 0;
  for (const character of id) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  const [color, soft] = colors[hash % colors.length]!;
  return { "--agent-color": color, "--agent-soft": soft } as CSSProperties;
}

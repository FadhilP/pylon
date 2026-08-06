import type { DelegatedAgentActivityReadModel } from "./protocol/events.js";

export type PairedAgentActivity = {
  id?: string;
  tool: string;
  input?: string;
  output?: string;
  completed?: boolean;
  failed?: boolean;
};

export function pairAgentActivity(activity: DelegatedAgentActivityReadModel[]): PairedAgentActivity[] {
  const tools: PairedAgentActivity[] = [];
  for (const item of activity) {
    if (item.kind === "call") {
      tools.push({ ...(item.id ? { id: item.id } : {}), tool: item.tool, input: item.text });
      continue;
    }
    const target = item.id
      ? [...tools].reverse().find((tool) => tool.id === item.id && tool.output === undefined)
      : [...tools].reverse().find((tool) => !tool.id && tool.tool === item.tool && tool.output === undefined);
    if (target) {
      target.output = item.text;
      target.completed = true;
      target.failed = item.isError;
    } else {
      tools.push({ ...(item.id ? { id: item.id } : {}), tool: item.tool, output: item.text, completed: true, failed: item.isError });
    }
  }
  return tools;
}

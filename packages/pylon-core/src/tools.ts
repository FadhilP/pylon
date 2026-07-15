export const PROTOCOL_VERSION = 1;

export type ToolPolicy = {
  owner: string;
  managedTools: string[];
  enabledTools: string[];
  allowOnly?: string[];
};
export type ToolPolicyMessage = ToolPolicy & {
  version: typeof PROTOCOL_VERSION;
  kind: "register";
  restoreTools?: string[];
  acknowledge?: () => void;
};
export type ToolUnregisterMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: "unregister";
  owner: string;
};
export type ToolMessage = ToolPolicyMessage | ToolUnregisterMessage;

const validOwner = (value: unknown): value is string =>
  typeof value === "string" && /^pi-[a-z0-9-]+$/.test(value);
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;

export function parseToolMessage(value: unknown):
  | { message: ToolMessage }
  | { error: string } {
  if (!value || typeof value !== "object") return { error: "message must be an object" };
  const input = value as Record<string, unknown>;
  if (input.version !== PROTOCOL_VERSION)
    return { error: `unsupported protocol version: ${String(input.version)}` };
  if (!validOwner(input.owner)) return { error: "invalid owner" };
  if (input.kind === "unregister")
    return { message: { version: PROTOCOL_VERSION, kind: "unregister", owner: input.owner } };
  if (input.kind !== "register") return { error: "invalid message kind" };
  if (!stringList(input.managedTools) || !stringList(input.enabledTools))
    return { error: "tool lists must contain unique non-empty strings" };
  const managedTools = input.managedTools;
  const enabledTools = input.enabledTools;
  if (!enabledTools.every((tool) => managedTools.includes(tool)))
    return { error: "enabledTools must be a subset of managedTools" };
  if (input.allowOnly !== undefined && !stringList(input.allowOnly))
    return { error: "allowOnly must contain unique non-empty strings" };
  if (input.restoreTools !== undefined && !stringList(input.restoreTools))
    return { error: "restoreTools must contain unique non-empty strings" };
  if (input.acknowledge !== undefined && typeof input.acknowledge !== "function")
    return { error: "acknowledge must be a function" };
  return {
    message: {
      version: PROTOCOL_VERSION,
      kind: "register",
      owner: input.owner,
      managedTools: [...managedTools],
      enabledTools: [...enabledTools],
      ...(input.allowOnly ? { allowOnly: [...input.allowOnly] } : {}),
      ...(input.restoreTools ? { restoreTools: [...input.restoreTools] } : {}),
      ...(input.acknowledge ? { acknowledge: input.acknowledge as () => void } : {}),
    },
  };
}

export function reconcileTools(
  baseline: Iterable<string>,
  policies: Iterable<ToolPolicy>,
): string[] {
  const result = new Set(baseline);
  const list = [...policies];
  for (const policy of list)
    for (const tool of policy.enabledTools) result.add(tool);
  for (const policy of list) {
    if (!policy.allowOnly) continue;
    const allowed = new Set(policy.allowOnly);
    for (const tool of result) if (!allowed.has(tool)) result.delete(tool);
  }
  return [...result];
}

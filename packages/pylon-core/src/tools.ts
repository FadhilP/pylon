export const PROTOCOL_VERSION = 1;

export type ToolPolicy = {
  owner: string;
  managedTools: string[];
  enabledTools: string[];
  deferredTools?: string[];
  deferredToolUsage?: Record<string, string>;
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
  typeof value === "string" && (value === "pylon-core" || /^pi-[a-z0-9-]+$/.test(value));
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;

function parseDeferredToolUsage(value: unknown, deferredTools: string[] | undefined):
  | { usage: Record<string, string> }
  | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "deferredToolUsage must be an object" };
  if (!deferredTools) return { error: "deferredToolUsage requires deferredTools" };
  const entries = Object.entries(value);
  if (entries.length > 32) return { error: "deferredToolUsage must contain at most 32 tools" };
  const deferred = new Set(deferredTools);
  const usage: Array<[string, string]> = [];
  for (const [tool, phrase] of entries) {
    if (!deferred.has(tool)) return { error: "deferredToolUsage keys must be deferred tools" };
    if (typeof phrase !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(phrase))
      return { error: "deferredToolUsage phrases must be one-line strings" };
    const normalized = phrase.trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > 120)
      return { error: "deferredToolUsage phrases must contain 1 to 120 characters" };
    usage.push([tool, normalized]);
  }
  return { usage: Object.fromEntries(usage) };
}

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
  if (input.deferredTools !== undefined && !stringList(input.deferredTools))
    return { error: "deferredTools must contain unique non-empty strings" };
  if (input.deferredTools && !input.deferredTools.every((tool) => enabledTools.includes(tool)))
    return { error: "deferredTools must be a subset of enabledTools" };
  let deferredToolUsage: Record<string, string> | undefined;
  if (input.deferredToolUsage !== undefined) {
    const parsedUsage = parseDeferredToolUsage(input.deferredToolUsage, input.deferredTools as string[] | undefined);
    if ("error" in parsedUsage) return parsedUsage;
    deferredToolUsage = parsedUsage.usage;
  }
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
      ...(input.deferredTools ? { deferredTools: [...input.deferredTools] } : {}),
      ...(deferredToolUsage ? { deferredToolUsage } : {}),
      ...(input.allowOnly ? { allowOnly: [...input.allowOnly] } : {}),
      ...(input.restoreTools ? { restoreTools: [...input.restoreTools] } : {}),
      ...(input.acknowledge ? { acknowledge: input.acknowledge as () => void } : {}),
    },
  };
}

export function reconcileTools(
  baseline: Iterable<string>,
  policies: Iterable<ToolPolicy>,
  selectedTools: Iterable<string> = [],
): string[] {
  const result = new Set(baseline);
  const list = [...policies];
  for (const policy of list) {
    const deferred = new Set(policy.deferredTools ?? []);
    for (const tool of policy.enabledTools)
      if (!deferred.has(tool)) result.add(tool);
  }
  for (const tool of selectedTools) result.add(tool);
  for (const policy of list) {
    if (!policy.allowOnly) continue;
    const allowed = new Set(policy.allowOnly);
    for (const tool of result) if (!allowed.has(tool)) result.delete(tool);
  }
  return [...result];
}

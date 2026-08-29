export const PROTOCOL_VERSION = 1;

export type ToolPolicy = {
  owner: string;
  managedTools: string[];
  enabledTools: string[];
  deferredTools?: string[];
  toolUsage?: Record<string, string>;
  /** @deprecated Use toolUsage. */
  deferredToolUsage?: Record<string, string>;
  allowOnly?: string[];
};
export type ToolPolicyMessage = ToolPolicy & {
  version: typeof PROTOCOL_VERSION;
  kind: "register";
  restoreTools?: string[];
  acknowledge?: () => void;
};
export type ToolUnregisterMessage = { version: typeof PROTOCOL_VERSION; kind: "unregister"; owner: string };
export type ToolMessage = ToolPolicyMessage | ToolUnregisterMessage;

const validOwner = (value: unknown): value is string =>
  typeof value === "string" && (value === "pylon-core" || /^pi-[a-z0-9-]+$/.test(value));
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every(item => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;

function parseToolUsage(
  value: unknown,
  allowedTools: string[] | undefined,
  field: "toolUsage" | "deferredToolUsage",
): { usage: Record<string, string> } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${field} must be an object` };
  if (!allowedTools) return { error: `${field} requires ${field === "toolUsage" ? "enabledTools" : "deferredTools"}` };
  const entries = Object.entries(value);
  if (entries.length > 32) return { error: `${field} must contain at most 32 tools` };
  const allowed = new Set(allowedTools);
  const usage: Array<[string, string]> = [];
  for (const [tool, phrase] of entries) {
    if (!allowed.has(tool))
      return { error: `${field} keys must be ${field === "toolUsage" ? "enabled" : "deferred"} tools` };
    if (typeof phrase !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(phrase))
      return { error: `${field} phrases must be one-line strings` };
    const normalized = phrase.trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > 120) return { error: `${field} phrases must contain 1 to 120 characters` };
    usage.push([tool, normalized]);
  }
  return { usage: Object.fromEntries(usage) };
}

export function parseToolMessage(value: unknown): { message: ToolMessage } | { error: string } {
  if (!value || typeof value !== "object") return { error: "message must be an object" };
  const input = value as Record<string, unknown>;
  if (input.version !== PROTOCOL_VERSION) return { error: `unsupported protocol version: ${String(input.version)}` };
  if (!validOwner(input.owner)) return { error: "invalid owner" };
  if (input.kind === "unregister")
    return { message: { version: PROTOCOL_VERSION, kind: "unregister", owner: input.owner } };
  if (input.kind !== "register") return { error: "invalid message kind" };
  if (!stringList(input.managedTools) || !stringList(input.enabledTools))
    return { error: "tool lists must contain unique non-empty strings" };
  const managedTools = input.managedTools;
  const enabledTools = input.enabledTools;
  if (!enabledTools.every(tool => managedTools.includes(tool)))
    return { error: "enabledTools must be a subset of managedTools" };
  if (input.deferredTools !== undefined && !stringList(input.deferredTools))
    return { error: "deferredTools must contain unique non-empty strings" };
  if (input.deferredTools && !input.deferredTools.every(tool => enabledTools.includes(tool)))
    return { error: "deferredTools must be a subset of enabledTools" };
  let toolUsage: Record<string, string> | undefined;
  if (input.toolUsage !== undefined) {
    const parsedUsage = parseToolUsage(input.toolUsage, enabledTools, "toolUsage");
    if ("error" in parsedUsage) return parsedUsage;
    toolUsage = parsedUsage.usage;
  }
  let deferredToolUsage: Record<string, string> | undefined;
  if (input.deferredToolUsage !== undefined) {
    const parsedUsage = parseToolUsage(
      input.deferredToolUsage,
      input.deferredTools as string[] | undefined,
      "deferredToolUsage",
    );
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
      ...(toolUsage ? { toolUsage } : {}),
      ...(deferredToolUsage ? { deferredToolUsage } : {}),
      ...(input.allowOnly ? { allowOnly: [...input.allowOnly] } : {}),
      ...(input.restoreTools ? { restoreTools: [...input.restoreTools] } : {}),
      ...(input.acknowledge ? { acknowledge: input.acknowledge as () => void } : {}),
    },
  };
}

export type ToolOverrideMode = "active" | "deferred" | "disabled";

export type ReconcileOptions = {
  /** Tools the model picked from the discovery catalog for this turn. */
  selectedTools?: Iterable<string>;
  /** Manual per-tool overrides; "active" re-adds a capable tool, any other mode removes it. */
  overrides?: Iterable<readonly [string, ToolOverrideMode]>;
  /** Every tool the runtime could offer; an override can only activate one of these. */
  capable?: ReadonlySet<string>;
};

/**
 * Resolves the active tool set: the baseline, plus every non-deferred policy tool, adjusted by
 * manual overrides and discovery selections, and finally narrowed by any restrictive gate.
 */
export function reconcileTools(
  baseline: Iterable<string>,
  policies: Iterable<ToolPolicy>,
  options: ReconcileOptions = {},
): string[] {
  const result = new Set(baseline);
  const list = [...policies];
  for (const policy of list) {
    const deferred = new Set(policy.deferredTools ?? []);
    for (const tool of policy.enabledTools) if (!deferred.has(tool)) result.add(tool);
  }
  for (const [tool, mode] of options.overrides ?? []) {
    if (mode === "active" && options.capable?.has(tool)) result.add(tool);
    else result.delete(tool);
  }
  for (const tool of options.selectedTools ?? []) result.add(tool);
  for (const policy of list) {
    if (!policy.allowOnly) continue;
    const allowed = new Set(policy.allowOnly);
    for (const tool of result) if (!allowed.has(tool)) result.delete(tool);
  }
  return [...result];
}

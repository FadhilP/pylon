import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseToolMessage,
  reconcileTools,
  type ToolOverrideMode,
  type ToolPolicy,
  type ToolPolicyMessage,
} from "./tools.ts";

const MAX_REJECTED = 10;
const MAX_OVERRIDES = 256;
const MAX_TOOL_NAME = 200;
const MAX_SELECTION = 6;
const OVERRIDE_MODES = ["active", "deferred", "disabled"];

/**
 * Owns the active tool set for a session.
 *
 * Packages register policies over the tools they manage; the baseline is whatever the runtime
 * offered before any policy applied. Every mutation runs through `reconcile`, which recomputes the
 * active set from scratch and rolls the caller's change back if the runtime rejects it.
 */
export function createToolRegistry(pi: ExtensionAPI) {
  const baseline = new Set<string>();
  const managedByOwner = new Map<string, Set<string>>();
  const policies = new Map<string, ToolPolicy>();
  const rejected: string[] = [];
  const selectedTools = new Set<string>();
  const toolOverrides = new Map<string, ToolOverrideMode>();
  let initialized = false;
  let lastError: string | undefined;
  let lastAcknowledgeError: string | undefined;

  const hasGate = () => [...policies.values()].some(policy => policy.allowOnly);
  const managedTools = () => new Set([...managedByOwner.values()].flatMap(tools => [...tools]));
  const capableTools = () => {
    const managed = managedTools();
    const capable = new Set([...policies.values()].flatMap(policy => policy.enabledTools));
    for (const tool of pi.getAllTools?.() ?? []) if (!managed.has(tool.name)) capable.add(tool.name);
    return capable;
  };
  const discoverableTools = () => {
    const capable = capableTools();
    const result = new Set(
      [...policies.values()].flatMap(policy => policy.deferredTools ?? []).filter(tool => capable.has(tool)),
    );
    for (const [tool, mode] of toolOverrides) {
      result.delete(tool);
      if (mode === "deferred" && capable.has(tool)) result.add(tool);
    }
    return result;
  };
  const discoveryCatalog = () => {
    const entries = new Map<string, Set<string>>();
    for (const name of discoverableTools()) entries.set(name, new Set());
    for (const policy of policies.values()) {
      for (const name of policy.enabledTools) {
        const usages = entries.get(name);
        const usage = policy.toolUsage?.[name] ?? policy.deferredToolUsage?.[name];
        if (usages && usage) usages.add(usage);
      }
    }
    return [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, usages]) => ({ name, usage: usages.size === 1 ? [...usages][0] : undefined }));
  };

  /** Records the tools the runtime offers on its own, ignoring policy-managed and overridden ones. */
  const captureBaseline = () => {
    if (initialized && hasGate()) return;
    const managed = managedTools();
    const previous = new Set(baseline);
    baseline.clear();
    for (const tool of pi.getActiveTools()) if (!managed.has(tool) && !toolOverrides.has(tool)) baseline.add(tool);
    for (const tool of previous) if (!managed.has(tool) && toolOverrides.has(tool)) baseline.add(tool);
    initialized = true;
  };

  const reconcile = () => {
    if (!initialized) captureBaseline();
    try {
      const discoverable = discoverableTools();
      const nextSelected = [...selectedTools].filter(tool => discoverable.has(tool));
      pi.setActiveTools(
        reconcileTools(baseline, policies.values(), {
          selectedTools: nextSelected,
          overrides: toolOverrides,
          capable: capableTools(),
        }),
      );
      selectedTools.clear();
      for (const tool of nextSelected) selectedTools.add(tool);
      lastError = undefined;
      return true;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      return false;
    }
  };

  const restoreBaseline = (previous: Set<string>) => {
    baseline.clear();
    for (const tool of previous) baseline.add(tool);
  };

  const unregister = (owner: string) => {
    const previousPolicy = policies.get(owner);
    const previousManaged = managedByOwner.get(owner);
    policies.delete(owner);
    managedByOwner.delete(owner);
    if (reconcile()) return;
    if (previousPolicy) policies.set(owner, previousPolicy);
    if (previousManaged) managedByOwner.set(owner, previousManaged);
  };

  const register = (message: ToolPolicyMessage) => {
    const previousManaged = managedByOwner.get(message.owner) ?? new Set<string>();
    const previousPolicy = policies.get(message.owner);
    const baselineBefore = new Set(baseline);
    managedByOwner.set(message.owner, new Set(message.managedTools));
    if (!initialized || !hasGate()) captureBaseline();

    // Tools this owner no longer manages fall back into the baseline if they are still active.
    const stillManaged = managedTools();
    const active = new Set(pi.getActiveTools());
    for (const tool of previousManaged) if (!stillManaged.has(tool) && active.has(tool)) baseline.add(tool);
    for (const tool of message.managedTools) baseline.delete(tool);

    policies.set(message.owner, {
      owner: message.owner,
      managedTools: [...message.managedTools],
      enabledTools: [...message.enabledTools],
      ...(message.deferredTools ? { deferredTools: [...message.deferredTools] } : {}),
      ...(message.toolUsage ? { toolUsage: { ...message.toolUsage } } : {}),
      ...(message.deferredToolUsage ? { deferredToolUsage: { ...message.deferredToolUsage } } : {}),
      ...(message.allowOnly ? { allowOnly: [...message.allowOnly] } : {}),
    });
    if (message.restoreTools && !hasGate()) {
      const managed = managedTools();
      for (const tool of message.restoreTools) if (!managed.has(tool)) baseline.add(tool);
    }

    if (reconcile()) {
      try {
        message.acknowledge?.();
        lastAcknowledgeError = undefined;
      } catch (error: any) {
        lastAcknowledgeError = error?.message ?? String(error);
      }
      return;
    }
    restoreBaseline(baselineBefore);
    if (previousManaged.size) managedByOwner.set(message.owner, previousManaged);
    else managedByOwner.delete(message.owner);
    if (previousPolicy) policies.set(message.owner, previousPolicy);
    else policies.delete(message.owner);
  };

  const handlePolicy = (value: unknown) => {
    const parsed = parseToolMessage(value);
    if ("error" in parsed) {
      rejected.push(parsed.error);
      if (rejected.length > MAX_REJECTED) rejected.shift();
      return;
    }
    if (parsed.message.kind === "unregister") unregister(parsed.message.owner);
    else register(parsed.message);
  };

  const applyOverrides = (value: any) => {
    if (
      value?.version !== 1 ||
      !value.overrides ||
      typeof value.overrides !== "object" ||
      Array.isArray(value.overrides)
    )
      return;
    const entries = Object.entries(value.overrides);
    if (
      entries.length > MAX_OVERRIDES ||
      entries.some(([tool, mode]) => !tool || tool.length > MAX_TOOL_NAME || !OVERRIDE_MODES.includes(String(mode)))
    )
      return;
    if (!initialized) captureBaseline();
    toolOverrides.clear();
    for (const [tool, mode] of entries) if (tool !== "search_tools") toolOverrides.set(tool, mode as ToolOverrideMode);
    reconcile();
  };

  /** Lets the model narrow the deferred catalog down to a handful of tools for the next turn. */
  const discoveryCapability = {
    eligible: () => [...discoverableTools()].sort(),
    catalog: () => discoveryCatalog(),
    select: (names: string[]) => {
      if (
        !Array.isArray(names) ||
        names.length > MAX_SELECTION ||
        names.some(name => typeof name !== "string" || !name) ||
        new Set(names).size !== names.length
      )
        return { error: `selection must contain at most ${MAX_SELECTION} unique non-empty tool names` };
      const eligible = discoverableTools();
      const unknown = names.filter(name => !eligible.has(name));
      if (unknown.length) return { error: `tools are not eligible: ${unknown.join(", ")}` };
      const previous = [...selectedTools];
      selectedTools.clear();
      for (const name of names) selectedTools.add(name);
      if (!reconcile()) {
        selectedTools.clear();
        for (const name of previous) selectedTools.add(name);
        return { error: lastError ?? "tool reconciliation failed" };
      }
      const active = new Set(pi.getActiveTools());
      return { selected: [...selectedTools], blocked: [...selectedTools].filter(name => !active.has(name)) };
    },
    reset: () => {
      const previous = [...selectedTools];
      selectedTools.clear();
      if (!reconcile()) {
        for (const name of previous) selectedTools.add(name);
        return { error: lastError ?? "tool reconciliation failed" };
      }
      return { selected: [] };
    },
  };

  /** Backs `/pylon tools [status|enable <tool...>|disable <tool...>]`. */
  const manageTools = (args: string, ctx: any) => {
    const [action = "status", ...names] = args.trim().split(/\s+/).filter(Boolean);
    const effective = () => pi.getActiveTools();
    if (action === "status") {
      ctx.ui.notify(
        `Baseline: ${[...baseline].sort().join(", ") || "none"}\nEffective: ${effective().sort().join(", ") || "none"}\nRestrictive gates: ${hasGate() ? "active" : "none"}`,
        "info",
      );
      return;
    }
    if (!["enable", "disable"].includes(action) || !names.length) {
      ctx.ui.notify("Usage: /pylon tools [status|enable <tool...>|disable <tool...>]", "error");
      return;
    }
    const known = new Set((pi.getAllTools?.() ?? effective().map(name => ({ name }))).map((tool: any) => tool.name));
    const unknown = names.filter(name => !known.has(name));
    if (unknown.length) {
      ctx.ui.notify(`Unknown tools: ${unknown.join(", ")}`, "error");
      return;
    }
    const managed = managedTools();
    const policyOwned = names.filter(name => managed.has(name));
    if (policyOwned.length) {
      ctx.ui.notify(`Policy-managed tools cannot be changed manually: ${policyOwned.join(", ")}`, "error");
      return;
    }
    const previous = new Set(baseline);
    for (const name of names)
      if (action === "enable") baseline.add(name);
      else baseline.delete(name);
    if (!reconcile()) {
      restoreBaseline(previous);
      ctx.ui.notify(`Tool update failed: ${lastError}`, "error");
      return;
    }
    const deferred = action === "enable" ? names.filter(name => !effective().includes(name)) : [];
    ctx.ui.notify(
      `${action === "enable" ? "Enabled" : "Disabled"}: ${names.join(", ")}${deferred.length ? `\nDeferred by active gate: ${deferred.join(", ")}` : ""}`,
      deferred.length ? "warning" : "info",
    );
  };

  return {
    baseline,
    policies,
    rejected,
    selectedTools,
    managedTools,
    captureBaseline,
    reconcile,
    handlePolicy,
    applyOverrides,
    discoveryCapability,
    manageTools,
    get lastError() {
      return lastError;
    },
    get lastAcknowledgeError() {
      return lastAcknowledgeError;
    },
    clearSelection() {
      selectedTools.clear();
    },
    clear() {
      selectedTools.clear();
      policies.clear();
      managedByOwner.clear();
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;

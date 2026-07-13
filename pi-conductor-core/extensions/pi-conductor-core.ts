import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseToolMessage,
  reconcileTools,
  type ToolPolicy,
} from "../src/tools.ts";

export default function (pi: ExtensionAPI) {
  const baseline = new Set<string>();
  const managedByOwner = new Map<string, Set<string>>();
  const policies = new Map<string, ToolPolicy>();
  const rejected: string[] = [];
  let initialized = false;
  let lastError: string | undefined;
  let lastAcknowledgeError: string | undefined;
  let guardDiagnostic: string | undefined;

  const hasGate = () => [...policies.values()].some((policy) => policy.allowOnly);
  const managedTools = () =>
    new Set([...managedByOwner.values()].flatMap((tools) => [...tools]));
  const captureBaseline = () => {
    if (initialized && hasGate()) return;
    const managed = managedTools();
    baseline.clear();
    for (const tool of pi.getActiveTools())
      if (!managed.has(tool)) baseline.add(tool);
    initialized = true;
  };
  const reconcile = () => {
    if (!initialized) captureBaseline();
    try {
      pi.setActiveTools(reconcileTools(baseline, policies.values()));
      lastError = undefined;
      return true;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      return false;
    }
  };

  const handlePolicy = (value: unknown) => {
    const parsed = parseToolMessage(value);
    if ("error" in parsed) {
      rejected.push(parsed.error);
      if (rejected.length > 10) rejected.shift();
      return;
    }
    const message = parsed.message;
    if (message.kind === "unregister") {
      const previousPolicy = policies.get(message.owner);
      const previousManaged = managedByOwner.get(message.owner);
      policies.delete(message.owner);
      managedByOwner.delete(message.owner);
      if (!reconcile()) {
        if (previousPolicy) policies.set(message.owner, previousPolicy);
        if (previousManaged) managedByOwner.set(message.owner, previousManaged);
      }
      return;
    }
    const previous = managedByOwner.get(message.owner) ?? new Set<string>(),
      previousPolicy = policies.get(message.owner),
      baselineBefore = new Set(baseline);
    managedByOwner.set(message.owner, new Set(message.managedTools));
    if (!initialized || !hasGate()) captureBaseline();
    const stillManaged = managedTools();
    const active = new Set(pi.getActiveTools());
    for (const tool of previous)
      if (!stillManaged.has(tool) && active.has(tool)) baseline.add(tool);
    for (const tool of message.managedTools) baseline.delete(tool);
    policies.set(message.owner, {
      owner: message.owner,
      managedTools: [...message.managedTools],
      enabledTools: [...message.enabledTools],
      ...(message.allowOnly ? { allowOnly: [...message.allowOnly] } : {}),
    });
    if (reconcile()) {
      try {
        message.acknowledge?.();
        lastAcknowledgeError = undefined;
      } catch (error: any) {
        lastAcknowledgeError = error?.message ?? String(error);
      }
    } else {
      baseline.clear();
      for (const tool of baselineBefore) baseline.add(tool);
      if (previous.size) managedByOwner.set(message.owner, previous);
      else managedByOwner.delete(message.owner);
      if (previousPolicy) policies.set(message.owner, previousPolicy);
      else policies.delete(message.owner);
    }
  };
  const disposePolicyListener = pi.events.on(
    "pi-conductor:tool-policy",
    handlePolicy,
  );
  const disposeGuardListener = pi.events.on("pi-guard:decision", (event: any) => {
    if (event?.version === 1)
      guardDiagnostic = `${event.decision}: ${event.reason} (blocked ${event.blocked}, confirmed ${event.confirmed})`;
  });

  pi.on("session_start", () => {
    captureBaseline();
    reconcile();
  });
  pi.on("session_shutdown", () => {
    disposePolicyListener();
    disposeGuardListener();
    policies.clear();
    managedByOwner.clear();
  });

  pi.registerCommand("conductor", {
    description: "Show coordinated Pi package tool policies and diagnostics",
    handler: async (_args, ctx) => {
      const policyLines = [...policies.values()]
        .sort((a, b) => a.owner.localeCompare(b.owner))
        .map(
          (policy) =>
            `${policy.owner}: enabled [${policy.enabledTools.join(", ")}], managed [${policy.managedTools.join(", ")}]${policy.allowOnly ? `, gate [${policy.allowOnly.join(", ")}]` : ""}`,
        );
      const missing = ["pi-advisor", "pi-scout", "pi-continuity"].filter(
        (owner) => !policies.has(owner),
      );
      const lines = [
        `Baseline: ${[...baseline].join(", ") || "none"}`,
        `Effective: ${pi.getActiveTools().join(", ") || "none"}`,
        ...(policyLines.length ? policyLines : ["Policies: none"]),
        `Known adapters absent or standalone: ${missing.join(", ") || "none"}`,
        `Rejected: ${rejected.length}${rejected.length ? ` (${rejected.at(-1)})` : ""}`,
        `Last reconcile error: ${lastError ?? "none"}`,
        `Last acknowledge error: ${lastAcknowledgeError ?? "none"}`,
        `Guard authority: ${guardDiagnostic ?? "active independently; no decision this session"}`,
      ];
      ctx.ui.notify(
        lines.join("\n"),
        lastError || lastAcknowledgeError || rejected.length ? "warning" : "info",
      );
    },
  });
}

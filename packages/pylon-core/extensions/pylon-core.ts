import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseToolMessage,
  PROTOCOL_VERSION,
  reconcileTools,
  type ToolPolicy,
} from "../src/tools.ts";
import {
  formatTokenMeter,
  meterFromBranch,
  recordTelemetryEvent,
  recordToolResult,
  recordVerificationOutcome,
} from "../src/token-meter.ts";
import {
  createWorktreeSummary,
  WORKTREE_SUMMARY_ENTRY_TYPE,
  worktreeDiff,
  worktreeFingerprint,
  worktreeSnapshot,
  type WorktreeSnapshot,
} from "../src/worktree.ts";

export default function pylonCoreExtension(pi: ExtensionAPI) {
  const baseline = new Set<string>();
  const managedByOwner = new Map<string, Set<string>>();
  const policies = new Map<string, ToolPolicy>();
  const rejected: string[] = [];
  const selectedTools = new Set<string>();
  const toolOverrides = new Map<string, "active" | "deferred" | "disabled">();
  let initialized = false;
  let lastError: string | undefined;
  let lastAcknowledgeError: string | undefined;
  let guardDiagnostic: string | undefined;
  let tokenMeter = meterFromBranch([]);
  let shellBaseline: Promise<string | undefined> | undefined;
  let shellCwd = "";
  let shellToolCallIds: string[] = [];
  let runBaseline: Promise<WorktreeSnapshot | undefined> | undefined;
  let runCwd = "";
  const delegateNames = new Map<string, string>();
  const delegateCounts = { A: 0, G: 0, S: 0 };

  const rebuildDelegateNames = (ctx: any) => {
    delegateNames.clear();
    delegateCounts.A = delegateCounts.G = delegateCounts.S = 0;
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      const message = entry?.message;
      const name = message?.details?.agentName;
      const match = typeof name === "string" ? /^(A|G|S)(\d+)$/.exec(name) : undefined;
      if (!match) continue;
      delegateCounts[match[1] as keyof typeof delegateCounts] = Math.max(
        delegateCounts[match[1] as keyof typeof delegateCounts],
        Number(match[2]),
      );
      if (typeof message?.toolCallId === "string") delegateNames.set(message.toolCallId, name);
    }
  };
  const disposeDelegateNames = pi.events.on("pylon:delegate-name", (request: any) => {
    if (request?.version !== 1 || typeof request.callId !== "string" || typeof request.respond !== "function") return;
    const prefix = request.kind === "advisor" ? "A" : request.kind === "grunt" ? "G"
      : request.kind === "repo_scout" || request.kind === "web_scout" ? "S" : undefined;
    if (!prefix) return;
    let name = delegateNames.get(request.callId);
    if (!name) {
      name = `${prefix}${++delegateCounts[prefix]}`;
      delegateNames.set(request.callId, name);
    }
    request.respond(name);
  });

  const hasGate = () => [...policies.values()].some((policy) => policy.allowOnly);
  const managedTools = () =>
    new Set([...managedByOwner.values()].flatMap((tools) => [...tools]));
  const capableTools = () => {
    const managed = managedTools();
    const capable = new Set([...policies.values()].flatMap((policy) => policy.enabledTools));
    for (const tool of pi.getAllTools?.() ?? []) if (!managed.has(tool.name)) capable.add(tool.name);
    return capable;
  };
  const discoverableTools = () => {
    const capable = capableTools();
    const result = new Set([...policies.values()].flatMap((policy) => policy.deferredTools ?? []).filter((tool) => capable.has(tool)));
    for (const [tool, mode] of toolOverrides) {
      result.delete(tool);
      if (mode === "deferred" && capable.has(tool)) result.add(tool);
    }
    return result;
  };
  const discoveryCatalog = () => {
    const entries = new Map<string, Set<string>>();
    const discoverable = discoverableTools();
    for (const policy of policies.values()) {
      for (const name of policy.deferredTools ?? []) {
        if (!discoverable.has(name)) continue;
        const usages = entries.get(name) ?? new Set<string>();
        const usage = policy.deferredToolUsage?.[name];
        if (usage) usages.add(usage);
        entries.set(name, usages);
      }
    }
    return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, usages]) => ({
      name,
      usage: usages.size === 1 ? [...usages][0] : undefined,
    }));
  };
  const captureBaseline = () => {
    if (initialized && hasGate()) return;
    const managed = managedTools();
    const previous = new Set(baseline);
    baseline.clear();
    for (const tool of pi.getActiveTools())
      if (!managed.has(tool) && !toolOverrides.has(tool)) baseline.add(tool);
    for (const tool of previous)
      if (!managed.has(tool) && toolOverrides.has(tool)) baseline.add(tool);
    initialized = true;
  };
  const reconcile = () => {
    if (!initialized) captureBaseline();
    try {
      const discoverable = discoverableTools();
      const capable = capableTools();
      const nextSelected = [...selectedTools].filter((tool) => discoverable.has(tool));
      const active = new Set(reconcileTools(baseline, policies.values()));
      for (const [tool, mode] of toolOverrides) {
        if (mode === "active" && capable.has(tool)) active.add(tool);
        else active.delete(tool);
      }
      for (const tool of nextSelected) active.add(tool);
      const gates = [...policies.values()].filter((policy) => policy.allowOnly);
      for (const gate of gates) {
        const allowed = new Set(gate.allowOnly);
        for (const tool of active) if (!allowed.has(tool)) active.delete(tool);
      }
      pi.setActiveTools([...active]);
      selectedTools.clear();
      for (const tool of nextSelected) selectedTools.add(tool);
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
      ...(message.deferredTools ? { deferredTools: [...message.deferredTools] } : {}),
      ...(message.deferredToolUsage ? { deferredToolUsage: { ...message.deferredToolUsage } } : {}),
      ...(message.allowOnly ? { allowOnly: [...message.allowOnly] } : {}),
    });
    if (message.restoreTools && !hasGate()) {
      const managed = managedTools();
      for (const tool of message.restoreTools)
        if (!managed.has(tool)) baseline.add(tool);
    }
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
    "pylon:tool-policy",
    handlePolicy,
  );
  const disposeOverrideListener = pi.events.on("pylon:tool-overrides", (value: any) => {
    if (value?.version !== 1 || !value.overrides || typeof value.overrides !== "object" || Array.isArray(value.overrides)) return;
    const entries = Object.entries(value.overrides);
    if (entries.length > 256 || entries.some(([tool, mode]) => !tool || tool.length > 200 || !["active", "deferred", "disabled"].includes(String(mode)))) return;
    if (!initialized) captureBaseline();
    toolOverrides.clear();
    for (const [tool, mode] of entries) if (tool !== "search_tools") toolOverrides.set(tool, mode as "active" | "deferred" | "disabled");
    reconcile();
  });
  const disposeGuardListener = pi.events.on("pi-guard:decision", (event: any) => {
    if (event?.version === 1)
      guardDiagnostic = `${event.decision}: ${event.reason} (blocked ${event.blocked}, confirmed ${event.confirmed})`;
  });
  const discoveryCapability = {
    eligible: () => [...discoverableTools()].sort(),
    catalog: () => discoveryCatalog(),
    select: (names: string[]) => {
      if (!Array.isArray(names) || names.length > 6 || names.some((name) => typeof name !== "string" || !name) || new Set(names).size !== names.length)
        return { error: "selection must contain at most six unique non-empty tool names" };
      const eligible = discoverableTools();
      const unknown = names.filter((name) => !eligible.has(name));
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
      return {
        selected: [...selectedTools],
        blocked: [...selectedTools].filter((name) => !active.has(name)),
      };
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
  const disposeDiscoveryListener = pi.events.on("pylon:tool-discovery", (request: any) => {
    if (request?.version === 1 && typeof request.respond === "function")
      request.respond(discoveryCapability);
  });
  const disposeWorktreeObserverRequest = pi.events.on("pylon:worktree-observer-request", (request: any) => {
    if (request?.version === 1 && typeof request.respond === "function")
      request.respond({ version: 1, owner: "pylon-core" });
  });
  const disposeTelemetryListener = pi.events.on("pylon:telemetry", (value: unknown) => {
    const event = recordTelemetryEvent(tokenMeter, value);
    if (!event) return;
    try { pi.appendEntry?.("pylon-telemetry", event); }
    catch { /* Telemetry must never disrupt model-calling packages. */ }
  });
  const disposeVerifyTelemetry = pi.events.on("pi-verify:result", (value: unknown) => {
    recordVerificationOutcome(tokenMeter, value);
  });

  const collectHealth = async (): Promise<{ lines: string[]; warning: boolean }> => {
    const pending: Promise<unknown>[] = [];
    pi.events.emit("pylon:health-request", {
      version: 1,
      respond(value: unknown | Promise<unknown>) {
        if (pending.length < 20) pending.push(Promise.resolve(value));
      },
    });
    const values = await Promise.all(pending.map((report) => new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 3_000);
      report.then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); resolve(undefined); },
      );
    })));
    const reports: Array<{ owner: string; label: string; lines: string[]; warning: boolean }> = [];
    let warning = false;
    for (const value of values) {
      if (!value || typeof value !== "object") {
        warning = true;
        reports.push({ owner: `invalid-${reports.length}`, label: "Unknown", lines: ["Health reporter failed or timed out"], warning: true });
        continue;
      }
      const report = value as any;
      if (report.version !== 1 || typeof report.owner !== "string" || !/^[a-z0-9-]{1,64}$/.test(report.owner) || typeof report.label !== "string" || !Array.isArray(report.lines) || report.lines.some((line: unknown) => typeof line !== "string")) {
        warning = true;
        reports.push({ owner: `invalid-${reports.length}`, label: "Unknown", lines: ["Invalid health report rejected"], warning: true });
        continue;
      }
      reports.push({ owner: report.owner, label: report.label.slice(0, 80), lines: report.lines.slice(0, 20).map((line: string) => line.replace(/[\r\n]+/g, " ").slice(0, 500)), warning: report.warning === true });
    }
    const counts = new Map<string, number>();
    for (const report of reports) counts.set(report.owner, (counts.get(report.owner) ?? 0) + 1);
    if ([...counts.values()].some((count) => count > 1)) warning = true;
    reports.sort((a, b) => a.owner.localeCompare(b.owner));
    return {
      lines: reports.length
        ? reports.flatMap((report) => [`${report.label}${(counts.get(report.owner) ?? 0) > 1 ? " (duplicate responder)" : ""}:`, ...report.lines.map((line) => `  ${line}`)])
        : ["none reported"],
      warning: warning || reports.some((report) => report.warning),
    };
  };

  const rebuildTokenMeter = (ctx: any) => {
    tokenMeter = meterFromBranch(ctx.sessionManager?.getBranch?.() ?? []);
  };
  pi.on("session_start", (_event, ctx) => {
    selectedTools.clear();
    shellBaseline = undefined;
    shellCwd = "";
    shellToolCallIds = [];
    runBaseline = undefined;
    runCwd = "";
    captureBaseline();
    reconcile();
    rebuildTokenMeter(ctx);
    rebuildDelegateNames(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    rebuildTokenMeter(ctx);
    rebuildDelegateNames(ctx);
  });
  pi.on("agent_start", async (_event, ctx) => {
    runCwd = ctx.cwd;
    runBaseline = worktreeSnapshot(ctx.cwd);
    await runBaseline;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    rebuildTokenMeter(ctx);
    const beforePromise = runBaseline;
    const cwd = runCwd || ctx.cwd;
    runBaseline = undefined;
    runCwd = "";
    if (!beforePromise) return;
    const [before, after] = await Promise.all([beforePromise, worktreeSnapshot(cwd)]);
    const files = before && after ? await worktreeDiff(before, after) : undefined;
    const assistantEntryId = [...(ctx.sessionManager?.getBranch?.() ?? [])]
      .reverse()
      .find((entry: any) => entry?.type === "message" && entry.message?.role === "assistant")
      ?.id;
    const summary = files && typeof assistantEntryId === "string"
      ? createWorktreeSummary(assistantEntryId, files)
      : undefined;
    if (summary?.files.length) {
      try { pi.appendEntry(WORKTREE_SUMMARY_ENTRY_TYPE, summary); }
      catch { /* Summary persistence must not disrupt a completed model turn. */ }
    }
    pi.events.emit("pylon:worktree-summary", {
      version: 1,
      cwd,
      known: Boolean(files),
      assistantEntryId: summary?.assistantEntryId,
      files: summary?.files ?? [],
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    if (!shellBaseline) {
      shellCwd = ctx.cwd;
      shellBaseline = worktreeFingerprint(ctx.cwd);
    }
    shellToolCallIds.push(event.toolCallId);
    await shellBaseline;
  });
  pi.on("tool_result", (event) => recordToolResult(tokenMeter, event));
  pi.on("turn_end", async (_event, ctx) => {
    const beforePromise = shellBaseline;
    if (!beforePromise) return;
    const cwd = shellCwd || ctx.cwd;
    const toolCallIds = shellToolCallIds;
    shellBaseline = undefined;
    shellCwd = "";
    shellToolCallIds = [];
    const [before, after] = await Promise.all([beforePromise, worktreeFingerprint(cwd)]);
    pi.events.emit("pylon:worktree-change", {
      version: 1,
      cwd,
      changed: !before || !after || before !== after,
      known: Boolean(before && after),
      toolCallIds,
    });
  });
  pi.on("session_shutdown", () => {
    disposePolicyListener();
    disposeOverrideListener();
    disposeGuardListener();
    disposeDiscoveryListener();
    disposeWorktreeObserverRequest();
    disposeTelemetryListener();
    disposeVerifyTelemetry();
    disposeDelegateNames();
    shellBaseline = undefined;
    shellCwd = "";
    shellToolCallIds = [];
    runBaseline = undefined;
    runCwd = "";
    selectedTools.clear();
    policies.clear();
    managedByOwner.clear();
    delegateNames.clear();
  });

  const doctor = async (ctx: any) => {
    const apiNames = ["getActiveTools", "setActiveTools", "on", "registerCommand"] as const;
    const missingApi = apiNames.filter((name) => typeof pi[name] !== "function");
    const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    const knownTools = new Set([...baseline, ...managedTools(), ...activeTools]);
    const surfaces = [
      ["Advisor", ["advisor"]],
      ["Continuity", ["continuity_update"]],
      ["Grunt", ["grunt"]],
      ["Heartbeat", ["heartbeat_start", "heartbeat_status", "heartbeat_cancel"]],
      ["Scout", ["rg", "fd", "scout_checkpoint", "repo_scout", "web_scout"]],
      ["Verify", ["verify"]],
    ] as const;
    const surfaceLines = surfaces.map(([name, tools]) => {
      const found = tools.filter((tool) => knownTools.has(tool));
      return `${name}: ${found.length === tools.length ? "registered" : found.length ? `partial (${found.join(", ")})` : "not observed"}`;
    });
    const [major, minor] = process.versions.node.split(".").map(Number);
    const nodeCompatible = major > 22 || (major === 22 && minor >= 18);
    const executables = await Promise.all([
      ["Git", "git", true],
      ["ripgrep", "rg", false],
      ["fd", "fd", false],
    ].map(async ([label, command, required]) => {
      try {
        const result = await pi.exec(command as string, ["--version"], { timeout: 3_000 });
        return { label, required, available: result.code === 0 };
      } catch {
        return { label, required, available: false };
      }
    }));
    const agentDir = getAgentDir();
    let stateStatus = "missing (created on first persisted setting)";
    let stateWarning = false;
    let oldLocks: string[] = [];
    try {
      await access(agentDir, constants.W_OK);
      stateStatus = "writable";
      const continuityDir = join(agentDir, "pi-continuity");
      const entries = await readdir(continuityDir).catch(() => []);
      const now = Date.now();
      oldLocks = (await Promise.all(entries.filter((name) => name.endsWith(".lock")).map(async (name) => {
        const info = await stat(join(continuityDir, name)).catch(() => undefined);
        return info && now - info.mtimeMs > 30_000 ? name : undefined;
      }))).filter((name): name is string => Boolean(name));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        stateStatus = "inaccessible";
        stateWarning = true;
      }
    }
    const quarantined: string[] = [];
    for (const name of ["pi-advisor", "pi-grunt", "pi-scout", "pi-continuity"]) {
      const entries = await readdir(join(agentDir, name), { recursive: true }).catch(() => [] as string[]);
      for (const entry of entries)
        if (entry.includes(".corrupt-") && quarantined.length < 8)
          quarantined.push(join(name, entry));
    }
    const configured: Array<[string, string]> = [];
    let configWarning = false;
    for (const [name, file, select] of [
      ["Advisor", join(agentDir, "pi-advisor", "config.json"), (value: any) => [["Advisor", value.advisorModel]]],
      ["Grunt", join(agentDir, "pi-grunt", "config.json"), (value: any) => [["Grunt", value.model]]],
      ["Scout", join(agentDir, "pi-scout", "config.json"), (value: any) => [["Scout", value.model]]],
      ["Continuity", join(agentDir, "pi-continuity", "config.json"), (value: any) => [["Continuity planner", value.planner?.model], ["Continuity executor", value.executor?.model]]],
    ] as const) {
      try {
        const value = JSON.parse(await readFile(file, "utf8"));
        for (const [label, model] of select(value))
          if (typeof model === "string" && model.trim()) configured.push([label, model]);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          configured.push([name, "<invalid config>"]);
          configWarning = true;
        }
      }
    }
    const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const modelLines = configured.length ? configured.map(([label, reference]) => {
      if (reference === "<invalid config>") return `${label}: invalid config JSON`;
      const slash = reference.indexOf("/");
      const colon = reference.lastIndexOf(":");
      const suffix = reference.slice(colon + 1);
      const idEnd = colon > slash && thinking.has(suffix) ? colon : undefined;
      const provider = slash > 0 ? reference.slice(0, slash) : "";
      const id = slash > 0 ? reference.slice(slash + 1, idEnd) : "";
      const model = provider && id ? ctx.modelRegistry?.find?.(provider, id) : undefined;
      const available = Boolean(model && ctx.modelRegistry?.hasConfiguredAuth?.(model));
      if (!provider || !id) configWarning = true;
      else if (!available) configWarning = true;
      return `${label}: ${reference} (${!provider || !id ? "invalid reference" : !model ? "model unavailable" : available ? "available" : "credentials unavailable"})`;
    }) : ["none configured"];
    const health = await collectHealth();
    return {
      lines: [
        `Node: ${process.versions.node} (${nodeCompatible ? "compatible" : "requires >=22.18.0"})`,
        `Pi API: ${missingApi.length ? `missing ${missingApi.join(", ")}` : "compatible"}`,
        `Policy protocol: v${PROTOCOL_VERSION} (${policies.size} registered, ${rejected.length} rejected)`,
        "Executables:",
        ...executables.map(({ label, required, available }) => `${label}: ${available ? "available" : `missing${required ? "" : " (optional)"}`}`),
        `State root: ${agentDir} (${stateStatus})`,
        `Locks older than 30s: ${oldLocks.join(", ") || "none"}`,
        `Quarantined state: ${quarantined.join(", ") || "none"}`,
        "Configured child models:",
        ...modelLines,
        "Tool surfaces:",
        ...surfaceLines,
        "Package health:",
        ...health.lines,
        "Command-only surfaces (Focus, Guard, Timeline): not observable through ExtensionAPI",
      ],
      warning: !nodeCompatible || missingApi.length > 0 || executables.some((item) => item.required && !item.available) || stateWarning || oldLocks.length > 0 || quarantined.length > 0 || configWarning || health.warning,
    };
  };

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
    if (!(["enable", "disable"] as string[]).includes(action) || !names.length) {
      ctx.ui.notify("Usage: /pylon tools [status|enable <tool...>|disable <tool...>]", "error");
      return;
    }
    const known = new Set(
      (pi.getAllTools?.() ?? effective().map((name) => ({ name })))
        .map((tool: any) => tool.name),
    );
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length) {
      ctx.ui.notify(`Unknown tools: ${unknown.join(", ")}`, "error");
      return;
    }
    const managed = managedTools();
    const policyOwned = names.filter((name) => managed.has(name));
    if (policyOwned.length) {
      ctx.ui.notify(`Policy-managed tools cannot be changed manually: ${policyOwned.join(", ")}`, "error");
      return;
    }
    const previous = new Set(baseline);
    for (const name of names)
      if (action === "enable") baseline.add(name);
      else baseline.delete(name);
    if (!reconcile()) {
      baseline.clear();
      for (const name of previous) baseline.add(name);
      ctx.ui.notify(`Tool update failed: ${lastError}`, "error");
      return;
    }
    const deferred = action === "enable"
      ? names.filter((name) => !effective().includes(name))
      : [];
    ctx.ui.notify(
      `${action === "enable" ? "Enabled" : "Disabled"}: ${names.join(", ")}${deferred.length ? `\nDeferred by active gate: ${deferred.join(", ")}` : ""}`,
      deferred.length ? "warning" : "info",
    );
  };

  pi.registerCommand("tokens", {
    description: "Show estimated payload tokens used by each tool in the current session branch",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatTokenMeter(tokenMeter), "info");
    },
  });

  pi.registerCommand("pylon", {
    description: "Show policies or manage tools with /pylon tools",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "tools" || value.startsWith("tools "))
        return manageTools(value.slice("tools".length), ctx);
      const policyLines = [...policies.values()]
        .sort((a, b) => a.owner.localeCompare(b.owner))
        .map(
          (policy) =>
            `${policy.owner}: enabled [${policy.enabledTools.join(", ")}], deferred [${policy.deferredTools?.join(", ") ?? ""}], managed [${policy.managedTools.join(", ")}]${policy.allowOnly ? `, gate [${policy.allowOnly.join(", ")}]` : ""}`,
        );
      const missing = ["pi-advisor", "pi-scout", "pi-continuity"].filter(
        (owner) => !policies.has(owner),
      );
      const diagnosis = value.toLowerCase() === "doctor" ? await doctor(ctx) : undefined;
      const lines = [
        ...(diagnosis ? ["Pylon doctor", ...diagnosis.lines, ""] : []),
        `Baseline: ${[...baseline].join(", ") || "none"}`,
        `Effective: ${pi.getActiveTools().join(", ") || "none"}`,
        `Discovery selection: ${[...selectedTools].join(", ") || "none"}`,
        ...(policyLines.length ? policyLines : ["Policies: none"]),
        `Known adapters absent or standalone: ${missing.join(", ") || "none"}`,
        `Rejected: ${rejected.length}${rejected.length ? ` (${rejected.at(-1)})` : ""}`,
        `Last reconcile error: ${lastError ?? "none"}`,
        `Last acknowledge error: ${lastAcknowledgeError ?? "none"}`,
        `Guard authority: ${guardDiagnostic ?? "active independently; no decision this session"}`,
      ];
      ctx.ui.notify(
        lines.join("\n"),
        lastError || lastAcknowledgeError || rejected.length || diagnosis?.warning ? "warning" : "info",
      );
    },
  });
}

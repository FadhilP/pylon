import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDelegateNames } from "../src/delegate-names.ts";
import { runDoctor } from "../src/doctor.ts";
import { createLineEditMode } from "../src/line-edit-mode.ts";
import { createTelemetry } from "../src/telemetry.ts";
import { createToolRegistry } from "../src/tool-registry.ts";
import { createWorktreeObserver } from "../src/worktree-observer.ts";

const KNOWN_ADAPTERS = ["pi-advisor", "pi-scout", "pi-continuity"];

export default function pylonCoreExtension(pi: ExtensionAPI) {
  const registry = createToolRegistry(pi);
  const telemetry = createTelemetry(pi);
  const worktree = createWorktreeObserver(pi);
  const delegates = createDelegateNames(pi);
  const lineEdit = createLineEditMode(pi);
  let guardDiagnostic: string | undefined;

  const disposers = [
    telemetry.dispose,
    delegates.dispose,
    pi.events.on("pylon:tool-policy", registry.handlePolicy),
    pi.events.on("pylon:tool-overrides", registry.applyOverrides),
    pi.events.on("pylon:tool-discovery", (request: any) => {
      if (request?.version === 1 && typeof request.respond === "function")
        request.respond(registry.discoveryCapability);
    }),
    pi.events.on("pylon:worktree-observer-request", (request: any) => {
      if (request?.version === 1 && typeof request.respond === "function")
        request.respond({ version: 1, owner: "pylon-core" });
    }),
    pi.events.on("pi-guard:decision", (event: any) => {
      if (event?.version === 1)
        guardDiagnostic = `${event.decision}: ${event.reason} (blocked ${event.blocked}, confirmed ${event.confirmed})`;
    }),
  ];

  pi.on("session_start", async (_event, ctx) => {
    await lineEdit.update(ctx.model, ctx.cwd, true);
    registry.clearSelection();
    worktree.reset();
    registry.captureBaseline();
    registry.reconcile();
    telemetry.rebuild(ctx);
    await delegates.rebuild(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    await lineEdit.update(event.model, ctx.cwd);
  });
  pi.on("session_tree", async (_event, ctx) => {
    telemetry.rebuild(ctx);
    await delegates.rebuild(ctx);
  });
  pi.on("agent_start", (_event, ctx) => worktree.agentStart(ctx));
  pi.on("agent_settled", async (_event, ctx) => {
    telemetry.rebuild(ctx);
    await worktree.agentSettled(ctx);
  });
  pi.on("tool_call", (event, ctx) => worktree.toolCall(event, ctx));
  pi.on("tool_result", event => telemetry.recordToolResult(event));
  pi.on("turn_end", (_event, ctx) => worktree.turnEnd(ctx));
  pi.on("session_shutdown", () => {
    for (const dispose of disposers) dispose();
    worktree.reset();
    registry.clear();
    delegates.clear();
  });

  pi.registerCommand("compact", {
    description: "Compact deterministically; optional instructions guide the configured reviewer",
    handler: async (args, ctx) => {
      await new Promise<void>(resolve => {
        let settled = false;
        const complete = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          const detail = (error instanceof Error ? error.message : error == null ? "" : String(error))
            .trim()
            .slice(0, 1_000);
          ctx.ui.notify(
            `Compaction failed. Reason: ${detail || "no explanation was returned"}. Retry; if it keeps failing, try a different model.`,
            "error",
          );
          resolve();
        };
        try {
          ctx.compact({ customInstructions: args.trim() || undefined, onComplete: complete, onError: fail });
        } catch (error) {
          fail(error);
        }
      });
    },
  });

  pi.registerCommand("tokens", {
    description: "Show estimated payload tokens used by each tool in the current session branch",
    handler: async (_args, ctx) => {
      ctx.ui.notify(telemetry.format(), "info");
    },
  });

  pi.registerCommand("pylon", {
    description: "Show policies or manage tools with /pylon tools",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "tools" || value.startsWith("tools "))
        return registry.manageTools(value.slice("tools".length), ctx);
      const policyLines = [...registry.policies.values()]
        .sort((a, b) => a.owner.localeCompare(b.owner))
        .map(
          policy =>
            `${policy.owner}: enabled [${policy.enabledTools.join(", ")}], deferred [${policy.deferredTools?.join(", ") ?? ""}], managed [${policy.managedTools.join(", ")}]${policy.allowOnly ? `, gate [${policy.allowOnly.join(", ")}]` : ""}`,
        );
      const missing = KNOWN_ADAPTERS.filter(owner => !registry.policies.has(owner));
      const diagnosis =
        value.toLowerCase() === "doctor"
          ? await runDoctor({
              pi,
              ctx,
              registry,
              lineEditMode: lineEdit.mode,
              lineEditConfigError: lineEdit.configError,
            })
          : undefined;
      const lines = [
        ...(diagnosis ? ["Pylon doctor", ...diagnosis.lines, ""] : []),
        `Baseline: ${[...registry.baseline].join(", ") || "none"}`,
        `Effective: ${pi.getActiveTools().join(", ") || "none"}`,
        `Discovery selection: ${[...registry.selectedTools].join(", ") || "none"}`,
        ...(policyLines.length ? policyLines : ["Policies: none"]),
        `Known adapters absent or standalone: ${missing.join(", ") || "none"}`,
        `Rejected: ${registry.rejected.length}${registry.rejected.length ? ` (${registry.rejected.at(-1)})` : ""}`,
        `Last reconcile error: ${registry.lastError ?? "none"}`,
        `Last acknowledge error: ${registry.lastAcknowledgeError ?? "none"}`,
        `Guard authority: ${guardDiagnostic ?? "active independently; no decision this session"}`,
      ];
      ctx.ui.notify(
        lines.join("\n"),
        registry.lastError || registry.lastAcknowledgeError || registry.rejected.length || diagnosis?.warning
          ? "warning"
          : "info",
      );
    },
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_SIEVE_THRESHOLD,
  MIN_SIEVE_THRESHOLD,
  configPath,
  configuredActivePruning,
  configuredThreshold,
  defaultConfig,
  loadConfig,
  saveConfig,
  type SieveConfig,
} from "../src/config.ts";
import {
  ELIGIBLE_TOOL_NAMES,
  READ_TOOL_NAME,
  RECALL_TOOL_NAME,
  RECENT_WINDOW_POLICY,
  SIEVE_THRESHOLD,
  addTransformStats,
  emptyTransformStats,
  sieveMessages,
  type RecoverableActiveResult,
  type TransformStats,
} from "../src/sieve.ts";

type SieveMode = "enabled" | "observe" | "disabled";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const estimatedTokens = (characters: number) => Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);

function statsText(stats: TransformStats, outcomeLabel: string) {
  const { skipped } = stats;
  return [
    `scanned ${stats.scanned}`,
    `${outcomeLabel} ${stats.transformed}`,
    `transform types: age-threshold ${stats.transformedBy.ageThreshold}, budget ${stats.transformedBy.budget}, giant-error ${stats.transformedBy.giantError}, active-threshold ${stats.transformedBy.activeThreshold}`,
    `${outcomeLabel.replace("transformations", "gross omitted")} ~${estimatedTokens(stats.omittedChars)} tokens`,
    `${outcomeLabel.replace("transformations", "net saved")} ~${estimatedTokens(stats.netCharsSaved)} tokens`,
    `skips: recent-window ${skipped.recentWindow}, ineligible-tool ${skipped.ineligibleTool}, error ${skipped.error}, non-text/mixed/empty ${skipped.nonTextMixedOrEmptyContent}, malformed-structured ${skipped.malformedStructuredContent}, at/below-threshold ${skipped.atOrBelowThreshold}, recovery-unavailable ${skipped.recoveryUnavailable}`,
  ].join("; ");
}

function statusText(
  mode: SieveMode,
  threshold: number,
  latestMode: Exclude<SieveMode, "disabled">,
  latestStats: TransformStats,
  cumulativeActual: TransformStats,
  cumulativeProjected: TransformStats,
  activePruning: boolean,
  activeRecalls: number,
  activeRecalledChars: number,
) {
  const cumulative = emptyTransformStats();
  addTransformStats(cumulative, cumulativeActual);
  addTransformStats(cumulative, cumulativeProjected);
  const latestLabel = latestMode === "observe" ? "projected transformations" : "actual transformations";

  return [
    `pi-sieve: ${mode}`,
    `Threshold: > ~${estimatedTokens(threshold)} tokens (${threshold} JS characters; estimated at ${CHARS_PER_ESTIMATED_TOKEN} characters/token)`,
    "Age policy: ages 2–5 base; 6+ half (minimum 1000 characters)",
    `Retained successful-output budget: ${3 * threshold} characters, newest-to-oldest`,
    `Eligible tools: ${ELIGIBLE_TOOL_NAMES.join(", ")}`,
    `Read exclusion: ${READ_TOOL_NAME} is never transformed`,
    `Active-result pruning: ${activePruning ? "enabled" : "disabled"}`,
    `Active recalls: ${activeRecalls}; restored ~${estimatedTokens(activeRecalledChars)} tokens`,
    `Recent-window policy: ${RECENT_WINDOW_POLICY}`,
    `Latest call (${latestMode === "observe" ? "observe projections" : "enabled actual"}): ${statsText(latestStats, latestLabel)}`,
    `Cumulative outcomes: actual transformations ${cumulativeActual.transformed}; actual gross omitted ~${estimatedTokens(cumulativeActual.omittedChars)} tokens; actual net saved ~${estimatedTokens(cumulativeActual.netCharsSaved)} tokens; projected observe transformations ${cumulativeProjected.transformed}; projected observe gross omitted ~${estimatedTokens(cumulativeProjected.omittedChars)} tokens; projected observe net saved ~${estimatedTokens(cumulativeProjected.netCharsSaved)} tokens`,
    `Cumulative classifications: ${statsText(cumulative, "qualifying transformations")}`,
  ].join("\n");
}

export default function sieveExtension(pi: ExtensionAPI, options: { configPath?: string } = {}) {
  let mode: SieveMode = "enabled";
  let threshold = SIEVE_THRESHOLD;
  let latestMode: Exclude<SieveMode, "disabled"> = "enabled";
  let latestStats = emptyTransformStats();
  let cumulativeActual = emptyTransformStats();
  let cumulativeProjected = emptyTransformStats();
  let activePruning = true;
  let activeRecalls = 0;
  let activeRecalledChars = 0;
  let recoverableActiveResults = new Map<string, RecoverableActiveResult>();
  let persistedConfig = defaultConfig();
  const settingsPath = options.configPath ?? configPath();
  const applyConfig = (config: SieveConfig) => {
    persistedConfig = config;
    activePruning = configuredActivePruning(config);
    threshold = configuredThreshold(config);
  };
  let configLoadError: unknown;
  let configQueue: Promise<void> = loadConfig(settingsPath).then(applyConfig).catch((error) => {
    configLoadError = error;
  });
  const updateConfig = async (patch: { activePruning?: boolean; threshold?: number }) => {
    const operation = configQueue.then(async () => {
      if (configLoadError) throw configLoadError;
      const next: SieveConfig = {
        version: 1,
        activePruning: patch.activePruning ?? configuredActivePruning(persistedConfig),
        threshold: patch.threshold ?? configuredThreshold(persistedConfig),
      };
      await saveConfig(next, settingsPath);
      applyConfig(next);
    });
    configQueue = operation.catch(() => {});
    await operation;
  };

  const refreshRecallTool = () => {
    const recallEnabled = activePruning && mode === "enabled";
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-sieve",
      managedTools: [RECALL_TOOL_NAME],
      enabledTools: recallEnabled ? [RECALL_TOOL_NAME] : [],
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter((name) => name !== RECALL_TOOL_NAME);
    if (recallEnabled) active.push(RECALL_TOOL_NAME);
    pi.setActiveTools(active);
  };

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: "Sieve Recall",
    description: "Recover one current-turn tool result omitted by opt-in pi-sieve active pruning.",
    parameters: Type.Object({
      toolCallId: Type.String({ minLength: 1, description: "Exact toolCallId shown in pi-sieve omission marker" }),
    }),
    async execute(_toolCallId, params) {
      const result = activePruning ? recoverableActiveResults.get(params.toolCallId) : undefined;
      if (!result) {
        return {
          content: [{ type: "text" as const, text: `No recoverable active result for toolCallId ${JSON.stringify(params.toolCallId)}.` }],
          details: { found: false, sourceToolCallId: params.toolCallId, sourceToolName: "", sourceIsError: false },
        };
      }
      const sourceChars = result.content.reduce((length, block) => length + block.text.length, 0);
      activeRecalls++;
      activeRecalledChars += sourceChars;
      return {
        content: result.content.map((block) => ({ ...block })),
        details: { found: true, sourceToolCallId: result.toolCallId, sourceToolName: result.toolName, sourceIsError: result.isError },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await configQueue;
    recoverableActiveResults.clear();
    refreshRecallTool();
    if (configLoadError)
      ctx.ui.notify(`Could not load pi-sieve settings: ${(configLoadError as any)?.message ?? String(configLoadError)}`, "error");
  });
  pi.on("input", () => {
    recoverableActiveResults.clear();
  });
  pi.on("session_shutdown", () => {
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-sieve" });
  });

  pi.on("context", (event) => {
    if (mode === "disabled") return;

    const result = sieveMessages(event.messages, threshold, { pruneActive: activePruning });
    latestMode = mode;
    latestStats = result.stats;
    if (mode === "observe") {
      addTransformStats(cumulativeProjected, result.stats);
      // Classify exactly as enabled, but leave Pi's outbound messages unchanged.
      return;
    }

    addTransformStats(cumulativeActual, result.stats);
    for (const recoverable of result.recoverableActiveResults)
      recoverableActiveResults.set(recoverable.toolCallId, recoverable);
    return { messages: result.messages };
  });

  pi.registerCommand("sieve", {
    description: "Configure outbound bulky tool-output limiting, including opt-in active-result pruning and recall",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [action = "status", value] = parts;
      const hasOnlyValue = parts.length === 2;
      const hasNoValue = parts.length === 1;

      if (action === "active" && hasOnlyValue && (value === "enable" || value === "disable")) {
        const nextActivePruning = value === "enable";
        try {
          await updateConfig({ activePruning: nextActivePruning });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve active-result setting: ${error?.message ?? String(error)}`, "error");
          return;
        }
        if (!activePruning) recoverableActiveResults.clear();
        refreshRecallTool();
        ctx.ui.notify(`pi-sieve active-result pruning ${activePruning ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (action === "enable" && hasNoValue) {
        mode = "enabled";
        refreshRecallTool();
        ctx.ui.notify("pi-sieve enabled.", "info");
        return;
      }
      if (action === "observe" && hasNoValue) {
        mode = "observe";
        recoverableActiveResults.clear();
        refreshRecallTool();
        ctx.ui.notify("pi-sieve observing: classifications are reported without changing outbound messages.", "info");
        return;
      }
      if (action === "disable" && hasNoValue) {
        mode = "disabled";
        recoverableActiveResults.clear();
        refreshRecallTool();
        ctx.ui.notify("pi-sieve disabled.", "info");
        return;
      }
      if (action === "reset-stats" && hasNoValue) {
        latestStats = emptyTransformStats();
        cumulativeActual = emptyTransformStats();
        cumulativeProjected = emptyTransformStats();
        activeRecalls = 0;
        activeRecalledChars = 0;
        ctx.ui.notify("pi-sieve statistics reset.", "info");
        return;
      }
      if (action === "threshold" && hasOnlyValue && value === "reset") {
        try {
          await updateConfig({ threshold: SIEVE_THRESHOLD });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve threshold: ${error?.message ?? String(error)}`, "error");
          return;
        }
        ctx.ui.notify(`pi-sieve threshold reset to ${threshold}.`, "info");
        return;
      }
      if (action === "threshold" && hasOnlyValue && typeof value === "string" && /^\d+$/.test(value)) {
        const candidate = Number(value);
        if (
          Number.isSafeInteger(candidate) &&
          candidate >= MIN_SIEVE_THRESHOLD &&
          candidate <= MAX_SIEVE_THRESHOLD
        ) {
          try {
            await updateConfig({ threshold: candidate });
          } catch (error: any) {
            ctx.ui.notify(`Could not save pi-sieve threshold: ${error?.message ?? String(error)}`, "error");
            return;
          }
          ctx.ui.notify(`pi-sieve threshold set to ${threshold}.`, "info");
          return;
        }
        ctx.ui.notify(`Threshold must be an integer from ${MIN_SIEVE_THRESHOLD} to ${MAX_SIEVE_THRESHOLD}.`, "info");
        return;
      }
      if (action === "status" && hasNoValue) {
        ctx.ui.notify(statusText(
          mode,
          threshold,
          latestMode,
          latestStats,
          cumulativeActual,
          cumulativeProjected,
          activePruning,
          activeRecalls,
          activeRecalledChars,
        ), "info");
        return;
      }
      ctx.ui.notify("Usage: /sieve enable|observe|disable|status|active <enable|disable>|threshold <1000-50000|reset>|reset-stats", "info");
    },
  });
}

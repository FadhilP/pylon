import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ELIGIBLE_TOOL_NAMES,
  READ_TOOL_NAME,
  RECENT_WINDOW_POLICY,
  SIEVE_THRESHOLD,
  addTransformStats,
  emptyTransformStats,
  sieveMessages,
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
    `transform types: age-threshold ${stats.transformedBy.ageThreshold}, budget ${stats.transformedBy.budget}, giant-error ${stats.transformedBy.giantError}`,
    `${outcomeLabel.replace("transformations", "gross omitted")} ~${estimatedTokens(stats.omittedChars)} tokens`,
    `${outcomeLabel.replace("transformations", "net saved")} ~${estimatedTokens(stats.netCharsSaved)} tokens`,
    `skips: recent-window ${skipped.recentWindow}, ineligible-tool ${skipped.ineligibleTool}, error ${skipped.error}, non-text/mixed/empty ${skipped.nonTextMixedOrEmptyContent}, at/below-threshold ${skipped.atOrBelowThreshold}`,
  ].join("; ");
}

function statusText(
  mode: SieveMode,
  threshold: number,
  latestMode: Exclude<SieveMode, "disabled">,
  latestStats: TransformStats,
  cumulativeActual: TransformStats,
  cumulativeProjected: TransformStats,
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
    `Recent-window policy: ${RECENT_WINDOW_POLICY}`,
    `Latest call (${latestMode === "observe" ? "observe projections" : "enabled actual"}): ${statsText(latestStats, latestLabel)}`,
    `Cumulative outcomes: actual transformations ${cumulativeActual.transformed}; actual gross omitted ~${estimatedTokens(cumulativeActual.omittedChars)} tokens; actual net saved ~${estimatedTokens(cumulativeActual.netCharsSaved)} tokens; projected observe transformations ${cumulativeProjected.transformed}; projected observe gross omitted ~${estimatedTokens(cumulativeProjected.omittedChars)} tokens; projected observe net saved ~${estimatedTokens(cumulativeProjected.netCharsSaved)} tokens`,
    `Cumulative classifications: ${statsText(cumulative, "qualifying transformations")}`,
  ].join("\n");
}

export default function sieveExtension(pi: ExtensionAPI) {
  let mode: SieveMode = "enabled";
  let threshold = SIEVE_THRESHOLD;
  let latestMode: Exclude<SieveMode, "disabled"> = "enabled";
  let latestStats = emptyTransformStats();
  let cumulativeActual = emptyTransformStats();
  let cumulativeProjected = emptyTransformStats();

  pi.on("context", (event) => {
    if (mode === "disabled") return;

    const result = sieveMessages(event.messages, threshold);
    latestMode = mode;
    latestStats = result.stats;
    if (mode === "observe") {
      addTransformStats(cumulativeProjected, result.stats);
      // Classify exactly as enabled, but leave Pi's outbound messages unchanged.
      return;
    }

    addTransformStats(cumulativeActual, result.stats);
    return { messages: result.messages };
  });

  pi.registerCommand("sieve", {
    description: "Configure outbound bulky tool-output limiting: enable, observe, disable, threshold, reset-stats, or status",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [action = "status", value] = parts;
      const hasOnlyValue = parts.length === 2;
      const hasNoValue = parts.length === 1;

      if (action === "enable" && hasNoValue) {
        mode = "enabled";
        ctx.ui.notify("pi-sieve enabled.", "info");
        return;
      }
      if (action === "observe" && hasNoValue) {
        mode = "observe";
        ctx.ui.notify("pi-sieve observing: classifications are reported without changing outbound messages.", "info");
        return;
      }
      if (action === "disable" && hasNoValue) {
        mode = "disabled";
        ctx.ui.notify("pi-sieve disabled.", "info");
        return;
      }
      if (action === "reset-stats" && hasNoValue) {
        latestStats = emptyTransformStats();
        cumulativeActual = emptyTransformStats();
        cumulativeProjected = emptyTransformStats();
        ctx.ui.notify("pi-sieve statistics reset.", "info");
        return;
      }
      if (action === "threshold" && hasOnlyValue && value === "reset") {
        threshold = SIEVE_THRESHOLD;
        ctx.ui.notify(`pi-sieve threshold reset to ${threshold}.`, "info");
        return;
      }
      if (action === "threshold" && hasOnlyValue && typeof value === "string" && /^\d+$/.test(value)) {
        const candidate = Number(value);
        if (Number.isSafeInteger(candidate) && candidate >= 1_000 && candidate <= 50_000) {
          threshold = candidate;
          ctx.ui.notify(`pi-sieve threshold set to ${threshold}.`, "info");
          return;
        }
        ctx.ui.notify("Threshold must be an integer from 1000 to 50000.", "info");
        return;
      }
      if (action === "status" && hasNoValue) {
        ctx.ui.notify(statusText(mode, threshold, latestMode, latestStats, cumulativeActual, cumulativeProjected), "info");
        return;
      }
      ctx.ui.notify("Usage: /sieve enable|observe|disable|status|threshold <1000-50000|reset>|reset-stats", "info");
    },
  });
}

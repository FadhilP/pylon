import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { composeStatuses, footerRows, plainText, shortWorkspace, type Density } from "../src/layout.ts";

export function ringCompletionBell(
  mode: string,
  write: (text: string) => unknown = text => process.stdout.write(text),
) {
  if (mode === "tui") write("\x07");
}

class FocusEditor extends CustomEditor {
  private readonly label: () => string;

  constructor(tui: any, editorTheme: any, keybindings: any, label: () => string) {
    super(tui, editorTheme, keybindings);
    this.label = label;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!lines.length) return lines;
    const label = truncateToWidth(` ${this.label()} `, width, ""),
      last = lines.length - 1,
      base = truncateToWidth(lines[last]!, Math.max(0, width - visibleWidth(label)), "");
    lines[last] = truncateToWidth(base + label, width, "");
    return lines;
  }
}

const childTools = new Set(["repo_scout", "web_scout", "grunt", "advisor"]);

type UsageTotals = { input: number; output: number; cost: number };

function usageTotals(ctx: any): UsageTotals {
  let input = 0,
    output = 0,
    cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const message = entry.message as AssistantMessage;
      input += message.usage.input;
      output += message.usage.output;
      cost += message.usage.cost.total;
    } else if (entry.message.role === "toolResult" && childTools.has(entry.message.toolName)) {
      const childCost = entry.message.details?.usage?.cost;
      if (typeof childCost === "number") cost += childCost;
    }
  }
  return { input, output, cost };
}

function formatUsage(ctx: any, { input, output, cost }: UsageTotals): string {
  const compact = (value: number) => (value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`);
  const context = ctx.getContextUsage();
  const pressure = context ? ` · ctx ${Math.round(context.percent)}%` : "";
  return `in ${compact(input)} · out ${compact(output)} · $${cost.toFixed(3)}${pressure}`;
}

export function usage(ctx: any): string {
  return formatUsage(ctx, usageTotals(ctx));
}

export default function focusExtension(pi: ExtensionAPI) {
  let enabled = true;
  let density: Density = "compact";
  let completionBell = false;
  let state = "READY";
  type ChildLabel = "SCOUT" | "WEB" | "ADVISOR" | "GRUNT";
  const activeChildren = new Map<string, ChildLabel>();
  const activeChildLabel = () => {
    if (!activeChildren.size) return undefined;
    const labels = [...new Set(activeChildren.values())];
    return labels.length === 1
      ? `${labels[0]}${activeChildren.size > 1 ? ` ×${activeChildren.size}` : ""}`
      : `${activeChildren.size} CHILDREN`;
  };
  const showChildren = (ctx: any) => {
    const label = activeChildLabel();
    if (!label) {
      ctx.ui.setWidget("focus-child", undefined);
      return;
    }
    ctx.ui.setWidget(
      "focus-child",
      (_tui: any, theme: Theme) =>
        new Text(
          theme.fg("customMessageLabel", theme.bold(label)) +
            theme.fg("muted", " · child model active · expand tool row for activity"),
          0,
          0,
        ),
    );
  };
  const clearChildren = (ctx: any) => {
    activeChildren.clear();
    showChildren(ctx);
  };

  const apply = (ctx: any) => {
    if (!enabled || ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui: any, theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        const title = theme.fg("accent", theme.bold("PI"));
        const location = theme.fg("muted", shortWorkspace(ctx.cwd));
        const session = pi.getSessionName() ?? "unnamed session";
        const first = truncateToWidth(`${title}  ${location}  ${theme.fg("dim", session)}`, width);
        if (density === "compact") return [first];
        return [first, truncateToWidth(theme.fg("dim", "focused coding · /ui status"), width)];
      },
    }));

    ctx.ui.setFooter((tui: any, theme: Theme, footerData: any) => {
      let totals = usageTotals(ctx);
      const unsubscribe = footerData.onBranchChange(() => {
        totals = usageTotals(ctx);
        tui.requestRender();
      });
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number) {
          const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean).map(plainText);
          const currentState = activeChildLabel() ?? composeStatuses(statuses, state);
          return footerRows(
            width,
            density,
            shortWorkspace(ctx.cwd),
            footerData.getGitBranch(),
            pi.getSessionName() ?? "unnamed session",
            currentState,
            formatUsage(ctx, totals),
          ).map(line => theme.fg("dim", line));
        },
      };
    });

    ctx.ui.setEditorComponent(
      (tui: any, theme: Theme, keybindings: any) =>
        new FocusEditor(tui, theme, keybindings, () => `${ctx.model?.id ?? "no model"} · ${pi.getThinkingLevel()}`),
    );
    ctx.ui.setWorkingIndicator({
      frames: ["·", "•", "●", "•"].map(frame => ctx.ui.theme.fg("accent", frame)),
      intervalMs: 140,
    });
  };

  const restore = (ctx: any) => {
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWidget("focus-child", undefined);
    ctx.ui.setStatus("focus-state", undefined);
  };

  pi.on("session_start", (_event, ctx) => apply(ctx));
  pi.on("agent_start", (_event, ctx) => {
    state = "WORKING";
    if (enabled) ctx.ui.setStatus("focus-state", undefined);
  });
  pi.on("agent_settled", (_event, ctx) => {
    state = "READY";
    clearChildren(ctx);
    if (enabled) ctx.ui.setStatus("focus-state", undefined);
    if (enabled && completionBell) ringCompletionBell(ctx.mode);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled || !childTools.has(event.toolName)) return;
    const label: ChildLabel =
      event.toolName === "repo_scout"
        ? "SCOUT"
        : event.toolName === "web_scout"
          ? "WEB"
          : event.toolName === "advisor"
            ? "ADVISOR"
            : "GRUNT";
    activeChildren.set(event.toolCallId, label);
    showChildren(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!childTools.has(event.toolName)) return;
    activeChildren.delete(event.toolCallId);
    showChildren(ctx);
  });

  pi.registerCommand("ui", {
    description: "Configure focused TUI density, completion bell, theme, and status",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const usage = "Usage: /ui [status|enable|disable|density <compact|comfortable>|bell <on|off>|theme|help]";
      const action = parts[0] ?? "status";
      const valid =
        (parts.length === 0 && action === "status") ||
        (parts.length === 1 && ["status", "enable", "disable", "theme", "help"].includes(action)) ||
        (parts.length === 2 && action === "density" && ["compact", "comfortable"].includes(parts[1]!)) ||
        (parts.length === 2 && action === "bell" && ["on", "off"].includes(parts[1]!));
      if (!valid) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (action === "help") {
        ctx.ui.notify(usage, "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Focused UI is available only in TUI mode.", "error");
        return;
      }
      if (action === "disable") {
        enabled = false;
        restore(ctx);
        ctx.ui.notify("Focused UI disabled.", "info");
        return;
      }
      if (action === "enable") {
        enabled = true;
        apply(ctx);
        ctx.ui.notify("Focused UI enabled.", "info");
        return;
      }
      if (action === "density") {
        density = parts[1] as Density;
        enabled = true;
        apply(ctx);
        ctx.ui.notify(`UI density: ${density}`, "info");
        return;
      }
      if (action === "bell") {
        completionBell = parts[1] === "on";
        ctx.ui.notify(`Completion bell: ${completionBell ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (action === "theme") {
        const result = ctx.ui.setTheme("focus-dark");
        ctx.ui.notify(
          result.success ? "Theme: focus-dark" : (result.error ?? "Unable to apply focus-dark"),
          result.success ? "info" : "error",
        );
        return;
      }
      ctx.ui.notify(
        `UI: ${enabled ? "enabled" : "disabled"}\nDensity: ${density}\nCompletion bell: ${completionBell ? "enabled" : "disabled"}\nTheme: run /ui theme to apply focus-dark`,
        "info",
      );
    },
  });
}

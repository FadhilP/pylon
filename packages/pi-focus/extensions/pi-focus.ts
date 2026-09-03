import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { footerRows, shortWorkspace, type Density } from "../src/layout.ts";

type FocusState = "READY" | "WORKING" | "BLOCKED" | "COMPACTING";
type ChildLabel = "SCOUT" | "WEB" | "ADVISOR" | "GRUNT";
type ActiveChild = { label: ChildLabel; startedAt: number };

export function ringCompletionBell(
  mode: string,
  write: (text: string) => unknown = text => process.stdout.write(text),
) {
  if (mode === "tui") write("\x07");
}

function thinkingText(theme: Theme, level: string, text: string): string {
  switch (level) {
    case "minimal":
      return theme.fg("thinkingMinimal", text);
    case "low":
      return theme.fg("thinkingLow", text);
    case "medium":
      return theme.fg("thinkingMedium", text);
    case "high":
      return theme.fg("thinkingHigh", text);
    case "xhigh":
      return theme.fg("thinkingXhigh", text);
    case "max":
      return theme.fg("thinkingMax", text);
    default:
      return theme.fg("thinkingOff", text);
  }
}

function stateText(theme: Theme, state: FocusState): string {
  switch (state) {
    case "READY":
      return theme.fg("success", "● READY");
    case "WORKING":
      return theme.fg("borderAccent", "● WORKING");
    case "BLOCKED":
      return theme.fg("warning", "◆ BLOCKED");
    case "COMPACTING":
      return theme.fg("customMessageLabel", "◆ COMPACTING");
  }
}

function childText(theme: Theme, label: ChildLabel, text: string): string {
  switch (label) {
    case "SCOUT":
      return theme.fg("borderAccent", text);
    case "WEB":
      return theme.fg("toolTitle", text);
    case "ADVISOR":
      return theme.fg("customMessageLabel", text);
    case "GRUNT":
      return theme.fg("warning", text);
  }
}

class FocusEditor extends CustomEditor {
  private readonly label: () => string;
  private readonly placeholder: () => string;

  constructor(tui: any, editorTheme: any, keybindings: any, label: () => string, placeholder: () => string) {
    super(tui, editorTheme, keybindings);
    this.label = label;
    this.placeholder = placeholder;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!lines.length) return lines;
    const label = truncateToWidth(` ${this.label()} `, width, ""),
      base = truncateToWidth(lines[0]!, Math.max(0, width - visibleWidth(label)), "");
    lines[0] = truncateToWidth(base + label, width, "");
    if (!this.getText() && lines[1]) {
      const cursor = lines[1].replace(/ +$/, "");
      lines[1] = truncateToWidth(`${cursor}${this.placeholder()}`, width, "");
    }
    return lines;
  }
}

const childTools = new Set(["repo_scout", "web_scout", "grunt", "advisor"]);

type UsageTotals = { input: number; output: number; cost: number };

function usageTotals(ctx: any): UsageTotals {
  let input = 0;
  let output = 0;
  let cost = 0;
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

function formatUsage({ input, output, cost }: UsageTotals): string {
  const compact = (value: number) => (value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1)}k`);
  return `in ${compact(input)} out ${compact(output)} $${cost.toFixed(3)}`;
}

function contextMeter(theme: Theme, percent: number | null, width: number): string {
  const cells = width >= 80 ? 12 : 8;
  const bounded = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent));
  const filled = bounded === null ? 0 : Math.round((bounded / 100) * cells);
  const color = bounded !== null && bounded >= 90 ? "error" : bounded !== null && bounded >= 70 ? "warning" : "accent";
  const label = bounded === null ? " --%" : `${String(Math.round(bounded)).padStart(3)}%`;
  return (
    theme.fg("borderMuted", "▕") +
    theme.fg(color, "█".repeat(filled)) +
    theme.fg("borderMuted", `${"░".repeat(cells - filled)}▏`) +
    theme.fg(color, label)
  );
}

export default function focusExtension(pi: ExtensionAPI) {
  let enabled = true;
  let density: Density = "compact";
  let completionBell = false;
  let baseState: FocusState = "READY";
  let stateBeforeCompaction: FocusState = "READY";
  let requestRender = () => {};
  const activeChildren = new Map<string, ActiveChild>();
  const blockingUi = new Set<string>();
  const currentState = (): FocusState =>
    baseState === "COMPACTING" ? "COMPACTING" : blockingUi.size ? "BLOCKED" : baseState;

  const showChildren = (ctx: any) => {
    if (!activeChildren.size) {
      ctx.ui.setWidget("focus-child", undefined);
      return;
    }
    ctx.ui.setWidget("focus-child", (tui: any, theme: Theme) => {
      const timer = setInterval(() => tui.requestRender(), 1_000);
      return {
        invalidate() {},
        dispose: () => clearInterval(timer),
        render(width: number) {
          const now = Date.now();
          const line = [...activeChildren.values()]
            .map(child => {
              const seconds = Math.max(0, Math.floor((now - child.startedAt) / 1_000));
              return `${childText(theme, child.label, child.label.toLowerCase())} ${theme.fg("dim", `${seconds}s`)}`;
            })
            .join("   ");
          return [truncateToWidth(line, width, "")];
        },
      };
    });
  };
  const clearChildren = (ctx: any) => {
    activeChildren.clear();
    showChildren(ctx);
  };
  const setTitle = (ctx: any) => {
    const session = pi.getSessionName() ?? "unnamed session";
    ctx.ui.setTitle(`π · ${session} · ${shortWorkspace(ctx.cwd)}`);
  };
  const setWorkingIndicator = (ctx: any) => {
    const theme = ctx.ui.theme as Theme;
    const level = pi.getThinkingLevel();
    ctx.ui.setWorkingIndicator({
      frames: ["·", "•", "●", "•"].map(frame => thinkingText(theme, level, frame)),
      intervalMs: 140,
    });
  };

  const apply = (ctx: any) => {
    if (!enabled || ctx.mode !== "tui") return;
    if ((ctx.ui.theme as Theme).name !== "focus-dark") ctx.ui.setTheme("focus-dark");

    setTitle(ctx);
    ctx.ui.setHeader((_tui: any, theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        const first = truncateToWidth(
          `${theme.fg("borderAccent", "π")}  ${theme.fg("muted", shortWorkspace(ctx.cwd))}`,
          width,
          "",
        );
        return density === "compact"
          ? [first]
          : [first, truncateToWidth(theme.fg("dim", "focused coding · /ui status"), width, "")];
      },
    }));

    ctx.ui.setFooter((tui: any, theme: Theme, footerData: any) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose() {
          unsubscribe();
          requestRender = () => {};
        },
        invalidate() {},
        render(width: number) {
          const branch = footerData.getGitBranch();
          const context = ctx.getContextUsage();
          return footerRows(
            width,
            stateText(theme, currentState()),
            theme.fg("muted", pi.getSessionName() ?? "unnamed session"),
            branch ? theme.fg("dim", branch) : null,
            theme.fg("dim", formatUsage(usageTotals(ctx))),
            contextMeter(theme, typeof context?.percent === "number" ? context.percent : null, width),
          );
        },
      };
    });

    ctx.ui.setEditorComponent(
      (tui: any, theme: Theme, keybindings: any) =>
        new FocusEditor(
          tui,
          theme,
          keybindings,
          () => {
            const activeTheme = ctx.ui.theme as Theme;
            const level = pi.getThinkingLevel();
            return `${activeTheme.fg("text", ctx.model?.id ?? "no model")} ${thinkingText(activeTheme, level, level)}`;
          },
          () => (ctx.ui.theme as Theme).fg("dim", "Ask pi to change the project"),
        ),
    );
    setWorkingIndicator(ctx);
  };

  const restore = (ctx: any) => {
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWorkingIndicator();
    ctx.ui.setWidget("focus-child", undefined);
    ctx.ui.setStatus("focus-state", undefined);
    ctx.ui.setTitle(`Pi - ${pi.getSessionName() ?? shortWorkspace(ctx.cwd)} - ${shortWorkspace(ctx.cwd)}`);
  };

  const disposeBlockingUi = pi.events.on("pylon:ui-blocking", (event: any) => {
    if (event?.version !== 1 || typeof event.id !== "string" || typeof event.active !== "boolean") return;
    if (event.active) blockingUi.add(event.id);
    else blockingUi.delete(event.id);
    requestRender();
  });

  pi.on("session_start", (_event, ctx) => {
    baseState = "READY";
    blockingUi.clear();
    apply(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (enabled && ctx.mode === "tui") setTitle(ctx);
    requestRender();
  });
  pi.on("model_select", (_event, ctx) => {
    if (enabled && ctx.mode === "tui") setWorkingIndicator(ctx);
    requestRender();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (enabled && ctx.mode === "tui") setWorkingIndicator(ctx);
    requestRender();
  });
  pi.on("agent_start", () => {
    baseState = "WORKING";
    requestRender();
  });
  pi.on("agent_settled", (_event, ctx) => {
    baseState = "READY";
    clearChildren(ctx);
    requestRender();
    if (enabled && completionBell) ringCompletionBell(ctx.mode);
  });
  pi.on("session_before_compact", () => {
    stateBeforeCompaction = baseState;
    baseState = "COMPACTING";
    requestRender();
  });
  const finishCompaction = (willRetry: boolean) => {
    baseState = willRetry || stateBeforeCompaction === "WORKING" ? "WORKING" : "READY";
    requestRender();
  };
  pi.on("session_compact", event => finishCompaction(event.willRetry));
  pi.on("session_compact_failed", event => finishCompaction(event.willRetry));
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
    activeChildren.set(event.toolCallId, { label, startedAt: Date.now() });
    showChildren(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!childTools.has(event.toolName)) return;
    activeChildren.delete(event.toolCallId);
    if (enabled) showChildren(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearChildren(ctx);
    disposeBlockingUi();
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
        if (result.success) apply(ctx);
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

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  composeStatuses,
  footerRows,
  plainText,
  shortWorkspace,
  type Density,
} from "../src/layout.ts";

export function ringCompletionBell(
  mode: string,
  write: (text: string) => unknown = (text) => process.stdout.write(text),
) {
  if (mode === "tui") write("\x07");
}

class FocusEditor extends CustomEditor {
  private readonly label: () => string;

  constructor(
    tui: any,
    editorTheme: any,
    keybindings: any,
    label: () => string,
  ) {
    super(tui, editorTheme, keybindings);
    this.label = label;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!lines.length) return lines;
    const label = truncateToWidth(` ${this.label()} `, width, ""),
      last = lines.length - 1,
      base = truncateToWidth(
        lines[last]!,
        Math.max(0, width - visibleWidth(label)),
        "",
      );
    lines[last] = truncateToWidth(base + label, width, "");
    return lines;
  }
}

function usage(ctx: any): string {
  let input = 0,
    output = 0,
    cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
    cost += message.usage.cost.total;
  }
  const compact = (value: number) =>
    value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
  const context = ctx.getContextUsage();
  const pressure = context ? ` · ctx ${Math.round(context.percent)}%` : "";
  return `in ${compact(input)} · out ${compact(output)} · $${cost.toFixed(3)}${pressure}`;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let density: Density = "compact";
  let completionBell = false;
  let state = "READY";
  let activeChild: "SCOUT" | "ADVISOR" | undefined;
  const clearChild = (ctx: any) => {
    activeChild = undefined;
    ctx.ui.setWidget("focus-child", undefined);
  };

  const apply = (ctx: any) => {
    if (!enabled || ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui: any, theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        const title = theme.fg("accent", theme.bold("PI"));
        const location = theme.fg("muted", shortWorkspace(ctx.cwd));
        const session = pi.getSessionName() ?? "unnamed session";
        const first = truncateToWidth(
          `${title}  ${location}  ${theme.fg("dim", session)}`,
          width,
        );
        if (density === "compact") return [first];
        return [
          first,
          truncateToWidth(
            theme.fg("dim", "focused coding · /ui status"),
            width,
          ),
        ];
      },
    }));

    ctx.ui.setFooter((tui: any, theme: Theme, footerData: any) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number) {
          const statuses = [...footerData.getExtensionStatuses().values()]
            .filter(Boolean)
            .map(plainText);
          const currentState = activeChild ?? composeStatuses(statuses, state);
          return footerRows(
            width,
            density,
            shortWorkspace(ctx.cwd),
            currentState,
            usage(ctx),
          ).map((line) => theme.fg("dim", line));
        },
      };
    });

    ctx.ui.setEditorComponent(
      (tui: any, theme: Theme, keybindings: any) =>
        new FocusEditor(
          tui,
          theme,
          keybindings,
          () => `${ctx.model?.id ?? "no model"} · ${pi.getThinkingLevel()}`,
        ),
    );
    ctx.ui.setWorkingIndicator({
      frames: ["·", "•", "●", "•"].map((frame) =>
        ctx.ui.theme.fg("accent", frame),
      ),
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
    clearChild(ctx);
    if (enabled) ctx.ui.setStatus("focus-state", undefined);
    if (enabled && completionBell) ringCompletionBell(ctx.mode);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (
      !enabled ||
      (event.toolName !== "repo_scout" && event.toolName !== "advisor")
    )
      return;
    activeChild = event.toolName === "repo_scout" ? "SCOUT" : "ADVISOR";
    ctx.ui.setWidget(
      "focus-child",
      (_tui, theme) =>
        new Text(
          theme.fg("customMessageLabel", theme.bold(activeChild!)) +
            theme.fg(
              "muted",
              " · child model active · expand tool row for activity",
            ),
          0,
          0,
        ),
    );
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName === "repo_scout" || event.toolName === "advisor")
      clearChild(ctx);
  });

  pi.registerCommand("ui", {
    description:
      "Configure focused TUI: enable, disable, compact, comfortable, bell, theme, status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
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
      if (action === "compact" || action === "comfortable") {
        density = action;
        enabled = true;
        apply(ctx);
        ctx.ui.notify(`UI density: ${density}`, "info");
        return;
      }
      if (action === "bell on" || action === "bell off") {
        completionBell = action === "bell on";
        ctx.ui.notify(`Completion bell: ${completionBell ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (action === "theme") {
        const result = ctx.ui.setTheme("focus-dark");
        ctx.ui.notify(
          result.success
            ? "Theme: focus-dark"
            : (result.error ?? "Unable to apply focus-dark"),
          result.success ? "info" : "error",
        );
        return;
      }
      if (action === "status") {
        ctx.ui.notify(
          `UI: ${enabled ? "enabled" : "disabled"}\nDensity: ${density}\nCompletion bell: ${completionBell ? "enabled" : "disabled"}\nTheme: run /ui theme to apply focus-dark`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        "Usage: /ui enable|disable|compact|comfortable|bell on|bell off|theme|status",
        "info",
      );
    },
  });
}

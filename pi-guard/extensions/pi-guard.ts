import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { commandRisk, pathRisk } from "../src/policy.ts";

export default function (pi: ExtensionAPI) {
  let blocked = 0;
  let confirmed = 0;
  const publish = (ctx: any, decision: string, reason: string) => {
    pi.events.emit("pi-guard:decision", {
      version: 1, cwd: ctx.cwd, decision, reason, blocked, confirmed,
    });
    if (ctx.hasUI) ctx.ui.setStatus("pi-guard", `guard: ${decision}`);
  };

  const approve = async (
    ctx: any,
    reason: string,
    detail: string,
  ): Promise<boolean> => {
    if (!ctx.hasUI) {
      publish(ctx, "blocked", reason);
      return false;
    }
    let checkpoint: Promise<unknown> | undefined;
    pi.events.emit("pi-timeline:checkpoint-request", {
      version: 1,
      cwd: ctx.cwd,
      reason,
      respond: (value: Promise<unknown>) => { checkpoint = value; },
    });
    if (checkpoint) await checkpoint.catch(() => undefined);
    const allowed = await ctx.ui.confirm(
      "Pi Guard confirmation",
      `${reason}.\n\n${detail.slice(0, 2000)}\n\nAllow once?`,
    );
    if (allowed) confirmed++;
    publish(ctx, allowed ? "confirmed" : "blocked", reason);
    return allowed;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const risk = commandRisk(event.input.command);
      if (!risk) return;
      if (await approve(ctx, risk, event.input.command)) return;
      blocked++;
      publish(ctx, "blocked", risk);
      return {
        block: true,
        reason: `Pi Guard blocked ${risk}${ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available"}.`,
      };
    }

    if (
      !isToolCallEventType("write", event) &&
      !isToolCallEventType("edit", event)
    ) return;
    const risk = await pathRisk(ctx.cwd, event.input.path);
    if (!risk) return;
    if (risk.action === "confirm" && await approve(ctx, risk.reason, event.input.path))
      return;
    blocked++;
    publish(ctx, "blocked", risk.reason);
    return {
      block: true,
      reason: `Pi Guard blocked ${risk.reason}${risk.action === "confirm" && !ctx.hasUI ? " because no confirmation UI is available" : ""}.`,
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    const risk = commandRisk(event.command);
    if (!risk) return;
    if (await approve(ctx, risk, event.command)) return;
    blocked++;
    publish(ctx, "blocked", risk);
    return {
      result: {
        output: `Pi Guard blocked ${risk}${ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available"}.`,
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    };
  });

  pi.registerCommand("guard", {
    description: "Show Pi Guard status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Pi Guard active. Blocked: ${blocked}. Confirmed once: ${confirmed}.`,
        "info",
      );
    },
  });
}

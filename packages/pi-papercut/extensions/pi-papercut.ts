import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  capturePapercut,
  listPapercuts,
  updatePapercuts,
  type CaptureSource,
  type PapercutStatus,
} from "../src/papercuts.ts";
import { loadProjectState, updateProjectState } from "../src/storage.ts";

const Status = StringEnum(["open", "resolved", "dismissed", "all"] as const);
const Action = StringEnum(["capture", "list", "resolve", "dismiss", "reopen"] as const);

const sourceFor = (ctx: any): CaptureSource => ({
  sessionId: ctx.sessionManager?.getSessionId?.(),
  provider: ctx.model?.provider,
  model: ctx.model?.id,
});
const shortId = (id: string) => id.slice(0, 8);
const recordLine = (record: any) => {
  const seen = record.occurrences > 1 ? ` · seen ${record.occurrences}×` : "";
  const outcome = record.status === "resolved" && record.resolution
    ? `\n  Resolution: ${record.resolution}`
    : record.status === "dismissed" && record.dismissal
      ? `\n  Dismissed: ${record.dismissal}`
      : "";
  return `${shortId(record.id)} · ${record.status}${seen} · ${record.message}${outcome}`;
};
const formatList = (records: any[], status: string) => records.length
  ? `Papercuts (${status}, ${records.length}):\n${records.map(recordLine).join("\n")}`
  : `No ${status === "all" ? "stored" : status} papercuts.`;

export default function papercutExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const managedTools = ["papercut"];

  pi.on("session_start", () => {
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-papercut",
      managedTools,
      enabledTools: managedTools,
    });
  });
  pi.on("session_shutdown", () => {
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-papercut",
    });
  });

  const capture = async (ctx: any, message: string) => {
    const saved = await updateProjectState(agentDir, ctx.cwd, (state) => {
      const captured = capturePapercut(state, message, sourceFor(ctx));
      return { state: captured.state, result: captured };
    });
    return saved.result;
  };

  const list = async (ctx: any, status: PapercutStatus | "all" = "open", limit = 50) => {
    const { state } = await loadProjectState(agentDir, ctx.cwd);
    return listPapercuts(state, status, limit);
  };

  const manage = async (
    ctx: any,
    action: "resolve" | "dismiss" | "reopen",
    ids: string[],
    note?: string,
  ) => {
    const saved = await updateProjectState(agentDir, ctx.cwd, (state) => {
      const updated = updatePapercuts(state, action, ids, note);
      return { state: updated.state, result: updated.records };
    });
    return saved.result;
  };

  pi.registerTool({
    name: "papercut",
    label: "Papercut",
    description: "Capture, list, or update the durable project papercut backlog. Omit action to capture. Supports unique ID prefixes, atomic batches, credential rejection, and bounded output.",
    promptSnippet: "Capture or manage small, actionable project workflow frictions",
    promptGuidelines: [
      "Use papercut immediately when concrete non-blocking friction caused by the repository, tooling, or workflow makes work unnecessarily harder—for example an avoidable retry, undocumented setup step, flaky command, stale cache, misleading error, or non-obvious gotcha. In one or two sentences record what you were doing, what got in the way, and optionally a tentative cause or improvement; then continue the current task. Do not log actual bugs or tracked work, expected failures, user mistakes, generic preferences, speculative ideas, or intentionally repeat known entries; incidental recurrence is deduplicated automatically.",
      "Use papercut to list or update stored papercuts when the user asks to inspect or resolve them. For implementation-related work, mark papercuts resolved only after suitable verification; use dismiss only when the friction should not be fixed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Optional(Action),
      message: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 500,
        description: "For capture: what you were doing → what got in the way; optionally a tentative cause or improvement",
      })),
      status: Type.Optional(Status),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      ids: Type.Optional(Type.Array(Type.String({ minLength: 4, maxLength: 36 }), { minItems: 1, maxItems: 100, uniqueItems: true })),
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Required resolution for resolve; optional reason for dismiss" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "capture";
      if (action === "capture") {
        if (!params.message?.trim()) throw new Error("message is required when capturing a papercut");
        if (params.status !== undefined || params.limit !== undefined || params.ids || params.note)
          throw new Error("status, limit, ids, and note are not valid when capturing a papercut");
        const result = await capture(ctx, params.message);
        return {
          content: [{
            type: "text" as const,
            text: result.duplicate
              ? `Papercut already open: ${shortId(result.record.id)} (seen ${result.record.occurrences}×).`
              : `Papercut captured: ${shortId(result.record.id)}.`,
          }],
          details: { papercut: result.record, duplicate: result.duplicate },
        };
      }
      if (action === "list") {
        if (params.message || params.ids || params.note)
          throw new Error("message, ids, and note are not valid when listing papercuts");
        const status = params.status ?? "open";
        const records = await list(ctx, status, params.limit ?? 50);
        return {
          content: [{ type: "text" as const, text: formatList(records, status) }],
          details: { status, records },
        };
      }
      if (params.message !== undefined || params.status !== undefined || params.limit !== undefined)
        throw new Error("message, status, and limit are not valid when updating papercuts");
      if (!params.ids?.length) throw new Error("ids are required when updating papercuts");
      if (action === "resolve" && !params.note?.trim())
        throw new Error("note is required when resolving papercuts");
      if (action === "reopen" && params.note !== undefined)
        throw new Error("note is not valid when reopening papercuts");
      const records = await manage(ctx, action, params.ids, params.note);
      return {
        content: [{
          type: "text" as const,
          text: `${action === "resolve" ? "Resolved" : action === "dismiss" ? "Dismissed" : "Reopened"} papercut${records.length === 1 ? "" : "s"}: ${records.map((record) => shortId(record.id)).join(", ")}.`,
        }],
        details: { action, records },
      };
    },
  });

  pi.registerCommand("papercuts", {
    description: "List project papercuts: /papercuts [open|resolved|dismissed|all]",
    handler: async (args, ctx) => {
      try {
        const status = (args.trim() || "open") as PapercutStatus | "all";
        if (!["open", "resolved", "dismissed", "all"].includes(status))
          throw new Error("usage: /papercuts [open|resolved|dismissed|all]");
        ctx.ui.notify(formatList(await list(ctx, status), status), "info");
      } catch (error: any) { ctx.ui.notify(error?.message ?? String(error), "error"); }
    },
  });
}

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
const Action = StringEnum(["list", "resolve", "dismiss", "reopen"] as const);

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
  const managedTools = ["papercut", "papercuts"];

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
    description: "Capture one concrete, non-blocking repository, tooling, or workflow friction in one or two sentences. Records private project-scoped state and rejects likely credentials. Output is bounded.",
    promptSnippet: "Record a small, actionable workflow friction without interrupting the current task",
    promptGuidelines: [
      "Use papercut immediately when concrete non-blocking friction caused by the repository, tooling, or workflow makes work unnecessarily harder—for example an avoidable retry, undocumented setup step, flaky command, stale cache, misleading error, or non-obvious gotcha. In one or two sentences record what you were doing, what got in the way, and optionally a tentative cause or improvement; then continue the current task. Do not log actual bugs or tracked work, expected failures, user mistakes, generic preferences, speculative ideas, or intentionally repeat known entries; incidental recurrence is deduplicated automatically.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      message: Type.String({
        minLength: 1,
        maxLength: 500,
        description: "What you were doing → what got in the way; optionally a tentative cause or improvement",
      }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await capture(ctx, params.message);
      const text = result.duplicate
        ? `Papercut already open: ${shortId(result.record.id)} (seen ${result.record.occurrences}×).`
        : `Papercut captured: ${shortId(result.record.id)}.`;
      return {
        content: [{ type: "text" as const, text }],
        details: { papercut: result.record, duplicate: result.duplicate },
      };
    },
  });

  pi.registerTool({
    name: "papercuts",
    label: "Papercuts",
    description: "List or update the durable project papercut backlog. Supports unique ID prefixes, atomic batches, and open/resolved/dismissed lifecycle states. List output is capped at 100 records.",
    promptSnippet: "List, resolve, dismiss, or reopen stored project papercuts",
    promptGuidelines: [
      "Use papercuts when the user asks to inspect or resolve stored papercuts. For implementation-related work, mark papercuts resolved only after suitable verification; use dismiss only when the friction should not be fixed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Action,
      status: Type.Optional(Status),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      ids: Type.Optional(Type.Array(Type.String({ minLength: 4, maxLength: 36 }), { minItems: 1, maxItems: 100, uniqueItems: true })),
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Required resolution for resolve; optional reason for dismiss" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        if (params.ids || params.note) throw new Error("ids and note are not valid when listing papercuts");
        const status = params.status ?? "open";
        const records = await list(ctx, status, params.limit ?? 50);
        return {
          content: [{ type: "text" as const, text: formatList(records, status) }],
          details: { status, records },
        };
      }
      if (params.status !== undefined || params.limit !== undefined)
        throw new Error("status and limit are only valid when listing papercuts");
      if (!params.ids?.length) throw new Error("ids are required when updating papercuts");
      if (params.action === "resolve" && !params.note?.trim())
        throw new Error("note is required when resolving papercuts");
      if (params.action === "reopen" && params.note !== undefined)
        throw new Error("note is not valid when reopening papercuts");
      const records = await manage(ctx, params.action, params.ids, params.note);
      return {
        content: [{
          type: "text" as const,
          text: `${params.action === "resolve" ? "Resolved" : params.action === "dismiss" ? "Dismissed" : "Reopened"} papercut${records.length === 1 ? "" : "s"}: ${records.map((record) => shortId(record.id)).join(", ")}.`,
        }],
        details: { action: params.action, records },
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

  pi.registerCommand("papercut", {
    description: "Capture or update a papercut: /papercut <message>|resolve <id> <resolution>|dismiss <id> [reason]|reopen <id>",
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (!text) throw new Error("usage: /papercut <message>|resolve <id> <resolution>|dismiss <id> [reason]|reopen <id>");
        const match = text.match(/^(resolve|dismiss|reopen)\s+(\S+)(?:\s+([\s\S]+))?$/i);
        if (!match) {
          if (/^(?:resolve|dismiss|reopen)\b/i.test(text))
            throw new Error("usage: /papercut resolve <id> <resolution>|dismiss <id> [reason]|reopen <id>");
          if (/^review\b/i.test(text)) throw new Error("session review is not supported");
          const result = await capture(ctx, text);
          ctx.ui.notify(result.duplicate
            ? `Papercut already open: ${shortId(result.record.id)} (seen ${result.record.occurrences}×).`
            : `Papercut captured: ${shortId(result.record.id)}.`, "info");
          return;
        }
        const action = match[1].toLowerCase() as "resolve" | "dismiss" | "reopen";
        const records = await manage(ctx, action, [match[2]], match[3]);
        ctx.ui.notify(`${action === "resolve" ? "Resolved" : action === "dismiss" ? "Dismissed" : "Reopened"} ${shortId(records[0].id)}.`, "info");
      } catch (error: any) { ctx.ui.notify(error?.message ?? String(error), "error"); }
    },
  });
}

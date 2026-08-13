import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  capturePapercut,
  listPapercuts,
  mutatePapercut,
  PapercutMutationError,
  queryPapercuts,
  updatePapercuts,
  type CaptureSource,
  type PapercutState,
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
  let boundSessionId = "";
  let boundCwd = "";
  let stateRevision = 0;
  let currentState: PapercutState | undefined;

  const counts = (state?: PapercutState) => ({
    open: state?.records.filter((record) => record.status === "open").length ?? 0,
    resolved: state?.records.filter((record) => record.status === "resolved").length ?? 0,
    dismissed: state?.records.filter((record) => record.status === "dismissed").length ?? 0,
    total: state?.records.length ?? 0,
  });
  const stateSnapshot = (available = Boolean(currentState)) => ({
    version: 1,
    sessionId: boundSessionId,
    available,
    revision: stateRevision,
    counts: counts(currentState),
  });
  const adoptState = (state: PapercutState, publish = true, forceRevision = false) => {
    const changed = forceRevision || currentState?.updatedAt !== state.updatedAt;
    currentState = state;
    if (changed) stateRevision++;
    if (publish) pi.events.emit("pi-papercut:state-change", stateSnapshot());
  };

  const disposeStateRequest = pi.events.on("pi-papercut:state-request", (request: any) => {
    if (request?.version !== 1 || request.sessionId !== boundSessionId || typeof request.respond !== "function") return;
    try { request.respond(stateSnapshot()); } catch { /* State observers cannot affect Papercut. */ }
  });
  const disposeListRequest = pi.events.on("pylon:papercut-list-request", (request: any) => {
    if (request?.version !== 1 || request.sessionId !== boundSessionId || typeof request.claim !== "function"
      || typeof request.respond !== "function" || !request.claim()) return;
    request.respond((async () => {
      const status = request.status as PapercutStatus | "all";
      if (!["open", "resolved", "dismissed", "all"].includes(status)
        || typeof request.query !== "string" || request.query.length > 200
        || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000
        || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) {
        throw new Error("invalid papercut list request");
      }
      const { state } = await loadProjectState(agentDir, boundCwd);
      adoptState(state, state.updatedAt !== currentState?.updatedAt);
      const page = queryPapercuts(state, status, request.query, request.offset, request.limit);
      return {
        version: 1,
        sessionId: boundSessionId,
        revision: stateRevision,
        status,
        query: request.query,
        offset: request.offset,
        limit: request.limit,
        total: page.total,
        records: page.records.map(({ source: _source, lastSource: _lastSource, ...record }) => record),
      };
    })());
  });
  const disposeMutationRequest = pi.events.on("pylon:papercut-mutation-request", (request: any) => {
    if (request?.version !== 1 || request.sessionId !== boundSessionId || typeof request.claim !== "function"
      || typeof request.respond !== "function" || !request.claim()) return;
    const sessionId = boundSessionId;
    const cwd = boundCwd;
    request.respond((async () => {
      if (!["edit", "delete"].includes(String(request.action))
        || typeof request.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.id)
        || typeof request.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(request.expectedUpdatedAt))
        || request.action === "edit" && (typeof request.message !== "string" || request.message.length > 500)
        || request.action === "delete" && request.message !== undefined) throw new Error("invalid papercut mutation request");
      try {
        const saved = await updateProjectState(agentDir, cwd, (state) => {
          const mutated = mutatePapercut(state, request.action === "edit"
            ? { action: "edit", id: request.id, expectedUpdatedAt: request.expectedUpdatedAt, message: request.message }
            : { action: "delete", id: request.id, expectedUpdatedAt: request.expectedUpdatedAt });
          return { state: mutated.state, result: undefined };
        });
        if (boundSessionId === sessionId && boundCwd === cwd) adoptState(saved.state, true, true);
        return { version: 1, sessionId, ok: true, revision: stateRevision };
      } catch (error) {
        if (error instanceof PapercutMutationError)
          return { version: 1, sessionId, ok: false, error: error.code };
        throw error;
      }
    })());
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    boundSessionId = sessionId;
    boundCwd = cwd;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-papercut",
      managedTools,
      enabledTools: managedTools,
      deferredTools: managedTools,
      toolUsage: { papercut: "capture or manage durable project workflow-friction notes" },
    });
    try {
      const { state } = await loadProjectState(agentDir, cwd);
      if (boundSessionId === sessionId && boundCwd === cwd) adoptState(state);
    } catch {
      if (boundSessionId !== sessionId || boundCwd !== cwd) return;
      stateRevision++;
      pi.events.emit("pi-papercut:state-change", stateSnapshot(false));
    }
  });
  pi.on("session_shutdown", () => {
    stateRevision++;
    pi.events.emit("pi-papercut:state-change", stateSnapshot(false));
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-papercut",
    });
    disposeStateRequest();
    disposeListRequest();
    disposeMutationRequest();
    boundSessionId = "";
    boundCwd = "";
    currentState = undefined;
  });

  const capture = async (ctx: any, message: string) => {
    const saved = await updateProjectState(agentDir, ctx.cwd, (state) => {
      const captured = capturePapercut(state, message, sourceFor(ctx));
      return { state: captured.state, result: captured };
    });
    if (ctx.sessionManager?.getSessionId?.() === boundSessionId) adoptState(saved.state, true, true);
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
    if (ctx.sessionManager?.getSessionId?.() === boundSessionId) adoptState(saved.state, true, true);
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

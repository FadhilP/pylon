import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  capturePapercut,
  listPapercuts,
  mutatePapercut,
  PapercutMutationError,
  queryPapercuts,
  updatePapercuts,
  type CaptureSource,
  type LifecycleAction,
  type PapercutMutation,
  type PapercutRecord,
  type PapercutState,
  type PapercutStatus,
} from "../src/papercuts.ts";
import { loadProjectState, updateProjectState } from "../src/storage.ts";

const STATUSES = ["open", "resolved", "dismissed", "all"] as const;
const Status = StringEnum(STATUSES);
const Action = StringEnum([
  "capture",
  "list",
  "resolve",
  "dismiss",
  "reopen",
] as const);

const MAX_QUERY_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ListStatus = PapercutStatus | "all";
type ToolAction = "capture" | "list" | LifecycleAction;
type ToolContext = {
  cwd: string;
  model?: { provider?: string; id?: string };
  sessionManager?: { getSessionId?: () => string };
};
type ToolParams = {
  action?: ToolAction;
  message?: string;
  status?: ListStatus;
  limit?: number;
  ids?: string[];
  note?: string;
};

const isListStatus = (value: unknown): value is ListStatus =>
  (STATUSES as readonly unknown[]).includes(value);

// --- Formatting -------------------------------------------------------------

const shortId = (id: string) => id.slice(0, 8);
const outcomeLine = (record: PapercutRecord) => {
  if (record.status === "resolved" && record.resolution)
    return `\n  Resolution: ${record.resolution}`;
  if (record.status === "dismissed" && record.dismissal)
    return `\n  Dismissed: ${record.dismissal}`;
  return "";
};
const recordLine = (record: PapercutRecord) => {
  const seen = record.occurrences > 1 ? ` · seen ${record.occurrences}×` : "";
  return `${shortId(record.id)} · ${record.status}${seen} · ${record.message}${outcomeLine(record)}`;
};
const formatList = (records: PapercutRecord[], status: string) =>
  records.length
    ? `Papercuts (${status}, ${records.length}):\n${records.map(recordLine).join("\n")}`
    : `No ${status === "all" ? "stored" : status} papercuts.`;

// --- Tool parameter rules ---------------------------------------------------

const FIELD_RULES: Record<
  ToolAction,
  { allowed: readonly string[]; whileDoing: string }
> = {
  capture: { allowed: ["message"], whileDoing: "capturing a papercut" },
  list: { allowed: ["status", "limit"], whileDoing: "listing papercuts" },
  resolve: { allowed: ["ids", "note"], whileDoing: "updating papercuts" },
  dismiss: { allowed: ["ids", "note"], whileDoing: "updating papercuts" },
  reopen: { allowed: ["ids"], whileDoing: "updating papercuts" },
};

function assertOnlyAllowedFields(action: ToolAction, params: ToolParams) {
  const { allowed, whileDoing } = FIELD_RULES[action];
  const extra = Object.keys(params).filter(
    (key) =>
      key !== "action" &&
      params[key as keyof ToolParams] !== undefined &&
      !allowed.includes(key),
  );
  if (extra.length)
    throw new Error(
      `${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not valid when ${whileDoing}`,
    );
}

// --- Pylon request parsing --------------------------------------------------

function parseListRequest(request: any) {
  const invalid = () => new Error("invalid papercut list request");
  const inRange = (value: unknown, min: number, max: number) =>
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max;
  if (!isListStatus(request.status)) throw invalid();
  if (
    typeof request.query !== "string" ||
    request.query.length > MAX_QUERY_LENGTH
  )
    throw invalid();
  if (!inRange(request.offset, 0, 1_000)) throw invalid();
  if (!inRange(request.limit, 1, 50)) throw invalid();
  return {
    status: request.status,
    query: request.query as string,
    offset: request.offset as number,
    limit: request.limit as number,
  };
}

function parseMutationRequest(request: any): PapercutMutation {
  const invalid = () => new Error("invalid papercut mutation request");
  const { action, id, expectedUpdatedAt, message } = request;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw invalid();
  if (
    typeof expectedUpdatedAt !== "string" ||
    Number.isNaN(Date.parse(expectedUpdatedAt))
  )
    throw invalid();
  if (action === "delete") {
    if (message !== undefined) throw invalid();
    return { action: "delete", id, expectedUpdatedAt };
  }
  if (
    action !== "edit" ||
    typeof message !== "string" ||
    message.length > MAX_MESSAGE_LENGTH
  )
    throw invalid();
  return { action: "edit", id, expectedUpdatedAt, message };
}

export default function papercutExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const managedTools = ["papercut"];
  let boundSessionId = "";
  let boundCwd = "";
  let stateRevision = 0;
  let currentState: PapercutState | undefined;

  // --- Published state snapshot ---------------------------------------------

  const counts = (state?: PapercutState) => ({
    open:
      state?.records.filter((record) => record.status === "open").length ?? 0,
    resolved:
      state?.records.filter((record) => record.status === "resolved").length ??
      0,
    dismissed:
      state?.records.filter((record) => record.status === "dismissed").length ??
      0,
    total: state?.records.length ?? 0,
  });
  const stateSnapshot = (available = Boolean(currentState)) => ({
    version: 1,
    sessionId: boundSessionId,
    available,
    revision: stateRevision,
    counts: counts(currentState),
  });
  const adoptState = (
    state: PapercutState,
    publish = true,
    forceRevision = false,
  ) => {
    const changed =
      forceRevision || currentState?.updatedAt !== state.updatedAt;
    currentState = state;
    if (changed) stateRevision++;
    if (publish) pi.events.emit("pi-papercut:state-change", stateSnapshot());
  };

  // --- Request guards -------------------------------------------------------

  const isForBoundSession = (request: any) =>
    Boolean(request) &&
    request.version === 1 &&
    request.sessionId === boundSessionId;
  const canRespond = (request: any) => typeof request.respond === "function";
  const claims = (request: any) =>
    typeof request.claim === "function" && request.claim();

  // --- Store access ---------------------------------------------------------

  const sourceFor = (ctx: ToolContext): CaptureSource => ({
    sessionId: ctx.sessionManager?.getSessionId?.(),
    provider: ctx.model?.provider,
    model: ctx.model?.id,
  });
  const isBoundSession = (ctx: ToolContext) =>
    ctx.sessionManager?.getSessionId?.() === boundSessionId;

  const capture = async (ctx: ToolContext, message: string) => {
    const saved = await updateProjectState(agentDir, ctx.cwd, (state) => {
      const captured = capturePapercut(state, message, sourceFor(ctx));
      return { state: captured.state, result: captured };
    });
    if (isBoundSession(ctx)) adoptState(saved.state, true, true);
    return saved.result;
  };
  const list = async (
    ctx: { cwd: string },
    status: ListStatus = "open",
    limit = 50,
  ) => {
    const { state } = await loadProjectState(agentDir, ctx.cwd);
    return listPapercuts(state, status, limit);
  };
  const runLifecycle = async (
    ctx: ToolContext,
    action: LifecycleAction,
    ids: string[],
    note?: string,
  ) => {
    const saved = await updateProjectState(agentDir, ctx.cwd, (state) => {
      const updated = updatePapercuts(state, action, ids, note);
      return { state: updated.state, result: updated.records };
    });
    if (isBoundSession(ctx)) adoptState(saved.state, true, true);
    return saved.result;
  };

  // --- Pylon request handlers -----------------------------------------------

  const runListRequest = async (request: any) => {
    const { status, query, offset, limit } = parseListRequest(request);
    const { state } = await loadProjectState(agentDir, boundCwd);
    adoptState(state, state.updatedAt !== currentState?.updatedAt);
    const page = queryPapercuts(state, status, query, offset, limit);
    return {
      version: 1,
      sessionId: boundSessionId,
      revision: stateRevision,
      status,
      query,
      offset,
      limit,
      total: page.total,
      records: page.records.map(
        ({ source: _source, lastSource: _lastSource, ...record }) => record,
      ),
    };
  };

  const runMutationRequest = async (
    request: any,
    sessionId: string,
    cwd: string,
  ) => {
    const mutation = parseMutationRequest(request);
    try {
      const saved = await updateProjectState(agentDir, cwd, (state) => ({
        state: mutatePapercut(state, mutation).state,
        result: undefined,
      }));
      if (boundSessionId === sessionId && boundCwd === cwd)
        adoptState(saved.state, true, true);
      return { version: 1, sessionId, ok: true, revision: stateRevision };
    } catch (error) {
      if (error instanceof PapercutMutationError)
        return { version: 1, sessionId, ok: false, error: error.code };
      throw error;
    }
  };

  const disposeStateRequest = pi.events.on(
    "pi-papercut:state-request",
    (request: any) => {
      if (!isForBoundSession(request) || !canRespond(request)) return;
      try {
        request.respond(stateSnapshot());
      } catch {
        /* State observers cannot affect Papercut. */
      }
    },
  );
  const disposeListRequest = pi.events.on(
    "pylon:papercut-list-request",
    (request: any) => {
      if (
        !isForBoundSession(request) ||
        !canRespond(request) ||
        !claims(request)
      )
        return;
      request.respond(runListRequest(request));
    },
  );
  const disposeMutationRequest = pi.events.on(
    "pylon:papercut-mutation-request",
    (request: any) => {
      if (
        !isForBoundSession(request) ||
        !canRespond(request) ||
        !claims(request)
      )
        return;
      request.respond(runMutationRequest(request, boundSessionId, boundCwd));
    },
  );

  // --- Session lifecycle ----------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    boundSessionId = sessionId;
    boundCwd = cwd;
    const stillBound = () => boundSessionId === sessionId && boundCwd === cwd;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-papercut",
      managedTools,
      enabledTools: managedTools,
      deferredTools: [],
      toolUsage: {
        papercut: "capture or manage durable project workflow-friction notes",
      },
    });
    try {
      const { state } = await loadProjectState(agentDir, cwd);
      if (stillBound()) adoptState(state);
    } catch {
      if (!stillBound()) return;
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

  // --- Tool actions ---------------------------------------------------------

  const captureAction = async (ctx: ToolContext, params: ToolParams) => {
    if (!params.message?.trim())
      throw new Error("message is required when capturing a papercut");
    const result = await capture(ctx, params.message);
    const text = result.duplicate
      ? `Papercut already open: ${shortId(result.record.id)} (seen ${result.record.occurrences}×).`
      : `Papercut captured: ${shortId(result.record.id)}.`;
    return {
      content: [{ type: "text" as const, text }],
      details: { papercut: result.record, duplicate: result.duplicate },
    };
  };

  const listAction = async (ctx: ToolContext, params: ToolParams) => {
    const status = params.status ?? "open";
    const records = await list(ctx, status, params.limit ?? 50);
    return {
      content: [{ type: "text" as const, text: formatList(records, status) }],
      details: { status, records },
    };
  };

  const LIFECYCLE_VERB: Record<LifecycleAction, string> = {
    resolve: "Resolved",
    dismiss: "Dismissed",
    reopen: "Reopened",
  };

  const lifecycleAction = async (
    ctx: ToolContext,
    action: LifecycleAction,
    params: ToolParams,
  ) => {
    if (!params.ids?.length)
      throw new Error("ids are required when updating papercuts");
    if (action === "resolve" && !params.note?.trim())
      throw new Error("note is required when resolving papercuts");
    const records = await runLifecycle(ctx, action, params.ids, params.note);
    const plural = records.length === 1 ? "" : "s";
    const ids = records.map((record) => shortId(record.id)).join(", ");
    return {
      content: [
        {
          type: "text" as const,
          text: `${LIFECYCLE_VERB[action]} papercut${plural}: ${ids}.`,
        },
      ],
      details: { action, records },
    };
  };

  pi.registerTool({
    name: "papercut",
    label: "Papercut",
    description:
      "Capture, list, or update the durable project papercut backlog. Omit action to capture. Supports unique ID prefixes, atomic batches, credential rejection, and bounded output.",
    promptSnippet:
      "Capture or manage small, actionable project workflow frictions",
    promptGuidelines: [
      "Use papercut immediately when concrete non-blocking friction caused by the repository, tooling, or workflow makes work unnecessarily harder—for example an avoidable retry, undocumented setup step, flaky command, stale cache, misleading error, or non-obvious gotcha. In one or two sentences record what you were doing, what got in the way, and optionally a tentative cause or improvement; then continue the current task. Do not log actual bugs or tracked work, expected failures, user mistakes, generic preferences, speculative ideas, or intentionally repeat known entries; incidental recurrence is deduplicated automatically.",
      "Use papercut to list or update stored papercuts when the user asks to inspect or resolve them. For implementation-related work, mark papercuts resolved only after suitable verification; use dismiss only when the friction should not be fixed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object(
      {
        action: Type.Optional(Action),
        message: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 500,
            description:
              "For capture: what you were doing → what got in the way; optionally a tentative cause or improvement",
          }),
        ),
        status: Type.Optional(Status),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        ids: Type.Optional(
          Type.Array(Type.String({ minLength: 4, maxLength: 36 }), {
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
          }),
        ),
        note: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 500,
            description:
              "Required resolution for resolve; optional reason for dismiss",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as ToolParams;
      const action = params.action ?? "capture";
      assertOnlyAllowedFields(action, params);
      if (action === "capture")
        return captureAction(ctx as ToolContext, params);
      if (action === "list") return listAction(ctx as ToolContext, params);
      return lifecycleAction(ctx as ToolContext, action, params);
    },
  });

  pi.registerCommand("papercuts", {
    description:
      "List project papercuts: /papercuts [open|resolved|dismissed|all]",
    handler: async (args, ctx) => {
      try {
        const status = args.trim() || "open";
        if (!isListStatus(status))
          throw new Error("usage: /papercuts [open|resolved|dismissed|all]");
        ctx.ui.notify(formatList(await list(ctx, status), status), "info");
      } catch (error: any) {
        ctx.ui.notify(error?.message ?? String(error), "error");
      }
    },
  });
}

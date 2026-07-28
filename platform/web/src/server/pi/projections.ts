import type { ConversationReadModel, DelegatedAgentActivityReadModel, DelegatedAgentKind, DelegatedAgentRunReadModel, DelegatedAgentUsageReadModel, MessageReadModel, ToolActivityReadModel, UiNotificationReadModel, UiRequestReadModel, UiStatusReadModel, UiWidgetReadModel } from "../../shared/protocol/events.ts";
import type { RuntimeSnapshot } from "../../shared/protocol/snapshots.ts";
import type { ConversationTurnIndexItem } from "../../shared/protocol/snapshots.ts";
import type { DriverEvent } from "./pi-driver.ts";
import { cloneOperational } from "./operational-projections.ts";
import { PROMPT_FILES_CUSTOM_TYPE } from "./prompt-attachments.ts";

const MAX_TEXT = 60 * 1024;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 100;
const MAX_DELEGATED_RUNS = 100;
const MAX_PAYLOAD_TEXT = 8 * 1024;
const MAX_AGENT_ACTIVITY_TEXT = 2_000;
const delegatedAgentKinds = new Set<DelegatedAgentKind>(["advisor", "grunt", "repo_scout", "web_scout"]);

export const HISTORY_PAGE_SIZE = MAX_MESSAGES;

export function encodeHistoryCursor(index: number): string {
  return Buffer.from(`h:${Math.max(0, Math.floor(index))}`).toString("base64url");
}

export function decodeHistoryCursor(cursor: string): number | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^h:\d+$/.test(decoded) || encodeHistoryCursor(Number(decoded.slice(2))) !== cursor) return undefined;
    const index = Number(decoded.slice(2));
    return Number.isSafeInteger(index) ? index : undefined;
  } catch {
    return undefined;
  }
}

export function encodeTurnIndexCursor(index: number): string {
  return Buffer.from(`t:${Math.max(0, Math.floor(index))}`).toString("base64url");
}

export function decodeTurnIndexCursor(cursor: string): number | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^t:\d+$/.test(decoded) || encodeTurnIndexCursor(Number(decoded.slice(2))) !== cursor) return undefined;
    const index = Number(decoded.slice(2));
    return Number.isSafeInteger(index) ? index : undefined;
  } catch {
    return undefined;
  }
}

type Publish = (type: string, payload: unknown) => void;

function text(value: unknown, maximum = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}
function createdAt(value: unknown): string | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function id(value: unknown, fallback: string): string { return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : fallback; }
function role(value: unknown): MessageReadModel["role"] {
  if (value === "toolResult" || value === "tool") return "tool";
  if (value === "assistant") return "assistant";
  if (value === "system" || value === "custom") return "system";
  return "user";
}
function thinkingLevel(value: unknown): MessageReadModel["thinkingLevel"] {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
    ? value as MessageReadModel["thinkingLevel"]
    : undefined;
}
function attachmentCount(value: unknown): number | undefined {
  const content = object(value).content;
  if (!Array.isArray(content)) return undefined;
  const count = content.filter((part) => object(part).type === "image").length;
  return count > 0 ? Math.min(4, count) : undefined;
}
function promptFileCount(value: unknown): number | undefined {
  const raw = object(value);
  if (raw.customType !== PROMPT_FILES_CUSTOM_TYPE) return undefined;
  const files = object(raw.details).files;
  return Array.isArray(files) && files.length > 0 ? Math.min(100, files.length) : undefined;
}
function messageText(value: unknown): string {
  const raw = object(value);
  if (typeof raw.content === "string") return text(raw.content);
  if (!Array.isArray(raw.content)) return text(raw.text);
  return raw.content.flatMap((part) => {
    const item = object(part);
    return typeof item.text === "string" ? [item.text] : [];
  }).join("").slice(0, MAX_TEXT);
}

function latestMessages(messages: MessageReadModel[]): MessageReadModel[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  const tail = messages.slice(-(MAX_MESSAGES - 1));
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser || tail.includes(latestUser)) return messages.slice(-MAX_MESSAGES);
  const userIndex = messages.indexOf(latestUser);
  const insertion = tail.findIndex((message) => messages.indexOf(message) > userIndex);
  tail.splice(insertion < 0 ? tail.length : insertion, 0, latestUser);
  return tail;
}

function trimMessages(messages: Map<string, MessageReadModel>): void {
  if (messages.size <= MAX_MESSAGES) return;
  const latestUser = [...messages.values()].reverse().find((message) => message.role === "user");
  for (const [key, message] of messages) {
    if (messages.size <= MAX_MESSAGES) break;
    if (message === latestUser) continue;
    messages.delete(key);
  }
}
function boundedLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  let remaining = 8 * 1024;
  for (const line of value.slice(0, 40)) {
    const item = text(line, Math.min(500, remaining));
    result.push(item);
    remaining -= item.length;
    if (remaining <= 0) break;
  }
  return result;
}
export function browserValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MAX_PAYLOAD_TEXT);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => browserValue(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50)
    .filter(([key]) => !/token|secret|authorization|password/i.test(key))
    .map(([key, item]) => [key.slice(0, 100), browserValue(item, depth + 1)]));
  return undefined;
}

function delegatedAgentKind(value: unknown): DelegatedAgentKind | undefined {
  return delegatedAgentKinds.has(value as DelegatedAgentKind) ? value as DelegatedAgentKind : undefined;
}

function boundedNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maximum, value)
    : undefined;
}

function delegatedUsage(value: unknown): DelegatedAgentUsageReadModel | undefined {
  const raw = object(value);
  const input = boundedNumber(raw.input);
  const output = boundedNumber(raw.output);
  const cacheRead = boundedNumber(raw.cacheRead);
  const cacheWrite = boundedNumber(raw.cacheWrite);
  const cost = boundedNumber(raw.cost, 1_000_000_000);
  if ([input, output, cacheRead, cacheWrite, cost].some((item) => item === undefined)) return undefined;
  return { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite!, cost: cost! };
}

function delegatedActivity(value: unknown): DelegatedAgentActivityReadModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: DelegatedAgentActivityReadModel[] = [];
  for (const rawValue of value.slice(0, 100)) {
    const raw = object(rawValue);
    if (raw.kind !== "call" && raw.kind !== "result") continue;
    const tool = text(raw.tool, 200);
    if (!tool) continue;
    let activityText = text(raw.text, MAX_AGENT_ACTIVITY_TEXT);
    if (activityText) {
      try { activityText = browserJson(JSON.parse(activityText))?.slice(0, MAX_AGENT_ACTIVITY_TEXT) ?? activityText; }
      catch { /* Non-JSON tool input remains bounded plain text. */ }
      activityText = activityText
        .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
        .replace(/\b((?:api[_-]?key|token|secret|password|cookie)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>");
    }
    result.push({
      kind: raw.kind,
      tool,
      ...(activityText ? { text: activityText } : {}),
      ...(raw.isError === true ? { isError: true } : {}),
    });
  }
  return result;
}

function delegatedRequest(input: unknown): string | undefined {
  const raw = object(input);
  return text(raw.request ?? raw.task, MAX_PAYLOAD_TEXT) || undefined;
}

function updateDelegatedRun(
  previous: DelegatedAgentRunReadModel | undefined,
  kind: DelegatedAgentKind,
  id: string,
  turn: number,
  input: unknown,
  result: unknown,
  status: DelegatedAgentRunReadModel["status"],
): DelegatedAgentRunReadModel {
  const raw = object(result);
  const details = object(raw.details);
  const activity = delegatedActivity(details.activity);
  const previousActivity = previous?.activity ?? [];
  if (previous && previous.status !== "running" && status === "running") {
    return {
      ...previous,
      activity: activity && activity.length >= previousActivity.length ? activity : previousActivity,
    };
  }
  const request = delegatedRequest(input);
  const response = status === "running" ? undefined : messageText(raw);
  const agentName = text(details.agentName, 24) || undefined;
  const startedAt = typeof details.startedAt === "string" && !Number.isNaN(Date.parse(details.startedAt))
    ? details.startedAt
    : undefined;
  const modelName = text(details.advisorModel ?? details.model, 200) || undefined;
  const level = thinkingLevel(details.thinking);
  const durationMs = boundedNumber(details.durationMs, 7 * 24 * 60 * 60 * 1_000);
  const usage = delegatedUsage(details.usage);
  return {
    ...previous,
    id,
    kind,
    turn: previous?.turn ?? Math.max(0, Math.floor(turn)),
    status,
    ...(agentName ? { agentName } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(modelName ? { modelName } : {}),
    ...(level ? { thinkingLevel: level } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage ? { usage } : {}),
    activity: activity && activity.length >= previousActivity.length ? activity : previousActivity,
  };
}

export function browserJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(browserValue(value), null, 2).slice(0, MAX_TEXT); }
  catch { return "[unserializable input]"; }
}

export function projectConversation(
  messages: unknown[],
  options: { start?: number; end?: number; includeDelegated?: boolean } = {},
): Pick<ConversationReadModel, "messages" | "delegatedRuns"> {
  const start = Math.min(messages.length, Math.max(0, Math.floor(options.start ?? Math.max(0, messages.length - MAX_MESSAGES))));
  const end = Math.min(messages.length, Math.max(start, Math.floor(options.end ?? messages.length)));
  const includeDelegated = options.includeDelegated !== false;
  let pinnedUserIndex = -1;
  for (let index = end - 1; index >= 0; index--) {
    if (role(object(messages[index]).role) === "user" && !promptFileCount(object(messages[index]))) {
      pinnedUserIndex = index;
      break;
    }
  }
  const toolCalls = new Map<string, { name: string; rawInput?: unknown; turn: number }>();
  const delegatedRuns = new Map<string, DelegatedAgentRunReadModel>();
  const projectedMessages: MessageReadModel[] = [];
  let latestProjectedUser: MessageReadModel | undefined;
  let userTurn = 0;
  for (let index = 0; index < end; index++) {
    const message = messages[index];
    const raw = object(message);
    const messageRole = role(raw.role);
    if (messageRole === "user") userTurn++;
    const fileCount = promptFileCount(raw);
    if (fileCount) {
      if (latestProjectedUser) latestProjectedUser.fileAttachmentCount = fileCount;
      continue;
    }
    if (messageRole === "assistant" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        const item = object(part);
        if (item.type !== "toolCall" || typeof item.id !== "string") continue;
        const name = text(item.name, 200) || "Tool";
        toolCalls.set(item.id, { name, rawInput: item.arguments, turn: userTurn });
        const kind = delegatedAgentKind(name);
        if (includeDelegated && kind) {
          delegatedRuns.set(item.id, updateDelegatedRun(undefined, kind, item.id, userTurn, item.arguments, undefined, "running"));
          trimMap(delegatedRuns, MAX_DELEGATED_RUNS);
        }
      }
    }
    if (messageRole === "tool") {
      const fallbackId = `history-${index}`;
      const toolId = id(raw.toolCallId, fallbackId);
      const call = toolCalls.get(toolId);
      const name = text(raw.toolName, 200) || call?.name || "Tool";
      const kind = delegatedAgentKind(name);
      if (includeDelegated && kind) {
        const details = object(raw.details);
        const failed = raw.isError === true || Boolean(details.failureCode)
          || typeof details.status === "string" && !["completed", "running"].includes(details.status);
        delegatedRuns.set(toolId, updateDelegatedRun(
          delegatedRuns.get(toolId),
          kind,
          toolId,
          call?.turn ?? userTurn,
          call?.rawInput,
          raw,
          failed ? "failed" : "completed",
        ));
        trimMap(delegatedRuns, MAX_DELEGATED_RUNS);
      }
      if (index < start && index !== pinnedUserIndex) continue;
      projectedMessages.push({
        id: fallbackId,
        ...(typeof raw.entryId === "string" ? { entryId: id(raw.entryId, fallbackId) } : {}),
        role: "tool",
        text: messageText(raw),
        streaming: false,
        ...(createdAt(raw.timestamp ?? raw.createdAt) ? { createdAt: createdAt(raw.timestamp ?? raw.createdAt) } : {}),
        tool: {
          id: toolId,
          name,
          input: browserJson(call?.rawInput),
          status: raw.isError === true ? "failed" : "completed",
        },
      });
      continue;
    }
    if (index < start && index !== pinnedUserIndex) continue;
    const images = attachmentCount(raw);
    const result: MessageReadModel = {
      id: `history-${index}`,
      ...(typeof raw.entryId === "string" ? { entryId: id(raw.entryId, `history-${index}`) } : {}),
      role: messageRole,
      text: messageText(raw),
      streaming: false,
      ...(createdAt(raw.timestamp ?? raw.createdAt) ? { createdAt: createdAt(raw.timestamp ?? raw.createdAt) } : {}),
      ...(messageRole === "user" && raw.canUndo === true ? { canUndo: true } : {}),
      ...(images ? { attachmentCount: images } : {}),
      ...(messageRole === "system" && typeof raw.customType === "string" ? { systemSource: text(raw.customType, 200) } : {}),
    };
    projectedMessages.push(result);
    if (messageRole === "user") latestProjectedUser = result;
  }
  return {
    messages: latestMessages(projectedMessages),
    delegatedRuns: [...delegatedRuns.values()].slice(-MAX_DELEGATED_RUNS),
  };
}

export function projectConversationTurnIndex(messages: unknown[]): ConversationTurnIndexItem[] {
  const turns: ConversationTurnIndexItem[] = [];
  for (let index = 0; index < messages.length; index++) {
    const raw = object(messages[index]);
    if (role(raw.role) !== "user" || promptFileCount(raw)) continue;
    const text = messageText(raw).replace(/\s+/g, " ").trim();
    const images = attachmentCount(raw);
    turns.push({
      promptId: id(raw.entryId, `history-${index}`),
      preview: (text || (images ? `${images} attached image${images === 1 ? "" : "s"}` : "Empty prompt")).slice(0, 120),
      ...(createdAt(raw.timestamp ?? raw.createdAt) ? { createdAt: createdAt(raw.timestamp ?? raw.createdAt) } : {}),
      cursor: encodeHistoryCursor(index),
    });
  }
  return turns;
}

export function projectMessages(messages: unknown[]): MessageReadModel[] {
  return projectConversation(messages).messages;
}

/** Maintains the browser-safe read model synchronously with journal publication. */
export class RuntimeProjection {
  private readonly messages = new Map<string, MessageReadModel>();
  private readonly tools = new Map<string, ToolActivityReadModel>();
  private readonly delegatedRuns = new Map<string, DelegatedAgentRunReadModel>();
  private pendingUpdate?: { id: string; text: string };
  private updateTimer?: NodeJS.Timeout;
  private updateBytes = 0;
  private activeMessageId?: string;
  private messageCounter = 0;
  private readonly turnMessages = new Map<string, string>();
  pendingUi?: UiRequestReadModel;

  constructor(private runtime: RuntimeSnapshot, private readonly publish: Publish) {
    for (const message of runtime.conversation.messages) this.messages.set(message.id, { ...message });
    for (const tool of runtime.conversation.tools) this.tools.set(tool.id, { ...tool });
    for (const run of runtime.conversation.delegatedRuns) this.delegatedRuns.set(run.id, structuredClone(run));
  }

  snapshot(): RuntimeSnapshot {
    return {
      ...this.runtime,
      conversation: {
        ...this.runtime.conversation,
        messages: latestMessages([...this.messages.values()]).map((message) => ({ ...message })),
        tools: [...this.tools.values()].slice(-MAX_TOOLS).map((tool) => ({ ...tool })),
        delegatedRuns: [...this.delegatedRuns.values()].slice(-MAX_DELEGATED_RUNS).map((run) => structuredClone(run)),
      },
      operational: cloneOperational(this.runtime.operational),
      extensionUi: {
        ...this.runtime.extensionUi,
        notifications: this.runtime.extensionUi.notifications.map((item) => ({ ...item })),
        statuses: this.runtime.extensionUi.statuses.map((item) => ({ ...item })),
        widgets: this.runtime.extensionUi.widgets.map((item) => ({ ...item, lines: [...item.lines] })),
      },
    };
  }

  refresh(runtime: RuntimeSnapshot): void {
    this.runtime = {
      ...this.runtime,
      ready: runtime.ready,
      cwdLabel: runtime.cwdLabel,
      projectAvailable: runtime.projectAvailable,
      sessionName: runtime.sessionName,
      gitBranch: runtime.gitBranch,
      activeTools: [...runtime.activeTools],
      availableTools: [...runtime.availableTools],
      optionalCapabilities: { ...runtime.optionalCapabilities },
      diagnostics: [...runtime.diagnostics],
      sessionControls: structuredClone(runtime.sessionControls),
      runtimePolicy: structuredClone(runtime.runtimePolicy),
      metrics: { ...runtime.metrics },
      discoverIndex: runtime.discoverIndex ? { ...runtime.discoverIndex } : undefined,
      conversation: {
        ...this.runtime.conversation,
        workStartedAt: runtime.conversation.workStartedAt,
        workModelName: runtime.conversation.workModelName,
        workThinkingLevel: runtime.conversation.workThinkingLevel,
        stopping: runtime.conversation.stopping,
        stoppedRun: runtime.conversation.stoppedRun
          ? { ...runtime.conversation.stoppedRun }
          : undefined,
      },
      operational: cloneOperational(runtime.operational),
    };
    this.publish("session.controls", this.runtime.sessionControls);
    this.publish("runtime.policy", this.runtime.runtimePolicy);
    this.publish("metrics.update", this.runtime.metrics);
  }

  replaceRuntime(runtime: RuntimeSnapshot): void {
    this.flush();
    this.runtime = runtime;
    this.messages.clear();
    this.tools.clear();
    this.delegatedRuns.clear();
    this.turnMessages.clear();
    for (const message of runtime.conversation.messages) this.messages.set(message.id, { ...message });
    for (const tool of runtime.conversation.tools) this.tools.set(tool.id, { ...tool });
    for (const run of runtime.conversation.delegatedRuns) this.delegatedRuns.set(run.id, structuredClone(run));
    this.pendingUi = undefined;
  }

  discardPending(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pendingUpdate = undefined;
    this.updateBytes = 0;
    this.activeMessageId = undefined;
  }

  dispose(): void { this.discardPending(); }

  apply(event: DriverEvent): void {
    if (event.type === "projects.changed") {
      this.publish("projects.changed", {});
      return;
    }
    if (event.type === "session.status") {
      this.publish("session.status", { sessionId: event.sessionId.slice(0, 128), state: event.state });
      return;
    }
    if (event.type === "queue.changed") {
      this.runtime.conversation.queue = structuredClone(event.queue);
      this.publish("queue.update", this.runtime.conversation.queue);
      return;
    }
    if (event.type === "workspace.revision") {
      this.runtime.workspace = structuredClone(event.workspace);
      this.publish("workspace.revision", this.runtime.workspace);
      return;
    }
    if (event.type === "ui.closed") {
      if (this.pendingUi?.requestId === event.requestId) this.pendingUi = undefined;
      this.publish("ui.closed", { requestId: event.requestId.slice(0, 128) });
      return;
    }
    if (event.type === "ui.event") {
      const raw = object(event.payload);
      const method = String(raw.method);
      const payload = object(raw.payload);
      if (raw.kind === "request" && ["select", "confirm", "input", "editor", "questionnaire"].includes(method)) {
        this.pendingUi = {
          requestId: id(raw.requestId, "invalid"),
          method: method as UiRequestReadModel["method"],
          payload: browserValue(payload) as Record<string, unknown>,
          owned: false,
          ownershipAvailable: false,
        };
        this.publish("ui.request", this.pendingUi);
      } else if (method === "notify") {
        const item: UiNotificationReadModel = {
          id: id(raw.requestId, `notification-${Date.now()}`),
          message: text(payload.message, 2_000),
          type: payload.type === "warning" || payload.type === "error" ? payload.type : "info",
          occurredAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        };
        this.runtime.extensionUi.notifications = [...this.runtime.extensionUi.notifications, item].slice(-10);
        this.publish("ui.notify", item);
      } else if (method === "setStatus") {
        const key = id(payload.key, "status");
        const item = typeof payload.text === "string" ? { key, text: text(payload.text, 500) } satisfies UiStatusReadModel : undefined;
        this.runtime.extensionUi.statuses = replaceKey(this.runtime.extensionUi.statuses, key, item, 25);
        this.publish("ui.status", item ?? { key });
      } else if (method === "setWidget") {
        const key = id(payload.key, "widget");
        const lines = boundedLines(payload.lines);
        const placement = payload.placement === "aboveEditor" || payload.placement === "belowEditor" ? payload.placement : undefined;
        const item = lines ? { key, lines, placement } satisfies UiWidgetReadModel : undefined;
        this.runtime.extensionUi.widgets = replaceKey(this.runtime.extensionUi.widgets, key, item, 10);
        this.publish("ui.widget", item ?? { key });
      } else if (method === "setTitle") {
        this.runtime.extensionUi.title = text(payload.title, 500);
        this.publish("ui.title", { title: this.runtime.extensionUi.title });
      } else if (method === "setEditorText") {
        this.runtime.extensionUi.editorText = text(payload.text);
        this.runtime.extensionUi.editorRevision++;
        this.publish("ui.editor-text", { text: this.runtime.extensionUi.editorText, revision: this.runtime.extensionUi.editorRevision });
      }
      return;
    }
    if (event.type === "package.event") {
      this.runtime.operational = cloneOperational(event.operational);
      this.publish(`operational.${event.channel}`, cloneOperational(this.runtime.operational));
      return;
    }
    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      const sessionId = event.sessionId.slice(0, 128);
      this.replaceRuntime(structuredClone(event.runtime));
      this.runtime.sessionId = sessionId;
      this.runtime.sessionGeneration = event.sessionGeneration;
      this.runtime.ready = event.type === "session.replaced";
      this.publish(event.type, { sessionId, sessionGeneration: event.sessionGeneration });
      return;
    }
    if (event.type !== "session.event") return;
    const raw = object(event.payload);
    const kind = String(raw.type ?? raw.event ?? raw.kind ?? "").replace(/-/g, "_");
    if (kind === "message_start" || kind === "message_starting") return this.messageStart(raw);
    if (kind === "message_update" || kind === "message_delta") return this.messageUpdate(raw);
    if (kind === "message_end" || kind === "message_complete") return this.messageEnd(raw);
    if (kind === "tool_execution_start" || kind === "tool_start" || kind === "tool_call_start") return this.toolStart(raw);
    if (kind === "tool_execution_end" || kind === "tool_end" || kind === "tool_call_end" || kind === "tool_result") return this.toolEnd(raw);
    if (kind === "tool_execution_update") return this.toolUpdate(raw);
    if (kind === "queue" || kind === "queue_update") return this.queue(raw);
    if (kind === "auto_retry_start" || kind === "auto_retry_end" || kind === "retry" || kind === "retry_start" || kind === "retry_end") return this.retry(raw, kind);
    if (kind === "compaction" || kind === "compaction_start" || kind === "compaction_end") return this.compaction(raw, kind);
    if (kind === "metrics" || kind === "session_stats" || kind === "usage") return this.metrics(object(raw.metrics ?? raw.stats ?? raw));
    if (kind === "worktree_summary") return this.worktreeSummary(raw);
    if (kind === "discover_index") {
      const value = object(raw.value);
      this.runtime.discoverIndex = ["idle", "indexing", "error"].includes(String(value.state))
        ? value as unknown as RuntimeSnapshot["discoverIndex"]
        : undefined;
      this.publish("discover.index", this.runtime.discoverIndex ?? {});
      return;
    }
    if (kind === "session_info_changed") {
      this.runtime.sessionName = text(raw.name, 200) || undefined;
      this.publish("session.info", { sessionId: this.runtime.sessionId, name: this.runtime.sessionName });
      return;
    }
    if (kind === "session_controls_error" || kind === "runtime_error") {
      this.publish("runtime.error", { message: text(raw.message, 1_000) || "Could not apply the queued model change" });
      return;
    }
    if (kind === "prompt_undo") {
      const entryIds = new Set(
        Array.isArray(raw.entryIds)
          ? raw.entryIds.filter((entryId): entryId is string => typeof entryId === "string").slice(0, 10_000)
          : [],
      );
      const forkEntryIds = new Set(
        Array.isArray(raw.forkEntryIds)
          ? raw.forkEntryIds.filter((entryId): entryId is string => typeof entryId === "string").slice(0, 10_000)
          : [],
      );
      const items: Array<{ id: string; canUndo: boolean; canForkWithTimeline: boolean }> = [];
      for (const message of this.messages.values()) {
        if (message.role !== "user" || !message.entryId) continue;
        message.canUndo = entryIds.has(message.entryId);
        message.canForkWithTimeline = forkEntryIds.has(message.entryId);
        items.push({
          id: message.id,
          canUndo: message.canUndo,
          canForkWithTimeline: message.canForkWithTimeline,
        });
      }
      this.publish("message.undo", { items });
      return;
    }
    if (kind === "agent_start") {
      if (raw.metrics) this.metrics(object(raw.metrics));
      const startedAt = typeof raw.workStartedAt === "string" && !Number.isNaN(Date.parse(raw.workStartedAt))
        ? raw.workStartedAt
        : new Date().toISOString();
      this.runtime.conversation.workStartedAt = startedAt;
      this.runtime.conversation.workModelName = text(raw.modelName, 200) || undefined;
      this.runtime.conversation.workThinkingLevel = thinkingLevel(raw.thinkingLevel);
      this.runtime.conversation.stopping = false;
      this.runtime.conversation.stoppedRun = undefined;
      this.publish("agent.start", {
        startedAt,
        turnId: id(raw.turnId, ""),
        modelName: this.runtime.conversation.workModelName,
        thinkingLevel: this.runtime.conversation.workThinkingLevel,
      });
      return;
    }
    if (kind === "agent_end" || kind === "agent_error") {
      if (kind === "agent_end" && raw.metrics) this.metrics(object(raw.metrics));
      if (kind === "agent_end") {
        this.runtime.gitBranch = typeof raw.gitBranch === "string" ? text(raw.gitBranch, 200) || undefined : undefined;
      }
      const durationMs = Number.isSafeInteger(raw.workDurationMs)
        ? Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, raw.workDurationMs as number))
        : undefined;
      const assistant = [...this.messages.values()].reverse().find((message) => message.role === "assistant");
      const turnId = id(raw.turnId, "");
      if (assistant && turnId) {
        this.turnMessages.set(turnId, assistant.id);
        trimMap(this.turnMessages, 20);
      }
      if (assistant && durationMs !== undefined) {
        assistant.workDurationMs = durationMs;
        assistant.modelName = text(raw.modelName, 200) || undefined;
        assistant.thinkingLevel = thinkingLevel(raw.thinkingLevel);
        this.messages.set(assistant.id, assistant);
      }
      this.runtime.conversation.workStartedAt = undefined;
      this.runtime.conversation.workModelName = undefined;
      this.runtime.conversation.workThinkingLevel = undefined;
      this.runtime.conversation.stopping = false;
      const stopped = raw.stopped === true;
      this.runtime.conversation.stoppedRun = stopped && durationMs !== undefined
        ? {
            turnId,
            userEntryId: text(raw.userEntryId, 128) || undefined,
            durationMs,
            modelName: text(raw.modelName, 200) || undefined,
            thinkingLevel: thinkingLevel(raw.thinkingLevel),
          }
        : undefined;
      this.publish(`agent.${kind.slice(6)}`, {
        willRetry: raw.willRetry === true,
        message: text(raw.errorMessage, 1_000) || undefined,
        durationMs,
        turnId,
        messageId: assistant?.id,
        modelName: assistant?.modelName,
        thinkingLevel: assistant?.thinkingLevel,
        gitBranch: this.runtime.gitBranch,
        stopped,
        userEntryId: this.runtime.conversation.stoppedRun?.userEntryId,
      });
    }
  }

  private messageStart(raw: Record<string, unknown>): void {
    this.flush();
    const message = object(raw.message);
    const fileCount = promptFileCount(message);
    if (fileCount) {
      const user = [...this.messages.values()].reverse().find((item) => item.role === "user");
      if (user) {
        user.fileAttachmentCount = fileCount;
        this.messages.set(user.id, user);
        this.publish("message.update", { id: user.id, text: user.text, fileAttachmentCount: fileCount });
      }
      return;
    }
    const messageId = id(raw.messageId ?? raw.id ?? message.id, `message-${++this.messageCounter}`);
    this.activeMessageId = messageId;
    const item: MessageReadModel = {
      id: messageId,
      ...(typeof raw.entryId === "string" || typeof message.entryId === "string"
        ? { entryId: id(raw.entryId ?? message.entryId, messageId) }
        : {}),
      role: role(raw.role ?? message.role),
      text: messageText(message) || text(raw.text),
      streaming: true,
      createdAt: createdAt(message.timestamp ?? raw.timestamp) ?? new Date().toISOString(),
      ...(attachmentCount(message) ? { attachmentCount: attachmentCount(message) } : {}),
      ...(typeof message.customType === "string" ? { systemSource: text(message.customType, 200) } : {}),
    };
    if (item.role === "tool") {
      const toolId = id(message.toolCallId ?? raw.toolCallId, messageId);
      const activity = this.tools.get(toolId);
      item.tool = {
        id: toolId,
        name: text(message.toolName ?? raw.toolName, 200) || activity?.name || "Tool",
        input: activity?.input,
        status: message.isError === true || raw.isError === true ? "failed" : activity?.status ?? "completed",
      };
    }
    this.messages.set(messageId, item);
    trimMessages(this.messages);
    this.runtime.conversation.streaming = true;
    this.publish("message.start", item);
  }
  private messageUpdate(raw: Record<string, unknown>): void {
    const message = object(raw.message);
    const messageId = this.activeMessageId ?? id(raw.messageId ?? raw.id ?? message.id, `message-${++this.messageCounter}`);
    this.activeMessageId = messageId;
    const current = this.messages.get(messageId) ?? { id: messageId, role: role(raw.role ?? message.role), text: "", streaming: true };
    const full = messageText(message);
    const incoming = text(raw.delta ?? raw.text);
    current.text = full || (current.text + incoming).slice(0, MAX_TEXT);
    current.streaming = true; this.messages.set(messageId, current); this.runtime.conversation.streaming = true;
    this.pendingUpdate = { id: messageId, text: current.text };
    this.updateBytes += Buffer.byteLength(incoming || full);
    if (this.updateBytes >= MAX_PAYLOAD_TEXT) this.flush();
    else if (!this.updateTimer) { this.updateTimer = setTimeout(() => this.flush(), 16); this.updateTimer.unref?.(); }
  }
  private messageEnd(raw: Record<string, unknown>): void {
    if (promptFileCount(object(raw.message))) return;
    this.flush();
    const messageId = this.activeMessageId ?? id(raw.messageId ?? raw.id ?? object(raw.message).id, "message");
    const current = this.messages.get(messageId);
    if (current) {
      const finalText = messageText(raw.message);
      if (finalText) current.text = finalText;
      const entryId = raw.entryId ?? object(raw.message).entryId;
      if (typeof entryId === "string") current.entryId = id(entryId, current.id);
      current.streaming = false;
      this.messages.set(messageId, current);
    }
    this.activeMessageId = undefined;
    this.runtime.conversation.streaming = false;
    this.publish("message.end", { id: messageId, text: current?.text ?? "", entryId: current?.entryId });
  }
  private toolStart(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, `tool-${this.tools.size + 1}`);
    const name = text(raw.name ?? raw.toolName, 200);
    const input = raw.args ?? raw.input;
    const item: ToolActivityReadModel = { id: toolId, name, input: browserJson(input), status: "running" };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.start", item);
    const kind = delegatedAgentKind(name);
    if (kind) this.setDelegatedRun(updateDelegatedRun(undefined, kind, toolId, this.runtime.metrics.userMessages, input, undefined, "running"));
  }
  private toolUpdate(raw: Record<string, unknown>): void {
    const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, "tool");
    const old = this.delegatedRuns.get(toolId);
    const kind = delegatedAgentKind(raw.name ?? raw.toolName) ?? old?.kind;
    if (!kind) return;
    this.setDelegatedRun(updateDelegatedRun(old, kind, toolId, this.runtime.metrics.userMessages, raw.args ?? raw.input, raw.partialResult, "running"));
  }
  private toolEnd(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, "tool"); const old = this.tools.get(toolId);
    const item: ToolActivityReadModel = { id: toolId, name: old?.name ?? text(raw.name ?? raw.toolName, 200), input: old?.input ?? browserJson(raw.args ?? raw.input), status: raw.isError === true || raw.failed === true || raw.error ? "failed" : "completed", summary: text(raw.summary ?? raw.error ?? raw.output, 4_000) || undefined };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.end", item);
    const previous = this.delegatedRuns.get(toolId);
    const kind = delegatedAgentKind(item.name) ?? previous?.kind;
    if (!kind) return;
    const result = raw.result ?? raw;
    const details = object(object(result).details);
    const failed = item.status === "failed" || Boolean(details.failureCode)
      || typeof details.status === "string" && !["completed", "running"].includes(details.status);
    this.setDelegatedRun(updateDelegatedRun(previous, kind, toolId, this.runtime.metrics.userMessages, raw.args ?? raw.input, result, failed ? "failed" : "completed"));
  }
  private setDelegatedRun(run: DelegatedAgentRunReadModel): void {
    this.delegatedRuns.set(run.id, run);
    trimMap(this.delegatedRuns, MAX_DELEGATED_RUNS);
    this.publish("delegate.update", structuredClone(run));
  }
  private queue(raw: Record<string, unknown>): void { this.runtime.conversation.queue = { steering: Array.isArray(raw.steering) ? raw.steering.length : Number.isSafeInteger(raw.steering) ? Math.max(0, raw.steering as number) : 0, followUp: Array.isArray(raw.followUp) ? raw.followUp.length : Number.isSafeInteger(raw.followUp) ? Math.max(0, raw.followUp as number) : 0 }; this.publish("queue.update", this.runtime.conversation.queue); }
  private retry(raw: Record<string, unknown>, kind: string): void { this.runtime.conversation.retry = { active: kind !== "retry_end" && kind !== "auto_retry_end" && raw.active !== false, attempt: typeof raw.attempt === "number" ? raw.attempt : undefined, maxAttempts: typeof raw.maxAttempts === "number" ? raw.maxAttempts : undefined, message: text(raw.message ?? raw.errorMessage ?? raw.finalError, 1_000) || undefined }; this.publish("retry.update", this.runtime.conversation.retry); }
  private compaction(raw: Record<string, unknown>, kind: string): void { this.runtime.conversation.compaction = { active: kind !== "compaction_end" && raw.active !== false, reason: raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow" ? raw.reason : undefined }; this.publish("compaction.update", this.runtime.conversation.compaction); }
  private metrics(raw: Record<string, unknown>): void {
    const current = this.runtime.metrics as unknown as Record<string, unknown>;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "contextTokens", "contextLimit", "contextPercent", "cost", "userMessages", "assistantMessages", "toolCalls"]) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key])) current[key] = raw[key];
    }
    if (typeof raw.model === "string") current.model = raw.model.slice(0, 200);
    if (typeof raw.provider === "string") current.provider = raw.provider.slice(0, 200);
    this.publish("metrics.update", this.runtime.metrics);
  }
  private worktreeSummary(raw: Record<string, unknown>): void {
    const turnId = id(raw.turnId, "");
    const messageId = this.turnMessages.get(turnId) ?? id(raw.messageId, "");
    const message = this.messages.get(messageId);
    if (!message || message.role !== "assistant" || !Array.isArray(raw.files)) return;
    const files: NonNullable<MessageReadModel["changedFiles"]> = [];
    for (const value of raw.files.slice(0, 100)) {
      const file = object(value);
      const path = text(file.path, 500);
      if (!path) continue;
      if (file.binary === true) {
        files.push({ path, binary: true });
        continue;
      }
      if (Number.isSafeInteger(file.additions) && (file.additions as number) >= 0
        && Number.isSafeInteger(file.deletions) && (file.deletions as number) >= 0) {
        files.push({ path, additions: file.additions as number, deletions: file.deletions as number });
      }
    }
    message.changedFiles = files;
    this.messages.set(messageId, message);
    if (turnId) this.turnMessages.delete(turnId);
    this.publish("turn.changes", { messageId, files });
  }
  flush(): void { if (this.updateTimer) clearTimeout(this.updateTimer); this.updateTimer = undefined; if (this.pendingUpdate) this.publish("message.update", this.pendingUpdate); this.pendingUpdate = undefined; this.updateBytes = 0; }
}

function replaceKey<T extends { key: string }>(items: T[], key: string, item: T | undefined, maximum: number): T[] {
  const next = items.filter((existing) => existing.key !== key);
  if (item) next.push(item);
  return next.slice(-maximum);
}

function trimMap<T>(map: Map<string, T>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

import type { ConversationReadModel, MessageReadModel, ToolActivityReadModel, UiNotificationReadModel, UiRequestReadModel, UiStatusReadModel, UiWidgetReadModel } from "../../shared/protocol/events.ts";
import type { RuntimeSnapshot } from "../../shared/protocol/snapshots.ts";
import type { DriverEvent } from "./pi-driver.ts";
import { cloneOperational } from "./operational-projections.ts";

const MAX_TEXT = 60 * 1024;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 100;
const MAX_PAYLOAD_TEXT = 8 * 1024;

type Publish = (type: string, payload: unknown) => void;

function text(value: unknown, maximum = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
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
function messageText(value: unknown): string {
  const raw = object(value);
  if (typeof raw.content === "string") return text(raw.content);
  if (!Array.isArray(raw.content)) return text(raw.text);
  return raw.content.flatMap((part) => {
    const item = object(part);
    return typeof item.text === "string" ? [item.text] : [];
  }).join("").slice(0, MAX_TEXT);
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

export function browserJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(browserValue(value), null, 2).slice(0, MAX_TEXT); }
  catch { return "[unserializable input]"; }
}

export function projectMessages(messages: unknown[]): MessageReadModel[] {
  const toolCalls = new Map<string, { name: string; input?: string }>();
  return messages.map((message, index) => {
    const raw = object(message);
    const messageRole = role(raw.role);
    if (messageRole === "assistant" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        const item = object(part);
        if (item.type !== "toolCall" || typeof item.id !== "string") continue;
        toolCalls.set(item.id, { name: text(item.name, 200) || "Tool", input: browserJson(item.arguments) });
      }
    }
    const result: MessageReadModel = {
      id: `history-${index}`,
      role: messageRole,
      text: messageText(raw),
      streaming: false,
      ...(attachmentCount(raw) ? { attachmentCount: attachmentCount(raw) } : {}),
      ...(messageRole === "system" && typeof raw.customType === "string" ? { systemSource: text(raw.customType, 200) } : {}),
    };
    if (messageRole !== "tool") return result;
    const toolId = id(raw.toolCallId, result.id);
    const call = toolCalls.get(toolId);
    result.tool = {
      id: toolId,
      name: text(raw.toolName, 200) || call?.name || "Tool",
      input: call?.input,
      status: raw.isError === true ? "failed" : "completed",
    };
    return result;
  }).slice(-MAX_MESSAGES);
}

/** Maintains the browser-safe read model synchronously with journal publication. */
export class RuntimeProjection {
  private readonly messages = new Map<string, MessageReadModel>();
  private readonly tools = new Map<string, ToolActivityReadModel>();
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
  }

  snapshot(): RuntimeSnapshot {
    return {
      ...this.runtime,
      conversation: {
        ...this.runtime.conversation,
        messages: [...this.messages.values()].slice(-MAX_MESSAGES).map((message) => ({ ...message })),
        tools: [...this.tools.values()].slice(-MAX_TOOLS).map((tool) => ({ ...tool })),
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
      metrics: { ...runtime.metrics },
      discoverIndex: runtime.discoverIndex ? { ...runtime.discoverIndex } : undefined,
      conversation: {
        ...this.runtime.conversation,
        workStartedAt: runtime.conversation.workStartedAt,
        workModelName: runtime.conversation.workModelName,
        workThinkingLevel: runtime.conversation.workThinkingLevel,
      },
      operational: cloneOperational(runtime.operational),
    };
    this.publish("session.controls", this.runtime.sessionControls);
    this.publish("metrics.update", this.runtime.metrics);
  }

  replaceRuntime(runtime: RuntimeSnapshot): void {
    this.flush();
    this.runtime = runtime;
    this.messages.clear();
    this.tools.clear();
    this.turnMessages.clear();
    for (const message of runtime.conversation.messages) this.messages.set(message.id, { ...message });
    for (const tool of runtime.conversation.tools) this.tools.set(tool.id, { ...tool });
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
    if (event.type === "ui.closed") {
      if (this.pendingUi?.requestId === event.requestId) this.pendingUi = undefined;
      this.publish("ui.closed", { requestId: event.requestId.slice(0, 128) });
      return;
    }
    if (event.type === "ui.event") {
      const raw = object(event.payload);
      const method = String(raw.method);
      const payload = object(raw.payload);
      if (raw.kind === "request" && ["select", "confirm", "input", "editor"].includes(method)) {
        this.pendingUi = {
          requestId: id(raw.requestId, "invalid"),
          method: method as UiRequestReadModel["method"],
          payload: browserValue(payload) as Record<string, unknown>,
          expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
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
    if (kind === "tool_execution_update") return;
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
    if (kind === "agent_start") {
      if (raw.metrics) this.metrics(object(raw.metrics));
      const startedAt = typeof raw.workStartedAt === "string" && !Number.isNaN(Date.parse(raw.workStartedAt))
        ? raw.workStartedAt
        : new Date().toISOString();
      this.runtime.conversation.workStartedAt = startedAt;
      this.runtime.conversation.workModelName = text(raw.modelName, 200) || undefined;
      this.runtime.conversation.workThinkingLevel = thinkingLevel(raw.thinkingLevel);
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
      this.publish(`agent.${kind.slice(6)}`, {
        willRetry: raw.willRetry === true,
        message: text(raw.errorMessage, 1_000) || undefined,
        durationMs,
        turnId,
        messageId: assistant?.id,
        modelName: assistant?.modelName,
        thinkingLevel: assistant?.thinkingLevel,
        gitBranch: this.runtime.gitBranch,
      });
    }
  }

  private messageStart(raw: Record<string, unknown>): void {
    this.flush();
    const message = object(raw.message);
    const messageId = id(raw.messageId ?? raw.id ?? message.id, `message-${++this.messageCounter}`);
    this.activeMessageId = messageId;
    const item: MessageReadModel = {
      id: messageId,
      role: role(raw.role ?? message.role),
      text: messageText(message) || text(raw.text),
      streaming: true,
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
    trimMap(this.messages, MAX_MESSAGES);
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
    this.flush();
    const messageId = this.activeMessageId ?? id(raw.messageId ?? raw.id ?? object(raw.message).id, "message");
    const current = this.messages.get(messageId);
    if (current) {
      const finalText = messageText(raw.message);
      if (finalText) current.text = finalText;
      current.streaming = false;
      this.messages.set(messageId, current);
    }
    this.activeMessageId = undefined;
    this.runtime.conversation.streaming = false;
    this.publish("message.end", { id: messageId, text: current?.text ?? "" });
  }
  private toolStart(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, `tool-${this.tools.size + 1}`);
    const item: ToolActivityReadModel = { id: toolId, name: text(raw.name ?? raw.toolName, 200), input: browserJson(raw.args ?? raw.input), status: "running" };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.start", item);
  }
  private toolEnd(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, "tool"); const old = this.tools.get(toolId);
    const item: ToolActivityReadModel = { id: toolId, name: old?.name ?? text(raw.name ?? raw.toolName, 200), input: old?.input ?? browserJson(raw.args ?? raw.input), status: raw.isError === true || raw.failed === true || raw.error ? "failed" : "completed", summary: text(raw.summary ?? raw.error ?? raw.output, 4_000) || undefined };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.end", item);
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
      if (Number.isSafeInteger(file.additions) && Number.isSafeInteger(file.deletions)) {
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

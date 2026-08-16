import { isDeepStrictEqual } from "node:util";
import { MAX_COMPACTION_DISPLAY_HISTORY_ITEMS, MAX_COMPACTION_DISPLAY_PATH, MAX_COMPACTION_DISPLAY_RECORDS, MAX_COMPACTION_DISPLAY_SOURCE_ID, MAX_COMPACTION_DISPLAY_TEXT } from "../../shared/protocol/events.ts";
import type { CompactionDisplayReadModel, ConversationReadModel, DelegatedAgentActivityReadModel, DelegatedAgentKind, DelegatedAgentRunReadModel, DelegatedAgentUsageReadModel, MessageReadModel, ToolActivityReadModel, UiNotificationReadModel, UiRequestReadModel, UiStatusReadModel, UiWidgetReadModel } from "../../shared/protocol/events.ts";
import type { RuntimeSnapshot } from "../../shared/protocol/snapshots.ts";
import type { ConversationTurnIndexItem } from "../../shared/protocol/snapshots.ts";
import type { DriverEvent } from "./pi-driver.ts";
import { cloneOperational } from "./operational-projections.ts";
import { PROMPT_FILES_CUSTOM_TYPE } from "./prompt-attachments.ts";
import { settleRunningActivities, terminalActivityStatus } from "../../shared/transcript.ts";
import { MAX_UNSEEN_COMPLETIONS, validCompletionSessionId } from "../../shared/session-completions.ts";

const MAX_TEXT = 60 * 1024;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 100;
const MAX_DELEGATED_RUNS = 100;
const MAX_PAYLOAD_TEXT = 8 * 1024;
const STREAM_FLUSH_MS = 50;
const MAX_AGENT_ACTIVITY_TEXT = 2_000;
const delegatedAgentKinds = new Set<DelegatedAgentKind>(["advisor", "grunt", "repo_scout", "web_scout", "spawn_agent", "spawn_session"]);
const spawnExecutionActions = new Set(["create", "continue", "adopt"]);
const spawnControlActions = new Set(["status", "cancel"]);

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
function compactionDisplay(value: unknown): CompactionDisplayReadModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const source = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.sourceEntryId === "string" && record.sourceEntryId.length > 0
      && record.sourceEntryId.length <= MAX_COMPACTION_DISPLAY_SOURCE_ID
      && typeof record.text === "string" && record.text.length > 0 && record.text.length <= MAX_COMPACTION_DISPLAY_TEXT;
  };
  const record = (item: unknown) => source(item)
    && ((item as Record<string, unknown>).role === "user" || (item as Record<string, unknown>).role === "assistant");
  const historyRecord = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" && record.path.length > 0 && record.path.length <= MAX_COMPACTION_DISPLAY_PATH
      && (record.sourceEntryId === undefined || typeof record.sourceEntryId === "string"
        && record.sourceEntryId.length <= MAX_COMPACTION_DISPLAY_SOURCE_ID);
  };
  const history = raw.history as Record<string, unknown> | undefined;
  if (!Array.isArray(raw.records) || !Array.isArray(raw.failedTools) || !Array.isArray(raw.toolResults)
    || raw.records.length + raw.failedTools.length + raw.toolResults.length > MAX_COMPACTION_DISPLAY_RECORDS
    || !raw.records.every(record) || !raw.failedTools.every(source) || !raw.toolResults.every(source)
    || !history || Array.isArray(history)
    || !Array.isArray(history.read) || history.read.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS || !history.read.every(historyRecord)
    || !Array.isArray(history.modified) || history.modified.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS || !history.modified.every(historyRecord)) return undefined;
  const sourceValue = (item: unknown) => {
    const record = item as Record<string, unknown>;
    return { sourceEntryId: record.sourceEntryId as string, text: record.text as string };
  };
  const historyValue = (item: unknown) => {
    const record = item as Record<string, unknown>;
    return {
      path: record.path as string,
      ...(typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {}),
    };
  };
  return {
    records: raw.records.map((item) => ({ ...sourceValue(item), role: (item as Record<string, unknown>).role as "user" | "assistant" })),
    failedTools: raw.failedTools.map(sourceValue),
    toolResults: raw.toolResults.map(sourceValue),
    history: { read: history.read.map(historyValue), modified: history.modified.map(historyValue) },
  };
}

function compactionMessage(value: unknown): MessageReadModel["compaction"] {
  const raw = object(value);
  if (!Number.isSafeInteger(raw.contextAfterTokens) || Number(raw.contextAfterTokens) < 0) return undefined;
  const optionalCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  const contextBeforeTokens = optionalCount(raw.contextBeforeTokens);
  const sourceEntryCount = optionalCount(raw.sourceEntryCount);
  const display = compactionDisplay(raw.display);
  return {
    contextAfterTokens: Number(raw.contextAfterTokens),
    ...(contextBeforeTokens === undefined ? {} : { contextBeforeTokens }),
    ...(sourceEntryCount === undefined ? {} : { sourceEntryCount }),
    ...(display ? { display } : {}),
  };
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

export function continuityCompactionInterruptionId(value: unknown): string | undefined {
  const raw = object(value);
  if (raw.role !== "assistant" || raw.stopReason !== "aborted" || !Array.isArray(raw.diagnostics)) return undefined;
  for (let index = raw.diagnostics.length - 1; index >= 0; index--) {
    const diagnostic = object(raw.diagnostics[index]);
    const details = object(diagnostic.details);
    if (diagnostic.type === "pi-continuity-compaction-interruption" && details.version === 1
      && typeof details.requestId === "string" && details.requestId.length > 0 && details.requestId.length <= 128)
      return details.requestId;
  }
  return undefined;
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

function spawnToolKind(value: unknown): "spawn_agent" | "spawn_session" | undefined {
  return value === "spawn_agent" || value === "spawn_session" ? value : undefined;
}

function spawnAction(input: unknown): string | undefined {
  const action = object(input).action;
  return typeof action === "string" ? action : undefined;
}

function delegatedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

function delegatedAgentKind(value: unknown, input?: unknown): DelegatedAgentKind | undefined {
  if (!delegatedAgentKinds.has(value as DelegatedAgentKind)) return undefined;
  const kind = value as DelegatedAgentKind;
  if (kind !== "spawn_agent" && kind !== "spawn_session") return kind;
  const action = spawnAction(input);
  if (!spawnExecutionActions.has(String(action)) || action === "adopt" && kind !== "spawn_session") return undefined;
  return kind;
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
  for (const rawValue of value) {
    const raw = object(rawValue);
    if (raw.kind !== "call" && raw.kind !== "result") continue;
    const tool = text(raw.tool, 200);
    if (!tool) continue;
    const activityId = text(raw.id, 128) || undefined;
    let activityText = text(raw.text, MAX_AGENT_ACTIVITY_TEXT);
    if (activityText) {
      try { activityText = browserJson(JSON.parse(activityText))?.slice(0, MAX_AGENT_ACTIVITY_TEXT) ?? activityText; }
      catch { /* Non-JSON tool input remains bounded plain text. */ }
      activityText = activityText
        .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
        .replace(/\b((?:api[_-]?key|token|secret|password|cookie)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
        .slice(0, MAX_AGENT_ACTIVITY_TEXT);
    }
    result.push({
      ...(activityId ? { id: activityId } : {}),
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
  return text(raw.request ?? raw.task ?? raw.prompt, MAX_PAYLOAD_TEXT) || undefined;
}

function spawnMetadata(kind: DelegatedAgentKind, input: unknown, details: Record<string, unknown>) {
  if (kind !== "spawn_agent" && kind !== "spawn_session") return {};
  const action = spawnAction(input);
  const validAction = spawnExecutionActions.has(String(action)) && (action !== "adopt" || kind === "spawn_session");
  const marker = object(details.piSpawn);
  const expectedKind = kind === "spawn_agent" ? "agent" : "session";
  const threadId = marker.version === 1 && marker.kind === expectedKind ? delegatedId(marker.id) : undefined;
  const runId = details.background === true ? delegatedId(details.runId) : undefined;
  return {
    ...(validAction ? { action: action as "create" | "continue" | "adopt" } : {}),
    ...(threadId ? { threadId } : {}),
    ...(runId ? { runId } : {}),
  };
}

function validSpawnControlTarget(
  previous: DelegatedAgentRunReadModel | undefined,
  kind: DelegatedAgentKind | undefined,
  details: Record<string, unknown>,
): previous is DelegatedAgentRunReadModel {
  if (!previous || kind !== previous.kind || delegatedId(details.runId) !== previous.runId) return false;
  const metadata = spawnMetadata(kind, undefined, details);
  return !!metadata.threadId && metadata.threadId === previous.threadId;
}

function delegatedEndStatus(
  raw: Record<string, unknown>,
  kind: DelegatedAgentKind,
  details: Record<string, unknown>,
): DelegatedAgentRunReadModel["status"] {
  const spawned = kind === "spawn_agent" || kind === "spawn_session";
  const failed = raw.isError === true || raw.failed === true || Boolean(raw.error) || Boolean(details.failureCode)
    || spawned && typeof details.status === "string" && !["completed", "running"].includes(details.status);
  if (failed) return "failed";
  if (!spawned || details.status !== "running") return "completed";
  const metadata = spawnMetadata(kind, undefined, details);
  const startedAt = typeof details.startedAt === "string" && !Number.isNaN(Date.parse(details.startedAt));
  return details.background === true && metadata.runId && metadata.threadId && startedAt ? "running" : "completed";
}

function equalDelegatedRunExceptDuration(
  previous: DelegatedAgentRunReadModel,
  next: DelegatedAgentRunReadModel,
): boolean {
  const previousComparable = { ...previous };
  const nextComparable = { ...next };
  delete previousComparable.durationMs;
  delete nextComparable.durationMs;
  return isDeepStrictEqual(previousComparable, nextComparable);
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
  const fullActivity = delegatedActivity(details.activity);
  const activityDelta = delegatedActivity(details.activityDelta);
  const previousActivity = previous?.activity ?? [];
  const activity = fullActivity && fullActivity.length >= previousActivity.length
    ? fullActivity
    : activityDelta?.length ? [...previousActivity, ...activityDelta] : previousActivity;
  const nextStatus = previous && previous.status !== "running" && status === "running" ? previous.status : status;
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
  const sessionUsage = delegatedUsage(details.sessionUsage);
  return {
    ...previous,
    id,
    kind,
    turn: previous?.turn ?? Math.max(0, Math.floor(turn)),
    status: nextStatus,
    ...(agentName ? { agentName } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(modelName ? { modelName } : {}),
    ...(level ? { thinkingLevel: level } : {}),
    ...spawnMetadata(kind, input, details),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage ? { usage } : {}),
    ...(sessionUsage ? { sessionUsage } : {}),
    activity,
  };
}

export function projectDelegatedToolEvent(
  phase: "start" | "update" | "end",
  toolId: string,
  previous: DelegatedAgentRunReadModel | undefined,
  raw: Record<string, unknown>,
  turn: number,
): DelegatedAgentRunReadModel | undefined {
  const input = raw.args ?? raw.input;
  const name = raw.name ?? raw.toolName;
  const kind = delegatedAgentKind(name, input) ?? previous?.kind;
  if (!kind) return undefined;
  if (phase === "start") return updateDelegatedRun(previous, kind, toolId, turn, input, undefined, "running");
  if (phase === "update") return updateDelegatedRun(previous, kind, toolId, turn, input, raw.partialResult, "running");
  const result = raw.result ?? raw;
  const details = object(object(result).details);
  return updateDelegatedRun(previous, kind, toolId, turn, input, result, delegatedEndStatus(raw, kind, details));
}

function mergeDelegatedRun(
  transcript: DelegatedAgentRunReadModel,
  live: DelegatedAgentRunReadModel,
): DelegatedAgentRunReadModel {
  const terminal = transcript.status !== "running" ? transcript : live;
  const activity = live.activity.length >= transcript.activity.length ? live.activity : transcript.activity;
  const usage = terminal.usage ?? live.usage ?? transcript.usage;
  const sessionUsage = terminal.sessionUsage ?? live.sessionUsage ?? transcript.sessionUsage;
  const durationMs = terminal.durationMs ?? live.durationMs ?? transcript.durationMs;
  return {
    id: transcript.id,
    kind: transcript.kind,
    turn: transcript.turn,
    status: terminal.status,
    activity: structuredClone(activity),
    ...(live.agentName ?? transcript.agentName ? { agentName: live.agentName ?? transcript.agentName } : {}),
    ...(live.startedAt ?? transcript.startedAt ? { startedAt: live.startedAt ?? transcript.startedAt } : {}),
    ...(live.request ?? transcript.request ? { request: live.request ?? transcript.request } : {}),
    ...(terminal.response ?? live.response ?? transcript.response ? { response: terminal.response ?? live.response ?? transcript.response } : {}),
    ...(live.modelName ?? transcript.modelName ? { modelName: live.modelName ?? transcript.modelName } : {}),
    ...(live.thinkingLevel ?? transcript.thinkingLevel ? { thinkingLevel: live.thinkingLevel ?? transcript.thinkingLevel } : {}),
    ...(live.runId ?? transcript.runId ? { runId: live.runId ?? transcript.runId } : {}),
    ...(live.threadId ?? transcript.threadId ? { threadId: live.threadId ?? transcript.threadId } : {}),
    ...(live.action ?? transcript.action ? { action: live.action ?? transcript.action } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage ? { usage: { ...usage } } : {}),
    ...(sessionUsage ? { sessionUsage: { ...sessionUsage } } : {}),
  };
}

export function mergeDelegatedRuns(
  transcript: readonly DelegatedAgentRunReadModel[],
  live: readonly DelegatedAgentRunReadModel[],
): DelegatedAgentRunReadModel[] {
  const runs = new Map(transcript.map((run) => [run.id, structuredClone(run)]));
  for (const run of live) {
    const persisted = runs.get(run.id);
    runs.delete(run.id);
    runs.set(run.id, persisted ? mergeDelegatedRun(persisted, run) : structuredClone(run));
  }
  while (runs.size > MAX_DELEGATED_RUNS) {
    const terminal = [...runs].find(([, run]) => run.status !== "running");
    runs.delete(terminal?.[0] ?? runs.keys().next().value!);
  }
  return [...runs.values()];
}

export function browserJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(browserValue(value), null, 2).slice(0, MAX_TEXT); }
  catch { return "[unserializable input]"; }
}

export function latestVisibleUserIndex(messages: unknown[], end = messages.length): number | undefined {
  for (let index = Math.min(messages.length, Math.max(0, Math.floor(end))) - 1; index >= 0; index--) {
    const raw = object(messages[index]);
    if (role(raw.role) === "user" && !promptFileCount(raw)) return index;
  }
  return undefined;
}

export function projectConversation(
  messages: unknown[],
  options: { start?: number; end?: number; includeDelegated?: boolean; limitMessages?: boolean; toolDurations?: ReadonlyMap<string, number> } = {},
): Pick<ConversationReadModel, "messages" | "delegatedRuns"> {
  const start = Math.min(messages.length, Math.max(0, Math.floor(options.start ?? Math.max(0, messages.length - MAX_MESSAGES))));
  const end = Math.min(messages.length, Math.max(start, Math.floor(options.end ?? messages.length)));
  const includeDelegated = options.includeDelegated !== false;
  const pinnedUserIndex = latestVisibleUserIndex(messages, end) ?? -1;
  const completedToolStatuses = new Map<string, "completed" | "failed">();
  for (const message of messages) {
    const raw = object(message);
    if (role(raw.role) === "tool" && typeof raw.toolCallId === "string") {
      const previous = completedToolStatuses.get(raw.toolCallId);
      if (raw.isError === true || previous !== "failed") {
        completedToolStatuses.set(raw.toolCallId, raw.isError === true ? "failed" : "completed");
      }
    }
  }
  const projectedToolResultIds = new Set(messages.slice(0, end).flatMap((message) => {
    const raw = object(message);
    return role(raw.role) === "tool" && typeof raw.toolCallId === "string" ? [raw.toolCallId] : [];
  }));
  const toolCalls = new Map<string, { name: string; rawInput?: unknown; turn: number }>();
  const delegatedRuns = new Map<string, DelegatedAgentRunReadModel>();
  const spawnRunIds = new Map<string, string>();
  const projectedMessages: MessageReadModel[] = [];
  let latestProjectedUser: MessageReadModel | undefined;
  let userTurn = 0;
  for (let index = 0; index < end; index++) {
    const message = messages[index];
    const raw = object(message);
    if (continuityCompactionInterruptionId(raw)) continue;
    const messageRole = role(raw.role);
    if (messageRole === "user") userTurn++;
    const fileCount = promptFileCount(raw);
    if (fileCount) {
      if (latestProjectedUser) latestProjectedUser.fileAttachmentCount = fileCount;
      continue;
    }
    const unmatchedCalls: MessageReadModel[] = [];
    if (messageRole === "assistant" && Array.isArray(raw.content)) {
      for (const [partIndex, part] of raw.content.entries()) {
        const item = object(part);
        if (item.type !== "toolCall" || typeof item.id !== "string") continue;
        const name = text(item.name, 200) || "Tool";
        toolCalls.set(item.id, { name, rawInput: item.arguments, turn: userTurn });
        const kind = delegatedAgentKind(name, item.arguments);
        if (includeDelegated && kind) {
          delegatedRuns.set(item.id, updateDelegatedRun(undefined, kind, item.id, userTurn, item.arguments, undefined, "running"));
          trimMap(delegatedRuns, MAX_DELEGATED_RUNS);
        }
        if (index >= start && !projectedToolResultIds.has(item.id)) unmatchedCalls.push({
          id: `history-${index}-tool-${partIndex}`,
          role: "tool",
          text: "",
          streaming: false,
          tool: {
            id: id(item.id, `history-${index}-tool-${partIndex}`),
            name,
            input: browserJson(item.arguments),
            status: completedToolStatuses.get(item.id) ?? "running",
            ...(options.toolDurations?.get(item.id) === undefined ? {} : { durationMs: options.toolDurations.get(item.id) }),
          },
        });
      }
    }
    if (messageRole === "tool") {
      const fallbackId = `history-${index}`;
      const toolId = id(raw.toolCallId, fallbackId);
      const call = toolCalls.get(toolId);
      const name = text(raw.toolName, 200) || call?.name || "Tool";
      const kind = delegatedAgentKind(name, call?.rawInput);
      const controlKind = spawnToolKind(name);
      const control = controlKind && spawnControlActions.has(String(spawnAction(call?.rawInput)));
      if (includeDelegated && kind) {
        const details = object(raw.details);
        const run = updateDelegatedRun(
          delegatedRuns.get(toolId), kind, toolId, call?.turn ?? userTurn, call?.rawInput, raw,
          delegatedEndStatus(raw, kind, details),
        );
        delegatedRuns.set(toolId, run);
        if (run.runId) spawnRunIds.set(run.runId, toolId);
        trimMap(delegatedRuns, MAX_DELEGATED_RUNS);
      } else if (includeDelegated && control) {
        const details = object(raw.details);
        const canonicalId = spawnRunIds.get(delegatedId(details.runId) ?? "");
        const previous = canonicalId ? delegatedRuns.get(canonicalId) : undefined;
        if (canonicalId && validSpawnControlTarget(previous, controlKind, details)) {
          const status = delegatedEndStatus(raw, controlKind, details);
          if (previous.status === "running" || status === previous.status) delegatedRuns.set(canonicalId, updateDelegatedRun(
            previous, controlKind, canonicalId, previous.turn, undefined, raw, status,
          ));
        }
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
          ...(options.toolDurations?.get(toolId) === undefined ? {} : { durationMs: options.toolDurations.get(toolId) }),
        },
      });
      continue;
    }
    if (index < start && index !== pinnedUserIndex) continue;
    const images = attachmentCount(raw);
    const compaction = compactionMessage(raw.compaction);
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
      ...(compaction ? { compaction } : {}),
    };
    projectedMessages.push(result, ...unmatchedCalls);
    if (messageRole === "user") latestProjectedUser = result;
  }
  return {
    messages: options.limitMessages === false ? projectedMessages : latestMessages(projectedMessages),
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
  private readonly toolInputs = new Map<string, unknown>();
  private readonly spawnRunIds = new Map<string, string>();
  private pendingUpdate?: { id: string; text: string };
  private updateTimer?: NodeJS.Timeout;
  private updateBytes = 0;
  private activeMessageId?: string;
  private latestAssistantMessageId?: string;
  private messageCounter = 0;
  private readonly turnMessages = new Map<string, string>();
  private readonly unseenCompletions = new Set<string>();
  pendingUi?: UiRequestReadModel;

  constructor(private runtime: RuntimeSnapshot, private readonly publish: Publish) {
    for (const message of runtime.conversation.messages) this.messages.set(message.id, { ...message });
    for (const tool of runtime.conversation.tools) this.tools.set(tool.id, { ...tool });
    for (const run of runtime.conversation.delegatedRuns) {
      this.delegatedRuns.set(run.id, structuredClone(run));
      if (run.runId) this.spawnRunIds.set(run.runId, run.id);
    }
  }

  snapshot(): RuntimeSnapshot {
    return {
      ...this.runtime,
      conversation: {
        ...this.runtime.conversation,
        messages: [...this.messages.values()].map((message) => ({ ...message })),
        tools: [...this.tools.values()].slice(-MAX_TOOLS).map((tool) => ({ ...tool })),
        delegatedRuns: [...this.delegatedRuns.values()].slice(-MAX_DELEGATED_RUNS).map((run) => structuredClone(run)),
      },
      operational: cloneOperational(this.runtime.operational),
      ...(this.runtime.providerAuth ? { providerAuth: structuredClone(this.runtime.providerAuth) } : {}),
      extensionUi: {
        ...this.runtime.extensionUi,
        notifications: this.runtime.extensionUi.notifications.map((item) => ({ ...item })),
        statuses: this.runtime.extensionUi.statuses.map((item) => ({ ...item })),
        widgets: this.runtime.extensionUi.widgets.map((item) => ({ ...item, lines: [...item.lines] })),
      },
    };
  }

  unseenCompletionSessionIds(): string[] { return [...this.unseenCompletions]; }

  refresh(runtime: RuntimeSnapshot): void {
    const finalAssistant = [...runtime.conversation.messages].reverse()
      .find((message) => message.role === "assistant" && !message.streaming);
    if (finalAssistant) this.reconcileAssistant(finalAssistant);
    for (const run of runtime.conversation.delegatedRuns) {
      const previous = this.delegatedRuns.get(run.id);
      if (run.status === "running" || (previous && previous.status !== "running")) continue;
      const next = previous ? {
        ...structuredClone(previous),
        ...structuredClone(run),
        activity: structuredClone(run.activity.length > previous.activity.length ? run.activity : previous.activity),
      } : structuredClone(run);
      if (!previous || !isDeepStrictEqual(previous, next)) this.setDelegatedRun(next);
    }
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
      providerAuth: runtime.providerAuth ? structuredClone(runtime.providerAuth) : undefined,
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
        agentError: runtime.conversation.agentError,
      },
      operational: cloneOperational(runtime.operational),
    };
    this.publish("session.controls", this.runtime.sessionControls);
    if (this.runtime.providerAuth) this.publish("provider.auth", this.runtime.providerAuth);
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
    this.latestAssistantMessageId = undefined;
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
      const sessionId = event.sessionId.slice(0, 128);
      if (event.completed && validCompletionSessionId(sessionId) && sessionId !== this.runtime.sessionId) {
        this.unseenCompletions.delete(sessionId);
        this.unseenCompletions.add(sessionId);
        while (this.unseenCompletions.size > MAX_UNSEEN_COMPLETIONS) {
          this.unseenCompletions.delete(this.unseenCompletions.values().next().value!);
        }
      }
      this.publish("session.status", {
        sessionId,
        state: event.state,
        ...(Object.hasOwn(event, "workStartedAt") ? { workStartedAt: event.workStartedAt } : {}),
        ...(event.completed ? { completed: true } : {}),
        ...(event.cue ? { cue: event.cue } : {}),
      });
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
          ...(typeof raw.timeoutSeconds === "number" ? { timeoutSeconds: Math.min(86_400, Math.max(1, Math.round(raw.timeoutSeconds))) } : {}),
          ...(typeof raw.expiresAt === "string" && !Number.isNaN(Date.parse(raw.expiresAt)) ? { expiresAt: raw.expiresAt } : {}),
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
      const operational = cloneOperational(event.operational);
      this.runtime.operational = operational;
      this.publish(`operational.${event.channel}`, operational);
      return;
    }
    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      const sessionId = event.sessionId.slice(0, 128);
      this.unseenCompletions.delete(sessionId);
      this.replaceRuntime(structuredClone(event.runtime));
      this.runtime.sessionId = sessionId;
      this.runtime.sessionGeneration = event.sessionGeneration;
      this.runtime.ready = event.type === "session.replaced";
      this.publish(event.type, { sessionId, sessionGeneration: event.sessionGeneration });
      return;
    }
    if (event.type === "command.result") {
      this.runtime.commandResult = event.result ? structuredClone(event.result) : undefined;
      this.publish("command.result", event.result ?? {});
      return;
    }
    if (event.type !== "session.event") return;
    const raw = object(event.payload);
    const kind = String(raw.type ?? raw.event ?? raw.kind ?? "").replace(/-/g, "_");
    if (kind === "message_start" || kind === "message_starting") return this.messageStart(raw);
    if (kind === "message_update" || kind === "message_delta") return this.messageUpdate(raw);
    if (kind === "message_end" || kind === "message_complete") return this.messageEnd(raw);
    if (kind === "continuity_compaction_interruption") return this.removeActiveMessage(raw);
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
      this.latestAssistantMessageId = undefined;
      if (raw.metrics) this.metrics(object(raw.metrics));
      const startedAt = this.runtime.conversation.workStartedAt ?? (typeof raw.workStartedAt === "string" && !Number.isNaN(Date.parse(raw.workStartedAt))
        ? raw.workStartedAt
        : new Date().toISOString());
      this.runtime.conversation.workStartedAt = startedAt;
      this.runtime.conversation.workModelName = text(raw.modelName, 200) || undefined;
      this.runtime.conversation.workThinkingLevel = thinkingLevel(raw.thinkingLevel);
      this.runtime.conversation.stopping = false;
      this.runtime.conversation.stoppedRun = undefined;
      this.runtime.conversation.agentError = undefined;
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
      const willRetry = raw.willRetry === true && raw.stopped !== true;
      if (!willRetry && kind === "agent_end") this.flush();
      const assistant = !willRetry && kind === "agent_end"
        ? this.reconcileFinalAssistant(raw)
        : [...this.messages.values()].reverse().find((message) => message.role === "assistant");
      const turnId = id(raw.turnId, "");
      if (!willRetry && assistant && turnId) {
        this.turnMessages.set(turnId, assistant.id);
        trimMap(this.turnMessages, 20);
      }
      if (!willRetry && assistant && durationMs !== undefined) {
        assistant.workDurationMs = durationMs;
        assistant.modelName = text(raw.modelName, 200) || undefined;
        assistant.thinkingLevel = thinkingLevel(raw.thinkingLevel);
        this.messages.set(assistant.id, assistant);
      }
      if (!willRetry) {
        this.activeMessageId = undefined;
        this.runtime.conversation.streaming = false;
        this.runtime.conversation.workStartedAt = undefined;
        this.runtime.conversation.workModelName = undefined;
        this.runtime.conversation.workThinkingLevel = undefined;
      }
      const stopped = raw.stopped === true;
      this.settleRunningWork(terminalActivityStatus(
        kind === "agent_error" ? "error" : "end",
        { stopped, willRetry },
      ));
      this.runtime.conversation.stopping = false;
      const agentError = willRetry ? undefined : text(raw.errorMessage, 1_000) || undefined;
      this.runtime.conversation.agentError = agentError;
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
        willRetry,
        message: agentError,
        durationMs,
        turnId,
        messageId: assistant?.id,
        assistantMessage: !willRetry && kind === "agent_end" && assistant ? { ...assistant, streaming: false } : null,
        modelName: assistant?.modelName,
        thinkingLevel: assistant?.thinkingLevel,
        gitBranch: this.runtime.gitBranch,
        stopped,
        userEntryId: this.runtime.conversation.stoppedRun?.userEntryId,
      });
    }
  }

  private settleRunningWork(status: "completed" | "failed"): void {
    const settled = settleRunningActivities({
      messages: [...this.messages.values()],
      tools: [...this.tools.values()],
      delegatedRuns: [...this.delegatedRuns.values()],
    }, status);
    this.messages.clear();
    for (const message of settled.messages) this.messages.set(message.id, message);
    this.tools.clear();
    for (const tool of settled.tools) this.tools.set(tool.id, tool);
    this.delegatedRuns.clear();
    for (const run of settled.delegatedRuns) this.delegatedRuns.set(run.id, run);
  }

  private reconcileFinalAssistant(raw: Record<string, unknown>): MessageReadModel | undefined {
    if (raw.assistantMessage === null) return undefined;
    const value = object(raw.assistantMessage);
    if (value.role !== "assistant" || typeof value.id !== "string" || typeof value.text !== "string") return undefined;
    return this.reconcileAssistant(value as unknown as MessageReadModel);
  }

  private reconcileAssistant(canonical: MessageReadModel): MessageReadModel {
    let current = this.messages.get(canonical.id);
    if (!current && canonical.entryId) {
      current = [...this.messages.values()].find((message) => message.entryId === canonical.entryId);
    }
    if (!current && this.latestAssistantMessageId) {
      const live = this.messages.get(this.latestAssistantMessageId);
      if (live?.role === "assistant" && live.text === canonical.text) current = live;
    }
    const missing = !current;
    const unfinished = current?.streaming === true;
    const reconciled = { ...canonical, id: current?.id ?? canonical.id, streaming: false };
    this.messages.set(reconciled.id, reconciled);
    this.latestAssistantMessageId = reconciled.id;
    if (missing) this.publish("message.start", { ...reconciled, streaming: true });
    if (missing || unfinished) {
      this.publish("message.end", { id: reconciled.id, text: reconciled.text, entryId: reconciled.entryId });
    }
    return reconciled;
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
    const correlatedId = typeof raw.clientMessageId === "string"
      ? id(`pending-${raw.clientMessageId}`, "")
      : "";
    const messageId = correlatedId || id(raw.messageId ?? raw.id ?? message.id, `message-${++this.messageCounter}`);
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
        ...(activity?.startedAt ? { startedAt: activity.startedAt } : {}),
        ...(activity?.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
      };
    }
    this.messages.set(messageId, item);
    if (item.role === "assistant") this.latestAssistantMessageId = messageId;
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
    if (current.role === "assistant") this.latestAssistantMessageId = messageId;
    this.pendingUpdate = { id: messageId, text: current.text };
    this.updateBytes += Buffer.byteLength(incoming || full);
    if (this.updateBytes >= MAX_PAYLOAD_TEXT) this.flush();
    else if (!this.updateTimer) { this.updateTimer = setTimeout(() => this.flush(), STREAM_FLUSH_MS); this.updateTimer.unref?.(); }
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
  private removeActiveMessage(raw: Record<string, unknown>): void {
    this.flush();
    const messageId = this.activeMessageId ?? id(raw.messageId ?? raw.id ?? object(raw.message).id, "message");
    this.messages.delete(messageId);
    if (this.latestAssistantMessageId === messageId) this.latestAssistantMessageId = undefined;
    this.activeMessageId = undefined;
    this.runtime.conversation.streaming = false;
    this.publish("message.remove", { id: messageId });
  }

  private toolStart(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, `tool-${this.tools.size + 1}`);
    const name = text(raw.name ?? raw.toolName, 200);
    const input = raw.args ?? raw.input;
    const startedAt = createdAt(raw.startedAt) ?? new Date().toISOString();
    this.toolInputs.set(toolId, input);
    const item: ToolActivityReadModel = { id: toolId, name, input: browserJson(input), status: "running", startedAt };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.start", item);
    const run = projectDelegatedToolEvent("start", toolId, undefined, raw, this.runtime.metrics.userMessages);
    if (run) this.setDelegatedRun(run);
  }
  private toolUpdate(raw: Record<string, unknown>): void {
    const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, "tool");
    const old = this.delegatedRuns.get(toolId);
    const next = projectDelegatedToolEvent("update", toolId, old, raw, this.runtime.metrics.userMessages);
    if (!next) return;
    if (old && equalDelegatedRunExceptDuration(old, next)) {
      this.delegatedRuns.set(toolId, next);
      return;
    }
    const appendsActivity = Array.isArray(object(object(raw.partialResult).details).activityDelta);
    this.setDelegatedRun(next, old, appendsActivity);
  }
  private toolEnd(raw: Record<string, unknown>): void {
    this.flush(); const toolId = id(raw.toolCallId ?? raw.toolId ?? raw.id, "tool"); const old = this.tools.get(toolId);
    const input = this.toolInputs.get(toolId) ?? raw.args ?? raw.input;
    this.toolInputs.delete(toolId);
    const name = old?.name ?? text(raw.name ?? raw.toolName, 200);
    const startedAt = createdAt(raw.startedAt) ?? old?.startedAt;
    const projectedDuration = boundedNumber(raw.durationMs, 7 * 24 * 60 * 60 * 1_000);
    const durationMs = projectedDuration ?? (startedAt ? Math.min(7 * 24 * 60 * 60 * 1_000, Math.max(0, Date.now() - Date.parse(startedAt))) : undefined);
    const item: ToolActivityReadModel = { id: toolId, name, input: old?.input ?? browserJson(input), status: raw.isError === true || raw.failed === true || raw.error ? "failed" : "completed", summary: text(raw.summary ?? raw.error ?? raw.output, 4_000) || undefined, ...(startedAt ? { startedAt } : {}), ...(durationMs === undefined ? {} : { durationMs }) };
    this.tools.set(toolId, item); trimMap(this.tools, MAX_TOOLS); this.publish("tool.end", item);
    const event = { ...raw, name, args: input };
    const previous = this.delegatedRuns.get(toolId);
    const run = projectDelegatedToolEvent("end", toolId, previous, event, this.runtime.metrics.userMessages);
    if (run) {
      this.setDelegatedRun(run, previous);
      if (run.runId) this.spawnRunIds.set(run.runId, run.id);
      return;
    }
    const controlKind = spawnToolKind(name);
    if (!controlKind || !spawnControlActions.has(String(spawnAction(input)))) return;
    const details = object(object(raw.result ?? raw).details);
    const canonicalId = this.spawnRunIds.get(delegatedId(details.runId) ?? "");
    const target = canonicalId ? this.delegatedRuns.get(canonicalId) : undefined;
    if (!canonicalId || !validSpawnControlTarget(target, controlKind, details)) return;
    const status = delegatedEndStatus(raw, controlKind, details);
    if (target.status !== "running" && status !== target.status) return;
    const next = updateDelegatedRun(target, controlKind, canonicalId, target.turn, undefined, raw.result ?? raw, status);
    this.setDelegatedRun(next, target);
  }
  private setDelegatedRun(run: DelegatedAgentRunReadModel, previous?: DelegatedAgentRunReadModel, appendsActivity = false): void {
    this.delegatedRuns.set(run.id, run);
    trimMap(this.delegatedRuns, MAX_DELEGATED_RUNS);
    for (const [runId, id] of this.spawnRunIds) if (!this.delegatedRuns.has(id)) this.spawnRunIds.delete(runId);
    const publishAppend = previous && (appendsActivity || run.activity === previous.activity
      || run.activity.length >= previous.activity.length
        && isDeepStrictEqual(run.activity.slice(0, previous.activity.length), previous.activity));
    this.publish("delegate.update", structuredClone(publishAppend
      ? { ...run, activity: run.activity.slice(previous.activity.length), activityMode: "append", activityBase: previous.activity.length }
      : run));
  }
  private queue(raw: Record<string, unknown>): void { this.runtime.conversation.queue = { steering: Array.isArray(raw.steering) ? raw.steering.length : Number.isSafeInteger(raw.steering) ? Math.max(0, raw.steering as number) : 0, followUp: Array.isArray(raw.followUp) ? raw.followUp.length : Number.isSafeInteger(raw.followUp) ? Math.max(0, raw.followUp as number) : 0 }; this.publish("queue.update", this.runtime.conversation.queue); }
  private retry(raw: Record<string, unknown>, kind: string): void { this.runtime.conversation.retry = { active: kind !== "retry_end" && kind !== "auto_retry_end" && raw.active !== false, attempt: typeof raw.attempt === "number" ? raw.attempt : undefined, maxAttempts: typeof raw.maxAttempts === "number" ? raw.maxAttempts : undefined, message: text(raw.message ?? raw.errorMessage ?? raw.finalError, 1_000) || undefined }; this.publish("retry.update", this.runtime.conversation.retry); }
  private compaction(raw: Record<string, unknown>, kind: string): void {
    this.runtime.conversation.compaction = {
      active: kind !== "compaction_end" && raw.active !== false,
      reason: raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow" ? raw.reason : undefined,
    };
    const completed = object(raw.completedMessage);
    const metadata = compactionMessage(completed.compaction);
    let item: MessageReadModel | undefined;
    if (kind === "compaction_end" && metadata && completed.role === "system"
      && typeof completed.id === "string" && typeof completed.entryId === "string") {
      const existing = [...this.messages.values()].find((message) => message.entryId === completed.entryId);
      item = {
        id: existing?.id ?? id(completed.id, `compaction-${completed.entryId}`),
        entryId: id(completed.entryId, completed.id),
        role: "system",
        text: text(completed.text),
        streaming: false,
        ...(createdAt(completed.createdAt) ? { createdAt: createdAt(completed.createdAt) } : {}),
        systemSource: "pylon-compaction",
        compaction: metadata,
      };
      this.messages.set(item.id, item);
    }
    this.publish("compaction.update", item
      ? { ...this.runtime.conversation.compaction, completedMessage: item }
      : this.runtime.conversation.compaction);
  }
  private metrics(raw: Record<string, unknown>): void {
    const current = this.runtime.metrics as unknown as Record<string, unknown>;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "contextTokens", "contextLimit", "contextPercent", "cost", "userMessages", "assistantMessages", "toolCalls"]) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key])) current[key] = raw[key];
    }
    if (Array.isArray(raw.toolUsage)) {
      const names = new Set<string>();
      current.toolUsage = raw.toolUsage.slice(0, 200).flatMap((item) => {
        const usage = object(item);
        const name = typeof usage.name === "string" ? usage.name.slice(0, 200) : "";
        if (!name || names.has(name) || !Number.isSafeInteger(usage.calls) || Number(usage.calls) < 0
          || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
          || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0
          || !Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0
          || Number(usage.tokens) !== Number(usage.inputTokens) + Number(usage.outputTokens)) return [];
        names.add(name);
        return [{ name, calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, tokens: usage.tokens }];
      });
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

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  activeAssistantEntryIds,
  appendToolDuration,
  appendTurnGitBranch,
  appendWorkDuration,
  MAX_WORK_DURATION_MS,
  readPersistedToolDurations,
  readPersistedTurnGitBranches,
  readPersistedWorkDurations,
} from "pylon-core/src/work-duration.ts";
import {
  inspectGitWorkspace,
  parseWorktreeSummary,
  readPersistedWorktreeSummaries,
  removeSessionRef,
  turnTreeDiff,
  turnsBranchForSession,
  WORKTREE_SUMMARY_ENTRY_TYPE,
} from "pylon-core/src/worktree.ts";
import { estimatedTokens, meterFromBranch } from "pylon-core/src/token-meter.ts";
import { listSessionInventory, resolveUniqueSession, type SessionInventoryEntry } from "pylon-core/session-inventory";
import {
  buildSessionContext,
  createAgentSessionRuntime,
  createEventBus,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  type AgentSession,
  type CompactionEntry,
  type SessionInfo,
  type EventBusController,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARD_RULES } from "../../shared/guard-policy.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { AcceptedCommand, QueuedPromptPayload } from "../../shared/protocol/commands.ts";
import type { HeliosBrowserInput, HeliosBrowserResult, HeliosPageIdentity } from "../../shared/protocol/helios.ts";
import type {
  HeliosAndroidToolingCommand,
  HeliosAndroidToolingResult,
} from "../../shared/protocol/helios-android-tooling.ts";
import {
  MAX_COMPACTION_DISPLAY_HISTORY_ITEMS,
  MAX_COMPACTION_DISPLAY_PATH,
  MAX_COMPACTION_DISPLAY_RECORDS,
  MAX_COMPACTION_DISPLAY_SOURCE_ID,
  MAX_COMPACTION_DISPLAY_TEXT,
} from "../../shared/protocol/events.ts";
import type {
  ChangedFileReadModel,
  CompactionDisplayReadModel,
  DelegatedAgentRunReadModel,
  MessageReadModel,
  ModelOptionReadModel,
  ProviderAuthReadModel,
  ProviderAuthType,
  SessionRuntimeState,
  SlashCommandResultReadModel,
  ToolUsageReadModel,
} from "../../shared/protocol/events.ts";
import type {
  ArchiveListQuery,
  ArchiveListSnapshot,
  ConversationAttachmentContent,
  ConversationAttachmentQuery,
  ConversationHistoryPage,
  ConversationHistoryQuery,
  ConversationTurnIndexPage,
  ConversationTurnIndexQuery,
  DiscoverIndexReadModel,
  ExtensionListSnapshot,
  FileSuggestionList,
  HookSettingsSnapshot,
  PackageListSnapshot,
  PackageSettingsReadModel,
  PapercutListPage,
  PapercutMutationResult,
  PapercutStatusReadModel,
  RuntimeDiagnostic,
  UsageQuery,
  UsageSnapshot,
  RuntimePolicyReadModel,
  RuntimeSnapshot,
  SessionListQuery,
  SessionListSnapshot,
  StateQLCommandInput,
  StateQLCommandResult,
  StateQLCommandResponseReadModel,
  StateQLRowsPage,
  StateQLSnapshot,
  TimelineCheckpointDiff,
  TimelineCheckpointFiles,
  TurnDiffQuery,
  TurnDiffResult,
  VerifyPolicyReadModel,
} from "../../shared/protocol/snapshots.ts";
import { isPapercutListPage, isStateQLCommandInput, isStateQLRowsPage, isStateQLSnapshot } from "../../shared/protocol/validation.ts";
import { GenerationGate } from "./generation-gate.ts";
import type {
  DeleteSessionInput,
  DeleteContinuityMemoryInput,
  MigrateContinuityMemoryInput,
  ContinuityPlanActionInput,
  DriverEvent,
  DriverEventListener,
  EditPromptInput,
  FileSuggestionInput,
  ForkInput,
  NewSessionInput,
  PiDriver,
  PapercutMutationInput,
  ProjectInput,
  ProjectArchiveInput,
  PromptInput,
  QueueMutationInput,
  RewindPromptInput,
  ReorderActiveSessionInput,
  ReorderProjectInput,
  RemoveProjectInput,
  RenameProjectInput,
  ReplacementResult,
  RuntimeHandle,
  RuntimeTarget,
  RenameSessionInput,
  SetExtensionEnabledInput,
  ExtensionPackageInput,
  SetProjectTrustInput,
  SetPackageEnabledInput,
  SetModelInput,
  SetSessionActiveInput,
  SetSessionPinnedInput,
  SetThinkingLevelInput,
  SetSessionControlsInput,
  StartProviderLoginInput,
  SessionArchiveInput,
  SwitchSessionInput,
  TimelineCheckpointDiffInput,
  TimelineCheckpointInput,
  UpdateContinuityMemoryInput,
  UpdatePackageSettingsInput,
  UpdateHookSettingsInput,
  UpdateRuntimePolicyInput,
  UpdateToolPolicyInput,
} from "./pi-driver.ts";
import { RemoteUiBridge, type ProviderAuthPrompt, type UiRequest, type UiResponse } from "./remote-ui-context.ts";
import type { StateQLCredentialVault } from "./stateql-credential-vault.ts";
import { createPylonModelRuntime, createPylonRuntimeFactory } from "./runtime-factory.ts";
import {
  applyOperationalEvent,
  cloneOperational,
  initialOperational,
  withOperationalCapabilities,
} from "./operational-projections.ts";
import { PackageCatalog, type PackageCatalogState } from "./package-catalog.ts";
import { PiExtensionManager } from "./pi-extension-manager.ts";
import {
  PROMPT_FILES_CUSTOM_TYPE,
  PROMPT_IMAGE_ATTACHMENT_VERSION,
  PromptAttachmentBridge,
  promptFilesMessage,
} from "./prompt-attachments.ts";
import { HookInjectionBridge } from "./hook-injection.ts";
import { HookSettingsStore } from "./hook-settings.ts";
import { WorkspaceApplyTool, type WorkspaceApplyToolInfo } from "./workspace-apply-tool.ts";
import {
  continuityCompactionInterruptionId,
  decodeHistoryCursor,
  decodeTurnIndexCursor,
  encodeHistoryCursor,
  encodeTurnIndexCursor,
  HISTORY_PAGE_SIZE,
  browserJson,
  latestVisibleUserIndex,
  mergeDelegatedRuns,
  projectConversation,
  projectConversationTurnIndex,
  projectDelegatedToolEvent,
} from "./projections.ts";
import { invalidateFileSuggestions, suggestGitFiles } from "./file-suggestions.ts";
import { projectIdForCwd, SessionIndex } from "./session-index.ts";
import { ProjectRegistry } from "./project-registry.ts";

interface TrashAttempt {
  status: number | null;
  error?: NodeJS.ErrnoException;
  stderr?: string | null;
}

interface TimelineEditTransaction {
  apply(): Promise<void>;
  rollback(): Promise<void>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
}

function cloneVerifyPolicy(value: VerifyPolicyReadModel): VerifyPolicyReadModel {
  return value.mode === "auto" ? { mode: "auto" } : { mode: "selected", checks: [...value.checks] };
}

const cloneToolOverrides = (value: RuntimePolicyReadModel["effective"]["toolOverrides"]) => ({ ...(value ?? {}) });

function defaultRuntimePolicy(): RuntimePolicyReadModel {
  return {
    revision: 0,
    global: {
      timelineEnabled: true,
      guardEnabled: true,
      guardRules: { ...DEFAULT_GUARD_RULES },
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
      toolOverrides: {},
    },
    project: { verify: { mode: "auto" }, toolOverrides: {} },
    session: { toolOverrides: {} },
    effective: {
      verify: { mode: "auto" },
      timelineEnabled: true,
      guardEnabled: true,
      guardRules: { ...DEFAULT_GUARD_RULES },
      workspace: "local",
      guardTimeoutSeconds: 60,
      clarifyTimeoutSeconds: 60,
      toolOverrides: {},
    },
    availableVerifyChecks: [],
  };
}

function agentWasAborted(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.messages)) return false;
  for (let index = value.messages.length - 1; index >= 0; index--) {
    const message = value.messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const item = message as Record<string, unknown>;
    if (item.role === "assistant") return item.stopReason === "aborted";
  }
  return false;
}

const CONTINUITY_COMPACTION_CHANNEL = "pi-continuity:compaction-continuation";
type ContinuityCompactionContinuation = {
  requestId: string;
  sessionId: string;
  sessionGeneration: number;
  taskGeneration: number;
  resuming?: boolean;
  abandoned?: boolean;
  interruptedAgentEnded?: boolean;
  interruption?: { durationMs: number; assistantEntryId?: string };
};

function parseContinuityCompactionContinuation(
  value: unknown,
): (ContinuityCompactionContinuation & { action: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !["begin", "resume", "abandon"].includes(String(raw.action)) ||
    typeof raw.requestId !== "string" ||
    !raw.requestId ||
    raw.requestId.length > 128 ||
    typeof raw.sessionId !== "string" ||
    !raw.sessionId ||
    raw.sessionId.length > 128 ||
    !Number.isSafeInteger(raw.sessionGeneration) ||
    Number(raw.sessionGeneration) < 0 ||
    !Number.isSafeInteger(raw.taskGeneration) ||
    Number(raw.taskGeneration) < 0
  )
    return undefined;
  return {
    action: raw.action as string,
    requestId: raw.requestId,
    sessionId: raw.sessionId,
    sessionGeneration: Number(raw.sessionGeneration),
    taskGeneration: Number(raw.taskGeneration),
  };
}

const PYLON_COMPACTION_SOURCE = "pylon-compaction";

function compactionSourceEntryCount(details: unknown): number | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  return raw.type === "pi-continuity-compaction" &&
    (raw.version === 1 || raw.version === 2 || raw.version === 3) &&
    Number.isSafeInteger(raw.sourceEntryCount) &&
    Number(raw.sourceEntryCount) >= 0
    ? Number(raw.sourceEntryCount)
    : undefined;
}

function compactionDisplay(details: unknown): CompactionDisplayReadModel | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  const bounded = (value: unknown, maximum: number, required = false) =>
    typeof value === "string" && value.length <= maximum && (!required || value.length > 0);
  const historyRecord = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.path, MAX_COMPACTION_DISPLAY_PATH, true) &&
      (item.sourceEntryId === undefined || bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID))
    );
  };
  const record = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) &&
      (item.role === "user" || item.role === "assistant" || item.role === "tool" || item.role === "summary") &&
      bounded(item.text, MAX_COMPACTION_DISPLAY_TEXT, true) &&
      (item.isError === undefined || typeof item.isError === "boolean")
    );
  };
  const supplement = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) &&
      (item.role === "user" || item.role === "assistant" || item.role === "tool") &&
      (item.category === "constraint" ||
        item.category === "decision" ||
        item.category === "error" ||
        item.category === "outcome" ||
        item.category === "context") &&
      bounded(item.quote, 800, true) &&
      typeof item.sourceHash === "string" &&
      /^[a-f0-9]{64}$/.test(item.sourceHash) &&
      typeof item.quoteHash === "string" &&
      item.quoteHash ===
        createHash("sha256")
          .update(item.quote as string)
          .digest("hex")
    );
  };
  const history = raw.history as Record<string, unknown> | undefined;
  const generic = raw.mode === "generic";
  const activeWork = raw.mode === "active-work";
  // Persisted detail versions are trusted only when their exact shape is known.
  if (
    raw.type !== "pi-continuity-compaction" ||
    raw.version !== 3 ||
    (!generic && !activeWork) ||
    !Number.isSafeInteger(raw.sourceEntryCount) ||
    Number(raw.sourceEntryCount) < 0 ||
    (raw.currentTaskEntryId !== undefined && !bounded(raw.currentTaskEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID)) ||
    (activeWork &&
      (!bounded(raw.runId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) ||
        !bounded(raw.timelineId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) ||
        (raw.handoffEntryId !== undefined && !bounded(raw.handoffEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID)))) ||
    !history ||
    Array.isArray(history) ||
    !Array.isArray(history.read) ||
    history.read.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS ||
    !history.read.every(historyRecord) ||
    !Array.isArray(history.modified) ||
    history.modified.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS ||
    !history.modified.every(historyRecord) ||
    !Array.isArray(raw.supplements) ||
    raw.supplements.length > 8 ||
    !raw.supplements.every(supplement) ||
    (generic &&
      (!Array.isArray(raw.records) ||
        raw.records.length > MAX_COMPACTION_DISPLAY_RECORDS ||
        !raw.records.every(record)))
  )
    return undefined;
  const records = generic
    ? (raw.records as Array<Record<string, unknown>>)
    : (raw.supplements as Array<Record<string, unknown>>).map(item => ({
        sourceEntryId: item.sourceEntryId,
        role: item.role,
        text: item.quote,
        ...(item.category === "error" ? { isError: true } : {}),
      }));
  const source = (item: Record<string, unknown>) => ({
    sourceEntryId: item.sourceEntryId as string,
    text: item.text as string,
  });
  const historySource = (item: unknown) => {
    const record = item as Record<string, unknown>;
    return {
      path: record.path as string,
      ...(typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {}),
    };
  };
  return {
    records: records.flatMap(item =>
      item.role === "user" || item.role === "assistant" ? [{ ...source(item), role: item.role }] : [],
    ),
    failedTools: records.flatMap(item => (item.role === "tool" && item.isError === true ? [source(item)] : [])),
    toolResults: records.flatMap(item => (item.role === "tool" && item.isError !== true ? [source(item)] : [])),
    history: {
      read: (history.read as unknown[]).map(historySource),
      modified: (history.modified as unknown[]).map(historySource),
    },
  };
}

function compactionTranscriptMessage(branch: SessionEntry[], entry: CompactionEntry): Record<string, unknown> {
  const contextAfter = buildSessionContext(branch, entry.id).messages;
  const estimatedContextAfter = contextAfter.reduce((total, message) => total + estimateTokens(message), 0);
  const contextAfterTokens = Number.isFinite(estimatedContextAfter)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, estimatedContextAfter))
    : 0;
  const contextBeforeTokens =
    Number.isSafeInteger(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : undefined;
  const sourceEntryCount = compactionSourceEntryCount(entry.details);
  const display = compactionDisplay(entry.details);
  return {
    role: "custom",
    customType: PYLON_COMPACTION_SOURCE,
    display: true,
    content: entry.summary,
    entryId: entry.id,
    timestamp: entry.timestamp,
    compaction: {
      contextAfterTokens,
      ...(contextBeforeTokens === undefined ? {} : { contextBeforeTokens }),
      ...(sourceEntryCount === undefined ? {} : { sourceEntryCount }),
      ...(display ? { display } : {}),
    },
  };
}

function projectedCompactionMessage(branch: SessionEntry[], entry: CompactionEntry): MessageReadModel | undefined {
  const message = projectConversation([compactionTranscriptMessage(branch, entry)], { limitMessages: false })
    .messages[0];
  return message ? { ...message, id: `compaction-${entry.id}` } : undefined;
}

const MAX_HELIOS_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_HELIOS_FRAME_BASE64 = Math.ceil(MAX_HELIOS_FRAME_BYTES / 3) * 4;

function heliosPage(value: unknown): HeliosPageIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  if (
    !Number.isInteger(page.index) ||
    (page.index as number) < 0 ||
    (page.index as number) > 100 ||
    typeof page.title !== "string" ||
    page.title.length > 500 ||
    typeof page.url !== "string" ||
    page.url.length > 4096
  )
    return undefined;
  return { index: page.index as number, title: page.title, url: page.url };
}

function stateqlResult(value: unknown, sessionId: string, sessionGeneration: number): StateQLSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("StateQL returned an invalid snapshot");
  const raw = value as Record<string, any>;
  const closed = raw.session?.status === "closed";
  const candidate = {
    ...raw,
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    history: Array.isArray(raw.history)
      ? raw.history.map((item: any) => ({
          ...item,
          origin: ["legacy", "user", "model", "system", "api"].includes(String(item?.origin))
            ? item.origin
            : "legacy",
        }))
      : raw.history,
    ...(closed ? { connection: null, transaction: null } : {}),
  };
  if (!isStateQLSnapshot(candidate) || candidate.actor_id !== sessionId)
    throw new Error("StateQL returned an invalid snapshot");
  const snapshot = candidate as StateQLSnapshot;
  const result: StateQLSnapshot = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    session: { session_id: snapshot.session.session_id, name: snapshot.session.name, status: snapshot.session.status },
    actor_id: snapshot.actor_id,
    connection: snapshot.connection
      ? {
          connection_id: snapshot.connection.connection_id,
          name: snapshot.connection.name,
          status: snapshot.connection.status,
          driver: snapshot.connection.driver,
          database: snapshot.connection.database,
          read_only: snapshot.connection.read_only,
        }
      : null,
    transaction: snapshot.transaction
      ? {
          transaction_id: snapshot.transaction.transaction_id,
          owner_actor_id: snapshot.transaction.owner_actor_id,
          state: snapshot.transaction.state,
        }
      : null,
    state_version: snapshot.state_version,
    state_confidence: snapshot.state_confidence,
    recent_results: snapshot.recent_results.map(item => ({ alias: item.alias, handle: item.handle, rows: item.rows })),
    recent_operations: snapshot.recent_operations.map(item => ({
      handle: item.handle,
      actor_id: item.actor_id,
      type: item.type,
      affected_rows: item.affected_rows,
      status: item.status,
    })),
    history: snapshot.history.map(item => ({
      command_id: item.command_id,
      timestamp: item.timestamp,
      session_id: item.session_id,
      actor_id: item.actor_id,
      origin: item.origin,
      command: item.command,
      sql: item.sql,
      handle: item.handle,
      executed: item.executed,
      cached: item.cached,
      success: item.success,
      error_code: item.error_code,
    })),
  };
  // ponytail: reject escape-heavy aggregate payloads instead of budgeting for the protocol's theoretical JSON worst case.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 512 * 1024)
    throw new Error("StateQL returned an oversized snapshot");
  return result;
}

const MAX_STATEQL_ROWS_BYTES = 256 * 1024;

function stateqlJsonValue(value: unknown, depth: number, budget: { bytes: number }): unknown {
  if (depth > 6) throw new Error("StateQL returned invalid rows");
  budget.bytes++;
  if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    budget.bytes += Buffer.byteLength(String(value), "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 64 * 1024) throw new Error("StateQL returned invalid rows");
    budget.bytes += Buffer.byteLength(value, "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("StateQL returned invalid rows");
    return value.map(item => stateqlJsonValue(item, depth + 1, budget));
  }
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("StateQL returned invalid rows");
  }
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("StateQL returned invalid rows");
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of entries) {
    if (key.length > 500) throw new Error("StateQL returned invalid rows");
    budget.bytes += Buffer.byteLength(key, "utf8");
    if (budget.bytes > MAX_STATEQL_ROWS_BYTES) throw new Error("StateQL returned oversized rows");
    result[key] = stateqlJsonValue(item, depth + 1, budget);
  }
  return result;
}

function stateqlRowsResult(
  value: unknown,
  handle: string,
  offset: number,
  limit: number,
  actorId: string,
  sessionGeneration: number,
): StateQLRowsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("StateQL returned invalid rows");
  const raw = value as Record<string, unknown>;
  if (raw.result_id !== handle || raw.offset !== offset || raw.limit !== limit || !Array.isArray(raw.rows)) {
    throw new Error("StateQL returned invalid rows");
  }
  const budget = { bytes: 0 };
  const rows = raw.rows.map(row => stateqlJsonValue(row, 0, budget));
  const candidate = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    actor_id: actorId,
    handle,
    offset: raw.offset,
    limit: raw.limit,
    rows,
    returned: raw.returned,
    total: raw.total,
    truncated: raw.truncated,
    next_offset: raw.next_offset,
  };
  if (!isStateQLRowsPage(candidate)) throw new Error("StateQL returned invalid rows");
  const page = candidate as StateQLRowsPage;
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_STATEQL_ROWS_BYTES)
    throw new Error("StateQL returned oversized rows");
  return page;
}

function stateqlCommandResult(
  value: unknown,
  input: StateQLCommandInput,
  actorId: string,
  sessionGeneration: number,
): StateQLCommandResult {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    actor_id: actorId,
    command: input.command,
  } as const;
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).declined === true)
    return { ...base, status: "declined" };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("StateQL returned an invalid command response");
  const raw = value as Record<string, any>;
  if (
    typeof raw.ok !== "boolean" ||
    typeof raw.command_id !== "string" ||
    !raw.command_id ||
    raw.command_id.length > 128 ||
    typeof raw.session_id !== "string" ||
    !raw.session_id ||
    raw.session_id.length > 128 ||
    !raw.meta ||
    typeof raw.meta !== "object" ||
    !Number.isFinite(raw.meta.duration_ms) ||
    raw.meta.duration_ms < 0
  )
    throw new Error("StateQL returned an invalid command response");
  const meta = {
    duration_ms: raw.meta.duration_ms,
    ...(typeof raw.meta.state_version === "string" && raw.meta.state_version.length <= 128
      ? { state_version: raw.meta.state_version }
      : {}),
    ...(typeof raw.meta.state_confidence === "string" && raw.meta.state_confidence.length <= 100
      ? { state_confidence: raw.meta.state_confidence }
      : {}),
  };
  let response: StateQLCommandResponseReadModel;
  if (raw.ok) {
    if (
      !Array.isArray(raw.warnings) ||
      raw.warnings.length > 100 ||
      !raw.warnings.every(
        (warning: unknown) =>
          Boolean(warning) &&
          typeof warning === "object" &&
          !Array.isArray(warning) &&
          typeof (warning as any).code === "string" &&
          (warning as any).code.length <= 100 &&
          typeof (warning as any).message === "string" &&
          (warning as any).message.length <= 2_000,
      )
    )
      throw new Error("StateQL returned an invalid command response");
    response = {
      ok: true,
      command_id: raw.command_id,
      session_id: raw.session_id,
      data: stateqlJsonValue(raw.data, 0, { bytes: 0 }),
      warnings: raw.warnings.map((warning: any) => ({ code: warning.code, message: warning.message })),
      meta,
    };
  } else {
    const error = raw.error;
    if (
      !error ||
      typeof error !== "object" ||
      typeof error.code !== "string" ||
      !error.code ||
      error.code.length > 100 ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean" ||
      typeof error.executed !== "boolean" ||
      (error.suggested_action !== undefined && typeof error.suggested_action !== "string")
    )
      throw new Error("StateQL returned an invalid command response");
    const redact = (text: string) =>
      text
        .slice(0, 2_000)
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1***@")
        .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=***");
    response = {
      ok: false,
      command_id: raw.command_id,
      session_id: raw.session_id,
      error: {
        code: error.code,
        message: redact(error.message),
        retryable: error.retryable,
        executed: error.executed,
        ...(typeof error.suggested_action === "string"
          ? { suggested_action: redact(error.suggested_action) }
          : {}),
      },
      meta,
    };
  }
  const result: StateQLCommandResult = { ...base, status: "completed", response };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_STATEQL_ROWS_BYTES)
    throw new Error("StateQL returned an oversized command response");
  return result;
}


function papercutListResult(
  value: unknown,
  status: PapercutStatusReadModel | "all",
  query: string,
  offset: number,
  limit: number,
  sessionId: string,
  sessionGeneration: number,
  sanitize: (value: string) => string,
): PapercutListPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Papercut returned an invalid list");
  const raw = value as Record<string, any>;
  if (
    raw.version !== 1 ||
    raw.sessionId !== sessionId ||
    raw.status !== status ||
    raw.query !== query ||
    raw.offset !== offset ||
    raw.limit !== limit ||
    !Array.isArray(raw.records)
  )
    throw new Error("Papercut returned an invalid list");
  const candidate = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration,
    revision: raw.revision,
    status,
    query,
    offset,
    limit,
    total: raw.total,
    records: raw.records,
    nextOffset:
      Number.isSafeInteger(raw.total) && offset + raw.records.length < raw.total ? offset + raw.records.length : null,
  };
  if (!isPapercutListPage(candidate)) throw new Error("Papercut returned an invalid list");
  const source = candidate as PapercutListPage;
  const result: PapercutListPage = {
    ...source,
    records: source.records.map(record => ({
      ...record,
      message: sanitize(record.message),
      ...(record.resolution !== undefined ? { resolution: sanitize(record.resolution) } : {}),
      ...(record.dismissal !== undefined ? { dismissal: sanitize(record.dismissal) } : {}),
    })),
  };
  if (!isPapercutListPage(result)) throw new Error("Papercut returned an invalid list");
  return result;
}

function heliosAndroidToolingResult(value: unknown, sessionGeneration: number): HeliosAndroidToolingResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Helios returned an invalid Android tooling response");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["state", "appiumVersion", "driverVersion", "message"]);
  const version = (item: unknown) => typeof item === "string" && /^[0-9A-Za-z.+-]{1,50}$/.test(item);
  if (
    Object.keys(raw).some(key => !allowed.has(key)) ||
    typeof raw.state !== "string" ||
    !["missing", "ready", "invalid", "busy"].includes(raw.state) ||
    !version(raw.appiumVersion) ||
    !version(raw.driverVersion) ||
    (raw.message !== undefined &&
      (typeof raw.message !== "string" ||
        !raw.message ||
        raw.message.length > 300 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(raw.message)))
  ) {
    throw new Error("Helios returned an invalid Android tooling response");
  }
  return {
    version: 1,
    sessionGeneration,
    state: raw.state as HeliosAndroidToolingResult["state"],
    appiumVersion: raw.appiumVersion as string,
    driverVersion: raw.driverVersion as string,
    ...(raw.message === undefined ? {} : { message: raw.message as string }),
  };
}

function heliosResult(value: unknown, sessionGeneration: number): HeliosBrowserResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Helios returned an invalid embedded browser response");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.active !== "boolean" || typeof raw.controlled !== "boolean")
    throw new Error("Helios returned an invalid embedded browser response");
  const ownership = ["owned", "cdp-attached", "extension-attached"].includes(String(raw.ownership))
    ? (raw.ownership as HeliosBrowserResult["ownership"])
    : undefined;
  const state = ["starting", "ready", "cleanup-required", "closing", "closed"].includes(String(raw.state))
    ? (raw.state as HeliosBrowserResult["state"])
    : undefined;
  const page = raw.page === undefined ? undefined : heliosPage(raw.page);
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.slice(0, 101).map(heliosPage) : undefined;
  if ((raw.page !== undefined && !page) || tabs?.some(tab => !tab))
    throw new Error("Helios returned invalid page metadata");
  let frame: HeliosBrowserResult["frame"];
  if (raw.frame !== undefined) {
    const image =
      raw.frame && typeof raw.frame === "object" && !Array.isArray(raw.frame)
        ? (raw.frame as Record<string, unknown>)
        : undefined;
    if (
      image?.mimeType !== "image/png" ||
      typeof image.data !== "string" ||
      !image.data ||
      image.data.length > MAX_HELIOS_FRAME_BASE64 ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    )
      throw new Error("Helios returned an invalid embedded browser frame");
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    if ((image.data.length / 4) * 3 - padding > MAX_HELIOS_FRAME_BYTES)
      throw new Error("Helios returned an oversized embedded browser frame");
    frame = { mimeType: "image/png", data: image.data };
  }
  return {
    version: 1,
    sessionGeneration,
    active: raw.active,
    controlled: raw.controlled,
    ...(ownership ? { ownership } : {}),
    ...(state ? { state } : {}),
    ...(page ? { page } : {}),
    ...(tabs ? { tabs: tabs as HeliosPageIdentity[] } : {}),
    ...(frame ? { frame } : {}),
  };
}

export function terminalAgentError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const item = message as Record<string, unknown>;
    if (item.role === "user") return undefined;
    if (item.role !== "assistant") continue;
    if (item.stopReason !== "error" || typeof item.errorMessage !== "string") return undefined;
    return item.errorMessage.trim().slice(0, 1_000) || undefined;
  }
  return undefined;
}

export function correlatePendingUserMessageStart(
  payload: Record<string, unknown>,
  pendingIds: string[],
): Record<string, unknown> {
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : {};
  const kind = String(payload.type ?? "");
  if ((kind !== "message_start" && kind !== "message_starting") || String(payload.role ?? message.role) !== "user")
    return payload;
  const clientMessageId = pendingIds.shift();
  return clientMessageId ? { ...payload, clientMessageId } : payload;
}

export function deferUserMessageEndEntryId(
  payload: Record<string, unknown>,
  isCurrent: () => boolean,
  resolveEntryId: () => string | undefined,
  publish: (payload: Record<string, unknown>) => void,
): boolean {
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : {};
  if (
    payload.type !== "message_end" ||
    String(payload.role ?? message.role) !== "user" ||
    typeof payload.entryId === "string" ||
    typeof message.entryId === "string"
  )
    return false;
  const previousEntryId = resolveEntryId();
  // AgentSession persists the message immediately after its synchronous listeners return.
  queueMicrotask(() => {
    if (!isCurrent()) return;
    const entryId = resolveEntryId();
    publish(entryId && entryId !== previousEntryId ? { ...payload, entryId } : payload);
  });
  return true;
}

function moveToTrash(sessionPath: string): TrashAttempt {
  return spawnSync("trash", sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
}

export function readGitBranch(cwd: string): string | undefined {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch ? branch.slice(0, 200) : undefined;
}

export async function deleteSessionFile(
  sessionPath: string,
  trash: (path: string) => TrashAttempt = moveToTrash,
): Promise<void> {
  const result = trash(sessionPath);
  if (!existsSync(sessionPath)) return;
  if (result.error?.code === "ENOENT") {
    await unlink(sessionPath);
    return;
  }
  const detail =
    result.error?.message ||
    result.stderr?.trim().split("\n")[0] ||
    (result.status === 0
      ? "trash reported success but the session file remains"
      : `trash exited with status ${result.status ?? "unknown"}`);
  throw new Error(`could not move session to trash: ${detail.slice(0, 200)}`);
}

const OPTIONAL_TOOLS = [
  "continuity_update",
  "memory",
  "verify",
  "heartbeat_start",
  "heartbeat_status",
  "heartbeat_cancel",
] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MAX_LIVE_DELEGATED_RUNS = 100;
const ACTIVE_AUTH_RUNTIMES = new WeakSet<ModelRuntime>();
const SLOW_SESSION_START_MS = 3_000;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function supportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"] as const;
  if (!model.thinkingLevelMap) return THINKING_LEVELS;
  return THINKING_LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null);
}

/**
 * Catalogue numbers the composer shows beside each model. A catalogue entry can carry anything —
 * a placeholder -1 context window, a missing rate — so each fact is dropped unless it satisfies
 * the protocol, rather than trusting the upstream type.
 */
export function modelCatalogFacts(model: { contextWindow?: unknown; cost?: unknown }): {
  contextWindow?: number;
  cost?: { input: number; output: number };
} {
  const size = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
      ? Math.floor(value)
      : undefined;
  const rate = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const cost = (model.cost ?? {}) as { input?: unknown; output?: unknown };
  const contextWindow = size(model.contextWindow);
  const input = rate(cost.input);
  const output = rate(cost.output);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(input === undefined || output === undefined ? {} : { cost: { input, output } }),
  };
}

export interface SessionRuntimeOptions {
  dialogTimeoutMs?: number;
  extensionFactories?: InlineExtension[];
  modelRuntime?: ModelRuntime;
  onShutdownRequested?: () => void;
  projectRegistry?: ProjectRegistry;
  stateqlCredentialVault?: StateQLCredentialVault;
}

export class SessionRuntime implements PiDriver {
  private runtime?: AgentSessionRuntime;
  private readonly gate = new GenerationGate();
  private readonly eventBus: EventBusController = createEventBus();
  private busUnsubscribers: Array<() => void> = [];
  private operational = initialOperational([], []);
  private readonly listeners = new Set<DriverEventListener>();
  private readonly ui: RemoteUiBridge;
  private unsubscribeSession?: () => void;
  private replacementGeneration?: number;
  private replacementInvalidated = false;
  private implicitReplacement = false;
  private replacementSessionName?: string;
  private runtimeDisposable = false;
  private diagnostics: RuntimeDiagnostic[] = [];
  private lastSnapshot?: RuntimeSnapshot;
  private target?: RuntimeTarget;
  private createRuntime?: CreateAgentSessionRuntimeFactory;
  private modelRuntime?: ModelRuntime;
  private authAbort?: AbortController;
  private authGeneration?: number;
  private authFlow?: ProviderAuthReadModel["flow"];
  private storedProviderIds = new Set<string>();
  private packageCatalog?: PackageCatalog;
  private packageState?: PackageCatalogState;
  private extensionManager?: PiExtensionManager;
  private packageUpdate = false;
  private indexUpdate = false;
  private sessionMutation?: "lifecycle" | "delete";
  private readonly sessionIndex = new SessionIndex();
  private readonly promptAttachments = new PromptAttachmentBridge();
  private readonly workspaceApplyTool = new WorkspaceApplyTool();
  private hookSettings?: HookSettingsStore;
  private hookInjection?: HookInjectionBridge;
  private projectRegistry?: ProjectRegistry;
  private readonly workDurations = new Map<string, number>();
  private workDurationsLeafId: string | null | undefined;
  private readonly turnGitBranches = new Map<string, string>();
  private turnGitBranchesLeafId: string | null | undefined;
  private readonly toolDurations = new Map<string, number>();
  private toolDurationsLeafId: string | null | undefined;
  private readonly activeToolStarts = new Map<
    string,
    { startedAt: string; startedAtMs: number; name: string; input?: string }
  >();
  private readonly turnControls = new Map<
    string,
    { modelName?: string; thinkingLevel?: RuntimeSnapshot["sessionControls"]["thinkingLevel"] }
  >();
  private readonly turnChanges = new Map<string, ChangedFileReadModel[]>();
  private turnChangesLeafId: string | null | undefined;
  private readonly liveDelegatedRuns = new Map<string, DelegatedAgentRunReadModel>();
  private timingSessionId?: string;
  private workStartedAt?: string;
  private workStartedAtMs?: number;
  private workModelName?: string;
  private workThinkingLevel?: RuntimeSnapshot["sessionControls"]["thinkingLevel"];
  private workTurnId?: string;
  private workUserEntryId?: string;
  private workAssistantEntryIdAtStart?: string;
  private stopping = false;
  private stoppedRun?: RuntimeSnapshot["conversation"]["stoppedRun"];
  private agentError?: string;
  private compactionContinuation?: ContinuityCompactionContinuation;
  private nextTurnId = 0;
  private readonly pendingWorktreeTurns: Array<{ turnId: string; messageId?: string; assistantEntryId?: string }> = [];
  private discoverIndex?: DiscoverIndexReadModel;
  private gitBranch?: string;
  private runtimePolicy: RuntimePolicyReadModel = defaultRuntimePolicy();
  private transcriptCache?: { sessionId: string; leafId: string | null; messages: unknown[] };
  private conversationProjectionCache?: {
    sessionId: string;
    leafId: string | null;
    historyStart: number;
    value: ReturnType<typeof projectConversation>;
  };
  private toolUsageCache?: { sessionId: string; leafId: string | null; items: ToolUsageReadModel[] };
  private undoPromptEntryIds = new Set<string>();
  private forkPromptEntryIds = new Set<string>();
  private forkPromptCheckpoints = new Map<string, string>();
  private commandResult?: SlashCommandResultReadModel;
  private commandCapture?: { id: string; name: string; notifications: UiRequest[] };
  private readonly pendingUserMessageIds: string[] = [];
  private disposed = false;

  constructor(private readonly options: SessionRuntimeOptions = {}) {
    this.ui = new RemoteUiBridge(
      request => this.publishUi(request),
      options.dialogTimeoutMs,
      request => this.publishUiClosed(request),
    );
    this.ui.setStateQLCredentialVault(options.stateqlCredentialVault);
  }

  async start(target: RuntimeTarget): Promise<RuntimeHandle> {
    if (this.runtime || this.disposed) throw new Error("driver cannot be started twice");
    const startupStartedAt = performance.now();
    let packageExtensionsMs = 0;
    let sessionStartMs = 0;
    let bindMs = 0;
    this.target = target;
    this.sessionIndex.setAgentDir(target.agentDir);
    this.projectRegistry = this.options.projectRegistry ?? ProjectRegistry.forAgentDir(target.agentDir);
    if (!this.options.projectRegistry) {
      await this.projectRegistry.load(async () => {
        const knownSessions = await listSessionInventory(process.env.PI_CODING_AGENT_DIR || target.agentDir);
        return [target.cwd, ...knownSessions.map(session => session.cwd)];
      });
    }
    this.sessionIndex.setProjectRegistry(this.projectRegistry);
    this.gitBranch = this.readDisplayGitBranch(target.cwd);
    this.packageCatalog = new PackageCatalog(target.repositoryRoot, target.agentDir);
    this.hookSettings = new HookSettingsStore(target.agentDir);
    const packageScanStartedAt = performance.now();
    const packageScan = this.packageCatalog.scan().finally(() => {
      packageExtensionsMs += performance.now() - packageScanStartedAt;
    });
    const [packageState, modelRuntime, hookSettings] = await Promise.all([
      packageScan,
      this.options.modelRuntime ?? createPylonModelRuntime(target.agentDir),
      this.hookSettings.read(),
    ]);
    this.hookInjection = new HookInjectionBridge(hookSettings);
    this.packageState = packageState;
    this.modelRuntime = modelRuntime;
    this.storedProviderIds = new Set((await modelRuntime.listCredentials()).map(credential => credential.providerId));
    const generation = this.gate.start();
    this.installBusHooks(generation);
    const createRuntime = await createPylonRuntimeFactory({
      agentDir: target.agentDir,
      additionalExtensionPaths: this.packageState.extensionPaths,
      extensionFactories: [
        this.promptAttachments.extension,
        this.workspaceApplyTool.extension,
        this.hookInjection!.extension,
        ...(this.options.extensionFactories ?? []),
      ],
      eventBus: this.eventBus,
      modelRuntime,
      onStartupPhase: (phase, durationMs) => {
        if (phase === "extension-loading") packageExtensionsMs += durationMs;
        else sessionStartMs += durationMs;
      },
    });
    this.createRuntime = createRuntime;
    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: target.cwd,
        agentDir: target.agentDir,
        sessionManager: target.sessionPath
          ? SessionManager.open(target.sessionPath)
          : target.inMemory
            ? SessionManager.inMemory(target.cwd)
            : SessionManager.create(
                target.cwd,
                undefined,
                target.parentSessionPath ? { parentSession: target.parentSessionPath } : undefined,
              ),
      });
      this.runtime = runtime;
      this.extensionManager = new PiExtensionManager(
        target.cwd,
        target.agentDir,
        runtime.services.settingsManager,
        this.packageState?.packages.flatMap(item => item.extensionPaths),
      );
      this.runtimeDisposable = true;
      this.installRuntimeHooks(runtime);
      this.loadRuntimePolicy(runtime.session.sessionId);
      const bindStartedAt = performance.now();
      await this.bindSession(runtime.session, generation);
      bindMs = performance.now() - bindStartedAt;
      this.refreshSnapshot();
      const totalMs = performance.now() - startupStartedAt;
      if (totalMs >= SLOW_SESSION_START_MS) {
        console.warn(
          `[pylon] Slow session startup ${JSON.stringify({
            totalMs: Math.round(totalMs),
            packageExtensionsMs: Math.round(packageExtensionsMs),
            sessionStartMs: Math.round(sessionStartMs),
            bindMs: Math.round(bindMs),
          })}`,
        );
      }
      return { sessionId: runtime.session.sessionId, sessionGeneration: generation };
    } catch (error) {
      this.gate.stop();
      this.detachBus();
      await runtime?.dispose().catch(() => undefined);
      this.runtime = undefined;
      throw error;
    }
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    if (!this.runtime || !this.target) throw new Error("runtime has not started");
    if (this.gate.ready) this.refreshSnapshot();
    if (!this.lastSnapshot) throw new Error("runtime snapshot is unavailable");
    return {
      ...this.lastSnapshot,
      sessionGeneration: this.gate.generation,
      ready: this.gate.ready,
      diagnostics: [...this.diagnostics],
    };
  }

  async conversationHistory(input: ConversationHistoryQuery): Promise<ConversationHistoryPage> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const cursor = decodeHistoryCursor(input.cursor);
    if (cursor === undefined) throw new Error("history cursor is invalid");
    this.hydrateToolDurations(runtime.session);
    this.hydrateTurnGitBranches(runtime.session);
    const messages = this.transcriptMessages(runtime.session);
    const limit = Math.min(HISTORY_PAGE_SIZE, Math.max(1, input.limit ?? HISTORY_PAGE_SIZE));
    const direction = input.direction ?? "before";
    let start: number;
    let end: number;
    if (direction === "after") {
      start = Math.min(cursor, messages.length);
      end = Math.min(messages.length, start + limit);
    } else if (direction === "around") {
      start = Math.max(0, Math.min(cursor, messages.length) - Math.floor(limit / 2));
      end = Math.min(messages.length, start + limit);
      start = Math.max(0, end - limit);
    } else {
      end = Math.min(cursor, messages.length);
      start = Math.max(0, end - limit);
    }
    const projected = projectConversation(messages, {
      start,
      end,
      includeDelegated: false,
      toolDurations: this.toolDurations,
    }).messages.map(message => {
      const gitBranch = message.entryId ? this.turnGitBranches.get(message.entryId) : undefined;
      return gitBranch === undefined ? message : { ...message, gitBranch };
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      messages: projected,
      remaining: start,
      ...(start > 0 ? { nextCursor: encodeHistoryCursor(start) } : {}),
      ...(start > 0 ? { earlierCursor: encodeHistoryCursor(start) } : {}),
      ...(end < messages.length ? { laterCursor: encodeHistoryCursor(end) } : {}),
      atStart: start === 0,
      atEnd: end === messages.length,
    };
  }

  async conversationAttachment(input: ConversationAttachmentQuery): Promise<ConversationAttachmentContent> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const entry = runtime.session.sessionManager.getBranch().find(item => item.id === input.sourceEntryId);
    if (!entry) throw new Error("attachment is not on the active branch");
    if (entry.type === "message" && entry.message.role === "user" && Array.isArray(entry.message.content)) {
      const images = entry.message.content.filter(part => part.type === "image");
      const image = images[input.index] as unknown as Record<string, unknown> | undefined;
      if (
        !image ||
        image.pylonAttachmentVersion !== PROMPT_IMAGE_ATTACHMENT_VERSION ||
        typeof image.data !== "string" ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(image.mimeType))
      ) {
        throw new Error("attachment is unavailable");
      }
      const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
      return {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: runtime.session.sessionId,
        sessionGeneration: this.gate.generation,
        kind: "image",
        name: `Image ${input.index + 1}`,
        mimeType: image.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        size: (image.data.length / 4) * 3 - padding,
        data: image.data,
      };
    }
    if (
      entry.type === "custom_message" &&
      entry.customType === PROMPT_FILES_CUSTOM_TYPE &&
      typeof entry.content === "string" &&
      entry.details &&
      typeof entry.details === "object"
    ) {
      const details = entry.details as { version?: unknown; files?: unknown };
      const files = Array.isArray(details.files) ? details.files : [];
      const file = files[input.index] as Record<string, unknown> | undefined;
      if (
        details.version !== 2 ||
        !file ||
        typeof file.name !== "string" ||
        !Number.isSafeInteger(file.size) ||
        !Number.isSafeInteger(file.contentStart) ||
        !Number.isSafeInteger(file.contentEnd) ||
        Number(file.contentStart) < 0 ||
        Number(file.contentEnd) < Number(file.contentStart) ||
        Number(file.contentEnd) > entry.content.length
      ) {
        throw new Error("attachment is unavailable");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: runtime.session.sessionId,
        sessionGeneration: this.gate.generation,
        kind: "file",
        name: file.name.slice(0, 255),
        mimeType: typeof file.mimeType === "string" && file.mimeType ? file.mimeType.slice(0, 120) : "text/plain",
        size: Number(file.size),
        text: entry.content.slice(Number(file.contentStart), Number(file.contentEnd)),
      };
    }
    throw new Error("attachment is unavailable");
  }
  async turnDiff(input: TurnDiffQuery): Promise<TurnDiffResult> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    if (!activeAssistantEntryIds(runtime.session.sessionManager.getBranch()).has(input.entryId)) {
      throw new Error("turn diff is unavailable");
    }
    const entries: unknown[] = runtime.session.sessionManager.getEntries();
    for (const value of entries) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (entry.type !== "custom" || entry.customType !== WORKTREE_SUMMARY_ENTRY_TYPE) continue;
      const summary = parseWorktreeSummary(entry.data);
      if (!summary || summary.assistantEntryId !== input.entryId) continue;
      if (!summary.root || !summary.beforeTree || !summary.afterTree) break; // found but unanchored
      // The stored root must be the live session's repository before any git access.
      const workspace = await inspectGitWorkspace(runtime.cwd);
      const storedRoot = await realpath(summary.root).catch(() => undefined);
      if (
        !workspace ||
        !storedRoot ||
        resolve(storedRoot).replaceAll("\\", "/").toLowerCase() !==
          resolve(workspace.root).replaceAll("\\", "/").toLowerCase()
      ) {
        break;
      }
      try {
        const diff = await turnTreeDiff(workspace.root, summary.beforeTree, summary.afterTree);
        return {
          protocolVersion: PROTOCOL_VERSION,
          sessionId: runtime.session.sessionId,
          sessionGeneration: this.gate.generation,
          ...diff,
        };
      } catch {
        break; // stale anchor or unreadable objects surface as unavailable
      }
    }
    throw new Error("turn diff is unavailable");
  }

  async conversationTurnIndex(input: ConversationTurnIndexQuery): Promise<ConversationTurnIndexPage> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const turns = projectConversationTurnIndex(this.transcriptMessages(runtime.session));
    const limit = Math.min(250, Math.max(1, input.limit ?? 250));
    const cursor = input.cursor ? decodeTurnIndexCursor(input.cursor) : undefined;
    if (input.cursor && cursor === undefined) throw new Error("turn index cursor is invalid");
    let start: number;
    let end: number;
    if (input.direction === "later") {
      start = Math.min(cursor ?? 0, turns.length);
      end = Math.min(turns.length, start + limit);
    } else {
      end = Math.min(cursor ?? turns.length, turns.length);
      start = Math.max(0, end - limit);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      turns: turns.slice(start, end).reverse(),
      totalCount: turns.length,
      ...(start > 0 ? { earlierCursor: encodeTurnIndexCursor(start) } : {}),
      ...(end < turns.length ? { laterCursor: encodeTurnIndexCursor(end) } : {}),
    };
  }

  async fileSuggestions(input: FileSuggestionInput): Promise<FileSuggestionList> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const result = await suggestGitFiles(runtime.session.sessionManager.getCwd(), input.query, input.limit);
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.gate.generation, ...result };
  }

  async listSessions(input: SessionListQuery = {}): Promise<SessionListSnapshot> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    const activeId = runtime.session.sessionId;
    const now = new Date();
    return this.sessionIndex.list(input, {
      activeId,
      generation: this.gate.generation,
      stateFor: sessionId => (sessionId === activeId ? (runtime.session.isStreaming ? "running" : "idle") : "sleeping"),
      userCountFor: sessionId => (sessionId === activeId ? runtime.session.getSessionStats().userMessages : undefined),
      activeFallback: {
        id: activeId,
        path: runtime.session.sessionFile ?? "",
        cwd: runtime.cwd,
        name: runtime.session.sessionManager.getSessionName(),
        created: now,
        modified: now,
        messageCount: runtime.session.getSessionStats().totalMessages,
        firstMessage: "",
        allMessagesText: "",
      },
    });
  }

  async usage(input: UsageQuery = {}): Promise<UsageSnapshot> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    return this.sessionIndex.usage(input, {
      activeId: runtime.session.sessionId,
      generation: this.gate.generation,
      stateFor: sessionId => (sessionId === runtime.session.sessionId ? "idle" : "sleeping"),
    });
  }

  async listArchived(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready) throw new Error("runtime is not ready");
    return this.sessionIndex.listArchived(input, {
      activeId: runtime.session.sessionId,
      generation: this.gate.generation,
      stateFor: () => "sleeping",
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    const catalog = this.packageCatalog;
    const runtime = this.requireRuntime();
    if (!catalog || !this.gate.ready) throw new Error("runtime is not ready");
    const state = await catalog.scan();
    const extensions = runtime.services.resourceLoader.getExtensions();
    const loaded = new Set(extensions.extensions.map(item => resolve(item.resolvedPath)));
    const failed = new Set(extensions.errors.map(item => resolve(item.path)));
    const packages = await Promise.all(
      state.packages.map(async item => {
        let settings: PackageSettingsReadModel | undefined;
        let settingsError: string | undefined;
        try {
          settings = await catalog.readSettings(item.id, state);
        } catch (error) {
          settingsError = error instanceof Error ? error.message.slice(0, 500) : "Settings unavailable";
        }
        const enabled = state.enabledIds.has(item.id);
        const active = item.extensionPaths.every(path => loaded.has(resolve(path)));
        return {
          id: item.id,
          name: item.name,
          description: item.description,
          ...(item.required ? { required: true } : {}),
          enabled,
          active,
          extensionCount: item.extensionPaths.length,
          ...(settings ? { settings } : {}),
          ...(!active && enabled && item.extensionPaths.some(path => failed.has(resolve(path)))
            ? { error: "One or more extensions failed to load." }
            : settingsError
              ? { error: settingsError }
              : {}),
        };
      }),
    );
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.gate.generation, packages };
  }

  async listExtensions(): Promise<ExtensionListSnapshot> {
    const manager = this.extensionManager;
    const runtime = this.requireRuntime();
    if (!manager || !this.gate.ready) throw new Error("runtime is not ready");
    return manager.list(runtime.services.resourceLoader.getExtensions(), this.gate.generation);
  }

  async listHookSettings(): Promise<HookSettingsSnapshot> {
    const store = this.hookSettings;
    if (!store || !this.gate.ready) throw new Error("runtime is not ready");
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: this.gate.generation, settings: await store.read() };
  }

  prompt(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    return this.sendPrompt(session, input);
  }

  private async sendPrompt(session: AgentSession, input: PromptInput): Promise<AcceptedCommand> {
    if (!input.planMode) return this.acceptPrompt(session, input);
    const plan = this.requireRuntime()
      .services.resourceLoader.getExtensions()
      .runtime.getCommands()
      .find(command => command.name === "plan" && command.source === "extension");
    if (!plan) throw new Error("Plan mode is unavailable");
    await session.prompt("/plan", { source: "rpc" });
    try {
      return await this.acceptPrompt(session, input);
    } catch (error) {
      await session.prompt("/plan cancel", { source: "rpc" }).catch(() => undefined);
      throw error;
    }
  }

  private acceptPrompt(session: AgentSession, input: PromptInput): Promise<AcceptedCommand> {
    const files = input.files ?? [];
    const commandName = /^\s*\/([^\s]+)/.exec(input.message)?.[1];
    const knownCommand = Boolean(
      commandName &&
      this.requireRuntime()
        .services.resourceLoader.getExtensions()
        .runtime.getCommands()
        .some(command => command.name === commandName),
    );
    const capture =
      knownCommand && commandName
        ? { id: input.commandId, name: commandName.slice(0, 120), notifications: [] as UiRequest[] }
        : undefined;
    const turnAtStart = this.nextTurnId;
    if (capture) this.commandCapture = capture;
    if (files.length) this.promptAttachments.stage(input.commandId, files);
    if (!knownCommand) this.pendingUserMessageIds.push(input.commandId);
    return new Promise<AcceptedCommand>((resolve, reject) => {
      let decided = false;
      let commandPending = false;
      const complete = (accepted: boolean) => {
        if (decided) return;
        decided = true;
        const filesConsumed = !files.length || this.promptAttachments.consumed(input.commandId);
        this.promptAttachments.clear(input.commandId);
        if (this.commandCapture === capture) this.commandCapture = undefined;
        if (accepted) {
          for (const notification of capture?.notifications ?? []) this.emitUi(notification);
        } else if (capture) {
          const output = capture.notifications
            .map(notification => String(notification.payload.message ?? "").trim())
            .filter(Boolean)
            .join("\n")
            .slice(0, 8_000);
          const severity = capture.notifications.some(notification => notification.payload.type === "error")
            ? "error"
            : capture.notifications.some(notification => notification.payload.type === "warning")
              ? "warning"
              : "info";
          const compactCommand = capture.name === "compact" || /^compact:\d+$/.test(capture.name);
          this.commandResult =
            compactCommand && !output && severity === "info"
              ? undefined
              : {
                  id: capture.id.slice(0, 128),
                  command: capture.name,
                  output,
                  severity,
                  occurredAt: new Date().toISOString(),
                };
          this.emitCommandResult();
        }
        if (!accepted) this.removePendingUserMessage(input.commandId);
        if (!accepted && knownCommand && !files.length && !input.images?.length)
          resolve(this.accepted(input.commandId));
        else if (!accepted && knownCommand)
          reject(new Error("files and images require a command that starts a model turn"));
        else if (!accepted) reject(new Error("prompt was rejected before acceptance"));
        else if (!filesConsumed) reject(new Error("text files require a prompt that starts a model turn"));
        else resolve(this.accepted(input.commandId));
      };
      const finish = (accepted: boolean) => {
        if (knownCommand) {
          commandPending = true;
          return;
        }
        complete(accepted);
      };
      void session
        .prompt(input.message, {
          source: "rpc",
          images: input.images?.map(image => ({
            type: "image",
            ...image,
            pylonAttachmentVersion: PROMPT_IMAGE_ATTACHMENT_VERSION,
          })),
          preflightResult: finish,
        })
        .then(() => {
          if (commandPending) complete(this.nextTurnId > turnAtStart);
        })
        .catch(error => {
          this.removePendingUserMessage(input.commandId);
          this.promptAttachments.clear(input.commandId);
          if (this.commandCapture === capture) this.commandCapture = undefined;
          for (const notification of capture?.notifications ?? []) this.emitUi(notification);
          this.failImplicitReplacement(error);
          reject(error);
        });
    });
  }

  queuePrompt(_input: PromptInput): Promise<AcceptedCommand> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  queuedPrompt(_input: QueueMutationInput): Promise<QueuedPromptPayload> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  restoreQueuedPrompt(_input: QueueMutationInput): Promise<void> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  steerQueuedPrompt(_input: QueueMutationInput): Promise<AcceptedCommand> {
    return Promise.reject(new Error("prompt queuing requires the runtime coordinator"));
  }

  async steer(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    this.pendingUserMessageIds.push(input.commandId);
    try {
      await session.steer(
        input.message,
        input.images?.map(image => ({
          type: "image",
          ...image,
          pylonAttachmentVersion: PROMPT_IMAGE_ATTACHMENT_VERSION,
        })),
      );
    } catch (error) {
      this.removePendingUserMessage(input.commandId);
      throw error;
    }
    if (input.files?.length) {
      await session.sendCustomMessage(promptFilesMessage(input.files), { deliverAs: "steer" });
    }
    return this.accepted(input.commandId);
  }

  async followUp(input: PromptInput): Promise<AcceptedCommand> {
    const session = this.sessionFor(input.expectedGeneration);
    this.pendingUserMessageIds.push(input.commandId);
    try {
      await session.followUp(
        input.message,
        input.images?.map(image => ({
          type: "image",
          ...image,
          pylonAttachmentVersion: PROMPT_IMAGE_ATTACHMENT_VERSION,
        })),
      );
    } catch (error) {
      this.removePendingUserMessage(input.commandId);
      throw error;
    }
    if (input.files?.length) {
      await session.sendCustomMessage(promptFilesMessage(input.files), { deliverAs: "followUp" });
    }
    return this.accepted(input.commandId);
  }

  async abort(): Promise<void> {
    if (!this.runtime || !this.gate.ready) throw new Error("runtime is not ready");
    const session = this.runtime.session;
    const cancelledContinuation = !!this.compactionContinuation;
    if (this.compactionContinuation) {
      const request = this.compactionContinuation;
      this.stopping = true;
      this.eventBus.emit(CONTINUITY_COMPACTION_CHANNEL, {
        version: 1,
        action: "cancel",
        requestId: request.requestId,
        sessionId: request.sessionId,
        sessionGeneration: request.sessionGeneration,
        taskGeneration: request.taskGeneration,
      });
      session.abortCompaction();
      this.abandonCompactionContinuation(request.requestId, this.gate.generation);
    }
    const hadPendingUi = this.ui.hasPendingDialog;
    if (hadPendingUi) this.ui.cancelGeneration(this.gate.generation);
    if (this.stopping && !hadPendingUi && !cancelledContinuation) return;
    if (!this.stopping) {
      this.stopping = true;
      this.refreshSnapshot();
    }
    try {
      await session.abort();
      if (this.runtime?.session === session && !session.isStreaming) {
        this.stopping = false;
        this.refreshSnapshot();
      }
    } catch (error) {
      this.stopping = false;
      this.refreshSnapshot();
      throw error;
    }
  }

  applyRuntimePolicy(policy: RuntimePolicyReadModel): void {
    this.runtimePolicy = {
      ...policy,
      global: {
        ...policy.global,
        guardRules: { ...DEFAULT_GUARD_RULES, ...policy.global.guardRules },
        toolOverrides: cloneToolOverrides(policy.global.toolOverrides),
      },
      project: {
        ...policy.project,
        verify: cloneVerifyPolicy(policy.project.verify),
        ...(policy.project.guardRules ? { guardRules: { ...policy.project.guardRules } } : {}),
        toolOverrides: cloneToolOverrides(policy.project.toolOverrides),
      },
      session: {
        toolOverrides: cloneToolOverrides(policy.session.toolOverrides),
        ...(policy.session.verify ? { verify: cloneVerifyPolicy(policy.session.verify) } : {}),
        ...(policy.session.timelineEnabled !== undefined ? { timelineEnabled: policy.session.timelineEnabled } : {}),
        ...(policy.session.guardEnabled !== undefined ? { guardEnabled: policy.session.guardEnabled } : {}),
        ...(policy.session.guardRules ? { guardRules: { ...policy.session.guardRules } } : {}),
        ...(policy.session.workspace ? { workspace: policy.session.workspace } : {}),
        ...(policy.session.guardTimeoutSeconds !== undefined
          ? { guardTimeoutSeconds: policy.session.guardTimeoutSeconds }
          : {}),
        ...(policy.session.clarifyTimeoutSeconds !== undefined
          ? { clarifyTimeoutSeconds: policy.session.clarifyTimeoutSeconds }
          : {}),
      },
      effective: {
        ...policy.effective,
        verify: cloneVerifyPolicy(policy.effective.verify),
        guardRules: { ...DEFAULT_GUARD_RULES, ...policy.effective.guardRules },
        toolOverrides: cloneToolOverrides(policy.effective.toolOverrides),
      },
      availableVerifyChecks: policy.availableVerifyChecks.map(check => ({ ...check })),
    };
    this.publishRuntimePolicy();
    this.refreshSnapshot();
  }

  updateRuntimePolicy(_input: UpdateRuntimePolicyInput): Promise<void> {
    return Promise.reject(new Error("runtime policy updates require the runtime coordinator"));
  }

  updateToolPolicy(_input: UpdateToolPolicyInput): Promise<void> {
    return Promise.reject(new Error("tool policy updates require the runtime coordinator"));
  }

  addProject(_input: ProjectInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  removeProject(_input: RemoveProjectInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  renameProject(_input: RenameProjectInput): Promise<void> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  reorderProject(_input: ReorderProjectInput): Promise<void> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  archiveProject(_input: ProjectArchiveInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  restoreProject(_input: ProjectArchiveInput): Promise<void> {
    return Promise.reject(new Error("project management requires the runtime coordinator"));
  }

  archiveSession(_input: SessionArchiveInput): Promise<ReplacementResult> {
    return Promise.reject(new Error("session archiving requires the runtime coordinator"));
  }

  restoreSession(_input: SessionArchiveInput): Promise<void> {
    return Promise.reject(new Error("session archiving requires the runtime coordinator"));
  }

  newSession(input?: NewSessionInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      if (input?.expectedGeneration !== undefined) this.gate.assert(input.expectedGeneration);
      const parent = input?.parentSessionId ? await this.resolveSession(input.parentSessionId) : undefined;
      const project = input?.projectId ? this.projectRegistry?.get(input.projectId) : undefined;
      if (input?.projectId && (!project || project.archivedAt)) throw new Error("project is unavailable");
      const runtime = this.requireRuntime();
      if (project && projectIdForCwd(project.cwd) !== projectIdForCwd(runtime.cwd)) {
        throw new Error("cross-project session creation requires the runtime coordinator");
      }
      const crossProject = parent && projectIdForCwd(parent.cwd) !== projectIdForCwd(runtime.cwd);
      if (crossProject) {
        const switched = await this.replace(() => runtime.switchSession(parent.path));
        if (switched.cancelled) return switched;
      }
      try {
        return await this.replace(() => runtime.newSession({ parentSession: parent?.path }));
      } catch (error) {
        if (crossProject) await this.recoverSession(parent).catch(() => undefined);
        throw error;
      }
    });
  }

  switchSession(input: SwitchSessionInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = await this.resolveSession(input.sessionId);
      return this.replace(() => this.requireRuntime().switchSession(session.path));
    });
  }

  rebindWorkspace(cwd: string): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const runtime = this.requireRuntime();
      const sessionPath = runtime.session.sessionFile;
      if (!sessionPath) throw new Error("session is not persisted");
      const result = await this.replace(() => runtime.switchSession(sessionPath, { cwdOverride: cwd }));
      if (!result.cancelled && this.target) this.target.cwd = cwd;
      return result;
    });
  }

  async timelineRelocationReady(): Promise<void> {
    const runtime = this.requireRuntime();
    let response: Promise<unknown> | undefined;
    this.eventBus.emit("pi-timeline:relocation-readiness", {
      version: 1,
      sessionId: runtime.session.sessionId,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    const value = await response;
    if (!value) return;
    const result = value as { ready?: unknown };
    if (result.ready !== true) throw new Error("Timeline checkpoints are not portable.");
  }

  workspaceApplied(): void {
    const runtime = this.requireRuntime();
    this.gitBranch = readGitBranch(runtime.cwd);
    this.eventBus.emit("pylon:workspace-applied", { version: 1, sessionId: runtime.session.sessionId });
    this.refreshSnapshot();
  }

  setWorkspaceApplyHandler(
    handler: (
      request: { type: "inspect" } | { type: "schedule"; revision: string },
    ) => Promise<WorkspaceApplyToolInfo | void>,
  ): void {
    this.workspaceApplyTool.setHandler(handler);
  }

  recordWorkspaceApplyResult(result: string): void {
    this.workspaceApplyTool.recordResult(result);
  }

  async timelineCheckpointFiles(input: TimelineCheckpointInput): Promise<TimelineCheckpointFiles> {
    const runtime = this.requireRuntime();
    let response: Promise<any> | undefined;
    this.eventBus.emit("pi-timeline:files-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      checkpointId: input.checkpointId,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Timeline checkpoint files are unavailable");
    const value = await response;
    const files = Array.isArray(value?.files)
      ? value.files.slice(0, 200).flatMap((item: any) => {
          if (
            !item ||
            typeof item.path !== "string" ||
            item.path.length > 500 ||
            !["added", "modified", "deleted"].includes(item.status) ||
            !Number.isSafeInteger(item.additions) ||
            item.additions < 0 ||
            !Number.isSafeInteger(item.deletions) ||
            item.deletions < 0
          )
            return [];
          return [
            {
              path: item.path,
              status: item.status,
              additions: item.additions,
              deletions: item.deletions,
              binary: item.binary === true,
            },
          ];
        })
      : [];
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      checkpointId: input.checkpointId,
      files,
      totalCount: Number.isSafeInteger(value?.totalCount) ? Math.min(10_000, value.totalCount) : files.length,
      truncated: value?.truncated === true,
    };
  }

  async timelineCheckpointDiff(input: TimelineCheckpointDiffInput): Promise<TimelineCheckpointDiff> {
    const runtime = this.requireRuntime();
    let response: Promise<any> | undefined;
    this.eventBus.emit("pi-timeline:diff-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      checkpointId: input.checkpointId,
      path: input.path,
      respond: (value: unknown) => {
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Timeline checkpoint diff is unavailable");
    const value = await response;
    if (!value || value.path !== input.path || !["text", "binary", "unavailable", "oversized"].includes(value.state))
      throw new Error("Timeline returned an invalid diff");
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: this.gate.generation,
      checkpointId: input.checkpointId,
      path: input.path,
      state: value.state,
      ...(typeof value.text === "string" ? { text: value.text.slice(0, 2 * 1024 * 1024) } : {}),
      ...(value.truncated === true ? { truncated: true } : {}),
    };
  }

  async stateqlSnapshot(historyLimit: number): Promise<StateQLSnapshot> {
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:stateql-snapshot-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      historyLimit,
      signal: controller.signal,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("StateQL snapshot is unavailable");
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("StateQL snapshot request timed out")), {
            once: true,
          }),
        ),
      ]);
      return stateqlResult(value, runtime.session.sessionId, this.gate.generation);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async stateqlRows(handle: string, offset: number, limit: number): Promise<StateQLRowsPage> {
    if (
      !handle.trim() ||
      handle.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 10_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("StateQL rows request is invalid");
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:stateql-rows-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      handle,
      offset,
      limit,
      signal: controller.signal,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("StateQL rows are unavailable");
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("StateQL rows request timed out")), {
            once: true,
          }),
        ),
      ]);
      return stateqlRowsResult(value, handle, offset, limit, runtime.session.sessionId, this.gate.generation);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async stateqlCommand(input: StateQLCommandInput, signal?: AbortSignal): Promise<StateQLCommandResult> {
    if (!isStateQLCommandInput(input)) throw new Error("StateQL command request is invalid");
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:stateql-command-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      command: input,
      signal: controller.signal,
      ui: this.ui.context(runtime.session.sessionId, this.gate.generation, "database"),
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("StateQL commands are unavailable");
    const timeoutMs = Math.min(input.command === "query" ? (input.timeout_ms ?? 30_000) + 60_000 : 300_000, 300_000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("StateQL command request cancelled")), {
            once: true,
          }),
        ),
      ]);
      return stateqlCommandResult(value, input, runtime.session.sessionId, this.gate.generation);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      signal?.removeEventListener("abort", abort);
    }
  }

  async papercutList(
    status: PapercutStatusReadModel | "all",
    query: string,
    offset: number,
    limit: number,
  ): Promise<PapercutListPage> {
    if (
      !["open", "resolved", "dismissed", "all"].includes(status) ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Papercut list request is invalid");
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:papercut-list-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      status,
      query,
      offset,
      limit,
      signal: controller.signal,
      claim: () => (claimed ? false : (claimed = true)),
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Papercuts are unavailable");
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("Papercut list request timed out")), {
            once: true,
          }),
        ),
      ]);
      return papercutListResult(
        value,
        status,
        query,
        offset,
        limit,
        runtime.session.sessionId,
        this.gate.generation,
        text => this.sanitizeOperationalText(text),
      );
    } catch (error) {
      this.recordError(error);
      throw new Error(controller.signal.aborted ? "Papercut list request timed out" : "Unable to load papercuts");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async papercutMutation(input: PapercutMutationInput): Promise<PapercutMutationResult> {
    if (
      !["edit", "delete"].includes(input.action) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) ||
      Number.isNaN(Date.parse(input.expectedUpdatedAt)) ||
      (input.action === "edit" && (!input.message.trim() || input.message.length > 500))
    )
      throw new Error("Papercut mutation request is invalid");
    const runtime = this.requireRuntime();
    const generation = this.gate.generation;
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:papercut-mutation-request", {
      version: 1,
      sessionId: runtime.session.sessionId,
      ...input,
      signal: controller.signal,
      claim: () => (claimed ? false : (claimed = true)),
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Papercut mutations are unavailable");
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();
    let value: unknown;
    try {
      value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("Papercut mutation request timed out")), {
            once: true,
          }),
        ),
      ]);
    } catch (error) {
      this.recordError(error);
      throw new Error(controller.signal.aborted ? "Papercut mutation request timed out" : "Unable to update papercut");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    const raw =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    if (!raw || raw.version !== 1 || raw.sessionId !== runtime.session.sessionId || typeof raw.ok !== "boolean")
      throw new Error("Papercut returned an invalid mutation result");
    if (raw.ok === false) {
      if (raw.error === "stale") throw new Error("Papercut changed or was removed. Your draft was kept.");
      if (raw.error === "duplicate") throw new Error("Another open papercut already uses this message.");
      if (raw.error === "invalid") throw new Error("Papercut message is invalid.");
      throw new Error("Papercut returned an invalid mutation result");
    }
    if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0)
      throw new Error("Papercut returned an invalid mutation result");
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: generation, revision: Number(raw.revision) };
  }

  async heliosBrowser(input: HeliosBrowserInput): Promise<HeliosBrowserResult> {
    if (input.expectedGeneration !== this.gate.generation) throw new Error("stale session generation");
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:helios-browser-request", {
      version: 1,
      ...input,
      sessionId: runtime.session.sessionId,
      signal: controller.signal,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Helios embedded browser is unavailable");
    const timeout = setTimeout(() => controller.abort(), 80_000);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Helios embedded browser request timed out")),
            { once: true },
          ),
        ),
      ]);
      if (input.expectedGeneration !== this.gate.generation) throw new Error("stale session generation");
      return heliosResult(value, this.gate.generation);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async heliosAndroidTooling(input: HeliosAndroidToolingCommand): Promise<HeliosAndroidToolingResult> {
    if (input.expectedGeneration !== this.gate.generation) throw new Error("stale session generation");
    const runtime = this.requireRuntime();
    const controller = new AbortController();
    let response: Promise<unknown> | undefined;
    let claimed = false;
    let answered = false;
    this.eventBus.emit("pylon:helios-android-tooling-request", {
      version: 1,
      ...input,
      sessionId: runtime.session.sessionId,
      signal: controller.signal,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (value: Promise<unknown>) => {
        if (answered) return;
        answered = true;
        response = Promise.resolve(value);
      },
    });
    if (!response) throw new Error("Helios Android tooling is unavailable");
    const timeout = setTimeout(() => controller.abort(), input.action === "install" ? 12 * 60_000 : 60_000);
    timeout.unref?.();
    try {
      const value = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Helios Android tooling request timed out")),
            { once: true },
          ),
        ),
      ]);
      if (input.expectedGeneration !== this.gate.generation) throw new Error("stale session generation");
      return heliosAndroidToolingResult(value, this.gate.generation);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  deleteSession(input: DeleteSessionInput): Promise<void> {
    return this.withSessionMutation("delete", async () => {
      this.gate.assert(input.expectedGeneration);
      if (!this.gate.ready) throw new Error("runtime is not ready");
      const runtime = this.requireRuntime();
      if (input.sessionId === runtime.session.sessionId) throw new Error("cannot delete the currently active session");
      const session = await this.resolveSession(input.sessionId);
      this.gate.assert(input.expectedGeneration);
      const activeFile = runtime.session.sessionManager.getSessionFile();
      if (activeFile && resolve(session.path) === resolve(activeFile))
        throw new Error("cannot delete the currently active session");
      await deleteSessionFile(session.path);
      const turnsBranch = turnsBranchForSession(input.sessionId);
      if (turnsBranch) await removeSessionRef(session.cwd, turnsBranch);
      this.sessionIndex.remove(input.sessionId);
    });
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const runtime = this.requireRuntime();
    const name = input.name.trim();
    if (input.sessionId === runtime.session.sessionId) {
      this.controlSession().setSessionName(name);
      this.refreshSnapshot();
    } else {
      const session = await this.resolveSession(input.sessionId);
      SessionManager.open(session.path).appendSessionInfo(name);
    }
    this.sessionIndex.invalidate();
  }

  setSessionActive(input: SetSessionActiveInput): Promise<void> {
    const current = this.requireRuntime().session.sessionId;
    if (input.sessionId === current && input.active) return Promise.resolve();
    if (input.sessionId === current) return Promise.reject(new Error("cannot deactivate the selected session"));
    return Promise.reject(new Error("manual session activation requires the runtime coordinator"));
  }

  setSessionPinned(_input: SetSessionPinnedInput): Promise<void> {
    return Promise.reject(new Error("session pinning requires the runtime coordinator"));
  }

  reorderActiveSession(_input: ReorderActiveSessionInput): Promise<void> {
    return Promise.reject(new Error("session ordering requires the runtime coordinator"));
  }

  editPrompt(input: EditPromptInput): Promise<AcceptedCommand> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("prompts can only be edited while the session is idle");
      }
      const branch = session.sessionManager.getBranch();
      const targetIndex = branch.findIndex(entry => entry.id === input.entryId);
      const target = branch[targetIndex];
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      const parentId =
        typeof (target as { parentId?: unknown }).parentId === "string"
          ? (target as { parentId: string }).parentId
          : branch[targetIndex - 1]?.id;
      const oldLeaf = session.sessionManager.getLeafId();
      if (!parentId || !oldLeaf) throw new Error("the selected prompt cannot be edited");

      const timeline = await this.prepareTimelineEdit(session, target.id, input.rollbackFiles);
      let navigated = false;
      try {
        const result = await session.navigateTree(parentId, { summarize: false });
        if (result.cancelled) {
          throw new Error("prompt editing was cancelled");
        }
        navigated = true;
        await timeline?.apply();
        const accepted = await this.sendPrompt(session, input);
        await timeline?.commit().catch(cleanupError => this.recordError(cleanupError));
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        return accepted;
      } catch (error) {
        if (navigated) {
          await timeline?.rollback().catch(rollbackError => this.recordError(rollbackError));
          await session
            .navigateTree(oldLeaf, { summarize: false })
            .catch(rollbackError => this.recordError(rollbackError));
        } else {
          await timeline?.cancel().catch(rollbackError => this.recordError(rollbackError));
        }
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        throw error;
      }
    });
  }

  rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("prompts can only be rewound while the session is idle");
      }
      const branch = session.sessionManager.getBranch();
      const targetIndex = branch.findIndex(entry => entry.id === input.entryId);
      const target = branch[targetIndex];
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      if (!this.undoPromptEntryIds.has(target.id)) {
        throw new Error("Pi Timeline cannot restore files before this prompt");
      }
      const parentId =
        typeof (target as { parentId?: unknown }).parentId === "string"
          ? (target as { parentId: string }).parentId
          : branch[targetIndex - 1]?.id;
      const oldLeaf = session.sessionManager.getLeafId();
      if (!parentId || !oldLeaf || oldLeaf === target.id) {
        throw new Error("the selected prompt cannot be rewound");
      }

      const timeline = await this.prepareTimelineEdit(session, target.id, true);
      let navigated = false;
      try {
        const result = await session.navigateTree(parentId, { summarize: false });
        if (result.cancelled) throw new Error("prompt rewind was cancelled");
        navigated = true;
        await timeline!.apply();
        await timeline!.commit().catch(cleanupError => this.recordError(cleanupError));
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        return this.accepted(input.commandId);
      } catch (error) {
        if (navigated) {
          await timeline?.rollback().catch(rollbackError => this.recordError(rollbackError));
          await session
            .navigateTree(oldLeaf, { summarize: false })
            .catch(rollbackError => this.recordError(rollbackError));
        } else {
          await timeline?.cancel().catch(rollbackError => this.recordError(rollbackError));
        }
        this.transcriptCache = undefined;
        this.refreshSnapshot();
        throw error;
      }
    });
  }

  fork(input: ForkInput): Promise<ReplacementResult> {
    return this.withSessionMutation("lifecycle", async () => {
      const session = this.sessionFor(input.expectedGeneration);
      if (!session.isIdle || this.runtimeState() !== "idle" || this.packageUpdate || this.indexUpdate) {
        throw new Error("Session controls can only change while the session is idle");
      }
      const target = session.sessionManager.getBranch().find(entry => entry.id === input.entryId);
      if (target?.type !== "message" || target.message.role !== "user") {
        throw new Error("the selected prompt is not on the active branch");
      }
      const name = input.name.trim();
      this.replacementSessionName = name;
      try {
        if (input.mode !== "timeline") {
          return await this.replace(() => this.requireRuntime().fork(input.entryId, { position: input.position }));
        }
        const checkpointId = this.forkPromptCheckpoints.get(input.entryId);
        if (!checkpointId || !this.runtimePolicy.effective.timelineEnabled) {
          throw new Error("No compatible Timeline checkpoint exists for this prompt");
        }
        await this.confirmTimelinePromptFork(session, checkpointId);
        return await this.replace(async () => {
          await session.prompt(`/timeline fork ${checkpointId}`, { source: "rpc" });
          return { cancelled: false };
        });
      } finally {
        this.replacementSessionName = undefined;
      }
    });
  }

  async setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult> {
    const catalog = this.packageCatalog;
    const runtime = this.requireRuntime();
    if (!catalog) throw new Error("runtime is not ready");
    return this.withSettingsUpdate(async () => {
      const current = await catalog.scan();
      if (current.enabledIds.has(input.packageId) !== input.enabled) {
        await catalog.setEnabled(input.packageId, input.enabled);
      }
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    });
  }

  async setExtensionEnabled(input: SetExtensionEnabledInput): Promise<ReplacementResult> {
    const manager = this.extensionManager;
    const runtime = this.requireRuntime();
    if (!manager) throw new Error("runtime is not ready");
    return this.withSettingsUpdate(async () => {
      if (!this.canSleep()) throw new Error("extensions can only change while the session is idle");
      await manager.setEnabled(input.extensionId, input.enabled);
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    });
  }

  async installExtensionPackage(input: ExtensionPackageInput): Promise<ReplacementResult> {
    return this.updateExtensionPackage(input, "install");
  }
  async removeExtensionPackage(input: ExtensionPackageInput): Promise<ReplacementResult> {
    return this.updateExtensionPackage(input, "remove");
  }
  async setProjectTrust(input: SetProjectTrustInput): Promise<ReplacementResult> {
    const manager = this.extensionManager;
    const runtime = this.requireRuntime();
    if (!manager) throw new Error("runtime is not ready");
    return this.withSettingsUpdate(async () => {
      if (!this.canSleep()) throw new Error("project trust can only change while the session is idle");
      await manager.setProjectTrusted(input.trusted);
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    });
  }

  private async updateExtensionPackage(
    input: ExtensionPackageInput,
    action: "install" | "remove",
  ): Promise<ReplacementResult> {
    const manager = this.extensionManager;
    const runtime = this.requireRuntime();
    if (!manager) throw new Error("runtime is not ready");
    return this.withSettingsUpdate(async () => {
      if (!this.canSleep()) throw new Error("extensions can only change while the session is idle");
      if (action === "install") await manager.install(input.source, input.scope);
      else await manager.remove(input.source, input.scope);
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    });
  }

  async reloadExtensions(): Promise<ReplacementResult> {
    const runtime = this.requireRuntime();
    const manager = this.extensionManager;
    if (!manager || !this.canSleep()) throw new Error("extensions can only reload while the session is idle");
    runtime.services.settingsManager.setProjectTrusted(manager.projectTrusted());
    await runtime.session.reload();
    this.extensionManager = new PiExtensionManager(manager.cwd, manager.agentDir, runtime.services.settingsManager, [
      ...manager.excludedPaths,
    ]);
    this.refreshSnapshot();
    return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
  }

  async updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult> {
    const catalog = this.packageCatalog;
    const runtime = this.requireRuntime();
    if (!catalog) throw new Error("runtime is not ready");
    this.assertPackageModels(input.settings);
    return this.withSettingsUpdate(async () => {
      await catalog.updateSettings(input.packageId, input.settings);
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    });
  }

  async updateHookSettings(input: UpdateHookSettingsInput): Promise<void> {
    const store = this.hookSettings;
    if (!store) throw new Error("runtime is not ready");
    await this.withSettingsUpdate(() => store.update(input.settings));
  }

  async rebuildDiscoverIndex(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!this.gate.ready || this.indexUpdate || !this.canSleep()) {
      throw new Error("the index can only rebuild while the session is idle");
    }
    this.indexUpdate = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let handled = false;
        this.eventBus.emit("pi-discover:index-action", {
          version: 1,
          action: "rebuild",
          acknowledge: () => {
            handled = true;
          },
          resolve,
          reject,
        });
        if (!handled) reject(new Error("pi-discover indexing is unavailable"));
      });
      this.refreshSnapshot();
    } finally {
      this.indexUpdate = false;
      if (runtime === this.runtime) this.refreshSnapshot();
    }
  }

  private async withSettingsUpdate<T>(action: () => Promise<T>): Promise<T> {
    if (!this.gate.ready) throw new Error("runtime is not ready");
    if (this.packageUpdate || this.sessionMutation) throw new Error("another settings update is in progress");
    this.packageUpdate = true;
    try {
      return await action();
    } finally {
      this.packageUpdate = false;
    }
  }

  private assertPackageModels(settings: PackageSettingsReadModel): void {
    const runtime = this.requireRuntime();
    const available = new Map(
      runtime.services.modelRuntime.getAvailableSnapshot().map(model => [`${model.provider}/${model.id}`, model]),
    );
    const assertProfile = (modelRef: string | undefined, thinking: string | undefined) => {
      const model = modelRef ? available.get(modelRef) : undefined;
      if (!model) throw new Error("package model is unavailable or has no configured credentials");
      if (thinking && !supportedThinkingLevels(model).includes(thinking as ThinkingLevel)) {
        throw new Error("package thinking level is unavailable for the selected model");
      }
    };
    if (settings.kind === "continuity") {
      if (settings.planner) assertProfile(settings.planner.model, settings.planner.thinking);
      if (settings.executor) assertProfile(settings.executor.model, settings.executor.thinking);
      if (settings.memoryReviewer) assertProfile(settings.memoryReviewer.model, settings.memoryReviewer.thinking);
      if (settings.compactionReviewer)
        assertProfile(settings.compactionReviewer.model, settings.compactionReviewer.thinking);
      return;
    }
    if (settings.kind === "advisor" || settings.kind === "scout") {
      if (settings.mode === "disabled") return;
      if (settings.mode === "model") {
        assertProfile(settings.model, settings.thinking);
        return;
      }
      if (settings.thinking && !runtime.session.getAvailableThinkingLevels().includes(settings.thinking)) {
        throw new Error("package thinking level is unavailable for the session model");
      }
      return;
    }
    if (settings.kind === "grunt" && settings.mode === "model") {
      assertProfile(settings.model, undefined);
      return;
    }
    if (settings.kind === "spawn" && settings.models) {
      for (const model of settings.models) assertProfile(model, undefined);
    }
  }

  async setModel(input: SetModelInput): Promise<void> {
    const session = this.controlSession();
    const model = this.requireRuntime()
      .services.modelRuntime.getAvailableSnapshot()
      .find(item => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    await session.setModel(model);
    this.refreshSnapshot();
  }

  setThinkingLevel(input: SetThinkingLevelInput): void {
    const session = this.controlSession();
    if (!session.getAvailableThinkingLevels().includes(input.level))
      throw new Error("thinking level is unavailable for this model");
    session.setThinkingLevel(input.level);
    this.refreshSnapshot();
  }

  async setSessionControls(input: SetSessionControlsInput): Promise<void> {
    const session = this.controlSession();
    this.validateSessionControls(input);
    const model = this.requireRuntime()
      .services.modelRuntime.getAvailableSnapshot()
      .find(item => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    const previousModel = session.model;
    const previousThinking = session.thinkingLevel;
    try {
      await session.setModel(model);
      session.setThinkingLevel(input.thinkingLevel);
      this.refreshSnapshot();
    } catch (error) {
      if (previousModel) await session.setModel(previousModel).catch(() => undefined);
      if (session.getAvailableThinkingLevels().includes(previousThinking)) {
        session.setThinkingLevel(previousThinking);
      }
      this.refreshSnapshot();
      throw error;
    }
  }

  async startProviderLogin(input: StartProviderLoginInput): Promise<void> {
    const session = this.sessionFor(input.expectedGeneration);
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("provider authentication is unavailable");
    if (this.authFlow?.status === "running" || ACTIVE_AUTH_RUNTIMES.has(modelRuntime)) {
      throw new Error("provider authentication is already in progress");
    }
    const provider = modelRuntime.getProvider(input.provider);
    if (!provider) throw new Error("unknown provider");
    const method = input.authType === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (!method) throw new Error("authentication method is unavailable for this provider");
    if (input.authType === "api_key" && !method.login) {
      throw new Error("this provider is configured outside Pylon");
    }

    const id = randomUUID();
    const authGeneration = this.gate.generation;
    const abort = new AbortController();
    this.authAbort = abort;
    this.authGeneration = authGeneration;
    this.authFlow = {
      id,
      providerId: provider.id,
      providerName: provider.name,
      authType: input.authType,
      status: "running",
      message: `Starting ${method.name}`,
    };
    ACTIVE_AUTH_RUNTIMES.add(modelRuntime);
    this.publishProviderAuth();

    void modelRuntime
      .login(provider.id, input.authType, {
        signal: abort.signal,
        prompt: async prompt => {
          this.updateAuthFlow(id, { message: prompt.message });
          const safePrompt: ProviderAuthPrompt =
            prompt.type === "select"
              ? {
                  type: "select",
                  message: prompt.message,
                  options: prompt.options.map(option => ({
                    id: option.id,
                    label: option.label,
                    ...(option.description ? { description: option.description } : {}),
                  })),
                  ...(prompt.signal ? { signal: prompt.signal } : {}),
                }
              : {
                  type: prompt.type,
                  message: prompt.message,
                  ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
                  ...(prompt.signal ? { signal: prompt.signal } : {}),
                };
          const value = await this.ui.authPrompt(session.sessionId, authGeneration, safePrompt, abort.signal);
          if (value === undefined) throw new Error("Login cancelled");
          return value;
        },
        notify: event => {
          if (event.type === "auth_url") {
            const authUrl = this.safeProviderUrl(event.url);
            this.updateAuthFlow(id, {
              message: authUrl
                ? (event.instructions ?? "Continue authentication in your browser.")
                : "The provider returned an invalid sign-in URL.",
              authUrl,
              instructions: event.instructions,
            });
          } else if (event.type === "device_code") {
            const verificationUri = this.safeProviderUrl(event.verificationUri);
            this.updateAuthFlow(id, {
              message: verificationUri
                ? "Enter the code on the provider sign-in page."
                : "The provider returned an invalid verification URL.",
              ...(verificationUri
                ? {
                    deviceCode: {
                      userCode: event.userCode,
                      verificationUri,
                      ...(event.expiresInSeconds
                        ? { expiresAt: new Date(Date.now() + event.expiresInSeconds * 1_000).toISOString() }
                        : {}),
                    },
                  }
                : {}),
            });
          } else if (event.type === "info") {
            this.updateAuthFlow(id, {
              message: event.message,
              links: event.links?.flatMap(link => {
                const url = this.safeProviderUrl(link.url);
                return url ? [{ url, ...(link.label ? { label: link.label } : {}) }] : [];
              }),
            });
          } else {
            this.updateAuthFlow(id, { message: event.message });
          }
        },
      })
      .then(() => {
        this.storedProviderIds.add(provider.id);
        this.updateAuthFlow(id, {
          status: "succeeded",
          message: `Connected ${provider.name}.`,
          authUrl: undefined,
          instructions: undefined,
          links: undefined,
          deviceCode: undefined,
        });
      })
      .catch(error => {
        const cancelled = abort.signal.aborted || (error instanceof Error && error.message === "Login cancelled");
        this.updateAuthFlow(id, {
          status: cancelled ? "cancelled" : "failed",
          message: cancelled ? "Authentication cancelled." : "Authentication failed. Try again.",
          authUrl: undefined,
          instructions: undefined,
          links: undefined,
          deviceCode: undefined,
        });
      })
      .finally(() => {
        ACTIVE_AUTH_RUNTIMES.delete(modelRuntime);
        if (this.authFlow?.id === id) {
          this.authAbort = undefined;
          this.authGeneration = undefined;
        }
      });
  }

  async cancelProviderLogin(expectedGeneration: number): Promise<void> {
    this.sessionFor(expectedGeneration);
    if (this.authFlow?.status !== "running" || !this.authAbort) return;
    this.authAbort.abort();
  }

  async logoutProvider(provider: string, expectedGeneration: number): Promise<void> {
    this.sessionFor(expectedGeneration);
    const modelRuntime = this.modelRuntime;
    if (!modelRuntime) throw new Error("provider authentication is unavailable");
    if (this.authFlow?.status === "running" || ACTIVE_AUTH_RUNTIMES.has(modelRuntime)) {
      throw new Error("provider authentication is already in progress");
    }
    if (!modelRuntime.getProvider(provider)) throw new Error("unknown provider");
    await modelRuntime.logout(provider);
    this.storedProviderIds.delete(provider);
    this.authFlow = undefined;
    this.publishProviderAuth();
  }

  private updateAuthFlow(id: string, patch: Partial<NonNullable<ProviderAuthReadModel["flow"]>>): void {
    if (this.authFlow?.id !== id || this.authGeneration !== this.gate.generation) return;
    this.authFlow = { ...this.authFlow, ...patch };
    this.publishProviderAuth();
  }

  private publishProviderAuth(): void {
    if (!this.runtime || !this.gate.ready) return;
    this.refreshSnapshot();
    this.emit({
      type: "provider.auth",
      sessionId: this.runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      providerAuth: this.providerAuthSnapshot(),
    });
  }

  private safeProviderUrl(value: string): string | undefined {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return url.toString();
      if (
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      )
        return url.toString();
    } catch {
      /* Invalid provider URL. */
    }
    return undefined;
  }

  private providerAuthSnapshot(): ProviderAuthReadModel {
    const providers = (this.modelRuntime?.getProviders() ?? [])
      .slice(0, 200)
      .map(provider => {
        const status = this.modelRuntime!.getProviderAuthStatus(provider.id);
        const methods: ProviderAuthReadModel["providers"][number]["methods"] = [];
        if (provider.auth.oauth) methods.push({ type: "oauth", name: provider.auth.oauth.name, interactive: true });
        if (provider.auth.apiKey)
          methods.push({
            type: "api_key",
            name: provider.auth.apiKey.name,
            interactive: Boolean(provider.auth.apiKey.login),
          });
        return {
          id: provider.id,
          name: provider.name,
          configured: status.configured,
          stored: this.storedProviderIds.has(provider.id),
          ...(status.configured
            ? {
                credentialType: this.modelRuntime!.isUsingOAuth(provider.id)
                  ? ("oauth" as const)
                  : ("api_key" as const),
              }
            : {}),
          methods,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      providers,
      ...(this.authFlow
        ? {
            flow: {
              ...this.authFlow,
              ...(this.authFlow.links ? { links: this.authFlow.links.map(link => ({ ...link })) } : {}),
              ...(this.authFlow.deviceCode ? { deviceCode: { ...this.authFlow.deviceCode } } : {}),
            },
          }
        : {}),
    };
  }

  validateSessionControls(input: SetSessionControlsInput): ModelOptionReadModel {
    const model = this.requireRuntime()
      .services.modelRuntime.getAvailableSnapshot()
      .find(item => item.provider === input.provider && item.id === input.modelId);
    if (!model) throw new Error("model is unavailable or has no configured credentials");
    const thinkingLevels = supportedThinkingLevels(model);
    if (!thinkingLevels.includes(input.thinkingLevel)) {
      throw new Error("thinking level is unavailable for this model");
    }
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      thinkingLevels: [...thinkingLevels],
      ...modelCatalogFacts(model),
    };
  }

  hasActiveAgentRun(): boolean {
    return Boolean(this.workStartedAt);
  }

  updateContinuityMemory(input: UpdateContinuityMemoryInput): Promise<void> {
    return this.continuityMemoryMutation(
      {
        action: "update",
        scope: input.scope,
        id: input.id,
        trigger: input.trigger,
        guidance: input.guidance,
        expectedRevision: input.expectedRevision,
      },
      input.expectedGeneration,
    );
  }

  deleteContinuityMemory(input: DeleteContinuityMemoryInput): Promise<void> {
    return this.continuityMemoryMutation(
      { action: "delete", scope: input.scope, id: input.id, expectedRevision: input.expectedRevision },
      input.expectedGeneration,
    );
  }

  migrateContinuityMemory(input: MigrateContinuityMemoryInput): Promise<void> {
    return this.continuityMemoryMutation({ action: "migrate" }, input.expectedGeneration);
  }

  continuityPlanAction(input: ContinuityPlanActionInput): Promise<void> {
    this.gate.assert(input.expectedGeneration);
    const session = this.controlSession();
    return new Promise<void>((resolve, reject) => {
      let answered = false;
      this.eventBus.emit("pi-continuity:plan-action", {
        version: 1,
        sessionId: session.sessionId,
        expectedGeneration: input.expectedGeneration,
        expectedRevision: input.expectedRevision,
        action: input.action,
        ...(input.action === "approve" ? { resetContext: input.resetContext } : { feedback: input.feedback }),
        respond: (result: unknown | Promise<unknown>) => {
          if (answered) return;
          answered = true;
          Promise.resolve(result).then(() => resolve(), reject);
        },
      });
      if (!answered) reject(new Error("Continuity planning is unavailable"));
    });
  }

  async answerUiRequest(input: UiResponse): Promise<void> {
    this.ui.answer(input);
  }

  keepUiRequestAlive(requestId: string, sessionGeneration: number): string | undefined {
    this.gate.assert(sessionGeneration);
    return this.ui.keepAlive(requestId, sessionGeneration);
  }

  dismissCommandResult(resultId: string, sessionGeneration: number): void {
    this.gate.assert(sessionGeneration);
    if (this.commandResult?.id !== resultId) return;
    this.commandResult = undefined;
    this.emitCommandResult();
    this.refreshSnapshot();
  }

  subscribe(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtimeState(): SessionRuntimeState {
    const runtime = this.requireRuntime();
    if (this.ui.hasPendingDialog) return "attention";
    if (
      runtime.session.isStreaming ||
      runtime.session.pendingMessageCount > 0 ||
      this.indexUpdate ||
      this.operational.jobs.items.some(job => job.state === "running")
    )
      return "running";
    return "idle";
  }

  canSleep(): boolean {
    return this.runtimeState() === "idle" && !this.sessionMutation && !this.packageUpdate && !this.indexUpdate;
  }

  runtimeDetails(): {
    sessionId: string;
    generation: number;
    cwd: string;
    sessionPath?: string;
    name?: string;
    workStartedAt?: string;
    userMessageCount: number;
  } {
    const runtime = this.requireRuntime();
    return {
      sessionId: runtime.session.sessionId,
      generation: this.gate.generation,
      cwd: runtime.cwd,
      sessionPath: runtime.session.sessionFile,
      name: runtime.session.sessionManager.getSessionName(),
      workStartedAt: this.workStartedAt,
      userMessageCount: runtime.session.getSessionStats().userMessages,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.authAbort?.abort();
    this.authAbort = undefined;
    this.authGeneration = undefined;
    this.authFlow = undefined;
    this.ui.dispose();
    this.detachSession();
    this.detachBus();
    this.eventBus.clear();
    const runtime = this.runtime;
    const shouldDisposeRuntime = this.runtimeDisposable;
    this.runtime = undefined;
    this.runtimeDisposable = false;
    if (runtime && shouldDisposeRuntime) await runtime.dispose();
    this.gate.stop();
    this.listeners.clear();
  }

  private installRuntimeHooks(runtime: AgentSessionRuntime): void {
    runtime.setBeforeSessionInvalidate(() => {
      if (this.sessionMutation === "delete") throw new Error("session cannot change while deletion is in progress");
      const oldGeneration = this.gate.generation;
      this.authAbort?.abort();
      this.authAbort = undefined;
      this.authGeneration = undefined;
      this.authFlow = undefined;
      this.ui.cancelGeneration(oldGeneration);
      this.detachSession();
      this.detachBus();
      this.operational = initialOperational([], []);
      if (this.lastSnapshot)
        this.lastSnapshot = { ...this.lastSnapshot, ready: false, operational: cloneOperational(this.operational) };
      this.runtimeDisposable = false;
      if (this.disposed) {
        this.gate.stop();
        return;
      }
      if (this.replacementGeneration === undefined) {
        this.replacementGeneration = this.gate.beginReplacement();
        this.implicitReplacement = true;
      }
      this.gate.invalidateCurrent();
      this.replacementInvalidated = true;
      this.installBusHooks(this.replacementGeneration);
    });
    runtime.setRebindSession(async session => {
      const generation = this.replacementGeneration;
      if (generation === undefined) throw new Error("replacement session arrived without an allocated generation");
      if (this.replacementSessionName) session.setSessionName(this.replacementSessionName);
      this.runtimeDisposable = true;
      this.loadRuntimePolicy(session.sessionId);
      await this.bindSession(session, generation);
      this.gate.commitReplacement();
      this.installBusHooks(generation);
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.implicitReplacement = false;
      this.refreshSnapshot();
      this.emit({
        type: "session.replaced",
        sessionId: session.sessionId,
        sessionGeneration: generation,
        runtime: this.lastSnapshot!,
      });
    });
  }

  private async bindSession(session: AgentSession, generation: number): Promise<void> {
    if (this.timingSessionId !== session.sessionId) {
      this.liveDelegatedRuns.clear();
      this.timingSessionId = session.sessionId;
      this.workStartedAt = undefined;
      this.workStartedAtMs = undefined;
      this.workDurations.clear();
      this.workDurationsLeafId = undefined;
      this.turnGitBranches.clear();
      this.turnGitBranchesLeafId = undefined;
      this.toolDurations.clear();
      this.toolDurationsLeafId = undefined;
      this.activeToolStarts.clear();
      this.turnControls.clear();
      this.turnChanges.clear();
      this.turnChangesLeafId = undefined;
      this.pendingWorktreeTurns.length = 0;
      this.nextTurnId = 0;
      this.workTurnId = undefined;
      this.workUserEntryId = undefined;
      this.workAssistantEntryIdAtStart = undefined;
      this.stopping = false;
      this.stoppedRun = undefined;
      this.compactionContinuation = undefined;
      this.agentError = terminalAgentError(this.transcriptMessages(session));
      this.discoverIndex = undefined;
      this.workModelName = undefined;
      this.workThinkingLevel = undefined;
      this.commandResult = undefined;
      this.commandCapture = undefined;
      this.pendingUserMessageIds.length = 0;
      this.gitBranch = this.readDisplayGitBranch(session.sessionManager.getCwd(), session.sessionId);
    }
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.ui.context(session.sessionId, generation),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: options => this.requireRuntime().newSession(options),
        switchSession: (sessionPath, options) => this.requireRuntime().switchSession(sessionPath, options),
        fork: (entryId, options) => this.requireRuntime().fork(entryId, options),
        navigateTree: (targetId, options) => session.navigateTree(targetId, options),
        reload: () => session.reload(),
      },
      abortHandler: () => {
        if (this.gate.accepts(generation)) void session.abort().catch(error => this.recordError(error));
      },
      shutdownHandler: () => this.options.onShutdownRequested?.(),
      onError: error => this.recordExtensionError(error),
    });
    this.publishRuntimePolicy();
    this.unsubscribeSession = session.subscribe(payload => {
      if (!this.gate.accepts(generation)) return;
      const raw =
        payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
      const kind = String(raw.type ?? "");
      const interruptionId =
        kind === "message_end" || kind === "message_complete"
          ? continuityCompactionInterruptionId(raw.message)
          : undefined;
      if (interruptionId && this.compactionContinuation?.requestId === interruptionId) {
        this.compactionContinuation.interruption = {
          durationMs: Math.min(MAX_WORK_DURATION_MS, Math.max(0, Date.now() - (this.workStartedAtMs ?? Date.now()))),
          assistantEntryId: this.latestAssistantEntryId(session),
        };
        this.transcriptCache = undefined;
        this.conversationProjectionCache = undefined;
        this.emit({
          type: "session.event",
          sessionId: session.sessionId,
          sessionGeneration: generation,
          payload: { type: "continuity_compaction_interruption", message: raw.message },
        });
        return;
      }
      if (kind === "message_end" || kind === "message_complete") {
        queueMicrotask(() => {
          if (!this.gate.accepts(generation) || this.runtime?.session !== session) return;
          this.refreshSnapshot();
          const metrics = this.lastSnapshot?.metrics;
          if (!metrics) return;
          this.emit({
            type: "session.event",
            sessionId: session.sessionId,
            sessionGeneration: generation,
            payload: { type: "usage", metrics },
          });
        });
      }
      let forwarded: unknown = raw;
      const phase =
        kind === "tool_execution_start"
          ? "start"
          : kind === "tool_execution_update"
            ? "update"
            : kind === "tool_execution_end"
              ? "end"
              : undefined;
      if (phase && typeof raw.toolCallId === "string" && raw.toolCallId) {
        const toolCallId = raw.toolCallId;
        if (phase === "start") {
          const startedAtMs = Date.now();
          const startedAt = new Date(startedAtMs).toISOString();
          this.activeToolStarts.set(toolCallId, {
            startedAt,
            startedAtMs,
            name: String(raw.toolName ?? raw.name ?? ""),
            input: browserJson(raw.args ?? raw.input),
          });
          forwarded = { ...raw, startedAt };
        } else if (phase === "end") {
          const started = this.activeToolStarts.get(toolCallId);
          this.activeToolStarts.delete(toolCallId);
          if (started) {
            const durationMs = Math.min(MAX_WORK_DURATION_MS, Math.max(0, Date.now() - started.startedAtMs));
            this.toolDurations.set(toolCallId, durationMs);
            try {
              if (!appendToolDuration(session.sessionManager, toolCallId, durationMs)) {
                this.recordError(new Error("could not persist completed tool duration"));
              }
            } catch (error) {
              this.recordError(error);
            }
            this.toolDurationsLeafId = session.sessionManager.getLeafId();
            forwarded = { ...raw, startedAt: started.startedAt, durationMs };
          }
        }
        const previous = this.liveDelegatedRuns.get(toolCallId);
        const run = projectDelegatedToolEvent(
          phase,
          toolCallId,
          previous,
          raw,
          this.lastSnapshot?.metrics.userMessages ?? session.getSessionStats().userMessages,
        );
        if (run) {
          this.liveDelegatedRuns.delete(run.id);
          this.liveDelegatedRuns.set(run.id, structuredClone(run));
          while (this.liveDelegatedRuns.size > MAX_LIVE_DELEGATED_RUNS) {
            const terminal = [...this.liveDelegatedRuns].find(([, item]) => item.status !== "running");
            this.liveDelegatedRuns.delete(terminal?.[0] ?? this.liveDelegatedRuns.keys().next().value!);
          }
        }
      }
      if (
        deferUserMessageEndEntryId(
          raw,
          () => this.gate.accepts(generation),
          () => this.latestUserEntryId(session),
          forwarded => {
            this.emit({
              type: "session.event",
              sessionId: session.sessionId,
              sessionGeneration: generation,
              payload: forwarded,
            });
          },
        )
      )
        return;
      forwarded = correlatePendingUserMessageStart(forwarded as Record<string, unknown>, this.pendingUserMessageIds);
      if (kind === "agent_start") {
        if (this.workStartedAtMs === undefined) {
          this.workTurnId = `turn-${++this.nextTurnId}`;
          this.workStartedAtMs = Date.now();
          this.workStartedAt = new Date(this.workStartedAtMs).toISOString();
          this.workUserEntryId = this.latestUserEntryId(session);
          this.workAssistantEntryIdAtStart = this.latestAssistantEntryId(session);
        }
        this.workModelName = session.model?.name;
        this.workThinkingLevel = session.supportsThinking() ? session.thinkingLevel : undefined;
        if (this.compactionContinuation?.resuming) {
          this.compactionContinuation = undefined;
        }
        this.stopping = false;
        this.stoppedRun = undefined;
        this.agentError = undefined;
        if (session.sessionFile)
          this.sessionIndex.invalidateSession(session.sessionId, session.sessionFile, session.sessionManager.getCwd());
        this.refreshSnapshot();
        forwarded = {
          ...raw,
          workStartedAt: this.workStartedAt,
          turnId: this.workTurnId,
          modelName: this.workModelName,
          thinkingLevel: this.workThinkingLevel,
          metrics: this.lastSnapshot?.metrics,
        };
      } else if (kind === "agent_end") {
        const duration = Math.min(MAX_WORK_DURATION_MS, Math.max(0, Date.now() - (this.workStartedAtMs ?? Date.now())));
        const continuation = this.compactionContinuation;
        const lastAssistant = Array.isArray(raw.messages)
          ? [...raw.messages]
              .reverse()
              .find(
                message =>
                  message &&
                  typeof message === "object" &&
                  !Array.isArray(message) &&
                  (message as { role?: unknown }).role === "assistant",
              )
          : undefined;
        const compactionInterruption =
          !!continuation?.interruption && continuityCompactionInterruptionId(lastAssistant) === continuation.requestId;
        if (compactionInterruption && continuation?.interruption) {
          continuation.interruption.assistantEntryId = this.compactionInterruptionEntryId(
            session,
            continuation.requestId,
          );
          continuation.interruptedAgentEnded = true;
          if (continuation.abandoned) this.compactionContinuation = undefined;
        }
        const stopped =
          this.stopping || continuation?.abandoned === true || (agentWasAborted(raw) && !compactionInterruption);
        const willRetry = (raw.willRetry === true || compactionInterruption) && !stopped;
        const turnId = this.workTurnId ?? `turn-${++this.nextTurnId}`;
        const modelName = this.workModelName;
        const thinkingLevel = this.workThinkingLevel;
        const userEntryId = this.workUserEntryId;
        this.agentError = willRetry ? undefined : terminalAgentError(raw.messages);
        if (willRetry) {
          if (session.sessionFile)
            this.sessionIndex.invalidateSession(
              session.sessionId,
              session.sessionFile,
              session.sessionManager.getCwd(),
            );
          this.refreshSnapshot();
          forwarded = {
            ...raw,
            workDurationMs: duration,
            turnId,
            modelName,
            thinkingLevel,
            gitBranch: this.gitBranch,
            metrics: this.lastSnapshot?.metrics,
            willRetry: true,
            stopped: false,
            userEntryId,
          };
          this.emit({
            type: "session.event",
            sessionId: session.sessionId,
            sessionGeneration: generation,
            payload: forwarded,
          });
          return;
        }
        const messages = this.transcriptMessages(session);
        let assistantIndex = -1;
        for (let index = messages.length - 1; index >= 0; index--) {
          if ((messages[index] as { role?: unknown } | undefined)?.role === "assistant") {
            assistantIndex = index;
            break;
          }
        }
        const latestAssistantEntryId =
          assistantIndex >= 0 && typeof (messages[assistantIndex] as { entryId?: unknown }).entryId === "string"
            ? (messages[assistantIndex] as { entryId: string }).entryId
            : undefined;
        const assistantEntryId =
          this.workStartedAtMs !== undefined && latestAssistantEntryId !== this.workAssistantEntryIdAtStart
            ? latestAssistantEntryId
            : undefined;
        const messageId = assistantEntryId ? `history-${assistantIndex}` : undefined;
        this.gitBranch = this.readDisplayGitBranch(session.sessionManager.getCwd(), session.sessionId);
        const turnGitBranch =
          this.projectRegistry?.workspaceForSession(session.sessionId)?.mode === "local" ? this.gitBranch : undefined;
        if (assistantEntryId) {
          this.workDurations.set(assistantEntryId, duration);
          if (turnGitBranch) this.turnGitBranches.set(assistantEntryId, turnGitBranch);
          try {
            if (!appendWorkDuration(session.sessionManager, assistantEntryId, duration)) {
              this.recordError(new Error("could not persist completed work duration"));
            }
            if (turnGitBranch && !appendTurnGitBranch(session.sessionManager, assistantEntryId, turnGitBranch)) {
              this.recordError(new Error("could not persist completed turn Git branch"));
            }
          } catch (error) {
            this.recordError(error);
          }
          const leafId = session.sessionManager.getLeafId();
          this.workDurationsLeafId = leafId;
          this.turnGitBranchesLeafId = leafId;
        }
        if (messageId) {
          this.turnControls.set(messageId, { modelName: this.workModelName, thinkingLevel: this.workThinkingLevel });
        }
        this.pendingWorktreeTurns.push({ turnId, messageId, assistantEntryId });
        if (this.pendingWorktreeTurns.length > 20) this.pendingWorktreeTurns.shift();
        if (stopped) {
          this.stoppedRun = {
            turnId,
            ...(this.workUserEntryId ? { userEntryId: this.workUserEntryId } : {}),
            durationMs: duration,
            ...(modelName ? { modelName } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          };
        }
        this.workStartedAt = undefined;
        this.workStartedAtMs = undefined;
        this.workModelName = undefined;
        this.workThinkingLevel = undefined;
        this.workTurnId = undefined;
        this.workUserEntryId = undefined;
        this.workAssistantEntryIdAtStart = undefined;
        this.stopping = false;
        if (session.sessionFile)
          this.sessionIndex.invalidateSession(session.sessionId, session.sessionFile, session.sessionManager.getCwd());
        invalidateFileSuggestions(session.sessionManager.getCwd());
        this.refreshSnapshot();
        const assistantMessage = messageId
          ? this.lastSnapshot?.conversation.messages.find(message => message.id === messageId)
          : undefined;
        forwarded = {
          ...raw,
          workDurationMs: duration,
          turnId,
          modelName,
          thinkingLevel,
          gitBranch: this.gitBranch,
          turnGitBranch,
          metrics: this.lastSnapshot?.metrics,
          stopped,
          userEntryId,
          assistantMessage: assistantMessage ?? null,
          errorMessage: this.agentError,
        };
      } else if (kind === "agent_settled" && this.workStartedAt) {
        if (this.compactionContinuation?.resuming) {
          this.abandonCompactionContinuation(this.compactionContinuation.requestId, generation);
        } else if (!this.compactionContinuation) {
          this.workStartedAt = undefined;
          this.workStartedAtMs = undefined;
          this.workModelName = undefined;
          this.workThinkingLevel = undefined;
          this.workTurnId = undefined;
          this.workUserEntryId = undefined;
          this.workAssistantEntryIdAtStart = undefined;
          this.stopping = false;
          this.refreshSnapshot();
        }
      } else if (kind === "compaction_end" && raw.aborted !== true) {
        const result =
          raw.result && typeof raw.result === "object" && !Array.isArray(raw.result)
            ? (raw.result as Record<string, unknown>)
            : undefined;
        const branch = session.sessionManager.getBranch();
        const entry =
          typeof result?.summary === "string" && typeof result.firstKeptEntryId === "string"
            ? [...branch]
                .reverse()
                .find(
                  (candidate): candidate is CompactionEntry =>
                    candidate.type === "compaction" &&
                    candidate.summary === result.summary &&
                    candidate.firstKeptEntryId === result.firstKeptEntryId,
                )
            : undefined;
        const completedMessage = entry ? projectedCompactionMessage(branch, entry) : undefined;
        if (completedMessage) {
          this.transcriptCache = undefined;
          this.conversationProjectionCache = undefined;
          forwarded = { ...raw, completedMessage };
        }
      } else if (kind === "session_info_changed") {
        if (session.sessionFile)
          this.sessionIndex.invalidateSession(session.sessionId, session.sessionFile, session.sessionManager.getCwd());
        this.refreshSnapshot();
      }
      this.emit({
        type: "session.event",
        sessionId: session.sessionId,
        sessionGeneration: generation,
        payload: forwarded,
      });
    });
  }

  private async replace(action: () => Promise<{ cancelled: boolean }>): Promise<ReplacementResult> {
    const runtime = this.requireRuntime();
    this.replacementGeneration = this.gate.beginReplacement();
    this.replacementInvalidated = false;
    this.implicitReplacement = false;
    try {
      const result = await action();
      if (result.cancelled) {
        this.gate.cancelReplacement();
        this.replacementGeneration = undefined;
        return { cancelled: true, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
      }
      if (!this.gate.ready) throw new Error("replacement completed without rebinding the new session");
      return { cancelled: false, sessionId: runtime.session.sessionId, sessionGeneration: this.gate.generation };
    } catch (error) {
      const invalidated = this.replacementInvalidated;
      if (invalidated) this.gate.failReplacement();
      else this.gate.cancelReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.implicitReplacement = false;
      this.recordError(error);
      if (invalidated) this.publishUnavailable();
      throw error;
    }
  }

  private async recoverSession(session: Pick<SessionInfo, "cwd" | "path">): Promise<void> {
    const createRuntime = this.createRuntime;
    if (!createRuntime) throw new Error("runtime recovery is unavailable");
    await this.rebuildSession(session, createRuntime, true);
  }

  private async rebuildSession(
    session: Pick<SessionInfo, "cwd" | "path">,
    createRuntime: CreateAgentSessionRuntimeFactory,
    recovery: boolean,
  ): Promise<void> {
    const target = this.target;
    if (!target) throw new Error("runtime recovery is unavailable");
    const oldGeneration = this.gate.generation;
    const generation = recovery ? this.gate.beginRecovery() : this.gate.beginReplacement();
    this.replacementGeneration = generation;
    this.replacementInvalidated = true;
    this.implicitReplacement = false;
    if (!recovery) this.gate.invalidateCurrent();
    this.ui.cancelGeneration(oldGeneration);
    this.detachSession();
    this.detachBus();
    this.operational = initialOperational([], []);
    this.installBusHooks(generation);
    const previousSessionFile = this.runtime?.session.sessionFile;
    this.runtimeDisposable = false;
    await this.runtime?.dispose().catch(() => undefined);

    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: session.cwd,
        agentDir: target.agentDir,
        sessionManager: SessionManager.open(session.path),
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
      });
      this.runtime = runtime;
      this.extensionManager = new PiExtensionManager(
        session.cwd,
        target.agentDir,
        runtime.services.settingsManager,
        this.packageState?.packages.flatMap(item => item.extensionPaths),
      );
      this.runtimeDisposable = true;
      this.installRuntimeHooks(runtime);
      await this.bindSession(runtime.session, generation);
      this.gate.commitReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.refreshSnapshot();
      this.emit({
        type: "session.replaced",
        sessionId: runtime.session.sessionId,
        sessionGeneration: generation,
        runtime: this.lastSnapshot!,
      });
    } catch (error) {
      this.detachSession();
      this.detachBus();
      await runtime?.dispose().catch(() => undefined);
      this.gate.failReplacement();
      this.replacementGeneration = undefined;
      this.replacementInvalidated = false;
      this.recordError(error);
      this.publishUnavailable();
      throw error;
    }
  }

  private failImplicitReplacement(error: unknown): void {
    if (!this.implicitReplacement) return;
    const invalidated = this.replacementInvalidated;
    if (invalidated) this.gate.failReplacement();
    else this.gate.cancelReplacement();
    this.replacementGeneration = undefined;
    this.replacementInvalidated = false;
    this.implicitReplacement = false;
    this.recordError(error);
    if (invalidated) this.publishUnavailable();
  }

  private publishUnavailable(): void {
    const runtime = this.requireRuntime();
    if (!this.lastSnapshot) return;
    this.operational = initialOperational([], []);
    this.lastSnapshot = {
      ...this.lastSnapshot,
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      ready: false,
      cwdLabel: this.displayCwdLabel(runtime.cwd, runtime.session.sessionId),
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: [],
        tools: [],
        delegatedRuns: [],
        streaming: false,
        queue: { steering: 0, followUp: 0 },
        retry: { active: false },
        compaction: { active: false },
      },
      operational: cloneOperational(this.operational),
      extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
    };
    this.emit({
      type: "session.unavailable",
      sessionId: this.lastSnapshot.sessionId,
      sessionGeneration: this.gate.generation,
      runtime: this.lastSnapshot,
    });
  }

  private async withSessionMutation<T>(kind: "lifecycle" | "delete", action: () => Promise<T>): Promise<T> {
    if (this.sessionMutation || this.packageUpdate) throw new Error("another session operation is in progress");
    this.sessionMutation = kind;
    try {
      return await action();
    } finally {
      this.sessionMutation = undefined;
    }
  }

  private controlSession(): AgentSession {
    const runtime = this.requireRuntime();
    if (
      !this.gate.ready ||
      !runtime.session.isIdle ||
      this.sessionMutation ||
      this.packageUpdate ||
      this.ui.hasPendingDialog
    ) {
      throw new Error("Session controls can only change while the session is idle");
    }
    return runtime.session;
  }

  private continuityMemoryMutation(mutation: Record<string, unknown>, expectedGeneration: number): Promise<void> {
    this.gate.assert(expectedGeneration);
    const session = this.controlSession();
    return new Promise<void>((resolve, reject) => {
      let answered = false;
      this.eventBus.emit("pi-continuity:memory-mutation", {
        version: 2,
        sessionId: session.sessionId,
        expectedGeneration,
        ...mutation,
        respond: (result: unknown | Promise<unknown>) => {
          if (answered) return;
          answered = true;
          Promise.resolve(result).then(
            () => resolve(),
            error => {
              if (error instanceof Error && /\b(?:stale|changed|revision)\b/i.test(error.message))
                error.name = "StaleMemoryError";
              reject(error);
            },
          );
        },
      });
      if (!answered) reject(new Error("Continuity memory is unavailable"));
    });
  }

  private async resolveSession(sessionId: string): Promise<SessionInventoryEntry> {
    const session = await resolveUniqueSession(sessionId, process.env.PI_CODING_AGENT_DIR || this.target?.agentDir);
    if (!session) throw new Error("session is unavailable");
    return session;
  }

  private refreshSnapshot(): void {
    const runtime = this.requireRuntime();
    const availableTools = runtime.session
      .getAllTools()
      .map(tool => tool.name)
      .sort();
    const available = new Set(availableTools);
    this.diagnostics = runtime.diagnostics
      .slice(0, 50)
      .map(diagnostic => ({ level: diagnostic.type, message: this.sanitizeDiagnostic(diagnostic.message) }));
    const session = runtime.session;
    this.hydrateWorkDurations(session);
    this.hydrateTurnGitBranches(session);
    this.hydrateToolDurations(session);
    this.hydrateTurnChanges(session);
    this.requestPackageStates(session.sessionId);
    const stats = session.getSessionStats();
    const context = session.getContextUsage();
    const messages = this.transcriptMessages(session);
    const leafId = session.sessionManager.getLeafId();
    const tailStart = Math.max(0, messages.length - HISTORY_PAGE_SIZE);
    const historyStart = Math.min(tailStart, latestVisibleUserIndex(messages) ?? tailStart);
    const cachedProjection = this.conversationProjectionCache;
    const projectedConversation =
      cachedProjection?.sessionId === session.sessionId &&
      cachedProjection.leafId === leafId &&
      cachedProjection.historyStart === historyStart
        ? cachedProjection.value
        : projectConversation(messages, {
            start: historyStart,
            limitMessages: false,
            toolDurations: this.toolDurations,
          });
    if (projectedConversation !== cachedProjection?.value) {
      this.conversationProjectionCache = {
        sessionId: session.sessionId,
        leafId,
        historyStart,
        value: projectedConversation,
      };
    }
    const delegatedRuns = mergeDelegatedRuns(projectedConversation.delegatedRuns, [...this.liveDelegatedRuns.values()]);
    const projectedMessages = projectedConversation.messages.map(message => {
      const workDurationMs = message.entryId ? this.workDurations.get(message.entryId) : undefined;
      const gitBranch = message.entryId ? this.turnGitBranches.get(message.entryId) : undefined;
      const controls = this.turnControls.get(message.id);
      const changedFiles = message.entryId ? this.turnChanges.get(message.entryId) : undefined;
      return workDurationMs === undefined && gitBranch === undefined && !controls && !changedFiles
        ? message
        : {
            ...message,
            ...(workDurationMs === undefined ? {} : { workDurationMs }),
            ...(gitBranch === undefined ? {} : { gitBranch }),
            ...controls,
            ...(changedFiles ? { changedFiles: changedFiles.map(file => ({ ...file })) } : {}),
          };
    });
    const model = session.model;
    const models = runtime.services.modelRuntime
      .getAvailableSnapshot()
      .slice(0, 500)
      .map(item => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        thinkingLevels: [...supportedThinkingLevels(item)],
        ...modelCatalogFacts(item),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
    const commands = runtime.services.resourceLoader
      .getExtensions()
      .runtime.getCommands()
      .slice(0, 200)
      .map(command => ({
        name: command.name.slice(0, 120),
        ...(command.description ? { description: command.description.slice(0, 300) } : {}),
        source: command.source,
      }));
    const loadedExtensions = runtime.services.resourceLoader
      .getExtensions()
      .extensions.map(extension => basename(extension.resolvedPath));
    const selectedProject = this.projectRegistry?.projectForSession(session.sessionId, runtime.cwd);
    this.operational = withOperationalCapabilities(
      this.operational,
      availableTools,
      loadedExtensions,
      this.diagnostics,
    );
    this.lastSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: session.sessionId,
      sessionGeneration: this.gate.generation,
      ready: this.gate.ready,
      cwdLabel: selectedProject?.label ?? this.displayCwdLabel(runtime.cwd, session.sessionId),
      projectAvailable: !this.target?.inMemory && Boolean(selectedProject && !selectedProject.archivedAt),
      sessionName: session.sessionManager.getSessionName(),
      gitBranch: this.gitBranch,
      activeTools: session.getActiveToolNames().sort(),
      availableTools,
      optionalCapabilities: Object.fromEntries(
        OPTIONAL_TOOLS.map(tool => [tool, available.has(tool) ? "available" : "unavailable"]),
      ),
      diagnostics: [...this.diagnostics],
      conversation: {
        messages: projectedMessages,
        tools: [...this.activeToolStarts].map(([id, tool]) => ({
          id,
          name: tool.name,
          ...(tool.input === undefined ? {} : { input: tool.input }),
          status: "running" as const,
          startedAt: tool.startedAt,
        })),
        delegatedRuns,
        ...(historyStart > 0
          ? { historyCursor: encodeHistoryCursor(historyStart), historyRemaining: historyStart }
          : {}),
        streaming: session.isStreaming,
        workStartedAt: this.workStartedAt,
        workModelName: this.workModelName,
        workThinkingLevel: this.workThinkingLevel,
        ...(this.stopping ? { stopping: true } : {}),
        ...(this.stoppedRun ? { stoppedRun: { ...this.stoppedRun } } : {}),
        ...(this.agentError ? { agentError: this.agentError } : {}),
        queue: { steering: 0, followUp: 0 },
        retry: { active: false },
        compaction: { active: false },
      },
      sessionControls: {
        model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
        models,
        thinkingLevel: session.supportsThinking() ? session.thinkingLevel : undefined,
        thinkingLevels: session.getAvailableThinkingLevels(),
        commands,
      },
      providerAuth: this.providerAuthSnapshot(),
      operational: this.operational,
      metrics: {
        model: model?.name ?? "No model",
        provider: model?.provider ?? "unavailable",
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        contextTokens: context?.tokens ?? 0,
        contextLimit: context?.contextWindow ?? 0,
        contextPercent: context?.percent ?? 0,
        cost: stats.cost,
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolUsage: this.sessionToolUsage(session),
      },
      ...(this.discoverIndex ? { discoverIndex: { ...this.discoverIndex } } : {}),
      extensionUi: this.ui.snapshot(),
      ...(this.commandResult ? { commandResult: { ...this.commandResult } } : {}),
      runtimePolicy: {
        ...this.runtimePolicy,
        global: {
          ...this.runtimePolicy.global,
          guardRules: { ...(this.runtimePolicy.global.guardRules ?? DEFAULT_GUARD_RULES) },
          toolOverrides: cloneToolOverrides(this.runtimePolicy.global.toolOverrides),
        },
        project: {
          ...this.runtimePolicy.project,
          verify: cloneVerifyPolicy(this.runtimePolicy.project.verify),
          ...(this.runtimePolicy.project.guardRules
            ? { guardRules: { ...this.runtimePolicy.project.guardRules } }
            : {}),
          toolOverrides: cloneToolOverrides(this.runtimePolicy.project.toolOverrides),
        },
        session: {
          toolOverrides: cloneToolOverrides(this.runtimePolicy.session.toolOverrides),
          ...(this.runtimePolicy.session.verify
            ? { verify: cloneVerifyPolicy(this.runtimePolicy.session.verify) }
            : {}),
          ...(this.runtimePolicy.session.timelineEnabled !== undefined
            ? { timelineEnabled: this.runtimePolicy.session.timelineEnabled }
            : {}),
          ...(this.runtimePolicy.session.guardEnabled !== undefined
            ? { guardEnabled: this.runtimePolicy.session.guardEnabled }
            : {}),
          ...(this.runtimePolicy.session.guardRules
            ? { guardRules: { ...this.runtimePolicy.session.guardRules } }
            : {}),
          ...(this.runtimePolicy.session.workspace ? { workspace: this.runtimePolicy.session.workspace } : {}),
          ...(this.runtimePolicy.session.guardTimeoutSeconds !== undefined
            ? { guardTimeoutSeconds: this.runtimePolicy.session.guardTimeoutSeconds }
            : {}),
          ...(this.runtimePolicy.session.clarifyTimeoutSeconds !== undefined
            ? { clarifyTimeoutSeconds: this.runtimePolicy.session.clarifyTimeoutSeconds }
            : {}),
        },
        effective: {
          ...this.runtimePolicy.effective,
          verify: cloneVerifyPolicy(this.runtimePolicy.effective.verify),
          guardRules: { ...(this.runtimePolicy.effective.guardRules ?? DEFAULT_GUARD_RULES) },
          toolOverrides: cloneToolOverrides(this.runtimePolicy.effective.toolOverrides),
        },
        availableVerifyChecks: this.runtimePolicy.availableVerifyChecks.map(check => ({ ...check })),
      },
    };
  }

  private displayProject(cwd: string, sessionId?: string) {
    const selected = this.target?.projectId ? this.projectRegistry?.get(this.target.projectId) : undefined;
    return selected ?? (sessionId ? this.projectRegistry?.projectForSession(sessionId, cwd) : undefined);
  }

  private loadRuntimePolicy(sessionId: string): void {
    const project = this.displayProject(
      this.runtime?.session.sessionManager.getCwd() ?? this.target?.cwd ?? "",
      sessionId,
    );
    this.runtimePolicy =
      project && this.projectRegistry
        ? this.projectRegistry.runtimePolicy(project.id, sessionId)
        : defaultRuntimePolicy();
  }

  private publishRuntimePolicy(): void {
    const sessionId = this.runtime?.session.sessionId;
    if (!sessionId) return;
    this.eventBus.emit("pylon:runtime-policy", {
      version: 2,
      sessionId,
      verify: cloneVerifyPolicy(this.runtimePolicy.effective.verify),
      timelineEnabled: this.runtimePolicy.effective.timelineEnabled,
      guardEnabled: this.runtimePolicy.effective.guardEnabled,
      guardRules: { ...(this.runtimePolicy.effective.guardRules ?? DEFAULT_GUARD_RULES) },
      dialogTimeouts: {
        guard: this.runtimePolicy.effective.guardTimeoutSeconds,
        clarify: this.runtimePolicy.effective.clarifyTimeoutSeconds,
      },
    });
    this.eventBus.emit("pylon:tool-overrides", {
      version: 1,
      overrides: cloneToolOverrides(this.runtimePolicy.effective.toolOverrides),
    });
    this.eventBus.emit("pi-verify:catalog-request", {
      version: 1,
      sessionId,
      respond: (value: unknown) => this.captureVerifyCatalog(value),
    });
  }

  private captureVerifyCatalog(value: unknown): void {
    if (value && typeof (value as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(value).then(
        resolved => this.captureVerifyCatalog(resolved),
        error => this.recordError(error),
      );
      return;
    }
    const raw =
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    if (raw?.version !== 1 || !Array.isArray(raw.checks)) return;
    const checks = raw.checks.slice(0, 100).flatMap(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const check = value as Record<string, unknown>;
      if (
        typeof check.id !== "string" ||
        !check.id ||
        check.id.length > 100 ||
        typeof check.label !== "string" ||
        !check.label ||
        check.label.length > 200 ||
        typeof check.command !== "string" ||
        !check.command ||
        check.command.length > 500
      )
        return [];
      return [{ id: check.id, label: check.label, command: check.command }];
    });
    this.runtimePolicy = { ...this.runtimePolicy, availableVerifyChecks: checks };
    if (this.gate.ready && this.runtime) {
      this.refreshSnapshot();
      this.emit({
        type: "session.event",
        sessionId: this.runtime.session.sessionId,
        sessionGeneration: this.gate.generation,
        payload: { type: "runtime_policy_changed" },
      });
    }
  }

  private displayCwdLabel(cwd: string, sessionId?: string): string {
    return this.displayProject(cwd, sessionId)?.label ?? (basename(cwd) || cwd);
  }

  private readDisplayGitBranch(cwd: string, sessionId?: string): string | undefined {
    return readGitBranch(this.displayProject(cwd, sessionId)?.cwd ?? cwd);
  }

  private captureSpawnProgress(payload: unknown, generation: number): void {
    if (
      !this.gate.accepts(generation) ||
      !this.runtime ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return;
    const raw = payload as Record<string, unknown>;
    const sessionId = this.runtime.session.sessionId;
    const toolCallId = typeof raw.toolCallId === "string" && raw.toolCallId.length <= 256 ? raw.toolCallId : undefined;
    const childId = typeof raw.id === "string" && raw.id.length <= 128 ? raw.id : undefined;
    const runId = typeof raw.runId === "string" && raw.runId.length <= 128 ? raw.runId : undefined;
    const spawnKind = raw.kind === "agent" || raw.kind === "session" ? raw.kind : undefined;
    const phase = raw.phase === "update" || raw.phase === "end" ? raw.phase : undefined;
    if (
      raw.version !== 1 ||
      raw.parentSessionId !== sessionId ||
      !toolCallId ||
      !childId ||
      !runId ||
      !spawnKind ||
      !phase
    )
      return;
    const result =
      raw.result && typeof raw.result === "object" && !Array.isArray(raw.result)
        ? (raw.result as Record<string, unknown>)
        : undefined;
    const details =
      result?.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? (result.details as Record<string, unknown>)
        : undefined;
    const marker =
      details?.piSpawn && typeof details.piSpawn === "object" && !Array.isArray(details.piSpawn)
        ? (details.piSpawn as Record<string, unknown>)
        : undefined;
    if (
      !result ||
      !details ||
      details.background !== true ||
      details.runId !== runId ||
      marker?.version !== 1 ||
      marker.kind !== spawnKind ||
      marker.id !== childId
    )
      return;
    const previous = this.liveDelegatedRuns.get(toolCallId);
    const toolName = spawnKind === "agent" ? "spawn_agent" : "spawn_session";
    if (
      !previous ||
      previous.kind !== toolName ||
      previous.status !== "running" ||
      (previous.threadId && previous.threadId !== childId) ||
      (previous.runId && previous.runId !== runId)
    )
      return;
    const event =
      phase === "update" ? { toolCallId, toolName, partialResult: result } : { toolCallId, toolName, result };
    const run = projectDelegatedToolEvent(
      phase,
      toolCallId,
      previous,
      event,
      this.lastSnapshot?.metrics.userMessages ?? this.runtime.session.getSessionStats().userMessages,
    );
    if (!run || run.threadId !== childId || run.runId !== runId) return;
    this.liveDelegatedRuns.set(toolCallId, structuredClone(run));
    this.emit({
      type: "session.event",
      sessionId,
      sessionGeneration: generation,
      payload: { type: "spawn_progress", phase, toolCallId, toolName, result },
    });
  }

  private installBusHooks(generation: number): void {
    this.detachBus();
    this.busUnsubscribers.push(
      this.eventBus.on("pi-discover:index-state", payload => {
        if (!this.gate.accepts(generation)) return;
        const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
        if (raw?.version !== 1) return;
        if (raw.available === false) {
          this.discoverIndex = undefined;
        } else if (["idle", "indexing", "error"].includes(String(raw.state))) {
          this.discoverIndex = {
            state: raw.state as DiscoverIndexReadModel["state"],
            ...(Number.isSafeInteger(raw.files) && (raw.files as number) >= 0 ? { files: raw.files as number } : {}),
            ...(Number.isSafeInteger(raw.symbols) && (raw.symbols as number) >= 0
              ? { symbols: raw.symbols as number }
              : {}),
            ...(typeof raw.indexedAt === "string" && !Number.isNaN(Date.parse(raw.indexedAt))
              ? { indexedAt: raw.indexedAt }
              : {}),
            ...(typeof raw.error === "string" && raw.error ? { error: raw.error.slice(0, 500) } : {}),
          };
        } else {
          return;
        }
        const sessionId = this.runtime?.session.sessionId;
        if (sessionId)
          this.emit({
            type: "session.event",
            sessionId,
            sessionGeneration: generation,
            payload: { type: "discover_index", value: this.discoverIndex },
          });
      }),
    );
    this.busUnsubscribers.push(
      this.eventBus.on(CONTINUITY_COMPACTION_CHANNEL, payload => {
        if (!this.gate.accepts(generation) || !this.runtime) return;
        const event = parseContinuityCompactionContinuation(payload);
        if (!event || event.sessionId !== this.runtime.session.sessionId) return;
        const continuationMatches = (continuation: ContinuityCompactionContinuation | undefined) =>
          !!continuation &&
          continuation.requestId === event.requestId &&
          continuation.sessionId === event.sessionId &&
          continuation.sessionGeneration === event.sessionGeneration &&
          continuation.taskGeneration === event.taskGeneration;
        if (event.action === "begin") {
          if (continuationMatches(this.compactionContinuation) || this.compactionContinuation) return;
          this.compactionContinuation = {
            requestId: event.requestId,
            sessionId: event.sessionId,
            sessionGeneration: event.sessionGeneration,
            taskGeneration: event.taskGeneration,
          };
          return;
        }
        if (!continuationMatches(this.compactionContinuation)) return;
        if (event.action === "resume") {
          if (!this.compactionContinuation!.interruption || !this.compactionContinuation!.interruptedAgentEnded) return;
          this.compactionContinuation!.resuming = true;
          return;
        }
        this.abandonCompactionContinuation(event.requestId, generation);
      }),
    );
    this.busUnsubscribers.push(
      this.eventBus.on("pi-verify:catalog", payload => {
        if (!this.gate.accepts(generation)) return;
        this.captureVerifyCatalog(payload);
      }),
    );
    this.busUnsubscribers.push(
      this.eventBus.on("pylon:spawn-runtime-policy-request", payload => {
        if (!this.gate.accepts(generation) || !payload || typeof payload !== "object") return;
        const request = payload as { version?: unknown; cwd?: unknown; sessionId?: unknown; provide?: unknown };
        if (
          request.version !== 1 ||
          typeof request.cwd !== "string" ||
          typeof request.sessionId !== "string" ||
          typeof request.provide !== "function"
        )
          return;
        const project = this.projectRegistry?.projectForSession(request.sessionId, request.cwd);
        if (!project) return;
        const policy = this.projectRegistry!.runtimePolicy(project.id, request.sessionId).effective;
        request.provide({
          version: 1,
          enabled: policy.guardEnabled,
          rules: { ...(policy.guardRules ?? DEFAULT_GUARD_RULES) },
          timeoutSeconds: policy.guardTimeoutSeconds,
        });
      }),
    );
    this.busUnsubscribers.push(
      this.eventBus.on("pylon:spawn-progress", payload => {
        this.captureSpawnProgress(payload, generation);
      }),
    );
    for (const channel of [
      "pi-verify:lifecycle",
      "pi-verify:result",
      "pi-heartbeat:job",
      "pi-guard:decision",
      "pylon:tool-policy",
      "pi-continuity:state-change",
      "pi-papercut:state-change",
      "pi-timeline:state-change",
      "pi-sieve:state-change",
    ]) {
      this.busUnsubscribers.push(
        this.eventBus.on(channel, payload => {
          const active = this.gate.accepts(generation);
          const replacing = this.replacementInvalidated && this.replacementGeneration === generation;
          if (!active && !replacing) return;
          const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
          if (replacing && raw?.available === false) return;
          const sessionId = active ? this.runtime?.session.sessionId : undefined;
          if (channel === "pi-timeline:state-change") this.captureTimelineUndo(raw);
          const operational = applyOperationalEvent(
            this.operational,
            channel,
            payload,
            this.diagnostics,
            sessionId,
            value => this.sanitizeOperationalText(value),
          );
          if (operational === this.operational) return;
          this.operational = operational;
          if (active && sessionId)
            this.emit({
              type: "package.event",
              sessionId,
              sessionGeneration: generation,
              channel,
              payload:
                channel === "pi-timeline:state-change" && raw
                  ? Object.fromEntries(
                      Object.entries(raw).filter(
                        ([key]) =>
                          key !== "undoPromptEntryIds" &&
                          key !== "forkPromptEntryIds" &&
                          key !== "forkPromptCheckpoints",
                      ),
                    )
                  : payload,
              operational: cloneOperational(this.operational),
            });
        }),
      );
    }
    this.busUnsubscribers.push(
      this.eventBus.on("pylon:worktree-summary", payload => {
        if (!this.gate.accepts(generation)) return;
        const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
        if (raw?.version !== 1 || typeof raw.known !== "boolean" || !Array.isArray(raw.files)) return;
        const turn = this.pendingWorktreeTurns.shift();
        if (!turn || raw.known !== true || !turn.messageId || !turn.assistantEntryId) return;
        if (raw.assistantEntryId !== undefined && raw.assistantEntryId !== turn.assistantEntryId) return;
        const summary = parseWorktreeSummary({ version: 1, assistantEntryId: turn.assistantEntryId, files: raw.files });
        if (!summary) return;
        const messageId = turn.messageId;
        this.turnChanges.set(summary.assistantEntryId, summary.files);
        this.turnChangesLeafId = this.runtime!.session.sessionManager.getLeafId();
        const sessionId = this.runtime!.session.sessionId;
        this.emit({
          type: "session.event",
          sessionId,
          sessionGeneration: generation,
          payload: { type: "worktree_summary", turnId: turn.turnId, messageId, files: summary.files },
        });
      }),
    );
  }

  private hydrateWorkDurations(session: AgentSession): void {
    const leafId = session.sessionManager.getLeafId();
    if (this.workDurationsLeafId === leafId) return;
    this.workDurations.clear();
    for (const [entryId, durationMs] of readPersistedWorkDurations(session.sessionManager)) {
      this.workDurations.set(entryId, durationMs);
    }
    this.workDurationsLeafId = leafId;
  }

  private hydrateTurnGitBranches(session: AgentSession): void {
    const leafId = session.sessionManager.getLeafId();
    if (this.turnGitBranchesLeafId === leafId) return;
    this.turnGitBranches.clear();
    for (const [entryId, gitBranch] of readPersistedTurnGitBranches(session.sessionManager)) {
      this.turnGitBranches.set(entryId, gitBranch);
    }
    this.turnGitBranchesLeafId = leafId;
  }

  private hydrateToolDurations(session: AgentSession): void {
    const leafId = session.sessionManager.getLeafId();
    if (this.toolDurationsLeafId === leafId) return;
    this.toolDurations.clear();
    for (const [toolCallId, durationMs] of readPersistedToolDurations(session.sessionManager)) {
      this.toolDurations.set(toolCallId, durationMs);
    }
    this.toolDurationsLeafId = leafId;
  }

  private hydrateTurnChanges(session: AgentSession): void {
    const leafId = session.sessionManager.getLeafId();
    if (this.turnChangesLeafId === leafId) return;
    this.turnChanges.clear();
    for (const [entryId, files] of readPersistedWorktreeSummaries(session.sessionManager)) {
      this.turnChanges.set(entryId, files);
    }
    this.turnChangesLeafId = leafId;
  }

  private transcriptMessages(session: AgentSession): unknown[] {
    const sessionId = session.sessionId;
    const leafId = session.sessionManager.getLeafId();
    const cached = this.transcriptCache;
    if (cached?.sessionId === sessionId && cached.leafId === leafId) return cached.messages;
    const branch = session.sessionManager.getBranch();
    const messages = branch.flatMap(entry => {
      if (entry.type === "compaction") return [compactionTranscriptMessage(branch, entry)];
      if (entry.type !== "message" && entry.type !== "custom_message") return [];
      return sessionEntryToContextMessages(entry).map(message => ({
        ...message,
        entryId: entry.id,
        timestamp: (message as { timestamp?: unknown }).timestamp ?? (entry as { timestamp?: unknown }).timestamp,
        ...(this.undoPromptEntryIds.has(entry.id) ? { canUndo: true } : {}),
        ...(this.forkPromptEntryIds.has(entry.id) ? { canForkWithTimeline: true } : {}),
      }));
    });
    this.transcriptCache = { sessionId, leafId, messages };
    return messages;
  }

  private sessionToolUsage(session: AgentSession): ToolUsageReadModel[] {
    const sessionId = session.sessionId;
    const leafId = session.sessionManager.getLeafId();
    const cached = this.toolUsageCache;
    if (cached?.sessionId === sessionId && cached.leafId === leafId) return cached.items;
    const meter = meterFromBranch(session.sessionManager.getBranch());
    const items = [...meter.byTool.entries()]
      .map(([name, usage]) => {
        const inputTokens = estimatedTokens(usage.resultChars);
        const outputTokens = estimatedTokens(usage.argumentChars);
        return { name, calls: usage.calls, inputTokens, outputTokens, tokens: inputTokens + outputTokens };
      })
      .sort(
        (left, right) => right.tokens - left.tokens || right.calls - left.calls || left.name.localeCompare(right.name),
      )
      .slice(0, 200);
    this.toolUsageCache = { sessionId, leafId, items };
    return items;
  }

  private removePendingUserMessage(commandId: string): void {
    const index = this.pendingUserMessageIds.indexOf(commandId);
    if (index >= 0) this.pendingUserMessageIds.splice(index, 1);
  }

  private latestAssistantEntryId(session: AgentSession): string | undefined {
    const branch = session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as { id?: unknown; type?: unknown; message?: { role?: unknown } } | undefined;
      if (entry?.type === "message" && entry.message?.role === "assistant" && typeof entry.id === "string")
        return entry.id;
    }
    return undefined;
  }

  private latestUserEntryId(session: AgentSession): string | undefined {
    const branch = session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as { id?: unknown; type?: unknown; message?: { role?: unknown } } | undefined;
      if (entry?.type === "message" && entry.message?.role === "user" && typeof entry.id === "string") return entry.id;
    }
    return undefined;
  }

  private prepareTimelineEdit(
    session: AgentSession,
    targetEntryId: string,
    rollbackFiles: boolean,
  ): Promise<TimelineEditTransaction | undefined> {
    return new Promise((resolve, reject) => {
      let handled = false;
      this.eventBus.emit("pi-timeline:edit-navigation", {
        version: 1,
        sessionId: session.sessionId,
        targetEntryId,
        rollbackFiles,
        respond: (result: TimelineEditTransaction | Promise<TimelineEditTransaction>) => {
          handled = true;
          void Promise.resolve(result).then(resolve, reject);
        },
      });
      if (handled) return;
      if (rollbackFiles) {
        reject(new Error("Pi Timeline is unavailable for filesystem rollback"));
        return;
      }
      resolve(undefined);
    });
  }

  private confirmTimelinePromptFork(session: AgentSession, checkpointId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let handled = false;
      this.eventBus.emit("pi-timeline:prompt-fork", {
        version: 1,
        sessionId: session.sessionId,
        checkpointId,
        respond: (result: unknown) => {
          handled = true;
          const value = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
          if (value?.version === 1 && value.available === true) resolve();
          else reject(new Error("No compatible Timeline checkpoint exists for this prompt"));
        },
      });
      if (!handled) reject(new Error("Pi Timeline is unavailable for this prompt"));
    });
  }

  private requestPackageStates(sessionId: string): void {
    for (const channel of [
      "pi-continuity:state-request",
      "pi-papercut:state-request",
      "pi-timeline:state-request",
      "pi-sieve:state-request",
    ]) {
      let answered = false;
      try {
        this.eventBus.emit(channel, {
          version:
            channel === "pi-timeline:state-request"
              ? 4
              : channel === "pi-sieve:state-request" || channel === "pi-papercut:state-request"
                ? 1
                : 4,
          sessionId,
          respond: (payload: unknown) => {
            const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
            if (answered || raw?.sessionId !== sessionId) return;
            answered = true;
            const stateChannel = channel.replace("state-request", "state-change");
            if (stateChannel === "pi-timeline:state-change") this.captureTimelineUndo(raw, false);
            this.operational = applyOperationalEvent(
              this.operational,
              stateChannel,
              payload,
              this.diagnostics,
              sessionId,
              value => this.sanitizeOperationalText(value),
            );
          },
        });
      } catch (error) {
        this.recordError(error);
      }
    }
  }

  private captureTimelineUndo(raw?: Record<string, unknown>, publish = true): void {
    if (raw?.version !== 4 || !Array.isArray(raw.undoPromptEntryIds)) return;
    const available = raw.available === true;
    this.undoPromptEntryIds = new Set(
      (available ? raw.undoPromptEntryIds : [])
        .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128)
        .slice(0, 10_000),
    );
    this.forkPromptEntryIds = new Set(
      available && Array.isArray(raw.forkPromptEntryIds)
        ? raw.forkPromptEntryIds
            .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128)
            .slice(0, 10_000)
        : [],
    );
    this.forkPromptCheckpoints = new Map(
      available && Array.isArray(raw.forkPromptCheckpoints)
        ? raw.forkPromptCheckpoints
            .flatMap(value => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return [];
              const item = value as Record<string, unknown>;
              return typeof item.promptEntryId === "string" &&
                item.promptEntryId.length <= 128 &&
                typeof item.checkpointId === "string" &&
                item.checkpointId.length <= 128
                ? [[item.promptEntryId, item.checkpointId] as const]
                : [];
            })
            .slice(0, 10_000)
        : [],
    );
    const sessionId = this.runtime?.session.sessionId;
    if (!publish || !sessionId) return;
    this.emit({
      type: "session.event",
      sessionId,
      sessionGeneration: this.gate.generation,
      payload: {
        type: "prompt_undo",
        entryIds: [...this.undoPromptEntryIds],
        forkEntryIds: [...this.forkPromptEntryIds],
      },
    });
  }

  private compactionInterruptionEntryId(session: AgentSession, requestId: string): string | undefined {
    const branch = session.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        continuityCompactionInterruptionId(entry.message) === requestId
      )
        return entry.id;
    }
    return undefined;
  }

  private abandonCompactionContinuation(requestId: string, generation: number): void {
    const continuation = this.compactionContinuation;
    const session = this.runtime?.session;
    if (!continuation || continuation.requestId !== requestId || !session || !this.gate.accepts(generation)) return;
    if (!continuation.interruption) {
      this.compactionContinuation = undefined;
      return;
    }
    continuation.abandoned = true;
    if (!continuation.interruptedAgentEnded) return;
    this.compactionContinuation = undefined;
    const interruption = continuation.interruption;
    const assistantEntryId = interruption.assistantEntryId ?? this.compactionInterruptionEntryId(session, requestId);
    if (assistantEntryId) {
      this.workDurations.set(assistantEntryId, interruption.durationMs);
      try {
        if (!appendWorkDuration(session.sessionManager, assistantEntryId, interruption.durationMs))
          this.recordError(new Error("could not persist abandoned compaction duration"));
      } catch (error) {
        this.recordError(error);
      }
      this.workDurationsLeafId = session.sessionManager.getLeafId();
    }
    const turnId = this.workTurnId ?? `turn-${++this.nextTurnId}`;
    const stoppedRun = {
      turnId,
      ...(this.workUserEntryId ? { userEntryId: this.workUserEntryId } : {}),
      durationMs: interruption.durationMs,
      ...(this.workModelName ? { modelName: this.workModelName } : {}),
      ...(this.workThinkingLevel ? { thinkingLevel: this.workThinkingLevel } : {}),
    };
    this.stoppedRun = stoppedRun;
    this.workStartedAt = undefined;
    this.workStartedAtMs = undefined;
    this.workModelName = undefined;
    this.workThinkingLevel = undefined;
    this.workTurnId = undefined;
    this.workUserEntryId = undefined;
    this.workAssistantEntryIdAtStart = undefined;
    this.stopping = false;
    this.transcriptCache = undefined;
    this.conversationProjectionCache = undefined;
    this.refreshSnapshot();
    this.emit({
      type: "session.event",
      sessionId: session.sessionId,
      sessionGeneration: generation,
      payload: {
        type: "agent_end",
        workDurationMs: interruption.durationMs,
        turnId,
        modelName: stoppedRun.modelName,
        thinkingLevel: stoppedRun.thinkingLevel,
        stopped: true,
        userEntryId: stoppedRun.userEntryId,
        assistantMessage: null,
      },
    });
  }

  private detachBus(): void {
    for (const unsubscribe of this.busUnsubscribers.splice(0)) unsubscribe();
  }

  private sessionFor(expectedGeneration: number): AgentSession {
    this.gate.assert(expectedGeneration);
    return this.requireRuntime().session;
  }

  private accepted(commandId: string): AcceptedCommand {
    return { commandId, sessionGeneration: this.gate.generation, accepted: true };
  }

  private publishUi(request: UiRequest): void {
    if (!this.gate.acceptsUi(request.sessionGeneration)) return;
    if (request.method === "notify" && this.commandCapture) {
      this.commandCapture.notifications.push(request);
      return;
    }
    this.emitUi(request);
  }

  private emitUi(request: UiRequest): void {
    this.emit({
      type: "ui.event",
      sessionId: request.sessionId,
      sessionGeneration: request.sessionGeneration,
      payload: request,
    });
  }

  private emitCommandResult(): void {
    const runtime = this.requireRuntime();
    this.emit({
      type: "command.result",
      sessionId: runtime.session.sessionId,
      sessionGeneration: this.gate.generation,
      ...(this.commandResult ? { result: { ...this.commandResult } } : {}),
    });
  }

  private publishUiClosed(request: UiRequest): void {
    this.emit({
      type: "ui.closed",
      sessionId: request.sessionId,
      sessionGeneration: request.sessionGeneration,
      requestId: request.requestId,
    });
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private detachSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("runtime has not started");
    return this.runtime;
  }

  private recordExtensionError(error: ExtensionError): void {
    this.diagnostics.push({
      level: "error",
      message: this.sanitizeDiagnostic(`${basename(error.extensionPath)} failed during ${error.event}`),
    });
    this.diagnostics = this.diagnostics.slice(-50);
  }

  private recordError(error: unknown): void {
    this.diagnostics.push({
      level: "error",
      message: this.sanitizeDiagnostic(error instanceof Error ? error.message : String(error)),
    });
    this.diagnostics = this.diagnostics.slice(-50);
  }

  private sanitizeOperationalText(message: string): string {
    return this.sanitizeDiagnostic(message).replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*)\s*=\s*\S+/g,
      "$1=<redacted>",
    );
  }

  private sanitizeDiagnostic(message: string): string {
    let safe = message;
    for (const path of [this.target?.cwd, this.target?.agentDir, this.target?.repositoryRoot]) {
      if (path) safe = safe.split(path).join("<path>");
    }
    return safe
      .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
      .slice(0, 2_000);
  }
}

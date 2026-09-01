import { validGuardRules } from "../guard-policy.ts";
import { parseStateQLPanelCommand } from "pi-stateql/stateql-command";
import { COMMAND_NAMES, type WebCommand } from "./commands.ts";
import { PROTOCOL_VERSION, type WebEvent } from "./envelope.ts";
import {
  MAX_COMPACTION_DISPLAY_HISTORY_ITEMS,
  MAX_COMPACTION_DISPLAY_PATH,
  MAX_COMPACTION_DISPLAY_RECORDS,
  MAX_COMPACTION_DISPLAY_SOURCE_ID,
  MAX_COMPACTION_DISPLAY_TEXT,
} from "./events.ts";
import type {
  ArchiveListSnapshot,
  ConversationHistoryPage,
  ConversationTurnIndexPage,
  ExtensionListSnapshot,
  FileSuggestionList,
  HookSettingsReadModel,
  HookSettingsSnapshot,
  PackageListSnapshot,
  PackageSettingsReadModel,
  PapercutListPage,
  RuntimeSnapshot,
  SessionListSnapshot,
  UsageSnapshot,
  StateQLRowsPage,
  StateQLCommandInput,
  StateQLSnapshot,
  WorkspaceFileContent,
  WorkspaceFilePage,
} from "./snapshots.ts";

const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TEXT_FILES = 100;
const MAX_TEXT_FILE_TOTAL_BYTES = 10 * 1024 * 1024;
const commandNames = new Set<string>(COMMAND_NAMES);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const extensionPackageName = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s]+)?$/i;
const extensionGitSource = /^(?:git:(?:[^\s]+)|(?:https?|ssh|git):\/\/[^\s]+)$/i;
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const runtimeStates = new Set(["sleeping", "idle", "running", "attention"]);
const memoryScopes = new Set(["user", "project"]);
const memoryAuthorities = new Set(["user_instruction", "project_contract", "imported"]);
const memoryOrigins = new Set(["user", "agent", "migration"]);
const memoryDispositions = new Set([
  "archival",
  "eligible_advisory",
  "eligible_enforced",
  "quarantined",
  "superseded",
  "revoked",
]);
const memoryEnforcementAuthorities = new Set(["context_only", "warning", "validation", "blocking_guard"]);
const memoryNoteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delegatedAgentKinds = new Set(["advisor", "grunt", "repo_scout", "web_scout", "spawn_agent", "spawn_session"]);
const workspaceModes = new Set(["checkout", "worktree", "local"]);
const sessionWorkspaceModes = new Set(["worktree", "checkout", "local", "non-git"]);
const inheritedWorkspaceModes = new Set(["inherit", "checkout", "worktree", "local"]);
const toolStatuses = new Set(["running", "completed", "failed", "attention"]);
const delegatedRunStatuses = new Set(["running", "completed", "failed", "attention"]);
const healthStatuses = new Set(["healthy", "degraded", "unavailable"]);
const policyToggles = new Set(["inherit", "enabled", "disabled"]);
const sieveModes = new Set(["enabled", "observe", "disabled"]);
const sieveLatestModes = new Set(["enabled", "observe"]);
const sieveProjectionModes = new Set(["stable", "legacy", "standard-v2"]);
const spawnExecutionActions = new Set(["create", "continue", "adopt"]);

const usageAgents = new Set(["main", "advisor", "grunt", "scout", "private", "other", "unknown"]);
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function boundedString(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validOptionalToolTiming(value: Record<string, unknown>): boolean {
  return (
    (value.startedAt === undefined ||
      (typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt)))) &&
    (value.durationMs === undefined ||
      (Number.isSafeInteger(value.durationMs) &&
        (value.durationMs as number) >= 0 &&
        (value.durationMs as number) <= 7 * 24 * 60 * 60 * 1_000))
  );
}

function validMessageAttachments(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_IMAGES + MAX_TEXT_FILES &&
      value.every(
        attachment =>
          record(attachment) &&
          identifier(attachment.sourceEntryId) &&
          Number.isSafeInteger(attachment.index) &&
          (attachment.index as number) >= 0 &&
          (attachment.index as number) < MAX_TEXT_FILES &&
          (attachment.kind === "image" || attachment.kind === "file") &&
          typeof attachment.name === "string" &&
          attachment.name.length > 0 &&
          attachment.name.length <= 255 &&
          typeof attachment.mimeType === "string" &&
          attachment.mimeType.length > 0 &&
          attachment.mimeType.length <= 120 &&
          Number.isSafeInteger(attachment.size) &&
          (attachment.size as number) > 0 &&
          (attachment.size as number) <= MAX_IMAGE_TOTAL_BYTES,
      ))
  );
}

function validImages(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES) return false;
  let totalBytes = 0;
  for (const image of value) {
    if (
      !record(image) ||
      !imageMimeTypes.has(String(image.mimeType)) ||
      typeof image.data !== "string" ||
      image.data.length === 0 ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    )
      return false;
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const bytes = (image.data.length / 4) * 3 - padding;
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return false;
    totalBytes += bytes;
  }
  return totalBytes <= MAX_IMAGE_TOTAL_BYTES;
}

function validTextFiles(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TEXT_FILES) return false;
  let totalBytes = 0;
  for (const file of value) {
    if (
      !record(file) ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255 ||
      /[\/\\\0]/.test(file.name) ||
      typeof file.text !== "string" ||
      !file.text ||
      file.text.includes("\0") ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) <= 0 ||
      (file.mimeType !== undefined && (typeof file.mimeType !== "string" || file.mimeType.length > 120))
    )
      return false;
    const bytes = new TextEncoder().encode(file.text).byteLength;
    if (bytes !== file.size) return false;
    totalBytes += bytes;
  }
  return totalBytes <= MAX_TEXT_FILE_TOTAL_BYTES;
}

function validVerifyPolicy(value: unknown, allowInherit = false): boolean {
  if (!record(value)) return false;
  if (allowInherit && value.mode === "inherit") return true;
  if (value.mode === "auto") return true;
  return (
    value.mode === "selected" &&
    Array.isArray(value.checks) &&
    value.checks.length <= 6 &&
    value.checks.every(check => boundedString(check, 100)) &&
    new Set(value.checks).size === value.checks.length
  );
}

function validDialogTimeout(value: unknown, allowInherit = false): boolean {
  return (
    value === null ||
    (allowInherit && value === "inherit") ||
    (Number.isSafeInteger(value) && (value as number) >= 15 && (value as number) <= 86_400)
  );
}

function validToolOverrides(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(
      ([tool, mode]) => boundedString(tool, 200) && (mode === "active" || mode === "deferred" || mode === "disabled"),
    )
  );
}

export function validHookSettings(value: unknown): value is HookSettingsReadModel {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !record(value.sessionStart) ||
    !record(value.beforeAgentStart)
  )
    return false;
  let totalBytes = 0;
  const hook = (item: Record<string, unknown>) => {
    if (
      Object.keys(item).length !== 2 ||
      typeof item.enabled !== "boolean" ||
      !Array.isArray(item.sources) ||
      item.sources.length > 20
    )
      return false;
    const ids = new Set<string>();
    for (const source of item.sources) {
      if (
        !record(source) ||
        ![4, 5].includes(Object.keys(source).length) ||
        !identifier(source.id) ||
        !boundedString(source.name, 200) ||
        (source.kind !== "file" && source.kind !== "text") ||
        typeof source.content !== "string" ||
        (source.reinjectOnCompaction !== undefined && typeof source.reinjectOnCompaction !== "boolean") ||
        Object.keys(source).some(key => !["id", "name", "kind", "content", "reinjectOnCompaction"].includes(key))
      )
        return false;
      const bytes = new TextEncoder().encode(source.content).byteLength;
      if (bytes > 64 * 1024 || ids.has(source.id)) return false;
      ids.add(source.id);
      totalBytes += bytes;
    }
    return true;
  };
  return hook(value.sessionStart) && hook(value.beforeAgentStart) && totalBytes <= 96 * 1024;
}

const genericApplyTimings = new Set(["immediate", "next-operation", "next-session", "reload"]);
const MAX_GENERIC_PACKAGE_FIELDS = 50;
const MAX_GENERIC_NUMBER = 1_000_000_000;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function validGenericNumber(value: unknown, integer = false): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_GENERIC_NUMBER &&
    (!integer || Number.isSafeInteger(value))
  );
}

function validGenericChoices(value: unknown, required: boolean): value is string[] | undefined {
  return (
    (value === undefined && !required) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 100 &&
      value.every(item => boundedString(item, 500)) &&
      new Set(value).size === value.length)
  );
}

function validGenericBounds(value: Record<string, unknown>, integer: boolean): boolean {
  return (
    (value.min === undefined || validGenericNumber(value.min, integer)) &&
    (value.max === undefined || validGenericNumber(value.max, integer)) &&
    (value.min === undefined || value.max === undefined || (value.min as number) <= (value.max as number)) &&
    (value.step === undefined || (validGenericNumber(value.step, integer) && (value.step as number) > 0))
  );
}

function validGenericStringList(value: unknown, choices: string[] | undefined, min: unknown, max: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    (min === undefined || value.length >= (min as number)) &&
    (max === undefined || value.length <= (max as number)) &&
    value.every(item => typeof item === "string" && item.length <= 500 && (!choices || choices.includes(item))) &&
    new Set(value).size === value.length
  );
}

function validGenericPackageField(value: unknown): boolean {
  if (!record(value)) return false;
  const base = ["version", "key", "label", "type", "defaultValue", "value", "description", "unit", "apply"];
  if (
    !exactKeys(value, [...base, "step", "min", "max", "choices"]) ||
    value.version !== 1 ||
    !boundedString(value.key, 128) ||
    !boundedString(value.label, 200) ||
    (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 500)) ||
    (value.unit !== undefined && !boundedString(value.unit, 64)) ||
    !genericApplyTimings.has(String(value.apply))
  )
    return false;
  if (value.type === "boolean") {
    return (
      value.step === undefined &&
      value.min === undefined &&
      value.max === undefined &&
      value.choices === undefined &&
      typeof value.defaultValue === "boolean" &&
      typeof value.value === "boolean"
    );
  }
  if (value.type === "integer" || value.type === "number") {
    const integer = value.type === "integer";
    return (
      value.choices === undefined &&
      validGenericBounds(value, integer) &&
      validGenericNumber(value.defaultValue, integer) &&
      validGenericNumber(value.value, integer) &&
      (value.min === undefined || (value.defaultValue as number) >= (value.min as number)) &&
      (value.max === undefined || (value.defaultValue as number) <= (value.max as number)) &&
      (value.min === undefined || (value.value as number) >= (value.min as number)) &&
      (value.max === undefined || (value.value as number) <= (value.max as number))
    );
  }
  if (value.type === "enum") {
    return (
      value.step === undefined &&
      value.min === undefined &&
      value.max === undefined &&
      validGenericChoices(value.choices, true) &&
      typeof value.defaultValue === "string" &&
      typeof value.value === "string" &&
      (value.choices as string[]).includes(value.defaultValue) &&
      (value.choices as string[]).includes(value.value)
    );
  }
  if (value.type === "string-list") {
    return (
      value.step === undefined &&
      validGenericBounds(value, true) &&
      validGenericChoices(value.choices, false) &&
      validGenericStringList(value.defaultValue, value.choices as string[] | undefined, value.min, value.max) &&
      validGenericStringList(value.value, value.choices as string[] | undefined, value.min, value.max)
    );
  }
  return false;
}

function validGenericPackageSettings(value: Record<string, unknown>): boolean {
  return (
    exactKeys(value, ["kind", "packageId", "fields"]) &&
    identifier(value.packageId) &&
    Array.isArray(value.fields) &&
    value.fields.length <= MAX_GENERIC_PACKAGE_FIELDS &&
    new Set(value.fields.map(field => (record(field) ? field.key : undefined))).size === value.fields.length &&
    value.fields.every(validGenericPackageField)
  );
}


export function validPackageSettings(value: unknown): value is PackageSettingsReadModel {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "generic") return validGenericPackageSettings(value);
  const modelMode = value.mode === "disabled" || value.mode === "session" || value.mode === "model";
  const model = value.model === undefined || boundedString(value.model, 400);
  const thinking = value.thinking === undefined || thinkingLevels.has(String(value.thinking));
  if (value.kind === "advisor") {
    return (
      modelMode &&
      model &&
      thinking &&
      value.webSearch === undefined &&
      Number.isSafeInteger(value.maxCalls) &&
      (value.maxCalls as number) >= 1 &&
      (value.maxCalls as number) <= 10 &&
      Number.isSafeInteger(value.timeoutMs) &&
      (value.timeoutMs as number) >= 1_000 &&
      (value.timeoutMs as number) <= 7_200_000 &&
      typeof value.maxCostUsd === "number" &&
      Number.isFinite(value.maxCostUsd) &&
      value.maxCostUsd >= 0.01 &&
      value.maxCostUsd <= 100 &&
      Number.isSafeInteger(value.maxOutputTokens) &&
      (value.maxOutputTokens as number) >= 256 &&
      (value.maxOutputTokens as number) <= 65_536 &&
      Number.isSafeInteger(value.inputTokenBudget) &&
      (value.inputTokenBudget as number) >= 1_000 &&
      (value.inputTokenBudget as number) <= 1_000_000 &&
      (value.mode !== "model" || boundedString(value.model, 400))
    );
  }
  if (value.kind === "scout") {
    return (
      modelMode &&
      model &&
      thinking &&
      (value.mode !== "model" || boundedString(value.model, 400)) &&
      (value.webSearch === undefined || typeof value.webSearch === "boolean") &&
      Number.isSafeInteger(value.repoTimeoutMs) &&
      (value.repoTimeoutMs as number) >= 1 &&
      (value.repoTimeoutMs as number) <= 7_200_000 &&
      typeof value.maxCostUsd === "number" &&
      Number.isFinite(value.maxCostUsd) &&
      value.maxCostUsd >= 0 &&
      value.maxCostUsd <= 100 &&
      Number.isSafeInteger(value.webSearchResults) &&
      (value.webSearchResults as number) >= 1 &&
      (value.webSearchResults as number) <= 8
    );
  }
  const validThinkingList = (levels: unknown) =>
    Array.isArray(levels) &&
    levels.length > 0 &&
    new Set(levels).size === levels.length &&
    levels.every(level => thinkingLevels.has(String(level)));
  if (value.kind === "grunt") {
    return (
      modelMode &&
      model &&
      (value.mode !== "model" || boundedString(value.model, 400)) &&
      ["isolated", "direct", "dynamic"].includes(String(value.executionMode)) &&
      validThinkingList(value.thinkingLevels) &&
      Number.isSafeInteger(value.timeoutMs) &&
      (value.timeoutMs as number) >= 1 &&
      (value.timeoutMs as number) <= 7_200_000 &&
      Number.isSafeInteger(value.maxTurns) &&
      (value.maxTurns as number) >= 1 &&
      (value.maxTurns as number) <= 1_000 &&
      typeof value.maxCostUsd === "number" &&
      Number.isFinite(value.maxCostUsd) &&
      value.maxCostUsd >= 0.01 &&
      value.maxCostUsd <= 100 &&
      Number.isSafeInteger(value.parentContextChars) &&
      (value.parentContextChars as number) >= 0 &&
      (value.parentContextChars as number) <= 12_000
    );
  }
  if (value.kind === "continuity") {
    return (
      typeof value.memoryEnabled === "boolean" &&
      Number.isSafeInteger(value.reserveTokens) &&
      (value.reserveTokens as number) >= 1_000 &&
      (value.reserveTokens as number) <= 1_000_000 &&
      Number.isSafeInteger(value.keepRecentTokens) &&
      (value.keepRecentTokens as number) >= 1_000 &&
      (value.keepRecentTokens as number) <= 50_000 &&
      Number.isSafeInteger(value.compactionReviewTimeoutMs) &&
      (value.compactionReviewTimeoutMs as number) >= 1_000 &&
      (value.compactionReviewTimeoutMs as number) <= 300_000 &&
      Number.isSafeInteger(value.compactionReviewerMaxOutputTokens) &&
      (value.compactionReviewerMaxOutputTokens as number) >= 256 &&
      (value.compactionReviewerMaxOutputTokens as number) <= 8_192 &&
      ["planner", "executor", "memoryReviewer", "compactionReviewer"].every(key => {
        const profile = value[key];
        return (
          profile === undefined ||
          (record(profile) &&
            boundedString(profile.model, 400) &&
            (profile.thinking === undefined || thinkingLevels.has(String(profile.thinking))))
        );
      })
    );
  }
  if (value.kind === "sieve") {
    return (
      typeof value.activePruning === "boolean" &&
      (value.projectionMode === "stable" ||
        value.projectionMode === "legacy" ||
        value.projectionMode === "standard-v2") &&
      Number.isSafeInteger(value.threshold) &&
      (value.threshold as number) >= 1_000 &&
      (value.threshold as number) <= 50_000 &&
      Number.isSafeInteger(value.rolloverHighMultiplier) &&
      Number.isSafeInteger(value.rolloverLowMultiplier) &&
      (value.rolloverLowMultiplier as number) >= 1 &&
      (value.rolloverHighMultiplier as number) <= 64 &&
      (value.rolloverHighMultiplier as number) > (value.rolloverLowMultiplier as number)
    );
  }
  if (value.kind === "timeline") {
    return (
      typeof value.editRollbackDefault === "boolean" &&
      (value.checkpointTitleMode === "disabled" ||
        value.checkpointTitleMode === "session" ||
        value.checkpointTitleMode === "model") &&
      (value.checkpointTitleModel === undefined || boundedString(value.checkpointTitleModel, 400)) &&
      (value.checkpointTitleMode !== "model" || boundedString(value.checkpointTitleModel, 400)) &&
      Number.isSafeInteger(value.gitTimeoutMs) &&
      (value.gitTimeoutMs as number) >= 1_000 &&
      (value.gitTimeoutMs as number) <= 600_000 &&
      Number.isSafeInteger(value.titleTimeoutMs) &&
      (value.titleTimeoutMs as number) >= 1_000 &&
      (value.titleTimeoutMs as number) <= 300_000 &&
      Number.isSafeInteger(value.titleMaxTokens) &&
      (value.titleMaxTokens as number) >= 8 &&
      (value.titleMaxTokens as number) <= 256 &&
      Number.isSafeInteger(value.titleChangedFiles) &&
      (value.titleChangedFiles as number) >= 1 &&
      (value.titleChangedFiles as number) <= 200
    );
  }
  return (
    value.kind === "spawn" &&
    (value.agentAvailability === "deferred" || value.agentAvailability === "active") &&
    (value.sessionAvailability === "deferred" || value.sessionAvailability === "active") &&
    (value.models === undefined ||
      (Array.isArray(value.models) &&
        value.models.length > 0 &&
        new Set(value.models).size === value.models.length &&
        value.models.every(model => boundedString(model, 400)))) &&
    validThinkingList(value.agentThinkingLevels) &&
    Number.isSafeInteger(value.spawnTimeoutMs) &&
    (value.spawnTimeoutMs as number) >= 0 &&
    (value.spawnTimeoutMs as number) <= 7_200_000 &&
    Number.isSafeInteger(value.recentThreadLimit) &&
    (value.recentThreadLimit as number) >= 1 &&
    (value.recentThreadLimit as number) <= 50 &&
    Number.isSafeInteger(value.recentThreadMaxChars) &&
    (value.recentThreadMaxChars as number) >= 100 &&
    (value.recentThreadMaxChars as number) <= 10_000 &&
    Number.isSafeInteger(value.recentThreadTotalChars) &&
    (value.recentThreadTotalChars as number) >= 1_000 &&
    (value.recentThreadTotalChars as number) <= 100_000
  );
}

/** Validates prompt text, attachments, and the actions that target one prompt. */
function commandPromptError(value: Record<string, unknown>, type: string): string | undefined {
  if (["prompt", "queuePrompt", "steer", "followUp", "editPrompt"].includes(type)) {
    if (
      typeof value.message !== "string" ||
      value.message.length > MAX_MESSAGE_LENGTH ||
      (!value.message.length && !Array.isArray(value.images) && !Array.isArray(value.files))
    ) {
      return "invalid message";
    }
    if (!validImages(value.images)) return "invalid images";
    if (!validTextFiles(value.files)) return "invalid text files";
  }
  if (["prompt", "queuePrompt"].includes(type) && value.planMode !== undefined && typeof value.planMode !== "boolean") {
    return "invalid prompt mode";
  }
  if (["restoreQueuedPrompt", "steerQueuedPrompt"].includes(type) && !identifier(value.queueId)) {
    return "invalid queueId";
  }
  if (type === "continuityPlanAction") {
    if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1)
      return "invalid plan revision";
    if (value.action === "approve") {
      if (typeof value.resetContext !== "boolean") return "invalid plan approval";
    } else if (value.action === "requestChanges") {
      if (!boundedString(value.feedback, 1_000) || !value.feedback.trim()) return "invalid plan feedback";
    } else return "invalid plan action";
  }
  if (type === "editPrompt" && (!identifier(value.entryId) || typeof value.rollbackFiles !== "boolean")) {
    return "invalid prompt edit";
  }
  if (type === "rewindPrompt" && !identifier(value.entryId)) {
    return "invalid prompt rewind";
  }
  return undefined;
}

/** Validates session, project, fork, and new-session targets. */
function commandTargetError(value: Record<string, unknown>, type: string): string | undefined {
  if (
    [
      "switchSession",
      "deleteSession",
      "archiveSession",
      "restoreSession",
      "renameSession",
      "setSessionActive",
      "setSessionPinned",
      "reorderActiveSession",
    ].includes(type) &&
    !identifier(value.sessionId)
  ) {
    return "invalid sessionId";
  }
  if (
    [
      "removeProject",
      "renameProject",
      "reorderProject",
      "archiveProject",
      "restoreProject",
      "updateProjectWorktreeSettings",
    ].includes(type) &&
    !identifier(value.projectId)
  ) {
    return "invalid projectId";
  }
  if (
    type === "renameProject" &&
    (!boundedString(value.name) || !value.name.trim() || /[\u0000-\u001f\u007f]/.test(value.name))
  ) {
    return "invalid project name";
  }
  if (type === "renameSession" && (!boundedString(value.name) || !value.name.trim())) {
    return "invalid session name";
  }
  if (type === "setSessionActive" && typeof value.active !== "boolean") {
    return "invalid session active state";
  }
  if (type === "setSessionPinned" && typeof value.pinned !== "boolean") {
    return "invalid session pinned state";
  }
  if (type === "reorderProject" && value.beforeProjectId !== undefined && !identifier(value.beforeProjectId)) {
    return "invalid project reorder target";
  }
  if (type === "reorderActiveSession" && value.beforeSessionId !== undefined && !identifier(value.beforeSessionId)) {
    return "invalid active session reorder target";
  }
  if (type === "fork") {
    if (!identifier(value.entryId)) return "invalid entryId";
    if (!boundedString(value.name, 200) || !value.name.trim()) {
      return "invalid fork name";
    }
    if (value.position !== undefined && value.position !== "before" && value.position !== "at") {
      return "invalid fork position";
    }
    if (value.mode !== undefined && value.mode !== "conversation" && value.mode !== "timeline") {
      return "invalid fork mode";
    }
  }
  if (type === "newSession" && value.parentSessionId !== undefined && !identifier(value.parentSessionId)) {
    return "invalid parentSessionId";
  }
  if (type === "newSession" && value.projectId !== undefined && !identifier(value.projectId)) {
    return "invalid projectId";
  }
  if (type === "newSession" && value.projectId !== undefined && value.parentSessionId !== undefined) {
    return "newSession accepts either projectId or parentSessionId";
  }
  return undefined;
}

/** Validates timeline checkpoint commands. */
function commandTimelineError(value: Record<string, unknown>, type: string): string | undefined {
  if (type === "timeline") {
    if (value.action !== "restore" && value.action !== "fork" && value.action !== "clear") {
      return "invalid timeline action";
    }
    if (value.action === "clear") {
      if (value.checkpointId !== undefined) return "clear does not accept a checkpointId";
    } else if (!identifier(value.checkpointId) || !/^[A-Za-z0-9:._-]+$/.test(value.checkpointId)) {
      return "invalid checkpointId";
    }
  }
  return undefined;
}

/** Validates package, extension, trust, and hook commands. */
function commandPackageError(value: Record<string, unknown>, type: string): string | undefined {
  if (type === "setPackageEnabled") {
    if (!identifier(value.packageId)) return "invalid packageId";
    if (typeof value.enabled !== "boolean") return "invalid package enabled state";
  }
  if (type === "updatePackageSettings") {
    if (!identifier(value.packageId)) return "invalid packageId";
    if (!validPackageSettings(value.settings)) return "invalid package settings";
  }
  if (type === "setExtensionEnabled") {
    if (!identifier(value.extensionId) || typeof value.enabled !== "boolean") return "invalid extension enabled state";
  }
  if (type === "installExtensionPackage" || type === "removeExtensionPackage") {
    if (value.scope !== "user" && value.scope !== "project") return "invalid extension package scope";
    if (value.scope === "project" ? !identifier(value.projectId) : value.projectId !== undefined)
      return "invalid extension package project";
    if (
      value.confirmed !== true ||
      typeof value.source !== "string" ||
      value.source.length > 500 ||
      !(extensionPackageName.test(value.source) || extensionGitSource.test(value.source))
    ) {
      return "invalid extension package source";
    }
  }
  if (type === "setProjectTrust" && (typeof value.trusted !== "boolean" || value.confirmed !== true)) {
    return "invalid project trust decision";
  }
  if (type === "reloadExtensions" && value.confirmed !== true) {
    return "extension reload requires confirmation";
  }
  if (type === "updateHookSettings" && !validHookSettings(value.settings)) {
    return "invalid hook settings";
  }
  if (
    type === "updateProjectWorktreeSettings" &&
    (typeof value.setupCommand !== "string" || value.setupCommand.length > 2_000)
  ) {
    return "invalid worktree setup command";
  }
  return undefined;
}

/** Validates runtime and tool policy updates. */
function commandPolicyError(value: Record<string, unknown>, type: string): string | undefined {
  if (type === "updateRuntimePolicy") {
    if (value.scope !== "global" && value.scope !== "project" && value.scope !== "session") {
      return "invalid runtime policy scope";
    }
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      return "invalid runtime policy revision";
    }
    if (
      !validVerifyPolicy(value.verify, value.scope === "global" || value.scope === "session") ||
      (value.scope === "global" && (!record(value.verify) || value.verify.mode !== "inherit"))
    ) {
      return "invalid Verify policy";
    }
    if (!policyToggles.has(String(value.timeline)) || (value.scope === "global" && value.timeline === "inherit")) {
      return "invalid Timeline policy";
    }
    if (
      !policyToggles.has(String(value.guard)) ||
      (value.scope === "global" && value.guard === "inherit") ||
      !validGuardRules(value.guardRules, value.scope === "global")
    ) {
      return "invalid Guard policy";
    }
    if (
      !inheritedWorkspaceModes.has(String(value.workspace)) ||
      (value.scope === "global" && value.workspace === "inherit")
    ) {
      return "invalid workspace policy";
    }
    if (
      !validDialogTimeout(value.guardTimeoutSeconds, value.scope !== "global") ||
      !validDialogTimeout(value.clarifyTimeoutSeconds, value.scope !== "global")
    ) {
      return "invalid dialog timeout policy";
    }
  }
  if (type === "updateToolPolicy") {
    if (value.scope !== "global" && value.scope !== "project" && value.scope !== "session") {
      return "invalid tool policy scope";
    }
    if (
      !boundedString(value.tool, 200) ||
      !["inherit", "active", "deferred", "disabled"].includes(String(value.mode))
    ) {
      return "invalid tool policy";
    }
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      return "invalid tool policy revision";
    }
  }
  return undefined;
}

/** Validates model, thinking level, and session control commands. */
function commandControlsError(value: Record<string, unknown>, type: string): string | undefined {
  if (type === "dismissCommandResult" && !identifier(value.resultId)) {
    return "invalid command result";
  }
  if (type === "handoffSession" && value.destination !== "checkout" && value.destination !== "worktree") {
    return "invalid handoff destination";
  }
  if (type === "applySessionChanges" && !boundedString(value.expectedRevision, 128)) {
    return "invalid workspace revision";
  }
  if (type === "setModel" && (!boundedString(value.provider) || !boundedString(value.modelId))) {
    return "invalid model";
  }
  if (type === "setThinkingLevel" && !thinkingLevels.has(String(value.level))) {
    return "invalid thinking level";
  }
  if (
    type === "setSessionControls" &&
    (!boundedString(value.provider) ||
      !boundedString(value.modelId) ||
      !thinkingLevels.has(String(value.thinkingLevel)))
  ) {
    return "invalid session controls";
  }
  if ((type === "startProviderLogin" || type === "logoutProvider") && !boundedString(value.provider, 200)) {
    return "invalid provider";
  }
  if (type === "startProviderLogin" && value.authType !== "api_key" && value.authType !== "oauth") {
    return "invalid provider authentication type";
  }
  return undefined;
}

/** Validates continuity memory commands. */
function commandMemoryError(value: Record<string, unknown>, type: string): string | undefined {
  if (type === "migrateContinuityMemory") {
    const allowed = new Set(["type", "commandId", "expectedGeneration"]);
    if (Object.keys(value).some(key => !allowed.has(key))) {
      return "invalid memory migration";
    }
  }
  if (type === "updateContinuityMemory" || type === "deleteContinuityMemory") {
    const allowed =
      type === "updateContinuityMemory"
        ? new Set(["type", "commandId", "expectedGeneration", "scope", "id", "trigger", "guidance", "expectedRevision"])
        : new Set(["type", "commandId", "expectedGeneration", "scope", "id", "expectedRevision"]);
    if (
      Object.keys(value).some(key => !allowed.has(key)) ||
      !memoryScopes.has(String(value.scope)) ||
      typeof value.id !== "string" ||
      value.id.length > MAX_ID_LENGTH ||
      !memoryNoteId.test(value.id) ||
      !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 1
    ) {
      return "invalid memory target";
    }
  }
  if (type === "updateContinuityMemory") {
    const trigger = value.trigger;
    const guidance = value.guidance;
    if (
      typeof trigger !== "string" ||
      trigger.length < 1 ||
      trigger.length > 240 ||
      trigger !== trigger.trim() ||
      typeof guidance !== "string" ||
      guidance.length < 1 ||
      guidance.length > 800 ||
      guidance !== guidance.trim() ||
      trigger.length + guidance.length > 1_000
    ) {
      return "invalid memory update";
    }
  }
  return undefined;
}

/** Each validator inspects only the commands its domain owns and passes the rest through. */
const commandValidators = [
  commandPromptError,
  commandTargetError,
  commandTimelineError,
  commandPackageError,
  commandPolicyError,
  commandControlsError,
  commandMemoryError,
];

export function validateCommand(value: unknown): ValidationResult<WebCommand> {
  if (!record(value)) return { ok: false, error: "command must be an object" };
  if (typeof value.type !== "string" || !commandNames.has(value.type)) {
    return { ok: false, error: "unknown command type" };
  }
  if (!identifier(value.commandId)) return { ok: false, error: "invalid commandId" };
  if (!generation(value.expectedGeneration)) return { ok: false, error: "invalid expectedGeneration" };

  for (const validate of commandValidators) {
    const error = validate(value, value.type);
    if (error) return { ok: false, error };
  }
  return { ok: true, value: value as unknown as WebCommand };
}

export function isHookSettingsSnapshot(value: unknown): value is HookSettingsSnapshot {
  return (
    record(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    generation(value.sessionGeneration) &&
    validHookSettings(value.settings)
  );
}

export function isPackageListSnapshot(value: unknown): value is PackageListSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !Array.isArray(value.packages) ||
    value.packages.length > 100
  )
    return false;
  return value.packages.every(
    item =>
      record(item) &&
      identifier(item.id) &&
      typeof item.name === "string" &&
      item.name.length > 0 &&
      item.name.length <= 200 &&
      typeof item.description === "string" &&
      item.description.length <= 500 &&
      (item.required === undefined || typeof item.required === "boolean") &&
      typeof item.enabled === "boolean" &&
      typeof item.active === "boolean" &&
      Number.isSafeInteger(item.extensionCount) &&
      (item.extensionCount as number) > 0 &&
      (item.extensionCount as number) <= 50 &&
      (item.settings === undefined || validPackageSettings(item.settings)) &&
      (item.error === undefined || (typeof item.error === "string" && item.error.length <= 500)),
  );
}

export function isExtensionListSnapshot(value: unknown): value is ExtensionListSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    typeof value.projectTrustRequired !== "boolean" ||
    typeof value.projectTrusted !== "boolean" ||
    !Array.isArray(value.packages) ||
    value.packages.length > 200 ||
    !Array.isArray(value.extensions) ||
    value.extensions.length > 500
  )
    return false;
  if (
    !value.packages.every(
      item => record(item) && boundedString(item.source, 500) && (item.scope === "user" || item.scope === "project"),
    )
  )
    return false;
  return value.extensions.every(
    item =>
      record(item) &&
      identifier(item.id) &&
      (item.scope === "user" || item.scope === "project") &&
      validWorkspacePath(item.path) &&
      boundedString(item.source, 500) &&
      (item.origin === "package" || item.origin === "top-level") &&
      typeof item.enabled === "boolean" &&
      typeof item.active === "boolean" &&
      (item.loadError === undefined || (typeof item.loadError === "string" && item.loadError.length <= 500)),
  );
}

export function isWebEvent(value: unknown): value is WebEvent {
  if (!record(value)) return false;
  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    Number.isSafeInteger(value.payloadVersion) &&
    (value.payloadVersion as number) > 0 &&
    identifier(value.eventId) &&
    identifier(value.sessionId) &&
    generation(value.sessionGeneration) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    typeof value.occurredAt === "string" &&
    !Number.isNaN(Date.parse(value.occurredAt)) &&
    typeof value.type === "string" &&
    value.type.length > 0
  );
}

export function isSessionListSnapshot(value: unknown): value is SessionListSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !Array.isArray(value.activeSessions) ||
    value.activeSessions.length > 100 ||
    !value.activeSessions.every(session => validSessionSummary(session)) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 100
  )
    return false;
  return value.projects.every(
    project =>
      record(project) &&
      identifier(project.id) &&
      typeof project.label === "string" &&
      project.label.length > 0 &&
      project.label.length <= 500 &&
      boundedString(project.cwd, 32 * 1024) &&
      Number.isSafeInteger(project.totalCount) &&
      (project.totalCount as number) >= 0 &&
      (project.nextCursor === undefined || identifier(project.nextCursor)) &&
      Array.isArray(project.sessions) &&
      project.sessions.length <= 100 &&
      project.sessions.every(session => validSessionSummary(session, project.id as string)),
  );
}

export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    typeof value.generatedAt !== "string" ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    typeof value.fromInclusive !== "string" ||
    Number.isNaN(Date.parse(value.fromInclusive)) ||
    typeof value.toExclusive !== "string" ||
    Number.isNaN(Date.parse(value.toExclusive)) ||
    !Array.isArray(value.records) ||
    value.records.length > 50_000 ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 10_000 ||
    !record(value.diagnostics)
  )
    return false;
  if (Date.parse(value.fromInclusive) >= Date.parse(value.toExclusive)) return false;
  const metric = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0;
  if (
    !value.records.every(
      item =>
        record(item) &&
        typeof item.day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.day) &&
        identifier(item.sessionId) &&
        identifier(item.projectId) &&
        boundedString(item.projectLabel, 256) &&
        boundedString(item.provider, 256) &&
        boundedString(item.model, 256) &&
        usageAgents.has(String(item.agent)) &&
        Number.isSafeInteger(item.calls) &&
        (item.calls as number) > 0 &&
        metric(item.input) &&
        metric(item.output) &&
        metric(item.cacheRead) &&
        metric(item.cacheWrite) &&
        metric(item.cost) &&
        typeof item.costKnown === "boolean",
    )
  )
    return false;
  if (
    !value.sessions.every(
      item =>
        record(item) &&
        identifier(item.id) &&
        identifier(item.projectId) &&
        boundedString(item.projectLabel, 256) &&
        boundedString(item.title, 500) &&
        typeof item.createdAt === "string" &&
        !Number.isNaN(Date.parse(item.createdAt)) &&
        typeof item.modifiedAt === "string" &&
        !Number.isNaN(Date.parse(item.modifiedAt)) &&
        Number.isSafeInteger(item.elapsedMs) &&
        (item.elapsedMs as number) >= 0,
    )
  )
    return false;
  const diagnostics = value.diagnostics;
  return (
    Number.isSafeInteger(diagnostics.unreadableFiles) &&
    (diagnostics.unreadableFiles as number) >= 0 &&
    Number.isSafeInteger(diagnostics.conflictingDuplicates) &&
    (diagnostics.conflictingDuplicates as number) >= 0 &&
    Number.isSafeInteger(diagnostics.unknownCostRecords) &&
    (diagnostics.unknownCostRecords as number) >= 0 &&
    Number.isSafeInteger(diagnostics.unknownAttributionRecords) &&
    (diagnostics.unknownAttributionRecords as number) >= 0 &&
    typeof diagnostics.truncated === "boolean"
  );
}

function validWorkspacePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== "..")
  );
}

export function isWorkspaceFilePage(value: unknown): value is WorkspaceFilePage {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !boundedString(value.revision, 128) ||
    !Array.isArray(value.files) ||
    value.files.length > 200 ||
    !Number.isSafeInteger(value.totalCount) ||
    (value.totalCount as number) < 0 ||
    (value.totalCount as number) > 10_000 ||
    typeof value.truncated !== "boolean" ||
    (value.nextCursor !== undefined && !identifier(value.nextCursor))
  )
    return false;
  return value.files.every(
    file =>
      record(file) &&
      validWorkspacePath(file.path) &&
      (file.status === undefined || ["added", "modified", "deleted"].includes(String(file.status))) &&
      (file.binary === undefined || typeof file.binary === "boolean") &&
      (file.additions === undefined || (Number.isSafeInteger(file.additions) && (file.additions as number) >= 0)) &&
      (file.deletions === undefined || (Number.isSafeInteger(file.deletions) && (file.deletions as number) >= 0)) &&
      (file.kind === undefined || file.kind === "submodule"),
  );
}

export function isWorkspaceFileContent(value: unknown): value is WorkspaceFileContent {
  return (
    record(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    generation(value.sessionGeneration) &&
    boundedString(value.revision, 128) &&
    validWorkspacePath(value.path) &&
    ["available", "deleted", "binary", "oversized"].includes(String(value.state)) &&
    (value.text === undefined || (typeof value.text === "string" && value.text.length <= 2 * 1024 * 1024)) &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}

function validJsonCell(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 64 * 1024;
  if (depth >= 6) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => validJsonCell(item, depth + 1));
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    return false;
  const entries = Object.entries(value);
  return entries.length <= 100 && entries.every(([key, item]) => key.length <= 500 && validJsonCell(item, depth + 1));
}

export function isPapercutListPage(value: unknown): value is PapercutListPage {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !["open", "resolved", "dismissed", "all"].includes(String(value.status)) ||
    typeof value.query !== "string" ||
    value.query.length > 200 ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    (value.offset as number) > 1_000 ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 50 ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0 ||
    (value.total as number) > 1_000 ||
    !Array.isArray(value.records) ||
    value.records.length > (value.limit as number) ||
    value.records.length > Math.max(0, (value.total as number) - (value.offset as number))
  )
    return false;
  const validTimestamp = (item: unknown) =>
    typeof item === "string" && item.length <= 64 && !Number.isNaN(Date.parse(item));
  if (
    !value.records.every(
      item =>
        record(item) &&
        typeof item.id === "string" &&
        memoryNoteId.test(item.id) &&
        typeof item.message === "string" &&
        item.message.length >= 1 &&
        item.message.length <= 500 &&
        ["open", "resolved", "dismissed"].includes(String(item.status)) &&
        Number.isSafeInteger(item.occurrences) &&
        (item.occurrences as number) >= 1 &&
        validTimestamp(item.createdAt) &&
        validTimestamp(item.updatedAt) &&
        validTimestamp(item.lastSeenAt) &&
        (item.resolution === undefined || (typeof item.resolution === "string" && item.resolution.length <= 500)) &&
        (item.resolvedAt === undefined || validTimestamp(item.resolvedAt)) &&
        (item.dismissal === undefined || (typeof item.dismissal === "string" && item.dismissal.length <= 500)) &&
        (item.dismissedAt === undefined || validTimestamp(item.dismissedAt)),
    )
  )
    return false;
  const nextOffset =
    (value.offset as number) + value.records.length < (value.total as number)
      ? (value.offset as number) + value.records.length
      : null;
  return value.nextOffset === nextOffset;
}

export function isStateQLCommandInput(value: unknown): value is StateQLCommandInput {
  return parseStateQLPanelCommand(value) !== undefined;
}


export function isStateQLRowsPage(value: unknown): value is StateQLRowsPage {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !identifier(value.actor_id) ||
    !boundedString(value.handle, 200) ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    (value.offset as number) > 10_000 ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100 ||
    !Array.isArray(value.rows) ||
    value.rows.length > (value.limit as number) ||
    !Number.isSafeInteger(value.returned) ||
    value.returned !== value.rows.length ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0 ||
    (value.total as number) > 10_000 ||
    (value.returned as number) > Math.max(0, (value.total as number) - (value.offset as number)) ||
    typeof value.truncated !== "boolean"
  )
    return false;
  if (
    !value.rows.every(
      row =>
        record(row) &&
        (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null) &&
        validJsonCell(row),
    )
  )
    return false;
  const truncated = (value.offset as number) + (value.returned as number) < (value.total as number);
  return (
    value.truncated === truncated &&
    (truncated
      ? (value.returned as number) > 0 &&
        Number.isSafeInteger(value.next_offset) &&
        value.next_offset === (value.offset as number) + (value.returned as number)
      : value.next_offset === null)
  );
}

export function isStateQLSnapshot(value: unknown): value is StateQLSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !record(value.session) ||
    !identifier(value.session.session_id) ||
    !identifier(value.session.name) ||
    !["active", "closed"].includes(String(value.session.status)) ||
    !identifier(value.actor_id) ||
    !Array.isArray(value.recent_results) ||
    value.recent_results.length > 10 ||
    !Array.isArray(value.recent_operations) ||
    value.recent_operations.length > 10 ||
    !Array.isArray(value.history) ||
    value.history.length > 100
  )
    return false;
  const connection = value.connection;
  if (
    connection !== null &&
    (!record(connection) ||
      !identifier(connection.connection_id) ||
      !boundedString(connection.name, 500) ||
      connection.status !== "connected" ||
      !["sqlite", "postgres", "mysql", "mongodb"].includes(String(connection.driver)) ||
      !boundedString(connection.database, 500) ||
      typeof connection.read_only !== "boolean")
  )
    return false;
  const transaction = value.transaction;
  if (
    transaction !== null &&
    (!record(transaction) ||
      !identifier(transaction.transaction_id) ||
      !identifier(transaction.owner_actor_id) ||
      !boundedString(transaction.state, 100))
  )
    return false;
  if (value.session.status === "closed" && (connection !== null || transaction !== null)) return false;
  if (value.state_version !== null && !boundedString(value.state_version, 128)) return false;
  if (
    value.state_confidence !== null &&
    !["authoritative", "transaction_snapshot", "database_reported", "local", "ttl_based", "unknown"].includes(
      String(value.state_confidence),
    )
  )
    return false;
  if (
    !value.recent_results.every(
      item =>
        record(item) &&
        (item.alias === null || boundedString(item.alias, 200)) &&
        identifier(item.handle) &&
        Number.isSafeInteger(item.rows) &&
        (item.rows as number) >= 0 &&
        (item.rows as number) <= 10_000,
    )
  )
    return false;
  if (
    !value.recent_operations.every(
      item =>
        record(item) &&
        identifier(item.handle) &&
        identifier(item.actor_id) &&
        boundedString(item.type, 100) &&
        boundedString(item.status, 100) &&
        (item.affected_rows === null ||
          (Number.isSafeInteger(item.affected_rows) && (item.affected_rows as number) >= 0)),
    )
  )
    return false;
  return value.history.every(
    item =>
      record(item) &&
      identifier(item.command_id) &&
      typeof item.timestamp === "string" &&
      item.timestamp.length <= 64 &&
      !Number.isNaN(Date.parse(item.timestamp)) &&
      identifier(item.session_id) &&
      identifier(item.actor_id) &&
      ["legacy", "user", "model", "system", "api"].includes(String(item.origin)) &&
      boundedString(item.command, 100) &&
      (item.sql === null || (typeof item.sql === "string" && new TextEncoder().encode(item.sql).byteLength <= 4_096)) &&
      (item.handle === null || identifier(item.handle)) &&
      typeof item.executed === "boolean" &&
      typeof item.cached === "boolean" &&
      typeof item.success === "boolean" &&
      (item.error_code === null || boundedString(item.error_code, 100)),
  );
}

export function isArchiveListSnapshot(value: unknown): value is ArchiveListSnapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !generation(value.sessionGeneration) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 100 ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 100 ||
    !Number.isSafeInteger(value.totalSessionCount) ||
    (value.totalSessionCount as number) < 0 ||
    (value.nextCursor !== undefined && !identifier(value.nextCursor))
  )
    return false;
  if (
    !value.projects.every(
      project =>
        record(project) &&
        identifier(project.id) &&
        boundedString(project.label, 500) &&
        Number.isSafeInteger(project.sessionCount) &&
        (project.sessionCount as number) >= 0 &&
        typeof project.archivedAt === "string" &&
        !Number.isNaN(Date.parse(project.archivedAt)),
    )
  )
    return false;
  return value.sessions.every(
    session =>
      validSessionSummary(session) &&
      typeof session.archivedAt === "string" &&
      !Number.isNaN(Date.parse(session.archivedAt)),
  );
}

function validSessionSummary(value: unknown, projectId?: string): boolean {
  return (
    record(value) &&
    identifier(value.id) &&
    identifier(value.projectId) &&
    (projectId === undefined || value.projectId === projectId) &&
    (value.name === undefined || (typeof value.name === "string" && value.name.length <= 200)) &&
    (value.parentSession === undefined ||
      (record(value.parentSession) &&
        identifier(value.parentSession.id) &&
        boundedString(value.parentSession.title, 200))) &&
    (value.runningUnderParentSessionId === undefined || identifier(value.runningUnderParentSessionId)) &&
    typeof value.cwdLabel === "string" &&
    value.cwdLabel.length <= 500 &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.modifiedAt === "string" &&
    !Number.isNaN(Date.parse(value.modifiedAt)) &&
    (value.workStartedAt === undefined ||
      (typeof value.workStartedAt === "string" && !Number.isNaN(Date.parse(value.workStartedAt)))) &&
    Number.isSafeInteger(value.userMessageCount) &&
    (value.userMessageCount as number) >= 0 &&
    typeof value.preview === "string" &&
    value.preview.length <= 500 &&
    typeof value.active === "boolean" &&
    typeof value.pinned === "boolean" &&
    runtimeStates.has(String(value.runtimeState))
  );
}

function validDelegatedRun(value: unknown): boolean {
  if (
    !record(value) ||
    !identifier(value.id) ||
    !delegatedAgentKinds.has(String(value.kind)) ||
    !Number.isSafeInteger(value.turn) ||
    (value.turn as number) < 0 ||
    !delegatedRunStatuses.has(String(value.status)) ||
    !Array.isArray(value.activity)
  )
    return false;
  if (value.request !== undefined && (typeof value.request !== "string" || value.request.length > 8 * 1024))
    return false;
  if (
    value.response !== undefined &&
    (typeof value.response !== "string" || value.response.length > MAX_MESSAGE_LENGTH)
  )
    return false;
  if (value.agentName !== undefined && !boundedString(value.agentName, 24)) return false;
  if (
    value.startedAt !== undefined &&
    (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt)))
  )
    return false;
  if (value.modelName !== undefined && (typeof value.modelName !== "string" || value.modelName.length > 200))
    return false;
  if (value.thinkingLevel !== undefined && !thinkingLevels.has(String(value.thinkingLevel))) return false;
  const spawned = value.kind === "spawn_agent" || value.kind === "spawn_session";
  if (spawned !== spawnExecutionActions.has(String(value.action))) return false;
  if (value.action === "adopt" && value.kind !== "spawn_session") return false;
  if (value.threadId !== undefined && (!spawned || !identifier(value.threadId))) return false;
  if (value.runId !== undefined && (!spawned || !identifier(value.runId))) return false;
  if (
    value.durationMs !== undefined &&
    (!Number.isSafeInteger(value.durationMs) ||
      (value.durationMs as number) < 0 ||
      (value.durationMs as number) > 7 * 24 * 60 * 60 * 1_000)
  )
    return false;
  if (
    value.contextTokens !== undefined &&
    value.contextTokens !== null &&
    (!Number.isSafeInteger(value.contextTokens) || (value.contextTokens as number) < 0)
  )
    return false;
  if (
    value.contextLimit !== undefined &&
    (!Number.isSafeInteger(value.contextLimit) || (value.contextLimit as number) <= 0)
  )
    return false;
  if (
    value.costLimitUsd !== undefined &&
    (typeof value.costLimitUsd !== "number" || !Number.isFinite(value.costLimitUsd) || value.costLimitUsd <= 0)
  )
    return false;
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (
      !record(usage) ||
      !["input", "output", "cacheRead", "cacheWrite", "cost"].every(
        key => typeof usage[key] === "number" && Number.isFinite(usage[key] as number) && (usage[key] as number) >= 0,
      )
    )
      return false;
  }
  return value.activity.every(
    item =>
      record(item) &&
      (item.id === undefined || identifier(item.id)) &&
      ["call", "result"].includes(String(item.kind)) &&
      boundedString(item.tool, 200) &&
      (item.text === undefined || (typeof item.text === "string" && item.text.length <= 2_000)) &&
      (item.isError === undefined || typeof item.isError === "boolean") &&
      validOptionalToolTiming(item),
  );
}

function validCompactionDisplay(value: unknown): boolean {
  const exact = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).every(key => keys.includes(key));
  if (
    !record(value) ||
    !exact(value, ["records", "failedTools", "toolResults", "history"]) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.failedTools) ||
    !Array.isArray(value.toolResults) ||
    value.records.length + value.failedTools.length + value.toolResults.length > MAX_COMPACTION_DISPLAY_RECORDS ||
    !record(value.history) ||
    !exact(value.history, ["read", "modified"]) ||
    !Array.isArray(value.history.read) ||
    !Array.isArray(value.history.modified) ||
    value.history.read.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS ||
    value.history.modified.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS
  )
    return false;
  const source = (item: unknown) =>
    record(item) &&
    exact(item, ["sourceEntryId", "text"]) &&
    boundedString(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID) &&
    boundedString(item.text, MAX_COMPACTION_DISPLAY_TEXT);
  const historyRecord = (item: unknown) =>
    record(item) &&
    exact(item, ["path", "sourceEntryId"]) &&
    boundedString(item.path, MAX_COMPACTION_DISPLAY_PATH) &&
    (item.sourceEntryId === undefined ||
      (typeof item.sourceEntryId === "string" && item.sourceEntryId.length <= MAX_COMPACTION_DISPLAY_SOURCE_ID));
  return (
    value.records.every(
      item =>
        record(item) &&
        exact(item, ["sourceEntryId", "role", "text"]) &&
        boundedString(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID) &&
        boundedString(item.text, MAX_COMPACTION_DISPLAY_TEXT) &&
        (item.role === "user" || item.role === "assistant"),
    ) &&
    value.failedTools.every(source) &&
    value.toolResults.every(source) &&
    value.history.read.every(historyRecord) &&
    value.history.modified.every(historyRecord)
  );
}

function validCompactionMessage(value: unknown): boolean {
  const optionalCount = (count: unknown) =>
    count === undefined || (Number.isSafeInteger(count) && (count as number) >= 0);
  return (
    record(value) &&
    Number.isSafeInteger(value.contextAfterTokens) &&
    (value.contextAfterTokens as number) >= 0 &&
    optionalCount(value.contextBeforeTokens) &&
    optionalCount(value.sourceEntryCount) &&
    (value.display === undefined || validCompactionDisplay(value.display))
  );
}

function validHistoryMessage(message: unknown): boolean {
  return (
    record(message) &&
    identifier(message.id) &&
    (message.entryId === undefined || identifier(message.entryId)) &&
    ["user", "assistant", "system", "tool"].includes(String(message.role)) &&
    typeof message.text === "string" &&
    message.text.length <= MAX_MESSAGE_LENGTH &&
    message.streaming === false &&
    (message.turn === undefined || (Number.isSafeInteger(message.turn) && (message.turn as number) > 0)) &&
    (message.attachmentCount === undefined ||
      (Number.isSafeInteger(message.attachmentCount) &&
        (message.attachmentCount as number) >= 0 &&
        (message.attachmentCount as number) <= MAX_IMAGES)) &&
    (message.fileAttachmentCount === undefined ||
      (Number.isSafeInteger(message.fileAttachmentCount) &&
        (message.fileAttachmentCount as number) >= 0 &&
        (message.fileAttachmentCount as number) <= MAX_TEXT_FILES)) &&
    validMessageAttachments(message.attachments) &&
    (message.systemSource === undefined ||
      (typeof message.systemSource === "string" && message.systemSource.length <= 200)) &&
    (message.compaction === undefined || validCompactionMessage(message.compaction)) &&
    (message.tool === undefined ||
      (record(message.tool) &&
        identifier(message.tool.id) &&
        boundedString(message.tool.name) &&
        (message.tool.input === undefined ||
          (typeof message.tool.input === "string" && message.tool.input.length <= MAX_MESSAGE_LENGTH)) &&
        toolStatuses.has(String(message.tool.status)) &&
        validOptionalToolTiming(message.tool)))
  );
}

export function isConversationHistoryPage(value: unknown): value is ConversationHistoryPage {
  return (
    record(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    identifier(value.sessionId) &&
    generation(value.sessionGeneration) &&
    Array.isArray(value.messages) &&
    value.messages.length <= 100 &&
    value.messages.every(validHistoryMessage) &&
    Number.isSafeInteger(value.remaining) &&
    (value.remaining as number) >= 0 &&
    (value.nextCursor === undefined || identifier(value.nextCursor)) &&
    (value.earlierCursor === undefined || identifier(value.earlierCursor)) &&
    (value.laterCursor === undefined || identifier(value.laterCursor)) &&
    (value.atStart === undefined || typeof value.atStart === "boolean") &&
    (value.atEnd === undefined || typeof value.atEnd === "boolean")
  );
}

export function isConversationTurnIndexPage(value: unknown): value is ConversationTurnIndexPage {
  return (
    record(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    identifier(value.sessionId) &&
    generation(value.sessionGeneration) &&
    Number.isSafeInteger(value.totalCount) &&
    (value.totalCount as number) >= 0 &&
    (value.earlierCursor === undefined || identifier(value.earlierCursor)) &&
    (value.laterCursor === undefined || identifier(value.laterCursor)) &&
    Array.isArray(value.turns) &&
    value.turns.length <= 250 &&
    value.turns.every(
      turn =>
        record(turn) &&
        identifier(turn.promptId) &&
        boundedString(turn.preview, 120) &&
        identifier(turn.cursor) &&
        (turn.createdAt === undefined ||
          (typeof turn.createdAt === "string" && !Number.isNaN(Date.parse(turn.createdAt)))),
    )
  );
}

export function isFileSuggestionList(value: unknown): value is FileSuggestionList {
  return (
    record(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    generation(value.sessionGeneration) &&
    typeof value.available === "boolean" &&
    Array.isArray(value.paths) &&
    value.paths.length <= 20 &&
    value.paths.every(
      path =>
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 500 &&
        !path.startsWith("/") &&
        !/^[A-Za-z]:/.test(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        !path.split("/").some(part => part === "" || part === "." || part === ".."),
    )
  );
}

function validWorkspaceSnapshot(workspace: unknown): boolean {
  if (
    !record(workspace) ||
    typeof workspace.gitAvailable !== "boolean" ||
    !sessionWorkspaceModes.has(String(workspace.mode)) ||
    !Number.isSafeInteger(workspace.changedCount) ||
    (workspace.changedCount as number) < 0 ||
    typeof workspace.canMoveToCheckout !== "boolean" ||
    typeof workspace.canMoveToWorktree !== "boolean" ||
    typeof workspace.canApplyChanges !== "boolean" ||
    (workspace.revision !== undefined && !boundedString(workspace.revision, 128)) ||
    (workspace.setupState !== undefined && !["idle", "running", "failed"].includes(String(workspace.setupState))) ||
    (workspace.setupError !== undefined && !boundedString(workspace.setupError, 500)) ||
    (workspace.checkoutOwner !== undefined && !identifier(workspace.checkoutOwner)) ||
    (workspace.handoffUnavailableReason !== undefined && !boundedString(workspace.handoffUnavailableReason, 500)) ||
    (workspace.applyTargetBranch !== undefined && !boundedString(workspace.applyTargetBranch, 200)) ||
    (workspace.applyTargetChangedCount !== undefined &&
      (!Number.isSafeInteger(workspace.applyTargetChangedCount) ||
        (workspace.applyTargetChangedCount as number) < 0)) ||
    (workspace.applyUnavailableReason !== undefined && !boundedString(workspace.applyUnavailableReason, 500)) ||
    (workspace.applyState !== undefined && !["pending", "applying"].includes(String(workspace.applyState))) ||
    (workspace.lastApply !== undefined &&
      (!record(workspace.lastApply) ||
        !["applied", "unchanged", "conflict", "error"].includes(String(workspace.lastApply.state)) ||
        (workspace.lastApply.targetBranch !== undefined && !boundedString(workspace.lastApply.targetBranch, 200)) ||
        (workspace.lastApply.message !== undefined && !boundedString(workspace.lastApply.message, 500)) ||
        (workspace.lastApply.conflicts !== undefined &&
          (!Array.isArray(workspace.lastApply.conflicts) ||
            workspace.lastApply.conflicts.length > 100 ||
            !workspace.lastApply.conflicts.every(path => boundedString(path, 500))))))
  )
    return false;
  return true;
}

function validRuntimePolicySnapshot(policy: unknown): boolean {
  if (
    !record(policy) ||
    !Number.isSafeInteger(policy.revision) ||
    (policy.revision as number) < 0 ||
    !record(policy.global) ||
    typeof policy.global.timelineEnabled !== "boolean" ||
    typeof policy.global.guardEnabled !== "boolean" ||
    !workspaceModes.has(String(policy.global.workspace)) ||
    !validDialogTimeout(policy.global.guardTimeoutSeconds) ||
    !validDialogTimeout(policy.global.clarifyTimeoutSeconds) ||
    (policy.global.toolOverrides !== undefined && !validToolOverrides(policy.global.toolOverrides)) ||
    !record(policy.project) ||
    !validVerifyPolicy(policy.project.verify) ||
    (policy.project.toolOverrides !== undefined && !validToolOverrides(policy.project.toolOverrides)) ||
    (policy.project.timelineEnabled !== undefined && typeof policy.project.timelineEnabled !== "boolean") ||
    (policy.project.guardEnabled !== undefined && typeof policy.project.guardEnabled !== "boolean") ||
    (policy.project.workspace !== undefined && !workspaceModes.has(String(policy.project.workspace))) ||
    (policy.project.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.guardTimeoutSeconds)) ||
    (policy.project.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.clarifyTimeoutSeconds)) ||
    !record(policy.session) ||
    (policy.session.toolOverrides !== undefined && !validToolOverrides(policy.session.toolOverrides)) ||
    (policy.session.verify !== undefined && !validVerifyPolicy(policy.session.verify)) ||
    (policy.session.timelineEnabled !== undefined && typeof policy.session.timelineEnabled !== "boolean") ||
    (policy.session.guardEnabled !== undefined && typeof policy.session.guardEnabled !== "boolean") ||
    (policy.session.workspace !== undefined && !workspaceModes.has(String(policy.session.workspace))) ||
    (policy.session.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.guardTimeoutSeconds)) ||
    (policy.session.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.clarifyTimeoutSeconds)) ||
    !record(policy.effective) ||
    !validVerifyPolicy(policy.effective.verify) ||
    typeof policy.effective.timelineEnabled !== "boolean" ||
    typeof policy.effective.guardEnabled !== "boolean" ||
    (policy.effective.toolOverrides !== undefined && !validToolOverrides(policy.effective.toolOverrides)) ||
    !workspaceModes.has(String(policy.effective.workspace)) ||
    !validDialogTimeout(policy.effective.guardTimeoutSeconds) ||
    !validDialogTimeout(policy.effective.clarifyTimeoutSeconds) ||
    !Array.isArray(policy.availableVerifyChecks) ||
    policy.availableVerifyChecks.length > 100 ||
    !policy.availableVerifyChecks.every(
      check =>
        record(check) &&
        boundedString(check.id, 100) &&
        boundedString(check.label, 200) &&
        boundedString(check.command, 500),
    )
  )
    return false;
  return true;
}

function validProviderAuth(auth: unknown): boolean {
  if (
    !record(auth) ||
    !Array.isArray(auth.providers) ||
    auth.providers.length > 200 ||
    !auth.providers.every(
      provider =>
        record(provider) &&
        boundedString(provider.id, 200) &&
        boundedString(provider.name, 200) &&
        typeof provider.configured === "boolean" &&
        typeof provider.stored === "boolean" &&
        (provider.credentialType === undefined ||
          provider.credentialType === "api_key" ||
          provider.credentialType === "oauth") &&
        Array.isArray(provider.methods) &&
        provider.methods.length <= 2 &&
        provider.methods.every(
          method =>
            record(method) &&
            (method.type === "api_key" || method.type === "oauth") &&
            boundedString(method.name, 200) &&
            typeof method.interactive === "boolean",
        ),
    )
  )
    return false;
  if (auth.flow !== undefined) {
    const flow = auth.flow;
    if (
      !record(flow) ||
      !identifier(flow.id) ||
      !boundedString(flow.providerId, 200) ||
      !boundedString(flow.providerName, 200) ||
      !["api_key", "oauth"].includes(String(flow.authType)) ||
      !["running", "succeeded", "failed", "cancelled"].includes(String(flow.status)) ||
      (flow.message !== undefined && !boundedString(flow.message, 2_000)) ||
      (flow.authUrl !== undefined && !boundedString(flow.authUrl, 8_000)) ||
      (flow.instructions !== undefined && !boundedString(flow.instructions, 2_000))
    )
      return false;
  }
  return true;
}

function validCommandResult(result: unknown): boolean {
  if (
    !record(result) ||
    !identifier(result.id) ||
    !boundedString(result.command, 120) ||
    typeof result.output !== "string" ||
    result.output.length > 8_000 ||
    !["info", "warning", "error"].includes(String(result.severity)) ||
    typeof result.occurredAt !== "string" ||
    Number.isNaN(Date.parse(result.occurredAt))
  )
    return false;
  return true;
}

function validConversationMessage(message: unknown): boolean {
  return (
    record(message) &&
    identifier(message.id) &&
    (message.entryId === undefined || identifier(message.entryId)) &&
    ["user", "assistant", "system", "tool"].includes(message.role as string) &&
    typeof message.text === "string" &&
    message.text.length <= MAX_MESSAGE_LENGTH &&
    typeof message.streaming === "boolean" &&
    (message.turn === undefined || (Number.isSafeInteger(message.turn) && (message.turn as number) > 0)) &&
    (message.createdAt === undefined ||
      (typeof message.createdAt === "string" && !Number.isNaN(Date.parse(message.createdAt)))) &&
    (message.canUndo === undefined || typeof message.canUndo === "boolean") &&
    (message.canForkWithTimeline === undefined || typeof message.canForkWithTimeline === "boolean") &&
    (message.attachmentCount === undefined ||
      (Number.isSafeInteger(message.attachmentCount) &&
        (message.attachmentCount as number) >= 0 &&
        (message.attachmentCount as number) <= MAX_IMAGES)) &&
    (message.fileAttachmentCount === undefined ||
      (Number.isSafeInteger(message.fileAttachmentCount) &&
        (message.fileAttachmentCount as number) >= 0 &&
        (message.fileAttachmentCount as number) <= MAX_TEXT_FILES)) &&
    validMessageAttachments(message.attachments) &&
    (message.workDurationMs === undefined ||
      (Number.isSafeInteger(message.workDurationMs) &&
        (message.workDurationMs as number) >= 0 &&
        (message.workDurationMs as number) <= 7 * 24 * 60 * 60 * 1_000)) &&
    (message.gitBranch === undefined ||
      (typeof message.gitBranch === "string" && message.gitBranch.length > 0 && message.gitBranch.length <= 200)) &&
    (message.modelName === undefined || (typeof message.modelName === "string" && message.modelName.length <= 200)) &&
    (message.thinkingLevel === undefined || thinkingLevels.has(String(message.thinkingLevel))) &&
    (message.changedFiles === undefined ||
      (Array.isArray(message.changedFiles) &&
        message.changedFiles.length <= 100 &&
        message.changedFiles.every(
          file =>
            record(file) &&
            typeof file.path === "string" &&
            file.path.length > 0 &&
            file.path.length <= 500 &&
            (file.binary === true ||
              (Number.isSafeInteger(file.additions) &&
                (file.additions as number) >= 0 &&
                Number.isSafeInteger(file.deletions) &&
                (file.deletions as number) >= 0)),
        ))) &&
    (message.systemSource === undefined ||
      (typeof message.systemSource === "string" && message.systemSource.length <= 200)) &&
    (message.compaction === undefined || validCompactionMessage(message.compaction)) &&
    (message.tool === undefined ||
      (record(message.tool) &&
        identifier(message.tool.id) &&
        boundedString(message.tool.name) &&
        (message.tool.input === undefined ||
          (typeof message.tool.input === "string" && message.tool.input.length <= MAX_MESSAGE_LENGTH)) &&
        toolStatuses.has(String(message.tool.status)) &&
        validOptionalToolTiming(message.tool)))
  );
}

function validConversationTool(tool: unknown): boolean {
  return (
    record(tool) &&
    identifier(tool.id) &&
    typeof tool.name === "string" &&
    (tool.input === undefined || (typeof tool.input === "string" && tool.input.length <= MAX_MESSAGE_LENGTH)) &&
    (tool.summary === undefined || (typeof tool.summary === "string" && tool.summary.length <= MAX_MESSAGE_LENGTH)) &&
    toolStatuses.has(tool.status as string) &&
    validOptionalToolTiming(tool)
  );
}

function validQueueItem(item: unknown): boolean {
  return (
    record(item) &&
    identifier(item.id) &&
    identifier(item.commandId) &&
    typeof item.preview === "string" &&
    item.preview.length <= 2_000 &&
    Number.isSafeInteger(item.attachmentCount) &&
    (item.attachmentCount as number) >= 0 &&
    (item.attachmentCount as number) <= MAX_IMAGES &&
    Number.isSafeInteger(item.fileAttachmentCount) &&
    (item.fileAttachmentCount as number) >= 0 &&
    (item.fileAttachmentCount as number) <= MAX_TEXT_FILES &&
    typeof item.planMode === "boolean" &&
    ["queued", "delivering"].includes(String(item.state))
  );
}

function validStoppedRun(stopped: unknown): boolean {
  return (
    record(stopped) &&
    identifier(stopped.turnId) &&
    (stopped.userEntryId === undefined || identifier(stopped.userEntryId)) &&
    Number.isSafeInteger(stopped.durationMs) &&
    (stopped.durationMs as number) >= 0 &&
    (stopped.durationMs as number) <= 7 * 24 * 60 * 60 * 1_000 &&
    (stopped.modelName === undefined || boundedString(stopped.modelName, 200)) &&
    (stopped.thinkingLevel === undefined || thinkingLevels.has(String(stopped.thinkingLevel)))
  );
}

function validConversation(conversation: unknown): boolean {
  if (
    !record(conversation) ||
    !Array.isArray(conversation.messages) ||
    !Array.isArray(conversation.tools) ||
    !Array.isArray(conversation.delegatedRuns) ||
    typeof conversation.streaming !== "boolean" ||
    !record(conversation.queue) ||
    !record(conversation.retry) ||
    !record(conversation.compaction)
  )
    return false;
  if (
    conversation.workStartedAt !== undefined &&
    (typeof conversation.workStartedAt !== "string" || Number.isNaN(Date.parse(conversation.workStartedAt)))
  )
    return false;
  if (
    conversation.workModelName !== undefined &&
    (typeof conversation.workModelName !== "string" || conversation.workModelName.length > 200)
  )
    return false;
  if (conversation.workThinkingLevel !== undefined && !thinkingLevels.has(String(conversation.workThinkingLevel)))
    return false;
  if (conversation.stopping !== undefined && typeof conversation.stopping !== "boolean") return false;
  if (conversation.agentError !== undefined && !boundedString(conversation.agentError, 1_000)) return false;
  if (conversation.stoppedRun !== undefined && !validStoppedRun(conversation.stoppedRun)) return false;
  if (conversation.historyCursor !== undefined && !identifier(conversation.historyCursor)) return false;
  if (
    conversation.historyRemaining !== undefined &&
    (!Number.isSafeInteger(conversation.historyRemaining) || (conversation.historyRemaining as number) < 0)
  )
    return false;
  // The cursor and its remaining count are only meaningful together.
  if ((conversation.historyCursor === undefined) !== (conversation.historyRemaining === undefined)) return false;
  if (conversation.tools.length > 100 || conversation.delegatedRuns.length > 100) return false;
  if (!conversation.messages.every(validConversationMessage)) return false;
  if (!conversation.tools.every(validConversationTool)) return false;
  if (!conversation.delegatedRuns.every(run => validDelegatedRun(run))) return false;
  if (
    !Number.isSafeInteger(conversation.queue.steering) ||
    !Number.isSafeInteger(conversation.queue.followUp) ||
    typeof conversation.retry.active !== "boolean" ||
    typeof conversation.compaction.active !== "boolean"
  )
    return false;
  if (
    conversation.queue.items !== undefined &&
    (!Array.isArray(conversation.queue.items) ||
      conversation.queue.items.length > 100 ||
      !conversation.queue.items.every(validQueueItem))
  )
    return false;
  return true;
}

function validSessionControls(controls: unknown): boolean {
  if (
    !record(controls) ||
    !Array.isArray(controls.models) ||
    controls.models.length > 500 ||
    !Array.isArray(controls.thinkingLevels) ||
    !controls.thinkingLevels.every(level => thinkingLevels.has(String(level))) ||
    (controls.thinkingLevel !== undefined && !thinkingLevels.has(String(controls.thinkingLevel)))
  )
    return false;
  if (
    controls.commands !== undefined &&
    (!Array.isArray(controls.commands) ||
      controls.commands.length > 200 ||
      !controls.commands.every(
        command =>
          record(command) &&
          boundedString(command.name, 120) &&
          (command.description === undefined ||
            (typeof command.description === "string" && command.description.length <= 300)) &&
          ["extension", "prompt", "skill"].includes(String(command.source)),
      ))
  )
    return false;
  const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const model = (value: unknown) =>
    record(value) &&
    boundedString(value.provider) &&
    boundedString(value.id) &&
    boundedString(value.name) &&
    (value.thinkingLevels === undefined ||
      (Array.isArray(value.thinkingLevels) &&
        value.thinkingLevels.length <= 7 &&
        value.thinkingLevels.every(level => thinkingLevels.has(String(level))))) &&
    (value.contextWindow === undefined ||
      (Number.isSafeInteger(value.contextWindow) && (value.contextWindow as number) >= 0)) &&
    (value.cost === undefined || (record(value.cost) && rate(value.cost.input) && rate(value.cost.output)));
  if (!controls.models.every(model) || (controls.model !== undefined && !model(controls.model))) return false;
  if (
    controls.pending !== undefined &&
    (!record(controls.pending) ||
      !model(controls.pending.model) ||
      !thinkingLevels.has(String(controls.pending.thinkingLevel)))
  )
    return false;
  return true;
}

function validRuntimeMetrics(metrics: unknown): boolean {
  if (
    !record(metrics) ||
    typeof metrics.model !== "string" ||
    typeof metrics.provider !== "string" ||
    ![
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "contextTokens",
      "contextLimit",
      "contextPercent",
      "cost",
      "userMessages",
      "assistantMessages",
      "toolCalls",
    ].every(key => typeof metrics[key] === "number" && Number.isFinite(metrics[key] as number)) ||
    (metrics.toolUsage !== undefined &&
      (!Array.isArray(metrics.toolUsage) ||
        metrics.toolUsage.length > 200 ||
        !metrics.toolUsage.every(
          item =>
            record(item) &&
            boundedString(item.name) &&
            item.name.length > 0 &&
            Number.isSafeInteger(item.calls) &&
            (item.calls as number) >= 0 &&
            Number.isSafeInteger(item.inputTokens) &&
            (item.inputTokens as number) >= 0 &&
            Number.isSafeInteger(item.outputTokens) &&
            (item.outputTokens as number) >= 0 &&
            Number.isSafeInteger(item.tokens) &&
            item.tokens === (item.inputTokens as number) + (item.outputTokens as number),
        )))
  )
    return false;
  return true;
}

function validDiscoverIndex(index: unknown): boolean {
  if (
    !record(index) ||
    !["idle", "indexing", "error"].includes(String(index.state)) ||
    (index.files !== undefined && (!Number.isSafeInteger(index.files) || (index.files as number) < 0)) ||
    (index.symbols !== undefined && (!Number.isSafeInteger(index.symbols) || (index.symbols as number) < 0)) ||
    (index.indexedAt !== undefined &&
      (typeof index.indexedAt !== "string" || Number.isNaN(Date.parse(index.indexedAt)))) ||
    (index.error !== undefined && (typeof index.error !== "string" || index.error.length > 500))
  )
    return false;
  return true;
}

const safeMemoryPath = (path: unknown) =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 240 &&
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[a-z]:/i.test(path) &&
  !path.split(/[\\/]+/).some(part => !part || part === "." || part === "..");
const validMemoryNote = (note: unknown, expectedScope: "user" | "project") =>
  record(note) &&
  typeof note.id === "string" &&
  note.id.length <= MAX_ID_LENGTH &&
  memoryNoteId.test(note.id) &&
  note.scope === expectedScope &&
  typeof note.trigger === "string" &&
  note.trigger.length >= 1 &&
  note.trigger.length <= 240 &&
  note.trigger === note.trigger.trim() &&
  typeof note.guidance === "string" &&
  note.guidance.length >= 1 &&
  note.guidance.length <= 800 &&
  note.guidance === note.guidance.trim() &&
  note.trigger.length + note.guidance.length <= 1_000 &&
  memoryAuthorities.has(String(note.authority)) &&
  memoryOrigins.has(String(note.origin)) &&
  (note.disposition === undefined || memoryDispositions.has(String(note.disposition))) &&
  (note.enforcementAuthority === undefined || memoryEnforcementAuthorities.has(String(note.enforcementAuthority))) &&
  (note.relatedPaths === undefined ||
    (Array.isArray(note.relatedPaths) && note.relatedPaths.length <= 5 && note.relatedPaths.every(safeMemoryPath))) &&
  Number.isSafeInteger(note.revision) &&
  (note.revision as number) >= 1 &&
  typeof note.updatedAt === "string" &&
  !Number.isNaN(Date.parse(note.updatedAt)) &&
  typeof note.sourceSummary === "string" &&
  note.sourceSummary.length <= 500;

/** Sieve stats blocks all share the same non-negative-integer shape. */
function validSieveStats(value: unknown): boolean {
  if (!record(value) || !record(value.transformedBy) || !record(value.byTool) || Object.keys(value.byTool).length > 33)
    return false;
  const transformedBy = value.transformedBy;
  const toolStats = Object.entries(value.byTool).every(
    ([name, usage]) =>
      record(usage) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(name) &&
      ["scanned", "transformed", "sourceChars", "retainedChars", "netCharsSaved"].every(
        key => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
      ),
  );
  return (
    toolStats &&
    ["scanned", "transformed", "omittedChars", "netCharsSaved"].every(
      key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
    ) &&
    ["ageThreshold", "budget", "activeThreshold", "staleRead", "duplicate", "errorCap", "mixedText"].every(
      key => Number.isSafeInteger(transformedBy[key]) && (transformedBy[key] as number) >= 0,
    )
  );
}

function validSieve(sieve: Record<string, unknown>): boolean {
  if (
    !sieveModes.has(String(sieve.mode)) ||
    !sieveProjectionModes.has(String(sieve.projectionMode)) ||
    !Number.isSafeInteger(sieve.threshold) ||
    (sieve.threshold as number) < 1_000 ||
    typeof sieve.activePruning !== "boolean" ||
    !sieveLatestModes.has(String(sieve.latestMode)) ||
    !validSieveStats(sieve.latest) ||
    !validSieveStats(sieve.cumulativeActual) ||
    !validSieveStats(sieve.cumulativeProjected) ||
    !Number.isSafeInteger(sieve.recalls) ||
    (sieve.recalls as number) < 0 ||
    !Number.isSafeInteger(sieve.recalledChars) ||
    (sieve.recalledChars as number) < 0 ||
    !record(sieve.recallsByTool) ||
    Object.keys(sieve.recallsByTool).length > 33 ||
    !Object.entries(sieve.recallsByTool).every(
      ([name, usage]) =>
        record(usage) &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(name) &&
        Number.isSafeInteger(usage.recalls) &&
        (usage.recalls as number) >= 0 &&
        Number.isSafeInteger(usage.recalledChars) &&
        (usage.recalledChars as number) >= 0,
    ) ||
    typeof sieve.updatedAt !== "string" ||
    Number.isNaN(Date.parse(sieve.updatedAt)) ||
    (sieve.error !== undefined && !boundedString(sieve.error, 500))
  )
    return false;
  const metrics = (value: Record<string, unknown> | undefined, keys: string[]) =>
    value !== undefined && keys.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
  const rawEpoch = sieve.epoch;
  const epoch = record(rawEpoch) ? rawEpoch : undefined;
  if (
    sieve.epoch !== undefined &&
    (!metrics(epoch, [
      "frozenResultCount",
      "frozenSourceChars",
      "frozenRetainedChars",
      "rolloverEligibleRetainedChars",
      "recoverableEntries",
    ]) ||
      !["id", "reason", "promptFingerprint"].every(
        key => epoch![key] === undefined || boundedString(epoch![key], 200),
      ) ||
      (epoch!.startedAt !== undefined &&
        (typeof epoch!.startedAt !== "string" || Number.isNaN(Date.parse(epoch!.startedAt)))))
  )
    return false;
  const rawStability = sieve.stability;
  const stability = record(rawStability) ? rawStability : undefined;
  const standardChangesByKind = record(stability?.standardChangesByKind) ? stability.standardChangesByKind : undefined;
  if (
    sieve.stability !== undefined &&
    (!metrics(stability, [
      "newProjections",
      "projectionCacheHits",
      "recoverableEntries",
      "explicitReflows",
      "softBudgetExceedances",
      "prefixChurnViolations",
      "estimatedInvalidatedChars",
    ]) ||
      (stability!.earliestChangedPriorMessageIndex !== undefined &&
        (!Number.isSafeInteger(stability!.earliestChangedPriorMessageIndex) ||
          (stability!.earliestChangedPriorMessageIndex as number) < 0)) ||
      (stability!.standardComparisons !== undefined &&
        (!Number.isSafeInteger(stability!.standardComparisons) || (stability!.standardComparisons as number) < 0)) ||
      (stability!.standardPrefixChurn !== undefined &&
        (!Number.isSafeInteger(stability!.standardPrefixChurn) || (stability!.standardPrefixChurn as number) < 0)) ||
      (stability!.standardEarliestChangedPriorMessageIndex !== undefined &&
        (!Number.isSafeInteger(stability!.standardEarliestChangedPriorMessageIndex) ||
          (stability!.standardEarliestChangedPriorMessageIndex as number) < 0)) ||
      (stability!.standardEstimatedInvalidatedChars !== undefined &&
        (!Number.isSafeInteger(stability!.standardEstimatedInvalidatedChars) ||
          (stability!.standardEstimatedInvalidatedChars as number) < 0)) ||
      (stability!.standardChangesByKind !== undefined &&
        (!standardChangesByKind ||
          !["activeThreshold", "ageThreshold", "budget", "staleRead", "duplicate", "errorCap", "history"].every(
            key => Number.isSafeInteger(standardChangesByKind[key]) && (standardChangesByKind[key] as number) >= 0,
          ))))
  )
    return false;
  if (
    sieve.contextUsagePercent !== undefined &&
    (typeof sieve.contextUsagePercent !== "number" ||
      !Number.isFinite(sieve.contextUsagePercent) ||
      sieve.contextUsagePercent < 0 ||
      sieve.contextUsagePercent > 100)
  )
    return false;
  return true;
}

function validContinuityMemory(continuity: Record<string, unknown>): boolean {
  if (
    !Array.isArray(continuity.memory) ||
    continuity.memory.length > 1_000 ||
    !continuity.memory.every(note => validMemoryNote(note, "project")) ||
    !Array.isArray(continuity.globalMemory) ||
    continuity.globalMemory.length > 1_000 ||
    !continuity.globalMemory.every(note => validMemoryNote(note, "user"))
  )
    return false;
  return true;
}

function validOperational(operational: unknown): boolean {
  if (
    !record(operational) ||
    !record(operational.verification) ||
    !record(operational.jobs) ||
    !record(operational.guard) ||
    !record(operational.continuity) ||
    !record(operational.papercuts) ||
    !record(operational.timeline) ||
    !record(operational.tools) ||
    !record(operational.sieve) ||
    !record(operational.health)
  )
    return false;
  const available = (feature: Record<string, unknown>) =>
    feature.availability === "available" || feature.availability === "unavailable";
  const papercutCounts = record(operational.papercuts.counts) ? operational.papercuts.counts : undefined;
  if (
    !available(operational.verification) ||
    !Array.isArray(operational.verification.checks) ||
    operational.verification.checks.length > 20 ||
    !available(operational.jobs) ||
    !Array.isArray(operational.jobs.items) ||
    operational.jobs.items.length > 50 ||
    !available(operational.guard) ||
    typeof operational.guard.blocked !== "number" ||
    typeof operational.guard.confirmed !== "number" ||
    !available(operational.continuity) ||
    !Number.isSafeInteger(operational.continuity.revision) ||
    !available(operational.papercuts) ||
    !Number.isSafeInteger(operational.papercuts.revision) ||
    !papercutCounts ||
    !["open", "resolved", "dismissed", "total"].every(
      key =>
        Number.isSafeInteger(papercutCounts?.[key]) &&
        (papercutCounts?.[key] as number) >= 0 &&
        (papercutCounts?.[key] as number) <= 1_000,
    ) ||
    (papercutCounts?.open as number) + (papercutCounts?.resolved as number) + (papercutCounts?.dismissed as number) !==
      papercutCounts?.total ||
    !available(operational.timeline) ||
    !Number.isSafeInteger(operational.timeline.revision) ||
    !Array.isArray(operational.timeline.checkpoints) ||
    operational.timeline.checkpoints.length > 100 ||
    (operational.timeline.failures !== undefined &&
      (!Array.isArray(operational.timeline.failures) || operational.timeline.failures.length > 20)) ||
    !available(operational.tools) ||
    !Array.isArray(operational.tools.policies) ||
    operational.tools.policies.length > 100 ||
    !available(operational.sieve) ||
    !healthStatuses.has(String(operational.health.status)) ||
    !Array.isArray(operational.health.issues) ||
    operational.health.issues.length > 20
  )
    return false;
  if (operational.sieve.availability === "available" && !validSieve(operational.sieve)) return false;
  if (operational.continuity.availability === "available" && !validContinuityMemory(operational.continuity))
    return false;
  return true;
}

function validExtensionUi(extensionUi: unknown): boolean {
  return (
    record(extensionUi) &&
    Array.isArray(extensionUi.notifications) &&
    extensionUi.notifications.length <= 10 &&
    extensionUi.notifications.every(
      item =>
        record(item) &&
        identifier(item.id) &&
        typeof item.message === "string" &&
        ["info", "warning", "error"].includes(item.type as string) &&
        typeof item.occurredAt === "string",
    ) &&
    Array.isArray(extensionUi.statuses) &&
    extensionUi.statuses.length <= 25 &&
    extensionUi.statuses.every(item => record(item) && identifier(item.key) && typeof item.text === "string") &&
    Array.isArray(extensionUi.widgets) &&
    extensionUi.widgets.length <= 10 &&
    extensionUi.widgets.every(
      item =>
        record(item) &&
        identifier(item.key) &&
        Array.isArray(item.lines) &&
        item.lines.length <= 40 &&
        item.lines.every(line => typeof line === "string" && line.length <= 500),
    ) &&
    (extensionUi.title === undefined || typeof extensionUi.title === "string") &&
    typeof extensionUi.editorText === "string" &&
    extensionUi.editorText.length <= MAX_MESSAGE_LENGTH &&
    Number.isSafeInteger(extensionUi.editorRevision) &&
    (extensionUi.editorRevision as number) >= 0
  );
}

export function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!identifier(value.sessionId) || !generation(value.sessionGeneration) || typeof value.ready !== "boolean")
    return false;
  if (typeof value.cwdLabel !== "string" || !Array.isArray(value.activeTools) || !Array.isArray(value.availableTools))
    return false;
  if (value.projectAvailable !== undefined && typeof value.projectAvailable !== "boolean") return false;
  if (value.sessionName !== undefined && (typeof value.sessionName !== "string" || value.sessionName.length > 200))
    return false;
  if (value.gitBranch !== undefined && (typeof value.gitBranch !== "string" || value.gitBranch.length > 200))
    return false;
  if (value.workspace !== undefined && !validWorkspaceSnapshot(value.workspace)) return false;
  if (!validRuntimePolicySnapshot(value.runtimePolicy)) return false;
  if (value.providerAuth !== undefined && !validProviderAuth(value.providerAuth)) return false;
  if (value.commandResult !== undefined && !validCommandResult(value.commandResult)) return false;
  if (
    !value.activeTools.every(item => typeof item === "string") ||
    !value.availableTools.every(item => typeof item === "string")
  )
    return false;
  if (
    !record(value.optionalCapabilities) ||
    !Object.values(value.optionalCapabilities).every(item => item === "available" || item === "unavailable")
  )
    return false;
  if (
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(
      item =>
        record(item) && ["info", "warning", "error"].includes(item.level as string) && typeof item.message === "string",
    )
  )
    return false;
  if (!validConversation(value.conversation)) return false;
  if (!validSessionControls(value.sessionControls)) return false;
  if (!validRuntimeMetrics(value.metrics)) return false;
  if (value.discoverIndex !== undefined && !validDiscoverIndex(value.discoverIndex)) return false;
  if (!validOperational(value.operational)) return false;
  return validExtensionUi(value.extensionUi);
}

type ValidationIssue = { area: string; detail: string };

function issue(area: string, detail: string): ValidationIssue {
  return { area: `operational.${area}`, detail };
}

function sieveValidationIssue(sieve: Record<string, unknown>): ValidationIssue | undefined {
  if (!sieveModes.has(String(sieve.mode))) return issue("sieve.mode", "is invalid");
  if (!sieveProjectionModes.has(String(sieve.projectionMode))) return issue("sieve.projectionMode", "is invalid");
  if (!Number.isSafeInteger(sieve.threshold) || (sieve.threshold as number) < 1_000)
    return issue("sieve.threshold", "must be a safe integer of at least 1000");
  if (typeof sieve.activePruning !== "boolean") return issue("sieve.activePruning", "must be boolean");
  if (!sieveLatestModes.has(String(sieve.latestMode))) return issue("sieve.latestMode", "is invalid");
  const statsIssue = (raw: unknown, path: string) => {
    if (!record(raw)) return issue(path, "must be an object");
    if (!record(raw.transformedBy)) return issue(`${path}.transformedBy`, "must be an object");
    if (!record(raw.byTool)) return issue(`${path}.byTool`, "must be an object");
    if (Object.keys(raw.byTool).length > 33) return issue(`${path}.byTool`, "must contain at most 33 tools");
    for (const key of ["scanned", "transformed", "omittedChars", "netCharsSaved"] as const) {
      if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)
        return issue(`${path}.${key}`, "must be a non-negative safe integer");
    }
    for (const key of [
      "ageThreshold",
      "budget",
      "activeThreshold",
      "staleRead",
      "duplicate",
      "errorCap",
      "mixedText",
    ] as const) {
      if (!Number.isSafeInteger(raw.transformedBy[key]) || (raw.transformedBy[key] as number) < 0)
        return issue(`${path}.transformedBy.${key}`, "must be a non-negative safe integer");
    }
    for (const [name, usage] of Object.entries(raw.byTool)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return issue(`${path}.byTool`, "contains an invalid tool name");
      if (!record(usage)) return issue(`${path}.byTool.${name}`, "must be an object");
      for (const key of ["scanned", "transformed", "sourceChars", "retainedChars", "netCharsSaved"] as const) {
        if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)
          return issue(`${path}.byTool.${name}.${key}`, "must be a non-negative safe integer");
      }
    }
    return undefined;
  };
  for (const key of ["latest", "cumulativeActual", "cumulativeProjected"] as const) {
    const invalid = statsIssue(sieve[key], `sieve.${key}`);
    if (invalid) return invalid;
  }
  for (const key of ["recalls", "recalledChars"] as const)
    if (!Number.isSafeInteger(sieve[key]) || (sieve[key] as number) < 0)
      return issue(`sieve.${key}`, "must be a non-negative safe integer");
  if (!record(sieve.recallsByTool)) return issue("sieve.recallsByTool", "must be an object");
  if (Object.keys(sieve.recallsByTool).length > 33)
    return issue("sieve.recallsByTool", "must contain at most 33 tools");
  for (const [name, usage] of Object.entries(sieve.recallsByTool)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return issue("sieve.recallsByTool", "contains an invalid tool name");
    if (!record(usage)) return issue(`sieve.recallsByTool.${name}`, "must be an object");
    for (const key of ["recalls", "recalledChars"] as const)
      if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)
        return issue(`sieve.recallsByTool.${name}.${key}`, "must be a non-negative safe integer");
  }
  if (typeof sieve.updatedAt !== "string" || Number.isNaN(Date.parse(sieve.updatedAt)))
    return issue("sieve.updatedAt", "must be a valid timestamp");
  if (sieve.error !== undefined && !boundedString(sieve.error, 500))
    return issue("sieve.error", "must be a non-empty string of at most 500 characters");
  const metricObjectIssue = (raw: unknown, path: string, keys: string[]) => {
    if (!record(raw)) return issue(path, "must be an object");
    for (const key of keys)
      if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)
        return issue(`${path}.${key}`, "must be a non-negative safe integer");
    return undefined;
  };
  if (sieve.epoch !== undefined) {
    const invalid = metricObjectIssue(sieve.epoch, "sieve.epoch", [
      "frozenResultCount",
      "frozenSourceChars",
      "frozenRetainedChars",
      "rolloverEligibleRetainedChars",
      "recoverableEntries",
    ]);
    if (invalid) return invalid;
    const epoch = sieve.epoch as Record<string, unknown>;
    for (const key of ["id", "reason", "promptFingerprint"] as const)
      if (epoch[key] !== undefined && !boundedString(epoch[key], 200))
        return issue(`sieve.epoch.${key}`, "must be a non-empty string of at most 200 characters");
    if (
      epoch.startedAt !== undefined &&
      (typeof epoch.startedAt !== "string" || Number.isNaN(Date.parse(epoch.startedAt)))
    )
      return issue("sieve.epoch.startedAt", "must be a valid timestamp");
  }
  if (sieve.stability !== undefined) {
    const invalid = metricObjectIssue(sieve.stability, "sieve.stability", [
      "newProjections",
      "projectionCacheHits",
      "recoverableEntries",
      "explicitReflows",
      "softBudgetExceedances",
      "prefixChurnViolations",
      "estimatedInvalidatedChars",
    ]);
    if (invalid) return invalid;
    const stability = sieve.stability as Record<string, unknown>;
    for (const key of [
      "earliestChangedPriorMessageIndex",
      "standardComparisons",
      "standardPrefixChurn",
      "standardEarliestChangedPriorMessageIndex",
      "standardEstimatedInvalidatedChars",
    ] as const) {
      if (stability[key] !== undefined && (!Number.isSafeInteger(stability[key]) || (stability[key] as number) < 0))
        return issue(`sieve.stability.${key}`, "must be a non-negative safe integer");
    }
    if (stability.standardChangesByKind !== undefined) {
      const changes = stability.standardChangesByKind;
      if (!record(changes)) return issue("sieve.stability.standardChangesByKind", "must be an object");
      for (const key of [
        "activeThreshold",
        "ageThreshold",
        "budget",
        "staleRead",
        "duplicate",
        "errorCap",
        "history",
      ] as const)
        if (!Number.isSafeInteger(changes[key]) || (changes[key] as number) < 0)
          return issue(`sieve.stability.standardChangesByKind.${key}`, "must be a non-negative safe integer");
    }
  }
  if (
    sieve.contextUsagePercent !== undefined &&
    (typeof sieve.contextUsagePercent !== "number" ||
      !Number.isFinite(sieve.contextUsagePercent) ||
      sieve.contextUsagePercent < 0 ||
      sieve.contextUsagePercent > 100)
  )
    return issue("sieve.contextUsagePercent", "must be a finite percentage from 0 to 100");
  return undefined;
}

function continuityMemoryIssue(continuity: Record<string, unknown>): ValidationIssue | undefined {
  const safePath = (path: unknown) =>
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 240 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[a-z]:/i.test(path) &&
    !path.split(/[\\/]+/).some(part => !part || part === "." || part === "..");
  const memoryIssue = (raw: unknown, scope: "user" | "project", path: string) => {
    if (!Array.isArray(raw) || raw.length > 1_000) return issue(path, "must be an array with at most 1000 notes");
    for (let index = 0; index < raw.length; index++) {
      const note = raw[index],
        notePath = `${path}[${index}]`;
      if (!record(note)) return issue(notePath, "must be an object");
      if (typeof note.id !== "string" || note.id.length > MAX_ID_LENGTH || !memoryNoteId.test(note.id))
        return issue(`${notePath}.id`, "must be a UUID of at most 128 characters");
      if (note.scope !== scope) return issue(`${notePath}.scope`, `must be ${scope}`);
      if (
        typeof note.trigger !== "string" ||
        note.trigger.length < 1 ||
        note.trigger.length > 240 ||
        note.trigger !== note.trigger.trim()
      )
        return issue(`${notePath}.trigger`, "must be trimmed and contain 1 to 240 characters");
      if (
        typeof note.guidance !== "string" ||
        note.guidance.length < 1 ||
        note.guidance.length > 800 ||
        note.guidance !== note.guidance.trim()
      )
        return issue(`${notePath}.guidance`, "must be trimmed and contain 1 to 800 characters");
      if (note.trigger.length + note.guidance.length > 1_000)
        return issue(notePath, "trigger and guidance must total at most 1000 characters");
      if (!memoryAuthorities.has(String(note.authority))) return issue(`${notePath}.authority`, "is invalid");
      if (!memoryOrigins.has(String(note.origin))) return issue(`${notePath}.origin`, "is invalid");
      if (note.disposition !== undefined && !memoryDispositions.has(String(note.disposition)))
        return issue(`${notePath}.disposition`, "is invalid");
      if (
        note.enforcementAuthority !== undefined &&
        !memoryEnforcementAuthorities.has(String(note.enforcementAuthority))
      )
        return issue(`${notePath}.enforcementAuthority`, "is invalid");
      if (
        note.relatedPaths !== undefined &&
        (!Array.isArray(note.relatedPaths) || note.relatedPaths.length > 5 || !note.relatedPaths.every(safePath))
      )
        return issue(`${notePath}.relatedPaths`, "must contain at most 5 safe relative paths");
      if (!Number.isSafeInteger(note.revision) || (note.revision as number) < 1)
        return issue(`${notePath}.revision`, "must be a positive safe integer");
      if (typeof note.updatedAt !== "string" || Number.isNaN(Date.parse(note.updatedAt)))
        return issue(`${notePath}.updatedAt`, "must be a valid timestamp");
      if (typeof note.sourceSummary !== "string" || note.sourceSummary.length > 500)
        return issue(`${notePath}.sourceSummary`, "must be a string of at most 500 characters");
    }
    return undefined;
  };
  const projectIssue = memoryIssue(continuity.memory, "project", "continuity.memory");
  if (projectIssue) return projectIssue;
  return memoryIssue(continuity.globalMemory, "user", "continuity.globalMemory");
}

function operationalValidationIssue(value: unknown): ValidationIssue | undefined {
  if (!record(value)) return issue("data", "must be an object");
  const names = [
    "verification",
    "jobs",
    "guard",
    "continuity",
    "papercuts",
    "timeline",
    "tools",
    "sieve",
    "health",
  ] as const;
  for (const name of names) if (!record(value[name])) return issue(name, "must be an object");
  const operational = value as Record<(typeof names)[number], Record<string, unknown>>;
  const available = (feature: Record<string, unknown>) =>
    feature.availability === "available" || feature.availability === "unavailable";
  for (const name of names.slice(0, -1))
    if (!available(operational[name])) return issue(`${name}.availability`, "must be available or unavailable");
  if (!Array.isArray(operational.verification.checks) || operational.verification.checks.length > 20)
    return issue("verification.checks", "must be an array with at most 20 items");
  if (!Array.isArray(operational.jobs.items) || operational.jobs.items.length > 50)
    return issue("jobs.items", "must be an array with at most 50 items");
  for (const key of ["blocked", "confirmed"] as const)
    if (typeof operational.guard[key] !== "number") return issue(`guard.${key}`, "must be a number");
  if (!Number.isSafeInteger(operational.continuity.revision))
    return issue("continuity.revision", "must be a safe integer");
  if (!Number.isSafeInteger(operational.papercuts.revision))
    return issue("papercuts.revision", "must be a safe integer");
  if (!record(operational.papercuts.counts)) return issue("papercuts.counts", "must be an object");
  if (!Number.isSafeInteger(operational.timeline.revision)) return issue("timeline.revision", "must be a safe integer");
  if (!Array.isArray(operational.timeline.checkpoints) || operational.timeline.checkpoints.length > 100)
    return issue("timeline.checkpoints", "must be an array with at most 100 items");
  if (
    operational.timeline.failures !== undefined &&
    (!Array.isArray(operational.timeline.failures) || operational.timeline.failures.length > 20)
  )
    return issue("timeline.failures", "must be an array with at most 20 items");
  if (!Array.isArray(operational.tools.policies) || operational.tools.policies.length > 100)
    return issue("tools.policies", "must be an array with at most 100 items");
  if (!healthStatuses.has(String(operational.health.status)))
    return issue("health.status", "must be healthy, degraded, or unavailable");
  if (!Array.isArray(operational.health.issues) || operational.health.issues.length > 20)
    return issue("health.issues", "must be an array with at most 20 items");

  if (operational.sieve.availability === "available") {
    const invalid = sieveValidationIssue(operational.sieve);
    if (invalid) return invalid;
  }
  if (operational.continuity.availability === "available") return continuityMemoryIssue(operational.continuity);
  return undefined;
}

export interface RuntimeSnapshotValidationIssue {
  kind: "protocol" | "snapshot";
  area: string;
  detail: string;
}

export function runtimeSnapshotValidationIssue(value: unknown): RuntimeSnapshotValidationIssue | undefined {
  if (!record(value)) return { kind: "snapshot", area: "payload", detail: "the response is not an object" };
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return {
      kind: "protocol",
      area: "protocol",
      detail: `expected ${PROTOCOL_VERSION}, received ${String(value.protocolVersion ?? "missing")}`,
    };
  }
  if (!identifier(value.sessionId) || !generation(value.sessionGeneration) || typeof value.ready !== "boolean") {
    return { kind: "snapshot", area: "identity", detail: "session ID, generation, or readiness is invalid" };
  }
  const requiredAreas = [
    "runtimePolicy",
    "conversation",
    "sessionControls",
    "metrics",
    "operational",
    "extensionUi",
  ] as const;
  const missing = requiredAreas.find(area => !record(value[area]));
  if (missing) return { kind: "snapshot", area: missing, detail: "required runtime data is missing" };
  if (!isRuntimeSnapshot(value)) {
    const operationalIssue = operationalValidationIssue(value.operational);
    if (operationalIssue) return { kind: "snapshot", ...operationalIssue };
    const validAreaReplacements: Array<[string, Record<string, unknown>]> = [
      ["workspace", { workspace: undefined }],
      [
        "runtime policy",
        {
          runtimePolicy: {
            revision: 0,
            global: {
              timelineEnabled: true,
              guardEnabled: true,
              workspace: "local",
              guardTimeoutSeconds: 60,
              clarifyTimeoutSeconds: 60,
            },
            project: { verify: { mode: "auto" } },
            session: {},
            effective: {
              verify: { mode: "auto" },
              timelineEnabled: true,
              guardEnabled: true,
              workspace: "local",
              guardTimeoutSeconds: 60,
              clarifyTimeoutSeconds: 60,
            },
            availableVerifyChecks: [],
          },
        },
      ],
      ["capabilities", { activeTools: [], availableTools: [], optionalCapabilities: {}, diagnostics: [] }],
      [
        "conversation",
        {
          conversation: {
            messages: [],
            tools: [],
            delegatedRuns: [],
            streaming: false,
            queue: { steering: 0, followUp: 0 },
            retry: { active: false },
            compaction: { active: false },
          },
        },
      ],
      ["session controls", { sessionControls: { models: [], thinkingLevels: [] } }],
      [
        "metrics",
        {
          metrics: {
            model: "",
            provider: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            contextTokens: 0,
            contextLimit: 0,
            contextPercent: 0,
            cost: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
          },
        },
      ],
      ["Discover index", { discoverIndex: undefined }],
      [
        "operational data",
        {
          operational: {
            verification: { availability: "unavailable", checks: [] },
            jobs: { availability: "unavailable", items: [] },
            guard: { availability: "unavailable", blocked: 0, confirmed: 0 },
            continuity: { availability: "unavailable", revision: 0 },
            papercuts: {
              availability: "unavailable",
              revision: 0,
              counts: { open: 0, resolved: 0, dismissed: 0, total: 0 },
            },
            timeline: { availability: "unavailable", revision: 0, checkpoints: [], failures: [] },
            tools: { availability: "unavailable", policies: [] },
            sieve: { availability: "unavailable" },
            health: { status: "unavailable", issues: [] },
          },
        },
      ],
      [
        "extension UI",
        { extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 } },
      ],
    ];
    const area = validAreaReplacements.find(([, replacement]) => isRuntimeSnapshot({ ...value, ...replacement }))?.[0];
    if (area) return { kind: "snapshot", area, detail: "a field is invalid, oversized, or incomplete" };
    return { kind: "snapshot", area: "runtime data", detail: "a field is invalid, oversized, or incomplete" };
  }
  return undefined;
}

export function describeRuntimeSnapshotIssue(
  value: unknown,
  issue = runtimeSnapshotValidationIssue(value),
): string | undefined {
  if (!issue) return undefined;
  const input = record(value) ? value : {};
  const session = identifier(input.sessionId) ? input.sessionId : "unknown";
  const generationValue = generation(input.sessionGeneration) ? input.sessionGeneration : "unknown";
  const ready = typeof input.ready === "boolean" ? input.ready : "unknown";
  if (issue.kind === "protocol") {
    return `Runtime protocol mismatch: ${issue.detail} (session ${session}, generation ${generationValue}, ready ${ready}).`;
  }
  return `Invalid runtime snapshot in ${issue.area}: ${issue.detail} (session ${session}, generation ${generationValue}, ready ${ready}, protocol ${String(input.protocolVersion ?? "missing")}).`;
}

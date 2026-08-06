import { COMMAND_NAMES, type WebCommand } from "./commands.ts";
import { PROTOCOL_VERSION, type WebEvent } from "./envelope.ts";
import type { ArchiveListSnapshot, ConversationHistoryPage, ConversationTurnIndexPage, FileSuggestionList, HookSettingsReadModel, HookSettingsSnapshot, PackageListSnapshot, PackageSettingsReadModel, RuntimeSnapshot, SessionListSnapshot, StateQLSnapshot, WorkspaceFileContent, WorkspaceFilePage } from "./snapshots.ts";

const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TEXT_FILES = 100;
const MAX_TEXT_FILE_TOTAL_BYTES = 10 * 1024 * 1024;
const commandNames = new Set<string>(COMMAND_NAMES);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const runtimeStates = new Set(["sleeping", "idle", "running", "attention"]);
const memoryScopes = new Set(["user", "project"]);
const memoryAuthorities = new Set(["user_instruction", "project_contract", "imported"]);
const memoryOrigins = new Set(["user", "agent", "migration"]);
const memoryNoteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delegatedAgentKinds = new Set(["advisor", "grunt", "repo_scout", "web_scout", "spawn_agent", "spawn_session"]);
const spawnExecutionActions = new Set(["create", "continue", "adopt"]);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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

function validImages(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGES) return false;
  let totalBytes = 0;
  for (const image of value) {
    if (!record(image) || !imageMimeTypes.has(String(image.mimeType)) || typeof image.data !== "string"
      || image.data.length === 0 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false;
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const bytes = image.data.length / 4 * 3 - padding;
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
    if (!record(file)
      || typeof file.name !== "string" || !file.name || file.name.length > 255 || /[\/\\\0]/.test(file.name)
      || typeof file.text !== "string" || !file.text || file.text.includes("\0")
      || !Number.isSafeInteger(file.size) || (file.size as number) <= 0
      || (file.mimeType !== undefined && (typeof file.mimeType !== "string" || file.mimeType.length > 120))) return false;
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
  return value.mode === "selected"
    && Array.isArray(value.checks)
    && value.checks.length <= 6
    && value.checks.every((check) => boundedString(check, 100))
    && new Set(value.checks).size === value.checks.length;
}

function validDialogTimeout(value: unknown, allowInherit = false): boolean {
  return value === null
    || allowInherit && value === "inherit"
    || Number.isSafeInteger(value) && (value as number) >= 15 && (value as number) <= 86_400;
}

function validToolOverrides(value: unknown): boolean {
  return record(value) && Object.keys(value).length <= 256
    && Object.entries(value).every(([tool, mode]) => boundedString(tool, 200)
      && (mode === "active" || mode === "deferred" || mode === "disabled"));
}

export function validHookSettings(value: unknown): value is HookSettingsReadModel {
  if (!record(value) || Object.keys(value).length !== 2
    || !record(value.sessionStart) || !record(value.beforeAgentStart)) return false;
  let totalBytes = 0;
  const hook = (item: Record<string, unknown>) => {
    if (Object.keys(item).length !== 2 || typeof item.enabled !== "boolean"
      || !Array.isArray(item.sources) || item.sources.length > 20) return false;
    const ids = new Set<string>();
    for (const source of item.sources) {
      if (!record(source) || Object.keys(source).length !== 4 || !identifier(source.id) || !boundedString(source.name, 200)
        || (source.kind !== "file" && source.kind !== "text") || typeof source.content !== "string") return false;
      const bytes = new TextEncoder().encode(source.content).byteLength;
      if (bytes > 64 * 1024 || ids.has(source.id)) return false;
      ids.add(source.id);
      totalBytes += bytes;
    }
    return true;
  };
  return hook(value.sessionStart) && hook(value.beforeAgentStart) && totalBytes <= 96 * 1024;
}

export function validPackageSettings(value: unknown): value is PackageSettingsReadModel {
  if (!record(value) || typeof value.kind !== "string") return false;
  const modelMode = value.mode === "disabled" || value.mode === "session" || value.mode === "model";
  const model = value.model === undefined || boundedString(value.model, 400);
  const thinking = value.thinking === undefined || thinkingLevels.has(String(value.thinking));
  if (value.kind === "advisor" || value.kind === "scout") {
    return modelMode && model && thinking && (value.mode !== "model" || boundedString(value.model, 400));
  }
  const validThinkingList = (levels: unknown) => Array.isArray(levels) && levels.length > 0
    && new Set(levels).size === levels.length
    && levels.every((level) => thinkingLevels.has(String(level)));
  if (value.kind === "grunt") {
    return modelMode && model
      && (value.mode !== "model" || boundedString(value.model, 400))
      && ["isolated", "direct", "dynamic"].includes(String(value.executionMode))
      && validThinkingList(value.thinkingLevels);
  }
  if (value.kind === "continuity") {
    return typeof value.memoryEnabled === "boolean" && ["planner", "executor", "memoryReviewer", "compactionReviewer"].every((key) => {
      const profile = value[key];
      return profile === undefined || record(profile)
        && boundedString(profile.model, 400)
        && (profile.thinking === undefined || thinkingLevels.has(String(profile.thinking)));
    });
  }
  if (value.kind === "sieve") {
    return typeof value.activePruning === "boolean"
      && (value.projectionMode === "stable" || value.projectionMode === "legacy" || value.projectionMode === "standard-v2")
      && Number.isSafeInteger(value.threshold)
      && (value.threshold as number) >= 1_000
      && (value.threshold as number) <= 50_000
      && Number.isSafeInteger(value.rolloverHighMultiplier)
      && Number.isSafeInteger(value.rolloverLowMultiplier)
      && (value.rolloverLowMultiplier as number) >= 1
      && (value.rolloverHighMultiplier as number) <= 64
      && (value.rolloverHighMultiplier as number) > (value.rolloverLowMultiplier as number);
  }
  if (value.kind === "helios") return typeof value.headed === "boolean";
  if (value.kind === "timeline") return typeof value.editRollbackDefault === "boolean";
  return value.kind === "spawn"
    && (value.agentAvailability === "deferred" || value.agentAvailability === "active")
    && (value.sessionAvailability === "deferred" || value.sessionAvailability === "active")
    && (value.models === undefined || Array.isArray(value.models) && value.models.length > 0
      && new Set(value.models).size === value.models.length
      && value.models.every((model) => boundedString(model, 400)))
    && validThinkingList(value.agentThinkingLevels);
}

export function validateCommand(value: unknown): ValidationResult<WebCommand> {
  if (!record(value)) return { ok: false, error: "command must be an object" };
  if (typeof value.type !== "string" || !commandNames.has(value.type)) {
    return { ok: false, error: "unknown command type" };
  }
  if (!identifier(value.commandId)) return { ok: false, error: "invalid commandId" };
  if (!generation(value.expectedGeneration)) return { ok: false, error: "invalid expectedGeneration" };

  if (["prompt", "queuePrompt", "steer", "followUp", "editPrompt"].includes(value.type)) {
    if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_LENGTH
      || (!value.message.length && !Array.isArray(value.images) && !Array.isArray(value.files))) {
      return { ok: false, error: "invalid message" };
    }
    if (!validImages(value.images)) return { ok: false, error: "invalid images" };
    if (!validTextFiles(value.files)) return { ok: false, error: "invalid text files" };
  }
  if (["prompt", "queuePrompt"].includes(value.type)
    && value.planMode !== undefined && typeof value.planMode !== "boolean") {
    return { ok: false, error: "invalid prompt mode" };
  }
  if (["restoreQueuedPrompt", "steerQueuedPrompt"].includes(value.type) && !identifier(value.queueId)) {
    return { ok: false, error: "invalid queueId" };
  }
  if (value.type === "editPrompt"
    && (!identifier(value.entryId) || typeof value.rollbackFiles !== "boolean")) {
    return { ok: false, error: "invalid prompt edit" };
  }
  if (value.type === "rewindPrompt" && !identifier(value.entryId)) {
    return { ok: false, error: "invalid prompt rewind" };
  }
  if (["switchSession", "deleteSession", "archiveSession", "restoreSession", "renameSession", "setSessionActive", "setSessionPinned", "reorderActiveSession"].includes(value.type) && !identifier(value.sessionId)) {
    return { ok: false, error: "invalid sessionId" };
  }
  if (["removeProject", "renameProject", "reorderProject", "archiveProject", "restoreProject", "updateProjectWorktreeSettings"].includes(value.type) && !identifier(value.projectId)) {
    return { ok: false, error: "invalid projectId" };
  }
  if (value.type === "renameProject" && (!boundedString(value.name) || !value.name.trim() || /[\u0000-\u001f\u007f]/.test(value.name))) {
    return { ok: false, error: "invalid project name" };
  }
  if (value.type === "renameSession" && (!boundedString(value.name) || !value.name.trim())) {
    return { ok: false, error: "invalid session name" };
  }
  if (value.type === "setSessionActive" && typeof value.active !== "boolean") {
    return { ok: false, error: "invalid session active state" };
  }
  if (value.type === "setSessionPinned" && typeof value.pinned !== "boolean") {
    return { ok: false, error: "invalid session pinned state" };
  }
  if (value.type === "reorderProject" && value.beforeProjectId !== undefined && !identifier(value.beforeProjectId)) {
    return { ok: false, error: "invalid project reorder target" };
  }
  if (value.type === "reorderActiveSession" && value.beforeSessionId !== undefined && !identifier(value.beforeSessionId)) {
    return { ok: false, error: "invalid active session reorder target" };
  }
  if (value.type === "fork") {
    if (!identifier(value.entryId)) return { ok: false, error: "invalid entryId" };
    if (!boundedString(value.name, 200) || !value.name.trim()) {
      return { ok: false, error: "invalid fork name" };
    }
    if (value.position !== undefined && value.position !== "before" && value.position !== "at") {
      return { ok: false, error: "invalid fork position" };
    }
    if (value.mode !== undefined && value.mode !== "conversation" && value.mode !== "timeline") {
      return { ok: false, error: "invalid fork mode" };
    }
  }
  if (value.type === "newSession" && value.parentSessionId !== undefined && !identifier(value.parentSessionId)) {
    return { ok: false, error: "invalid parentSessionId" };
  }
  if (value.type === "newSession" && value.projectId !== undefined && !identifier(value.projectId)) {
    return { ok: false, error: "invalid projectId" };
  }
  if (value.type === "newSession" && value.projectId !== undefined && value.parentSessionId !== undefined) {
    return { ok: false, error: "newSession accepts either projectId or parentSessionId" };
  }
  if (value.type === "timeline") {
    if (value.action !== "restore" && value.action !== "fork" && value.action !== "clear") {
      return { ok: false, error: "invalid timeline action" };
    }
    if (value.action === "clear") {
      if (value.checkpointId !== undefined) return { ok: false, error: "clear does not accept a checkpointId" };
    } else if (!identifier(value.checkpointId) || !/^[A-Za-z0-9:._-]+$/.test(value.checkpointId)) {
      return { ok: false, error: "invalid checkpointId" };
    }
  }
  if (value.type === "setPackageEnabled") {
    if (!identifier(value.packageId)) return { ok: false, error: "invalid packageId" };
    if (typeof value.enabled !== "boolean") return { ok: false, error: "invalid package enabled state" };
  }
  if (value.type === "updatePackageSettings") {
    if (!identifier(value.packageId)) return { ok: false, error: "invalid packageId" };
    if (!validPackageSettings(value.settings)) return { ok: false, error: "invalid package settings" };
  }
  if (value.type === "updateHookSettings" && !validHookSettings(value.settings)) {
    return { ok: false, error: "invalid hook settings" };
  }
  if (value.type === "updateProjectWorktreeSettings"
    && (typeof value.setupCommand !== "string" || value.setupCommand.length > 2_000)) {
    return { ok: false, error: "invalid worktree setup command" };
  }
  if (value.type === "updateRuntimePolicy") {
    if (value.scope !== "global" && value.scope !== "project" && value.scope !== "session") {
      return { ok: false, error: "invalid runtime policy scope" };
    }
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      return { ok: false, error: "invalid runtime policy revision" };
    }
    if (!validVerifyPolicy(value.verify, value.scope === "global" || value.scope === "session")
      || value.scope === "global" && (!record(value.verify) || value.verify.mode !== "inherit")) {
      return { ok: false, error: "invalid Verify policy" };
    }
    if (!["inherit", "enabled", "disabled"].includes(String(value.timeline))
      || value.scope === "global" && value.timeline === "inherit") {
      return { ok: false, error: "invalid Timeline policy" };
    }
    if (!["inherit", "enabled", "disabled"].includes(String(value.guard))
      || value.scope === "global" && value.guard === "inherit") {
      return { ok: false, error: "invalid Guard policy" };
    }
    if (!["inherit", "checkout", "worktree", "local"].includes(String(value.workspace))
      || value.scope === "global" && value.workspace === "inherit") {
      return { ok: false, error: "invalid workspace policy" };
    }
    if (!validDialogTimeout(value.guardTimeoutSeconds, value.scope !== "global")
      || !validDialogTimeout(value.clarifyTimeoutSeconds, value.scope !== "global")) {
      return { ok: false, error: "invalid dialog timeout policy" };
    }
  }
  if (value.type === "updateToolPolicy") {
    if (value.scope !== "global" && value.scope !== "project" && value.scope !== "session") {
      return { ok: false, error: "invalid tool policy scope" };
    }
    if (!boundedString(value.tool, 200) || !["inherit", "active", "deferred", "disabled"].includes(String(value.mode))) {
      return { ok: false, error: "invalid tool policy" };
    }
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      return { ok: false, error: "invalid tool policy revision" };
    }
  }
  if (value.type === "dismissCommandResult" && !identifier(value.resultId)) {
    return { ok: false, error: "invalid command result" };
  }
  if (value.type === "handoffSession"
    && value.destination !== "checkout" && value.destination !== "worktree") {
    return { ok: false, error: "invalid handoff destination" };
  }
  if (value.type === "applySessionChanges" && !boundedString(value.expectedRevision, 128)) {
    return { ok: false, error: "invalid workspace revision" };
  }
  if (value.type === "setModel" && (!boundedString(value.provider) || !boundedString(value.modelId))) {
    return { ok: false, error: "invalid model" };
  }
  if (value.type === "setThinkingLevel" && !thinkingLevels.has(String(value.level))) {
    return { ok: false, error: "invalid thinking level" };
  }
  if (value.type === "setSessionControls"
    && (!boundedString(value.provider) || !boundedString(value.modelId)
      || !thinkingLevels.has(String(value.thinkingLevel)))) {
    return { ok: false, error: "invalid session controls" };
  }
  if ((value.type === "startProviderLogin" || value.type === "logoutProvider")
    && !boundedString(value.provider, 200)) {
    return { ok: false, error: "invalid provider" };
  }
  if (value.type === "startProviderLogin" && value.authType !== "api_key" && value.authType !== "oauth") {
    return { ok: false, error: "invalid provider authentication type" };
  }
  if (value.type === "migrateContinuityMemory") {
    const allowed = new Set(["type", "commandId", "expectedGeneration"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      return { ok: false, error: "invalid memory migration" };
    }
  }
  if (value.type === "updateContinuityMemory" || value.type === "deleteContinuityMemory") {
    const allowed = value.type === "updateContinuityMemory"
      ? new Set(["type", "commandId", "expectedGeneration", "scope", "id", "trigger", "guidance", "expectedRevision"])
      : new Set(["type", "commandId", "expectedGeneration", "scope", "id", "expectedRevision"]);
    if (Object.keys(value).some((key) => !allowed.has(key))
      || !memoryScopes.has(String(value.scope)) || typeof value.id !== "string" || value.id.length > MAX_ID_LENGTH || !memoryNoteId.test(value.id)
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) {
      return { ok: false, error: "invalid memory target" };
    }
  }
  if (value.type === "updateContinuityMemory") {
    const trigger = value.trigger;
    const guidance = value.guidance;
    if (typeof trigger !== "string" || trigger.length < 1 || trigger.length > 240 || trigger !== trigger.trim()
      || typeof guidance !== "string" || guidance.length < 1 || guidance.length > 800 || guidance !== guidance.trim()
      || trigger.length + guidance.length > 1_000) {
      return { ok: false, error: "invalid memory update" };
    }
  }

  return { ok: true, value: value as unknown as WebCommand };
}

export function isHookSettingsSnapshot(value: unknown): value is HookSettingsSnapshot {
  return record(value) && value.protocolVersion === PROTOCOL_VERSION
    && generation(value.sessionGeneration) && validHookSettings(value.settings);
}

export function isPackageListSnapshot(value: unknown): value is PackageListSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !Array.isArray(value.packages) || value.packages.length > 100) return false;
  return value.packages.every((item) => record(item)
    && identifier(item.id)
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 200
    && typeof item.description === "string" && item.description.length <= 500
    && (item.required === undefined || typeof item.required === "boolean")
    && typeof item.enabled === "boolean"
    && typeof item.active === "boolean"
    && Number.isSafeInteger(item.extensionCount) && (item.extensionCount as number) > 0 && (item.extensionCount as number) <= 50
    && (item.settings === undefined || validPackageSettings(item.settings))
    && (item.error === undefined || typeof item.error === "string" && item.error.length <= 500));
}

export function isWebEvent(value: unknown): value is WebEvent {
  if (!record(value)) return false;
  return value.protocolVersion === PROTOCOL_VERSION
    && Number.isSafeInteger(value.payloadVersion) && (value.payloadVersion as number) > 0
    && identifier(value.eventId)
    && identifier(value.sessionId)
    && generation(value.sessionGeneration)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0
    && typeof value.occurredAt === "string" && !Number.isNaN(Date.parse(value.occurredAt))
    && typeof value.type === "string" && value.type.length > 0;
}

export function isSessionListSnapshot(value: unknown): value is SessionListSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !Array.isArray(value.activeSessions) || value.activeSessions.length > 100
    || !value.activeSessions.every((session) => validSessionSummary(session))
    || !Array.isArray(value.projects) || value.projects.length > 100) return false;
  return value.projects.every((project) => record(project)
    && identifier(project.id)
    && typeof project.label === "string" && project.label.length > 0 && project.label.length <= 500
    && boundedString(project.cwd, 32 * 1024)
    && Number.isSafeInteger(project.totalCount) && (project.totalCount as number) >= 0
    && (project.nextCursor === undefined || identifier(project.nextCursor))
    && Array.isArray(project.sessions) && project.sessions.length <= 100
    && project.sessions.every((session) => validSessionSummary(session, project.id as string)));
}

function validWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    && !value.startsWith("/") && !value.includes("\\")
    && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function isWorkspaceFilePage(value: unknown): value is WorkspaceFilePage {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !boundedString(value.revision, 128) || !Array.isArray(value.files) || value.files.length > 200
    || !Number.isSafeInteger(value.totalCount) || (value.totalCount as number) < 0 || (value.totalCount as number) > 10_000
    || typeof value.truncated !== "boolean"
    || (value.nextCursor !== undefined && !identifier(value.nextCursor))) return false;
  return value.files.every((file) => record(file) && validWorkspacePath(file.path)
    && (file.status === undefined || ["added", "modified", "deleted"].includes(String(file.status)))
    && (file.binary === undefined || typeof file.binary === "boolean")
    && (file.additions === undefined || Number.isSafeInteger(file.additions) && (file.additions as number) >= 0)
    && (file.deletions === undefined || Number.isSafeInteger(file.deletions) && (file.deletions as number) >= 0));
}

export function isWorkspaceFileContent(value: unknown): value is WorkspaceFileContent {
  return record(value)
    && value.protocolVersion === PROTOCOL_VERSION
    && generation(value.sessionGeneration)
    && boundedString(value.revision, 128)
    && validWorkspacePath(value.path)
    && ["available", "deleted", "binary", "oversized"].includes(String(value.state))
    && (value.text === undefined || typeof value.text === "string" && value.text.length <= 2 * 1024 * 1024)
    && (value.truncated === undefined || typeof value.truncated === "boolean");
}

export function isStateQLSnapshot(value: unknown): value is StateQLSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !record(value.session) || !identifier(value.session.session_id) || !identifier(value.session.name)
    || !["active", "closed"].includes(String(value.session.status)) || !identifier(value.actor_id)
    || !Array.isArray(value.recent_results) || value.recent_results.length > 10
    || !Array.isArray(value.recent_operations) || value.recent_operations.length > 10
    || !Array.isArray(value.history) || value.history.length > 100) return false;
  const connection = value.connection;
  if (connection !== null && (!record(connection) || !identifier(connection.connection_id)
    || !boundedString(connection.name, 500) || connection.status !== "connected"
    || !["sqlite", "postgres", "mysql"].includes(String(connection.driver))
    || !boundedString(connection.database, 500) || typeof connection.read_only !== "boolean")) return false;
  const transaction = value.transaction;
  if (transaction !== null && (!record(transaction) || !identifier(transaction.transaction_id)
    || !identifier(transaction.owner_actor_id) || !boundedString(transaction.state, 100))) return false;
  if (value.session.status === "closed" && (connection !== null || transaction !== null)) return false;
  if (value.state_version !== null && !boundedString(value.state_version, 128)) return false;
  if (value.state_confidence !== null && !["authoritative", "transaction_snapshot", "database_reported", "local", "ttl_based", "unknown"].includes(String(value.state_confidence))) return false;
  if (!value.recent_results.every((item) => record(item)
    && (item.alias === null || boundedString(item.alias, 200)) && identifier(item.handle)
    && Number.isSafeInteger(item.rows) && (item.rows as number) >= 0 && (item.rows as number) <= 10_000)) return false;
  if (!value.recent_operations.every((item) => record(item) && identifier(item.handle)
    && identifier(item.actor_id) && boundedString(item.type, 100) && boundedString(item.status, 100)
    && (item.affected_rows === null || Number.isSafeInteger(item.affected_rows) && (item.affected_rows as number) >= 0))) return false;
  return value.history.every((item) => record(item) && identifier(item.command_id)
    && typeof item.timestamp === "string" && item.timestamp.length <= 64 && !Number.isNaN(Date.parse(item.timestamp))
    && identifier(item.session_id) && identifier(item.actor_id) && boundedString(item.command, 100)
    && (item.sql === null || typeof item.sql === "string" && new TextEncoder().encode(item.sql).byteLength <= 4_096)
    && (item.handle === null || identifier(item.handle))
    && typeof item.executed === "boolean" && typeof item.cached === "boolean" && typeof item.success === "boolean"
    && (item.error_code === null || boundedString(item.error_code, 100)));
}

export function isArchiveListSnapshot(value: unknown): value is ArchiveListSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !Array.isArray(value.projects) || value.projects.length > 100
    || !Array.isArray(value.sessions) || value.sessions.length > 100
    || !Number.isSafeInteger(value.totalSessionCount) || (value.totalSessionCount as number) < 0
    || (value.nextCursor !== undefined && !identifier(value.nextCursor))) return false;
  if (!value.projects.every((project) => record(project)
    && identifier(project.id)
    && boundedString(project.label, 500)
    && Number.isSafeInteger(project.sessionCount) && (project.sessionCount as number) >= 0
    && typeof project.archivedAt === "string" && !Number.isNaN(Date.parse(project.archivedAt)))) return false;
  return value.sessions.every((session) => validSessionSummary(session)
    && typeof session.archivedAt === "string" && !Number.isNaN(Date.parse(session.archivedAt)));
}

function validSessionSummary(value: unknown, projectId?: string): boolean {
  return record(value)
    && identifier(value.id)
    && identifier(value.projectId)
    && (projectId === undefined || value.projectId === projectId)
    && (value.name === undefined || typeof value.name === "string" && value.name.length <= 200)
    && (value.parentSession === undefined || record(value.parentSession)
      && identifier(value.parentSession.id)
      && boundedString(value.parentSession.title, 200))
    && typeof value.cwdLabel === "string" && value.cwdLabel.length <= 500
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && typeof value.modifiedAt === "string" && !Number.isNaN(Date.parse(value.modifiedAt))
    && (value.workStartedAt === undefined || typeof value.workStartedAt === "string" && !Number.isNaN(Date.parse(value.workStartedAt)))
    && Number.isSafeInteger(value.userMessageCount) && (value.userMessageCount as number) >= 0
    && typeof value.preview === "string" && value.preview.length <= 500
    && typeof value.active === "boolean"
    && typeof value.pinned === "boolean"
    && runtimeStates.has(String(value.runtimeState));
}

function validDelegatedRun(value: unknown): boolean {
  if (!record(value)
    || !identifier(value.id)
    || !delegatedAgentKinds.has(String(value.kind))
    || !Number.isSafeInteger(value.turn) || (value.turn as number) < 0
    || !["running", "completed", "failed"].includes(String(value.status))
    || !Array.isArray(value.activity)) return false;
  if (value.request !== undefined && (typeof value.request !== "string" || value.request.length > 8 * 1024)) return false;
  if (value.response !== undefined && (typeof value.response !== "string" || value.response.length > MAX_MESSAGE_LENGTH)) return false;
  if (value.agentName !== undefined && !boundedString(value.agentName, 24)) return false;
  if (value.startedAt !== undefined && (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt)))) return false;
  if (value.modelName !== undefined && (typeof value.modelName !== "string" || value.modelName.length > 200)) return false;
  if (value.thinkingLevel !== undefined && !thinkingLevels.has(String(value.thinkingLevel))) return false;
  const spawned = value.kind === "spawn_agent" || value.kind === "spawn_session";
  if (spawned !== spawnExecutionActions.has(String(value.action))) return false;
  if (value.action === "adopt" && value.kind !== "spawn_session") return false;
  if (value.threadId !== undefined && (!spawned || !identifier(value.threadId))) return false;
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs)
    || (value.durationMs as number) < 0 || (value.durationMs as number) > 7 * 24 * 60 * 60 * 1_000)) return false;
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!record(usage) || !["input", "output", "cacheRead", "cacheWrite", "cost"]
      .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key] as number)
        && (usage[key] as number) >= 0)) return false;
  }
  return value.activity.every((item) => record(item)
    && (item.id === undefined || identifier(item.id))
    && ["call", "result"].includes(String(item.kind))
    && boundedString(item.tool, 200)
    && (item.text === undefined || typeof item.text === "string" && item.text.length <= 2_000)
    && (item.isError === undefined || typeof item.isError === "boolean"));
}

function validCompactionMessage(value: unknown): boolean {
  return record(value)
    && Number.isSafeInteger(value.contextAfterTokens) && (value.contextAfterTokens as number) >= 0
    && (value.sourceEntryCount === undefined
      || Number.isSafeInteger(value.sourceEntryCount) && (value.sourceEntryCount as number) >= 0);
}

function validHistoryMessage(message: unknown): boolean {
  return record(message)
    && identifier(message.id)
    && (message.entryId === undefined || identifier(message.entryId))
    && ["user", "assistant", "system", "tool"].includes(String(message.role))
    && typeof message.text === "string" && message.text.length <= MAX_MESSAGE_LENGTH
    && message.streaming === false
    && (message.attachmentCount === undefined || Number.isSafeInteger(message.attachmentCount)
      && (message.attachmentCount as number) >= 0 && (message.attachmentCount as number) <= MAX_IMAGES)
    && (message.fileAttachmentCount === undefined || Number.isSafeInteger(message.fileAttachmentCount)
      && (message.fileAttachmentCount as number) >= 0 && (message.fileAttachmentCount as number) <= MAX_TEXT_FILES)
    && (message.systemSource === undefined || typeof message.systemSource === "string" && message.systemSource.length <= 200)
    && (message.compaction === undefined || validCompactionMessage(message.compaction))
    && (message.tool === undefined || record(message.tool)
      && identifier(message.tool.id)
      && boundedString(message.tool.name)
      && (message.tool.input === undefined || typeof message.tool.input === "string" && message.tool.input.length <= MAX_MESSAGE_LENGTH)
      && ["running", "completed", "failed"].includes(String(message.tool.status)));
}

export function isConversationHistoryPage(value: unknown): value is ConversationHistoryPage {
  return record(value)
    && value.protocolVersion === PROTOCOL_VERSION
    && identifier(value.sessionId)
    && generation(value.sessionGeneration)
    && Array.isArray(value.messages) && value.messages.length <= 100 && value.messages.every(validHistoryMessage)
    && Number.isSafeInteger(value.remaining) && (value.remaining as number) >= 0
    && (value.nextCursor === undefined || identifier(value.nextCursor))
    && (value.earlierCursor === undefined || identifier(value.earlierCursor))
    && (value.laterCursor === undefined || identifier(value.laterCursor))
    && (value.atStart === undefined || typeof value.atStart === "boolean")
    && (value.atEnd === undefined || typeof value.atEnd === "boolean");
}

export function isConversationTurnIndexPage(value: unknown): value is ConversationTurnIndexPage {
  return record(value)
    && value.protocolVersion === PROTOCOL_VERSION
    && identifier(value.sessionId)
    && generation(value.sessionGeneration)
    && Number.isSafeInteger(value.totalCount) && (value.totalCount as number) >= 0
    && (value.earlierCursor === undefined || identifier(value.earlierCursor))
    && (value.laterCursor === undefined || identifier(value.laterCursor))
    && Array.isArray(value.turns) && value.turns.length <= 250
    && value.turns.every((turn) => record(turn)
      && identifier(turn.promptId)
      && boundedString(turn.preview, 120)
      && identifier(turn.cursor)
      && (turn.createdAt === undefined || typeof turn.createdAt === "string" && !Number.isNaN(Date.parse(turn.createdAt))));
}

export function isFileSuggestionList(value: unknown): value is FileSuggestionList {
  return record(value)
    && value.protocolVersion === PROTOCOL_VERSION
    && generation(value.sessionGeneration)
    && typeof value.available === "boolean"
    && Array.isArray(value.paths)
    && value.paths.length <= 20
    && value.paths.every((path) => typeof path === "string"
      && path.length > 0 && path.length <= 500
      && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\\") && !path.includes("\0")
      && !path.split("/").some((part) => part === "" || part === "." || part === ".."));
}

export function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!identifier(value.sessionId) || !generation(value.sessionGeneration) || typeof value.ready !== "boolean") return false;
  if (typeof value.cwdLabel !== "string" || !Array.isArray(value.activeTools) || !Array.isArray(value.availableTools)) return false;
  if (value.projectAvailable !== undefined && typeof value.projectAvailable !== "boolean") return false;
  if (value.sessionName !== undefined && (typeof value.sessionName !== "string" || value.sessionName.length > 200)) return false;
  if (value.gitBranch !== undefined && (typeof value.gitBranch !== "string" || value.gitBranch.length > 200)) return false;
  if (value.workspace !== undefined) {
    if (!record(value.workspace)
      || typeof value.workspace.gitAvailable !== "boolean"
      || !["worktree", "checkout", "local", "non-git"].includes(String(value.workspace.mode))
      || !Number.isSafeInteger(value.workspace.changedCount) || (value.workspace.changedCount as number) < 0
      || typeof value.workspace.canMoveToCheckout !== "boolean"
      || typeof value.workspace.canMoveToWorktree !== "boolean"
      || typeof value.workspace.canApplyChanges !== "boolean"
      || (value.workspace.revision !== undefined && !boundedString(value.workspace.revision, 128))
      || (value.workspace.setupState !== undefined && !["idle", "running", "failed"].includes(String(value.workspace.setupState)))
      || (value.workspace.setupError !== undefined && !boundedString(value.workspace.setupError, 500))
      || (value.workspace.checkoutOwner !== undefined && !identifier(value.workspace.checkoutOwner))
      || (value.workspace.handoffUnavailableReason !== undefined && !boundedString(value.workspace.handoffUnavailableReason, 500))
      || (value.workspace.applyTargetBranch !== undefined && !boundedString(value.workspace.applyTargetBranch, 200))
      || (value.workspace.applyTargetChangedCount !== undefined
        && (!Number.isSafeInteger(value.workspace.applyTargetChangedCount) || (value.workspace.applyTargetChangedCount as number) < 0))
      || (value.workspace.applyUnavailableReason !== undefined && !boundedString(value.workspace.applyUnavailableReason, 500))
      || (value.workspace.applyState !== undefined && !["pending", "applying"].includes(String(value.workspace.applyState)))
      || (value.workspace.lastApply !== undefined && (!record(value.workspace.lastApply)
        || !["applied", "unchanged", "conflict", "error"].includes(String(value.workspace.lastApply.state))
        || (value.workspace.lastApply.targetBranch !== undefined && !boundedString(value.workspace.lastApply.targetBranch, 200))
        || (value.workspace.lastApply.message !== undefined && !boundedString(value.workspace.lastApply.message, 500))
        || (value.workspace.lastApply.conflicts !== undefined && (!Array.isArray(value.workspace.lastApply.conflicts)
          || value.workspace.lastApply.conflicts.length > 100
          || !value.workspace.lastApply.conflicts.every((path) => boundedString(path, 500))))))) return false;
  }
  const policy = value.runtimePolicy;
  if (!record(policy) || !Number.isSafeInteger(policy.revision) || (policy.revision as number) < 0
    || !record(policy.global)
    || typeof policy.global.timelineEnabled !== "boolean"
    || typeof policy.global.guardEnabled !== "boolean"
    || !["checkout", "worktree", "local"].includes(String(policy.global.workspace))
    || !validDialogTimeout(policy.global.guardTimeoutSeconds)
    || !validDialogTimeout(policy.global.clarifyTimeoutSeconds)
    || (policy.global.toolOverrides !== undefined && !validToolOverrides(policy.global.toolOverrides))
    || !record(policy.project) || !validVerifyPolicy(policy.project.verify)
    || (policy.project.toolOverrides !== undefined && !validToolOverrides(policy.project.toolOverrides))
    || (policy.project.timelineEnabled !== undefined && typeof policy.project.timelineEnabled !== "boolean")
    || (policy.project.guardEnabled !== undefined && typeof policy.project.guardEnabled !== "boolean")
    || (policy.project.workspace !== undefined && !["checkout", "worktree", "local"].includes(String(policy.project.workspace)))
    || (policy.project.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.guardTimeoutSeconds))
    || (policy.project.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.clarifyTimeoutSeconds))
    || !record(policy.session)
    || (policy.session.toolOverrides !== undefined && !validToolOverrides(policy.session.toolOverrides))
    || (policy.session.verify !== undefined && !validVerifyPolicy(policy.session.verify))
    || (policy.session.timelineEnabled !== undefined && typeof policy.session.timelineEnabled !== "boolean")
    || (policy.session.guardEnabled !== undefined && typeof policy.session.guardEnabled !== "boolean")
    || (policy.session.workspace !== undefined && !["checkout", "worktree", "local"].includes(String(policy.session.workspace)))
    || (policy.session.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.guardTimeoutSeconds))
    || (policy.session.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.clarifyTimeoutSeconds))
    || !record(policy.effective) || !validVerifyPolicy(policy.effective.verify)
    || typeof policy.effective.timelineEnabled !== "boolean"
    || typeof policy.effective.guardEnabled !== "boolean"
    || (policy.effective.toolOverrides !== undefined && !validToolOverrides(policy.effective.toolOverrides))
    || !["checkout", "worktree", "local"].includes(String(policy.effective.workspace))
    || !validDialogTimeout(policy.effective.guardTimeoutSeconds)
    || !validDialogTimeout(policy.effective.clarifyTimeoutSeconds)
    || !Array.isArray(policy.availableVerifyChecks) || policy.availableVerifyChecks.length > 100
    || !policy.availableVerifyChecks.every((check) => record(check)
      && boundedString(check.id, 100)
      && boundedString(check.label, 200)
      && boundedString(check.command, 500))) return false;
  if (value.providerAuth !== undefined) {
    const auth = value.providerAuth;
    if (!record(auth) || !Array.isArray(auth.providers) || auth.providers.length > 200
      || !auth.providers.every((provider) => record(provider)
        && boundedString(provider.id, 200) && boundedString(provider.name, 200)
        && typeof provider.configured === "boolean" && typeof provider.stored === "boolean"
        && (provider.credentialType === undefined || provider.credentialType === "api_key" || provider.credentialType === "oauth")
        && Array.isArray(provider.methods) && provider.methods.length <= 2
        && provider.methods.every((method) => record(method)
          && (method.type === "api_key" || method.type === "oauth")
          && boundedString(method.name, 200) && typeof method.interactive === "boolean"))) return false;
    if (auth.flow !== undefined) {
      const flow = auth.flow;
      if (!record(flow) || !identifier(flow.id)
        || !boundedString(flow.providerId, 200) || !boundedString(flow.providerName, 200)
        || !["api_key", "oauth"].includes(String(flow.authType))
        || !["running", "succeeded", "failed", "cancelled"].includes(String(flow.status))
        || (flow.message !== undefined && !boundedString(flow.message, 2_000))
        || (flow.authUrl !== undefined && !boundedString(flow.authUrl, 8_000))
        || (flow.instructions !== undefined && !boundedString(flow.instructions, 2_000))) return false;
    }
  }
  if (value.commandResult !== undefined && (!record(value.commandResult)
    || !identifier(value.commandResult.id)
    || !boundedString(value.commandResult.command, 120)
    || typeof value.commandResult.output !== "string" || value.commandResult.output.length > 8_000
    || !["info", "warning", "error"].includes(String(value.commandResult.severity))
    || typeof value.commandResult.occurredAt !== "string" || Number.isNaN(Date.parse(value.commandResult.occurredAt)))) return false;
  if (!value.activeTools.every((item) => typeof item === "string") || !value.availableTools.every((item) => typeof item === "string")) return false;
  if (!record(value.optionalCapabilities) || !Object.values(value.optionalCapabilities).every((item) => item === "available" || item === "unavailable")) return false;
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => record(item)
    && ["info", "warning", "error"].includes(item.level as string)
    && typeof item.message === "string")) return false;
  const conversation = value.conversation;
  if (!record(conversation) || !Array.isArray(conversation.messages) || !Array.isArray(conversation.tools)
    || !Array.isArray(conversation.delegatedRuns)
    || typeof conversation.streaming !== "boolean" || !record(conversation.queue) || !record(conversation.retry) || !record(conversation.compaction)) return false;
  if (conversation.workStartedAt !== undefined
    && (typeof conversation.workStartedAt !== "string" || Number.isNaN(Date.parse(conversation.workStartedAt)))) return false;
  if (conversation.workModelName !== undefined && (typeof conversation.workModelName !== "string" || conversation.workModelName.length > 200)) return false;
  if (conversation.workThinkingLevel !== undefined && !thinkingLevels.has(String(conversation.workThinkingLevel))) return false;
  if (conversation.stopping !== undefined && typeof conversation.stopping !== "boolean") return false;
  if (conversation.agentError !== undefined && !boundedString(conversation.agentError, 1_000)) return false;
  if (conversation.stoppedRun !== undefined) {
    const stopped = conversation.stoppedRun;
    if (!record(stopped) || !identifier(stopped.turnId)
      || (stopped.userEntryId !== undefined && !identifier(stopped.userEntryId))
      || !Number.isSafeInteger(stopped.durationMs) || (stopped.durationMs as number) < 0
      || (stopped.durationMs as number) > 7 * 24 * 60 * 60 * 1_000
      || (stopped.modelName !== undefined && !boundedString(stopped.modelName, 200))
      || (stopped.thinkingLevel !== undefined && !thinkingLevels.has(String(stopped.thinkingLevel)))) return false;
  }
  if (conversation.historyCursor !== undefined && !identifier(conversation.historyCursor)) return false;
  if (conversation.historyRemaining !== undefined
    && (!Number.isSafeInteger(conversation.historyRemaining) || (conversation.historyRemaining as number) < 0)) return false;
  if ((conversation.historyCursor === undefined) !== (conversation.historyRemaining === undefined)) return false;
  if (conversation.tools.length > 100 || conversation.delegatedRuns.length > 100) return false;
  if (!conversation.messages.every((message) => record(message) && identifier(message.id)
    && (message.entryId === undefined || identifier(message.entryId))
    && ["user", "assistant", "system", "tool"].includes(message.role as string)
    && typeof message.text === "string" && message.text.length <= MAX_MESSAGE_LENGTH && typeof message.streaming === "boolean"
    && (message.createdAt === undefined || typeof message.createdAt === "string" && !Number.isNaN(Date.parse(message.createdAt)))
    && (message.canUndo === undefined || typeof message.canUndo === "boolean")
    && (message.canForkWithTimeline === undefined || typeof message.canForkWithTimeline === "boolean")
    && (message.attachmentCount === undefined || Number.isSafeInteger(message.attachmentCount) && (message.attachmentCount as number) >= 0 && (message.attachmentCount as number) <= MAX_IMAGES)
    && (message.fileAttachmentCount === undefined || Number.isSafeInteger(message.fileAttachmentCount) && (message.fileAttachmentCount as number) >= 0 && (message.fileAttachmentCount as number) <= MAX_TEXT_FILES)
    && (message.workDurationMs === undefined || Number.isSafeInteger(message.workDurationMs)
      && (message.workDurationMs as number) >= 0 && (message.workDurationMs as number) <= 7 * 24 * 60 * 60 * 1_000)
    && (message.modelName === undefined || typeof message.modelName === "string" && message.modelName.length <= 200)
    && (message.thinkingLevel === undefined || thinkingLevels.has(String(message.thinkingLevel)))
    && (message.changedFiles === undefined || Array.isArray(message.changedFiles) && message.changedFiles.length <= 100
      && message.changedFiles.every((file) => record(file)
        && typeof file.path === "string" && file.path.length > 0 && file.path.length <= 500
        && (file.binary === true || Number.isSafeInteger(file.additions) && (file.additions as number) >= 0
          && Number.isSafeInteger(file.deletions) && (file.deletions as number) >= 0)))
    && (message.systemSource === undefined || typeof message.systemSource === "string" && message.systemSource.length <= 200)
    && (message.compaction === undefined || validCompactionMessage(message.compaction))
    && (message.tool === undefined || record(message.tool)
      && identifier(message.tool.id)
      && boundedString(message.tool.name)
      && (message.tool.input === undefined || typeof message.tool.input === "string" && message.tool.input.length <= MAX_MESSAGE_LENGTH)
      && ["running", "completed", "failed"].includes(String(message.tool.status))))) return false;
  if (!conversation.tools.every((tool) => record(tool) && identifier(tool.id) && typeof tool.name === "string"
    && (tool.input === undefined || typeof tool.input === "string" && tool.input.length <= MAX_MESSAGE_LENGTH)
    && (tool.summary === undefined || typeof tool.summary === "string" && tool.summary.length <= MAX_MESSAGE_LENGTH)
    && ["running", "completed", "failed"].includes(tool.status as string))) return false;
  if (!conversation.delegatedRuns.every((run) => validDelegatedRun(run))) return false;
  if (!Number.isSafeInteger(conversation.queue.steering) || !Number.isSafeInteger(conversation.queue.followUp)
    || typeof conversation.retry.active !== "boolean" || typeof conversation.compaction.active !== "boolean") return false;
  if (conversation.queue.items !== undefined && (!Array.isArray(conversation.queue.items)
    || conversation.queue.items.length > 100 || !conversation.queue.items.every((item) => record(item) && identifier(item.id)
      && identifier(item.commandId)
      && typeof item.preview === "string" && item.preview.length <= 2_000
      && Number.isSafeInteger(item.attachmentCount) && (item.attachmentCount as number) >= 0
      && (item.attachmentCount as number) <= MAX_IMAGES
      && Number.isSafeInteger(item.fileAttachmentCount) && (item.fileAttachmentCount as number) >= 0
      && (item.fileAttachmentCount as number) <= MAX_TEXT_FILES
      && typeof item.planMode === "boolean"
      && ["queued", "delivering"].includes(String(item.state))))) return false;
  const controls = value.sessionControls;
  if (!record(controls) || !Array.isArray(controls.models) || controls.models.length > 500
    || !Array.isArray(controls.thinkingLevels) || !controls.thinkingLevels.every((level) => thinkingLevels.has(String(level)))
    || (controls.thinkingLevel !== undefined && !thinkingLevels.has(String(controls.thinkingLevel)))) return false;
  if (controls.commands !== undefined && (!Array.isArray(controls.commands) || controls.commands.length > 200
    || !controls.commands.every((command) => record(command)
      && boundedString(command.name, 120)
      && (command.description === undefined || typeof command.description === "string" && command.description.length <= 300)
      && ["extension", "prompt", "skill"].includes(String(command.source))))) return false;
  const model = (value: unknown) => record(value) && boundedString(value.provider) && boundedString(value.id) && boundedString(value.name)
    && (value.thinkingLevels === undefined || Array.isArray(value.thinkingLevels)
      && value.thinkingLevels.length <= 7
      && value.thinkingLevels.every((level) => thinkingLevels.has(String(level))));
  if (!controls.models.every(model) || controls.model !== undefined && !model(controls.model)) return false;
  if (controls.pending !== undefined && (!record(controls.pending)
    || !model(controls.pending.model)
    || !thinkingLevels.has(String(controls.pending.thinkingLevel)))) return false;
  const metrics = value.metrics;
  if (!record(metrics) || typeof metrics.model !== "string" || typeof metrics.provider !== "string"
    || !["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "contextTokens", "contextLimit", "contextPercent", "cost", "userMessages", "assistantMessages", "toolCalls"]
      .every((key) => typeof metrics[key] === "number" && Number.isFinite(metrics[key] as number))
    || (metrics.toolUsage !== undefined && (!Array.isArray(metrics.toolUsage) || metrics.toolUsage.length > 200
      || !metrics.toolUsage.every((item) => record(item) && boundedString(item.name) && item.name.length > 0
        && Number.isSafeInteger(item.calls) && (item.calls as number) >= 0
        && Number.isSafeInteger(item.inputTokens) && (item.inputTokens as number) >= 0
        && Number.isSafeInteger(item.outputTokens) && (item.outputTokens as number) >= 0
        && Number.isSafeInteger(item.tokens) && item.tokens === (item.inputTokens as number) + (item.outputTokens as number))))) return false;
  if (value.discoverIndex !== undefined) {
    const index = value.discoverIndex;
    if (!record(index) || !["idle", "indexing", "error"].includes(String(index.state))
      || (index.files !== undefined && (!Number.isSafeInteger(index.files) || (index.files as number) < 0))
      || (index.symbols !== undefined && (!Number.isSafeInteger(index.symbols) || (index.symbols as number) < 0))
      || (index.indexedAt !== undefined && (typeof index.indexedAt !== "string" || Number.isNaN(Date.parse(index.indexedAt))))
      || (index.error !== undefined && (typeof index.error !== "string" || index.error.length > 500))) return false;
  }
  const operational = value.operational;
  if (!record(operational) || !record(operational.verification) || !record(operational.jobs) || !record(operational.guard)
    || !record(operational.continuity) || !record(operational.timeline) || !record(operational.tools)
    || !record(operational.sieve) || !record(operational.health)) return false;
  const available = (feature: Record<string, unknown>) => feature.availability === "available" || feature.availability === "unavailable";
  if (!available(operational.verification) || !Array.isArray(operational.verification.checks) || operational.verification.checks.length > 20
    || !available(operational.jobs) || !Array.isArray(operational.jobs.items) || operational.jobs.items.length > 50
    || !available(operational.guard) || typeof operational.guard.blocked !== "number" || typeof operational.guard.confirmed !== "number"
    || !available(operational.continuity) || !Number.isSafeInteger(operational.continuity.revision)
    || !available(operational.timeline) || !Number.isSafeInteger(operational.timeline.revision) || !Array.isArray(operational.timeline.checkpoints) || operational.timeline.checkpoints.length > 100
    || !available(operational.tools) || !Array.isArray(operational.tools.policies) || operational.tools.policies.length > 100
    || !available(operational.sieve)
    || !["healthy", "degraded", "unavailable"].includes(String(operational.health.status)) || !Array.isArray(operational.health.issues) || operational.health.issues.length > 20) return false;
  if (operational.sieve.availability === "available") {
    const stats = (value: unknown) => {
      if (!record(value) || !record(value.transformedBy) || !record(value.byTool)
        || Object.keys(value.byTool).length > 33) return false;
      const transformedBy = value.transformedBy;
      const toolStats = Object.entries(value.byTool).every(([name, usage]) => record(usage)
        && /^[a-zA-Z0-9_-]{1,64}$/.test(name)
        && ["scanned", "transformed", "sourceChars", "retainedChars", "netCharsSaved"].every((key) =>
          Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0));
      return toolStats && ["scanned", "transformed", "omittedChars", "netCharsSaved"].every((key) =>
        Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
        && ["ageThreshold", "budget", "giantError", "activeThreshold", "staleRead", "duplicate", "errorCap", "mixedText"].every((key) =>
          Number.isSafeInteger(transformedBy[key]) && (transformedBy[key] as number) >= 0);
    };
    if (!["enabled", "observe", "disabled"].includes(String(operational.sieve.mode))
      || !["stable", "legacy", "standard-v2"].includes(String(operational.sieve.projectionMode))
      || !Number.isSafeInteger(operational.sieve.threshold) || (operational.sieve.threshold as number) < 1_000
      || typeof operational.sieve.activePruning !== "boolean"
      || !["enabled", "observe"].includes(String(operational.sieve.latestMode))
      || !stats(operational.sieve.latest)
      || !stats(operational.sieve.cumulativeActual)
      || !stats(operational.sieve.cumulativeProjected)
      || !Number.isSafeInteger(operational.sieve.recalls) || (operational.sieve.recalls as number) < 0
      || !Number.isSafeInteger(operational.sieve.recalledChars) || (operational.sieve.recalledChars as number) < 0
      || !record(operational.sieve.recallsByTool) || Object.keys(operational.sieve.recallsByTool).length > 33
      || !Object.entries(operational.sieve.recallsByTool).every(([name, usage]) => record(usage)
        && /^[a-zA-Z0-9_-]{1,64}$/.test(name)
        && Number.isSafeInteger(usage.recalls) && (usage.recalls as number) >= 0
        && Number.isSafeInteger(usage.recalledChars) && (usage.recalledChars as number) >= 0)
      || typeof operational.sieve.updatedAt !== "string" || Number.isNaN(Date.parse(operational.sieve.updatedAt))
      || (operational.sieve.error !== undefined && !boundedString(operational.sieve.error, 500))) return false;
    const metrics = (value: Record<string, unknown> | undefined, keys: string[]) => value !== undefined
      && keys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
    const rawEpoch = operational.sieve.epoch;
    const epoch = record(rawEpoch) ? rawEpoch : undefined;
    if (operational.sieve.epoch !== undefined && (!metrics(epoch, ["frozenResultCount", "frozenSourceChars", "frozenRetainedChars", "rolloverEligibleRetainedChars", "recoverableEntries"])
      || !["id", "reason", "promptFingerprint"].every((key) => epoch![key] === undefined || boundedString(epoch![key], 200))
      || epoch!.startedAt !== undefined && (typeof epoch!.startedAt !== "string" || Number.isNaN(Date.parse(epoch!.startedAt))))) return false;
    const rawStability = operational.sieve.stability;
    const stability = record(rawStability) ? rawStability : undefined;
    const standardChangesByKind = record(stability?.standardChangesByKind)
      ? stability.standardChangesByKind
      : undefined;
    if (operational.sieve.stability !== undefined && (!metrics(stability, ["newProjections", "projectionCacheHits", "recoverableEntries", "explicitReflows", "softBudgetExceedances", "prefixChurnViolations", "estimatedInvalidatedChars"])
      || stability!.earliestChangedPriorMessageIndex !== undefined && (!Number.isSafeInteger(stability!.earliestChangedPriorMessageIndex) || (stability!.earliestChangedPriorMessageIndex as number) < 0)
      || stability!.standardComparisons !== undefined && (!Number.isSafeInteger(stability!.standardComparisons) || (stability!.standardComparisons as number) < 0)
      || stability!.standardPrefixChurn !== undefined && (!Number.isSafeInteger(stability!.standardPrefixChurn) || (stability!.standardPrefixChurn as number) < 0)
      || stability!.standardEarliestChangedPriorMessageIndex !== undefined && (!Number.isSafeInteger(stability!.standardEarliestChangedPriorMessageIndex) || (stability!.standardEarliestChangedPriorMessageIndex as number) < 0)
      || stability!.standardEstimatedInvalidatedChars !== undefined && (!Number.isSafeInteger(stability!.standardEstimatedInvalidatedChars) || (stability!.standardEstimatedInvalidatedChars as number) < 0)
      || stability!.standardChangesByKind !== undefined && (!standardChangesByKind
        || !["activeThreshold", "ageThreshold", "budget", "staleRead", "duplicate", "errorCap", "history"].every((key) =>
          Number.isSafeInteger(standardChangesByKind[key]) && (standardChangesByKind[key] as number) >= 0)))) return false;
    if (operational.sieve.contextUsagePercent !== undefined && (typeof operational.sieve.contextUsagePercent !== "number" || !Number.isFinite(operational.sieve.contextUsagePercent) || operational.sieve.contextUsagePercent < 0 || operational.sieve.contextUsagePercent > 100)) return false;
  }
  const safeMemoryPath = (path: unknown) => typeof path === "string" && path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.startsWith("\\") && !/^[a-z]:/i.test(path) && !path.split(/[\\/]+/).some((part) => !part || part === "." || part === "..");
  const validMemoryNote = (note: unknown, expectedScope: "user" | "project") => record(note)
    && typeof note.id === "string" && note.id.length <= MAX_ID_LENGTH && memoryNoteId.test(note.id)
    && note.scope === expectedScope
    && typeof note.trigger === "string" && note.trigger.length >= 1 && note.trigger.length <= 240 && note.trigger === note.trigger.trim()
    && typeof note.guidance === "string" && note.guidance.length >= 1 && note.guidance.length <= 800 && note.guidance === note.guidance.trim()
    && note.trigger.length + note.guidance.length <= 1_000
    && memoryAuthorities.has(String(note.authority)) && memoryOrigins.has(String(note.origin))
    && (note.relatedPaths === undefined || Array.isArray(note.relatedPaths) && note.relatedPaths.length <= 5 && note.relatedPaths.every(safeMemoryPath))
    && Number.isSafeInteger(note.revision) && (note.revision as number) >= 1
    && typeof note.updatedAt === "string" && !Number.isNaN(Date.parse(note.updatedAt))
    && typeof note.sourceSummary === "string" && note.sourceSummary.length <= 500;
  if (operational.continuity.availability === "available") {
    if (!Array.isArray(operational.continuity.memory) || operational.continuity.memory.length > 1_000 || !operational.continuity.memory.every((note) => validMemoryNote(note, "project"))
      || !Array.isArray(operational.continuity.globalMemory) || operational.continuity.globalMemory.length > 1_000 || !operational.continuity.globalMemory.every((note) => validMemoryNote(note, "user"))) return false;
  }
  const extensionUi = value.extensionUi;
  return record(extensionUi)
    && Array.isArray(extensionUi.notifications) && extensionUi.notifications.length <= 10
    && extensionUi.notifications.every((item) => record(item) && identifier(item.id) && typeof item.message === "string"
      && ["info", "warning", "error"].includes(item.type as string) && typeof item.occurredAt === "string")
    && Array.isArray(extensionUi.statuses) && extensionUi.statuses.length <= 25
    && extensionUi.statuses.every((item) => record(item) && identifier(item.key) && typeof item.text === "string")
    && Array.isArray(extensionUi.widgets) && extensionUi.widgets.length <= 10
    && extensionUi.widgets.every((item) => record(item) && identifier(item.key) && Array.isArray(item.lines)
      && item.lines.length <= 40 && item.lines.every((line) => typeof line === "string" && line.length <= 500))
    && (extensionUi.title === undefined || typeof extensionUi.title === "string")
    && typeof extensionUi.editorText === "string" && extensionUi.editorText.length <= MAX_MESSAGE_LENGTH
    && Number.isSafeInteger(extensionUi.editorRevision) && (extensionUi.editorRevision as number) >= 0;
}

function operationalValidationIssue(value: unknown): { area: string; detail: string } | undefined {
  const issue = (area: string, detail: string) => ({ area: `operational.${area}`, detail });
  if (!record(value)) return issue("data", "must be an object");
  const names = ["verification", "jobs", "guard", "continuity", "timeline", "tools", "sieve", "health"] as const;
  for (const name of names) if (!record(value[name])) return issue(name, "must be an object");
  const operational = value as Record<typeof names[number], Record<string, unknown>>;
  const available = (feature: Record<string, unknown>) => feature.availability === "available" || feature.availability === "unavailable";
  for (const name of names.slice(0, -1)) if (!available(operational[name])) return issue(`${name}.availability`, "must be available or unavailable");
  if (!Array.isArray(operational.verification.checks) || operational.verification.checks.length > 20) return issue("verification.checks", "must be an array with at most 20 items");
  if (!Array.isArray(operational.jobs.items) || operational.jobs.items.length > 50) return issue("jobs.items", "must be an array with at most 50 items");
  for (const key of ["blocked", "confirmed"] as const) if (typeof operational.guard[key] !== "number") return issue(`guard.${key}`, "must be a number");
  if (!Number.isSafeInteger(operational.continuity.revision)) return issue("continuity.revision", "must be a safe integer");
  if (!Number.isSafeInteger(operational.timeline.revision)) return issue("timeline.revision", "must be a safe integer");
  if (!Array.isArray(operational.timeline.checkpoints) || operational.timeline.checkpoints.length > 100) return issue("timeline.checkpoints", "must be an array with at most 100 items");
  if (!Array.isArray(operational.tools.policies) || operational.tools.policies.length > 100) return issue("tools.policies", "must be an array with at most 100 items");
  if (!["healthy", "degraded", "unavailable"].includes(String(operational.health.status))) return issue("health.status", "must be healthy, degraded, or unavailable");
  if (!Array.isArray(operational.health.issues) || operational.health.issues.length > 20) return issue("health.issues", "must be an array with at most 20 items");

  if (operational.sieve.availability === "available") {
    const sieve = operational.sieve;
    if (!["enabled", "observe", "disabled"].includes(String(sieve.mode))) return issue("sieve.mode", "is invalid");
    if (!["stable", "legacy", "standard-v2"].includes(String(sieve.projectionMode))) return issue("sieve.projectionMode", "is invalid");
    if (!Number.isSafeInteger(sieve.threshold) || (sieve.threshold as number) < 1_000) return issue("sieve.threshold", "must be a safe integer of at least 1000");
    if (typeof sieve.activePruning !== "boolean") return issue("sieve.activePruning", "must be boolean");
    if (!["enabled", "observe"].includes(String(sieve.latestMode))) return issue("sieve.latestMode", "is invalid");
    const statsIssue = (raw: unknown, path: string) => {
      if (!record(raw)) return issue(path, "must be an object");
      if (!record(raw.transformedBy)) return issue(`${path}.transformedBy`, "must be an object");
      if (!record(raw.byTool)) return issue(`${path}.byTool`, "must be an object");
      if (Object.keys(raw.byTool).length > 33) return issue(`${path}.byTool`, "must contain at most 33 tools");
      for (const key of ["scanned", "transformed", "omittedChars", "netCharsSaved"] as const) {
        if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) return issue(`${path}.${key}`, "must be a non-negative safe integer");
      }
      for (const key of ["ageThreshold", "budget", "giantError", "activeThreshold", "staleRead", "duplicate", "errorCap", "mixedText"] as const) {
        if (!Number.isSafeInteger(raw.transformedBy[key]) || (raw.transformedBy[key] as number) < 0) return issue(`${path}.transformedBy.${key}`, "must be a non-negative safe integer");
      }
      for (const [name, usage] of Object.entries(raw.byTool)) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return issue(`${path}.byTool`, "contains an invalid tool name");
        if (!record(usage)) return issue(`${path}.byTool.${name}`, "must be an object");
        for (const key of ["scanned", "transformed", "sourceChars", "retainedChars", "netCharsSaved"] as const) {
          if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) return issue(`${path}.byTool.${name}.${key}`, "must be a non-negative safe integer");
        }
      }
      return undefined;
    };
    for (const key of ["latest", "cumulativeActual", "cumulativeProjected"] as const) {
      const invalid = statsIssue(sieve[key], `sieve.${key}`);
      if (invalid) return invalid;
    }
    for (const key of ["recalls", "recalledChars"] as const) if (!Number.isSafeInteger(sieve[key]) || (sieve[key] as number) < 0) return issue(`sieve.${key}`, "must be a non-negative safe integer");
    if (!record(sieve.recallsByTool)) return issue("sieve.recallsByTool", "must be an object");
    if (Object.keys(sieve.recallsByTool).length > 33) return issue("sieve.recallsByTool", "must contain at most 33 tools");
    for (const [name, usage] of Object.entries(sieve.recallsByTool)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return issue("sieve.recallsByTool", "contains an invalid tool name");
      if (!record(usage)) return issue(`sieve.recallsByTool.${name}`, "must be an object");
      for (const key of ["recalls", "recalledChars"] as const) if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) return issue(`sieve.recallsByTool.${name}.${key}`, "must be a non-negative safe integer");
    }
    if (typeof sieve.updatedAt !== "string" || Number.isNaN(Date.parse(sieve.updatedAt))) return issue("sieve.updatedAt", "must be a valid timestamp");
    if (sieve.error !== undefined && !boundedString(sieve.error, 500)) return issue("sieve.error", "must be a non-empty string of at most 500 characters");
    const metricObjectIssue = (raw: unknown, path: string, keys: string[]) => {
      if (!record(raw)) return issue(path, "must be an object");
      for (const key of keys) if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) return issue(`${path}.${key}`, "must be a non-negative safe integer");
      return undefined;
    };
    if (sieve.epoch !== undefined) {
      const invalid = metricObjectIssue(sieve.epoch, "sieve.epoch", ["frozenResultCount", "frozenSourceChars", "frozenRetainedChars", "rolloverEligibleRetainedChars", "recoverableEntries"]);
      if (invalid) return invalid;
      const epoch = sieve.epoch as Record<string, unknown>;
      for (const key of ["id", "reason", "promptFingerprint"] as const) if (epoch[key] !== undefined && !boundedString(epoch[key], 200)) return issue(`sieve.epoch.${key}`, "must be a non-empty string of at most 200 characters");
      if (epoch.startedAt !== undefined && (typeof epoch.startedAt !== "string" || Number.isNaN(Date.parse(epoch.startedAt)))) return issue("sieve.epoch.startedAt", "must be a valid timestamp");
    }
    if (sieve.stability !== undefined) {
      const invalid = metricObjectIssue(sieve.stability, "sieve.stability", ["newProjections", "projectionCacheHits", "recoverableEntries", "explicitReflows", "softBudgetExceedances", "prefixChurnViolations", "estimatedInvalidatedChars"]);
      if (invalid) return invalid;
      const stability = sieve.stability as Record<string, unknown>;
      for (const key of ["earliestChangedPriorMessageIndex", "standardComparisons", "standardPrefixChurn", "standardEarliestChangedPriorMessageIndex", "standardEstimatedInvalidatedChars"] as const) {
        if (stability[key] !== undefined && (!Number.isSafeInteger(stability[key]) || (stability[key] as number) < 0)) return issue(`sieve.stability.${key}`, "must be a non-negative safe integer");
      }
      if (stability.standardChangesByKind !== undefined) {
        const changes = stability.standardChangesByKind;
        if (!record(changes)) return issue("sieve.stability.standardChangesByKind", "must be an object");
        for (const key of ["activeThreshold", "ageThreshold", "budget", "staleRead", "duplicate", "errorCap", "history"] as const) if (!Number.isSafeInteger(changes[key]) || (changes[key] as number) < 0) return issue(`sieve.stability.standardChangesByKind.${key}`, "must be a non-negative safe integer");
      }
    }
    if (sieve.contextUsagePercent !== undefined && (typeof sieve.contextUsagePercent !== "number" || !Number.isFinite(sieve.contextUsagePercent) || sieve.contextUsagePercent < 0 || sieve.contextUsagePercent > 100)) return issue("sieve.contextUsagePercent", "must be a finite percentage from 0 to 100");
  }

  if (operational.continuity.availability === "available") {
    const safePath = (path: unknown) => typeof path === "string" && path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.startsWith("\\") && !/^[a-z]:/i.test(path) && !path.split(/[\\/]+/).some((part) => !part || part === "." || part === "..");
    const memoryIssue = (raw: unknown, scope: "user" | "project", path: string) => {
      if (!Array.isArray(raw) || raw.length > 1_000) return issue(path, "must be an array with at most 1000 notes");
      for (let index = 0; index < raw.length; index++) {
        const note = raw[index], notePath = `${path}[${index}]`;
        if (!record(note)) return issue(notePath, "must be an object");
        if (typeof note.id !== "string" || note.id.length > MAX_ID_LENGTH || !memoryNoteId.test(note.id)) return issue(`${notePath}.id`, "must be a UUID of at most 128 characters");
        if (note.scope !== scope) return issue(`${notePath}.scope`, `must be ${scope}`);
        if (typeof note.trigger !== "string" || note.trigger.length < 1 || note.trigger.length > 240 || note.trigger !== note.trigger.trim()) return issue(`${notePath}.trigger`, "must be trimmed and contain 1 to 240 characters");
        if (typeof note.guidance !== "string" || note.guidance.length < 1 || note.guidance.length > 800 || note.guidance !== note.guidance.trim()) return issue(`${notePath}.guidance`, "must be trimmed and contain 1 to 800 characters");
        if (note.trigger.length + note.guidance.length > 1_000) return issue(notePath, "trigger and guidance must total at most 1000 characters");
        if (!memoryAuthorities.has(String(note.authority))) return issue(`${notePath}.authority`, "is invalid");
        if (!memoryOrigins.has(String(note.origin))) return issue(`${notePath}.origin`, "is invalid");
        if (note.relatedPaths !== undefined && (!Array.isArray(note.relatedPaths) || note.relatedPaths.length > 5 || !note.relatedPaths.every(safePath))) return issue(`${notePath}.relatedPaths`, "must contain at most 5 safe relative paths");
        if (!Number.isSafeInteger(note.revision) || (note.revision as number) < 1) return issue(`${notePath}.revision`, "must be a positive safe integer");
        if (typeof note.updatedAt !== "string" || Number.isNaN(Date.parse(note.updatedAt))) return issue(`${notePath}.updatedAt`, "must be a valid timestamp");
        if (typeof note.sourceSummary !== "string" || note.sourceSummary.length > 500) return issue(`${notePath}.sourceSummary`, "must be a string of at most 500 characters");
      }
      return undefined;
    };
    const projectIssue = memoryIssue(operational.continuity.memory, "project", "continuity.memory");
    if (projectIssue) return projectIssue;
    return memoryIssue(operational.continuity.globalMemory, "user", "continuity.globalMemory");
  }
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
  const requiredAreas = ["runtimePolicy", "conversation", "sessionControls", "metrics", "operational", "extensionUi"] as const;
  const missing = requiredAreas.find((area) => !record(value[area]));
  if (missing) return { kind: "snapshot", area: missing, detail: "required runtime data is missing" };
  if (!isRuntimeSnapshot(value)) {
    const operationalIssue = operationalValidationIssue(value.operational);
    if (operationalIssue) return { kind: "snapshot", ...operationalIssue };
    const validAreaReplacements: Array<[string, Record<string, unknown>]> = [
      ["workspace", { workspace: undefined }],
      ["runtime policy", {
        runtimePolicy: {
          revision: 0,
          global: { timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 },
          project: { verify: { mode: "auto" } },
          session: {},
          effective: { verify: { mode: "auto" }, timelineEnabled: true, guardEnabled: true, workspace: "local", guardTimeoutSeconds: 60, clarifyTimeoutSeconds: 60 },
          availableVerifyChecks: [],
        },
      }],
      ["capabilities", { activeTools: [], availableTools: [], optionalCapabilities: {}, diagnostics: [] }],
      ["conversation", {
        conversation: {
          messages: [], tools: [], delegatedRuns: [], streaming: false,
          queue: { steering: 0, followUp: 0 }, retry: { active: false }, compaction: { active: false },
        },
      }],
      ["session controls", { sessionControls: { models: [], thinkingLevels: [] } }],
      ["metrics", {
        metrics: {
          model: "", provider: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          contextTokens: 0, contextLimit: 0, contextPercent: 0, cost: 0,
          userMessages: 0, assistantMessages: 0, toolCalls: 0,
        },
      }],
      ["Discover index", { discoverIndex: undefined }],
      ["operational data", {
        operational: {
          verification: { availability: "unavailable", checks: [] },
          jobs: { availability: "unavailable", items: [] },
          guard: { availability: "unavailable", blocked: 0, confirmed: 0 },
          continuity: { availability: "unavailable", revision: 0 },
          timeline: { availability: "unavailable", revision: 0, checkpoints: [] },
          tools: { availability: "unavailable", policies: [] },
          sieve: { availability: "unavailable" },
          health: { status: "unavailable", issues: [] },
        },
      }],
      ["extension UI", {
        extensionUi: { notifications: [], statuses: [], widgets: [], editorText: "", editorRevision: 0 },
      }],
    ];
    const area = validAreaReplacements.find(([, replacement]) => isRuntimeSnapshot({ ...value, ...replacement }))?.[0];
    if (area) return { kind: "snapshot", area, detail: "a field is invalid, oversized, or incomplete" };
    return { kind: "snapshot", area: "runtime data", detail: "a field is invalid, oversized, or incomplete" };
  }
  return undefined;
}

export function describeRuntimeSnapshotIssue(value: unknown, issue = runtimeSnapshotValidationIssue(value)): string | undefined {
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

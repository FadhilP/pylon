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
const memoryKinds = new Set(["workflow", "structure", "architecture", "warning", "preference"]);
const delegatedAgentKinds = new Set(["advisor", "grunt", "repo_scout", "web_scout"]);

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
  if (value.kind === "grunt") {
    return modelMode && model
      && (value.mode !== "model" || boundedString(value.model, 400))
      && ["isolated", "direct", "dynamic"].includes(String(value.executionMode));
  }
  if (value.kind === "continuity") {
    return ["planner", "executor"].every((key) => {
      const profile = value[key];
      return profile === undefined || record(profile)
        && boundedString(profile.model, 400)
        && (profile.thinking === undefined || thinkingLevels.has(String(profile.thinking)));
    });
  }
  if (value.kind === "sieve") {
    return typeof value.activePruning === "boolean"
      && (value.projectionMode === "stable" || value.projectionMode === "legacy")
      && Number.isSafeInteger(value.threshold)
      && (value.threshold as number) >= 1_000
      && (value.threshold as number) <= 50_000;
  }
  if (value.kind === "helios") return typeof value.headed === "boolean";
  return value.kind === "timeline" && typeof value.editRollbackDefault === "boolean";
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
  if (value.type === "updateContinuityMemory" || value.type === "deleteContinuityMemory") {
    if (!boundedString(value.key, 200) || typeof value.expectedUpdatedAt !== "string"
      || Number.isNaN(Date.parse(value.expectedUpdatedAt))) return { ok: false, error: "invalid memory target" };
  }
  if (value.type === "updateContinuityMemory"
    && (!boundedString(value.text, 1_000) || !value.text.trim() || !memoryKinds.has(String(value.kind)))) {
    return { ok: false, error: "invalid memory update" };
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
    || !Array.isArray(value.activity) || value.activity.length > 100) return false;
  if (value.request !== undefined && (typeof value.request !== "string" || value.request.length > 8 * 1024)) return false;
  if (value.response !== undefined && (typeof value.response !== "string" || value.response.length > MAX_MESSAGE_LENGTH)) return false;
  if (value.agentName !== undefined && !boundedString(value.agentName, 24)) return false;
  if (value.startedAt !== undefined && (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt)))) return false;
  if (value.modelName !== undefined && (typeof value.modelName !== "string" || value.modelName.length > 200)) return false;
  if (value.thinkingLevel !== undefined && !thinkingLevels.has(String(value.thinkingLevel))) return false;
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs)
    || (value.durationMs as number) < 0 || (value.durationMs as number) > 7 * 24 * 60 * 60 * 1_000)) return false;
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!record(usage) || !["input", "output", "cacheRead", "cacheWrite", "cost"]
      .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key] as number)
        && (usage[key] as number) >= 0)) return false;
  }
  return value.activity.every((item) => record(item)
    && ["call", "result"].includes(String(item.kind))
    && boundedString(item.tool, 200)
    && (item.text === undefined || typeof item.text === "string" && item.text.length <= 2_000)
    && (item.isError === undefined || typeof item.isError === "boolean"));
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
    || !record(policy.project) || !validVerifyPolicy(policy.project.verify)
    || (policy.project.timelineEnabled !== undefined && typeof policy.project.timelineEnabled !== "boolean")
    || (policy.project.guardEnabled !== undefined && typeof policy.project.guardEnabled !== "boolean")
    || (policy.project.workspace !== undefined && !["checkout", "worktree", "local"].includes(String(policy.project.workspace)))
    || (policy.project.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.guardTimeoutSeconds))
    || (policy.project.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.project.clarifyTimeoutSeconds))
    || !record(policy.session)
    || (policy.session.verify !== undefined && !validVerifyPolicy(policy.session.verify))
    || (policy.session.timelineEnabled !== undefined && typeof policy.session.timelineEnabled !== "boolean")
    || (policy.session.guardEnabled !== undefined && typeof policy.session.guardEnabled !== "boolean")
    || (policy.session.workspace !== undefined && !["checkout", "worktree", "local"].includes(String(policy.session.workspace)))
    || (policy.session.guardTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.guardTimeoutSeconds))
    || (policy.session.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(policy.session.clarifyTimeoutSeconds))
    || !record(policy.effective) || !validVerifyPolicy(policy.effective.verify)
    || typeof policy.effective.timelineEnabled !== "boolean"
    || typeof policy.effective.guardEnabled !== "boolean"
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
  if (conversation.queue.pending !== undefined) {
    const pending = conversation.queue.pending;
    if (!record(pending) || !identifier(pending.id)
      || typeof pending.preview !== "string" || pending.preview.length > 2_000
      || !Number.isSafeInteger(pending.attachmentCount) || (pending.attachmentCount as number) < 0
      || (pending.attachmentCount as number) > MAX_IMAGES
      || !Number.isSafeInteger(pending.fileAttachmentCount) || (pending.fileAttachmentCount as number) < 0
      || (pending.fileAttachmentCount as number) > MAX_TEXT_FILES
      || typeof pending.planMode !== "boolean"
      || !["queued", "delivering"].includes(String(pending.state))) return false;
  }
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
    || !["inputTokens", "outputTokens", "cacheReadTokens", "contextTokens", "contextLimit", "contextPercent", "cost", "userMessages", "assistantMessages", "toolCalls"]
      .every((key) => typeof metrics[key] === "number" && Number.isFinite(metrics[key] as number))) return false;
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
      || !["stable", "legacy"].includes(String(operational.sieve.projectionMode))
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
    if (operational.sieve.epoch !== undefined && (!metrics(epoch, ["frozenResultCount", "frozenSourceChars", "frozenRetainedChars", "recoverableEntries"])
      || !["id", "reason", "promptFingerprint"].every((key) => epoch![key] === undefined || boundedString(epoch![key], 200))
      || epoch!.startedAt !== undefined && (typeof epoch!.startedAt !== "string" || Number.isNaN(Date.parse(epoch!.startedAt))))) return false;
    const rawStability = operational.sieve.stability;
    const stability = record(rawStability) ? rawStability : undefined;
    if (operational.sieve.stability !== undefined && (!metrics(stability, ["newProjections", "projectionCacheHits", "recoverableEntries", "explicitReflows", "softBudgetExceedances", "prefixChurnViolations", "estimatedInvalidatedChars"])
      || stability!.earliestChangedPriorMessageIndex !== undefined && (!Number.isSafeInteger(stability!.earliestChangedPriorMessageIndex) || (stability!.earliestChangedPriorMessageIndex as number) < 0))) return false;
    if (operational.sieve.contextUsagePercent !== undefined && (typeof operational.sieve.contextUsagePercent !== "number" || !Number.isFinite(operational.sieve.contextUsagePercent) || operational.sieve.contextUsagePercent < 0 || operational.sieve.contextUsagePercent > 100)) return false;
  }
  if (operational.continuity.memory !== undefined
    && (!Array.isArray(operational.continuity.memory) || operational.continuity.memory.length > 30
      || !operational.continuity.memory.every((fact) => record(fact)
        && boundedString(fact.key, 200)
        && memoryKinds.has(String(fact.kind))
        && boundedString(fact.text, 1_000)
        && boundedString(fact.source, 500)
        && typeof fact.confidence === "number" && fact.confidence >= 0 && fact.confidence <= 1
        && typeof fact.updatedAt === "string" && !Number.isNaN(Date.parse(fact.updatedAt))))) return false;
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
          model: "", provider: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
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

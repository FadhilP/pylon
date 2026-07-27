import { COMMAND_NAMES, type WebCommand } from "./commands.ts";
import { PROTOCOL_VERSION, type WebEvent } from "./envelope.ts";
import type { ArchiveListSnapshot, ConversationHistoryPage, PackageListSnapshot, PackageSettingsReadModel, RuntimeSnapshot, SessionListSnapshot } from "./snapshots.ts";

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
  if (["switchSession", "deleteSession", "archiveSession", "restoreSession", "renameSession", "setSessionActive"].includes(value.type) && !identifier(value.sessionId)) {
    return { ok: false, error: "invalid sessionId" };
  }
  if (["removeProject", "archiveProject", "restoreProject"].includes(value.type) && !identifier(value.projectId)) {
    return { ok: false, error: "invalid projectId" };
  }
  if (value.type === "renameSession" && (!boundedString(value.name) || !value.name.trim())) {
    return { ok: false, error: "invalid session name" };
  }
  if (value.type === "setSessionActive" && typeof value.active !== "boolean") {
    return { ok: false, error: "invalid session active state" };
  }
  if (value.type === "fork") {
    if (!identifier(value.entryId)) return { ok: false, error: "invalid entryId" };
    if (value.position !== undefined && value.position !== "before" && value.position !== "at") {
      return { ok: false, error: "invalid fork position" };
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

export function isPackageListSnapshot(value: unknown): value is PackageListSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !generation(value.sessionGeneration)
    || !Array.isArray(value.packages) || value.packages.length > 100) return false;
  return value.packages.every((item) => record(item)
    && identifier(item.id)
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 200
    && typeof item.description === "string" && item.description.length <= 500
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
    && Number.isSafeInteger(project.totalCount) && (project.totalCount as number) >= 0
    && (project.nextCursor === undefined || identifier(project.nextCursor))
    && Array.isArray(project.sessions) && project.sessions.length <= 100
    && project.sessions.every((session) => validSessionSummary(session, project.id as string)));
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
    && Number.isSafeInteger(value.userMessageCount) && (value.userMessageCount as number) >= 0
    && typeof value.preview === "string" && value.preview.length <= 500
    && typeof value.active === "boolean"
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
    && (value.nextCursor === undefined || identifier(value.nextCursor));
}

export function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!identifier(value.sessionId) || !generation(value.sessionGeneration) || typeof value.ready !== "boolean") return false;
  if (typeof value.cwdLabel !== "string" || !Array.isArray(value.activeTools) || !Array.isArray(value.availableTools)) return false;
  if (value.projectAvailable !== undefined && typeof value.projectAvailable !== "boolean") return false;
  if (value.sessionName !== undefined && (typeof value.sessionName !== "string" || value.sessionName.length > 200)) return false;
  if (value.gitBranch !== undefined && (typeof value.gitBranch !== "string" || value.gitBranch.length > 200)) return false;
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
  if (conversation.historyCursor !== undefined && !identifier(conversation.historyCursor)) return false;
  if (conversation.historyRemaining !== undefined
    && (!Number.isSafeInteger(conversation.historyRemaining) || (conversation.historyRemaining as number) < 0)) return false;
  if ((conversation.historyCursor === undefined) !== (conversation.historyRemaining === undefined)) return false;
  if (conversation.messages.length > 100 || conversation.tools.length > 100 || conversation.delegatedRuns.length > 100) return false;
  if (!conversation.messages.every((message) => record(message) && identifier(message.id)
    && (message.entryId === undefined || identifier(message.entryId))
    && ["user", "assistant", "system", "tool"].includes(message.role as string)
    && typeof message.text === "string" && message.text.length <= MAX_MESSAGE_LENGTH && typeof message.streaming === "boolean"
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
    || !record(operational.continuity) || !record(operational.timeline) || !record(operational.tools) || !record(operational.health)) return false;
  const available = (feature: Record<string, unknown>) => feature.availability === "available" || feature.availability === "unavailable";
  if (!available(operational.verification) || !Array.isArray(operational.verification.checks) || operational.verification.checks.length > 20
    || !available(operational.jobs) || !Array.isArray(operational.jobs.items) || operational.jobs.items.length > 50
    || !available(operational.guard) || typeof operational.guard.blocked !== "number" || typeof operational.guard.confirmed !== "number"
    || !available(operational.continuity) || !Number.isSafeInteger(operational.continuity.revision)
    || !available(operational.timeline) || !Number.isSafeInteger(operational.timeline.revision) || !Array.isArray(operational.timeline.checkpoints) || operational.timeline.checkpoints.length > 100
    || !available(operational.tools) || !Array.isArray(operational.tools.policies) || operational.tools.policies.length > 100
    || !["healthy", "degraded", "unavailable"].includes(String(operational.health.status)) || !Array.isArray(operational.health.issues) || operational.health.issues.length > 20) return false;
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

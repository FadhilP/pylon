import { COMMAND_NAMES, type WebCommand } from "./commands.ts";
import { PROTOCOL_VERSION, type WebEvent } from "./envelope.ts";
import type { PackageListSnapshot, RuntimeSnapshot, SessionListSnapshot } from "./snapshots.ts";

const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 4;
const commandNames = new Set<string>(COMMAND_NAMES);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const runtimeStates = new Set(["sleeping", "idle", "running", "attention"]);

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

export function validateCommand(value: unknown): ValidationResult<WebCommand> {
  if (!record(value)) return { ok: false, error: "command must be an object" };
  if (typeof value.type !== "string" || !commandNames.has(value.type)) {
    return { ok: false, error: "unknown command type" };
  }
  if (!identifier(value.commandId)) return { ok: false, error: "invalid commandId" };
  if (!generation(value.expectedGeneration)) return { ok: false, error: "invalid expectedGeneration" };

  if (["prompt", "steer", "followUp"].includes(value.type)) {
    if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_LENGTH || (!value.message.length && !Array.isArray(value.images))) {
      return { ok: false, error: "invalid message" };
    }
    if (!validImages(value.images)) return { ok: false, error: "invalid images" };
  }
  if ((value.type === "switchSession" || value.type === "deleteSession") && !identifier(value.sessionId)) {
    return { ok: false, error: "invalid sessionId" };
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
  if (value.type === "setModel" && (!boundedString(value.provider) || !boundedString(value.modelId))) {
    return { ok: false, error: "invalid model" };
  }
  if (value.type === "setThinkingLevel" && !thinkingLevels.has(String(value.level))) {
    return { ok: false, error: "invalid thinking level" };
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
    || !Array.isArray(value.projects) || value.projects.length > 100) return false;
  return value.projects.every((project) => record(project)
    && identifier(project.id)
    && typeof project.label === "string" && project.label.length > 0 && project.label.length <= 500
    && Number.isSafeInteger(project.totalCount) && (project.totalCount as number) >= 0
    && (project.nextCursor === undefined || identifier(project.nextCursor))
    && Array.isArray(project.sessions) && project.sessions.length <= 100
    && project.sessions.every((session) => record(session)
      && identifier(session.id)
      && session.projectId === project.id
      && (session.name === undefined || typeof session.name === "string" && session.name.length <= 200)
      && typeof session.cwdLabel === "string" && session.cwdLabel.length <= 500
      && typeof session.createdAt === "string" && !Number.isNaN(Date.parse(session.createdAt))
      && typeof session.modifiedAt === "string" && !Number.isNaN(Date.parse(session.modifiedAt))
      && Number.isSafeInteger(session.userMessageCount) && (session.userMessageCount as number) >= 0
      && typeof session.preview === "string" && session.preview.length <= 500
      && typeof session.active === "boolean"
      && runtimeStates.has(String(session.runtimeState))));
}

export function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!identifier(value.sessionId) || !generation(value.sessionGeneration) || typeof value.ready !== "boolean") return false;
  if (typeof value.cwdLabel !== "string" || !Array.isArray(value.activeTools) || !Array.isArray(value.availableTools)) return false;
  if (!value.activeTools.every((item) => typeof item === "string") || !value.availableTools.every((item) => typeof item === "string")) return false;
  if (!record(value.optionalCapabilities) || !Object.values(value.optionalCapabilities).every((item) => item === "available" || item === "unavailable")) return false;
  if (!Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => record(item)
    && ["info", "warning", "error"].includes(item.level as string)
    && typeof item.message === "string")) return false;
  const conversation = value.conversation;
  if (!record(conversation) || !Array.isArray(conversation.messages) || !Array.isArray(conversation.tools)
    || typeof conversation.streaming !== "boolean" || !record(conversation.queue) || !record(conversation.retry) || !record(conversation.compaction)) return false;
  if (conversation.messages.length > 100 || conversation.tools.length > 100) return false;
  if (!conversation.messages.every((message) => record(message) && identifier(message.id)
    && ["user", "assistant", "system", "tool"].includes(message.role as string)
    && typeof message.text === "string" && message.text.length <= MAX_MESSAGE_LENGTH && typeof message.streaming === "boolean"
    && (message.attachmentCount === undefined || Number.isSafeInteger(message.attachmentCount) && (message.attachmentCount as number) >= 0 && (message.attachmentCount as number) <= MAX_IMAGES)
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
  if (!Number.isSafeInteger(conversation.queue.steering) || !Number.isSafeInteger(conversation.queue.followUp)
    || typeof conversation.retry.active !== "boolean" || typeof conversation.compaction.active !== "boolean") return false;
  const controls = value.sessionControls;
  if (!record(controls) || !Array.isArray(controls.models) || controls.models.length > 500
    || !Array.isArray(controls.thinkingLevels) || !controls.thinkingLevels.every((level) => thinkingLevels.has(String(level)))
    || (controls.thinkingLevel !== undefined && !thinkingLevels.has(String(controls.thinkingLevel)))) return false;
  const model = (value: unknown) => record(value) && boundedString(value.provider) && boundedString(value.id) && boundedString(value.name);
  if (!controls.models.every(model) || controls.model !== undefined && !model(controls.model)) return false;
  const metrics = value.metrics;
  if (!record(metrics) || typeof metrics.model !== "string" || typeof metrics.provider !== "string"
    || !["inputTokens", "outputTokens", "cacheReadTokens", "contextTokens", "contextLimit", "contextPercent", "cost", "userMessages", "assistantMessages", "toolCalls"]
      .every((key) => typeof metrics[key] === "number" && Number.isFinite(metrics[key] as number))) return false;
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

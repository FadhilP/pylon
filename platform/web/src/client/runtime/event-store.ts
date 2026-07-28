import { useSyncExternalStore } from "react";
import type { AcceptedCommand, QueuedPromptPayload, WebCommand } from "../../shared/protocol/commands";
import { PROTOCOL_VERSION, type WebEvent } from "../../shared/protocol/envelope";
import type { ConnectionState, ContinuityMemoryFactReadModel, ConversationReadModel, DelegatedAgentRunReadModel, MessageReadModel, OperationalReadModel, SessionControlsReadModel, SessionMetricsReadModel, ThinkingLevelReadModel, ToolActivityReadModel, UiRequestReadModel } from "../../shared/protocol/events";
import type { SessionRuntimeState } from "../../shared/protocol/events";
import type { ArchiveListQuery, ArchiveListSnapshot, ConversationTurnIndexPage, ConversationTurnIndexQuery, FileSuggestionList, PackageListSnapshot, PackageSettingsReadModel, RuntimeSnapshot, SessionListQuery, SessionListSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, VerifyPolicyReadModel, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFilePage, WorkspaceFileReadModel } from "../../shared/protocol/snapshots";
import type { PromptImage, PromptTextFile } from "../../shared/protocol/commands";
import { describeRuntimeSnapshotIssue, isArchiveListSnapshot, isConversationHistoryPage, isConversationTurnIndexPage, isFileSuggestionList, isPackageListSnapshot, isSessionListSnapshot, isWebEvent, isWorkspaceFileContent, isWorkspaceFilePage, runtimeSnapshotValidationIssue } from "../../shared/protocol/validation";
import { mergeHistoryMessages, restoreCachedHistory, type CachedHistory } from "../../shared/history-cache";
import { ApiClient } from "./api-client";
import { drainWorkspaceFiles } from "../../shared/workspace-file-pages";

export interface RuntimeStoreSnapshot {
  connection: ConnectionState;
  runtime?: RuntimeSnapshot;
  pendingUi?: UiRequestReadModel;
  sequence: number;
  generation?: number;
  agentActive?: boolean;
  sessionRevision?: number;
  sessionStatuses?: Record<string, SessionRuntimeState>;
  error?: string;
  errorRevision?: number;
  recovery?: { message: string; action: "retry" | "reload" };
  historyWindow?: TranscriptWindowReadModel;
  treeChanging?: boolean;
}

export interface TranscriptWindowReadModel {
  sessionId: string;
  sessionGeneration: number;
  messages: MessageReadModel[];
  earlierCursor?: string;
  laterCursor?: string;
}

const initial: RuntimeStoreSnapshot = { connection: "loading", sequence: 0, sessionRevision: 0 };
const eventNames = ["message.start", "message.update", "message.end", "message.undo", "tool.start", "tool.end", "delegate.update", "turn.changes", "discover.index", "queue.update", "workspace.revision", "retry.update", "compaction.update", "metrics.update", "session.controls", "runtime.policy", "runtime.error", "projects.changed", "ui.request", "ui.closed", "ui.ownership", "ui.notify", "ui.status", "ui.widget", "ui.title", "ui.editor-text", "agent.start", "agent.end", "session.info", "session.status", "session.replaced", "session.unavailable", "stream.reset-required", "operational.pi-verify:lifecycle", "operational.pi-verify:result", "operational.pi-heartbeat:job", "operational.pi-guard:decision", "operational.pylon:tool-policy", "operational.pi-continuity:state-change", "operational.pi-timeline:state-change"];
const MAX_CACHED_SESSIONS = 10;
const WORKSPACE_INVENTORY_TTL_MS = 60_000;

interface CachedWorkspaceInventory {
  revision?: string;
  expiresAt: number;
  files: WorkspaceFileReadModel[];
  truncated: boolean;
}

interface HistorySegment {
  messages: MessageReadModel[];
  earlierCursor?: string;
  laterCursor?: string;
}

function historyKey(sessionId: string, generation: number): string {
  return `${sessionId}:${generation}`;
}

function commandId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function mergeDelegatedRun(previous: DelegatedAgentRunReadModel | undefined, next: DelegatedAgentRunReadModel): DelegatedAgentRunReadModel {
  if (!previous) return next;
  if (previous.status !== "running" && next.status === "running") {
    return {
      ...previous,
      activity: next.activity.length >= previous.activity.length ? next.activity : previous.activity,
    };
  }
  return {
    ...previous,
    ...next,
    activity: next.activity.length >= previous.activity.length ? next.activity : previous.activity,
    usage: next.usage ?? previous.usage,
  };
}

export class RuntimeEventStore {
  private readonly api = new ApiClient();
  private readonly historyCache = new Map<string, CachedHistory>();
  private readonly invalidatedHistoryGenerations = new Map<string, number>();
  private readonly workspaceInventories = new Map<string, CachedWorkspaceInventory>();
  private readonly historyWindows = new Map<string, HistorySegment[]>();
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private source?: EventSource;
  private frame?: number;
  private disposed = false;
  private started = false;
  private resetting = false;
  private bootstrapEpoch = 0;
  private bootstrapAttempts = 0;
  private bootstrapRetry?: number;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): RuntimeStoreSnapshot => this.snapshot;

  start(): void { if (this.started) return; this.started = true; void this.bootstrap(); }
  dispose(): void {
    this.disposed = true;
    this.source?.close();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    if (this.bootstrapRetry !== undefined) window.clearTimeout(this.bootstrapRetry);
  }
  retryBootstrap(): void {
    if (this.disposed) return;
    if (this.bootstrapRetry !== undefined) window.clearTimeout(this.bootstrapRetry);
    this.bootstrapRetry = undefined;
    this.resetting = false;
    void this.bootstrap();
  }
  reportError(message: string): void {
    this.set({ ...this.snapshot, error: message, errorRevision: (this.snapshot.errorRevision ?? 0) + 1 });
  }

  async sendMessage(message: string, images?: PromptImage[], files?: PromptTextFile[], planMode = false): Promise<void> {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected" || !runtime.ready) throw new Error("Runtime is not connected");
    const type = runtime.conversation.workStartedAt ? "queuePrompt" : "prompt";
    await this.sendCommand({
      type,
      message,
      ...(images?.length ? { images } : {}),
      ...(files?.length ? { files } : {}),
      ...(planMode ? { planMode: true } : {}),
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
    this.set({ ...this.snapshot, sessionRevision: (this.snapshot.sessionRevision ?? 0) + 1 });
  }

  async restoreQueuedPrompt(queueId: string): Promise<QueuedPromptPayload> {
    const runtime = this.requireReadyRuntime();
    const queued = await this.api.queuedPrompt(queueId, runtime.sessionGeneration);
    await this.sendCommand({
      type: "restoreQueuedPrompt",
      queueId,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
    return queued;
  }

  async steerQueuedPrompt(queueId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "steerQueuedPrompt",
      queueId,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async editPrompt(entryId: string, message: string, images: PromptImage[], rollbackFiles: boolean): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const cachedHistory = this.historyCache.get(runtime.sessionId);
    const key = historyKey(runtime.sessionId, runtime.sessionGeneration);
    const cachedWindow = this.historyWindows.get(key);
    this.invalidatedHistoryGenerations.set(runtime.sessionId, runtime.sessionGeneration);
    this.historyCache.delete(runtime.sessionId);
    this.historyWindows.delete(key);
    this.set({ ...this.snapshot, treeChanging: true });
    try {
      await this.sendCommand({
        type: "editPrompt",
        entryId,
        message,
        ...(images.length ? { images } : {}),
        rollbackFiles,
        commandId: commandId(),
        expectedGeneration: runtime.sessionGeneration,
      });
      if (this.snapshot.runtime?.sessionGeneration === runtime.sessionGeneration) {
        this.set({ ...this.snapshot, treeChanging: false });
      }
      this.set({ ...this.snapshot, sessionRevision: (this.snapshot.sessionRevision ?? 0) + 1 });
    } catch (error) {
      this.invalidatedHistoryGenerations.delete(runtime.sessionId);
      if (cachedHistory) this.historyCache.set(runtime.sessionId, cachedHistory);
      if (cachedWindow) this.historyWindows.set(key, cachedWindow);
      this.set({ ...this.snapshot, treeChanging: false });
      throw error;
    }
  }

  async rewindPrompt(entryId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const cachedHistory = this.historyCache.get(runtime.sessionId);
    const key = historyKey(runtime.sessionId, runtime.sessionGeneration);
    const cachedWindow = this.historyWindows.get(key);
    this.invalidatedHistoryGenerations.set(runtime.sessionId, runtime.sessionGeneration);
    this.historyCache.delete(runtime.sessionId);
    this.historyWindows.delete(key);
    this.set({ ...this.snapshot, treeChanging: true });
    try {
      const accepted = await this.sendCommand({
        type: "rewindPrompt",
        entryId,
        commandId: commandId(),
        expectedGeneration: runtime.sessionGeneration,
      });
      await this.waitForRuntime(runtime.sessionId, accepted.sessionGeneration);
      this.set({ ...this.snapshot, sessionRevision: (this.snapshot.sessionRevision ?? 0) + 1 });
    } catch (error) {
      this.invalidatedHistoryGenerations.delete(runtime.sessionId);
      if (cachedHistory) this.historyCache.set(runtime.sessionId, cachedHistory);
      if (cachedWindow) this.historyWindows.set(key, cachedWindow);
      this.set({ ...this.snapshot, treeChanging: false });
      throw error;
    }
  }

  async forkPrompt(entryId: string, name: string, mode: "conversation" | "timeline"): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const key = historyKey(runtime.sessionId, runtime.sessionGeneration);
    this.invalidatedHistoryGenerations.set(runtime.sessionId, runtime.sessionGeneration);
    this.historyCache.delete(runtime.sessionId);
    this.historyWindows.delete(key);
    this.set({ ...this.snapshot, treeChanging: true });
    try {
      await this.sendCommand({
        type: "fork",
        entryId,
        name,
        position: "at",
        mode,
        commandId: commandId(),
        expectedGeneration: runtime.sessionGeneration,
      });
      if (this.snapshot.runtime?.sessionGeneration === runtime.sessionGeneration) {
        this.set({ ...this.snapshot, treeChanging: false });
      }
    } catch (error) {
      this.invalidatedHistoryGenerations.delete(runtime.sessionId);
      this.set({ ...this.snapshot, treeChanging: false });
      throw error;
    }
  }

  async abort(): Promise<void> {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected") throw new Error("Runtime is not connected");
    if (runtime.conversation.stopping) return;
    this.set({
      ...this.snapshot,
      runtime: {
        ...runtime,
        conversation: { ...runtime.conversation, stopping: true },
      },
    });
    try {
      await this.sendCommand({ type: "abort", commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
    } catch (error) {
      const current = this.snapshot.runtime;
      if (current?.sessionId === runtime.sessionId) {
        this.set({
          ...this.snapshot,
          runtime: {
            ...current,
            conversation: { ...current.conversation, stopping: false },
          },
        });
      }
      throw error;
    }
  }

  async listSessions(input: SessionListQuery = {}, signal?: AbortSignal): Promise<SessionListSnapshot> {
    const runtime = this.requireReadyRuntime();
    const sessions = await this.api.sessions(input, signal);
    if (!isSessionListSnapshot(sessions) || sessions.sessionGeneration !== runtime.sessionGeneration) throw new Error("Session list is stale or invalid");
    return sessions;
  }

  async updateRuntimePolicy(
    scope: "project" | "session",
    verify: VerifyPolicyReadModel | "inherit",
    timeline: boolean | "inherit",
    expectedRevision: number,
  ): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "updateRuntimePolicy",
      scope,
      verify: verify === "inherit" ? { mode: "inherit" } : verify,
      timeline: timeline === "inherit" ? "inherit" : timeline ? "enabled" : "disabled",
      expectedRevision,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async fileSuggestions(query: string): Promise<FileSuggestionList> {
    const runtime = this.requireReadyRuntime();
    const result = await this.api.fileSuggestions(query, runtime.sessionGeneration);
    if (!isFileSuggestionList(result) || result.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("File suggestions are stale or invalid");
    }
    return result;
  }

  async conversationTurnIndex(input: ConversationTurnIndexQuery = {}): Promise<ConversationTurnIndexPage> {
    const runtime = this.requireReadyRuntime();
    const page = await this.api.conversationTurnIndex(input, runtime.sessionGeneration);
    if (!isConversationTurnIndexPage(page)
      || page.sessionId !== runtime.sessionId
      || page.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Conversation turn index is stale or invalid");
    }
    return page;
  }

  async workspaceFiles(query = "", cursor?: string, signal?: AbortSignal, refresh = false): Promise<WorkspaceFilePage> {
    const runtime = this.requireReadyRuntime();
    const sessionId = runtime.sessionId;
    const generation = runtime.sessionGeneration;
    const result = await this.api.workspaceFiles(generation, query, cursor, signal, refresh);
    const current = this.snapshot.runtime;
    if (!isWorkspaceFilePage(result) || result.sessionGeneration !== generation) {
      throw new Error("Workspace files are stale or invalid");
    }
    if (current?.sessionId !== sessionId || current.sessionGeneration !== generation) {
      throw new Error("Workspace files belong to a previous session");
    }
    return result;
  }

  async workspaceInventory(
    refresh: boolean,
    signal: AbortSignal,
    publish: (files: WorkspaceFileReadModel[], truncated: boolean) => void,
    progress: (loaded: number, total: number) => void,
  ): Promise<CachedWorkspaceInventory> {
    const runtime = this.requireReadyRuntime();
    const revision = runtime.workspace?.revision;
    const cached = this.workspaceInventories.get(runtime.sessionId);
    if (!refresh && cached && cached.expiresAt > Date.now()
      && cached.revision === runtime.workspace?.revision) {
      this.workspaceInventories.delete(runtime.sessionId);
      this.workspaceInventories.set(runtime.sessionId, cached);
      publish(cached.files, cached.truncated);
      progress(cached.files.length, cached.files.length);
      return cached;
    }
    let truncated = false;
    const files = await drainWorkspaceFiles(
      (cursor) => this.workspaceFiles("", cursor, signal, refresh && !cursor),
      signal,
      (next, value) => {
        truncated = value;
        publish(next, value);
      },
      progress,
    );
    const current = this.snapshot.runtime;
    if (current?.sessionId !== runtime.sessionId
      || current.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Workspace files belong to a previous session");
    }
    const inventory = {
      revision,
      expiresAt: Date.now() + WORKSPACE_INVENTORY_TTL_MS,
      files,
      truncated,
    };
    this.workspaceInventories.delete(runtime.sessionId);
    this.workspaceInventories.set(runtime.sessionId, inventory);
    while (this.workspaceInventories.size > MAX_CACHED_SESSIONS) {
      this.workspaceInventories.delete(this.workspaceInventories.keys().next().value!);
    }
    return inventory;
  }

  async workspaceFile(path: string, view: "current" | "base" = "current"): Promise<WorkspaceFileContent> {
    const runtime = this.requireReadyRuntime();
    const result = await this.api.workspaceFile(runtime.sessionGeneration, path, view);
    if (!isWorkspaceFileContent(result) || result.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Workspace file is stale or invalid");
    }
    return result;
  }

  async workspaceDiff(path: string): Promise<WorkspaceFileDiff> {
    const runtime = this.requireReadyRuntime();
    const result = await this.api.workspaceDiff(runtime.sessionGeneration, path);
    if (!isWorkspaceFileContent(result) || result.sessionGeneration !== runtime.sessionGeneration
      || String(result.state) === "deleted") {
      throw new Error("Workspace diff is stale or invalid");
    }
    return result;
  }

  async timelineCheckpointFiles(checkpointId: string): Promise<TimelineCheckpointFiles> {
    const runtime = this.requireReadyRuntime();
    const result = await this.api.timelineCheckpointFiles(runtime.sessionGeneration, checkpointId);
    if (result.sessionGeneration !== runtime.sessionGeneration || result.checkpointId !== checkpointId)
      throw new Error("Timeline files are stale or invalid");
    return result;
  }

  async timelineCheckpointDiff(checkpointId: string, path: string): Promise<TimelineCheckpointDiff> {
    const runtime = this.requireReadyRuntime();
    const result = await this.api.timelineCheckpointDiff(runtime.sessionGeneration, checkpointId, path);
    if (result.sessionGeneration !== runtime.sessionGeneration
      || result.checkpointId !== checkpointId || result.path !== path)
      throw new Error("Timeline diff is stale or invalid");
    return result;
  }

  async handoffSession(destination: "checkout" | "worktree"): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "handoffSession", destination, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async updateProjectWorktreeSettings(projectId: string, setupCommand: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "updateProjectWorktreeSettings",
      projectId,
      setupCommand,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async addProject(): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "addProject", commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async loadEarlierMessages(all = false): Promise<void> {
    const runtime = this.requireReadyRuntime();
    let cursor = this.historyWindow(runtime).earlierCursor;
    if (!cursor) return;
    const seen = new Set<string>();
    try {
      do {
        if (seen.has(cursor)) throw new Error("History cursor repeated");
        seen.add(cursor);
        const page = await this.api.conversationHistory(cursor, runtime.sessionGeneration);
        if (!isConversationHistoryPage(page)
          || page.sessionId !== runtime.sessionId
          || page.sessionGeneration !== runtime.sessionGeneration) {
          throw new Error("Conversation history is stale or invalid");
        }
        this.addHistorySegment(runtime, "before", {
          messages: page.messages,
          earlierCursor: page.earlierCursor,
          laterCursor: page.laterCursor,
        });
        cursor = page.earlierCursor;
      } while (all && cursor);
      const current = this.snapshot.runtime;
      if (!current || current.sessionId !== runtime.sessionId || current.sessionGeneration !== runtime.sessionGeneration) {
        throw new Error("Session changed while loading history");
      }
      this.set({ ...this.snapshot, historyWindow: this.historyWindow(current) });
    } catch (error) {
      this.set({
        ...this.snapshot,
        error: error instanceof Error ? error.message : "Could not load conversation history",
        errorRevision: (this.snapshot.errorRevision ?? 0) + 1,
      });
      throw error;
    }
  }

  async loadLaterMessages(): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const cursor = this.historyWindow(runtime).laterCursor;
    if (!cursor) return;
    const page = await this.api.conversationHistory(cursor, runtime.sessionGeneration, 100, "after");
    if (!isConversationHistoryPage(page)
      || page.sessionId !== runtime.sessionId
      || page.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Conversation history is stale or invalid");
    }
    this.addHistorySegment(runtime, "after", {
      messages: page.messages,
      earlierCursor: page.earlierCursor,
      laterCursor: page.laterCursor,
    });
    this.set({ ...this.snapshot, historyWindow: this.historyWindow(runtime) });
  }

  async jumpToHistory(cursor: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const page = await this.api.conversationHistory(cursor, runtime.sessionGeneration, 100, "around");
    if (!isConversationHistoryPage(page)
      || page.sessionId !== runtime.sessionId
      || page.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Conversation history is stale or invalid");
    }
    this.historyWindows.set(historyKey(runtime.sessionId, runtime.sessionGeneration), [{
      messages: page.messages,
      earlierCursor: page.earlierCursor,
      laterCursor: page.laterCursor,
    }]);
    this.set({ ...this.snapshot, historyWindow: this.historyWindow(runtime) });
  }

  async listArchived(input: ArchiveListQuery = {}): Promise<ArchiveListSnapshot> {
    const runtime = this.requireReadyRuntime();
    const archives = await this.api.archives(input);
    if (!isArchiveListSnapshot(archives) || archives.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Archive list is stale or invalid");
    }
    return archives;
  }

  async removeProject(projectId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "removeProject", projectId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async reorderProject(projectId: string, beforeProjectId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "reorderProject",
      projectId,
      ...(beforeProjectId ? { beforeProjectId } : {}),
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async archiveProject(projectId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "archiveProject", projectId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async restoreProject(projectId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "restoreProject", projectId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async newSession(projectId?: string, parentSessionId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "newSession",
      ...(projectId ? { projectId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async listPackages(): Promise<PackageListSnapshot> {
    const runtime = this.requireReadyRuntime();
    const packages = await this.api.packages();
    if (!isPackageListSnapshot(packages) || packages.sessionGeneration !== runtime.sessionGeneration) {
      throw new Error("Package list is stale or invalid");
    }
    return packages;
  }

  async setPackageEnabled(packageId: string, enabled: boolean): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "setPackageEnabled",
      packageId,
      enabled,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async updatePackageSettings(packageId: string, settings: PackageSettingsReadModel): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "updatePackageSettings",
      packageId,
      settings,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async rebuildDiscoverIndex(): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "rebuildDiscoverIndex",
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "setModel", provider, modelId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async setThinkingLevel(level: ThinkingLevelReadModel): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "setThinkingLevel", level, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async setSessionControls(provider: string, modelId: string, thinkingLevel: ThinkingLevelReadModel): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "setSessionControls",
      provider,
      modelId,
      thinkingLevel,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async updateContinuityMemory(fact: ContinuityMemoryFactReadModel, text: string, kind: ContinuityMemoryFactReadModel["kind"]): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "updateContinuityMemory",
      key: fact.key,
      text,
      kind,
      expectedUpdatedAt: fact.updatedAt,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async deleteContinuityMemory(fact: ContinuityMemoryFactReadModel): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "deleteContinuityMemory",
      key: fact.key,
      expectedUpdatedAt: fact.updatedAt,
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async switchSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    const accepted = await this.sendCommand({ type: "switchSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
    await this.waitForRuntime(sessionId, accepted.sessionGeneration);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "deleteSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async archiveSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "archiveSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async restoreSession(sessionId: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "restoreSession", sessionId, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "renameSession", sessionId, name, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async setSessionActive(sessionId: string, active: boolean): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({ type: "setSessionActive", sessionId, active, commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
  }

  async reorderActiveSession(sessionId: string, beforeSessionId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.sendCommand({
      type: "reorderActiveSession",
      sessionId,
      ...(beforeSessionId ? { beforeSessionId } : {}),
      commandId: commandId(),
      expectedGeneration: runtime.sessionGeneration,
    });
  }

  async timeline(action: "restore" | "fork" | "clear", checkpointId?: string): Promise<void> {
    const runtime = this.requireReadyRuntime();
    if (action !== "clear") {
      this.historyWindows.delete(historyKey(runtime.sessionId, runtime.sessionGeneration));
      this.set({ ...this.snapshot, treeChanging: true });
    }
    try {
      await this.sendCommand({ type: "timeline", action, ...(checkpointId ? { checkpointId } : {}), commandId: commandId(), expectedGeneration: runtime.sessionGeneration });
      if (action !== "clear" && this.snapshot.runtime?.sessionGeneration === runtime.sessionGeneration) {
        this.set({ ...this.snapshot, treeChanging: false });
      }
    } catch (error) {
      this.set({ ...this.snapshot, treeChanging: false });
      throw error;
    }
  }

  async answerUi(request: UiRequestReadModel, body: Record<string, unknown>): Promise<void> {
    const runtime = this.requireReadyRuntime();
    if (!request.owned) throw new Error("This dialog belongs to another tab");
    await this.api.uiResponse(request.requestId, { ...body, requestId: request.requestId, sessionGeneration: runtime.sessionGeneration, method: request.method });
  }

  async changeUiOwnership(request: UiRequestReadModel, action: "claim" | "release"): Promise<void> {
    const runtime = this.requireReadyRuntime();
    await this.api.uiOwnership(request.requestId, runtime.sessionGeneration, action);
  }

  private async sendCommand(command: WebCommand): Promise<AcceptedCommand> {
    try { return await this.api.command(command); }
    catch (error) {
      if (!["setPackageEnabled", "updatePackageSettings", "timeline", "updateContinuityMemory", "deleteContinuityMemory"].includes(command.type)) {
        this.set({
          ...this.snapshot,
          error: error instanceof Error ? error.message : "Command failed",
          errorRevision: (this.snapshot.errorRevision ?? 0) + 1,
        });
      }
      throw error;
    }
  }

  private waitForRuntime(sessionId: string, generation: number): Promise<void> {
    const ready = () => {
      const runtime = this.snapshot.runtime;
      return this.snapshot.connection === "connected"
        && runtime?.ready === true
        && runtime.sessionId === sessionId
        && runtime.sessionGeneration === generation;
    };
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        const observed = this.snapshot.runtime;
        reject(new Error(
          `Timed out after 30 seconds while loading session ${sessionId} at generation ${generation}. `
          + `Observed ${this.snapshot.connection}, session ${observed?.sessionId ?? "none"}, `
          + `generation ${observed?.sessionGeneration ?? "none"}, ready ${observed?.ready ?? false}.`,
        ));
      }, 30_000);
      const unsubscribe = this.subscribe(() => {
        if (!ready()) return;
        window.clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
  }

  private requireReadyRuntime(): RuntimeSnapshot {
    const runtime = this.snapshot.runtime;
    if (!runtime || this.snapshot.connection !== "connected" || !runtime.ready) throw new Error("Runtime is not connected");
    return runtime;
  }

  private historyWindow(runtime: RuntimeSnapshot): TranscriptWindowReadModel {
    const key = historyKey(runtime.sessionId, runtime.sessionGeneration);
    let segments = this.historyWindows.get(key);
    if (!segments?.length) {
      segments = [{
        messages: runtime.conversation.messages.slice(-100),
        earlierCursor: runtime.conversation.historyCursor,
      }];
      this.historyWindows.set(key, segments);
    } else {
      const latest = segments.at(-1)!;
      if (!latest.laterCursor) {
        latest.messages = runtime.conversation.messages.slice(-100);
        latest.earlierCursor = runtime.conversation.historyCursor;
      }
    }
    const messages = segments.reduce<MessageReadModel[]>(
      (current, segment) => mergeHistoryMessages(current, segment.messages),
      [],
    ).slice(-300);
    return {
      sessionId: runtime.sessionId,
      sessionGeneration: runtime.sessionGeneration,
      messages,
      earlierCursor: segments[0]?.earlierCursor,
      laterCursor: segments.at(-1)?.laterCursor,
    };
  }

  private addHistorySegment(runtime: RuntimeSnapshot, direction: "before" | "after", segment: HistorySegment): void {
    const key = historyKey(runtime.sessionId, runtime.sessionGeneration);
    const segments = this.historyWindows.get(key) ?? [];
    if (direction === "before") segments.unshift(segment);
    else segments.push(segment);
    while (segments.length > 3) {
      if (direction === "before") segments.pop();
      else segments.shift();
    }
    this.historyWindows.delete(key);
    this.historyWindows.set(key, segments);
    while (this.historyWindows.size > MAX_CACHED_SESSIONS) {
      this.historyWindows.delete(this.historyWindows.keys().next().value!);
    }
  }

  private async bootstrap(): Promise<void> {
    const epoch = ++this.bootstrapEpoch;
    try {
      const boot = await this.api.bootstrap();
      const issue = runtimeSnapshotValidationIssue(boot.runtime);
      if (issue) {
        const error = new Error(describeRuntimeSnapshotIssue(boot.runtime, issue));
        error.name = issue.kind === "protocol" ? "ProtocolMismatchError" : "RuntimeSnapshotError";
        throw error;
      }
      if (boot.protocolVersion !== PROTOCOL_VERSION || !Number.isSafeInteger(boot.sequence) || boot.sequence < 0) {
        const error = new Error(`Invalid bootstrap envelope: expected protocol ${PROTOCOL_VERSION}, received ${String(boot.protocolVersion)}.`);
        error.name = boot.protocolVersion === PROTOCOL_VERSION ? "RuntimeSnapshotError" : "ProtocolMismatchError";
        throw error;
      }
      if (this.disposed || epoch !== this.bootstrapEpoch) return;
      this.resetting = false;
      this.bootstrapAttempts = 0;
      if (this.bootstrapRetry !== undefined) window.clearTimeout(this.bootstrapRetry);
      this.bootstrapRetry = undefined;
      const runtime = restoreCachedHistory(boot.runtime, this.historyCache.get(boot.runtime.sessionId));
      this.set({ connection: "disconnected", runtime, pendingUi: boot.pendingUi, sequence: boot.sequence, generation: runtime.sessionGeneration, recovery: undefined });
      this.openEvents(`${boot.runtime.sessionGeneration}:${boot.sequence}`);
    } catch (error) {
      if (epoch !== this.bootstrapEpoch) return;
      this.resetting = false;
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : "Unable to load the runtime";
      const action = error instanceof Error && error.name === "ProtocolMismatchError" ? "reload" : "retry";
      this.set({
        ...this.snapshot,
        connection: this.snapshot.runtime ? "disconnected" : "loading",
        recovery: { message, action },
      });
      if (action === "retry") this.scheduleBootstrapRetry();
    }
  }

  private scheduleBootstrapRetry(): void {
    if (this.bootstrapRetry !== undefined || this.disposed) return;
    const delays = [1_000, 2_000, 5_000];
    const delay = delays[Math.min(this.bootstrapAttempts++, delays.length - 1)];
    this.bootstrapRetry = window.setTimeout(() => {
      this.bootstrapRetry = undefined;
      void this.bootstrap();
    }, delay);
  }

  private openEvents(cursor: string): void {
    this.source?.close();
    const source = this.api.events(cursor);
    this.source = source;
    source.onopen = () => { if (this.source === source) this.set({ ...this.snapshot, connection: "connected", error: undefined, recovery: undefined }); };
    source.onerror = () => {
      if (this.source !== source || this.disposed) return;
      if (source.readyState === EventSource.CLOSED) {
        this.reset();
        return;
      }
      // EventSource handles temporary network reconnects itself.
      this.set({ ...this.snapshot, connection: "disconnected" });
    };
    for (const name of eventNames) source.addEventListener(name, (event) => {
      if (this.source === source) this.onEvent(name, event);
    });
  }

  private onEvent(name: string, event: Event): void {
    if (name === "stream.reset-required") { this.reset(); return; }
    const data = (event as MessageEvent<string>).data;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (!isWebEvent(parsed)) return;
    this.apply(parsed);
  }

  private apply(event: WebEvent): void {
    if (event.payloadVersion !== 1) { this.reset(); return; }
    const current = this.snapshot;
    const generation = current.generation;
    if (generation !== undefined && event.sessionGeneration < generation) return;
    if (event.sessionGeneration === generation && event.sequence <= current.sequence) return;
    if (event.sessionGeneration === generation && event.sequence !== current.sequence + 1) {
      this.reset(); return;
    }
    if (generation !== undefined && event.sessionGeneration > generation && event.type !== "session.replaced") {
      this.reset(); return;
    }

    if (event.type === "session.replaced" || event.type === "session.unavailable") {
      this.reset();
      return;
    }
    if (event.type === "session.status") {
      const status = asRecord(event.payload);
      if (typeof status.sessionId === "string" && ["sleeping", "idle", "running", "attention"].includes(String(status.state))) {
        this.set({
          ...current,
          sessionStatuses: { ...current.sessionStatuses, [status.sessionId]: status.state as SessionRuntimeState },
          sequence: event.sequence,
        }, true);
      }
      return;
    }
    if (event.type === "runtime.error") {
      const payload = asRecord(event.payload);
      this.set({
        ...current,
        sequence: event.sequence,
        error: typeof payload.message === "string" ? payload.message : "Runtime command failed",
        errorRevision: (current.errorRevision ?? 0) + 1,
      }, true);
      return;
    }
    if (event.type === "workspace.revision") this.workspaceInventories.delete(event.sessionId);

    let runtime = current.runtime;
    let pendingUi = current.pendingUi;
    if (runtime) {
      runtime = applyRuntimeEvent(runtime, event);
      if (event.type === "ui.request") pendingUi = event.payload as UiRequestReadModel;
      if (event.type === "ui.ownership" && pendingUi) {
        const ownership = asRecord(event.payload);
        if (ownership.requestId === pendingUi.requestId) pendingUi = {
          ...pendingUi,
          owned: ownership.owned === true,
          ownershipAvailable: ownership.ownershipAvailable === true,
        };
      }
      if (event.type === "ui.closed") pendingUi = undefined;
    }
    const sessionChanged = event.type === "agent.start" || event.type === "agent.end" || event.type === "session.info" || event.type === "projects.changed";
    this.set({
      ...current,
      runtime,
      pendingUi,
      generation: event.sessionGeneration,
      sequence: event.sequence,
      agentActive: event.type === "agent.start" ? true : event.type === "agent.end" ? false : current.agentActive,
      sessionRevision: (current.sessionRevision ?? 0) + (sessionChanged ? 1 : 0),
      connection: "connected",
      error: undefined,
    }, true);
  }

  private reset(): void {
    if (this.resetting || this.disposed) return;
    this.resetting = true;
    this.source?.close();
    this.source = undefined;
    this.set({
      ...this.snapshot,
      connection: "disconnected",
      runtime: this.snapshot.runtime ? { ...this.snapshot.runtime, ready: false } : undefined,
      pendingUi: undefined,
      agentActive: false,
      error: undefined,
    });
    void this.bootstrap();
  }

  private set(next: RuntimeStoreSnapshot, batched = false): void {
    if (next.runtime) {
      const runtime = next.runtime;
      next = { ...next, historyWindow: this.historyWindow(runtime) };
      const sessionId = runtime.sessionId;
      const invalidatedGeneration = this.invalidatedHistoryGenerations.get(sessionId);
      if (invalidatedGeneration === undefined || runtime.sessionGeneration > invalidatedGeneration) {
        this.invalidatedHistoryGenerations.delete(sessionId);
        this.historyCache.delete(sessionId);
        this.historyCache.set(sessionId, {
          messages: runtime.conversation.messages.slice(-300),
          historyCursor: runtime.conversation.historyCursor,
          historyRemaining: runtime.conversation.historyRemaining,
        });
        while (this.historyCache.size > MAX_CACHED_SESSIONS) {
          this.historyCache.delete(this.historyCache.keys().next().value!);
        }
      }
    }
    this.snapshot = next;
    if (!batched) { this.notify(); return; }
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.notify(); });
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}

function applyRuntimeEvent(runtime: RuntimeSnapshot, event: WebEvent): RuntimeSnapshot {
  const payload = event.payload;
  const conversation = runtime.conversation;
  if (event.type.startsWith("operational.")) return { ...runtime, operational: payload as OperationalReadModel };
  switch (event.type) {
    case "message.start": {
      const item = payload as MessageReadModel;
      return { ...runtime, conversation: { ...conversation, streaming: true, messages: [...conversation.messages.filter((message) => message.id !== item.id), item] } };
    }
    case "message.update": {
      const update = payload as { id?: string; text?: string; fileAttachmentCount?: number };
      if (!update.id) return runtime;
      const messages = conversation.messages.map((message) => message.id === update.id ? {
        ...message,
        text: typeof update.text === "string" ? update.text : message.text,
        ...(update.fileAttachmentCount === undefined ? {} : { fileAttachmentCount: update.fileAttachmentCount }),
        streaming: true,
      } : message);
      return { ...runtime, conversation: { ...conversation, streaming: true, messages } };
    }
    case "message.end": {
      const update = payload as { id?: string; text?: string; entryId?: string };
      const messages = conversation.messages.map((message) => message.id === update.id ? {
        ...message,
        text: typeof update.text === "string" ? update.text : message.text,
        ...(typeof update.entryId === "string" ? { entryId: update.entryId } : {}),
        streaming: false,
      } : message);
      return { ...runtime, conversation: { ...conversation, streaming: false, messages } };
    }
    case "message.undo": {
      const updates = new Map(
        Array.isArray(asRecord(payload).items)
          ? (asRecord(payload).items as unknown[]).flatMap((item) => {
              const value = asRecord(item);
              return typeof value.id === "string" && typeof value.canUndo === "boolean"
                ? [[value.id, {
                    canUndo: value.canUndo,
                    canForkWithTimeline: value.canForkWithTimeline === true,
                  }] as const]
                : [];
            })
          : [],
      );
      return {
        ...runtime,
        conversation: {
          ...conversation,
          messages: conversation.messages.map((message) =>
            updates.has(message.id) ? { ...message, ...updates.get(message.id) } : message),
        },
      };
    }
    case "tool.start": return { ...runtime, conversation: { ...conversation, tools: replaceTool(conversation.tools, payload as ToolActivityReadModel) } };
    case "tool.end": return { ...runtime, conversation: { ...conversation, tools: replaceTool(conversation.tools, payload as ToolActivityReadModel) } };
    case "delegate.update": {
      const run = payload as DelegatedAgentRunReadModel;
      const previous = conversation.delegatedRuns.find((item) => item.id === run.id);
      const next = mergeDelegatedRun(previous, run);
      return {
        ...runtime,
        conversation: {
          ...conversation,
          delegatedRuns: [...conversation.delegatedRuns.filter((item) => item.id !== run.id), next].slice(-100),
        },
      };
    }
    case "turn.changes": {
      const update = asRecord(payload);
      if (typeof update.messageId !== "string" || !Array.isArray(update.files)) return runtime;
      return {
        ...runtime,
        conversation: {
          ...conversation,
          messages: conversation.messages.map((message) => message.id === update.messageId
            ? { ...message, changedFiles: update.files as MessageReadModel["changedFiles"] }
            : message),
        },
      };
    }
    case "session.controls": return { ...runtime, sessionControls: payload as SessionControlsReadModel };
    case "runtime.policy": return { ...runtime, runtimePolicy: payload as RuntimeSnapshot["runtimePolicy"] };
    case "queue.update": return { ...runtime, conversation: { ...conversation, queue: payload as ConversationReadModel["queue"] } };
    case "workspace.revision": return { ...runtime, workspace: payload as RuntimeSnapshot["workspace"] };
    case "retry.update": return { ...runtime, conversation: { ...conversation, retry: payload as ConversationReadModel["retry"] } };
    case "compaction.update": return { ...runtime, conversation: { ...conversation, compaction: payload as ConversationReadModel["compaction"] } };
    case "metrics.update": return { ...runtime, metrics: payload as SessionMetricsReadModel };
    case "discover.index": {
      const value = asRecord(payload);
      return {
        ...runtime,
        discoverIndex: ["idle", "indexing", "error"].includes(String(value.state))
          ? value as unknown as RuntimeSnapshot["discoverIndex"]
          : undefined,
      };
    }
    case "session.info": {
      const info = asRecord(payload);
      return {
        ...runtime,
        sessionName: typeof info.name === "string" ? info.name.slice(0, 200) || undefined : undefined,
      };
    }
    case "agent.start": {
      const info = asRecord(payload);
      return {
        ...runtime,
        conversation: {
          ...conversation,
          workStartedAt: typeof info.startedAt === "string" ? info.startedAt : new Date().toISOString(),
          workModelName: typeof info.modelName === "string" ? info.modelName : undefined,
          workThinkingLevel: typeof info.thinkingLevel === "string" ? info.thinkingLevel as ConversationReadModel["workThinkingLevel"] : undefined,
          stopping: false,
          stoppedRun: undefined,
        },
      };
    }
    case "agent.end": {
      const info = asRecord(payload);
      const durationMs = Number.isSafeInteger(info.durationMs) ? info.durationMs as number : undefined;
      const messageId = typeof info.messageId === "string" ? info.messageId : undefined;
      const messages = durationMs === undefined || !messageId
        ? conversation.messages
        : conversation.messages.map((message) => message.id === messageId ? {
            ...message,
            workDurationMs: durationMs,
            modelName: typeof info.modelName === "string" ? info.modelName : undefined,
            thinkingLevel: typeof info.thinkingLevel === "string" ? info.thinkingLevel as MessageReadModel["thinkingLevel"] : undefined,
          } : message);
      return {
        ...runtime,
        gitBranch: typeof info.gitBranch === "string" ? info.gitBranch.slice(0, 200) || undefined : undefined,
        conversation: {
          ...conversation,
          messages,
          workStartedAt: undefined,
          workModelName: undefined,
          workThinkingLevel: undefined,
          stopping: false,
          stoppedRun: info.stopped === true && durationMs !== undefined
            ? {
                turnId: typeof info.turnId === "string" ? info.turnId : "",
                userEntryId: typeof info.userEntryId === "string" ? info.userEntryId : undefined,
                durationMs,
                modelName: typeof info.modelName === "string" ? info.modelName : undefined,
                thinkingLevel: typeof info.thinkingLevel === "string"
                  ? info.thinkingLevel as ConversationReadModel["workThinkingLevel"]
                  : undefined,
              }
            : undefined,
        },
      };
    }
    case "ui.notify": return { ...runtime, extensionUi: { ...runtime.extensionUi, notifications: [...runtime.extensionUi.notifications.filter((item) => item.id !== (payload as { id?: string }).id), payload as RuntimeSnapshot["extensionUi"]["notifications"][number]].slice(-10) } };
    case "ui.status": {
      const item = payload as { key?: string; text?: string };
      if (!item.key) return runtime;
      const statuses = runtime.extensionUi.statuses.filter((old) => old.key !== item.key);
      if (typeof item.text === "string") statuses.push({ key: item.key, text: item.text });
      return { ...runtime, extensionUi: { ...runtime.extensionUi, statuses } };
    }
    case "ui.widget": {
      const item = payload as { key?: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" };
      if (!item.key) return runtime;
      const widgets = runtime.extensionUi.widgets.filter((old) => old.key !== item.key);
      if (Array.isArray(item.lines)) widgets.push({ key: item.key, lines: item.lines, placement: item.placement });
      return { ...runtime, extensionUi: { ...runtime.extensionUi, widgets } };
    }
    case "ui.title": return { ...runtime, extensionUi: { ...runtime.extensionUi, title: typeof (payload as { title?: unknown }).title === "string" ? (payload as { title: string }).title : undefined } };
    case "ui.editor-text": {
      const item = payload as { text?: unknown; revision?: unknown };
      if (typeof item.text !== "string" || !Number.isSafeInteger(item.revision)) return runtime;
      return { ...runtime, extensionUi: { ...runtime.extensionUi, editorText: item.text, editorRevision: item.revision as number } };
    }
    default: return runtime;
  }
}
function replaceTool(tools: ToolActivityReadModel[], tool: ToolActivityReadModel): ToolActivityReadModel[] { return [...tools.filter((item) => item.id !== tool.id), tool].slice(-100); }

export const runtimeStore = new RuntimeEventStore();
export function useRuntimeStore(): RuntimeStoreSnapshot { return useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot, runtimeStore.getSnapshot); }

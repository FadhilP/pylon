import type { AcceptedCommand, WebCommand } from "../../shared/protocol/commands.ts";
import type { HeliosBrowserInput, HeliosBrowserResult } from "../../shared/protocol/helios.ts";
import type { PromptImage, PromptTextFile, QueuedPromptPayload } from "../../shared/protocol/commands.ts";
import type { QueueReadModel, SessionRuntimeState, SlashCommandResultReadModel } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, ConversationHistoryPage, ConversationHistoryQuery, ConversationTurnIndexPage, ConversationTurnIndexQuery, FileSuggestionList, PackageListSnapshot, PackageSettingsReadModel, RuntimeSnapshot, SessionListQuery, SessionListSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFilePage } from "../../shared/protocol/snapshots.ts";
import type { UiResponse } from "./remote-ui-context.ts";

export interface RuntimeTarget {
  cwd: string;
  agentDir: string;
  repositoryRoot: string;
  sessionPath?: string;
  parentSessionPath?: string;
  parentSessionId?: string;
  inMemory?: boolean;
  projectId?: string;
}

export interface RuntimeHandle {
  sessionId: string;
  sessionGeneration: number;
}

export interface TerminalTarget extends RuntimeHandle {
  cwd: string;
}

export interface PromptInput {
  commandId: string;
  expectedGeneration: number;
  message: string;
  images?: PromptImage[];
  files?: PromptTextFile[];
  planMode?: boolean;
}

export interface QueueMutationInput {
  expectedGeneration: number;
  queueId: string;
  commandId?: string;
}

export interface FileSuggestionInput {
  query: string;
  limit?: number;
}

export interface WorkspaceFilesInput {
  query?: string;
  cursor?: string;
  limit?: number;
  refresh?: boolean;
}

export interface WorkspaceFileInput {
  path: string;
  view?: "current" | "base";
}

export interface TimelineCheckpointInput {
  checkpointId: string;
}

export interface TimelineCheckpointDiffInput extends TimelineCheckpointInput {
  path: string;
}

export interface NewSessionInput {
  parentSessionId?: string;
  projectId?: string;
  expectedGeneration?: number;
}

export interface ProjectInput {
  expectedGeneration: number;
}

export interface RemoveProjectInput extends ProjectInput {
  projectId: string;
}

export interface RenameProjectInput extends ProjectInput {
  projectId: string;
  name: string;
}

export interface ProjectArchiveInput extends ProjectInput {
  projectId: string;
}

export interface ProjectWorktreeSettingsInput extends ProjectInput {
  projectId: string;
  setupCommand: string;
}

export interface ReorderProjectInput extends ProjectInput {
  projectId: string;
  beforeProjectId?: string;
}

export interface ReorderActiveSessionInput extends ProjectInput {
  sessionId: string;
  beforeSessionId?: string;
}

export interface HandoffSessionInput {
  expectedGeneration: number;
  destination: "checkout" | "worktree";
}

export interface ApplySessionChangesInput {
  expectedGeneration: number;
  expectedRevision: string;
}

export interface SwitchSessionInput {
  sessionId: string;
}

export interface DeleteSessionInput {
  sessionId: string;
}

export interface SessionArchiveInput extends ProjectInput {
  sessionId: string;
}

export interface RenameSessionInput {
  sessionId: string;
  name: string;
}

export interface SetSessionActiveInput {
  sessionId: string;
  active: boolean;
}

export interface SetSessionPinnedInput {
  sessionId: string;
  pinned: boolean;
}

export interface ForkInput {
  expectedGeneration: number;
  entryId: string;
  name: string;
  position?: "before" | "at";
  mode?: "conversation" | "timeline";
}

export type UpdateRuntimePolicyInput = Extract<WebCommand, { type: "updateRuntimePolicy" }>;

export interface EditPromptInput extends PromptInput {
  entryId: string;
  rollbackFiles: boolean;
}

export interface RewindPromptInput {
  entryId: string;
  commandId: string;
  expectedGeneration: number;
}

export interface SetPackageEnabledInput {
  packageId: string;
  enabled: boolean;
}

export interface UpdatePackageSettingsInput {
  packageId: string;
  settings: PackageSettingsReadModel;
}

export interface SetModelInput {
  provider: string;
  modelId: string;
}

export interface SetThinkingLevelInput {
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface SetSessionControlsInput extends SetModelInput {
  thinkingLevel: SetThinkingLevelInput["level"];
}

export interface StartProviderLoginInput {
  expectedGeneration: number;
  provider: string;
  authType: "api_key" | "oauth";
}

export interface UpdateContinuityMemoryInput {
  expectedGeneration?: number;
  key: string;
  text: string;
  kind: "workflow" | "structure" | "architecture" | "warning" | "preference";
  expectedUpdatedAt: string;
}

export interface DeleteContinuityMemoryInput {
  expectedGeneration?: number;
  key: string;
  expectedUpdatedAt: string;
}

export interface ReplacementResult {
  cancelled: boolean;
  sessionId: string;
  sessionGeneration: number;
}

export type DriverEvent =
  | {
      type: "session.event";
      sessionId: string;
      sessionGeneration: number;
      payload: unknown;
    }
  | {
      type: "session.replaced" | "session.unavailable";
      sessionId: string;
      sessionGeneration: number;
      runtime: RuntimeSnapshot;
    }
  | {
      type: "ui.event";
      sessionId: string;
      sessionGeneration: number;
      payload: unknown;
    }
  | {
      type: "ui.closed";
      sessionId: string;
      sessionGeneration: number;
      requestId: string;
    }
  | {
      type: "package.event";
      sessionId: string;
      sessionGeneration: number;
      channel: string;
      payload: unknown;
      operational: RuntimeSnapshot["operational"];
    }
  | {
      type: "session.status";
      sessionId: string;
      sessionGeneration: number;
      state: SessionRuntimeState;
      completed?: boolean;
    }
  | {
      type: "projects.changed";
      sessionId: string;
      sessionGeneration: number;
    }
  | {
      type: "queue.changed";
      sessionId: string;
      sessionGeneration: number;
      queue: QueueReadModel;
    }
  | {
      type: "workspace.revision";
      sessionId: string;
      sessionGeneration: number;
      workspace: NonNullable<RuntimeSnapshot["workspace"]>;
    }
  | {
      type: "command.result";
      sessionId: string;
      sessionGeneration: number;
      result?: SlashCommandResultReadModel;
    };

export type DriverEventListener = (event: DriverEvent) => void;

export interface PiDriver {
  start(target: RuntimeTarget): Promise<RuntimeHandle>;
  snapshot(): Promise<RuntimeSnapshot>;
  terminalTarget?(): TerminalTarget;
  conversationHistory(input: ConversationHistoryQuery): Promise<ConversationHistoryPage>;
  conversationTurnIndex?(input: ConversationTurnIndexQuery): Promise<ConversationTurnIndexPage>;
  fileSuggestions(input: FileSuggestionInput): Promise<FileSuggestionList>;
  workspaceFiles?(input: WorkspaceFilesInput): Promise<WorkspaceFilePage>;
  workspaceFile?(input: WorkspaceFileInput): Promise<WorkspaceFileContent>;
  workspaceDiff?(input: WorkspaceFileInput): Promise<WorkspaceFileDiff>;
  timelineCheckpointFiles?(input: TimelineCheckpointInput): Promise<TimelineCheckpointFiles>;
  timelineCheckpointDiff?(input: TimelineCheckpointDiffInput): Promise<TimelineCheckpointDiff>;
  heliosBrowser?(input: HeliosBrowserInput): Promise<HeliosBrowserResult>;
  listSessions(input?: SessionListQuery): Promise<SessionListSnapshot>;
  listArchived(input?: ArchiveListQuery): Promise<ArchiveListSnapshot>;
  listPackages(): Promise<PackageListSnapshot>;
  prompt(input: PromptInput): Promise<AcceptedCommand>;
  queuePrompt(input: PromptInput): Promise<AcceptedCommand>;
  queuedPrompt(input: QueueMutationInput): Promise<QueuedPromptPayload>;
  restoreQueuedPrompt(input: QueueMutationInput): Promise<void>;
  steerQueuedPrompt(input: QueueMutationInput): Promise<AcceptedCommand>;
  steer(input: PromptInput): Promise<AcceptedCommand>;
  followUp(input: PromptInput): Promise<AcceptedCommand>;
  abort(): Promise<void>;
  newSession(input?: NewSessionInput): Promise<ReplacementResult>;
  addProject(input: ProjectInput): Promise<ReplacementResult>;
  removeProject(input: RemoveProjectInput): Promise<ReplacementResult>;
  renameProject(input: RenameProjectInput): Promise<void>;
  reorderProject(input: ReorderProjectInput): Promise<void>;
  archiveProject(input: ProjectArchiveInput): Promise<ReplacementResult>;
  restoreProject(input: ProjectArchiveInput): Promise<void>;
  updateProjectWorktreeSettings?(input: ProjectWorktreeSettingsInput): Promise<void>;
  handoffSession?(input: HandoffSessionInput): Promise<ReplacementResult>;
  applySessionChanges?(input: ApplySessionChangesInput): Promise<ReplacementResult>;
  switchSession(input: SwitchSessionInput): Promise<ReplacementResult>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
  archiveSession(input: SessionArchiveInput): Promise<ReplacementResult>;
  restoreSession(input: SessionArchiveInput): Promise<void>;
  renameSession(input: RenameSessionInput): Promise<void>;
  setSessionActive(input: SetSessionActiveInput): Promise<void>;
  setSessionPinned(input: SetSessionPinnedInput): Promise<void>;
  reorderActiveSession(input: ReorderActiveSessionInput): Promise<void>;
  editPrompt(input: EditPromptInput): Promise<AcceptedCommand>;
  rewindPrompt(input: RewindPromptInput): Promise<AcceptedCommand>;
  fork(input: ForkInput): Promise<ReplacementResult>;
  updateRuntimePolicy(input: UpdateRuntimePolicyInput): Promise<void>;
  setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult>;
  updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult>;
  rebuildDiscoverIndex(): Promise<void>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): void;
  setSessionControls(input: SetSessionControlsInput): Promise<void>;
  startProviderLogin?(input: StartProviderLoginInput): Promise<void>;
  cancelProviderLogin?(expectedGeneration: number): Promise<void>;
  logoutProvider?(provider: string, expectedGeneration: number): Promise<void>;
  updateContinuityMemory(input: UpdateContinuityMemoryInput): Promise<void>;
  deleteContinuityMemory(input: DeleteContinuityMemoryInput): Promise<void>;
  answerUiRequest(input: UiResponse): Promise<void>;
  keepUiRequestAlive(requestId: string, sessionGeneration: number): string | undefined | void;
  dismissCommandResult?(resultId: string, sessionGeneration: number): void;
  subscribe(listener: DriverEventListener): () => void;
  dispose(): Promise<void>;
}

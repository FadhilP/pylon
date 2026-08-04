import type { PROTOCOL_VERSION } from "./envelope.ts";
import type { ConversationReadModel, ExtensionUiReadModel, MessageReadModel, OperationalReadModel, ProviderAuthReadModel, SessionControlsReadModel, SessionMetricsReadModel, SessionRuntimeState, SlashCommandResultReadModel, UiRequestReadModel, VerifyOptionReadModel } from "./events.ts";

export type FeatureAvailability = "available" | "unavailable";

export interface RuntimeDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
}

export interface RuntimeSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  sessionGeneration: number;
  ready: boolean;
  cwdLabel: string;
  projectAvailable?: boolean;
  sessionName?: string;
  gitBranch?: string;
  activeTools: string[];
  availableTools: string[];
  optionalCapabilities: Record<string, FeatureAvailability>;
  diagnostics: RuntimeDiagnostic[];
  conversation: ConversationReadModel;
  sessionControls: SessionControlsReadModel;
  providerAuth?: ProviderAuthReadModel;
  metrics: SessionMetricsReadModel;
  discoverIndex?: DiscoverIndexReadModel;
  operational: OperationalReadModel;
  extensionUi: ExtensionUiReadModel;
  workspace?: WorkspaceReadModel;
  runtimePolicy: RuntimePolicyReadModel;
  commandResult?: SlashCommandResultReadModel;
}

export type VerifyPolicyReadModel =
  | { mode: "auto" }
  | { mode: "selected"; checks: string[] };

export type WorkspacePolicyMode = "checkout" | "worktree" | "local";
export type DialogTimeoutSeconds = number | null;
export type ToolExposureMode = "active" | "deferred" | "disabled";
export type ToolOverrideReadModel = Record<string, ToolExposureMode>;

export interface RuntimePolicyReadModel {
  revision: number;
  global: {
    timelineEnabled: boolean;
    guardEnabled: boolean;
    workspace: WorkspacePolicyMode;
    guardTimeoutSeconds: DialogTimeoutSeconds;
    clarifyTimeoutSeconds: DialogTimeoutSeconds;
    toolOverrides?: ToolOverrideReadModel;
  };
  project: {
    verify: VerifyPolicyReadModel;
    toolOverrides?: ToolOverrideReadModel;
    timelineEnabled?: boolean;
    guardEnabled?: boolean;
    workspace?: WorkspacePolicyMode;
    guardTimeoutSeconds?: DialogTimeoutSeconds;
    clarifyTimeoutSeconds?: DialogTimeoutSeconds;
  };
  session: {
    verify?: VerifyPolicyReadModel;
    toolOverrides?: ToolOverrideReadModel;
    timelineEnabled?: boolean;
    guardEnabled?: boolean;
    workspace?: WorkspacePolicyMode;
    guardTimeoutSeconds?: DialogTimeoutSeconds;
    clarifyTimeoutSeconds?: DialogTimeoutSeconds;
  };
  effective: {
    verify: VerifyPolicyReadModel;
    timelineEnabled: boolean;
    guardEnabled: boolean;
    workspace: WorkspacePolicyMode;
    guardTimeoutSeconds: DialogTimeoutSeconds;
    clarifyTimeoutSeconds: DialogTimeoutSeconds;
    toolOverrides?: ToolOverrideReadModel;
  };
  availableVerifyChecks: VerifyOptionReadModel[];
}

export interface WorkspaceReadModel {
  gitAvailable: boolean;
  mode: "worktree" | "checkout" | "local" | "non-git";
  revision?: string;
  changedCount: number;
  setupState?: "idle" | "running" | "failed";
  setupError?: string;
  checkoutOwner?: string;
  canMoveToCheckout: boolean;
  canMoveToWorktree: boolean;
  handoffUnavailableReason?: string;
  canApplyChanges: boolean;
  applyTargetBranch?: string;
  applyTargetChangedCount?: number;
  applyUnavailableReason?: string;
  applyState?: "pending" | "applying";
  lastApply?: {
    state: "applied" | "unchanged" | "conflict" | "error";
    targetBranch?: string;
    conflicts?: string[];
    message?: string;
  };
}

export interface WorkspaceFileReadModel {
  path: string;
  status?: "added" | "modified" | "deleted";
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface WorkspaceFilePage {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  revision: string;
  files: WorkspaceFileReadModel[];
  totalCount: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface WorkspaceFileContent {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  revision: string;
  path: string;
  state: "available" | "deleted" | "binary" | "oversized";
  text?: string;
  truncated?: boolean;
}

export interface WorkspaceFileDiff extends WorkspaceFileContent {
  state: "available" | "binary" | "oversized";
}

export interface TimelineCheckpointFileReadModel {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TimelineCheckpointFiles {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  checkpointId: string;
  files: TimelineCheckpointFileReadModel[];
  totalCount: number;
  truncated: boolean;
}

export interface TimelineCheckpointDiff {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  checkpointId: string;
  path: string;
  state: "text" | "binary" | "unavailable" | "oversized";
  text?: string;
  truncated?: boolean;
}

export interface StateQLHistoryEntryReadModel {
  command_id: string;
  timestamp: string;
  session_id: string;
  actor_id: string;
  command: string;
  handle: string | null;
  executed: boolean;
  cached: boolean;
  success: boolean;
  error_code: string | null;
}

export interface StateQLSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  session: {
    session_id: string;
    name: string;
    status: "active" | "closed";
  };
  actor_id: string;
  connection: {
    connection_id: string;
    name: string;
    status: "connected";
    driver: "sqlite" | "postgres" | "mysql";
    database: string;
    read_only: boolean;
  } | null;
  transaction: {
    transaction_id: string;
    owner_actor_id: string;
    state: string;
  } | null;
  state_version: string | null;
  state_confidence: "authoritative" | "transaction_snapshot" | "database_reported" | "local" | "ttl_based" | "unknown" | null;
  recent_results: Array<{
    alias: string | null;
    handle: string;
    rows: number;
  }>;
  recent_operations: Array<{
    handle: string;
    actor_id: string;
    type: string;
    affected_rows: number | null;
    status: string;
  }>;
  history: StateQLHistoryEntryReadModel[];
}

export interface DiscoverIndexReadModel {
  state: "idle" | "indexing" | "error";
  files?: number;
  symbols?: number;
  indexedAt?: string;
  error?: string;
}

export interface BootstrapSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sequence: number;
  csrfToken: string;
  runtime: RuntimeSnapshot;
  pendingUi?: UiRequestReadModel;
}

export interface ConversationHistoryQuery {
  cursor: string;
  direction?: "before" | "after" | "around";
  limit?: number;
}

export interface ConversationHistoryPage {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  sessionGeneration: number;
  messages: MessageReadModel[];
  remaining: number;
  nextCursor?: string;
  earlierCursor?: string;
  laterCursor?: string;
  atStart?: boolean;
  atEnd?: boolean;
}

export interface ConversationTurnIndexItem {
  promptId: string;
  preview: string;
  createdAt?: string;
  cursor: string;
}

export interface ConversationTurnIndexQuery {
  cursor?: string;
  direction?: "earlier" | "later";
  limit?: number;
}

export interface ConversationTurnIndexPage {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  sessionGeneration: number;
  turns: ConversationTurnIndexItem[];
  totalCount: number;
  earlierCursor?: string;
  laterCursor?: string;
}

export interface FileSuggestionList {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  available: boolean;
  paths: string[];
}

export interface SessionSummary {
  id: string;
  projectId: string;
  name?: string;
  parentSession?: { id: string; title: string };
  cwdLabel: string;
  createdAt: string;
  modifiedAt: string;
  workStartedAt?: string;
  userMessageCount: number;
  preview: string;
  active: boolean;
  pinned: boolean;
  runtimeState: SessionRuntimeState;
}

export interface SessionProjectPage {
  id: string;
  label: string;
  cwd: string;
  totalCount: number;
  sessions: SessionSummary[];
  nextCursor?: string;
}

export interface SessionListQuery {
  projectId?: string;
  cursor?: string;
  query?: string;
  limit?: number;
}

export interface SessionListSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  activeSessions: SessionSummary[];
  projects: SessionProjectPage[];
}

export interface ArchivedProjectSummary {
  id: string;
  label: string;
  sessionCount: number;
  archivedAt: string;
}

export interface ArchivedSessionSummary extends SessionSummary {
  archivedAt: string;
}

export interface ArchiveListQuery {
  cursor?: string;
  query?: string;
  limit?: number;
}

export interface ArchiveListSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  projects: ArchivedProjectSummary[];
  sessions: ArchivedSessionSummary[];
  totalSessionCount: number;
  nextCursor?: string;
}

export interface PackageSummary {
  id: string;
  name: string;
  description: string;
  required?: boolean;
  enabled: boolean;
  active: boolean;
  extensionCount: number;
  settings?: PackageSettingsReadModel;
  error?: string;
}

export type PackageModelMode = "disabled" | "session" | "model";

export type PackageSettingsReadModel =
  | {
      kind: "advisor" | "scout";
      mode: PackageModelMode;
      model?: string;
      thinking?: import("./events.ts").ThinkingLevelReadModel;
    }
  | {
      kind: "grunt";
      mode: PackageModelMode;
      model?: string;
      executionMode: "isolated" | "direct" | "dynamic";
      thinkingLevels: import("./events.ts").ThinkingLevelReadModel[];
    }
  | {
      kind: "continuity";
      memoryEnabled: boolean;
      planner?: PackageModelProfileReadModel;
      executor?: PackageModelProfileReadModel;
    }
  | {
      kind: "sieve";
      activePruning: boolean;
      threshold: number;
      projectionMode: "stable" | "legacy" | "standard-v2";
      rolloverHighMultiplier: number;
      rolloverLowMultiplier: number;
    }
  | {
      kind: "helios";
      headed: boolean;
    }
  | {
      kind: "timeline";
      editRollbackDefault: boolean;
    }
  | {
      kind: "spawn";
      agentAvailability: "deferred" | "active";
      sessionAvailability: "deferred" | "active";
      models?: string[];
      agentThinkingLevels: import("./events.ts").ThinkingLevelReadModel[];
    };

export interface PackageModelProfileReadModel {
  model: string;
  thinking?: import("./events.ts").ThinkingLevelReadModel;
}

export interface PackageListSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  packages: PackageSummary[];
}

export type HookKind = "file" | "text";

export interface HookSourceReadModel {
  id: string;
  name: string;
  kind: HookKind;
  content: string;
}

export interface HookReadModel {
  enabled: boolean;
  sources: HookSourceReadModel[];
}

/** The only web-configurable lifecycle hooks. */
export interface HookSettingsReadModel {
  sessionStart: HookReadModel;
  beforeAgentStart: HookReadModel;
}

export interface HookSettingsSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  settings: HookSettingsReadModel;
}

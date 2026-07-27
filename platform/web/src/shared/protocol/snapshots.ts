import type { PROTOCOL_VERSION } from "./envelope.ts";
import type { ConversationReadModel, ExtensionUiReadModel, MessageReadModel, OperationalReadModel, SessionControlsReadModel, SessionMetricsReadModel, SessionRuntimeState, UiRequestReadModel } from "./events.ts";

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
  metrics: SessionMetricsReadModel;
  discoverIndex?: DiscoverIndexReadModel;
  operational: OperationalReadModel;
  extensionUi: ExtensionUiReadModel;
  workspace?: WorkspaceReadModel;
}

export interface WorkspaceReadModel {
  gitAvailable: boolean;
  mode: "worktree" | "checkout" | "non-git";
  revision?: string;
  changedCount: number;
  setupState?: "idle" | "running" | "failed";
  setupError?: string;
  checkoutOwner?: string;
  canMoveToCheckout: boolean;
  canMoveToWorktree: boolean;
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
  limit?: number;
}

export interface ConversationHistoryPage {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  sessionGeneration: number;
  messages: MessageReadModel[];
  remaining: number;
  nextCursor?: string;
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
  cwdLabel: string;
  createdAt: string;
  modifiedAt: string;
  userMessageCount: number;
  preview: string;
  active: boolean;
  runtimeState: SessionRuntimeState;
}

export interface SessionProjectPage {
  id: string;
  label: string;
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
    }
  | {
      kind: "continuity";
      planner?: PackageModelProfileReadModel;
      executor?: PackageModelProfileReadModel;
    }
  | {
      kind: "sieve";
      activePruning: boolean;
      threshold: number;
    }
  | {
      kind: "helios";
      headed: boolean;
    }
  | {
      kind: "timeline";
      editRollbackDefault: boolean;
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

import type { PROTOCOL_VERSION } from "./envelope.ts";
import type { ConversationReadModel, ExtensionUiReadModel, OperationalReadModel, SessionControlsReadModel, SessionMetricsReadModel, SessionRuntimeState, UiRequestReadModel } from "./events.ts";

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
  activeTools: string[];
  availableTools: string[];
  optionalCapabilities: Record<string, FeatureAvailability>;
  diagnostics: RuntimeDiagnostic[];
  conversation: ConversationReadModel;
  sessionControls: SessionControlsReadModel;
  metrics: SessionMetricsReadModel;
  operational: OperationalReadModel;
  extensionUi: ExtensionUiReadModel;
}

export interface BootstrapSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sequence: number;
  csrfToken: string;
  runtime: RuntimeSnapshot;
  pendingUi?: UiRequestReadModel;
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
  projects: SessionProjectPage[];
}

export interface PackageSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  active: boolean;
  extensionCount: number;
  error?: string;
}

export interface PackageListSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionGeneration: number;
  packages: PackageSummary[];
}

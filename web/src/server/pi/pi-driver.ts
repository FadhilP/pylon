import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import type { PromptImage } from "../../shared/protocol/commands.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { ArchiveListQuery, ArchiveListSnapshot, PackageListSnapshot, PackageSettingsReadModel, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots.ts";
import type { UiResponse } from "./remote-ui-context.ts";

export interface RuntimeTarget {
  cwd: string;
  agentDir: string;
  repositoryRoot: string;
  sessionPath?: string;
  parentSessionPath?: string;
  inMemory?: boolean;
}

export interface RuntimeHandle {
  sessionId: string;
  sessionGeneration: number;
}

export interface PromptInput {
  commandId: string;
  expectedGeneration: number;
  message: string;
  images?: PromptImage[];
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

export interface ProjectArchiveInput extends ProjectInput {
  projectId: string;
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

export interface ForkInput {
  entryId: string;
  position?: "before" | "at";
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
    }
  | {
      type: "projects.changed";
      sessionId: string;
      sessionGeneration: number;
    };

export type DriverEventListener = (event: DriverEvent) => void;

export interface PiDriver {
  start(target: RuntimeTarget): Promise<RuntimeHandle>;
  snapshot(): Promise<RuntimeSnapshot>;
  listSessions(input?: SessionListQuery): Promise<SessionListSnapshot>;
  listArchived(input?: ArchiveListQuery): Promise<ArchiveListSnapshot>;
  listPackages(): Promise<PackageListSnapshot>;
  prompt(input: PromptInput): Promise<AcceptedCommand>;
  steer(input: PromptInput): Promise<AcceptedCommand>;
  followUp(input: PromptInput): Promise<AcceptedCommand>;
  abort(): Promise<void>;
  newSession(input?: NewSessionInput): Promise<ReplacementResult>;
  addProject(input: ProjectInput): Promise<ReplacementResult>;
  removeProject(input: RemoveProjectInput): Promise<ReplacementResult>;
  archiveProject(input: ProjectArchiveInput): Promise<ReplacementResult>;
  restoreProject(input: ProjectArchiveInput): Promise<void>;
  switchSession(input: SwitchSessionInput): Promise<ReplacementResult>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
  archiveSession(input: SessionArchiveInput): Promise<ReplacementResult>;
  restoreSession(input: SessionArchiveInput): Promise<void>;
  renameSession(input: RenameSessionInput): Promise<void>;
  setSessionActive(input: SetSessionActiveInput): Promise<void>;
  fork(input: ForkInput): Promise<ReplacementResult>;
  setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult>;
  updatePackageSettings(input: UpdatePackageSettingsInput): Promise<ReplacementResult>;
  rebuildDiscoverIndex(): Promise<void>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): void;
  updateContinuityMemory(input: UpdateContinuityMemoryInput): Promise<void>;
  deleteContinuityMemory(input: DeleteContinuityMemoryInput): Promise<void>;
  answerUiRequest(input: UiResponse): Promise<void>;
  subscribe(listener: DriverEventListener): () => void;
  dispose(): Promise<void>;
}

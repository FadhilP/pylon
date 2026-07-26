import type { AcceptedCommand } from "../../shared/protocol/commands.ts";
import type { PromptImage } from "../../shared/protocol/commands.ts";
import type { SessionRuntimeState } from "../../shared/protocol/events.ts";
import type { PackageListSnapshot, RuntimeSnapshot, SessionListQuery, SessionListSnapshot } from "../../shared/protocol/snapshots.ts";
import type { UiResponse } from "./remote-ui-context.ts";

export interface RuntimeTarget {
  cwd: string;
  agentDir: string;
  repositoryRoot: string;
  sessionPath?: string;
  parentSessionPath?: string;
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
}

export interface SwitchSessionInput {
  sessionId: string;
}

export interface DeleteSessionInput {
  sessionId: string;
}

export interface ForkInput {
  entryId: string;
  position?: "before" | "at";
}

export interface SetPackageEnabledInput {
  packageId: string;
  enabled: boolean;
}

export interface SetModelInput {
  provider: string;
  modelId: string;
}

export interface SetThinkingLevelInput {
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
    };

export type DriverEventListener = (event: DriverEvent) => void;

export interface PiDriver {
  start(target: RuntimeTarget): Promise<RuntimeHandle>;
  snapshot(): Promise<RuntimeSnapshot>;
  listSessions(input?: SessionListQuery): Promise<SessionListSnapshot>;
  listPackages(): Promise<PackageListSnapshot>;
  prompt(input: PromptInput): Promise<AcceptedCommand>;
  steer(input: PromptInput): Promise<AcceptedCommand>;
  followUp(input: PromptInput): Promise<AcceptedCommand>;
  abort(): Promise<void>;
  newSession(input?: NewSessionInput): Promise<ReplacementResult>;
  switchSession(input: SwitchSessionInput): Promise<ReplacementResult>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
  fork(input: ForkInput): Promise<ReplacementResult>;
  setPackageEnabled(input: SetPackageEnabledInput): Promise<ReplacementResult>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): void;
  answerUiRequest(input: UiResponse): Promise<void>;
  subscribe(listener: DriverEventListener): () => void;
  dispose(): Promise<void>;
}

export interface MessageReadModel {
  id: string;
  entryId?: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  streaming: boolean;
  attachmentCount?: number;
  fileAttachmentCount?: number;
  workDurationMs?: number;
  modelName?: string;
  thinkingLevel?: ThinkingLevelReadModel;
  changedFiles?: ChangedFileReadModel[];
  systemSource?: string;
  tool?: {
    id: string;
    name: string;
    input?: string;
    status: "running" | "completed" | "failed";
  };
}

export interface ChangedFileReadModel {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export type SessionRuntimeState = "sleeping" | "idle" | "running" | "attention";

export interface ToolActivityReadModel {
  id: string;
  name: string;
  input?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
}

export type DelegatedAgentKind = "advisor" | "grunt" | "repo_scout" | "web_scout";

export interface DelegatedAgentActivityReadModel {
  kind: "call" | "result";
  tool: string;
  text?: string;
  isError?: boolean;
}

export interface DelegatedAgentUsageReadModel {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface DelegatedAgentRunReadModel {
  id: string;
  kind: DelegatedAgentKind;
  agentName?: string;
  startedAt?: string;
  turn: number;
  request?: string;
  response?: string;
  status: "running" | "completed" | "failed";
  modelName?: string;
  thinkingLevel?: ThinkingLevelReadModel;
  durationMs?: number;
  usage?: DelegatedAgentUsageReadModel;
  activity: DelegatedAgentActivityReadModel[];
}

export interface QueueReadModel {
  steering: number;
  followUp: number;
  pending?: QueuedPromptReadModel;
}

export interface QueuedPromptReadModel {
  id: string;
  preview: string;
  attachmentCount: number;
  fileAttachmentCount: number;
  planMode: boolean;
  state: "queued" | "delivering";
}

export interface RetryReadModel {
  active: boolean;
  attempt?: number;
  maxAttempts?: number;
  message?: string;
}

export interface CompactionReadModel {
  active: boolean;
  reason?: "manual" | "threshold" | "overflow";
}

export interface ConversationReadModel {
  messages: MessageReadModel[];
  tools: ToolActivityReadModel[];
  delegatedRuns: DelegatedAgentRunReadModel[];
  historyCursor?: string;
  historyRemaining?: number;
  streaming: boolean;
  workStartedAt?: string;
  workModelName?: string;
  workThinkingLevel?: ThinkingLevelReadModel;
  queue: QueueReadModel;
  retry: RetryReadModel;
  compaction: CompactionReadModel;
}

export interface SessionMetricsReadModel {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  contextLimit: number;
  contextPercent: number;
  cost: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

export type ThinkingLevelReadModel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOptionReadModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels?: ThinkingLevelReadModel[];
}

export interface SessionControlsReadModel {
  model?: ModelOptionReadModel;
  models: ModelOptionReadModel[];
  thinkingLevel?: ThinkingLevelReadModel;
  thinkingLevels: ThinkingLevelReadModel[];
  commands?: SlashCommandReadModel[];
}

export interface SlashCommandReadModel {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface UiRequestReadModel {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  payload: Record<string, unknown>;
  expiresAt?: string;
  owned: boolean;
  ownershipAvailable: boolean;
}

export interface UiNotificationReadModel {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
  occurredAt: string;
}

export interface UiStatusReadModel { key: string; text: string; }
export interface UiWidgetReadModel { key: string; lines: string[]; placement?: "aboveEditor" | "belowEditor"; }

export interface ExtensionUiReadModel {
  notifications: UiNotificationReadModel[];
  statuses: UiStatusReadModel[];
  widgets: UiWidgetReadModel[];
  title?: string;
  editorText: string;
  editorRevision: number;
}

export type FeatureState = "available" | "unavailable";

export interface VerificationCheckReadModel {
  id: string;
  label: string;
  command: string;
  status: "passed" | "failed" | "error";
  durationMs: number;
  output?: string;
  truncated: boolean;
}

export interface VerificationReadModel {
  availability: FeatureState;
  state?: "running" | "passed" | "failed" | "cancelled" | "stale" | "error" | "no_checks" | "clean";
  runId?: string;
  scope?: "changed" | "project";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  checks: VerificationCheckReadModel[];
  message?: string;
}

export interface JobReadModel {
  id: string;
  label: string;
  state: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  purpose?: "verification" | "build" | "other";
  todoId?: string;
}

export interface JobsReadModel { availability: FeatureState; items: JobReadModel[]; }

export interface GuardReadModel {
  availability: FeatureState;
  decision?: string;
  reason?: string;
  blocked: number;
  confirmed: number;
}

export interface ContinuityTodoReadModel {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  updatedAt: string;
}

export interface ContinuityWorkReadModel {
  mode: "planning" | "executing" | "handed_off" | "completed" | "cancelled";
  goal: string;
  approved: boolean;
  planSummary: string;
  currentTodoId?: string;
  latestFailure?: string;
  nextAction?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  todos: ContinuityTodoReadModel[];
}

export interface ContinuityMemoryFactReadModel {
  key: string;
  kind: "workflow" | "structure" | "architecture" | "warning" | "preference";
  text: string;
  source: string;
  confidence: number;
  updatedAt: string;
  captureCommit?: string;
  branchAtCapture?: string;
  evidencePaths?: Array<{ path: string; sha256: string }>;
}

export interface ContinuityReadModel {
  availability: FeatureState;
  revision: number;
  memory: ContinuityMemoryFactReadModel[];
  work?: ContinuityWorkReadModel;
}

export interface TimelineCheckpointReadModel {
  id: string;
  title: string;
  createdAt: string;
  branch?: string;
  verified: boolean;
  ownerSessionId: string;
}

export interface TimelineReadModel { availability: FeatureState; revision: number; checkpoints: TimelineCheckpointReadModel[]; }

export interface ToolPolicyReadModel {
  owner: string;
  managedTools: string[];
  enabledTools: string[];
  deferredTools: string[];
  allowOnly?: string[];
}

export interface ToolsReadModel { availability: FeatureState; policies: ToolPolicyReadModel[]; }
export interface RuntimeHealthReadModel { status: "healthy" | "degraded" | "unavailable"; issues: string[]; }

export interface OperationalReadModel {
  verification: VerificationReadModel;
  jobs: JobsReadModel;
  guard: GuardReadModel;
  continuity: ContinuityReadModel;
  timeline: TimelineReadModel;
  tools: ToolsReadModel;
  health: RuntimeHealthReadModel;
}

export type ConnectionState = "loading" | "connected" | "disconnected" | "error";

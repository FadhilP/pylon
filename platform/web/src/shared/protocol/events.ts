export const MAX_COMPACTION_DISPLAY_RECORDS = 20;
export const MAX_COMPACTION_DISPLAY_HISTORY_ITEMS = 12;
export const MAX_COMPACTION_DISPLAY_TEXT = 2_000;
export const MAX_COMPACTION_DISPLAY_SOURCE_ID = 240;
export const MAX_COMPACTION_DISPLAY_PATH = 540;

export interface CompactionDisplaySourceReadModel {
  sourceEntryId: string;
  text: string;
}

export interface CompactionDisplayRecordReadModel extends CompactionDisplaySourceReadModel {
  role: "user" | "assistant";
}

export interface CompactionDisplayHistoryRecordReadModel {
  path: string;
  sourceEntryId?: string;
}

export interface CompactionDisplayReadModel {
  records: CompactionDisplayRecordReadModel[];
  failedTools: CompactionDisplaySourceReadModel[];
  toolResults: CompactionDisplaySourceReadModel[];
  history: {
    read: CompactionDisplayHistoryRecordReadModel[];
    modified: CompactionDisplayHistoryRecordReadModel[];
  };
}

export interface CompactionMessageReadModel {
  contextAfterTokens: number;
  contextBeforeTokens?: number;
  sourceEntryCount?: number;
  display?: CompactionDisplayReadModel;
}

export interface MessageReadModel {
  id: string;
  entryId?: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  streaming: boolean;
  createdAt?: string;
  canUndo?: boolean;
  canForkWithTimeline?: boolean;
  attachmentCount?: number;
  fileAttachmentCount?: number;
  workDurationMs?: number;
  modelName?: string;
  thinkingLevel?: ThinkingLevelReadModel;
  changedFiles?: ChangedFileReadModel[];
  systemSource?: string;
  compaction?: CompactionMessageReadModel;
  tool?: {
    id: string;
    name: string;
    input?: string;
    status: "running" | "completed" | "failed";
    startedAt?: string;
    durationMs?: number;
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
  startedAt?: string;
  durationMs?: number;
}

export type DelegatedAgentKind = "advisor" | "grunt" | "repo_scout" | "web_scout" | "spawn_agent" | "spawn_session";
export type SpawnExecutionActionReadModel = "create" | "continue" | "adopt";

export interface DelegatedAgentActivityReadModel {
  id?: string;
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
  threadId?: string;
  runId?: string;
  action?: SpawnExecutionActionReadModel;
  durationMs?: number;
  usage?: DelegatedAgentUsageReadModel;
  sessionUsage?: DelegatedAgentUsageReadModel;
  activity: DelegatedAgentActivityReadModel[];
}

export interface DelegatedAgentRunUpdateReadModel extends DelegatedAgentRunReadModel {
  activityMode?: "append";
  activityBase?: number;
}

export interface QueueReadModel {
  steering: number;
  followUp: number;
  items?: QueuedPromptReadModel[];
}

export interface QueuedPromptReadModel {
  id: string;
  commandId: string;
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
  stopping?: boolean;
  stoppedRun?: {
    turnId: string;
    userEntryId?: string;
    durationMs: number;
    modelName?: string;
    thinkingLevel?: ThinkingLevelReadModel;
  };
  agentError?: string;
  queue: QueueReadModel;
  retry: RetryReadModel;
  compaction: CompactionReadModel;
}

export interface ToolUsageReadModel {
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
}

export interface SessionMetricsReadModel {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  contextLimit: number;
  contextPercent: number;
  cost: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolUsage?: ToolUsageReadModel[];
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
  pending?: {
    model: ModelOptionReadModel;
    thinkingLevel: ThinkingLevelReadModel;
  };
  commands?: SlashCommandReadModel[];
}

export interface SlashCommandReadModel {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export type ProviderAuthType = "api_key" | "oauth";

export interface ProviderAuthReadModel {
  providers: Array<{
    id: string;
    name: string;
    configured: boolean;
    stored: boolean;
    credentialType?: ProviderAuthType;
    methods: Array<{
      type: ProviderAuthType;
      name: string;
      interactive: boolean;
    }>;
  }>;
  flow?: {
    id: string;
    providerId: string;
    providerName: string;
    authType: ProviderAuthType;
    status: "running" | "succeeded" | "failed" | "cancelled";
    message?: string;
    authUrl?: string;
    instructions?: string;
    links?: Array<{ url: string; label?: string }>;
    deviceCode?: {
      userCode: string;
      verificationUri: string;
      expiresAt?: string;
    };
  };
}

export interface UiRequestReadModel {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "questionnaire";
  payload: Record<string, unknown>;
  owned: boolean;
  ownershipAvailable: boolean;
  timeoutSeconds?: number;
  expiresAt?: string;
}

export interface SlashCommandResultReadModel {
  id: string;
  command: string;
  output: string;
  severity: "info" | "warning" | "error";
  occurredAt: string;
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

export interface VerifyOptionReadModel {
  id: string;
  label: string;
  command: string;
}

export interface JobReadModel {
  id: string;
  label: string;
  state: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out";
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
  approvalPending: boolean;
  planSummary: string;
  handoff?: {
    workingSet: string[];
    assumptions: string[];
    acceptanceCriteria: string[];
  };
  planRevision?: number;
  revisionFeedback?: { revision: number; text: string; createdAt: string };
  currentTodoId?: string;
  latestFailure?: string;
  nextAction?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  todos: ContinuityTodoReadModel[];
}

export interface PapercutSummaryReadModel {
  availability: FeatureState;
  revision: number;
  counts: { open: number; resolved: number; dismissed: number; total: number };
}


export interface ContinuityMemoryNoteReadModel {
  id: string;
  scope: "user" | "project";
  trigger: string;
  guidance: string;
  authority: "user_instruction" | "project_contract" | "imported";
  origin: "user" | "agent" | "migration";
  disposition?: "archival" | "eligible_advisory" | "eligible_enforced" | "quarantined" | "superseded" | "revoked";
  enforcementAuthority?: "context_only" | "warning" | "validation" | "blocking_guard";
  relatedPaths?: string[];
  revision: number;
  updatedAt: string;
  sourceSummary: string;
}

export interface ContinuityReadModel {
  availability: FeatureState;
  revision: number;
  memory: ContinuityMemoryNoteReadModel[];
  globalMemory: ContinuityMemoryNoteReadModel[];
  v4MigrationAvailable: boolean;
  work?: ContinuityWorkReadModel;
}

export interface TimelineCheckpointReadModel {
  id: string;
  title: string;
  createdAt: string;
  branch?: string;
  verified: boolean;
  ownerSessionId: string;
  changes?: {
    fileCount: number;
    additions: number;
    deletions: number;
    binaryCount: number;
  };
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

export interface SieveToolTransformStatsReadModel {
  scanned: number;
  transformed: number;
  sourceChars: number;
  retainedChars: number;
  netCharsSaved: number;
}

export interface SieveTransformStatsReadModel {
  scanned: number;
  transformed: number;
  omittedChars: number;
  netCharsSaved: number;
  transformedBy: {
    ageThreshold: number;
    budget: number;
    giantError: number;
    activeThreshold: number;
    staleRead: number;
    duplicate: number;
    errorCap: number;
    mixedText: number;
  };
  byTool: Record<string, SieveToolTransformStatsReadModel>;
}

export interface SieveReadModel {
  availability: FeatureState;
  mode?: "enabled" | "observe" | "disabled";
  projectionMode?: "stable" | "legacy" | "standard-v2";
  threshold?: number;
  activePruning?: boolean;
  latestMode?: "enabled" | "observe";
  latest?: SieveTransformStatsReadModel;
  cumulativeActual?: SieveTransformStatsReadModel;
  cumulativeProjected?: SieveTransformStatsReadModel;
  recalls?: number;
  recalledChars?: number;
  recallsByTool?: Record<string, { recalls: number; recalledChars: number }>;
  epoch?: {
    id?: string;
    reason?: string;
    startedAt?: string;
    promptFingerprint?: string;
    frozenResultCount: number;
    frozenSourceChars: number;
    frozenRetainedChars: number;
    rolloverEligibleRetainedChars: number;
    recoverableEntries: number;
  };
  stability?: {
    newProjections: number;
    projectionCacheHits: number;
    recoverableEntries: number;
    explicitReflows: number;
    softBudgetExceedances: number;
    prefixChurnViolations: number;
    estimatedInvalidatedChars: number;
    earliestChangedPriorMessageIndex?: number;
    standardComparisons?: number;
    standardPrefixChurn?: number;
    standardEarliestChangedPriorMessageIndex?: number;
    standardEstimatedInvalidatedChars?: number;
    standardChangesByKind?: {
      activeThreshold: number;
      ageThreshold: number;
      budget: number;
      staleRead: number;
      duplicate: number;
      errorCap: number;
      history: number;
    };
  };
  contextUsagePercent?: number;
  updatedAt?: string;
  error?: string;
}

export interface RuntimeHealthReadModel { status: "healthy" | "degraded" | "unavailable"; issues: string[]; }

export interface OperationalReadModel {
  verification: VerificationReadModel;
  jobs: JobsReadModel;
  guard: GuardReadModel;
  continuity: ContinuityReadModel;
  papercuts: PapercutSummaryReadModel;
  timeline: TimelineReadModel;
  tools: ToolsReadModel;
  sieve: SieveReadModel;
  health: RuntimeHealthReadModel;
}

export type ConnectionState = "loading" | "connected" | "disconnected";

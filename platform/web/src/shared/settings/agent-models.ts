/** Project-scoped agent-model overrides. Absent keys inherit the global package defaults. */

export const AGENT_MODEL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentModelThinkingLevel = (typeof AGENT_MODEL_THINKING_LEVELS)[number];

export interface AgentModelProfile {
  model: string;
  thinking?: AgentModelThinkingLevel;
}

export interface ProjectAgentModels {
  continuity?: {
    planner?: AgentModelProfile;
    executor?: AgentModelProfile;
    memoryReviewer?: AgentModelProfile;
    compactionReviewer?: AgentModelProfile;
  };
  advisor?: {
    model?: string;
    thinking?: AgentModelThinkingLevel;
    useMainModel?: boolean;
  };
}

/* Spawn allowlists and the delegate naming model stay global for now: they load
   once at extension setup, before project policy is published, so the
   event-override pattern used here does not reach them. */

const MAX_MODEL_REF_LENGTH = 200;

const isThinkingLevel = (value: unknown): value is AgentModelThinkingLevel =>
  typeof value === "string" &&
  (AGENT_MODEL_THINKING_LEVELS as readonly string[]).includes(value);

/** A non-empty `provider/model` reference. Model ids may contain additional slashes. */
const validModelRef = (value: unknown): value is string => {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > MAX_MODEL_REF_LENGTH) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
};

const validProfile = (value: unknown): value is AgentModelProfile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!validModelRef(record.model)) return false;
  if (record.thinking !== undefined && !isThinkingLevel(record.thinking)) return false;
  return Object.keys(record).every(key => key === "model" || key === "thinking");
};

const validAdvisor = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    (record.model !== undefined && !validModelRef(record.model)) ||
    (record.thinking !== undefined && !isThinkingLevel(record.thinking)) ||
    (record.useMainModel !== undefined && typeof record.useMainModel !== "boolean") ||
    (record.model !== undefined && record.useMainModel === true)
  )
    return false;
  return Object.keys(record).every(key => key === "model" || key === "thinking" || key === "useMainModel");
};

/** Sparse project overrides; unknown keys are rejected and empty values mean inherit. */
export function validProjectAgentModels(value: unknown): value is ProjectAgentModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every(key => ["continuity", "advisor"].includes(key))) return false;
  if (record.continuity !== undefined) {
    const continuity = record.continuity as Record<string, unknown>;
    if (!continuity || typeof continuity !== "object" || Array.isArray(continuity)) return false;
    if (
      !Object.keys(continuity).every(key =>
        ["planner", "executor", "memoryReviewer", "compactionReviewer"].includes(key),
      ) ||
      Object.values(continuity).some(profile => !validProfile(profile))
    )
      return false;
  }
  if (record.advisor !== undefined && !validAdvisor(record.advisor)) return false;
  return true;
}

const cloneProfile = (profile: AgentModelProfile): AgentModelProfile => ({
  model: profile.model,
  ...(profile.thinking ? { thinking: profile.thinking } : {}),
});

export function cloneProjectAgentModels(value: ProjectAgentModels | undefined): ProjectAgentModels | undefined {
  if (!value) return undefined;
  const continuityEntries = Object.entries(value.continuity ?? {});
  const advisor = value.advisor && Object.keys(value.advisor).length ? { ...value.advisor } : undefined;
  const clone: ProjectAgentModels = {
    ...(continuityEntries.length
      ? {
          continuity: Object.fromEntries(
            continuityEntries.map(([role, profile]) => [role, cloneProfile(profile)]),
          ) as ProjectAgentModels["continuity"],
        }
      : {}),
    ...(advisor ? { advisor } : {}),
  };
  return Object.keys(clone).length ? clone : undefined;
}

/** Merge sparse scopes. Continuity roles inherit independently; Advisor mode replaces as one choice. */
export function mergeProjectAgentModels(
  base: ProjectAgentModels | undefined,
  override: ProjectAgentModels | undefined,
): ProjectAgentModels | undefined {
  const continuity = { ...(base?.continuity ?? {}), ...(override?.continuity ?? {}) };
  const advisor = { ...(base?.advisor ?? {}), ...(override?.advisor ?? {}) };
  if (override?.advisor?.model !== undefined) delete advisor.useMainModel;
  else if (override?.advisor?.useMainModel !== undefined) delete advisor.model;
  return cloneProjectAgentModels({
    ...(Object.keys(continuity).length ? { continuity } : {}),
    ...(Object.keys(advisor).length ? { advisor } : {}),
  });
}

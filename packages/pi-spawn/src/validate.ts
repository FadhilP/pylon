import { SPAWN_TOOLS, SPECIALIST_TOOLS } from "./constants.ts";
import type { SpawnKind } from "./sessions.ts";

const creationOnlyAgentFields = (params: any) =>
  params.name !== undefined ||
  params.model !== undefined ||
  params.thinking !== undefined ||
  params.systemPrompt !== undefined ||
  params.tools !== undefined ||
  params.disableSpecialists !== undefined;
const creationOnlySessionFields = (params: any) =>
  params.name !== undefined || params.model !== undefined;
const runControlFields = (params: any) =>
  params.runId !== undefined || params.background !== undefined;
const creationOnlyFields = (kind: SpawnKind, params: any) =>
  kind === "agent"
    ? creationOnlyAgentFields(params)
    : creationOnlySessionFields(params) || params.project !== undefined;

/** Returns a user-facing message when the parameters are wrong for the requested action. */
type Rule = (kind: SpawnKind, params: any) => string | undefined;

const create: Rule = (kind, params) => {
  if (params.id !== undefined || params.runId !== undefined)
    return `${kind} create does not accept id or runId.`;
  if (!params.prompt?.trim()) return `${kind} create requires prompt.`;
  if (params.limit !== undefined || params.maxChars !== undefined)
    return `${kind} create does not accept recent limits.`;
  if (
    kind === "session" &&
    params.project !== undefined &&
    !params.project.trim()
  )
    return "session project must not be empty.";
  if (kind !== "agent" || params.tools === undefined) return;
  const excluded = new Set([
    ...SPAWN_TOOLS,
    ...(params.disableSpecialists === false ? [] : SPECIALIST_TOOLS),
  ]);
  const forbidden = params.tools.find((tool: string) => excluded.has(tool));
  if (forbidden)
    return `Agent tool allowlist cannot include excluded tool: ${forbidden}.`;
};

const adopt: Rule = (kind, params) => {
  if (kind !== "session") return "Only standard sessions can be adopted.";
  if (!params.id) return "session adopt requires id.";
  if (params.runId !== undefined) return "session adopt does not accept runId.";
  if (!params.prompt?.trim()) return "session adopt requires prompt.";
  if (params.project !== undefined && !params.project.trim())
    return "session project must not be empty.";
  if (creationOnlySessionFields(params))
    return "Session name and model cannot be changed on adopt.";
};

const proceed: Rule = (kind, params) => {
  if (!params.id) return `${kind} continue requires id.`;
  if (params.runId !== undefined)
    return `${kind} continue does not accept runId.`;
  if (!params.prompt?.trim()) return `${kind} continue requires prompt.`;
  if (params.limit !== undefined || params.maxChars !== undefined)
    return `${kind} continue does not accept recent limits.`;
  if (kind === "agent" && creationOnlyAgentFields(params))
    return "Agent creation policy cannot change on continue.";
  if (kind === "session" && creationOnlyFields(kind, params))
    return "Session name, model, and project can only be set on create or adopt.";
};

const collect: Rule = (kind, params) => {
  if (!params.id || !params.runId)
    return `${kind} ${params.action} requires id and runId.`;
  if (
    params.prompt !== undefined ||
    params.background !== undefined ||
    params.limit !== undefined ||
    params.maxChars !== undefined ||
    creationOnlyFields(kind, params)
  )
    return `${kind} ${params.action} accepts only id and runId.`;
};

const recent: Rule = (kind, params) => {
  if (kind !== "agent")
    return "Only private agents support recent transcript inspection.";
  if (!params.id) return "agent recent requires id.";
  if (
    params.prompt !== undefined ||
    runControlFields(params) ||
    creationOnlyAgentFields(params)
  )
    return "agent recent does not accept prompts, runs, or creation fields.";
  if (
    params.limit !== undefined &&
    (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)
  )
    return "agent recent limit must be an integer between 1 and 50.";
  if (
    params.maxChars !== undefined &&
    (!Number.isInteger(params.maxChars) ||
      params.maxChars < 80 ||
      params.maxChars > 2_000)
  )
    return "agent recent maxChars must be an integer between 80 and 2000.";
};

const list: Rule = (kind, params) => {
  if (
    params.id !== undefined ||
    params.prompt !== undefined ||
    params.limit !== undefined ||
    params.maxChars !== undefined ||
    runControlFields(params) ||
    creationOnlyFields(kind, params)
  )
    return `${kind} list does not accept thread, run, recent, or creation fields.`;
};

const rules: Record<string, Rule> = {
  create,
  adopt,
  continue: proceed,
  status: collect,
  cancel: collect,
  recent,
  list,
};

export function invalidInput(kind: SpawnKind, params: any): string | undefined {
  const rule = rules[params.action];
  return rule ? rule(kind, params) : `Unknown ${kind} action.`;
}

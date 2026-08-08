export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type Todo = {
  id: string;
  text: string;
  status: TodoStatus;
  updatedAt: string;
};
export type WorkIssue = {
  kind: "verification" | "background" | "manual";
  id?: string;
};
export type PlanHandoff = {
  workingSet: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
};
export type ApprovalTransition = {
  token: string;
  revision: number;
  resetContext: boolean;
  executorModel: { provider: string; id: string };
  thinking?: string;
  createdAt: string;
};
export type PlanRevisionFeedback = {
  revision: number;
  text: string;
  createdAt: string;
};
export type PlanTodoInput = string | { id?: string; text: string };
export type Work = {
  schemaVersion: 1;
  mode: "planning" | "executing" | "handed_off" | "completed" | "cancelled";
  goal: string;
  approved: boolean;
  constraints: string[];
  planSummary: string;
  handoff?: PlanHandoff;
  todos: Todo[];
  currentTodoId?: string;
  latestFailure?: string;
  nextAction?: string;
  issue?: WorkIssue;
  runId?: string;
  timelineId?: string;
  planRevision?: number;
  offeredPlanRevision?: number;
  approval?: ApprovalTransition;
  revisionFeedback?: PlanRevisionFeedback;
  baseModel?: { provider: string; id: string };
  baseThinking?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
const modes = new Set([
  "planning",
  "executing",
  "handed_off",
  "completed",
  "cancelled",
]);
const statuses = new Set(["pending", "in_progress", "done", "blocked"]);
const normalizedTodoText = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const stringList = (value: unknown, maxItems: number, maxLength: number) =>
  Array.isArray(value) && value.length <= maxItems && value.every(
    (item) => typeof item === "string" && item.length > 0 && item.length <= maxLength,
  );
export function isWork(value: any): value is Work {
  return Boolean(
    value &&
      value.schemaVersion === 1 &&
      modes.has(value.mode) &&
      typeof value.goal === "string" &&
      typeof value.approved === "boolean" &&
      Array.isArray(value.constraints) &&
      value.constraints.every((item: unknown) => typeof item === "string") &&
      typeof value.planSummary === "string" &&
      (value.handoff === undefined ||
        (stringList(value.handoff?.workingSet, 20, 240) &&
          stringList(value.handoff?.assumptions, 12, 500) &&
          stringList(value.handoff?.acceptanceCriteria, 12, 500))) &&
      Array.isArray(value.todos) &&
      value.todos.every(
        (todo: any) =>
          typeof todo?.id === "string" &&
          typeof todo.text === "string" &&
          statuses.has(todo.status) &&
          typeof todo.updatedAt === "string",
      ) &&
      new Set(value.todos.map((todo: Todo) => todo.id)).size ===
        value.todos.length &&
      new Set(value.todos.map((todo: Todo) => normalizedTodoText(todo.text))).size ===
        value.todos.length &&
      (value.currentTodoId === undefined ||
        value.todos.some((todo: Todo) => todo.id === value.currentTodoId)) &&
      (value.latestFailure === undefined ||
        typeof value.latestFailure === "string") &&
      (value.nextAction === undefined || typeof value.nextAction === "string") &&
      (value.issue === undefined ||
        (["verification", "background", "manual"].includes(value.issue?.kind) &&
          (value.issue.id === undefined || typeof value.issue.id === "string"))) &&
      (value.runId === undefined ||
        (typeof value.runId === "string" && value.runId.length > 0)) &&
      (value.timelineId === undefined ||
        (typeof value.timelineId === "string" && value.timelineId.length > 0)) &&
      (value.planRevision === undefined ||
        (Number.isInteger(value.planRevision) && value.planRevision > 0)) &&
      (value.offeredPlanRevision === undefined ||
        (Number.isInteger(value.offeredPlanRevision) &&
          value.offeredPlanRevision > 0 &&
          (value.planRevision === undefined ||
            value.offeredPlanRevision <= value.planRevision))) &&
      (value.approval === undefined ||
        (["planning", "executing"].includes(value.mode) &&
          typeof value.approval?.token === "string" &&
          value.approval.token.length > 0 &&
          Number.isInteger(value.approval.revision) &&
          value.approval.revision > 0 &&
          value.approval.revision === value.planRevision &&
          typeof value.approval.resetContext === "boolean" &&
          typeof value.approval.executorModel?.provider === "string" &&
          typeof value.approval.executorModel?.id === "string" &&
          (value.approval.thinking === undefined || typeof value.approval.thinking === "string") &&
          typeof value.approval.createdAt === "string")) &&
      (value.revisionFeedback === undefined ||
        (Number.isInteger(value.revisionFeedback?.revision) &&
          value.revisionFeedback.revision > 0 &&
          (value.planRevision === undefined || value.revisionFeedback.revision <= value.planRevision) &&
          typeof value.revisionFeedback.text === "string" &&
          value.revisionFeedback.text.length > 0 &&
          typeof value.revisionFeedback.createdAt === "string")) &&
      (value.baseModel === undefined ||
        (typeof value.baseModel?.provider === "string" &&
          typeof value.baseModel?.id === "string")) &&
      (value.baseThinking === undefined || typeof value.baseThinking === "string") &&
      (value.completedAt === undefined || typeof value.completedAt === "string") &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string"
  );
}
export function sessionWorkFile(sessionId: string) {
  return `${encodeURIComponent(sessionId)}.json`;
}
export function fresh(goal = ""): Work {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    mode: "planning",
    goal,
    approved: false,
    constraints: [],
    planSummary: "",
    todos: [],
    createdAt: now,
    updatedAt: now,
  };
}
export function setPlan(
  work: Work,
  inputs: PlanTodoInput[],
  now = new Date().toISOString(),
) {
  if (inputs.length > 12) throw Error("Plan cannot contain more than 12 todos.");
  const items = inputs.map((input) =>
    typeof input === "string" ? { text: input } : input,
  );
  const normalized = items.map((item) => normalizedTodoText(item.text));
  if (normalized.some((text) => !text) || new Set(normalized).size !== items.length)
    throw Error("Plan todos must have unique non-empty text.");

  const oldById = new Map(work.todos.map((todo) => [todo.id, todo]));
  const oldByText = new Map(work.todos.map((todo) => [normalizedTodoText(todo.text), todo]));
  const suppliedIds = items.flatMap((item) => item.id ? [item.id] : []);
  if (work.todos.length && (
    new Set(suppliedIds).size !== suppliedIds.length ||
    suppliedIds.some((id) => !oldById.has(id))
  )) throw Error("Plan todo IDs must be unique IDs from the current plan.");

  let next =
    Math.max(
      0,
      ...work.todos.map((t) => Number(t.id.match(/^todo_(\d+)$/)?.[1]) || 0),
    ) + 1;
  const usedIds = new Set<string>();
  work.todos = items.map((item, index) => {
    const prior = item.id ? oldById.get(item.id) : oldByText.get(normalized[index]!);
    if (prior && usedIds.has(prior.id))
      throw Error("Plan todo IDs cannot be reused.");
    if (prior) usedIds.add(prior.id);
    return prior
      ? { ...prior, text: item.text, updatedAt: now }
      : { id: `todo_${next++}`, text: item.text, status: "pending", updatedAt: now };
  });
  if (
    work.currentTodoId &&
    !work.todos.some((t) => t.id === work.currentTodoId)
  )
    work.currentTodoId = undefined;
}
export function updateTodo(
  work: Work,
  id: string,
  status: TodoStatus,
  now = new Date().toISOString(),
) {
  const todo = work.todos.find((t) => t.id === id);
  if (!todo) return false;
  todo.status = status;
  todo.updatedAt = now;
  if (status === "in_progress") work.currentTodoId = id;
  else if (work.currentTodoId === id) work.currentTodoId = undefined;
  return true;
}
export function hasRemainingTodos(work: Work) {
  return work.todos.some((t) => t.status !== "done");
}

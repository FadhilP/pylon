import { integer, oneOf, optional, stringList } from "./validate.ts";
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type Todo = { id: string; text: string; status: TodoStatus; updatedAt: string };
export type WorkIssue = { kind: "verification" | "background" | "manual"; id?: string };
export type PlanHandoff = { workingSet: string[]; assumptions: string[]; acceptanceCriteria: string[] };
export type ApprovalTransition = {
  token: string;
  revision: number;
  resetContext: boolean;
  executorModel: { provider: string; id: string };
  thinking?: string;
  createdAt: string;
};
export type PlanRevisionFeedback = { revision: number; text: string; createdAt: string };
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
const modes = oneOf("planning", "executing", "handed_off", "completed", "cancelled");
const statuses = oneOf("pending", "in_progress", "done", "blocked");
const normalizedTodoText = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const nonEmpty = (value: unknown) => typeof value === "string" && value.length > 0;
const isModelRef = (value: any) => typeof value?.provider === "string" && typeof value?.id === "string";

const validTodos = (todos: any) => {
  if (!Array.isArray(todos)) return false;
  const shaped = todos.every(
    (todo: any) =>
      typeof todo?.id === "string" &&
      typeof todo.text === "string" &&
      statuses(todo.status) &&
      typeof todo.updatedAt === "string",
  );
  if (!shaped) return false;
  // IDs and normalized text must both be unique: duplicates make todo transitions ambiguous.
  return (
    new Set(todos.map((todo: Todo) => todo.id)).size === todos.length &&
    new Set(todos.map((todo: Todo) => normalizedTodoText(todo.text))).size === todos.length
  );
};

const validHandoff = (handoff: any) =>
  stringList(handoff?.workingSet, 20, 240) &&
  stringList(handoff?.assumptions, 12, 500) &&
  stringList(handoff?.acceptanceCriteria, 12, 500);

/** An approval is only meaningful while planning or executing, and only for the current revision. */
const validApproval = (approval: any, value: any) =>
  ["planning", "executing"].includes(value.mode) &&
  nonEmpty(approval?.token) &&
  integer(approval.revision, 1) &&
  approval.revision === value.planRevision &&
  typeof approval.resetContext === "boolean" &&
  isModelRef(approval.executorModel) &&
  optional(approval.thinking, thinking => typeof thinking === "string") &&
  typeof approval.createdAt === "string";

const validRevisionFeedback = (feedback: any, planRevision: any) =>
  integer(feedback?.revision, 1) &&
  (planRevision === undefined || feedback.revision <= planRevision) &&
  nonEmpty(feedback.text) &&
  typeof feedback.createdAt === "string";

export function isWork(value: any): value is Work {
  if (!value || value.schemaVersion !== 1 || !modes(value.mode)) return false;
  if (typeof value.goal !== "string" || typeof value.approved !== "boolean") return false;
  if (typeof value.planSummary !== "string") return false;
  if (!Array.isArray(value.constraints) || !value.constraints.every((item: unknown) => typeof item === "string"))
    return false;
  if (!optional(value.handoff, handoff => validHandoff(handoff))) return false;
  if (!validTodos(value.todos)) return false;
  if (!optional(value.currentTodoId, id => value.todos.some((todo: Todo) => todo.id === id))) return false;
  if (!optional(value.latestFailure, text => typeof text === "string")) return false;
  if (!optional(value.nextAction, text => typeof text === "string")) return false;
  if (
    !optional(
      value.issue,
      issue =>
        ["verification", "background", "manual"].includes(issue?.kind) &&
        optional(issue.id, id => typeof id === "string"),
    )
  )
    return false;
  if (!optional(value.runId, nonEmpty)) return false;
  if (!optional(value.timelineId, nonEmpty)) return false;
  if (!optional(value.planRevision, revision => integer(revision, 1))) return false;
  if (
    !optional(
      value.offeredPlanRevision,
      offered => integer(offered, 1) && (value.planRevision === undefined || offered <= value.planRevision),
    )
  )
    return false;
  if (!optional(value.approval, approval => validApproval(approval, value))) return false;
  if (!optional(value.revisionFeedback, feedback => validRevisionFeedback(feedback, value.planRevision))) return false;
  if (!optional(value.baseModel, isModelRef)) return false;
  if (!optional(value.baseThinking, thinking => typeof thinking === "string")) return false;
  if (!optional(value.completedAt, at => typeof at === "string")) return false;
  return typeof value.createdAt === "string" && typeof value.updatedAt === "string";
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
export function setPlan(work: Work, inputs: PlanTodoInput[], now = new Date().toISOString()) {
  if (inputs.length > 12) throw Error("Plan cannot contain more than 12 todos.");
  const items = inputs.map(input => (typeof input === "string" ? { text: input } : input));
  const normalized = items.map(item => normalizedTodoText(item.text));
  if (normalized.some(text => !text) || new Set(normalized).size !== items.length)
    throw Error("Plan todos must have unique non-empty text.");

  const oldById = new Map(work.todos.map(todo => [todo.id, todo]));
  const oldByText = new Map(work.todos.map(todo => [normalizedTodoText(todo.text), todo]));
  const suppliedIds = items.flatMap(item => (item.id ? [item.id] : []));
  if (
    work.todos.length &&
    (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some(id => !oldById.has(id)))
  )
    throw Error("Plan todo IDs must be unique IDs from the current plan.");

  let next = Math.max(0, ...work.todos.map(t => Number(t.id.match(/^todo_(\d+)$/)?.[1]) || 0)) + 1;
  const usedIds = new Set<string>();
  work.todos = items.map((item, index) => {
    const prior = item.id ? oldById.get(item.id) : oldByText.get(normalized[index]!);
    if (prior && usedIds.has(prior.id)) throw Error("Plan todo IDs cannot be reused.");
    if (prior) usedIds.add(prior.id);
    return prior
      ? { ...prior, text: item.text, updatedAt: now }
      : { id: `todo_${next++}`, text: item.text, status: "pending", updatedAt: now };
  });
  if (work.currentTodoId && !work.todos.some(t => t.id === work.currentTodoId)) work.currentTodoId = undefined;
}
export function updateTodo(work: Work, id: string, status: TodoStatus, now = new Date().toISOString()) {
  const todo = work.todos.find(t => t.id === id);
  if (!todo) return false;
  todo.status = status;
  todo.updatedAt = now;
  if (status === "in_progress") work.currentTodoId = id;
  else if (work.currentTodoId === id) work.currentTodoId = undefined;
  return true;
}
export function hasRemainingTodos(work: Work) {
  return work.todos.some(t => t.status !== "done");
}

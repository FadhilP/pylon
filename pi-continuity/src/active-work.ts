export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type Todo = {
  id: string;
  text: string;
  status: TodoStatus;
  updatedAt: string;
};
export type Work = {
  schemaVersion: 1;
  mode: "planning" | "executing" | "handed_off" | "completed" | "cancelled";
  goal: string;
  approved: boolean;
  constraints: string[];
  planSummary: string;
  todos: Todo[];
  currentTodoId?: string;
  latestFailure?: string;
  nextAction?: string;
  runId?: string;
  planRevision?: number;
  offeredPlanRevision?: number;
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
      (value.currentTodoId === undefined ||
        value.todos.some((todo: Todo) => todo.id === value.currentTodoId)) &&
      (value.latestFailure === undefined ||
        typeof value.latestFailure === "string") &&
      (value.nextAction === undefined || typeof value.nextAction === "string") &&
      (value.runId === undefined || typeof value.runId === "string") &&
      (value.planRevision === undefined ||
        (Number.isInteger(value.planRevision) && value.planRevision > 0)) &&
      (value.offeredPlanRevision === undefined ||
        (Number.isInteger(value.offeredPlanRevision) &&
          value.offeredPlanRevision > 0 &&
          (value.planRevision === undefined ||
            value.offeredPlanRevision <= value.planRevision))) &&
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
  texts: string[],
  now = new Date().toISOString(),
) {
  const old = new Map(work.todos.map((t) => [t.text.trim(), t]));
  let next =
    Math.max(
      0,
      ...work.todos.map((t) => Number(t.id.match(/^todo_(\d+)$/)?.[1]) || 0),
    ) + 1;
  work.todos = texts.slice(0, 12).map((text) => {
    const prior = old.get(text.trim());
    return prior
      ? { ...prior, text, updatedAt: now }
      : { id: `todo_${next++}`, text, status: "pending", updatedAt: now };
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

import type { Work } from "./active-work.ts";
import type { Fact } from "./memory.ts";
const words = (s: string) =>
  new Set(s.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []);
const identifiers = (s: string) =>
  new Set(
    s.toLowerCase().match(
      /[a-z0-9_-]+(?:[./][a-z0-9_.-]+)+|[a-z][a-z0-9]*_[a-z0-9_]+/g,
    ) || [],
  );
export function buildContext(
  work: Work | undefined,
  facts: Fact[],
  latest = "",
  budget = 450,
  parent: Fact[] = [],
) {
  const queryText =
      `${latest} ${work?.goal || ""} ${work?.todos.find((t) => t.id === work.currentTodoId)?.text || ""}`,
    query = words(queryText),
    queryIdentifiers = identifiers(queryText),
    score = (f: Fact) =>
      [...words(`${f.key} ${f.text}`)].filter((w) => query.has(w)).length,
    strongMatch = (f: Fact) =>
      [...identifiers(`${f.key} ${f.text}`)].some((value) =>
        queryIdentifiers.has(value),
      );
  const relevant = (fact: Fact) =>
    fact.kind === "preference" || score(fact) >= 2 || strongMatch(fact);
  const selected = facts.filter(relevant).sort(
    (a, b) =>
      Number(b.kind === "preference") - Number(a.kind === "preference") ||
      score(b) - score(a) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  const lines = [
    "Continuity state. Memory may be stale; direct instructions and repository evidence win.",
  ];
  if (work) {
    const remaining = work.todos.filter((todo) => todo.status !== "done");
    const done = work.todos.filter((todo) => todo.status === "done");
    lines.push(
      `Work: ${work.mode}; goal: ${work.goal.slice(0, 500)}`,
      ...remaining.slice(0, 6).map((todo) => `Todo ${todo.id} [${todo.status}]: ${todo.text}`),
      done.length ? `Done: ${done.map((todo) => todo.id).join(", ")}` : "",
      work.latestFailure ? `Blocked: ${work.latestFailure}` : "",
      work.nextAction ? `Next: ${work.nextAction}` : "",
      ...work.constraints.slice(0, 4).map((x) => `Constraint: ${x}`),
      work.planSummary ? `Plan: ${work.planSummary.slice(0, 800)}` : "",
    );
  }
  lines.push(
    ...selected.slice(0, 3).map((f) => `Memory ${f.key}: ${f.text}`),
    ...parent
      .filter(relevant)
      .sort(
        (a, b) =>
          Number(b.kind === "preference") - Number(a.kind === "preference") ||
          score(b) - score(a),
      )
      .slice(0, 2)
      .map((f) => `Parent memory ${f.key}: ${f.text}`),
  );
  const content = lines.filter(Boolean);
  if (content.length === 1) return "";
  return content.join("\n").slice(0, budget * 4);
}

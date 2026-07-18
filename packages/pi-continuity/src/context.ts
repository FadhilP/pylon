import type { Work } from "./active-work.ts";
import type { Fact, FactStatus } from "./memory.ts";
export type MemoryNotice = { key: string; status: Extract<FactStatus, "suspect" | "unverifiable">; reason: string };
const aliases: Record<string, string> = {
  check: "test", validate: "test", validation: "test", verify: "test", verification: "test",
  deploy: "release", publish: "release", ship: "release",
  bundle: "build", compile: "build",
  configuration: "config", setting: "config",
};
const normalizeWord = (word: string) => {
  let value = word;
  if (value.length > 4 && value.endsWith("ies")) value = `${value.slice(0, -3)}y`;
  else if (value.length > 5 && value.endsWith("ing")) {
    value = value.slice(0, -3);
    if (value.at(-1) === value.at(-2)) value = value.slice(0, -1);
  } else if (value.length > 4 && /(?:sses|shes|ches|xes|zes)$/.test(value)) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith("s") && !/(?:ss|us|is)$/.test(value)) value = value.slice(0, -1);
  return aliases[value] ?? value;
};
const words = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []).map(normalizeWord));
const identifiers = (s: string) =>
  new Set(
    s.toLowerCase().match(
      /[a-z0-9_-]+(?:[./][a-z0-9_.-]+)+|[a-z][a-z0-9]*_[a-z0-9_]+/g,
    ) || [],
  );
export function shortlistFacts(facts: Fact[], latest = "", work?: Work, limit = 3) {
  const queryText = `${latest} ${work?.goal || ""} ${work?.todos.find((t) => t.id === work.currentTodoId)?.text || ""}`,
    query = words(queryText), queryIdentifiers = identifiers(queryText),
    score = (fact: Fact) => [...words(`${fact.key} ${fact.text}`)].filter((word) => query.has(word)).length,
    strongMatch = (fact: Fact) => [...identifiers(`${fact.key} ${fact.text}`)].some((value) => queryIdentifiers.has(value)),
    rank = (a: Fact, b: Fact) => Number(strongMatch(b)) - Number(strongMatch(a)) ||
      score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt),
    reservedPreference = facts.filter((fact) => fact.kind === "preference").sort(rank)[0],
    relevant = facts.filter((fact) => fact !== reservedPreference && (score(fact) >= 2 || strongMatch(fact))).sort(rank);
  return [...(reservedPreference ? [reservedPreference] : []), ...relevant].slice(0, limit);
}
export function buildContext(
  work: Work | undefined,
  facts: Fact[],
  latest = "",
  budget = 450,
  parent: Fact[] = [],
  notices: MemoryNotice[] = [],
) {
  const selected = shortlistFacts(facts, latest, work, 3);
  const selectedParent = shortlistFacts(parent, latest, work, 2);
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
    ...selectedParent.map((f) => `Parent memory ${f.key}: ${f.text}`),
  );
  const content = lines.filter(Boolean), noticeLines = notices.slice(0, 2)
    .map((notice) => `Memory ${notice.key.slice(0, 80)} [${notice.status}]: ${notice.reason.slice(0, 120)}. Inspect evidence; ancestry or age alone never justifies deletion.`);
  if (content.length === 1 && !noticeLines.length) return "";
  const max = budget * 4, noticeText = noticeLines.join("\n"),
    noticeBudget = Math.min(Math.floor(max * 0.45), 420), clippedNotice = noticeText.slice(0, noticeBudget),
    bodyBudget = Math.max(0, max - clippedNotice.length - (clippedNotice ? 1 : 0));
  return [content.join("\n").slice(0, bodyBudget), clippedNotice].filter(Boolean).join("\n");
}

import type { Work } from "./active-work.ts";
import type { Fact, FactStatus } from "./memory.ts";
const aliases: Record<string, string> = {
  check: "test", validate: "test", validation: "test", verify: "test", verification: "test",
  deploy: "release", publish: "release", ship: "release",
  bundle: "build", compile: "build",
  configuration: "config", setting: "config",
};
const ignoredWords = new Set([
  "about", "and", "could", "from", "have", "into", "just", "now", "please", "right",
  "should", "than", "that", "then", "these", "this", "those", "would", "with",
]);
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
const words = (s: string) => new Set(
  (s.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])
    .map(normalizeWord)
    .filter((word) => !ignoredWords.has(word)),
);
const identifiers = (s: string) => new Set(
  s.toLowerCase().match(
    /[a-z0-9_-]+(?:[./\\][a-z0-9_.-]+)+|[a-z][a-z0-9]*_[a-z0-9_]+/g,
  ) || [],
);
const continuation = /^(?:continue|go on|keep going|proceed|resume|carry on|do it|run that|fix it|try again)[.!?]*$/i;

/** Uses active work only when the user supplied an explicit content-free continuation. */
export function promptQuery(latest = "", work?: Work) {
  const prompt = latest.trim();
  if (!prompt) return "";
  if (!continuation.test(prompt)) return words(prompt).size ? prompt : "";
  if (!work) return "";
  const current = work.todos.find((todo) => todo.id === work.currentTodoId)?.text;
  return `${work.goal} ${current || ""}`.trim();
}

type InjectableStatus = Extract<FactStatus, "active" | "unchecked">;
type ScoredFact = { fact: Fact; strength: number; matches: number };
export function shortlistFacts(
  facts: Fact[], latest = "", work?: Work, limit = 2,
  statusFor: (fact: Fact) => InjectableStatus = () => "active",
) {
  return shortlistResolvedFacts(facts, promptQuery(latest, work), limit, statusFor);
}

/** Ranks against a query already resolved by promptQuery, without reinterpreting continuation text. */
export function shortlistResolvedFacts(
  facts: Fact[], queryText: string, limit = 2,
  statusFor: (fact: Fact) => InjectableStatus = () => "active",
) {
  const query = words(queryText), queryIdentifiers = identifiers(queryText);
  if (!query.size && !queryIdentifiers.size) return [];
  const scored = facts.map((fact): ScoredFact | undefined => {
    const keyText = `${fact.key} ${(fact.evidencePaths ?? []).map((item) => item.path).join(" ")}`,
      keyWords = words(keyText), textWords = words(fact.text),
      keyMatches = [...keyWords].filter((word) => query.has(word)),
      textMatches = [...textWords].filter((word) => query.has(word)),
      distinct = new Set([...keyMatches, ...textMatches]),
      exactIdentifier = [...identifiers(`${keyText} ${fact.text}`)].some((value) => queryIdentifiers.has(value)),
      keyAndText = keyMatches.some((keyWord) => textMatches.some((textWord) => textWord !== keyWord)),
      requiredTextMatches = statusFor(fact) === "unchecked" ? 3 : 2;
    const strength = exactIdentifier ? 3 : keyAndText ? 2 : textMatches.length >= requiredTextMatches ? 1 : 0;
    return strength ? { fact, strength, matches: distinct.size } : undefined;
  }).filter((item): item is ScoredFact => item !== undefined)
    .sort((a, b) => b.strength - a.strength || b.matches - a.matches ||
      b.fact.updatedAt.localeCompare(a.fact.updatedAt) || a.fact.key.localeCompare(b.fact.key));
  return scored.slice(0, limit).map((item) => item.fact);
}
function factIdentity(fact: Fact): string {
  return JSON.stringify([
    fact.scope ?? "project",
    fact.owner ?? "",
    fact.key,
    fact.kind,
    fact.text.replace(/\r\n/g, "\n").trim(),
    fact.source,
    fact.confidence,
    fact.captureCommit ?? "",
    fact.branchAtCapture ?? "",
    (fact.evidencePaths ?? []).map((evidence) => `${evidence.path}:${evidence.sha256}`).sort(),
  ]);
}

function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const identity = factIdentity(fact);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = value.replace(/\r\n/g, "\n").trim();
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function buildContext(
  work: Work | undefined,
  facts: Fact[],
  latest = "",
  budget = 450,
  parent: Fact[] = [],
  options: { resolvedQuery?: boolean } = {},
) {
  const query = options.resolvedQuery ? latest : promptQuery(latest, work);
  const selected = shortlistResolvedFacts(dedupeFacts(facts), query, 2);
  const selectedIdentities = new Set(selected.map(factIdentity));
  const selectedParent = shortlistResolvedFacts(dedupeFacts(parent), query, 2 - selected.length)
    .filter((fact) => !selectedIdentities.has(factIdentity(fact)));
  const lines = [
    "Continuity state. Memory may be stale; direct instructions and repository evidence win.",
  ];
  if (work) {
    const remaining = work.todos.filter((todo) => todo.status !== "done");
    const done = work.todos.filter((todo) => todo.status === "done");
    if (work.mode === "planning") {
      // Approval needs the complete proposed shape, rather than an execution-sized summary.
      lines.push(
        `Work: planning; goal: ${work.goal.slice(0, 500)}`,
        work.planSummary ? `Plan: ${work.planSummary.slice(0, 900)}` : "",
        ...dedupeStrings(work.constraints).slice(0, 6).map((x) => `Constraint: ${x.slice(0, 220)}`),
        ...work.todos.map((todo) => `Todo ${todo.id} [${todo.status}]: ${todo.text}`),
        work.latestFailure ? `Blocked: ${work.latestFailure.slice(0, 300)}` : "",
        work.nextAction ? `Next: ${work.nextAction.slice(0, 300)}` : "",
      );
    } else {
      const current = work.todos.find((todo) => todo.id === work.currentTodoId);
      const upcoming = remaining.filter((todo) => todo.id !== current?.id);
      lines.push(
        `Work: ${work.mode}; goal: ${work.goal.slice(0, 280)}`,
        current ? `Current ${current.id} [${current.status}]: ${current.text.slice(0, 160)}` : "",
        ...upcoming.slice(0, 3).map((todo) => `Todo ${todo.id} [${todo.status}]: ${todo.text.slice(0, 160)}`),
        done.length ? `Done: ${done.length}` : "",
        work.latestFailure ? `Blocked: ${work.latestFailure.slice(0, 260)}` : "",
        work.nextAction ? `Next: ${work.nextAction.slice(0, 260)}` : "",
        ...dedupeStrings(work.constraints).slice(0, 2).map((x) => `Constraint: ${x.slice(0, 160)}`),
        work.planSummary ? `Plan anchor: ${work.planSummary.slice(0, 360)}` : "",
      );
    }
  }
  const memoryLines = [
    ...selected.map((fact) => `Memory ${fact.key}: ${fact.text}`),
    ...selectedParent.map((fact) => `Parent memory ${fact.key}: ${fact.text}`),
  ];
  const content = lines.filter(Boolean), max = budget * 4;
  if (work) {
    const base = content.join("\n").slice(0, max), remaining = Math.max(0, max - base.length - 1);
    const memory = fitWholeLines(memoryLines, Math.min(400, remaining));
    return [base, memory].filter(Boolean).join("\n");
  }
  const header = content[0], memory = fitWholeLines(memoryLines, Math.min(400, max - header.length - 1));
  return memory ? `${header}\n${memory}` : "";
}

function fitWholeLines(lines: string[], max: number) {
  const accepted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = line.length + (accepted.length ? 1 : 0);
    if (size <= max - used) { accepted.push(line); used += size; }
  }
  return accepted.join("\n");
}

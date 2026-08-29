import type { Work } from "./active-work.ts";
import type { NotebookNote } from "./memory.ts";
import { renderNote } from "./memory.ts";

const aliases: Record<string, string> = {
  check: "test",
  validate: "test",
  validation: "test",
  verify: "test",
  verification: "test",
  deploy: "release",
  publish: "release",
  ship: "release",
  bundle: "build",
  compile: "build",
  configuration: "config",
  setting: "config",
};
const ignoredWords = new Set([
  "about",
  "and",
  "could",
  "from",
  "have",
  "into",
  "just",
  "now",
  "please",
  "right",
  "should",
  "than",
  "that",
  "then",
  "these",
  "this",
  "those",
  "user",
  "work",
  "would",
  "with",
]);
const normalizeWord = (word: string) => {
  let value = word;
  if (value.length > 4 && value.endsWith("ies"))
    value = `${value.slice(0, -3)}y`;
  else if (value.length > 5 && value.endsWith("ing")) {
    value = value.slice(0, -3);
    if (value.at(-1) === value.at(-2)) value = value.slice(0, -1);
  } else if (value.length > 4 && /(?:sses|shes|ches|xes|zes)$/.test(value))
    value = value.slice(0, -2);
  else if (
    value.length > 3 &&
    value.endsWith("s") &&
    !/(?:ss|us|is)$/.test(value)
  )
    value = value.slice(0, -1);
  return aliases[value] ?? value;
};
const words = (value: string) =>
  new Set(
    (value.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])
      .map(normalizeWord)
      .filter((word) => !ignoredWords.has(word)),
  );
const identifiers = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_-]+(?:[./\\][a-z0-9_.-]+)+|[a-z][a-z0-9]*_[a-z0-9_]+/g) ||
      [],
  );
const continuation =
  /^(?:continue|go on|keep going|proceed|resume|carry on|do it|run that|fix it|try again)[.!?]*$/i;

export function promptQuery(latest = "", work?: Work) {
  const prompt = latest.trim();
  if (!prompt) return "";
  if (!continuation.test(prompt)) return words(prompt).size ? prompt : "";
  if (!work) return "";
  const current = work.todos.find(
    (todo) => todo.id === work.currentTodoId,
  )?.text;
  return `${work.goal} ${current || ""}`.trim();
}

type ScoredNote = { note: NotebookNote; strength: number; matches: number };
export function shortlistNotes(
  notes: NotebookNote[],
  latest = "",
  work?: Work,
  limit = 2,
) {
  return shortlistResolvedNotes(notes, promptQuery(latest, work), limit);
}
export function shortlistResolvedNotes(
  notes: NotebookNote[],
  queryText: string,
  limit = 2,
) {
  return shortlistResolvedQueries(notes, [queryText], limit);
}
export function shortlistResolvedQueries(
  notes: NotebookNote[],
  queryTexts: string[],
  limit = 2,
) {
  const queries = queryTexts
    .map((text) => ({ words: words(text), identifiers: identifiers(text) }))
    .filter((query) => query.words.size || query.identifiers.size);
  if (!queries.length) return [];
  const seen = new Set<string>();
  return notes
    .map((note): ScoredNote | undefined => {
      if (seen.has(note.id)) return;
      seen.add(note.id);
      const hintText = (note.relatedPaths ?? []).join(" "),
        hintWords = words(hintText),
        ruleWords = words(`${note.trigger} ${note.guidance}`);
      const noteIdentifiers = identifiers(
        `${hintText} ${note.trigger} ${note.guidance}`,
      );
      let best: ScoredNote | undefined;
      for (const query of queries) {
        const hintMatches = [...hintWords].filter((word) =>
          query.words.has(word),
        );
        const ruleMatches = [...ruleWords].filter((word) =>
          query.words.has(word),
        );
        const distinct = new Set([...hintMatches, ...ruleMatches]);
        const exactIdentifier = [...noteIdentifiers].some((value) =>
          query.identifiers.has(value),
        );
        const hintAndRule = hintMatches.some((hint) =>
          ruleMatches.some((rule) => rule !== hint),
        );
        const strength = exactIdentifier
          ? 3
          : hintAndRule
            ? 2
            : ruleMatches.length >= 2
              ? 1
              : 0;
        if (
          strength &&
          (!best ||
            strength > best.strength ||
            (strength === best.strength && distinct.size > best.matches))
        )
          best = { note, strength, matches: distinct.size };
      }
      return best;
    })
    .filter((item): item is ScoredNote => item !== undefined)
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        b.matches - a.matches ||
        b.note.updatedAt.localeCompare(a.note.updatedAt) ||
        a.note.id.localeCompare(b.note.id),
    )
    .slice(0, limit)
    .map((item) => item.note);
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = value.replace(/\r\n/g, "\n").trim();
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function retrievalQueries(latest = "", work?: Work) {
  const current = work?.todos.find(
    (todo) => todo.id === work.currentTodoId,
  )?.text;
  return dedupeStrings([
    promptQuery(latest, work),
    work?.goal ?? "",
    current ?? "",
    work?.planSummary ?? "",
    work?.nextAction ?? "",
  ]);
}

export function buildMemoryInjection(
  notes: NotebookNote[],
  queryTexts: string[],
  budget = 100,
  excludedIds: ReadonlySet<string> = new Set(),
  candidateLimit = 8,
) {
  const header =
    "Continuity state. Memory may be stale; direct instructions and repository evidence win.";
  const max = budget * 4,
    available = Math.min(600, max - header.length - 1);
  const selected: NotebookNote[] = [];
  let used = 0;
  for (const note of shortlistResolvedQueries(
    notes.filter((note) => !excludedIds.has(note.id)),
    queryTexts,
    candidateLimit,
  )) {
    const line = renderNote(note),
      size = line.length + (selected.length ? 1 : 0);
    if (size <= available - used) {
      selected.push(note);
      used += size;
    }
    if (selected.length >= 2) break;
  }
  return {
    text: selected.length
      ? `${header}\n${selected.map(renderNote).join("\n")}`
      : "",
    notes: selected,
  };
}

export function buildContext(
  work: Work | undefined,
  notes: NotebookNote[],
  latest = "",
  budget = 450,
  parent: NotebookNote[] = [],
  options: {
    resolvedQuery?: boolean;
    resolvedQueries?: string[];
    candidateLimit?: number;
  } = {},
) {
  const queries = options.resolvedQueries ?? [
    options.resolvedQuery ? latest : promptQuery(latest, work),
  ];
  const candidateLimit = options.candidateLimit ?? 8;
  const selected = shortlistResolvedQueries(notes, queries, candidateLimit);
  const selectedIds = new Set(selected.map((note) => note.id));
  const selectedParent = shortlistResolvedQueries(
    parent,
    queries,
    candidateLimit,
  ).filter((note) => !selectedIds.has(note.id));
  const lines = [
    "Continuity state. Memory may be stale; direct instructions and repository evidence win.",
  ];
  if (work) {
    const remaining = work.todos.filter((todo) => todo.status !== "done");
    const done = work.todos.filter((todo) => todo.status === "done");
    if (work.mode === "planning")
      lines.push(
        `Work: planning; goal: ${work.goal.slice(0, 500)}`,
        work.planSummary ? `Plan: ${work.planSummary.slice(0, 900)}` : "",
        ...dedupeStrings(work.handoff?.workingSet ?? [])
          .slice(0, 8)
          .map((value) => `Working set: ${value.slice(0, 240)}`),
        ...dedupeStrings(work.handoff?.assumptions ?? [])
          .slice(0, 4)
          .map((value) => `Assumption/gap: ${value.slice(0, 300)}`),
        ...dedupeStrings(work.handoff?.acceptanceCriteria ?? [])
          .slice(0, 4)
          .map((value) => `Acceptance: ${value.slice(0, 300)}`),
        ...dedupeStrings(work.constraints)
          .slice(0, 6)
          .map((value) => `Constraint: ${value.slice(0, 220)}`),
        ...work.todos.map(
          (todo) => `Todo ${todo.id} [${todo.status}]: ${todo.text}`,
        ),
        work.revisionFeedback
          ? `Revision feedback: ${work.revisionFeedback.text.slice(0, 500)}`
          : "",
        work.latestFailure
          ? `Blocked: ${work.latestFailure.slice(0, 300)}`
          : "",
        work.nextAction ? `Next: ${work.nextAction.slice(0, 300)}` : "",
      );
    else {
      const current = work.todos.find((todo) => todo.id === work.currentTodoId);
      lines.push(
        `Work: ${work.mode}; goal: ${work.goal.slice(0, 280)}`,
        current
          ? `Current ${current.id} [${current.status}]: ${current.text.slice(0, 160)}`
          : "",
        ...remaining
          .filter((todo) => todo.id !== current?.id)
          .slice(0, 3)
          .map(
            (todo) =>
              `Todo ${todo.id} [${todo.status}]: ${todo.text.slice(0, 160)}`,
          ),
        done.length ? `Done: ${done.length}` : "",
        work.latestFailure
          ? `Blocked: ${work.latestFailure.slice(0, 260)}`
          : "",
        work.nextAction ? `Next: ${work.nextAction.slice(0, 260)}` : "",
        ...dedupeStrings(work.constraints)
          .slice(0, 2)
          .map((value) => `Constraint: ${value.slice(0, 160)}`),
        work.planSummary
          ? `Plan anchor: ${work.planSummary.slice(0, 360)}`
          : "",
        ...dedupeStrings(work.handoff?.workingSet ?? [])
          .slice(0, 4)
          .map((value) => `Working set: ${value.slice(0, 180)}`),
      );
    }
  }
  const memoryLines = [...selected, ...selectedParent].map(renderNote);
  const content = lines.filter(Boolean),
    max = budget * 4;
  if (work) {
    const base = content.join("\n").slice(0, max),
      remaining = Math.max(0, max - base.length - 1);
    const memory = fitWholeLines(memoryLines, Math.min(600, remaining), 2);
    return [base, memory].filter(Boolean).join("\n");
  }
  const header = content[0]!,
    memory = fitWholeLines(
      memoryLines,
      Math.min(600, max - header.length - 1),
      2,
    );
  return memory ? `${header}\n${memory}` : "";
}
function fitWholeLines(lines: string[], max: number, maxLines: number) {
  const accepted: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (accepted.length >= maxLines) break;
    const size = line.length + (accepted.length ? 1 : 0);
    if (size <= max - used) {
      accepted.push(line);
      used += size;
    }
  }
  return accepted.join("\n");
}

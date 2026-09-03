import type { UsageAgent, UsageRecord, UsageSessionSummary, UsageSnapshot } from "./protocol/snapshots.ts";

export type UsageFacet = "project" | "provider" | "model";
/**
 * "costInput", "costOutput" and "costUnsplit" are the parts of "cost". They are
 * not offered as measures of their own — they exist so combined cost can draw
 * the same input/output reading as combined tokens, with whatever the provider
 * billed without a split named as its own part rather than folded into either.
 */
export type UsageMetric =
  "total" | "input" | "output" | "cost" | "cacheRead" | "sessions" | "costInput" | "costOutput" | "costUnsplit";
export type UsageSplit = "none" | UsageFacet | "agent";
export type UsageFilters = Record<UsageFacet, Set<string>>;

export interface UsageGroup {
  value: string;
  name: string;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  costInput: number;
  costOutput: number;
  costEstimated: number;
  cache: number;
}

export interface UsageFacetOption {
  value: string;
  label: string;
  sessions: number;
}

export interface UsageSeriesData {
  label: string;
  value: string;
  /** Set when the series is one part of a measure rather than a whole line. */
  part?: "input" | "output" | "unsplit";
  kind?: UsageFacet | "agent";
  cacheRead: number;
  amount: number;
  dash: boolean;
  values: number[];
  sessions: number;
  cache: number;
}

export interface UsageSessionRow {
  id: string;
  title: string;
  project: string;
  projectId: string;
  model: string;
  agent: string;
  elapsedMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cache: number;
  cost: number;
  costKnown: boolean;
}

export const USAGE_FACETS: UsageFacet[] = ["project", "provider", "model"];
export const USAGE_AGENT_ORDER: UsageAgent[] = ["main", "scout", "grunt", "advisor", "private", "other", "unknown"];

const USAGE_AGENT_LABELS: Record<UsageAgent, string> = {
  main: "Main agent",
  scout: "Scout",
  grunt: "Grunt",
  advisor: "Advisor",
  private: "Private agents",
  other: "Other",
  unknown: "Unknown",
};
export const usageAgentLabel = (agent: UsageAgent): string => USAGE_AGENT_LABELS[agent];

const facetValue = (record: UsageRecord, facet: UsageFacet): string =>
  facet === "project" ? record.projectId : record[facet];
const facetLabel = (record: UsageRecord, facet: UsageFacet): string =>
  facet === "project" ? record.projectLabel : record[facet];
const splitValue = (record: UsageRecord, split: UsageFacet | "agent"): string =>
  split === "agent" ? record.agent : facetValue(record, split);
const splitLabel = (record: UsageRecord, split: UsageFacet | "agent"): string =>
  split === "agent" ? usageAgentLabel(record.agent) : facetLabel(record, split);

/**
 * Delegated turns bill a total with no halves, so a range almost always holds
 * some cost that cannot be attributed. That is not a reason to refuse the
 * split — it is a third part, named as what it is, so the parts always add up
 * to the total beside them and nothing is invented to make them.
 */
export const costPartsReported = (value: Pick<UsageGroup, "costInput" | "costOutput">): boolean =>
  value.costInput + value.costOutput > 0;

export const cachePercent = (input: number, cacheRead: number): number =>
  input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : 0;

export type UsageMeasurable = Pick<UsageRecord, "input" | "output" | "cost"> &
  Partial<Pick<UsageRecord, "cacheRead" | "costInput" | "costOutput">> & { sessions?: number };

/**
 * Sessions are the one measure that is not a sum: a record belongs to a session
 * it shares with other records, so the count only exists once rows are grouped.
 * Callers that measure records by day count distinct sessions themselves.
 */
export function measureUsage(metric: UsageMetric, value: UsageMeasurable): number {
  return metric === "input"
    ? value.input
    : metric === "output"
      ? value.output
      : metric === "costInput"
        ? (value.costInput ?? 0)
        : metric === "costOutput"
          ? (value.costOutput ?? 0)
          : metric === "cacheRead"
            ? (value.cacheRead ?? 0)
            : metric === "sessions"
              ? (value.sessions ?? 0)
              : metric === "costUnsplit"
                ? Math.max(0, value.cost - (value.costInput ?? 0) - (value.costOutput ?? 0))
                : metric === "cost"
                  ? value.cost
                  : value.input + value.output;
}

export function filterUsageRecords(records: readonly UsageRecord[], filters: UsageFilters): UsageRecord[] {
  return records.filter(record =>
    USAGE_FACETS.every(facet => filters[facet].size === 0 || filters[facet].has(facetValue(record, facet))),
  );
}

export function usageFacetOptions(
  records: readonly UsageRecord[],
  filters: UsageFilters,
): Record<UsageFacet, UsageFacetOption[]> {
  return Object.fromEntries(
    USAGE_FACETS.map(facet => {
      const scoped = records.filter(record =>
        USAGE_FACETS.every(
          candidate =>
            candidate === facet ||
            filters[candidate].size === 0 ||
            filters[candidate].has(facetValue(record, candidate)),
        ),
      );
      const options = new Map<string, { label: string; sessions: Set<string> }>();
      for (const record of scoped) {
        const value = facetValue(record, facet);
        const option = options.get(value) ?? { label: facetLabel(record, facet), sessions: new Set<string>() };
        option.sessions.add(record.sessionId);
        options.set(value, option);
      }
      return [
        facet,
        [...options.entries()]
          .map(([value, option]) => ({ value, label: option.label, sessions: option.sessions.size }))
          .sort((left, right) => left.label.localeCompare(right.label)),
      ];
    }),
  ) as Record<UsageFacet, UsageFacetOption[]>;
}

export function groupUsage(records: readonly UsageRecord[], facet?: UsageFacet | "agent"): UsageGroup[] {
  const groups = new Map<string, Omit<UsageGroup, "sessions" | "cache"> & { sessionIds: Set<string> }>();
  for (const record of records) {
    const value = facet === undefined ? "total" : facet === "agent" ? record.agent : facetValue(record, facet);
    const name =
      facet === undefined ? "Total" : facet === "agent" ? usageAgentLabel(record.agent) : facetLabel(record, facet);
    const group = groups.get(value) ?? {
      value,
      name,
      sessionIds: new Set<string>(),
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: true,
      costInput: 0,
      costOutput: 0,
      costEstimated: 0,
    };
    group.sessionIds.add(record.sessionId);
    group.input += record.input;
    group.output += record.output;
    group.cacheRead += record.cacheRead;
    group.cacheWrite += record.cacheWrite;
    group.cost += record.cost;
    group.costKnown = group.costKnown && record.costKnown;
    group.costInput += record.costInput;
    group.costOutput += record.costOutput;
    group.costEstimated += record.costEstimated;
    groups.set(value, group);
  }
  return [...groups.values()].map(group => ({
    value: group.value,
    name: group.name,
    sessions: group.sessionIds.size,
    input: group.input,
    output: group.output,
    cacheRead: group.cacheRead,
    cacheWrite: group.cacheWrite,
    cost: group.cost,
    costKnown: group.costKnown,
    costInput: group.costInput,
    costOutput: group.costOutput,
    costEstimated: group.costEstimated,
    cache: cachePercent(group.input, group.cacheRead),
  }));
}

export function usageDayKeys(snapshot: Pick<UsageSnapshot, "fromInclusive" | "toExclusive">): string[] {
  const start = new Date(snapshot.fromInclusive);
  const end = new Date(Date.parse(snapshot.toExclusive) - 1);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 24 * 60 * 60 * 1_000)
    days.push(new Date(cursor).toISOString().slice(0, 10));
  return days;
}

function dailyValues(records: readonly UsageRecord[], days: readonly string[], metric: UsageMetric): number[] {
  if (metric === "sessions") {
    const perDay = new Map<string, Set<string>>();
    for (const record of records) {
      const seen = perDay.get(record.day) ?? new Set<string>();
      seen.add(record.sessionId);
      perDay.set(record.day, seen);
    }
    return days.map(day => perDay.get(day)?.size ?? 0);
  }
  const values = new Map<string, number>();
  for (const record of records) values.set(record.day, (values.get(record.day) ?? 0) + measureUsage(metric, record));
  return days.map(day => values.get(day) ?? 0);
}

const PART_LABEL: Partial<Record<UsageMetric, string>> = {
  input: "Input",
  output: "Output",
  costInput: "Input",
  costOutput: "Output",
  costUnsplit: "Not split",
};
const PART_OF: Partial<Record<UsageMetric, "input" | "output" | "unsplit">> = {
  input: "input",
  output: "output",
  costInput: "input",
  costOutput: "output",
  costUnsplit: "unsplit",
};

export function buildUsageSeries(
  records: readonly UsageRecord[],
  days: readonly string[],
  metric: UsageMetric,
  split: UsageSplit,
): UsageSeriesData[] {
  const splitFacet = split === "none" ? undefined : split;
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const value = splitFacet ? splitValue(record, splitFacet) : "total";
    const bucket = buckets.get(value) ?? [];
    bucket.push(record);
    buckets.set(value, bucket);
  }
  const ordered = [...buckets.entries()].sort(
    ([, left], [, right]) => measureUsage(metric, groupUsage(right)[0]!) - measureUsage(metric, groupUsage(left)[0]!),
  );
  const make = (
    value: string,
    rows: UsageRecord[],
    part: "input" | "output" | UsageMetric,
    dash: boolean,
  ): UsageSeriesData => {
    const group = groupUsage(rows)[0]!;
    const name = splitFacet ? splitLabel(rows[0]!, splitFacet) : "Total";
    return {
      label: splitFacet ? name : (PART_LABEL[part] ?? name),
      ...(PART_OF[part] ? { part: PART_OF[part] } : {}),
      value,
      ...(splitFacet ? { kind: splitFacet } : {}),
      amount: measureUsage(part, group),
      cacheRead: group.cacheRead,
      dash,
      values: dailyValues(rows, days, part),
      sessions: group.sessions,
      cache: group.cache,
    };
  };
  // Input and output are the two halves of one measured quantity, so a combined
  // total draws as its parts rather than as one line — for cost too, wherever
  // the provider reported them.
  const totals = groupUsage(records)[0];
  const parts: UsageMetric[] =
    splitFacet || !totals
      ? []
      : metric === "total"
        ? ["input", "output"]
        : metric === "cost" && costPartsReported(totals)
          ? measureUsage("costUnsplit", totals) > 0
            ? ["costInput", "costOutput", "costUnsplit"]
            : ["costInput", "costOutput"]
          : [];
  if (parts.length)
    return ordered.flatMap(([value, rows]) => parts.map((part, index) => make(value, rows, part, index > 0)));
  return ordered.map(([value, rows]) => make(value, rows, metric, false));
}

function dominant(
  records: readonly UsageRecord[],
  metric: UsageMetric,
  value: (record: UsageRecord) => string,
): string {
  const totals = new Map<string, number>();
  for (const record of records)
    totals.set(value(record), (totals.get(value(record)) ?? 0) + measureUsage(metric, record));
  return (
    [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ??
    "Unknown"
  );
}

export function topUsageSessions(
  records: readonly UsageRecord[],
  sessions: readonly UsageSessionSummary[],
  metric: UsageMetric,
  limit = 6,
): UsageSessionRow[] {
  const ranked: UsageMetric = metric === "sessions" ? "cost" : metric;
  const summaries = new Map(sessions.map(session => [session.id, session]));
  const bySession = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const bucket = bySession.get(record.sessionId) ?? [];
    bucket.push(record);
    bySession.set(record.sessionId, bucket);
  }
  return [...bySession.entries()]
    .map(([id, rows]) => {
      const summary = summaries.get(id);
      const group = groupUsage(rows)[0]!;
      return {
        id,
        title: summary?.title ?? id,
        project: summary?.projectLabel ?? rows[0]!.projectLabel,
        projectId: summary?.projectId ?? rows[0]!.projectId,
        model: dominant(rows, ranked, row => row.model),
        agent: dominant(rows, ranked, row => usageAgentLabel(row.agent)),
        elapsedMs: summary?.elapsedMs ?? 0,
        input: group.input,
        output: group.output,
        cacheRead: group.cacheRead,
        cache: group.cache,
        cost: group.cost,
        costKnown: group.costKnown,
      };
    })
    .sort((left, right) => measureUsage(ranked, right) - measureUsage(ranked, left) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

const spreadsheetSafe = (value: string): string => (/^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value);
const csvField = (value: string | number | boolean): string => {
  const text = typeof value === "string" ? spreadsheetSafe(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function usageCsv(records: readonly UsageRecord[]): string {
  const rows: Array<Array<string | number | boolean>> = [
    [
      "day",
      "project_id",
      "project",
      "session_id",
      "provider",
      "model",
      "agent",
      "calls",
      "input",
      "output",
      "cache_read",
      "cache_write",
      "cache_hit_pct",
      "cost",
      "cost_input",
      "cost_output",
      "cost_estimated",
      "cost_known",
    ],
    ...records.map(record => [
      record.day,
      record.projectId,
      record.projectLabel,
      record.sessionId,
      record.provider,
      record.model,
      usageAgentLabel(record.agent),
      record.calls,
      record.input,
      record.output,
      record.cacheRead,
      record.cacheWrite,
      cachePercent(record.input, record.cacheRead).toFixed(2),
      record.cost,
      record.costInput,
      record.costOutput,
      record.costEstimated,
      record.costKnown,
    ]),
  ];
  return rows.map(row => row.map(csvField).join(",")).join("\n");
}

import type { UsageAgent, UsageRecord, UsageSessionSummary, UsageSnapshot } from "./protocol/snapshots.ts";

export type UsageFacet = "project" | "provider" | "model";
export type UsageMetric = "total" | "input" | "output" | "cost";
export type UsageSplit = "none" | "provider" | "model";
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
  kind?: "provider" | "model";
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

export const cachePercent = (input: number, cacheRead: number): number =>
  input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : 0;

export function measureUsage(metric: UsageMetric, value: Pick<UsageRecord, "input" | "output" | "cost">): number {
  return metric === "input"
    ? value.input
    : metric === "output"
      ? value.output
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
    };
    group.sessionIds.add(record.sessionId);
    group.input += record.input;
    group.output += record.output;
    group.cacheRead += record.cacheRead;
    group.cacheWrite += record.cacheWrite;
    group.cost += record.cost;
    group.costKnown = group.costKnown && record.costKnown;
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
  const values = new Map<string, number>();
  for (const record of records) values.set(record.day, (values.get(record.day) ?? 0) + measureUsage(metric, record));
  return days.map(day => values.get(day) ?? 0);
}

export function buildUsageSeries(
  records: readonly UsageRecord[],
  days: readonly string[],
  metric: UsageMetric,
  split: UsageSplit,
): UsageSeriesData[] {
  const splitFacet = split === "none" ? undefined : split;
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const value = splitFacet ? facetValue(record, splitFacet) : "total";
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
    const name = splitFacet ? facetLabel(rows[0]!, splitFacet) : "Total";
    return {
      label: metric === "total" ? (splitFacet ? `${name} · ${part}` : part === "input" ? "Input" : "Output") : name,
      value,
      ...(splitFacet ? { kind: splitFacet } : {}),
      amount: measureUsage(part, group),
      dash,
      values: dailyValues(rows, days, part),
      sessions: group.sessions,
      cache: group.cache,
    };
  };
  if (metric === "total")
    return ordered.flatMap(([value, rows]) => [make(value, rows, "input", false), make(value, rows, "output", true)]);
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
        model: dominant(rows, metric, row => row.model),
        agent: dominant(rows, metric, row => usageAgentLabel(row.agent)),
        elapsedMs: summary?.elapsedMs ?? 0,
        input: group.input,
        output: group.output,
        cost: group.cost,
        costKnown: group.costKnown,
      };
    })
    .sort((left, right) => measureUsage(metric, right) - measureUsage(metric, left) || left.id.localeCompare(right.id))
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
      record.costKnown,
    ]),
  ];
  return rows.map(row => row.map(csvField).join(",")).join("\n");
}

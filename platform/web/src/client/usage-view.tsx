import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactNumber } from "../shared/format";
import type { UsageSnapshot } from "../shared/protocol/snapshots";
import { LedBar } from "./overview-primitives";
import { runtimeStore, useRuntimeStore } from "./runtime/event-store";
import {
  buildUsageSeries,
  filterUsageRecords,
  groupUsage,
  measureUsage,
  topUsageSessions,
  usageCsv,
  usageDayKeys,
  usageFacetOptions,
  USAGE_AGENT_ORDER,
  USAGE_FACETS,
  type UsageFacet,
  type UsageFacetOption,
  type UsageFilters,
  type UsageGroup,
  type UsageMetric,
  type UsageSeriesData,
  type UsageSplit,
} from "../shared/usage-data";

type Facet = UsageFacet;
type Metric = UsageMetric;
type Group = UsageGroup;
type Filters = UsageFilters;
type Days = 7 | 30 | 90;
type Range = Days | { from: string; through: string };
type Dimensions = Record<Facet, UsageFacetOption[]>;
type State = { filters: Filters; range: Range; metric: Metric; split: UsageSplit };
type Series = UsageSeriesData & { color: string };
type Choice<T extends string> = [T, string];
type ChoiceGroup<T extends string> = { group: string; items: Choice<T>[] };

const FACETS = USAGE_FACETS;
const RANGES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
] as const;

/**
 * Both axes of the chart are lists, not button rows: a new measure or a new
 * break-down is one entry here, and nothing else on the page changes.
 */
const MEASURES: ChoiceGroup<Metric>[] = [
  { group: "Spend", items: [["cost", "Cost"]] },
  {
    group: "Tokens",
    items: [
      ["total", "Input + output"],
      ["input", "Input"],
      ["output", "Output"],
      ["cacheRead", "Cache reads"],
    ],
  },
  { group: "Activity", items: [["sessions", "Sessions"]] },
];
const SPLITS: ChoiceGroup<UsageSplit>[] = [
  { group: "", items: [["none", "Combined"]] },
  {
    group: "One line for each",
    items: [
      ["provider", "Provider"],
      ["model", "Model"],
      ["project", "Project"],
      ["agent", "Agent"],
    ],
  },
];
/** The heading says the measure in full; the menu says it in short. */
const MEASURE_TITLE: Record<Metric, string> = {
  cost: "Cost",
  costInput: "Input cost",
  costOutput: "Output cost",
  costUnsplit: "Unsplit cost",
  total: "Input + output tokens",
  input: "Input tokens",
  output: "Output tokens",
  cacheRead: "Cache reads",
  sessions: "Sessions",
};

/**
 * A measure keeps one colour wherever it is drawn: prompt-side work in the
 * accent, completions in amber, cache reads in green — the same reading as the
 * split columns, so switching to Output alone does not repaint it blue. Cost
 * the provider billed without a split is drawn as neither half.
 */
const MEASURE_TONE: Partial<Record<Metric, string>> = {
  output: "var(--c2)",
  costOutput: "var(--c2)",
  cacheRead: "var(--c3)",
};
const PART_TONE = { input: "var(--c1)", output: "var(--c2)", unsplit: "var(--text-muted)" } as const;

/**
 * A rank spans orders of magnitude — the busiest model routinely outspends the
 * quietest by a hundred to one — and a linear bar renders everything below the
 * leader as one lit cell. The bar reads a ratio instead: each third of it is a
 * tenfold difference, and anything under a thousandth of the leader is dark.
 */
const RANK_DECADES = 3;
const rankShare = (value: number, peak: number) =>
  value <= 0 || peak <= 0 ? 0 : Math.max(0, Math.min(100, 100 * (1 + Math.log10(value / peak) / RANK_DECADES)));

const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);
const EMPTY: Group = {
  value: "total",
  name: "Total",
  sessions: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costKnown: true,
  costInput: 0,
  costOutput: 0,
  costEstimated: 0,
  cache: 0,
};
const emptyFilters = (): Filters => ({ project: new Set(), provider: new Set(), model: new Set() });
const choices = <T extends string>(groups: ChoiceGroup<T>[]) => groups.flatMap(entry => entry.items);
const choiceLabel = <T extends string>(groups: ChoiceGroup<T>[], value: T) =>
  choices(groups).find(item => item[0] === value)?.[1] ?? value;
const formatMeasure = (metric: Metric) => (value: number) =>
  metric === "cost" || metric === "costInput" || metric === "costOutput"
    ? money(value)
    : metric === "sessions"
      ? Math.round(value).toLocaleString()
      : formatCompactNumber(value);

/** Colours pin to a fixed order per dimension, so a provider keeps its colour. */
function tone(kind: Facet | "agent", value: string, dimensions: Dimensions): string {
  const list: readonly string[] = kind === "agent" ? USAGE_AGENT_ORDER : dimensions[kind].map(option => option.value);
  return `var(--c${(Math.max(0, list.indexOf(value)) % 5) + 1})`;
}

function dateTick(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

const duration = (elapsedMs: number) => {
  const minutes = Math.round(elapsedMs / 60_000);
  if (!minutes) return "—";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};

/**
 * A control that resizes to its own value pushes everything beside it, so every
 * summary is laid out over all of its labels at once and only the current one
 * is painted: the width is the widest option, always.
 */
function FitLabel({ current, all }: { current: string; all: string[] }) {
  const labels = all.includes(current) ? all : [current, ...all];
  return (
    <span className="usage-fit">
      {labels.map(text => (
        <span key={text} className={text === current ? "is-current" : undefined} aria-hidden={text !== current}>
          {text}
        </span>
      ))}
    </span>
  );
}

/** One menu widget for every choice on the page: scope filters and both chart axes. */
function Picker<T extends string>({
  groups,
  value,
  title,
  onChange,
}: {
  groups: ChoiceGroup<T>[];
  value: T;
  title: string;
  onChange: (next: T) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} className="usage-facet usage-picker">
      <summary aria-label={title}>
        <FitLabel current={choiceLabel(groups, value)} all={choices(groups).map(item => item[1])} />
      </summary>
      <div className="usage-facet-menu">
        {groups.map(entry => (
          <div key={entry.group || "top"}>
            {entry.group && (
              <div className="usage-facet-head">
                <span>{entry.group}</span>
              </div>
            )}
            {entry.items.map(([item, label]) => (
              <button
                key={item}
                className="usage-facet-option"
                type="button"
                role="menuitemradio"
                aria-checked={item === value}
                onClick={() => {
                  ref.current?.removeAttribute("open");
                  onChange(item);
                }}>
                <i aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

const CHART_ROWS = 22;
const CELL = 5;
const CELL_GAP = 2;

/**
 * The chart is the app's LED cells on a time axis: one column per day, stacked
 * by whatever the series are — input and output when combined, one segment per
 * provider, model, project or agent when broken down. No second chart grammar.
 *
 * The viewBox is sized to the element's real pixel width so one SVG unit is one
 * CSS pixel — a fixed box gets scaled by the container, which would scale the
 * tick text with it.
 */
function Chart({ series, days, metric }: { series: Series[]; days: string[]; metric: Metric }) {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.max(360, Math.round(measured)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const format = formatMeasure(metric);
  const height = CHART_ROWS * (CELL + CELL_GAP) + 30;
  const left = 58;
  const count = Math.max(days.length, 1);
  const totals = days.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
  const peak = Math.max(...totals, 0);
  const step = (width - left) / count;
  const barWidth = Math.min(14, Math.max(3, step * 0.7));
  const inset = (step - barWidth) / 2;
  const rowY = (row: number) => height - 26 - (row + 1) * (CELL + CELL_GAP) + CELL_GAP;
  const labelIndexes = [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(index => days[index]);

  /** Every series that is present lights at least one cell, or a quiet day reads as single-tone. */
  const slice = (index: number, lit: number) => {
    const total = totals[index] ?? 0;
    let assigned = 0;
    const sizes = series.map((item, order) => {
      const value = item.values[index] ?? 0;
      const size = order === series.length - 1 ? lit - assigned : Math.round((lit * value) / (total || 1));
      assigned += Math.max(0, size);
      return { color: item.color, size: Math.max(0, size), value };
    });
    if (lit >= sizes.length)
      for (const part of sizes) {
        if (part.size || !part.value) continue;
        const biggest = sizes.reduce((widest, entry) => (entry.size > widest.size ? entry : widest));
        if (biggest.size > 1) {
          biggest.size -= 1;
          part.size = 1;
        }
      }
    return sizes;
  };

  /** The row's colour is the series whose run of cells covers it. */
  const colorAt = (sizes: ReturnType<typeof slice>, row: number) => {
    let base = 0;
    for (const part of sizes) {
      if (row < base + part.size) return part.color;
      base += part.size;
    }
    return undefined;
  };

  return (
    <svg
      ref={ref}
      className="usage-chart"
      viewBox={`0 0 ${width} ${height}`}
      height={height}
      role="img"
      aria-label={`${MEASURE_TITLE[metric]} by day`}>
      {peak <= 0 ? (
        <text className="chart-empty" x="50%" y={height / 2} textAnchor="middle">
          No usage in this range
        </text>
      ) : (
        <>
          {[0, 0.5, 1].map(fraction => (
            <text
              key={fraction}
              className="tick"
              x={left - 12}
              y={height - 26 - fraction * CHART_ROWS * (CELL + CELL_GAP) + 4}
              textAnchor="end">
              {format(peak * fraction)}
            </text>
          ))}
          <line className="base" x1={left} y1={height - 22} x2={width} y2={height - 22} />
          {days.map((day, index) => {
            const value = totals[index] ?? 0;
            const lit = Math.max(value > 0 ? 1 : 0, Math.round((value / peak) * CHART_ROWS));
            const sizes = slice(index, lit);
            const x = left + index * step + inset;
            return (
              <g key={day} className="col">
                <title>{`${day} · ${format(value)}`}</title>
                {Array.from({ length: CHART_ROWS }, (_, row) => {
                  const color = row < lit ? colorAt(sizes, row) : undefined;
                  return (
                    <rect
                      key={row}
                      className={color ? "on" : "off"}
                      x={x.toFixed(1)}
                      y={rowY(row).toFixed(1)}
                      width={barWidth.toFixed(1)}
                      height={CELL}
                      rx={1}
                      fill={color}
                    />
                  );
                })}
              </g>
            );
          })}
          {labelIndexes.map((index, order) => (
            <text
              key={index}
              className="tick"
              x={left + index * step + barWidth / 2}
              y={height - 6}
              textAnchor={order === 0 ? "start" : index === count - 1 ? "end" : "middle"}>
              {dateTick(days[index]!)}
            </text>
          ))}
        </>
      )}
    </svg>
  );
}

/**
 * Cache hit rate is cacheRead / (input + cacheRead), so the volume behind any
 * rate follows from the two figures it was measured on. Every cache figure on
 * the page says both: the rate, and what it stands for.
 */
function CacheCell({ input, cacheRead, rate }: { input: number; cacheRead: number; rate: number }) {
  return (
    <>
      <small>{formatCompactNumber(cacheRead || (rate >= 100 ? 0 : (input * rate) / (100 - rate)))}</small>
      {`${rate.toFixed(1)}%`}
    </>
  );
}

function Facets({
  state,
  dimensions,
  onChange,
}: {
  state: State;
  dimensions: Dimensions;
  onChange: (next: State) => void;
}) {
  const setFilter = (kind: Facet, value: string) => {
    const next = new Set(state.filters[kind]);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...state, filters: { ...state.filters, [kind]: next } });
  };
  return (
    <>
      {FACETS.map(kind => {
        const chosen = [...state.filters[kind]];
        const fallback = `${kind[0]!.toUpperCase()}${kind.slice(1)}s`;
        const chosenLabel = dimensions[kind].find(option => option.value === chosen[0])?.label ?? chosen[0];
        return (
          <details key={kind} className="usage-facet">
            <summary>
              <FitLabel
                current={chosen.length === 1 ? (chosenLabel ?? fallback) : fallback}
                all={[fallback, ...dimensions[kind].map(option => option.label)]}
              />
              {chosen.length > 1 && <span className="usage-facet-count">{chosen.length}</span>}
            </summary>
            <div className="usage-facet-menu">
              <div className="usage-facet-head">
                <span>Select any</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onChange({ ...state, filters: { ...state.filters, [kind]: new Set<string>() } })}>
                  Clear
                </button>
              </div>
              {dimensions[kind].map(option => (
                <label key={option.value} className="usage-facet-option">
                  <input
                    type="checkbox"
                    checked={state.filters[kind].has(option.value)}
                    onChange={() => setFilter(kind, option.value)}
                  />
                  <span>{option.label}</span>
                  <small>{option.sessions} sessions</small>
                </label>
              ))}
            </div>
          </details>
        );
      })}
    </>
  );
}

type LoadState = {
  snapshot?: UsageSnapshot;
  snapshotRange?: string;
  requestedRange: string;
  loading: boolean;
  error?: string;
};

export function UsageView({ onSelectSession }: { onSelectSession?: (sessionId: string) => void }) {
  const live = useRuntimeStore();
  const [state, setState] = useState<State>({ filters: emptyFilters(), range: 30, metric: "cost", split: "none" });
  const [custom, setCustom] = useState({ from: "", through: "" });
  const [customOpen, setCustomOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ requestedRange: "30", loading: true });
  const [retry, setRetry] = useState(0);
  const generation = live.runtime?.sessionGeneration;
  const runtimeReady = live.runtime?.ready;
  const assistantMessages = live.runtime?.metrics.assistantMessages;

  const rangeKey = typeof state.range === "number" ? String(state.range) : `${state.range.from}:${state.range.through}`;
  const rangeInput = typeof state.range === "number" ? { days: state.range } : state.range;
  useEffect(() => {
    if (!runtimeReady || !generation) {
      setLoad(current => ({
        ...current,
        requestedRange: rangeKey,
        loading: false,
        error: "Usage is available when the runtime is ready.",
      }));
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoad(current => ({ ...current, requestedRange: rangeKey, loading: true, error: undefined }));
    void runtimeStore
      .usage(rangeInput, controller.signal)
      .then(snapshot => {
        if (active) setLoad({ snapshot, snapshotRange: rangeKey, requestedRange: rangeKey, loading: false });
      })
      .catch(cause => {
        if (!active || controller.signal.aborted) return;
        setLoad(current => ({
          ...current,
          requestedRange: rangeKey,
          loading: false,
          error: cause instanceof Error ? cause.message : "Unable to load usage",
        }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [assistantMessages, generation, retry, runtimeReady, rangeKey]);

  const snapshot = load.snapshotRange === rangeKey ? load.snapshot : undefined;
  const records = snapshot?.records ?? [];
  const colorDimensions = useMemo(() => usageFacetOptions(records, emptyFilters()), [records]);
  const dimensions = useMemo(() => usageFacetOptions(records, state.filters), [records, state.filters]);
  const data = useMemo(() => {
    const rows = filterUsageRecords(records, state.filters);
    const byMeasure = (left: Group, right: Group) =>
      measureUsage(state.metric, right) - measureUsage(state.metric, left);
    const days = snapshot ? usageDayKeys(snapshot) : [];
    const series = buildUsageSeries(rows, days, state.metric, state.split).map(item => ({
      ...item,
      // Split columns carry the Inspector's own composition reading: input in
      // the accent, output in amber (.overview-led-bar > i.is-on.is-b).
      color: item.part
        ? PART_TONE[item.part]
        : item.kind
          ? tone(item.kind, item.value, colorDimensions)
          : (MEASURE_TONE[state.metric] ?? "var(--c1)"),
    }));
    return {
      rows,
      days,
      total: groupUsage(rows)[0] ?? EMPTY,
      byProject: groupUsage(rows, "project").sort(byMeasure),
      byProvider: groupUsage(rows, "provider").sort((left, right) => right.cost - left.cost),
      byAgent: groupUsage(rows, "agent").sort(
        (left, right) =>
          USAGE_AGENT_ORDER.findIndex(agent => agent === left.value) -
          USAGE_AGENT_ORDER.findIndex(agent => agent === right.value),
      ),
      byModel: groupUsage(rows, "model").sort(byMeasure),
      topSessions: topUsageSessions(rows, snapshot?.sessions ?? [], state.metric),
      series,
    };
  }, [colorDimensions, records, snapshot, state.filters, state.metric, state.split]);

  const measure = (value: Parameters<typeof measureUsage>[1]) => measureUsage(state.metric, value);
  const format = formatMeasure(state.metric);
  const { total } = data;
  const chips = FACETS.flatMap(kind =>
    [...state.filters[kind]].map(value => ({
      kind,
      value,
      label: colorDimensions[kind].find(option => option.value === value)?.label ?? value,
    })),
  );
  const modelPeak = Math.max(...data.byModel.map(measure), 1);
  const agentPeak = Math.max(...data.byAgent.map(measure), 1);
  const dropChip = (kind: Facet, value: string) => {
    const next = new Set(state.filters[kind]);
    next.delete(value);
    setState({ ...state, filters: { ...state.filters, [kind]: next } });
  };
  const toggleProvider = (value: string) => {
    const next = new Set(state.filters.provider);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setState({ ...state, filters: { ...state.filters, provider: next } });
  };
  const exportCsv = () => {
    const blob = new Blob([usageCsv(data.rows)], { type: "text/csv;charset=utf-8" });
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: "pylon-usage.csv",
    });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };
  const error = load.requestedRange === rangeKey ? load.error : undefined;
  const diagnostics = snapshot?.diagnostics;
  const partialHistory = Boolean(
    diagnostics && (diagnostics.truncated || diagnostics.unreadableFiles || diagnostics.conflictingDuplicates),
  );
  const incompleteAttribution = Boolean(diagnostics?.unknownAttributionRecords);
  const periodLabel =
    typeof state.range === "number" ? `last ${state.range} days` : `${state.range.from} to ${state.range.through}`;
  const composed = data.series.length > 1;
  /** The totals are always what was billed; only their input/output split can be derived. */
  const estimatedSplit = state.metric === "cost" && total.costEstimated > 0;

  return (
    <div className="page-grid usage-page">
      {/* Scope on the left, period on the right, one rule: the workspace header
          above already titles the page, so this carries no second title. */}
      <div className="usage-toolbar">
        <Facets state={state} dimensions={dimensions} onChange={setState} />
        <span className="usage-segbar push" role="group" aria-label="Period">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state.range === value}
              onClick={() => {
                setCustom({ from: "", through: "" });
                setCustomOpen(false);
                setState({ ...state, range: value });
              }}>
              {label}
            </button>
          ))}
          <button type="button" aria-pressed={customOpen} onClick={() => setCustomOpen(true)}>
            Custom
          </button>
        </span>
        <span className={`usage-dates${customOpen ? " is-open" : ""}`}>
          <label>
            <span>From</span>
            <input
              type="date"
              value={custom.from}
              max={new Date().toISOString().slice(0, 10)}
              onChange={event => {
                const next = { ...custom, from: event.target.value };
                setCustom(next);
                if (next.from && next.through) setState({ ...state, range: next });
              }}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={custom.through}
              max={new Date().toISOString().slice(0, 10)}
              onChange={event => {
                const next = { ...custom, through: event.target.value };
                setCustom(next);
                if (next.from && next.through) setState({ ...state, range: next });
              }}
            />
          </label>
        </span>
      </div>

      {/* One fixed-height line whether or not anything is filtered, so the page
          below never shifts as you scope it. */}
      <div className="usage-chips">
        {error ? (
          <span role="alert">
            {error}{" "}
            <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>
              Retry
            </button>
          </span>
        ) : chips.length === 0 ? (
          <span>
            {load.loading && !snapshot ? "Loading usage…" : "Every project, provider and model in this workspace."}
          </span>
        ) : (
          <>
            <span>Filtered to</span>
            {chips.map(chip => (
              <button
                key={`${chip.kind}:${chip.value}`}
                className="usage-chip"
                type="button"
                onClick={() => dropChip(chip.kind, chip.value)}>
                {chip.label}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              className="text-button"
              type="button"
              onClick={() => setState({ ...state, filters: emptyFilters() })}>
              Clear all
            </button>
          </>
        )}
      </div>

      {/* The Inspector's session summary at page scale (.session-tool-summary):
          one big figure, the split beside it, and nothing else shouting. */}
      <div className="usage-summary">
        <div className="usage-summary-total">
          <small>{`Cost, ${periodLabel}`}</small>
          <strong className="mono">{money(total.cost)}</strong>
          <span>
            {total.costKnown ? "Reported pricing" : "Partial pricing"}
            {` · ${total.sessions.toLocaleString()} sessions`}
            {total.costEstimated > 0 ? ` · ${money(total.costEstimated)} split by rate` : ""}
            {partialHistory ? " · Partial history" : incompleteAttribution ? " · Attribution incomplete" : ""}
          </span>
        </div>
        <div className="usage-summary-split">
          <div>
            <small>By provider</small>
            {data.byProvider.length > 0 && <small>Select a provider to scope this page</small>}
          </div>
          {data.byProvider.length === 0 ? (
            <div className="usage-key">
              <span>No usage in this scope</span>
            </div>
          ) : (
            <>
              <div className="usage-split-bar">
                {data.byProvider.map(row => {
                  const share = percent(row.cost, total.cost);
                  return (
                    <button
                      key={row.value}
                      type="button"
                      style={
                        {
                          "--seg": tone("provider", row.value, colorDimensions),
                          flex: `0 0 ${share.toFixed(2)}%`,
                        } as React.CSSProperties
                      }
                      aria-pressed={state.filters.provider.has(row.value)}
                      title={`${row.name} · ${money(row.cost)} · ${share.toFixed(1)}%`}
                      onClick={() => toggleProvider(row.value)}>
                      <span className="sr-only">{`${row.name} ${money(row.cost)}`}</span>
                      {Array.from({ length: Math.max(1, Math.round((share / 100) * 56)) }, (_, index) => (
                        <i key={index} />
                      ))}
                    </button>
                  );
                })}
              </div>
              <div className="usage-key">
                {data.byProvider.map(row => (
                  <span
                    key={row.value}
                    style={{ "--seg": tone("provider", row.value, colorDimensions) } as React.CSSProperties}>
                    <i />
                    <strong>{row.name}</strong> <span className="mono">{money(row.cost)}</span>
                    {` · ${percent(row.cost, total.cost).toFixed(1)}%`}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="usage-strip">
        <div>
          <small>Input tokens</small>
          <strong className="mono">{formatCompactNumber(total.input)}</strong>
          <span>prompt and tool context</span>
        </div>
        <div>
          <small>Output tokens</small>
          <strong className="mono">{formatCompactNumber(total.output)}</strong>
          <span>{`${percent(total.output, total.input).toFixed(1)}% of input`}</span>
        </div>
        <div>
          <small>Sessions</small>
          <strong className="mono">{total.sessions.toLocaleString()}</strong>
          <span>{`${money(total.sessions ? total.cost / total.sessions : 0)} per session`}</span>
        </div>
        <div>
          <small>Cache hit rate</small>
          <strong className="mono">
            {`${total.cache.toFixed(1)}%`}
            <small>{`${formatCompactNumber(total.cacheRead)} cached`}</small>
          </strong>
          <span>weighted by input volume</span>
        </div>
      </div>

      <section className="usage-section">
        <div className="usage-section-head">
          {/* The measure is the heading: the word you would change is the
              control you press, so "Measure" needs no label of its own. */}
          <h2 className="usage-title">
            <Picker
              groups={MEASURES}
              value={state.metric}
              title="Measure"
              onChange={metric => setState({ ...state, metric })}
            />
            <span>over time</span>
          </h2>
          <span className="usage-field push">
            Broken down by
            <Picker
              groups={SPLITS}
              value={state.split}
              title="Break down"
              onChange={split => setState({ ...state, split })}
            />
          </span>
        </div>
        <Chart series={data.series} days={data.days} metric={state.metric} />
        {composed && (
          <div className="usage-legend">
            {data.series.map(item => (
              <div key={item.label} style={{ "--seg": item.color } as React.CSSProperties}>
                <div className="usage-legend-name">
                  <i />
                  {item.label}
                </div>
                <b className="mono">{format(item.amount)}</b>
                <small>
                  {item.part === "unsplit"
                    ? "billed without a split"
                    : state.split === "none"
                      ? `${percent(
                          item.amount,
                          data.series.reduce((sum, entry) => sum + entry.amount, 0),
                        ).toFixed(
                          1,
                        )}% of ${MEASURE_TITLE[state.metric].toLowerCase()}${estimatedSplit ? " · part estimated" : ""}`
                      : `${item.sessions} sessions · ${item.cache.toFixed(1)}% cache hit · ${formatCompactNumber(item.cacheRead)} cached`}
                </small>
              </div>
            ))}
          </div>
        )}
        <p className="usage-note">
          {state.split === "none" && composed
            ? data.series.some(item => item.part === "unsplit")
              ? "Days are UTC. Each column is one day: input at the base, output above it, and what the provider billed without a split on top."
              : "Days are UTC. Each column is one day: input at the base, output above it."
            : "Days are UTC. Each column is one day, lit to its share of the tallest day in view."}
          {/* A derived split is stated wherever it is being read, never folded in silently. */}
          {estimatedSplit && (
            <>
              {" "}
              {`Every total here is what you were billed. ${money(total.costEstimated)} of it was logged without a split, so that part's input and output come from model pricing rather than from the bill.`}
            </>
          )}
        </p>
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h2>Projects</h2>
          <button className="text-button push" type="button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
        <div className="usage-scroll-x">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Share</th>
                <th className="num">Sessions</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache hit</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byProject.length === 0 ? (
                <tr>
                  <td colSpan={7}>No usage matches this scope.</td>
                </tr>
              ) : (
                data.byProject.map(row => (
                  <tr key={row.value}>
                    <td>
                      <span
                        className="usage-name"
                        style={{ "--seg": tone("project", row.value, colorDimensions) } as React.CSSProperties}>
                        <i />
                        {row.name}
                      </span>
                    </td>
                    <td>
                      <span
                        className="usage-share"
                        style={{ "--seg": tone("project", row.value, colorDimensions) } as React.CSSProperties}>
                        <LedBar
                          a={percent(row.cost, total.cost)}
                          cells={14}
                          thin
                          label={`${percent(row.cost, total.cost).toFixed(1)}% of cost`}
                        />
                      </span>
                    </td>
                    <td className="num">{row.sessions}</td>
                    <td className="num">{formatCompactNumber(row.input)}</td>
                    <td className="num">{formatCompactNumber(row.output)}</td>
                    <td className="num">
                      <CacheCell input={row.input} cacheRead={row.cacheRead} rate={row.cache} />
                    </td>
                    <td className="num cost">{money(row.cost)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>Total for this period</td>
                <td className="num">{money(total.cost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="usage-section">
        <div className="usage-pair">
          <div>
            <div className="usage-section-head">
              <h2>Agents</h2>
              <small className="push">Includes delegated subagents</small>
            </div>
            {data.byAgent.length === 0 ? (
              <p className="usage-note">No usage in this scope.</p>
            ) : (
              data.byAgent.map(row => (
                <div
                  key={row.value}
                  className="usage-row"
                  style={{ "--seg": tone("agent", row.value, colorDimensions) } as React.CSSProperties}>
                  <div>
                    <strong>{row.name}</strong>
                    <LedBar a={rankShare(measure(row), agentPeak)} thin />
                  </div>
                  <b>{format(measure(row))}</b>
                </div>
              ))
            )}
          </div>
          <div>
            <div className="usage-section-head">
              <h2>Models</h2>
              <small className="push">{`by ${choiceLabel(MEASURES, state.metric).toLowerCase()}`}</small>
            </div>
            {data.byModel.length === 0 ? (
              <p className="usage-note">No usage in this scope.</p>
            ) : (
              data.byModel.map(row => (
                <div
                  key={row.value}
                  className="usage-row"
                  style={{ "--seg": tone("model", row.value, colorDimensions) } as React.CSSProperties}>
                  <div>
                    <strong className="mono-name">{row.name}</strong>
                    <LedBar a={rankShare(measure(row), modelPeak)} thin />
                  </div>
                  <b>{format(measure(row))}</b>
                </div>
              ))
            )}
          </div>
        </div>
        <p className="usage-note">
          Bars compare against the busiest row: every third of a bar is a tenfold difference.
        </p>
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h2>Most expensive sessions</h2>
          <small className="push">Open a session to see its turns</small>
        </div>
        {/* A top-N subset, not a decomposition, so it carries no total row — but
            it carries the same columns as Projects, read the same way. */}
        <div className="usage-scroll-x">
          <table className="usage-table usage-sessions">
            <thead>
              <tr>
                <th>Session</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache hit</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.topSessions.length === 0 ? (
                <tr>
                  <td colSpan={5}>No sessions match this scope.</td>
                </tr>
              ) : (
                data.topSessions.map(row => (
                  <tr
                    key={row.id}
                    role={onSelectSession ? "button" : undefined}
                    tabIndex={onSelectSession ? 0 : undefined}
                    onClick={() => onSelectSession?.(row.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectSession?.(row.id);
                      }
                    }}>
                    <td>
                      <span
                        className="usage-session-title"
                        style={{ "--seg": tone("project", row.projectId, colorDimensions) } as React.CSSProperties}>
                        <i />
                        <span>
                          <strong>{row.title}</strong>
                          <span className="meta">
                            <span>{row.project}</span>
                            <span>{row.model}</span>
                            <span>{row.agent}</span>
                            <span>{duration(row.elapsedMs)}</span>
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="num">{formatCompactNumber(row.input)}</td>
                    <td className="num">{formatCompactNumber(row.output)}</td>
                    <td className="num">
                      <CacheCell input={row.input} cacheRead={row.cacheRead} rate={row.cache} />
                    </td>
                    <td className="num cost">{money(row.cost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

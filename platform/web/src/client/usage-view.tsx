import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactNumber } from "../shared/format";
import type { UsageSnapshot } from "../shared/protocol/snapshots";
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

const FACETS = USAGE_FACETS;
const RANGES = [
  [7, "7d"],
  [30, "30d"],
  [90, "90d"],
] as const;
const MEASURES: [Metric, string][] = [
  ["total", "Input + output"],
  ["input", "Input"],
  ["output", "Output"],
  ["cost", "Cost"],
];
const SPLITS: [UsageSplit, string][] = [
  ["none", "Combined"],
  ["provider", "By provider"],
  ["model", "By model"],
];

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
  cache: 0,
};
const emptyFilters = (): Filters => ({ project: new Set(), provider: new Set(), model: new Set() });
const formatMeasure = (metric: Metric) => (value: number) =>
  metric === "cost" ? money(value) : formatCompactNumber(value);

/** Colours pin to a fixed order per dimension, so a provider keeps its colour. */
function tone(kind: Facet | "agent", value: string, dimensions: Dimensions): string {
  const list: readonly string[] = kind === "agent" ? USAGE_AGENT_ORDER : dimensions[kind].map(option => option.value);
  return `var(--c${(Math.max(0, list.indexOf(value)) % 5) + 1})`;
}

/** Round the axis to a step a person would say out loud. */
function axisScale(peak: number) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak / 4)));
  const step = ([1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= peak / 4) ?? 10) * magnitude;
  return { step, steps: Math.max(1, Math.ceil(peak / step)) };
}

function dateTick(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The viewBox is sized to the element's real pixel width so one SVG unit is
 * one CSS pixel — a fixed box gets scaled by the container, which would scale
 * the tick text with it.
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
  const plot = { left: 58, right: width - 14, top: 16, bottom: 206, labelY: 230 };
  const peak = Math.max(...series.flatMap(item => item.values), 1);
  const { step, steps } = axisScale(peak);
  const top = step * steps;
  const count = Math.max(days.length, 1);
  const x = (index: number) => plot.left + (index * (plot.right - plot.left)) / Math.max(1, count - 1);
  const y = (value: number) => plot.bottom - (value / top) * (plot.bottom - plot.top);
  const labelIndexes = [...new Set([0, Math.round((count - 1) / 3), Math.round(((count - 1) * 2) / 3), count - 1])];
  const anchors: { [index: number]: "start" | "end" } = { 0: "start", [count - 1]: "end" };
  return (
    <svg
      ref={ref}
      className="usage-chart"
      viewBox={`0 0 ${width} 244`}
      height={244}
      role="img"
      aria-label="Usage over time">
      {series.length === 0 ? (
        <text className="chart-empty" x="50%" y={118} textAnchor="middle">
          No draw in this range
        </text>
      ) : (
        <>
          {Array.from({ length: steps + 1 }, (_, index) => {
            const at = y(step * index);
            return (
              <g key={index}>
                <line className="grid" x1={plot.left} y1={at} x2={plot.right} y2={at} />
                <text className="tick" x={plot.left - 10} y={at + 4} textAnchor="end">
                  {format(step * index)}
                </text>
              </g>
            );
          })}
          {series.map(item => {
            const points = item.values.map((value, index) => [x(index), y(value)] as const);
            const path = points
              .map(([px, py], index) => `${index ? "L" : "M"} ${px.toFixed(1)},${py.toFixed(1)}`)
              .join(" ");
            return (
              <g key={item.label}>
                {series.length === 1 && (
                  <path
                    className="fill"
                    fill={item.color}
                    d={`${path} L ${plot.right},${plot.bottom} L ${plot.left},${plot.bottom} Z`}
                  />
                )}
                <path className="trace" stroke={item.color} strokeDasharray={item.dash ? "6 5" : undefined} d={path} />
                {points.map(([px, py], index) => (
                  <circle key={index} className="dot" cx={px} cy={py} r={2.5} stroke={item.color} />
                ))}
              </g>
            );
          })}
          {labelIndexes.map(index => (
            <text key={index} className="tick" x={x(index)} y={plot.labelY} textAnchor={anchors[index] ?? "middle"}>
              {days[index] ? dateTick(days[index]) : ""}
            </text>
          ))}
        </>
      )}
    </svg>
  );
}

const BAND_CELLS = 56;
const RANK_CELLS = 24;

/** The band keeps its proportional reading, drawn with the app's LED cells. */
function Band({
  kind,
  groups,
  total,
  dimensions,
  selected,
  onToggle,
}: {
  kind: Facet | "agent";
  groups: Group[];
  total: number;
  dimensions: Dimensions;
  selected?: Set<string>;
  onToggle?: (value: string) => void;
}) {
  if (groups.length === 0)
    return (
      <div className="usage-band-key">
        <div>
          <span>No usage in scope</span>
        </div>
      </div>
    );
  return (
    <>
      <div className="usage-band">
        {groups.map(row => {
          const share = percent(row.cost, total);
          const cells = Math.max(1, Math.round((share / 100) * BAND_CELLS));
          return (
            <button
              key={row.value}
              type="button"
              style={
                { "--seg": tone(kind, row.value, dimensions), flex: `0 0 ${share.toFixed(2)}%` } as React.CSSProperties
              }
              disabled={!onToggle}
              aria-pressed={selected?.has(row.value) ?? false}
              title={`${row.name} · ${money(row.cost)} · ${share.toFixed(1)}%`}
              onClick={() => onToggle?.(row.value)}>
              <span className="sr-only">{`${row.name} ${money(row.cost)}`}</span>
              {Array.from({ length: cells }, (_, index) => (
                <i key={index} />
              ))}
            </button>
          );
        })}
      </div>
      <div className="usage-band-key">
        {groups.map(row => (
          <div key={row.value} style={{ "--seg": tone(kind, row.value, dimensions) } as React.CSSProperties}>
            <i />
            <b>{row.name}</b>
            <span>{`${money(row.cost)} · ${percent(row.cost, total).toFixed(1)}%`}</span>
          </div>
        ))}
      </div>
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
        const fallback = `${kind[0].toUpperCase()}${kind.slice(1)}s`;
        const chosenLabel = dimensions[kind].find(option => option.value === chosen[0])?.label ?? chosen[0];
        return (
          <details key={kind} className="usage-facet">
            <summary>
              <span>{chosen.length === 1 ? chosenLabel : fallback}</span>
              {chosen.length > 1 && <span className="usage-facet-count">{chosen.length}</span>}
            </summary>
            <div className="usage-facet-menu">
              <div className="usage-facet-head">
                <span>Select any</span>
                <button
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
  const [state, setState] = useState<State>({ filters: emptyFilters(), range: 30, metric: "total", split: "none" });
  const [custom, setCustom] = useState({ from: "", through: "" });
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
      color: item.kind
        ? tone(item.kind, item.value, colorDimensions)
        : state.metric === "total"
          ? `var(--c${item.dash ? 2 : 1})`
          : "var(--c1)",
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

  const measure = (value: Pick<Group, "input" | "output" | "cost">) => measureUsage(state.metric, value);
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
  const duration = (elapsedMs: number) => {
    const minutes = Math.round(elapsedMs / 60_000);
    if (!minutes) return "—";
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  };
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
  const issued =
    error && !snapshot
      ? "Usage unavailable"
      : load.loading
        ? snapshot
          ? "Refreshing usage"
          : "Loading usage"
        : partialHistory
          ? "Partial history"
          : incompleteAttribution
            ? "Attribution incomplete"
            : "Usage current";

  return (
    <div className="usage-sheet">
      <header className="usage-head">
        <div>
          <h1>Usage</h1>
        </div>
        <div className="usage-issued">
          {/* {issued}
          <br /> */}
          {total.costKnown ? "Reported pricing" : "Partial pricing"}
        </div>
      </header>

      <section className="usage-scope" aria-label="Scope">
        <span className="section-kicker">Meter</span>
        <Facets state={state} dimensions={dimensions} onChange={setState} />
        <div className="usage-period">
          <div className="usage-range" role="group" aria-label="Period">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={state.range === value}
                onClick={() => {
                  setCustom({ from: "", through: "" });
                  setState({ ...state, range: value });
                }}>
                {label}
              </button>
            ))}
          </div>
          <div
            className={`usage-date-range${typeof state.range === "number" ? "" : " is-active"}`}
            aria-label="Custom period">
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
            <i aria-hidden="true" />
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
          </div>
        </div>
      </section>

      <div className="usage-chips">
        {error ? (
          <span role="alert">
            {error}{" "}
            <button className="usage-clear" type="button" onClick={() => setRetry(value => value + 1)}>
              Retry
            </button>
          </span>
        ) : chips.length === 0 ? (
          <span>
            {load.loading && !snapshot ? "Loading metered usage…" : "Metering every project, provider and model."}
          </span>
        ) : (
          <>
            <span className="usage-label">Metering</span>
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
              className="usage-clear"
              type="button"
              onClick={() => setState({ ...state, filters: emptyFilters() })}>
              Clear all
            </button>
          </>
        )}
      </div>

      <section className="usage-hero">
        <div>
          <span className="usage-label">
            Total draw ·{" "}
            {typeof state.range === "number" ? `${state.range} days` : `${state.range.from} to ${state.range.through}`}
          </span>
          <div className="usage-total">
            {money(total.cost)}
            <small>{total.costKnown ? "reported" : "partial"}</small>
          </div>
          <div className="usage-band-block">
            <div className="usage-band-title">
              <span className="usage-band-name">Draw by provider</span>
              <em>Select a segment to meter that provider only</em>
            </div>
            <Band
              kind="provider"
              groups={data.byProvider}
              total={total.cost}
              dimensions={colorDimensions}
              selected={state.filters.provider}
              onToggle={toggleProvider}
            />
          </div>
          <div className="usage-band-block">
            <div className="usage-band-title">
              <span className="usage-band-name">Draw by Pylon agent</span>
              <em>Includes delegated subagent work</em>
            </div>
            <Band kind="agent" groups={data.byAgent} total={total.cost} dimensions={colorDimensions} />
          </div>
        </div>
        <dl className="usage-figures">
          {(
            [
              ["Input tokens", formatCompactNumber(total.input), "prompts and tool context"],
              [
                "Output tokens",
                formatCompactNumber(total.output),
                `${percent(total.output, total.input).toFixed(1)}% of input`,
              ],
              [
                "Sessions",
                total.sessions.toLocaleString(),
                `${money(total.sessions ? total.cost / total.sessions : 0)} per session`,
              ],
              ["Cache hit rate", `${total.cache.toFixed(1)}%`, "weighted by input volume"],
            ] as const
          ).map(([term, value, note]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>
                <b>{value}</b>
                <em>{note}</em>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h2>Draw over time</h2>
          <div className="usage-controls">
            <div>
              <span className="usage-label">Measure</span>
              <span className="usage-segbar">
                {MEASURES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={state.metric === value}
                    onClick={() => setState({ ...state, metric: value })}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
            <div>
              <span className="usage-label">Lines</span>
              <span className="usage-segbar">
                {SPLITS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={state.split === value}
                    onClick={() => setState({ ...state, split: value })}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
          </div>
        </div>
        <Chart series={data.series} days={data.days} metric={state.metric} />
        <div className="usage-series">
          {data.series.length === 0 ? (
            <div>
              <small>Widen the range, or clear a filter on the meter.</small>
            </div>
          ) : (
            data.series.map(item => (
              <div key={item.label}>
                <div className="usage-series-name" style={{ "--seg": item.color } as React.CSSProperties}>
                  <i className={item.dash ? "dash" : undefined} />
                  {item.label}
                </div>
                <b>{format(item.amount)}</b>
                <small>{`${item.sessions} sessions · ${item.cache.toFixed(1)}% cache`}</small>
              </div>
            ))
          )}
        </div>
        <p className="usage-note">Daily buckets use UTC.</p>
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h2>Line items by project</h2>
          <button className="usage-export" type="button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
        <div className="usage-scroll-x">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Sessions</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache hit</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.byProject.length === 0 ? (
                <tr>
                  <td colSpan={6}>No usage matches this scope.</td>
                </tr>
              ) : (
                data.byProject.map(row => (
                  <tr key={row.value}>
                    <td>
                      <span
                        className="usage-cell-name"
                        style={{ "--seg": tone("project", row.value, colorDimensions) } as React.CSSProperties}>
                        <i />
                        {row.name}
                      </span>
                    </td>
                    <td className="num">{row.sessions}</td>
                    <td className="num">{formatCompactNumber(row.input)}</td>
                    <td className="num">{formatCompactNumber(row.output)}</td>
                    <td className="num">{row.cache.toFixed(1)}%</td>
                    <td className="num pay">{money(row.cost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="usage-foot">
          <span>Total for period</span>
          <b>{money(total.cost)}</b>
        </div>
      </section>

      <section className="usage-pair">
        <div>
          <div className="usage-section-head">
            <h2>Heaviest models</h2>
          </div>
          {data.byModel.map(row => {
            const lit = Math.round((measure(row) / modelPeak) * RANK_CELLS);
            return (
              <div
                key={row.value}
                className="usage-rank"
                style={{ "--seg": tone("model", row.value, colorDimensions) } as React.CSSProperties}>
                <div>
                  <b>{row.name}</b>
                  <span className="usage-rank-bar">
                    {Array.from({ length: RANK_CELLS }, (_, index) => (
                      <i key={index} className={index < lit ? "on" : undefined} />
                    ))}
                  </span>
                </div>
                <span>{format(measure(row))}</span>
              </div>
            );
          })}
          <p className="usage-note">Bar length is share of the heaviest model, by the selected measure.</p>
        </div>
        <div>
          <div className="usage-section-head">
            <h2>Heaviest sessions</h2>
          </div>
          {data.topSessions.map(row => (
            <div
              key={row.id}
              className="usage-session"
              style={{ "--seg": tone("project", row.projectId, colorDimensions) } as React.CSSProperties}
              role={onSelectSession ? "button" : undefined}
              tabIndex={onSelectSession ? 0 : undefined}
              onClick={() => onSelectSession?.(row.id)}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectSession?.(row.id);
                }
              }}>
              <i />
              <strong>{row.title}</strong>
              <span>
                <span>{row.project}</span>
                <span>{row.model}</span>
                <span>{row.agent}</span>
                <span>{duration(row.elapsedMs)}</span>
              </span>
              <b>{format(measure(row))}</b>
            </div>
          ))}
          <p className="usage-note">Single sessions inside the metered window, by the selected measure.</p>
        </div>
      </section>
    </div>
  );
}

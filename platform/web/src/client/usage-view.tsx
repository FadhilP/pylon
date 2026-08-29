import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactNumber } from "../shared/format";

/**
 * Metered draw across every project, agent and provider in the workspace.
 *
 * The figures below are SAMPLE DATA. Real usage is per-session today —
 * SessionMetricsReadModel carries model, provider, tokens and cost, but only
 * for the live runtime — so a cross-session aggregate needs a server-side
 * sweep that does not exist yet. Swapping `RECORDS` and `SESSIONS` for a
 * fetch is the whole of that change; nothing below them knows the difference.
 */

type Record = {
  project: string;
  provider: string;
  model: string;
  agent: string;
  sessions: number;
  input: number;
  output: number;
  cost: number;
  cache: number;
};

const RECORDS: Record[] = [
  {
    project: "Pylon",
    provider: "Anthropic",
    model: "claude-opus-5",
    agent: "Advisor",
    sessions: 38,
    input: 2180000,
    output: 604000,
    cost: 25.42,
    cache: 51.4,
  },
  {
    project: "Pylon",
    provider: "OpenAI",
    model: "gpt-5.2",
    agent: "Scout",
    sessions: 24,
    input: 1420000,
    output: 418000,
    cost: 20.83,
    cache: 38.7,
  },
  {
    project: "Pylon",
    provider: "Anthropic",
    model: "claude-sonnet-5",
    agent: "Grunt",
    sessions: 13,
    input: 704000,
    output: 272000,
    cost: 7.84,
    cache: 45.2,
  },
  {
    project: "pi-coding-agent",
    provider: "OpenAI",
    model: "gpt-5.2",
    agent: "Main agent",
    sessions: 16,
    input: 680000,
    output: 156000,
    cost: 6.44,
    cache: 41.8,
  },
  {
    project: "pi-coding-agent",
    provider: "Google",
    model: "gemini-3.1-pro",
    agent: "Private agents",
    sessions: 11,
    input: 682000,
    output: 174000,
    cost: 5.92,
    cache: 29.1,
  },
  {
    project: "Continuity",
    provider: "Anthropic",
    model: "claude-sonnet-5",
    agent: "Scout",
    sessions: 7,
    input: 328000,
    output: 88000,
    cost: 2.65,
    cache: 51.6,
  },
  {
    project: "Continuity",
    provider: "Anthropic",
    model: "claude-haiku-4-5",
    agent: "Grunt",
    sessions: 5,
    input: 236000,
    output: 84000,
    cost: 2.44,
    cache: 39.6,
  },
  {
    project: "Helios",
    provider: "Google",
    model: "gemini-3.1-pro",
    agent: "Private agents",
    sessions: 5,
    input: 246000,
    output: 62000,
    cost: 2.02,
    cache: 31.3,
  },
  {
    project: "Helios",
    provider: "Anthropic",
    model: "claude-opus-5",
    agent: "Advisor",
    sessions: 3,
    input: 154000,
    output: 46000,
    cost: 1.26,
    cache: 35.5,
  },
];

type SessionRecord = Omit<Record, "sessions" | "cache"> & { title: string; minutes: number; daysAgo: number };

/** A top-N subset rather than a breakdown, so it need not sum to the total. */
const SESSIONS: SessionRecord[] = [
  {
    title: "Refactor the advisor budget guard",
    project: "Pylon",
    provider: "Anthropic",
    model: "claude-opus-5",
    agent: "Advisor",
    input: 412000,
    output: 96000,
    cost: 4.82,
    minutes: 74,
    daysAgo: 1,
  },
  {
    title: "Migrate the worktree handoff path",
    project: "Pylon",
    provider: "OpenAI",
    model: "gpt-5.2",
    agent: "Scout",
    input: 366000,
    output: 88000,
    cost: 4.11,
    minutes: 96,
    daysAgo: 3,
  },
  {
    title: "Rebuild the inspector prototypes",
    project: "Pylon",
    provider: "Anthropic",
    model: "claude-opus-5",
    agent: "Advisor",
    input: 298000,
    output: 132000,
    cost: 3.94,
    minutes: 128,
    daysAgo: 2,
  },
  {
    title: "Trace the sieve rollover regression",
    project: "Pylon",
    provider: "Anthropic",
    model: "claude-sonnet-5",
    agent: "Grunt",
    input: 244000,
    output: 71000,
    cost: 2.18,
    minutes: 41,
    daysAgo: 6,
  },
  {
    title: "Port the extension loader to Pi",
    project: "pi-coding-agent",
    provider: "OpenAI",
    model: "gpt-5.2",
    agent: "Main agent",
    input: 208000,
    output: 54000,
    cost: 1.96,
    minutes: 63,
    daysAgo: 5,
  },
  {
    title: "Survey the papercut backlog",
    project: "pi-coding-agent",
    provider: "Google",
    model: "gemini-3.1-pro",
    agent: "Private agents",
    input: 186000,
    output: 48000,
    cost: 1.62,
    minutes: 37,
    daysAgo: 12,
  },
  {
    title: "Wire memory activation into run",
    project: "Continuity",
    provider: "Anthropic",
    model: "claude-sonnet-5",
    agent: "Scout",
    input: 154000,
    output: 42000,
    cost: 1.31,
    minutes: 52,
    daysAgo: 9,
  },
  {
    title: "Audit the browser sandbox flags",
    project: "Helios",
    provider: "Google",
    model: "gemini-3.1-pro",
    agent: "Private agents",
    input: 132000,
    output: 31000,
    cost: 1.08,
    minutes: 29,
    daysAgo: 21,
  },
];

type Facet = "project" | "provider" | "model";
type Metric = "total" | "input" | "output" | "cost";
const FACETS: Facet[] = ["project", "provider", "model"];
const RANGES = [
  ["7", "7d"],
  ["30", "30d"],
  ["90", "90d"],
] as const;
const MEASURES: [Metric, string][] = [
  ["total", "Input + output"],
  ["input", "Input"],
  ["output", "Output"],
  ["cost", "Cost"],
];
const SPLITS = [
  ["none", "Combined"],
  ["provider", "By provider"],
  ["model", "By model"],
] as const;

const DAILY_SHAPE = [0.62, 0.78, 0.7, 0.89, 1.03, 0.84, 0.63, 0.94, 1.16, 1.08, 1.21, 1.39, 1.17, 1.24];
/** Agents run in role order so a band keeps its reading whatever the filters do. */
const AGENT_ORDER = ["Main agent", "Scout", "Grunt", "Advisor", "Private agents"];

const unique = (key: keyof Record) => [...new Set(RECORDS.map(row => String(row[key])))];
const DIMENSIONS: Record_<Facet, string[]> = {
  project: unique("project"),
  provider: unique("provider"),
  model: unique("model"),
};
type Record_<K extends string, V> = { [key in K]: V };
const AGENTS = [...AGENT_ORDER, ...unique("agent").filter(name => !AGENT_ORDER.includes(name))];

/** Colours pin to a fixed order per dimension, so a provider keeps its colour. */
function tone(kind: Facet | "agent", name: string): string {
  const list = kind === "agent" ? AGENTS : DIMENSIONS[kind];
  return `var(--c${(Math.max(0, list.indexOf(name)) % 5) + 1})`;
}

const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

type Group = { name: string; sessions: number; input: number; output: number; cost: number; cache: number };
type Filters = { project: Set<string>; provider: Set<string>; model: Set<string> };
type State = { filters: Filters; range: string; metric: Metric; split: string };

function scopedRecords(state: State): Record[] {
  const factor = state.range === "7" ? 0.28 : state.range === "90" ? 2.55 : 1;
  return RECORDS.filter(row =>
    FACETS.every(key => state.filters[key].size === 0 || state.filters[key].has(row[key])),
  ).map(row => ({
    ...row,
    sessions: Math.max(1, Math.round(row.sessions * factor)),
    input: Math.round(row.input * factor),
    output: Math.round(row.output * factor),
    cost: row.cost * factor,
  }));
}

function aggregate(rows: Record[], key?: keyof Record): Group[] {
  const groups = new Map<string, Group & { weighted: number }>();
  for (const row of rows) {
    const name = key ? String(row[key]) : "Total";
    const item = groups.get(name) ?? { name, sessions: 0, input: 0, output: 0, cost: 0, cache: 0, weighted: 0 };
    item.sessions += row.sessions;
    item.input += row.input;
    item.output += row.output;
    item.cost += row.cost;
    item.weighted += row.cache * row.input;
    groups.set(name, item);
  }
  return [...groups.values()].map(item => ({ ...item, cache: item.input ? item.weighted / item.input : 0 }));
}

const EMPTY: Group = { name: "Total", sessions: 0, input: 0, output: 0, cost: 0, cache: 0 };
const measureOf = (metric: Metric) => (row: { input: number; output: number; cost: number }) =>
  metric === "input"
    ? row.input
    : metric === "output"
      ? row.output
      : metric === "cost"
        ? row.cost
        : row.input + row.output;
const formatMeasure = (metric: Metric) => (value: number) =>
  metric === "cost" ? money(value) : formatCompactNumber(value);

/** Round the axis to a step a person would say out loud. */
function axisScale(peak: number) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak / 4)));
  const step = ([1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= peak / 4) ?? 10) * magnitude;
  return { step, steps: Math.max(1, Math.ceil(peak / step)) };
}

type Series = {
  label: string;
  amount: number;
  dash: boolean;
  color: string;
  values: number[];
  sessions: number;
  cache: number;
};

function buildSeries(state: State): Series[] {
  const paired = state.metric === "total";
  const key = state.split === "none" ? undefined : (state.split as Facet);
  const measure = measureOf(state.metric);
  const groups = aggregate(scopedRecords(state), key).sort((a, b) => measure(b) - measure(a));
  const curve = (amount: number, seed: number) =>
    DAILY_SHAPE.map((shape, day) => (amount / DAILY_SHAPE.length) * shape * (1 + Math.sin((day + 1) * seed) * 0.055));
  if (!paired)
    return groups.map((group, index) => ({
      label: group.name,
      amount: measure(group),
      dash: false,
      color: key ? tone(key, group.name) : "var(--c1)",
      values: curve(measure(group), index + 2),
      sessions: group.sessions,
      cache: group.cache,
    }));
  return groups.flatMap((group, index) =>
    (
      [
        ["Input", group.input, false],
        ["Output", group.output, true],
      ] as const
    ).map(([part, amount, dash], slot) => ({
      label: key ? `${group.name} · ${part.toLowerCase()}` : part,
      amount,
      dash,
      color: key ? tone(key, group.name) : `var(--c${slot + 1})`,
      values: curve(amount, index + 2 + slot * 0.8),
      sessions: group.sessions,
      cache: group.cache,
    })),
  );
}

function dateTicks(range: string): string[] {
  const span = Number(range);
  const end = new Date();
  return DAILY_SHAPE.map((_, index) => {
    const day = new Date(end);
    day.setDate(end.getDate() - Math.round(((DAILY_SHAPE.length - 1 - index) * span) / (DAILY_SHAPE.length - 1)));
    return day.toLocaleDateString("en", { month: "short", day: "numeric" });
  });
}

/**
 * The viewBox is sized to the element's real pixel width so one SVG unit is
 * one CSS pixel — a fixed box gets scaled by the container, which would scale
 * the tick text with it.
 */
function Chart({ series, range, metric }: { series: Series[]; range: string; metric: Metric }) {
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
  const count = series[0]?.values.length ?? DAILY_SHAPE.length;
  const x = (index: number) => plot.left + (index * (plot.right - plot.left)) / (count - 1);
  const y = (value: number) => plot.bottom - (value / top) * (plot.bottom - plot.top);
  const stamps = dateTicks(range);
  const anchors: { [index: number]: "start" | "end" } = { 0: "start", 13: "end" };

  return (
    <svg
      ref={ref}
      className="usage-chart"
      viewBox={`0 0 ${width} 244`}
      height={244}
      role="img"
      aria-label="Usage over time">
      {series.length === 0 ? (
        <text className="tick" x={plot.left} y={110}>
          No usage matches this scope.
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
          {[0, 4, 9, 13].map(index => (
            <text key={index} className="tick" x={x(index)} y={plot.labelY} textAnchor={anchors[index] ?? "middle"}>
              {stamps[index]}
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
  selected,
  onToggle,
}: {
  kind: Facet | "agent";
  groups: Group[];
  total: number;
  selected?: Set<string>;
  onToggle?: (name: string) => void;
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
              key={row.name}
              type="button"
              style={{ "--seg": tone(kind, row.name), flex: `0 0 ${share.toFixed(2)}%` } as React.CSSProperties}
              disabled={!onToggle}
              aria-pressed={selected?.has(row.name) ?? false}
              title={`${row.name} · ${money(row.cost)} · ${share.toFixed(1)}%`}
              onClick={() => onToggle?.(row.name)}>
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
          <div key={row.name} style={{ "--seg": tone(kind, row.name) } as React.CSSProperties}>
            <i />
            <b>{row.name}</b>
            <span>{`${money(row.cost)} · ${percent(row.cost, total).toFixed(1)}%`}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Facets({ state, onChange }: { state: State; onChange: (next: State) => void }) {
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
        return (
          <details key={kind} className="usage-facet">
            <summary>
              <span>{chosen.length === 1 ? chosen[0] : fallback}</span>
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
              {DIMENSIONS[kind].map(value => (
                <label key={value} className="usage-facet-option">
                  <input
                    type="checkbox"
                    checked={state.filters[kind].has(value)}
                    onChange={() => setFilter(kind, value)}
                  />
                  <span>{value}</span>
                  <small>
                    {RECORDS.filter(row => row[kind] === value).reduce((sum, row) => sum + row.sessions, 0)} sessions
                  </small>
                </label>
              ))}
            </div>
          </details>
        );
      })}
    </>
  );
}

export function UsageView() {
  const [state, setState] = useState<State>({
    filters: { project: new Set(), provider: new Set(), model: new Set() },
    range: "30",
    metric: "total",
    split: "none",
  });

  const data = useMemo(() => {
    const rows = scopedRecords(state);
    const measure = measureOf(state.metric);
    const byMeasure = (a: Group, b: Group) => measure(b) - measure(a);
    return {
      total: aggregate(rows)[0] ?? EMPTY,
      byProject: aggregate(rows, "project").sort(byMeasure),
      byProvider: aggregate(rows, "provider").sort((a, b) => b.cost - a.cost),
      byAgent: aggregate(rows, "agent").sort((a, b) => AGENTS.indexOf(a.name) - AGENTS.indexOf(b.name)),
      byModel: aggregate(rows, "model").sort(byMeasure),
      topSessions: SESSIONS.filter(
        row =>
          row.daysAgo <= Number(state.range) &&
          FACETS.every(key => state.filters[key].size === 0 || state.filters[key].has(row[key])),
      )
        .sort((a, b) => measure(b) - measure(a))
        .slice(0, 6),
      series: buildSeries(state),
    };
  }, [state]);

  const measure = measureOf(state.metric);
  const format = formatMeasure(state.metric);
  const { total } = data;
  const chips = FACETS.flatMap(kind => [...state.filters[kind]].map(value => ({ kind, value })));
  const modelPeak = Math.max(...data.byModel.map(measure), 1);
  const duration = (minutes: number) =>
    minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const dropChip = (kind: Facet, value: string) => {
    const next = new Set(state.filters[kind]);
    next.delete(value);
    setState({ ...state, filters: { ...state.filters, [kind]: next } });
  };
  const toggleProvider = (name: string) => {
    const next = new Set(state.filters.provider);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setState({ ...state, filters: { ...state.filters, provider: next } });
  };
  const exportCsv = () => {
    const header = ["project", "provider", "model", "agent", "sessions", "input", "output", "cache_pct", "est_cost"];
    const body = scopedRecords(state).map(row =>
      [
        row.project,
        row.provider,
        row.model,
        row.agent,
        row.sessions,
        row.input,
        row.output,
        row.cache,
        row.cost.toFixed(2),
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv" });
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: "pylon-usage.csv",
    });
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="usage-sheet">
      <header className="usage-head">
        <div>
          <h1>Usage</h1>
          <p>Metered draw across every project, agent and provider in this workspace.</p>
        </div>
        <div className="usage-issued">
          Sample data
          <br />
          Estimated pricing
        </div>
      </header>

      <section className="usage-scope" aria-label="Scope">
        <span className="section-kicker">Meter</span>
        <Facets state={state} onChange={setState} />
        <div className="usage-range" role="group" aria-label="Period">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={state.range === value}
              onClick={() => setState({ ...state, range: value })}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <div className="usage-chips">
        {chips.length === 0 ? (
          <span>Metering every project, provider and model.</span>
        ) : (
          <>
            <span className="section-kicker">Metering</span>
            {chips.map(chip => (
              <button
                key={`${chip.kind}:${chip.value}`}
                className="usage-chip"
                type="button"
                onClick={() => dropChip(chip.kind, chip.value)}>
                {chip.value}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            <button
              className="usage-clear"
              type="button"
              onClick={() =>
                setState({ ...state, filters: { project: new Set(), provider: new Set(), model: new Set() } })
              }>
              Clear all
            </button>
          </>
        )}
      </div>

      <section className="usage-hero">
        <div>
          <span className="section-kicker">Total draw · {state.range} days</span>
          <div className="usage-total">
            {money(total.cost)}
            <small>estimated</small>
          </div>
          <div className="usage-band-block">
            <div className="usage-band-title">
              <span className="section-kicker">Draw by provider</span>
              <em>Select a segment to meter that provider only</em>
            </div>
            <Band
              kind="provider"
              groups={data.byProvider}
              total={total.cost}
              selected={state.filters.provider}
              onToggle={toggleProvider}
            />
          </div>
          <div className="usage-band-block">
            <div className="usage-band-title">
              <span className="section-kicker">Draw by Pylon agent</span>
              <em>Includes delegated subagent work</em>
            </div>
            <Band kind="agent" groups={data.byAgent} total={total.cost} />
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
              <span className="section-kicker">Measure</span>
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
              <span className="section-kicker">Lines</span>
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
        <Chart series={data.series} range={state.range} metric={state.metric} />
        <div className="usage-series">
          {data.series.length === 0 ? (
            <div>
              <small>No usage matches this scope.</small>
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
                  <tr key={row.name}>
                    <td>
                      <span
                        className="usage-cell-name"
                        style={{ "--seg": tone("project", row.name) } as React.CSSProperties}>
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
                key={row.name}
                className="usage-rank"
                style={{ "--seg": tone("model", row.name) } as React.CSSProperties}>
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
              key={row.title}
              className="usage-session"
              style={{ "--seg": tone("project", row.project) } as React.CSSProperties}>
              <i />
              <strong>{row.title}</strong>
              <span>
                <span>{row.project}</span>
                <span>{row.model}</span>
                <span>{row.agent}</span>
                <span>{duration(row.minutes)}</span>
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

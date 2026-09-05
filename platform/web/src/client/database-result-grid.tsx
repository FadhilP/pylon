import { useEffect, useMemo, useRef, useState } from "react";
import { databaseBytes, databaseCell, type DatabaseResult } from "../shared/database-workspace";
import { runtimeStore } from "./runtime/event-store";
import type { StateQLCommandInput, StateQLCommandResult } from "../shared/protocol/snapshots";

let rowQueue: Promise<void> = Promise.resolve();
const buffers = new Map<object, number>();

export function DatabaseResultGrid({
  result,
  scope,
  editable = false,
  disabled = false,
  onCommand,
  onSaved,
}: {
  result: DatabaseResult;
  scope: string;
  editable?: boolean;
  disabled?: boolean;
  onCommand?: (input: StateQLCommandInput) => Promise<StateQLCommandResult | undefined>;
  onSaved?: () => void;
}) {
  const [tokens, setTokens] = useState<Array<string | null>>([]);
  const [writable, setWritable] = useState<string[]>([]);
  const [editingReason, setEditingReason] = useState("");
  const [edit, setEdit] = useState<{
    token: string;
    column: string;
    value: string;
    unset: boolean;
    plan?: string;
    expires?: string;
  }>();
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [columns, setColumns] = useState(result.columns);
  const [loading, setLoading] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [column, setColumn] = useState("");
  const [comparison, setComparison] = useState("contains");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState<"json" | "jsonl" | "csv">("csv");
  const downloadController = useRef<AbortController | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const owner = {};
    buffers.set(owner, 0);
    setRows([]);
    setTokens([]);
    setEdit(undefined);
    setColumns(result.columns);
    setComplete(false);
    setLoading(true);
    setError("");
    const drain = async () => {
      const collected: Array<Record<string, unknown>> = [];
      const rowTokens: Array<string | null> = [];
      let offset = 0;
      let bytes = 0;
      let fullValues = true;
      try {
        while (!abort.signal.aborted) {
          const page = await runtimeStore.stateqlRows(result.result_id, offset, 100, abort.signal);
          if (abort.signal.aborted) return;
          if (
            page.total !== result.rows ||
            page.offset !== offset ||
            page.returned !== page.rows.length ||
            (page.next_offset !== null && page.next_offset !== offset + page.returned) ||
            (page.next_offset !== null && !page.returned)
          )
            throw new Error("Result changed while loading. Run the query again.");
          const size = databaseBytes(page.rows);
          const otherBytes = [...buffers.entries()].reduce((sum, [key, value]) => sum + (key === owner ? 0 : value), 0);
          if (
            collected.length + page.returned > 10_000 ||
            bytes + size > 8 * 1024 * 1024 ||
            otherBytes + bytes + size > 16 * 1024 * 1024
          )
            throw new Error("Loaded-row limit reached. Export the complete stored result or close another result tab.");
          bytes += size;
          buffers.set(owner, bytes);
          collected.push(...page.rows);
          rowTokens.push(...(page.row_tokens ?? page.rows.map(() => null)));
          setTokens([...rowTokens]);
          setWritable(page.writable_columns ?? []);
          setEditingReason(page.editing_reason ?? "Rows with unsupported types or expired identity are read-only.");
          fullValues &&= page.full_values === true;
          if (page.columns) setColumns(page.columns);
          setRows([...collected]);
          if (page.next_offset === null) {
            if (collected.length !== page.total) throw new Error("The result page ended early.");
            setComplete(fullValues);
            if (!fullValues) setError("Some cells are compact previews. Export for complete stored values.");
            return;
          }
          offset = page.next_offset;
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Result loading failed.");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    rowQueue = rowQueue.then(drain, drain);
    return () => {
      abort.abort();
      downloadController.current?.abort();
      buffers.delete(owner);
    };
  }, [result.result_id, scope, revision]);

  const filtered = useMemo(
    () =>
      rows.filter(row => {
        const values = column ? [row[column]] : Object.values(row);
        return values.some(value => {
          if (comparison === "null") return value === null;
          if (comparison === "missing") return value === undefined;
          if (comparison === "true" || comparison === "false") return value === (comparison === "true");
          if (comparison === "before" || comparison === "after") {
            const type = columns.find(item => item.name === column)?.type ?? "";
            if (!/date|time/i.test(type) || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value))
              return false;
            const actual = Date.parse(value);
            const expected = Date.parse(filter);
            return (
              Number.isFinite(actual) &&
              Number.isFinite(expected) &&
              (comparison === "before" ? actual < expected : actual > expected)
            );
          }
          if (!filter) return true;
          if (comparison === "contains")
            return databaseCell(value).toLocaleLowerCase().includes(filter.toLocaleLowerCase());
          if (comparison === "equals") return databaseCell(value) === filter;
          if (typeof value !== "number" || !Number.isFinite(Number(filter))) return false;
          return comparison === "greater" ? value > Number(filter) : value < Number(filter);
        });
      }),
    [rows, columns, column, comparison, filter],
  );
  const rowIndices = useMemo(() => new Map(rows.map((row, index) => [row, index])), [rows]);
  const first = Math.max(0, Math.floor(scrollTop / 32) - 8);
  const visible = filtered.slice(first, first + Math.ceil(height / 32) + 16);
  useEffect(() => {
    setScrollTop(0);
    setEdit(undefined);
    viewport.current?.scrollTo({ top: 0 });
  }, [filter, column, comparison]);

  const download = async () => {
    const abort = new AbortController();
    downloadController.current = abort;
    setExporting(true);
    try {
      const blob = await runtimeStore.stateqlExport(result.result_id, format, abort.signal);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `result.${format}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      if (!abort.signal.aborted) setExporting(false);
    }
  };

  const save = async (apply: boolean) => {
    if (!edit || !onCommand) return;
    const submitted = edit;
    try {
      const input: StateQLCommandInput =
        apply && edit.plan
          ? { command: "apply", handle: edit.plan }
          : {
              command: "table.plan",
              row_token: edit.token,
              changes: edit.unset ? { unset: [edit.column] } : { set: { [edit.column]: JSON.parse(edit.value) } },
            };
      const response = await onCommand(input);
      if (response?.status !== "completed" || !response.response.ok) return;
      const value = response.response.data as { plan_id?: string; expires_at?: string };
      if (apply) {
        setEdit(undefined);
        onSaved?.();
      } else if (value.plan_id)
        setEdit(current =>
          current === submitted ? { ...current, plan: value.plan_id, expires: value.expires_at } : current,
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Use valid JSON for this cell.");
    }
  };

  return (
    <section className="database-result" aria-label="Query result">
      <div className="database-toolbar">
        <label className="sr-only" htmlFor={`filter-${result.result_id}`}>
          Filter {complete ? "all result" : "loaded"} rows
        </label>
        <input
          id={`filter-${result.result_id}`}
          type="search"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder={`Filter ${complete ? "all result" : "loaded"} rows…`}
        />
        <select aria-label="Filter column" value={column} onChange={event => setColumn(event.target.value)}>
          <option value="">All columns</option>
          {columns.map(item => (
            <option key={item.name}>{item.name}</option>
          ))}
        </select>
        <select aria-label="Comparison" value={comparison} onChange={event => setComparison(event.target.value)}>
          <option value="contains">Contains</option>
          <option value="equals">Equals</option>
          <option value="greater">Number greater than</option>
          <option value="less">Number less than</option>
          <option value="null">Is null</option>
          <option value="missing">Is missing</option>
          <option value="true">Is true</option>
          <option value="false">Is false</option>
          {column && /date|time/i.test(columns.find(item => item.name === column)?.type ?? "") && (
            <>
              <option value="before">Date before</option>
              <option value="after">Date after</option>
            </>
          )}
        </select>
        <span className="spacer" />
        {loading ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              controller.current?.abort();
              setLoading(false);
              setError("Loading cancelled. Showing loaded rows.");
            }}>
            Stop loading
          </button>
        ) : (
          <button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>
            Reload
          </button>
        )}
        <select
          aria-label="Export format"
          value={format}
          onChange={event => setFormat(event.target.value as typeof format)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="jsonl">JSONL</option>
        </select>
        <button type="button" className="text-button" disabled={exporting} onClick={() => void download()}>
          {exporting ? "Preparing…" : "Export"}
        </button>
        {exporting && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              downloadController.current?.abort();
              setExporting(false);
            }}>
            Cancel export
          </button>
        )}
      </div>
      {edit && (
        <div className="database-cell-editor">
          <label>
            Editing {edit.column}
            <input
              aria-label={`New value for ${edit.column} as JSON`}
              value={edit.value}
              onChange={event => setEdit({ ...edit, value: event.target.value, plan: undefined })}
            />
          </label>
          <small>JSON value: quote text and exact large numbers; use null for nullable cells.</small>
          <label className="database-check">
            <input
              type="checkbox"
              checked={edit.unset}
              onChange={event => setEdit({ ...edit, unset: event.target.checked, plan: undefined })}
            />
            Unset field (MongoDB)
          </label>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void save(false)}>
            Plan cell change
          </button>
          {edit.plan && (
            <button
              type="button"
              className="primary-button"
              disabled={disabled || Date.parse(edit.expires ?? "") <= Date.now()}
              onClick={() => void save(true)}>
              Apply cell change
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setEdit(undefined)}>
            Discard
          </button>
        </div>
      )}
      {editable && !tokens.some(Boolean) && !loading && <p className="database-notice">{editingReason}</p>}
      {error && (
        <p className="database-notice" role="status">
          {error}
        </p>
      )}
      <div
        className="database-grid"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Scrollable result rows"
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <table aria-rowcount={filtered.length + 1}>
          <thead>
            <tr>
              <th scope="col">#</th>
              {columns.map(item => (
                <th scope="col" key={item.name}>
                  {item.name}
                  <small>{item.type}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true">
                <td colSpan={columns.length + 1} style={{ height: first * 32, padding: 0 }} />
              </tr>
            )}
            {visible.map((row, index) => (
              <tr key={first + index} aria-rowindex={first + index + 2}>
                <td>{first + index + 1}</td>
                {columns.map(item => {
                  const token = tokens[rowIndices.get(row) ?? -1];
                  return (
                    <td key={item.name} title={databaseCell(row[item.name])}>
                      {editable && token && writable.includes(item.name) ? (
                        <button
                          type="button"
                          className="database-cell"
                          disabled={disabled}
                          aria-label={`Edit ${item.name}, row ${first + index + 1}`}
                          onClick={() =>
                            setEdit({ token, column: item.name, value: JSON.stringify(row[item.name]), unset: false })
                          }>
                          {databaseCell(row[item.name])}
                        </button>
                      ) : (
                        databaseCell(row[item.name])
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {first + visible.length < filtered.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={columns.length + 1}
                  style={{ height: (filtered.length - first - visible.length) * 32, padding: 0 }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {!loading && !filtered.length && (
          <div className="database-empty">{rows.length ? "No matching rows" : "No rows returned"}</div>
        )}
      </div>
      <footer className="database-status" role="status">
        <span
          className={`overview-orb ${loading ? "is-running" : complete ? "is-done" : "is-attention"}`}
          aria-hidden="true"
        />
        <span>
          {loading ? "Loading · " : ""}
          {rows.length.toLocaleString()} of {result.rows.toLocaleString()} stored rows
          {filter || ["null", "missing", "true", "false"].includes(comparison) ? ` · ${filtered.length} match` : ""}
        </span>
        <span className="spacer" />
        <span>{complete ? "Complete" : "Loaded rows only"}</span>
        <span>{result.cached ? "Cache hit" : "Materialized"}</span>
        {result.storage.expires_at && <span>Expires {new Date(result.storage.expires_at).toLocaleTimeString()}</span>}
      </footer>
    </section>
  );
}

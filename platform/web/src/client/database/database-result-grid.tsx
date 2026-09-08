import { useEffect, useMemo, useRef, useState } from "react";
import { IconCopy, IconRefresh, IconDownload, IconPlayerStop } from "@tabler/icons-react";
import { databaseBytes, databaseCell, databaseRecord, type DatabaseResult } from "./database-workspace";
import {
  filterGridRows,
  groupGridChanges,
  parseGridJson,
  sortGridRows,
  type GridComparison,
  type GridDraft,
  type GridFilter,
} from "./database-grid";
import { runtimeStore } from "../runtime/event-store";
import type { StateQLCommandInput, StateQLCommandResult } from "../../shared/protocol/snapshots";

let rowQueue: Promise<void> = Promise.resolve();
const buffers = new Map<object, number>();

type ActiveEdit = { token: string; column: string; value: string; unset: boolean };
type Plan = { id: string; expires?: string; revision: number };

export function DatabaseResultGrid({
  result,
  scope,
  editable = false,
  disabled = false,
  suspended = false,
  onCommand,
  onPlanChanges,
  onSaved,
  onDirtyChange,
}: {
  result: DatabaseResult;
  scope: string;
  editable?: boolean;
  disabled?: boolean;
  suspended?: boolean;
  onCommand?: (input: StateQLCommandInput) => Promise<StateQLCommandResult | undefined>;
  onPlanChanges?: (
    updates: Array<{ row_token: string; changes: { set?: Record<string, unknown>; unset?: string[] } }>,
  ) => Promise<StateQLCommandResult | undefined>;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tokens, setTokens] = useState<Array<string | null>>([]);
  const [writable, setWritable] = useState<string[]>([]);
  const [editingReason, setEditingReason] = useState("");
  const [activeEdit, setActiveEdit] = useState<ActiveEdit>();
  const [drafts, setDrafts] = useState<GridDraft[]>([]);
  const [plan, setPlan] = useState<Plan>();
  const [planning, setPlanning] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [columns, setColumns] = useState(result.columns);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [filters, setFilters] = useState<GridFilter[]>([]);
  const [comparison, setComparison] = useState<GridComparison>("contains");
  const [filterValue, setFilterValue] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" | "" }>({ column: "", direction: "" });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const draftRevision = useRef(0);
  const filterId = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState<"json" | "jsonl" | "csv">("csv");
  const downloadController = useRef<AbortController | null>(null);
  const dirty = drafts.length > 0 || Boolean(activeEdit);
  useEffect(() => {
    if (suspended) {
      controller.current?.abort();
      downloadController.current?.abort();
      setLoading(false);
      setPlan(undefined);
    }
  }, [suspended]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (suspended) {
      const owner = {};
      buffers.set(owner, databaseBytes(rows));
      return () => {
        buffers.delete(owner);
      };
    }
    const abort = new AbortController();
    controller.current = abort;
    const owner = {};
    buffers.set(owner, 0);
    setRows([]);
    setTokens([]);
    setActiveEdit(undefined);
    setDrafts([]);
    setPlan(undefined);
    draftRevision.current = 0;
    setColumns(result.columns);
    setHiddenColumns(new Set());
    setReloadRequired(false);
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
  }, [result.result_id, scope, revision, suspended]);

  const loaded = useMemo(
    () => rows.map((row, index) => ({ row, token: tokens[index] ?? null, index })),
    [rows, tokens],
  );
  const filtered = useMemo(
    () => filterGridRows(loaded, columns, filters, globalSearch),
    [loaded, columns, filters, globalSearch],
  );
  const displayed = useMemo(
    () =>
      sortGridRows(
        filtered,
        columns.find(item => item.name === sort.column),
        sort.direction,
      ),
    [filtered, columns, sort],
  );
  const visibleColumns = columns.filter(column => !hiddenColumns.has(column.name));
  const first = Math.max(0, Math.floor(scrollTop / 32) - 8);
  const visible = displayed.slice(first, first + Math.ceil(height / 32) + 16);
  useEffect(() => {
    setScrollTop(0);
    viewport.current?.scrollTo({ top: 0 });
  }, [globalSearch, filters, sort]);

  const changeDrafts = (next: GridDraft[]) => {
    draftRevision.current += 1;
    setDrafts(next);
    setPlan(undefined);
  };
  const valueFor = (item: (typeof loaded)[number], column: string) => {
    const draft = [...drafts].reverse().find(value => value.row_token === item.token && value.column === column);
    if (!draft) return item.row[column];
    return draft.unset ? undefined : draft.value;
  };
  const stageEdit = () => {
    if (!activeEdit || planning || disabled || !editable || suspended) return;
    let value: unknown;
    if (!activeEdit.unset) {
      const parsed = parseGridJson(activeEdit.value);
      if (!parsed.ok) {
        setError("Use valid JSON for this cell. Use null for NULL; choose Unset for a missing field.");
        return;
      }
      value = parsed.value;
    }
    const draft: GridDraft = {
      row_token: activeEdit.token,
      column: activeEdit.column,
      ...(activeEdit.unset ? { unset: true } : { value }),
    };
    changeDrafts([
      ...drafts.filter(value => value.row_token !== draft.row_token || value.column !== draft.column),
      draft,
    ]);
    setActiveEdit(undefined);
    setError("");
  };
  const reviewChanges = async () => {
    if (planning || disabled || suspended || activeEdit || reloadRequired || !drafts.length) return;
    const updates = groupGridChanges(drafts);
    if (!updates.length) return;
    if (!onPlanChanges && updates.length !== 1) {
      setError("Multiple rows require batch change support. No changes were sent.");
      return;
    }
    const submittedRevision = draftRevision.current;
    setPlanning(true);
    setError("");
    try {
      const response = onPlanChanges
        ? await onPlanChanges(updates)
        : await onCommand?.({
            command: "table.plan",
            row_token: updates[0]!.row_token,
            changes: updates[0]!.changes,
          } as StateQLCommandInput);
      if (response?.status !== "completed" || !response.response.ok) {
        setError("Changes were not planned. Review the database response before trying again.");
        return;
      }
      const data = response.response.data as { plan_id?: string; expires_at?: string };
      if (!data.plan_id || !Number.isFinite(Date.parse(data.expires_at ?? ""))) {
        setError("The database did not return a change plan.");
        return;
      }
      if (draftRevision.current === submittedRevision)
        setPlan({ id: data.plan_id, expires: data.expires_at, revision: submittedRevision });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Changes could not be planned.");
    } finally {
      setPlanning(false);
    }
  };
  const applyChanges = async () => {
    if (
      !plan ||
      planning ||
      disabled ||
      suspended ||
      activeEdit ||
      plan.revision !== draftRevision.current ||
      !onCommand
    )
      return;
    if (!Number.isFinite(Date.parse(plan.expires ?? "")) || Date.parse(plan.expires ?? "") <= Date.now()) {
      setPlan(undefined);
      setError("The change plan expired. Review changes again.");
      return;
    }
    setPlanning(true);
    setError("");
    try {
      const response = await onCommand({ command: "apply", handle: plan.id } as StateQLCommandInput);
      if (response?.status === "declined") {
        setPlan(undefined);
        return;
      }
      if (
        response?.status !== "completed" ||
        !response.response.ok ||
        !databaseRecord(response.response.data) ||
        response.response.data.status !== "committed" ||
        response.response.data.committed === false
      ) {
        setPlan(undefined);
        setReloadRequired(true);
        setError(
          "Apply failed or its outcome is uncertain. Do not retry blindly; discard drafts and reload the result.",
        );
        return;
      }
      changeDrafts([]);
      setActiveEdit(undefined);
      onSaved?.();
    } catch (cause) {
      setPlan(undefined);
      setReloadRequired(true);
      setError(
        `${cause instanceof Error ? cause.message : "Apply failed."} Do not retry blindly; discard drafts and reload the result.`,
      );
    } finally {
      setPlanning(false);
    }
  };
  const download = async () => {
    if (suspended) return;
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
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setError(`${label} copied.`);
    } catch {
      setError("Copy is unavailable in this browser context.");
    }
  };
  const addFilter = (column: string) => {
    setFilters(current => [...current, { id: String(++filterId.current), column, comparison, value: filterValue }]);
    setFilterValue("");
  };
  const requestReload = () => {
    if (suspended) return;
    if (dirty) {
      setError("Discard pending changes before reloading; row identities must not be reused after a reload.");
      return;
    }
    setRevision(value => value + 1);
  };
  const resultHandle = (result as DatabaseResult & { alias?: string }).alias || result.result_id;

  return (
    <section className="database-result database-result-grid-redesign" aria-label="Query result">
      <div className="database-toolbar">
        <label className="sr-only" htmlFor={`search-${result.result_id}`}>
          Search loaded rows
        </label>
        <input
          id={`search-${result.result_id}`}
          type="search"
          value={globalSearch}
          onChange={event => setGlobalSearch(event.target.value)}
          placeholder="Search loaded rows…"
        />
        <details className="database-column-panel">
          <summary aria-label="Show or hide columns" title="Columns">
            Columns
          </summary>
          <div>
            {columns.map(item => (
              <label key={item.name}>
                <input
                  type="checkbox"
                  checked={!hiddenColumns.has(item.name)}
                  onChange={() =>
                    setHiddenColumns(current => {
                      const next = new Set(current);
                      next.has(item.name) ? next.delete(item.name) : next.add(item.name);
                      return next;
                    })
                  }
                />{" "}
                {item.name}
              </label>
            ))}
          </div>
        </details>
        <span className="spacer" />
        {editable && (
          <button
            type="button"
            className="text-button"
            aria-pressed={editMode}
            disabled={disabled || planning || reloadRequired}
            onClick={() => {
              setEditMode(value => !value);
              setActiveEdit(undefined);
            }}
            title="Toggle inline editing">
            {editMode ? "Finish editing" : "Edit"}
          </button>
        )}
        {loading ? (
          <button
            type="button"
            className="text-button database-icon-button"
            aria-label="Stop loading"
            title="Stop loading"
            onClick={() => {
              controller.current?.abort();
              setLoading(false);
              setError("Loading cancelled. Showing loaded rows.");
            }}>
            <IconPlayerStop size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="text-button database-icon-button"
            aria-label="Reload result"
            title="Reload result"
            disabled={suspended || dirty}
            onClick={requestReload}>
            <IconRefresh size={16} />
          </button>
        )}
        <button
          type="button"
          className="text-button database-icon-button"
          aria-label="Copy loaded result"
          title="Copy loaded result"
          onClick={() => void copy(JSON.stringify(rows), "Loaded result")}>
          <IconCopy size={16} />
        </button>
        <button
          type="button"
          className="text-button database-icon-button"
          aria-label="Copy result handle"
          title="Copy result handle"
          onClick={() => void copy(resultHandle, "Result handle")}>
          <code>{resultHandle}</code>
          <IconCopy size={13} />
        </button>
        <select
          aria-label="Export format"
          value={format}
          onChange={event => setFormat(event.target.value as typeof format)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="jsonl">JSONL</option>
        </select>
        <button
          type="button"
          className="text-button database-icon-button"
          aria-label="Export complete stored result"
          title="Export complete stored result"
          disabled={exporting || suspended}
          onClick={() => void download()}>
          {exporting ? "…" : <IconDownload size={16} />}
        </button>
        {exporting && (
          <button
            type="button"
            className="text-button database-icon-button"
            aria-label="Cancel export"
            title="Cancel export"
            onClick={() => {
              downloadController.current?.abort();
              setExporting(false);
            }}>
            ■
          </button>
        )}
      </div>
      {!!filters.length && (
        <div className="database-filter-chips" aria-label="Active filters">
          {filters.map(filter => (
            <span key={filter.id}>
              {filter.column || "All columns"} · {filter.comparison}
              {filter.value ? ` · ${filter.value}` : ""}
              <button
                type="button"
                aria-label={`Remove ${filter.column || "all columns"} filter`}
                onClick={() => setFilters(current => current.filter(value => value.id !== filter.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {dirty && (
        <div className="database-pending-bar" role="status">
          <strong>
            {drafts.length} pending {drafts.length === 1 ? "change" : "changes"}
          </strong>
          <span>
            {reloadRequired
              ? "Discard drafts and reload before submitting anything else."
              : "Changes are staged locally and have not been sent."}
          </span>
          <span className="spacer" />
          {plan ? (
            <button
              type="button"
              className="primary-button"
              disabled={disabled || planning || plan.revision !== draftRevision.current}
              onClick={() => void applyChanges()}>
              Apply changes
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button"
              disabled={
                disabled ||
                planning ||
                Boolean(activeEdit) ||
                !drafts.length ||
                reloadRequired ||
                (!onPlanChanges && groupGridChanges(drafts).length !== 1)
              }
              onClick={() => void reviewChanges()}>
              {planning ? "Planning…" : "Review changes"}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            disabled={planning}
            onClick={() => {
              changeDrafts([]);
              setActiveEdit(undefined);
            }}>
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
        <table aria-rowcount={displayed.length + 1}>
          <thead>
            <tr>
              <th scope="col">#</th>
              {visibleColumns.map(item => (
                <th scope="col" key={item.name}>
                  <span>
                    {item.name}
                    <small>{item.type}</small>
                  </span>
                  <details className="database-header-panel">
                    <summary aria-label={`Controls for ${item.name}`} title={`Controls for ${item.name}`}>
                      ⋮
                    </summary>
                    <div>
                      <button type="button" onClick={() => setSort({ column: item.name, direction: "asc" })}>
                        Sort ascending
                      </button>
                      <button type="button" onClick={() => setSort({ column: item.name, direction: "desc" })}>
                        Sort descending
                      </button>
                      <button type="button" onClick={() => setSort({ column: "", direction: "" })}>
                        Reset sort
                      </button>
                      <label>
                        Comparison
                        <select
                          value={comparison}
                          onChange={event => setComparison(event.target.value as GridComparison)}>
                          <option value="contains">Contains</option>
                          <option value="equals">Equals</option>
                          <option value="greater">Number greater than</option>
                          <option value="less">Number less than</option>
                          <option value="null">Is null</option>
                          <option value="missing">Is missing</option>
                          <option value="true">Is true</option>
                          <option value="false">Is false</option>
                          {/date|time/i.test(item.type) && (
                            <>
                              <option value="before">Date before</option>
                              <option value="after">Date after</option>
                            </>
                          )}
                        </select>
                      </label>
                      <label>
                        Value
                        <input
                          value={filterValue}
                          disabled={["null", "missing", "true", "false"].includes(comparison)}
                          onChange={event => setFilterValue(event.target.value)}
                        />
                      </label>
                      <button type="button" onClick={() => addFilter(item.name)}>
                        Apply filter
                      </button>
                      <button
                        type="button"
                        onClick={() => setHiddenColumns(current => new Set(current).add(item.name))}>
                        Hide column
                      </button>
                    </div>
                  </details>
                  {sort.column === item.name && (
                    <em aria-label={`Sorted ${sort.direction}`}>{sort.direction === "asc" ? "↑" : "↓"}</em>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true">
                <td colSpan={visibleColumns.length + 1} style={{ height: first * 32, padding: 0 }} />
              </tr>
            )}
            {visible.map((item, index) => (
              <tr key={`${item.token ?? "row"}-${item.index}`} aria-rowindex={first + index + 2}>
                <td>{first + index + 1}</td>
                {visibleColumns.map(column => {
                  const value = valueFor(item, column.name);
                  const canEdit =
                    editable &&
                    editMode &&
                    item.token &&
                    writable.includes(column.name) &&
                    !disabled &&
                    !planning &&
                    !reloadRequired;
                  const active = activeEdit?.token === item.token && activeEdit.column === column.name;
                  return (
                    <td
                      key={column.name}
                      className={
                        drafts.some(draft => draft.row_token === item.token && draft.column === column.name)
                          ? "is-dirty"
                          : ""
                      }
                      title={databaseCell(value)}>
                      {active ? (
                        <span className="database-inline-editor">
                          <input
                            aria-label={`New value for ${column.name} as JSON`}
                            autoFocus
                            value={activeEdit!.value}
                            disabled={planning || disabled || suspended}
                            onChange={event => {
                              setPlan(undefined);
                              setActiveEdit({ ...activeEdit!, value: event.target.value });
                            }}
                            onKeyDown={event => {
                              if (event.key === "Enter") stageEdit();
                              if (event.key === "Escape") setActiveEdit(undefined);
                            }}
                          />
                          <label>
                            <input
                              type="checkbox"
                              checked={activeEdit!.unset}
                              onChange={event => {
                                setPlan(undefined);
                                setActiveEdit({ ...activeEdit!, unset: event.target.checked });
                              }}
                            />
                            Unset
                          </label>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Stage ${column.name} change`}
                            onClick={stageEdit}>
                            ✓
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Cancel cell edit"
                            onClick={() => setActiveEdit(undefined)}>
                            ×
                          </button>
                        </span>
                      ) : canEdit ? (
                        <button
                          type="button"
                          className="database-cell"
                          aria-label={`Edit ${column.name}, row ${first + index + 1}`}
                          onClick={() =>
                            setActiveEdit({
                              token: item.token!,
                              column: column.name,
                              value: JSON.stringify(value) ?? "null",
                              unset: false,
                            })
                          }>
                          {databaseCell(value)}
                        </button>
                      ) : (
                        databaseCell(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {first + visible.length < displayed.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={visibleColumns.length + 1}
                  style={{ height: (displayed.length - first - visible.length) * 32, padding: 0 }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {!loading && !displayed.length && (
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
          {rows.length.toLocaleString()} loaded of {result.rows.toLocaleString()} stored rows
          {globalSearch || filters.length ? ` · ${displayed.length} match` : ""}
        </span>
        <span className="spacer" />
        <span>{complete ? "Complete stored result loaded" : "Loaded rows only"}</span>
        <span>{result.cached ? "Cache hit" : "Materialized"}</span>
        {result.storage.expires_at && <span>Expires {new Date(result.storage.expires_at).toLocaleTimeString()}</span>}
      </footer>
    </section>
  );
}

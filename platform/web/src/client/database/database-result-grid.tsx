import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCopy, IconRefresh, IconDownload, IconPlayerStop } from "@tabler/icons-react";
import { databaseBytes, databaseCell, databaseRecord, type DatabaseResult } from "./database-workspace";
import {
  createGridPublication,
  filterGridRows,
  GRID_ROW_NUMBER_WIDTH,
  groupGridChanges,
  initialGridColumnWidth,
  initialGridColumnWidths,
  parseGridJson,
  resizeGridColumn,
  sortGridRows,
  type GridColumn,
  type GridComparison,
  type GridDraft,
  type GridFilter,
} from "./database-grid";
import { runtimeStore } from "../runtime/event-store";
import type { StateQLCommandInput, StateQLCommandResult } from "../../shared/protocol/snapshots";
import type { StateQLWorkspace } from "../../shared/protocol/snapshots";

let rowQueue: Promise<void> = Promise.resolve();
const buffers = new Map<object, number>();

type ActiveEdit = { token: string; column: string; value: string; unset: boolean };
type Plan = { id: string; expires?: string; revision: number };
type HeaderMenu = { column: GridColumn; left: number; top: number; trigger: HTMLButtonElement };

function DatabaseHeaderMenu({
  menu,
  comparison,
  value,
  onComparison,
  onValue,
  onSort,
  onFilter,
  onHide,
  onClose,
}: {
  menu: HeaderMenu;
  comparison: GridComparison;
  value: string;
  onComparison: (comparison: GridComparison) => void;
  onValue: (value: string) => void;
  onSort: (direction: "asc" | "desc" | "") => void;
  onFilter: () => void;
  onHide: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menu.trigger.contains(target)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  return createPortal(
    <div
      ref={ref}
      className="database-header-popover"
      role="dialog"
      aria-label={`Controls for ${menu.column.name}`}
      style={{ left: menu.left, top: menu.top }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose(true);
        }
      }}>
      <button type="button" onClick={() => onSort("asc")}>Sort ascending</button>
      <button type="button" onClick={() => onSort("desc")}>Sort descending</button>
      <button type="button" onClick={() => onSort("")}>Reset sort</button>
      <label>
        Comparison
        <select value={comparison} onChange={event => onComparison(event.target.value as GridComparison)}>
          <option value="contains">Contains</option>
          <option value="equals">Equals</option>
          <option value="greater">Number greater than</option>
          <option value="less">Number less than</option>
          <option value="null">Is null</option>
          <option value="missing">Is missing</option>
          <option value="true">Is true</option>
          <option value="false">Is false</option>
          {/date|time/i.test(menu.column.type) && (
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
          value={value}
          disabled={["null", "missing", "true", "false"].includes(comparison)}
          onChange={event => onValue(event.target.value)}
        />
      </label>
      <button type="button" onClick={onFilter}>Apply filter</button>
      <button type="button" onClick={onHide}>Hide column</button>
    </div>,
    document.body,
  );
}

export function DatabaseResultGrid({
  result,
  scope,
  workspace,
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
  workspace: StateQLWorkspace;
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
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => initialGridColumnWidths(result.columns));
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu>();
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
    setColumnWidths(initialGridColumnWidths(result.columns));
    setHeaderMenu(undefined);
    setHiddenColumns(new Set());
    setReloadRequired(false);
    setComplete(false);
    setLoading(true);
    setError("");
    const publication = createGridPublication<Record<string, unknown>>(
      (nextRows, nextTokens) => { if (!abort.signal.aborted) { setRows(nextRows); setTokens(nextTokens); } },
    );
    const drain = async () => {
      let offset = 0;
      let bytes = 0;
      let fullValues = true;
      try {
        while (!abort.signal.aborted) {
          const page = await runtimeStore.stateqlRows(workspace, result.result_id, offset, 100, abort.signal);
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
            publication.count + page.returned > 10_000 ||
            bytes + size > 8 * 1024 * 1024 ||
            otherBytes + bytes + size > 16 * 1024 * 1024
          )
            throw new Error("Loaded-row limit reached. Export the complete stored result or close another result tab.");
          bytes += size;
          buffers.set(owner, bytes);
          const pageTokens = page.row_tokens ?? page.rows.map(() => null);
          publication.append(page.rows, pageTokens, offset === 0);
          const writableColumns = page.writable_columns ?? [];
          setWritable(previous => previous.length === writableColumns.length && previous.every((name, index) => name === writableColumns[index]) ? previous : writableColumns);
          setEditingReason(page.editing_reason ?? "Rows with unsupported types or expired identity are read-only.");
          fullValues &&= page.full_values === true;
          if (page.columns) {
            const nextColumns = page.columns;
            setColumns(previous => JSON.stringify(previous) === JSON.stringify(nextColumns) ? previous : nextColumns);
            setColumnWidths(current =>
              Object.fromEntries(nextColumns.map(column => [column.name, current[column.name] ?? initialGridColumnWidth(column)])),
            );
          }
          if (page.next_offset === null) {
            if (publication.count !== page.total) throw new Error("The result page ended early.");
            publication.flush();
            setComplete(fullValues);
            if (!fullValues) setError("Some cells are compact previews. Export for complete stored values.");
            return;
          }
          offset = page.next_offset;
        }
      } catch (cause) {
        if (!abort.signal.aborted) {
          publication.flush();
          setError(cause instanceof Error ? cause.message : "Result loading failed.");
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false);
        publication.dispose();
      }
    };
    rowQueue = rowQueue.then(drain, drain);
    return () => {
      abort.abort();
      downloadController.current?.abort();
      publication.dispose();
      buffers.delete(owner);
    };
  }, [result.result_id, scope, workspace, revision, suspended]);

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
  const tableWidth =
    GRID_ROW_NUMBER_WIDTH + visibleColumns.reduce((total, column) => total + columnWidths[column.name]!, 0);
  const closeHeaderMenu = (restoreFocus = false) => {
    setHeaderMenu(current => {
      if (restoreFocus && current?.trigger.isConnected) queueMicrotask(() => current.trigger.focus());
      return undefined;
    });
  };
  const openHeaderMenu = (event: React.MouseEvent<HTMLButtonElement>, column: GridColumn) => {
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    const width = 220;
    const height = 330;
    const left = Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4));
    const top = rect.bottom + height + 4 <= window.innerHeight ? rect.bottom + 4 : Math.max(4, rect.top - height - 4);
    setHeaderMenu(current =>
      current?.column.name === column.name ? undefined : { column, left, top, trigger },
    );
  };
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
      const blob = await runtimeStore.stateqlExport(workspace, result.result_id, format, abort.signal);
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
        onScroll={event => {
          setScrollTop(event.currentTarget.scrollTop);
          closeHeaderMenu();
        }}>
        <table aria-rowcount={displayed.length + 1} style={{ width: `max(100%, ${tableWidth}px)` }}>
          <colgroup>
            <col style={{ width: GRID_ROW_NUMBER_WIDTH }} />
            {visibleColumns.map(column => (
              <col key={column.name} style={{ width: columnWidths[column.name] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">#</th>
              {visibleColumns.map(item => (
                <th scope="col" key={item.name}>
                  <span>
                    {item.name}
                    <small>{item.type}</small>
                  </span>
                  <button
                    type="button"
                    className="database-header-menu-button"
                    aria-label={`Controls for ${item.name}`}
                    aria-expanded={headerMenu?.column.name === item.name}
                    title={`Controls for ${item.name}`}
                    onClick={event => openHeaderMenu(event, item)}>
                    ⋮
                  </button>
                  {sort.column === item.name && (
                    <em aria-label={`Sorted ${sort.direction}`}>{sort.direction === "asc" ? "↑" : "↓"}</em>
                  )}
                  <button
                    type="button"
                    className="database-column-resizer"
                    aria-label={`Resize ${item.name} column`}
                    title={`Resize ${item.name} column`}
                    onPointerDown={event => {
                      closeHeaderMenu();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.currentTarget.dataset.startX = String(event.clientX);
                      event.currentTarget.dataset.startWidth = String(columnWidths[item.name]);
                    }}
                    onPointerMove={event => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const startX = Number(event.currentTarget.dataset.startX);
                      const startWidth = Number(event.currentTarget.dataset.startWidth);
                      setColumnWidths(current => ({
                        ...current,
                        [item.name]: resizeGridColumn(startWidth, event.clientX - startX),
                      }));
                    }}
                    onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
                    onPointerCancel={event => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                    onKeyDown={event => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      setColumnWidths(current => ({
                        ...current,
                        [item.name]: resizeGridColumn(current[item.name]!, event.key === "ArrowLeft" ? -16 : 16),
                      }));
                    }}
                  />
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
      {headerMenu && (
        <DatabaseHeaderMenu
          menu={headerMenu}
          comparison={comparison}
          value={filterValue}
          onComparison={setComparison}
          onValue={setFilterValue}
          onSort={direction => {
            setSort(direction ? { column: headerMenu.column.name, direction } : { column: "", direction: "" });
            closeHeaderMenu(true);
          }}
          onFilter={() => {
            addFilter(headerMenu.column.name);
            closeHeaderMenu(true);
          }}
          onHide={() => {
            setHiddenColumns(current => new Set(current).add(headerMenu.column.name));
            closeHeaderMenu(true);
          }}
          onClose={closeHeaderMenu}
        />
      )}
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

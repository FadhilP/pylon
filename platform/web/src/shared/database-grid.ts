import { databaseCell } from "./database-workspace.ts";

export type GridComparison =
  "contains" | "equals" | "greater" | "less" | "null" | "missing" | "true" | "false" | "before" | "after";
export interface GridColumn {
  name: string;
  type: string;
}
export interface GridFilter {
  id: string;
  column: string;
  comparison: GridComparison;
  value: string;
}
export interface GridRow {
  row: Record<string, unknown>;
  token: string | null;
  index: number;
}
export interface GridDraft {
  row_token: string;
  column: string;
  value?: unknown;
  unset?: boolean;
}
export interface GridUpdate {
  row_token: string;
  changes: { set?: Record<string, unknown>; unset?: string[] };
}

export function parseGridJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/** Combine cell drafts by their opaque row identity. Never derive identity from a displayed row. */
export function groupGridChanges(drafts: GridDraft[]): GridUpdate[] {
  const grouped = new Map<string, { set: Record<string, unknown>; unset: Set<string> }>();
  for (const draft of drafts) {
    if (!draft.row_token || !draft.column) continue;
    const current = grouped.get(draft.row_token) ?? {
      set: Object.create(null) as Record<string, unknown>,
      unset: new Set<string>(),
    };
    if (draft.unset) {
      delete current.set[draft.column];
      current.unset.add(draft.column);
    } else {
      current.set[draft.column] = draft.value;
      current.unset.delete(draft.column);
    }
    grouped.set(draft.row_token, current);
  }
  return [...grouped].map(([row_token, changes]) => ({
    row_token,
    changes: {
      ...(Object.keys(changes.set).length ? { set: { ...changes.set } } : {}),
      ...(changes.unset.size ? { unset: [...changes.unset] } : {}),
    },
  }));
}

function matches(value: unknown, column: GridColumn | undefined, filter: GridFilter): boolean {
  switch (filter.comparison) {
    case "null":
      return value === null;
    case "missing":
      return value === undefined;
    case "true":
      return value === true;
    case "false":
      return value === false;
    case "before":
    case "after": {
      if (!/date|time/i.test(column?.type ?? "") || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value))
        return false;
      const actual = Date.parse(value);
      const expected = Date.parse(filter.value);
      return (
        Number.isFinite(actual) &&
        Number.isFinite(expected) &&
        (filter.comparison === "before" ? actual < expected : actual > expected)
      );
    }
    case "contains":
      return !filter.value || databaseCell(value).toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
    case "equals":
      return databaseCell(value) === filter.value;
    case "greater":
      return typeof value === "number" && Number.isFinite(Number(filter.value)) && value > Number(filter.value);
    case "less":
      return typeof value === "number" && Number.isFinite(Number(filter.value)) && value < Number(filter.value);
  }
}

export function filterGridRows(
  rows: GridRow[],
  columns: GridColumn[],
  filters: GridFilter[],
  globalSearch: string,
): GridRow[] {
  const needle = globalSearch.toLocaleLowerCase();
  return rows.filter(item => {
    if (needle && !Object.values(item.row).some(value => databaseCell(value).toLocaleLowerCase().includes(needle)))
      return false;
    return filters.every(filter => {
      const candidates = filter.column
        ? [{ value: item.row[filter.column], column: columns.find(column => column.name === filter.column) }]
        : columns.map(column => ({ value: item.row[column.name], column }));
      return candidates.some(candidate => matches(candidate.value, candidate.column, filter));
    });
  });
}

function sortable(value: unknown, type: string): string | number | boolean {
  if (/date|time/i.test(type) && typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value as string | number | boolean;
}

/** Explicit index tie-breaker keeps sorting stable across engines and page drains. */
export function sortGridRows(
  rows: GridRow[],
  column: GridColumn | undefined,
  direction: "asc" | "desc" | "",
): GridRow[] {
  if (!column || !direction) return rows;
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left.row[column.name];
    const b = right.row[column.name];
    if (a === b) return left.index - right.index;
    if (a === undefined) return factor;
    if (b === undefined) return -factor;
    if (a === null) return factor;
    if (b === null) return -factor;
    const aa = sortable(a, column.type);
    const bb = sortable(b, column.type);
    let result: number;
    if (typeof aa === "number" && typeof bb === "number") result = aa - bb;
    else if (typeof aa === "boolean" && typeof bb === "boolean") result = Number(aa) - Number(bb);
    else
      result = String(aa).localeCompare(String(bb), undefined, {
        numeric: /int|float|double|decimal|number/i.test(column.type),
      });
    return result ? result * factor : left.index - right.index;
  });
}

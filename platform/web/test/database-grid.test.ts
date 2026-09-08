import assert from "node:assert/strict";
import test from "node:test";
import {
  filterGridRows,
  groupGridChanges,
  parseGridJson,
  sortGridRows,
  type GridRow,
} from "../src/client/database/database-grid.ts";

const columns = [
  { name: "id", type: "integer" },
  { name: "score", type: "number" },
  { name: "value", type: "text" },
  { name: "when", type: "timestamp" },
];
const rows: GridRow[] = [
  { index: 0, token: "opaque-a", row: { id: 8, score: 10, value: null, when: "2024-01-01T00:00:00Z" } },
  { index: 1, token: "opaque-b", row: { id: 2, score: 2, value: "same", when: "2024-01-02T00:00:00Z" } },
  { index: 2, token: "opaque-c", row: { id: 3, score: 2, value: "same" } },
  { index: 3, token: "opaque-d", row: { id: 4, score: 3 } },
];

test("grid filtering combines filters without losing opaque row identity", () => {
  const filtered = filterGridRows(
    rows,
    columns,
    [
      { id: "null", column: "value", comparison: "null", value: "" },
      { id: "score", column: "score", comparison: "greater", value: "5" },
    ],
    "",
  );
  assert.deepEqual(
    filtered.map(row => row.token),
    ["opaque-a"],
  );
  assert.deepEqual(
    filterGridRows(rows, columns, [{ id: "missing", column: "value", comparison: "missing", value: "" }], "").map(
      row => row.token,
    ),
    ["opaque-d"],
  );
});

test("numeric sorting is type-aware and stable for equal values", () => {
  const sorted = sortGridRows(rows, columns[1], "asc");
  assert.deepEqual(
    sorted.map(row => row.row.id),
    [2, 3, 4, 8],
  );
  assert.deepEqual(
    sortGridRows(rows, columns[1], "desc")
      .filter(row => row.row.score === 2)
      .map(row => row.token),
    ["opaque-b", "opaque-c"],
  );
});

test("grid drafts group set and unset changes by original row token and reject invalid JSON", () => {
  assert.equal(parseGridJson("{").ok, false);
  const parsed = parseGridJson("null");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value, null);
  assert.deepEqual(
    groupGridChanges([
      { row_token: "opaque-a", column: "name", value: "Ada" },
      { row_token: "opaque-a", column: "gone", unset: true },
      { row_token: "opaque-b", column: "count", value: 2 },
      { row_token: "opaque-a", column: "gone", value: false },
    ]),
    [
      { row_token: "opaque-a", changes: { set: { name: "Ada", gone: false } } },
      { row_token: "opaque-b", changes: { set: { count: 2 } } },
    ],
  );
});

test("draft grouping treats prototype-like database columns as ordinary values", () => {
  const [update] = groupGridChanges([{ row_token: "original-row", column: "__proto__", value: { polluted: true } }]);
  assert.equal(Object.getPrototypeOf(update.changes.set), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(update.changes.set)), JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

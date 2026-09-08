import assert from "node:assert/strict";
import test from "node:test";
import {
  createGridPublication,
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


test("result publication shows the first page immediately and batches later pages", () => {
  const publications: Array<{ rows: number[]; tokens: Array<string | null> }> = [];
  const pending = createGridPublication<number>(
    (publishedRows, publishedTokens) => publications.push({ rows: publishedRows, tokens: publishedTokens }),
    { rowCadence: 3, timeCadence: 60_000 },
  );
  pending.append([1], ["one"], true);
  pending.append([2], ["two"]);
  pending.append([3], ["three"]);
  assert.deepEqual(publications, [{ rows: [1], tokens: ["one"] }]);
  pending.append([4], ["four"]);
  assert.deepEqual(publications.at(-1), { rows: [1, 2, 3, 4], tokens: ["one", "two", "three", "four"] });
  pending.append([5], ["five"]);
  pending.flush();
  assert.deepEqual(publications.at(-1), { rows: [1, 2, 3, 4, 5], tokens: ["one", "two", "three", "four", "five"] });
  pending.dispose();
});

test("result publication has a bounded delay and disposal cancels pending publication", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: number[][] = [];
  const pending = createGridPublication<number>(rows => seen.push(rows));
  pending.append([1], [null], true);
  pending.append([2], [null]);
  t.mock.timers.tick(49);
  assert.deepEqual(seen, [[1]]);
  t.mock.timers.tick(1);
  assert.deepEqual(seen, [[1], [1, 2]]);
  pending.append([3], [null]);
  pending.dispose();
  t.mock.timers.tick(100);
  pending.flush();
  assert.equal(seen.length, 2);
});

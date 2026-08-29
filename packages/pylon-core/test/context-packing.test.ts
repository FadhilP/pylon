import test from "node:test";
import assert from "node:assert/strict";
import { packRecentRecords } from "../src/context-packing.ts";

const identity = (record: string) => record.trim();
const pack = (records: string[], maxChars = 1000, maxItems = 10) =>
  packRecentRecords(records, { maxChars, maxItems, identity });

test("the newest records are selected but reading order is restored", () => {
  assert.equal(pack(["one", "two", "three"], 1000, 2), "two\n\nthree");
});

test("duplicates are dropped by identity, keeping the newest occurrence", () => {
  assert.equal(pack(["same", "other", " same "]), "other\n\n same ");
});

test("an oversized record is skipped so older records that still fit survive", () => {
  const packed = pack(["small", "x".repeat(50), "tiny"], 20);
  assert.equal(packed, "small\n\ntiny");
});

test("the separator counts against the budget", () => {
  assert.equal(pack(["aaa", "bbb"], 8), "aaa\n\nbbb");
  assert.equal(pack(["aaa", "bbb"], 7), "bbb", "one separator short leaves only the newest");
});

test("empty identities and non-positive budgets yield nothing", () => {
  assert.equal(pack(["   ", ""]), "");
  assert.equal(pack(["kept"], 0), "");
  assert.equal(pack(["kept"], 1000, 0), "");
});

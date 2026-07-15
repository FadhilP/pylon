import test from "node:test";
import assert from "node:assert/strict";
import { TailBuffer, bounded } from "../src/output.ts";

test("tails bounded", () => {
  const tail = new TailBuffer(10);
  tail.append("abcdefghijklmnop");
  assert.ok(Buffer.byteLength(tail.toString()) <= 10);
  assert.equal(bounded("a\nb\nc", 100, 2).truncated, true);
});

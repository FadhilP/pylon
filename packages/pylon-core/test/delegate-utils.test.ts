import assert from "node:assert/strict";
import test from "node:test";
import { isTransientProviderFailure } from "../src/delegate-retry.ts";
import { truncateUtf8 } from "../src/utf8.ts";

test("truncateUtf8 returns the largest complete prefix within the byte cap", () => {
  assert.equal(truncateUtf8("a世界b", 7), "a世界");
  assert.equal(Buffer.byteLength(truncateUtf8("😀😀", 5)), 4);
  assert.equal(truncateUtf8("abc", 0), "");
});

test("delegate retry classification is shared and excludes terminal failures", () => {
  assert.equal(
    isTransientProviderFailure("websocket error; please retry your request"),
    true,
  );
  assert.equal(isTransientProviderFailure("401 authentication failed"), false);
  assert.equal(isTransientProviderFailure("request timed out"), false);
});

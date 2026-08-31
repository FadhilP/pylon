import test from "node:test";
import assert from "node:assert/strict";
import { scrollTopAfterPrepend } from "../src/shared/composer-input.ts";

test("prepended history keeps the current transcript content in place", () => {
  assert.equal(scrollTopAfterPrepend({ scrollTop: 80, scrollHeight: 1_300 }, 1_000), 380);
  assert.equal(scrollTopAfterPrepend({ scrollTop: 240, scrollHeight: 1_300 }, 1_000), 540);
});

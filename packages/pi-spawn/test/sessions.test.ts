import assert from "node:assert/strict";
import test from "node:test";
import { SpawnBusyError, withThreadLock } from "../src/sessions.ts";

test("thread lock rejects only overlapping work on the same thread and always releases", async () => {
  let release!: () => void;
  const held = withThreadLock("thread-a", () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => withThreadLock("thread-a", async () => {}), SpawnBusyError);
  await withThreadLock("thread-b", async () => {});
  release();
  await held;
  await withThreadLock("thread-a", async () => {});
});

test("thread lock does not start work after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(() => withThreadLock("cancelled", async () => { started = true; }, controller.signal), /aborted/);
  assert.equal(started, false);
});

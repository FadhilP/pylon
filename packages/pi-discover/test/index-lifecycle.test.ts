import assert from "node:assert/strict";
import test from "node:test";
import { createIndexLifecycle } from "../src/index-lifecycle.ts";

const pi = { events: { emit() {} } } as any;

test("shutdown cancels queued automatic refresh before an index is opened", async () => {
  let opened = 0;
  const lifecycle = createIndexLifecycle(pi, (() => {
    opened++;
    throw new Error("must not open");
  }) as any);
  lifecycle.setWorkspace({ cwd: "first" });
  lifecycle.scheduleRefresh({ cwd: "first" });
  await lifecycle.stop();
  lifecycle.scheduleRefresh({ cwd: "late" });
  assert.equal(opened, 0);
});

test("queued refreshes coalesce to the latest workspace and a new startup cancels stale work", async () => {
  const refreshed: string[] = [];
  const lifecycle = createIndexLifecycle(pi, ((cwd: string) => ({
    refresh: async () => {
      refreshed.push(cwd);
    },
    status: async () => ({}),
  })) as any);
  lifecycle.scheduleRefresh({ cwd: "old" });
  lifecycle.setWorkspace({ cwd: "new" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refreshed, []);
  lifecycle.scheduleRefresh({ cwd: "intermediate" });
  lifecycle.scheduleRefresh({ cwd: "new" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refreshed, ["new"]);
  await lifecycle.stop();
});

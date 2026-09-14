import assert from "node:assert/strict";
import test from "node:test";
import { createSessionMaintenance } from "../src/session-maintenance.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test("queued maintenance coalesces by root and cancellation only removes its own registration", async () => {
  let calls = 0;
  const collect = async () => {
    calls++;
  };
  const one = createSessionMaintenance("maintenance-shared", collect);
  const two = createSessionMaintenance("./maintenance-shared", collect);
  const other = createSessionMaintenance("maintenance-other", collect);
  const first = one.collect(),
    second = two.collect(),
    unrelated = other.collect();
  assert.equal(calls, 0, "scheduling yields rather than running inside the startup hook");
  const stopped = one.stop();
  await Promise.all([first, second, unrelated, stopped]);
  assert.equal(calls, 2, "the remaining request and the unrelated root each run once");
  await one.collect();
  assert.equal(calls, 2, "closed registrations cannot schedule late work");
  two.cancel();
  await Promise.all([two.stop(), other.stop()]);
});

test("same-session restart cancels queued work and can schedule again", async () => {
  let calls = 0;
  const maintenance = createSessionMaintenance("maintenance-restart", async () => {
    calls++;
  });
  const cancelled = maintenance.collect();
  maintenance.cancel();
  await cancelled;
  assert.equal(calls, 0);
  await maintenance.collect();
  assert.equal(calls, 1);
  await maintenance.stop();
});

test("disposal drains running maintenance and failures do not poison later scheduling", async () => {
  const started = deferred(),
    finish = deferred();
  const maintenance = createSessionMaintenance("maintenance-drain", async () => {
    started.resolve();
    await finish.promise;
    throw new Error("failed collection");
  });
  const failure = assert.rejects(maintenance.collect(), /failed collection/);
  await started.promise;
  let disposed = false;
  const stopped = maintenance.stop().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  finish.resolve();
  await Promise.all([failure, stopped]);
  let retried = false;
  const next = createSessionMaintenance("maintenance-drain", async () => {
    retried = true;
  });
  await next.collect();
  assert.equal(retried, true);
  await next.stop();
});

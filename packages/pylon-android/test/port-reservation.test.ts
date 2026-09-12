import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveAndroidPort } from "pylon-android/port-reservation";

function pathFor(port: number): string {
  return join(tmpdir(), `pi-helios-port-${port}.lock`);
}

test("Android port reservations exclude concurrent runners and release cleanly", async () => {
  const port = randomInt(50_000, 60_000);
  const first = await reserveAndroidPort(port);
  assert.ok(first);
  assert.equal(await reserveAndroidPort(port), undefined);
  await first.release();
  const second = await reserveAndroidPort(port);
  assert.ok(second);
  await second.release();
});

test("active reservations cannot be stolen only because their lock is old", async () => {
  const port = randomInt(40_000, 50_000);
  const reservation = await reserveAndroidPort(port);
  assert.ok(reservation);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(pathFor(port), old, old);
  assert.equal(await reserveAndroidPort(port), undefined);
  await reservation.release();

  const next = await reserveAndroidPort(port);
  assert.ok(next);
  await next.release();
});

test("a prior owner cannot remove a replacement lock with a different token", async () => {
  const port = randomInt(30_000, 40_000);
  const path = pathFor(port);
  const reservation = await reserveAndroidPort(port);
  assert.ok(reservation);
  await rm(path, { force: true });
  const replacement = { pid: process.pid, token: "00000000-0000-4000-8000-000000000000" };
  await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  try {
    await reservation.release();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), replacement);
  } finally {
    await rm(path, { force: true });
  }
});

test("stale locks from a dead process can be reclaimed", async () => {
  const port = randomInt(20_000, 30_000);
  const path = pathFor(port);
  await writeFile(path, `${JSON.stringify({ pid: 2_147_483_647, token: "10000000-0000-4000-8000-000000000000" })}\n`, {
    mode: 0o600,
  });
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(path, old, old);

  const reservation = await reserveAndroidPort(port);
  assert.ok(reservation);
  await reservation.release();
});
test("an active stale-reclaim guard prevents competing takeover", async () => {
  const port = randomInt(10_000, 20_000);
  const path = pathFor(port);
  const reclaimPath = `${path}.reclaim`;
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await writeFile(path, `${JSON.stringify({ pid: 2_147_483_647, token: "20000000-0000-4000-8000-000000000000" })}\n`, {
    mode: 0o600,
  });
  await utimes(path, old, old);
  await writeFile(reclaimPath, `${process.pid}\n`, { mode: 0o600 });

  try {
    assert.equal(await reserveAndroidPort(port), undefined);
    assert.equal((await readFile(path, "utf8")).includes("20000000"), true);
    assert.equal(await readFile(reclaimPath, "utf8"), `${process.pid}\n`);
  } finally {
    await rm(path, { force: true });
    await rm(reclaimPath, { force: true });
  }
});

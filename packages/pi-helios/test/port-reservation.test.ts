import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { reserveHeliosPort } from "../src/port-reservation.ts";

test("Helios port reservations exclude concurrent managers and release cleanly", async () => {
  const port = randomInt(50_000, 60_000);
  const first = await reserveHeliosPort(port);
  assert.ok(first);
  assert.equal(await reserveHeliosPort(port), undefined);
  await first.release();
  const second = await reserveHeliosPort(port);
  assert.ok(second);
  await second.release();
});

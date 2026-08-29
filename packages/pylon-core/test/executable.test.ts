import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executableAvailable } from "../src/executable.ts";

test("executableAvailable distinguishes a spawned executable from ENOENT", async () => {
  assert.equal(await executableAvailable(process.execPath), true);
  assert.equal(
    await executableAvailable(`pylon-missing-${randomUUID()}`),
    false,
  );
});

test("executableAvailable preserves cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    executableAvailable(process.execPath, controller.signal),
    /cancelled/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionInventory, mapLimit, resolveUniqueSession } from "../src/session-inventory.ts";

async function sessionFile(agentDir: string, directory: string, name: string, content: string) {
  const root = join(agentDir, "sessions", directory);
  await mkdir(root, { recursive: true });
  const path = join(root, `${name}.jsonl`);
  await writeFile(path, content);
  return path;
}

test("session mapping stays bounded, preserves input order, and propagates failures", { timeout: 5_000 }, async () => {
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const inputs = Array.from({ length: 48 }, (_, index) => index);
  const values = await mapLimit(inputs, async value => {
    peak = Math.max(peak, ++active);
    if (value === 0) await first;
    else await Promise.resolve();
    if (value === inputs.length - 1) releaseFirst();
    active--;
    return value * 2;
  });
  assert.equal(peak, 16);
  assert.deepEqual(
    values,
    inputs.map(value => value * 2),
  );
  assert.deepEqual(await mapLimit([], async () => assert.fail("empty input must not invoke the transform")), []);
  await assert.rejects(
    mapLimit([0], async () => {
      throw new Error("metadata unavailable");
    }),
    /metadata unavailable/,
  );
});

test("session inventory reads headers without parsing transcripts and preserves duplicate paths", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pylon-session-inventory-"));
  try {
    const first = await sessionFile(
      agentDir,
      "one",
      "first",
      `${JSON.stringify({ type: "session", id: "duplicate", cwd: "/one", timestamp: "2026-01-01T00:00:00.000Z" })}\nnot json\n${"x".repeat(128 * 1024)}`,
    );
    const second = await sessionFile(
      agentDir,
      "two",
      "second",
      `${JSON.stringify({ type: "session", id: "duplicate", cwd: "/two", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    await sessionFile(agentDir, "broken", "broken", "not json\n");

    const sessions = await listSessionInventory(agentDir);
    assert.deepEqual(new Set(sessions.map(session => session.path)), new Set([first, second]));
    assert.ok(sessions.every(session => session.modified instanceof Date));
    await assert.rejects(resolveUniqueSession("duplicate", agentDir), /ambiguous/);
    await assert.rejects(listSessionInventory(agentDir, { strict: true }), /invalid or oversized session header/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("session inventory treats a missing session root as empty", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pylon-session-inventory-empty-"));
  try {
    assert.deepEqual(await listSessionInventory(agentDir, { strict: true }), []);
    assert.equal(await resolveUniqueSession("missing", agentDir), undefined);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

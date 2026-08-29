import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessionInventory,
  resolveUniqueSession,
} from "../src/session-inventory.ts";

async function sessionFile(
  agentDir: string,
  directory: string,
  name: string,
  content: string,
) {
  const root = join(agentDir, "sessions", directory);
  await mkdir(root, { recursive: true });
  const path = join(root, `${name}.jsonl`);
  await writeFile(path, content);
  return path;
}

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
    assert.deepEqual(
      new Set(sessions.map((session) => session.path)),
      new Set([first, second]),
    );
    assert.ok(sessions.every((session) => session.modified instanceof Date));
    await assert.rejects(
      resolveUniqueSession("duplicate", agentDir),
      /ambiguous/,
    );
    await assert.rejects(
      listSessionInventory(agentDir, { strict: true }),
      /invalid or oversized session header/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("session inventory treats a missing session root as empty", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pylon-session-inventory-empty-"),
  );
  try {
    assert.deepEqual(
      await listSessionInventory(agentDir, { strict: true }),
      [],
    );
    assert.equal(await resolveUniqueSession("missing", agentDir), undefined);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasPendingV4Migration, migrateV4, recordPendingV4Migration, type MigrationJournal } from "../src/memory-migration.ts";
import type { NotebookNote } from "../src/memory.ts";

const fact = (key: string, scope: "user" | "project" = "project", owner = "owner") => ({ key, text: `When ${key}, preserve the documented boundary.`, source: "README", scope, owner, evidencePaths: [] });
const fakeReviewer = (failAt = -1) => {
  let calls = 0;
  return (async (_model: any, prompt: any) => {
    calls++;
    if (calls === failAt) return { stopReason: "error", errorMessage: "provider unavailable", content: [] };
    const text = prompt.messages[0].content[0].text;
    const packet = JSON.parse(text.match(/<migration-data>(.*)<\/migration-data>/s)[1]);
    const decisions = packet.map((item: any) => ({ index: item.index, verdict: "rewrite", trigger: `using ${item.legacyKey}`, guidance: `For ${item.legacyKey}, use action-${item.legacyKey} and boundary-${item.legacyKey}.`, reasonCode: "normalized_rule" }));
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ version: 1, decisions }) }] };
  }) as any;
};
async function writeV4(root: string, facts: any[], candidates: any[] = []) {
  const directory = join(root, "memory-v4"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "memory.json"), JSON.stringify({ schemaVersion: 4, facts }));
  await writeFile(join(directory, "candidates.json"), JSON.stringify({ schemaVersion: 4, candidates }));
}

test("migration availability hides absent, activated, and rolled-back V4 sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-availability-"));
  try {
    assert.equal(await hasPendingV4Migration(root), false);
    await writeV4(root, [fact("contract")]);
    assert.equal(await hasPendingV4Migration(root), true);
    const journal = { version: 1, sourceHashes: {}, status: "activated", completedRecordIds: [], reviewerBatchIds: [], retryCount: 0, diagnostics: [] };
    await mkdir(join(root, "memory-v5"), { recursive: true });
    await writeFile(join(root, "memory-v5", "migration.json"), JSON.stringify(journal));
    assert.equal(await hasPendingV4Migration(root), false);
    await writeFile(join(root, "memory-v5", "migration.json"), JSON.stringify({ ...journal, status: "rolled_back" }));
    assert.equal(await hasPendingV4Migration(root), false);
    await writeFile(join(root, "memory-v5", "migration.json"), JSON.stringify({ ...journal, status: "failed" }));
    assert.equal(await hasPendingV4Migration(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pending migration backs up V4 and records reviewer unavailability", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-pending-"));
  try {
    await writeV4(root, [fact("contract")]);
    assert.equal(await recordPendingV4Migration(root, "reviewer unavailable"), true);
    const journal = JSON.parse(await readFile(join(root, "memory-v5", "migration.json"), "utf8")) as MigrationJournal;
    assert.equal(journal.status, "pending"); assert.match(journal.failureReason ?? "", /reviewer unavailable/);
    assert.ok((await readdir(join(root, "memory-v5", "backups"))).some((name) => name.startsWith("memory-v4-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration reviews all owners and activates once after every batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-atomic-"));
  try {
    const ownerA = "a".repeat(64);
    await writeV4(root, [fact("global", "user", "legacy-user"), { ...fact("one", "project", ownerA), captureCommit: "a".repeat(40) }, fact("two", "project", "owner-b")]);
    let commits = 0, committed: NotebookNote[] = [];
    const result = await migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async (notes) => { commits++; committed = notes; return 7; } });
    assert.equal(result.migrated, true); assert.equal(commits, 1); assert.equal(committed.length, 3);
    assert.equal(committed.find((note) => note.scope === "user")?.owner, "default");
    assert.equal(committed.find((note) => note.owner === ownerA)?.sourceRefs.find((ref) => ref.type === "migration")?.captureCommit, "a".repeat(40));
    const journal = JSON.parse(await readFile(join(root, "memory-v5", "migration.json"), "utf8")) as MigrationJournal;
    assert.equal(journal.status, "activated"); assert.equal(journal.activatedStateRevision, 7);
    const repeated = await migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async () => { commits++; return 8; } });
    assert.equal(repeated.migrated, false); assert.equal(commits, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewer failure never activates a partial owner set and restart uses prepared progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-failure-"));
  try {
    await writeV4(root, [fact("one"), fact("two"), fact("three")]);
    let commits = 0;
    await assert.rejects(migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(2), commitAll: async () => { commits++; return 1; } }), /reviewer/);
    assert.equal(commits, 0);
    const failed = JSON.parse(await readFile(join(root, "memory-v5", "migration.json"), "utf8")) as MigrationJournal;
    assert.equal(failed.status, "failed");
    const resumed = await migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async (notes) => { commits++; assert.equal(notes.length, 3); return 2; } });
    assert.equal(resumed.migrated, true); assert.equal(commits, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed V4 is backed up and journaled without activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-malformed-"));
  try {
    const directory = join(root, "memory-v4"); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "memory.json"), "{bad json");
    await assert.rejects(migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async () => 1 }), /malformed/);
    const backups = await readdir(join(root, "memory-v5", "backups")); assert.ok(backups.some((name) => name.startsWith("memory-v4-")));
    const journal = JSON.parse(await readFile(join(root, "memory-v5", "migration.json"), "utf8")) as MigrationJournal; assert.equal(journal.status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("credential-like legacy records are rejected individually without blocking safe migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-credential-"));
  try {
    await writeV4(root, [fact("safe", "user", "default"), { ...fact("unsafe", "project", "owner"), text: "When configuring access, password=actual-secret-value" }]);
    let committed: NotebookNote[] = [];
    const result = await migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async (notes) => { committed = notes; return 1; } });
    assert.equal(result.migrated, true); assert.equal(committed.length, 1); assert.equal(committed[0]?.scope, "user"); assert.ok(result.rejected >= 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe pending candidates are reported and never imported", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-unsafe-"));
  try {
    await writeV4(root, [fact("safe", "user", "default")], [{ ...fact("candidate"), id: "c", action: "add", evidencePaths: [{ path: "../secret", sha256: "a".repeat(64) }] }]);
    let committed: NotebookNote[] = [];
    const result = await migrateV4({ root, ownerRoots: new Map(), model: {}, auth: { apiKey: "safe" }, profile: { model: "p/m" }, sessionId: "s", completeReview: fakeReviewer(), commitAll: async (notes) => { committed = notes; return 1; } });
    assert.equal(committed.length, 1); assert.ok(result.rejected >= 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

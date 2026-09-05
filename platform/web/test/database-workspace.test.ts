import assert from "node:assert/strict";
import test from "node:test";
import { DATABASE_DRAFTS_KEY, clearDatabaseDrafts, readDatabaseDrafts, saveDatabaseDraft, type DatabaseDraft } from "../src/shared/database-workspace.ts";

test("query persistence isolates connection scopes and never retains live result or parameter data", () => {
  let raw = "";
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const draft: DatabaseDraft = { version: 1, scope: "actor:connection-a", sessionId: "actor", active: "query", height: 220, updatedAt: 0,
    tabs: [{ id: "query", title: "Users", text: "SELECT * FROM users", driver: "sqlite", saved: true }] };
  Object.assign(draft.tabs[0]!, { params: "secret", result: { rows: ["private"] }, plan: "write-token" });
  saveDatabaseDraft(storage, draft);
  saveDatabaseDraft(storage, { ...draft, scope: "actor:connection-b" });
  assert.equal(readDatabaseDrafts(storage).length, 2);
  for (const secret of ["secret", "private", "write-token"]) assert.ok(!raw.includes(secret));
  clearDatabaseDrafts(storage, "actor", draft.scope);
  assert.deepEqual(readDatabaseDrafts(storage).map(value => value.scope), ["actor:connection-b"]);
  saveDatabaseDraft(storage, { ...draft, tabs: draft.tabs.map(tab => ({ ...tab, saved: false })) });
  assert.equal(readDatabaseDrafts(storage).length, 1);
  clearDatabaseDrafts(storage, "actor");
  assert.deepEqual(readDatabaseDrafts(storage), []);
});

test("draft restoration rejects malformed, oversized, and inaccessible storage without throwing", () => {
  for (const raw of ["{", "{}", '[{"version":2}]', "x".repeat(1024 * 1024 + 1)]) {
    assert.deepEqual(readDatabaseDrafts({ getItem: key => { assert.equal(key, DATABASE_DRAFTS_KEY); return raw; } }), []);
  }
  assert.deepEqual(readDatabaseDrafts({ getItem: () => { throw new Error("denied"); } }), []);
  assert.throws(() => saveDatabaseDraft({ getItem: () => null, setItem: () => {} }, {
    version: 1, scope: "a", sessionId: "a", active: "q", height: 220, updatedAt: 0,
    tabs: [{ id: "q", title: "q", driver: "sqlite", saved: true, text: "x".repeat(65537) }],
  }), /storage limit/);
});

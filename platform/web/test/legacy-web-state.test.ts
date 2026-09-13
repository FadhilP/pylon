import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { COMPOSER_DRAFTS_KEY } from "../src/client/conversation/composer-drafts.ts";
import { DATABASE_DRAFTS_KEY } from "../src/client/database/database-workspace.ts";
import { EXPLORER_STATE_KEY } from "../src/client/workspace/explorer-state.ts";
import type { LegacyWebStateImportInput, LegacyWebStateImportResult } from "../src/shared/settings/web-state.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const accepted = (domain: keyof LegacyWebStateImportInput): LegacyWebStateImportResult => {
  if (domain === "preferences") return { preferences: { accepted: true, value: { revision: 1, initialized: true, theme: "dark", syntax: "auto", hiddenModels: [], databaseWorkspace: "session" } } };
  return { [domain]: { accepted: true, values: [] } } as LegacyWebStateImportResult;
};

function authoredDrafts(storage: MemoryStorage): void {
  storage.setItem("pylon-theme", "dark");
  storage.setItem("pylon-syntax-theme", "dracula");
  storage.setItem("pylon-database-workspace-v1", "global");
  storage.setItem("pylon-hidden-models", JSON.stringify(["provider/model", "provider/model"]));
  storage.setItem(EXPLORER_STATE_KEY, JSON.stringify([{ projectId: "project", open: ["src"], changesOnly: false }]));
  storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify([{ sessionId: "session", projectId: "project", text: "draft", updatedAt: 1 }]));
  // Browser-only active/height state is intentionally not part of the durable payload.
  storage.setItem(DATABASE_DRAFTS_KEY, JSON.stringify([{ version: 1, scope: JSON.stringify(["session", "session", "session", "database"]), sessionId: "session", tabs: [{ id: "query", title: "Query", text: "select 1", driver: "sqlite", saved: true }], active: "query", height: 400, updatedAt: 1 }]));
}

test("accepted legacy domains clear authored keys and normalize duplicate hidden models", async () => {
  const jiti = createJiti(import.meta.url);
  const { importLegacyWebState } = await jiti.import<{ importLegacyWebState: (send: (input: LegacyWebStateImportInput) => Promise<LegacyWebStateImportResult>, projectForSession?: (sessionId: string) => string | undefined) => Promise<string | undefined> }>("../src/client/runtime/legacy-web-state.ts");
  const previous = globalThis.localStorage;
  const storage = new MemoryStorage();
  globalThis.localStorage = storage as unknown as Storage;
  const calls: LegacyWebStateImportInput[] = [];
  try {
    authoredDrafts(storage);
    const warning = await importLegacyWebState(async input => {
      calls.push(input);
      return accepted(Object.keys(input)[0] as keyof LegacyWebStateImportInput);
    }, sessionId => sessionId === "session" ? "project" : undefined);
    assert.equal(warning, undefined);
    assert.deepEqual(calls[0].preferences?.hiddenModels, [{ provider: "provider", id: "model" }]);
    assert.deepEqual(calls[3].databases, [{ scope: JSON.stringify(["session", "session", "session", "database"]), sessionId: "session", projectId: "project", tabs: [{ id: "query", title: "Query", text: "select 1", driver: "sqlite", saved: true }] }]);
    for (const key of ["pylon-theme", "pylon-syntax-theme", "pylon-hidden-models", "pylon-database-workspace-v1", EXPLORER_STATE_KEY, COMPOSER_DRAFTS_KEY, DATABASE_DRAFTS_KEY]) assert.equal(storage.getItem(key), null);
  } finally {
    globalThis.localStorage = previous;
  }
});

test("conflicting, unresolved, and failed legacy transfers retain their browser keys", async () => {
  const jiti = createJiti(import.meta.url);
  const { importLegacyWebState } = await jiti.import<{ importLegacyWebState: (send: (input: LegacyWebStateImportInput) => Promise<LegacyWebStateImportResult>, projectForSession?: (sessionId: string) => string | undefined) => Promise<string | undefined> }>("../src/client/runtime/legacy-web-state.ts");
  const previous = globalThis.localStorage;
  const storage = new MemoryStorage();
  globalThis.localStorage = storage as unknown as Storage;
  try {
    authoredDrafts(storage);
    const warning = await importLegacyWebState(async input => {
      if (input.composers) return { composers: { accepted: false, values: [] } };
      if (input.databases) return { databases: { accepted: false, values: [] } };
      return accepted(Object.keys(input)[0] as keyof LegacyWebStateImportInput);
    }, () => "project");
    assert.match(warning ?? "", /conflict/);
    assert.ok(storage.getItem(COMPOSER_DRAFTS_KEY));
    assert.ok(storage.getItem(DATABASE_DRAFTS_KEY));

    storage.setItem("pylon-theme", "warm");
    await importLegacyWebState(async () => { throw new Error("offline"); });
    assert.equal(storage.getItem("pylon-theme"), "warm");
    assert.ok(storage.getItem(COMPOSER_DRAFTS_KEY));

    storage.setItem(DATABASE_DRAFTS_KEY, JSON.stringify([{ version: 1, scope: JSON.stringify(["session", "missing", "missing", "database"]), sessionId: "missing", tabs: [{ id: "query", title: "Query", text: "select 1", driver: "sqlite", saved: true }], active: "query", height: 400, updatedAt: 1 }]));
    const unresolved = await importLegacyWebState(async input => accepted(Object.keys(input)[0] as keyof LegacyWebStateImportInput));
    assert.match(unresolved ?? "", /database drafts/);
    assert.ok(storage.getItem(DATABASE_DRAFTS_KEY));
  } finally {
    globalThis.localStorage = previous;
  }
});

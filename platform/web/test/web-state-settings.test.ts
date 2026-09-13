import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { KeyboardSettingsStore, WebStateRevisionConflict } from "../src/server/settings/keyboard-settings.ts";
import { DEFAULT_KEYMAP } from "../src/shared/settings/keyboard.ts";

const explorer = (projectId: string, open = ["src"]): { projectId: string; open: string[]; changesOnly: boolean } => ({ projectId, open, changesOnly: false });
const composer = (sessionId: string, projectId = "p"): { sessionId: string; projectId: string; text: string } => ({ sessionId, projectId, text: "draft" });
const databaseScope = (name: string, sessionId: string) => JSON.stringify(["session", sessionId, sessionId, name]);
const database = (name: string, sessionId = "s", projectId = "p") => ({
  scope: databaseScope(name, sessionId), sessionId, projectId, tabs: [{ id: "query", title: "Query", text: "select 1", driver: "sqlite" as const, saved: true as const }],
});

function temporaryStore(): { dir: string; path: string; store: KeyboardSettingsStore } {
  const dir = mkdtempSync(join(tmpdir(), "pylon-web-state-"));
  const path = join(dir, "settings.sqlite");
  return { dir, path, store: new KeyboardSettingsStore(path) };
}

test("SQLite migrates v1 keyboard data to durable web state and survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "pylon-web-state-v1-"));
  const path = join(dir, "settings.sqlite");
  let store: KeyboardSettingsStore | undefined;
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE keyboard_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL); PRAGMA user_version=1");
    db.prepare("INSERT INTO keyboard_settings VALUES (1,7,?)").run(JSON.stringify(DEFAULT_KEYMAP));
    db.close();
    store = new KeyboardSettingsStore(path);
    assert.equal(store.read().revision, 7);
    const saved = store.updateExplorer(undefined, explorer("project"))!;
    store.close();
    store = new KeyboardSettingsStore(path);
    assert.deepEqual(store.readExplorer("project"), saved);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default state deletes rows and stale saves conflict with the authoritative absence", () => {
  const { dir, store } = temporaryStore();
  try {
    const saved = store.updateComposer(undefined, composer("s"))!;
    assert.equal(store.updateComposer(saved.revision, { ...composer("s"), text: "" }), undefined);
    assert.equal(store.readComposer("s"), undefined);
    assert.throws(() => store.updateComposer(saved.revision, composer("s")), (error: unknown) => error instanceof WebStateRevisionConflict && error.current === undefined);
    const state = store.updateExplorer(undefined, explorer("p"))!;
    assert.equal(store.updateExplorer(state.revision, explorer("p", [])), undefined);
    const draft = store.updateDatabase(undefined, database("scope"))!;
    assert.equal(store.updateDatabase(draft.revision, { ...database("scope"), tabs: [] }), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy imports decide each domain once and cannot recreate a cleared draft", () => {
  const { dir, store } = temporaryStore();
  try {
    const first = store.importLegacy({ explorers: [explorer("project")], preferences: { initialized: false, theme: "dark", syntax: "auto", hiddenModels: [], databaseWorkspace: "session" } });
    assert.equal(first.explorers?.accepted, true);
    assert.equal(first.preferences?.value.initialized, true);
    const saved = store.readExplorer("project")!;
    store.deleteExplorer("project", saved.revision);
    const stale = store.importLegacy({ explorers: [explorer("project")] });
    assert.equal(stale.explorers?.accepted, false);
    assert.equal(store.readExplorer("project"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authored drafts reject quota growth rather than silently evicting another draft", () => {
  const { dir, store } = temporaryStore();
  try {
    const text = "x".repeat(64 * 1024);
    for (let i = 0; i < 128; i++) store.updateComposer(undefined, { sessionId: `s${i}`, projectId: "p", text });
    assert.throws(() => store.updateComposer(undefined, { sessionId: "overflow", projectId: "p", text }), /limit/);
    assert.equal(store.readComposer("s0")?.text.length, text.length);
    assert.throws(() => store.updateComposer(undefined, { sessionId: "bad", projectId: "p", text: "x".repeat(64 * 1024 + 1) }), /Invalid|limit/);
    const tabs = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, title: `T${index}`, text: "q".repeat(60 * 1024), driver: "sqlite" as const, saved: true as const }));
    for (let i = 0; i < 4; i++) store.updateDatabase(undefined, { ...database(`db${i}`, `db-session${i}`), tabs });
    assert.throws(() => store.updateDatabase(undefined, { ...database("db-overflow", "db-overflow"), tabs }), /limit/);
    assert.equal(store.readDatabase(databaseScope("db0", "db-session0"))?.tabs.length, 4);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit session/project cleanup removes owned rows, explorer pruning is age based, and checkpoint/close are safe", () => {
  const { dir, path, store } = temporaryStore();
  try {
    store.updateExplorer(undefined, explorer("old"));
    const db = new DatabaseSync(path);
    db.prepare("UPDATE explorer_states SET updated_at=? WHERE project_id='old'").run(Date.now() - 91 * 24 * 60 * 60 * 1000);
    db.close();
    store.updateExplorer(undefined, explorer("fresh"));
    assert.equal(store.readExplorer("old"), undefined);
    store.updateComposer(undefined, composer("session", "project"));
    store.updateDatabase(undefined, database("scope", "session", "project"));
    store.deleteSession("session");
    assert.equal(store.readComposer("session"), undefined);
    assert.equal(store.readDatabase(databaseScope("scope", "session")), undefined);
    store.updateExplorer(undefined, explorer("project"));
    store.updateComposer(undefined, composer("other", "project"));
    store.updateDatabase(undefined, database("other-scope", "other", "project"));
    store.deleteProject("project");
    assert.equal(store.readExplorer("project"), undefined);
    assert.equal(store.readComposer("other"), undefined);
    assert.equal(store.readDatabase(databaseScope("other-scope", "other")), undefined);
    store.checkpoint();
    store.close();
    store.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

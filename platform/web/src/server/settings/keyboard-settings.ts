import { DatabaseSync } from "node:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_KEYMAP,
  isKeyboardSettings,
  validateKeymap,
  type KeyboardSettings,
  type Keymap,
} from "../../shared/settings/keyboard.ts";
import {
  isComposerDraft,
  isComposerDraftInput,
  isDatabaseDraft,
  isDatabaseDraftInput,
  isExplorerInput,
  isExplorerRecord,
  isHostPreferences,
  isHostPreferencesInput,
  utf8Bytes,
  type ComposerDraft,
  type ComposerDraftInput,
  type DatabaseDraft,
  type DatabaseDraftInput,
  type ExplorerInput,
  type ExplorerRecord,
  type HostPreferences,
  type HostPreferencesInput,
  type LegacyWebStateImportInput,
  type LegacyWebStateImportResult,
} from "../../shared/settings/web-state.ts";

export class KeyboardRevisionConflict extends Error {
  constructor(readonly current: KeyboardSettings) {
    super("Keyboard settings changed in another window. Review the current bindings and retry.");
  }
}

/** A failed optimistic write always includes the authoritative value (or absence). */
export class WebStateRevisionConflict<T> extends Error {
  constructor(readonly current: T | undefined) {
    super("Web state changed in another window. Reload it and retry.");
  }
}

const PREFERENCES_LIMIT = 64 * 1024;
const EXPLORER_RECORD_LIMIT = 32 * 1024;
const EXPLORER_ROW_LIMIT = 1000;
const EXPLORER_TOTAL_LIMIT = 8 * 1024 * 1024;
const COMPOSER_TEXT_LIMIT = 64 * 1024;
const COMPOSER_ROW_LIMIT = 500;
const COMPOSER_TOTAL_LIMIT = 8 * 1024 * 1024;
const DATABASE_RECORD_LIMIT = 256 * 1024;
const DATABASE_TOTAL_LIMIT = 1024 * 1024;
const EXPLORER_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

type ExpectedRevision = number | null | undefined;
type SqlRow = Record<string, unknown>;

/**
 * Owns settings.sqlite and all durable Pylon Web state. The historical class name
 * stays exported because the keyboard HTTP API already depends on it.
 */
export class KeyboardSettingsStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=100;");
      this.migrate();
      // Fail closed: opening existing corrupt preferences must not replace them.
      this.read();
      this.readHostPreferences();
      this.transaction(() => this.pruneExplorers(Date.now(), ""));
      this.checkpoint();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 2) throw new Error("Keyboard settings were created by a newer Pylon version");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (version === 0) {
        this.createKeyboardTable();
        this.db
          .prepare("INSERT OR IGNORE INTO keyboard_settings (id,revision,value) VALUES (1,0,?)")
          .run(JSON.stringify(DEFAULT_KEYMAP));
      }
      if (version <= 1) this.createWebStateTables();
      this.createLegacyImportsTable();
      this.db.exec("PRAGMA user_version=2; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createKeyboardTable(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS keyboard_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)");
  }

  private createWebStateTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explorer_states (
        project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS explorer_states_age ON explorer_states(updated_at);
      CREATE TABLE IF NOT EXISTS composer_drafts (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS composer_drafts_project ON composer_drafts(project_id);
      CREATE TABLE IF NOT EXISTS database_drafts (
        scope TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS database_drafts_session ON database_drafts(session_id);
      CREATE INDEX IF NOT EXISTS database_drafts_project ON database_drafts(project_id);
    `);
    this.db.prepare("INSERT OR IGNORE INTO host_preferences (id,revision,value) VALUES (1,0,?)").run(JSON.stringify({ initialized: false, theme: "system", syntax: "auto", hiddenModels: [], databaseWorkspace: "session" }));
  }
  private createLegacyImportsTable(): void {
    // Kept in schema v2: this feature has not shipped, but existing development
    // databases may already carry user_version=2.
    this.db.exec("CREATE TABLE IF NOT EXISTS legacy_imports (domain TEXT PRIMARY KEY, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)))");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Keyboard settings store is closed");
  }
  private transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  private expected<T extends { revision: number }>(expectedRevision: ExpectedRevision, current: T | undefined): void {
    if (expectedRevision == null) {
      if (current) throw new WebStateRevisionConflict(current);
      return;
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid web state revision");
    if (!current || current.revision !== expectedRevision) throw new WebStateRevisionConflict(current);
  }
  private nextRevision(current: { revision: number } | undefined): number {
    if (current && current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Web state revision exhausted");
    return (current?.revision ?? -1) + 1;
  }

  read(): KeyboardSettings {
    this.assertOpen();
    const row = this.db.prepare("SELECT revision,value FROM keyboard_settings WHERE id=1").get();
    if (!row) throw new Error("Stored keyboard settings are missing; no settings were reset");
    const value: unknown = { revision: row.revision, keymap: JSON.parse(String(row.value)) };
    if (!isKeyboardSettings(value)) throw new Error("Stored keyboard settings are invalid; no settings were reset");
    return value;
  }

  update(expectedRevision: number, keymap: Keymap): KeyboardSettings {
    this.assertOpen();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid keyboard settings revision");
    return this.transaction(() => {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new KeyboardRevisionConflict(current);
      const problem = validateKeymap(keymap);
      if (problem) throw new Error(problem);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Keyboard settings revision exhausted");
      this.db.prepare("UPDATE keyboard_settings SET revision=revision+1,value=? WHERE id=1 AND revision=?").run(JSON.stringify(keymap), expectedRevision);
      return this.read();
    });
  }

  readHostPreferences(): HostPreferences {
    this.assertOpen();
    const row = this.db.prepare("SELECT revision,value FROM host_preferences WHERE id=1").get() as SqlRow | undefined;
    if (!row) throw new Error("Stored host preferences are missing; no settings were reset");
    const value: unknown = { ...JSON.parse(String(row.value)), revision: row.revision };
    if (!isHostPreferences(value)) throw new Error("Stored host preferences are invalid; no settings were reset");
    return value;
  }
  /** Compatibility-friendly short name for the later settings endpoint. */
  readPreferences(): HostPreferences {
    return this.readHostPreferences();
  }
  updateHostPreferences(expectedRevision: ExpectedRevision, input: HostPreferencesInput): HostPreferences {
    this.assertOpen();
    if (!isHostPreferencesInput(input)) throw new Error("Invalid host preferences");
    const encoded = JSON.stringify(input);
    if (utf8Bytes(encoded) > PREFERENCES_LIMIT) throw new Error("Host preferences exceed the storage limit");
    return this.transaction(() => {
      const current = this.readHostPreferences();
      if (current.initialized && !input.initialized) throw new Error("Host preferences initialization cannot be cleared");
      if (expectedRevision == null) throw new WebStateRevisionConflict(current);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid web state revision");
      if (expectedRevision !== current.revision) throw new WebStateRevisionConflict(current);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Web state revision exhausted");
      this.db.prepare("INSERT INTO host_preferences (id,revision,value) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value").run(current.revision + 1, encoded);
      return this.readHostPreferences();
    });
  }
  updatePreferences(expectedRevision: ExpectedRevision, input: HostPreferencesInput): HostPreferences {
    return this.updateHostPreferences(expectedRevision, input);
  }

  readExplorer(projectId: string): ExplorerRecord | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT revision,updated_at,value FROM explorer_states WHERE project_id=?").get(projectId) as SqlRow | undefined;
    if (!row) return undefined;
    const value: unknown = { ...JSON.parse(String(row.value)), projectId, revision: row.revision, updatedAt: row.updated_at };
    if (!isExplorerRecord(value)) throw new Error("Stored explorer state is invalid; no settings were reset");
    return value;
  }
  listExplorers(): ExplorerRecord[] {
    this.assertOpen();
    return (this.db.prepare("SELECT project_id FROM explorer_states ORDER BY updated_at DESC, project_id").all() as SqlRow[]).map(row => this.readExplorer(String(row.project_id))!);
  }
  updateExplorer(expectedRevision: ExpectedRevision, input: ExplorerInput): ExplorerRecord | undefined {
    this.assertOpen();
    if (!isExplorerInput(input)) throw new Error("Invalid explorer state");
    if (input.open.length === 0 && !input.changesOnly) return this.deleteExplorer(input.projectId, expectedRevision);
    const now = Date.now();
    return this.transaction(() => {
      const current = this.readExplorer(input.projectId);
      this.expected(expectedRevision, current);
      const saved: ExplorerRecord = { ...input, revision: this.nextRevision(current), updatedAt: now };
      const encoded = JSON.stringify({ open: saved.open, changesOnly: saved.changesOnly });
      if (utf8Bytes(encoded) > EXPLORER_RECORD_LIMIT) throw new Error("Explorer state exceeds the storage limit");
      this.db.prepare("INSERT INTO explorer_states (project_id,revision,updated_at,value) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,value=excluded.value").run(saved.projectId, saved.revision, saved.updatedAt, encoded);
      this.pruneExplorers(now, saved.projectId);
      return this.readExplorer(saved.projectId);
    });
  }
  deleteExplorer(projectId: string, expectedRevision: ExpectedRevision): undefined {
    this.assertOpen();
    return this.transaction(() => {
      const current = this.readExplorer(projectId);
      this.expected(expectedRevision, current);
      if (current) this.db.prepare("DELETE FROM explorer_states WHERE project_id=? AND revision=?").run(projectId, current.revision);
      return undefined;
    });
  }
  private pruneExplorers(now: number, keepProjectId: string): void {
    this.db.prepare("DELETE FROM explorer_states WHERE updated_at < ?").run(now - EXPLORER_MAX_AGE);
    for (;;) {
      const total = this.db.prepare("SELECT count(*) AS count, COALESCE(sum(length(CAST(value AS BLOB))),0) AS bytes FROM explorer_states").get() as SqlRow;
      if (Number(total.count) <= EXPLORER_ROW_LIMIT && Number(total.bytes) <= EXPLORER_TOTAL_LIMIT) return;
      const oldest = this.db.prepare("SELECT project_id FROM explorer_states WHERE project_id<>? ORDER BY updated_at,project_id LIMIT 1").get(keepProjectId) as SqlRow | undefined;
      if (!oldest) return;
      this.db.prepare("DELETE FROM explorer_states WHERE project_id=?").run(String(oldest.project_id));
    }
  }
  importExplorers(inputs: readonly ExplorerInput[]): ExplorerRecord[] {
    const imported: ExplorerRecord[] = [];
    for (const input of inputs) {
      try {
        const saved = this.updateExplorer(undefined, input);
        if (saved) imported.push(saved);
      } catch (error) {
        if (!(error instanceof WebStateRevisionConflict)) throw error;
        if (error.current) imported.push(error.current as ExplorerRecord);
      }
    }
    return imported;
  }

  readComposer(sessionId: string): ComposerDraft | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT project_id,revision,updated_at,text FROM composer_drafts WHERE session_id=?").get(sessionId) as SqlRow | undefined;
    if (!row) return undefined;
    const value: unknown = { sessionId, projectId: row.project_id, text: row.text, revision: row.revision, updatedAt: row.updated_at };
    if (!isComposerDraft(value)) throw new Error("Stored composer draft is invalid; no settings were reset");
    return value;
  }
  listComposers(): ComposerDraft[] {
    this.assertOpen();
    return (this.db.prepare("SELECT session_id FROM composer_drafts ORDER BY updated_at DESC, session_id").all() as SqlRow[]).map(row => this.readComposer(String(row.session_id))!);
  }
  listComposersForProject(projectId: string, limit = 100): ComposerDraft[] {
    this.assertOpen();
    return (this.db.prepare("SELECT session_id FROM composer_drafts WHERE project_id=? ORDER BY updated_at DESC, session_id LIMIT ?").all(projectId, limit) as SqlRow[]).map(row => this.readComposer(String(row.session_id))!);
  }
  updateComposer(expectedRevision: ExpectedRevision, input: ComposerDraftInput): ComposerDraft | undefined {
    this.assertOpen();
    if (!isComposerDraftInput(input)) throw new Error("Invalid composer draft");
    if (input.text.length === 0) return this.deleteComposer(input.sessionId, expectedRevision);
    if (utf8Bytes(input.text) > COMPOSER_TEXT_LIMIT) throw new Error("Composer draft exceeds the storage limit");
    const now = Date.now();
    return this.transaction(() => {
      const current = this.readComposer(input.sessionId);
      this.expected(expectedRevision, current);
      const quota = this.db.prepare("SELECT count(*) AS count, COALESCE(sum(length(CAST(text AS BLOB))),0) AS bytes FROM composer_drafts WHERE session_id<>?").get(input.sessionId) as SqlRow;
      if (Number(quota.count) + 1 > COMPOSER_ROW_LIMIT || Number(quota.bytes) + utf8Bytes(input.text) > COMPOSER_TOTAL_LIMIT) throw new Error("Composer drafts exceed the storage limit");
      const saved: ComposerDraft = { ...input, revision: this.nextRevision(current), updatedAt: now };
      this.db.prepare("INSERT INTO composer_drafts (session_id,project_id,revision,updated_at,text) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,revision=excluded.revision,updated_at=excluded.updated_at,text=excluded.text").run(saved.sessionId, saved.projectId, saved.revision, saved.updatedAt, saved.text);
      return saved;
    });
  }
  deleteComposer(sessionId: string, expectedRevision: ExpectedRevision): undefined {
    this.assertOpen();
    return this.transaction(() => {
      const current = this.readComposer(sessionId);
      this.expected(expectedRevision, current);
      if (current) this.db.prepare("DELETE FROM composer_drafts WHERE session_id=? AND revision=?").run(sessionId, current.revision);
      return undefined;
    });
  }
  importComposers(inputs: readonly ComposerDraftInput[]): ComposerDraft[] {
    const imported: ComposerDraft[] = [];
    for (const input of inputs) {
      try {
        const saved = this.updateComposer(undefined, input);
        if (saved) imported.push(saved);
      } catch (error) {
        if (!(error instanceof WebStateRevisionConflict)) throw error;
        if (error.current) imported.push(error.current as ComposerDraft);
      }
    }
    return imported;
  }

  readDatabase(scope: string): DatabaseDraft | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT revision,updated_at,value FROM database_drafts WHERE scope=?").get(scope) as SqlRow | undefined;
    if (!row) return undefined;
    const value: unknown = { ...JSON.parse(String(row.value)), revision: row.revision, updatedAt: row.updated_at };
    if (!isDatabaseDraft(value)) throw new Error("Stored database draft is invalid; no settings were reset");
    return value;
  }
  listDatabases(): DatabaseDraft[] {
    this.assertOpen();
    return (this.db.prepare("SELECT scope FROM database_drafts ORDER BY updated_at DESC, scope").all() as SqlRow[]).map(row => this.readDatabase(String(row.scope))!);
  }
  listDatabasesForSession(sessionId: string, limit = 100): DatabaseDraft[] {
    this.assertOpen();
    return (this.db.prepare("SELECT scope FROM database_drafts WHERE session_id=? ORDER BY updated_at DESC, scope LIMIT ?").all(sessionId, limit) as SqlRow[]).map(row => this.readDatabase(String(row.scope))!);
  }
  updateDatabase(expectedRevision: ExpectedRevision, input: DatabaseDraftInput): DatabaseDraft | undefined {
    this.assertOpen();
    if (!isDatabaseDraftInput(input)) throw new Error("Invalid database draft");
    if (input.tabs.length === 0) return this.deleteDatabase(input.scope, expectedRevision);
    const now = Date.now();
    return this.transaction(() => {
      const current = this.readDatabase(input.scope);
      this.expected(expectedRevision, current);
      const saved: DatabaseDraft = { ...input, revision: this.nextRevision(current), updatedAt: now };
      const encoded = JSON.stringify(saved);
      if (utf8Bytes(encoded) > DATABASE_RECORD_LIMIT) throw new Error("Database draft exceeds the storage limit");
      const quota = this.db.prepare("SELECT COALESCE(sum(length(CAST(value AS BLOB))),0) AS bytes FROM database_drafts WHERE scope<>?").get(input.scope) as SqlRow;
      if (Number(quota.bytes) + utf8Bytes(encoded) > DATABASE_TOTAL_LIMIT) throw new Error("Database drafts exceed the storage limit");
      this.db.prepare("INSERT INTO database_drafts (scope,session_id,project_id,revision,updated_at,value) VALUES (?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET session_id=excluded.session_id,project_id=excluded.project_id,revision=excluded.revision,updated_at=excluded.updated_at,value=excluded.value").run(saved.scope, saved.sessionId, saved.projectId, saved.revision, saved.updatedAt, encoded);
      return saved;
    });
  }
  deleteDatabase(scope: string, expectedRevision: ExpectedRevision): undefined {
    this.assertOpen();
    return this.transaction(() => {
      const current = this.readDatabase(scope);
      this.expected(expectedRevision, current);
      if (current) this.db.prepare("DELETE FROM database_drafts WHERE scope=? AND revision=?").run(scope, current.revision);
      return undefined;
    });
  }
  importDatabases(inputs: readonly DatabaseDraftInput[]): DatabaseDraft[] {
    const imported: DatabaseDraft[] = [];
    for (const input of inputs) {
      try {
        const saved = this.updateDatabase(undefined, input);
        if (saved) imported.push(saved);
      } catch (error) {
        if (!(error instanceof WebStateRevisionConflict)) throw error;
        if (error.current) imported.push(error.current as DatabaseDraft);
      }
    }
    return imported;
  }

  /**
   * Imports each supplied legacy domain at most once. The ledger and all writes
   * share one transaction, so a stale browser cannot recreate a cleared row.
   */
  importLegacy(input: LegacyWebStateImportInput): LegacyWebStateImportResult {
    this.assertOpen();
    return this.transaction(() => {
      const decided = (domain: string) => Boolean(this.db.prepare("SELECT 1 FROM legacy_imports WHERE domain=?").get(domain));
      const mark = (domain: string, accepted: boolean) => this.db.prepare("INSERT INTO legacy_imports (domain,accepted) VALUES (?,?)").run(domain, accepted ? 1 : 0);
      const result: LegacyWebStateImportResult = {};
      if (input.preferences !== undefined) {
        const current = this.readHostPreferences();
        if (decided("preferences")) result.preferences = { accepted: false, value: current };
        else if (current.initialized || current.revision !== 0) {
          mark("preferences", false);
          result.preferences = { accepted: false, value: current };
        } else {
          const saved = this.updateHostPreferences(current.revision, { ...input.preferences, initialized: true });
          mark("preferences", true);
          result.preferences = { accepted: true, value: saved };
        }
      }
      if (input.explorers !== undefined) {
        if (decided("explorers")) {
          result.explorers = { accepted: false, values: this.listExplorers() };
        } else if (input.explorers.some(item => this.readExplorer(item.projectId))) {
          // A stale browser must not recreate rows that were deleted after it loaded.
          mark("explorers", false);
          result.explorers = { accepted: false, values: this.listExplorers() };
        } else {
          result.explorers = { accepted: true, values: this.importExplorers(input.explorers) };
          mark("explorers", true);
        }
      }
      if (input.composers !== undefined) {
        if (decided("composers")) {
          result.composers = { accepted: false, values: this.listComposers() };
        } else if (input.composers.some(item => this.readComposer(item.sessionId))) {
          mark("composers", false);
          result.composers = { accepted: false, values: this.listComposers() };
        } else {
          result.composers = { accepted: true, values: this.importComposers(input.composers) };
          mark("composers", true);
        }
      }
      if (input.databases !== undefined) {
        if (decided("databases")) {
          result.databases = { accepted: false, values: this.listDatabases() };
        } else if (input.databases.some(item => this.readDatabase(item.scope))) {
          mark("databases", false);
          result.databases = { accepted: false, values: this.listDatabases() };
        } else {
          result.databases = { accepted: true, values: this.importDatabases(input.databases) };
          mark("databases", true);
        }
      }
      return result;
    });
  }

  /** These cleanup calls are explicit only; normal reads/listing never archive or delete authored drafts. */
  /** Returns deletion markers so transports can converge other browser caches. */
  deleteSession(sessionId: string): { composers: string[]; databases: string[] } {
    this.assertOpen();
    const composers = this.listComposers().filter(draft => draft.sessionId === sessionId).map(draft => draft.sessionId);
    const databases = this.listDatabasesForSession(sessionId).map(draft => draft.scope);
    this.transaction(() => {
      this.db.prepare("DELETE FROM composer_drafts WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM database_drafts WHERE session_id=?").run(sessionId);
    });
    return { composers, databases };
  }
  deleteProject(projectId: string): { explorers: string[]; composers: string[]; databases: string[] } {
    this.assertOpen();
    const explorers = this.listExplorers().filter(state => state.projectId === projectId).map(state => state.projectId);
    const composers = this.listComposersForProject(projectId, 501).map(draft => draft.sessionId);
    const databases = this.listDatabases().filter(draft => draft.projectId === projectId).map(draft => draft.scope);
    this.transaction(() => {
      this.db.prepare("DELETE FROM explorer_states WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM composer_drafts WHERE project_id=?").run(projectId);
      this.db.prepare("DELETE FROM database_drafts WHERE project_id=?").run(projectId);
    });
    return { explorers, composers, databases };
  }
  /** WAL-friendly, non-blocking maintenance for callers after explicit cleanup. */
  checkpoint(): void {
    this.assertOpen();
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

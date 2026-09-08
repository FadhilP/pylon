import { DatabaseSync } from "node:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_KEYMAP,
  isKeyboardSettings,
  validateKeymap,
  type KeyboardSettings,
  type Keymap,
} from "../shared/keyboard.ts";

export class KeyboardRevisionConflict extends Error {
  constructor(readonly current: KeyboardSettings) {
    super("Keyboard settings changed in another window. Review the current bindings and retry.");
  }
}

/** Durable Web preferences, deliberately separate from disposable repository indexes. */
export class KeyboardSettingsStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1) throw new Error("Keyboard settings were created by a newer Pylon version");
      if (version === 0) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(
            "CREATE TABLE IF NOT EXISTS keyboard_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)",
          );
          this.db
            .prepare("INSERT OR IGNORE INTO keyboard_settings (id,revision,value) VALUES (1,0,?)")
            .run(JSON.stringify(DEFAULT_KEYMAP));
          this.db.exec("PRAGMA user_version=1; COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      this.read();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  read(): KeyboardSettings {
    if (this.closed) throw new Error("Keyboard settings store is closed");
    const row = this.db.prepare("SELECT revision,value FROM keyboard_settings WHERE id=1").get();
    if (!row) throw new Error("Stored keyboard settings are missing; no settings were reset");
    const value: unknown = { revision: row?.revision, keymap: JSON.parse(String(row?.value)) };
    if (!isKeyboardSettings(value)) throw new Error("Stored keyboard settings are invalid; no settings were reset");
    return value;
  }
  update(expectedRevision: number, keymap: Keymap): KeyboardSettings {
    if (this.closed) throw new Error("Keyboard settings store is closed");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid keyboard settings revision");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new KeyboardRevisionConflict(current);
      const problem = validateKeymap(keymap);
      if (problem) throw new Error(problem);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Keyboard settings revision exhausted");
      this.db
        .prepare("UPDATE keyboard_settings SET revision=revision+1,value=? WHERE id=1 AND revision=?")
        .run(JSON.stringify(keymap), expectedRevision);
      const saved = this.read();
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

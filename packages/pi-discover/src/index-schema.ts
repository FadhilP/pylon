import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function indexDatabasePath(
  agentDir = typeof getAgentDir === "function"
    ? getAgentDir()
    : join(homedir(), ".pi", "agent"),
): string {
  if (process.env.PI_DISCOVER_INDEX_PATH)
    return process.env.PI_DISCOVER_INDEX_PATH;
  const current = join(agentDir, "pi-discover", "index.sqlite");
  const legacy = join(agentDir, "indexes", "pi-discover.sqlite");
  if (existsSync(current) || !existsSync(legacy)) return current;
  mkdirSync(dirname(current), { recursive: true });
  const database = new DatabaseSync(legacy);
  try {
    database.exec("PRAGMA busy_timeout=1000; PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    database.close();
  }
  renameSync(legacy, current);
  return current;
}

const SCHEMA_VERSION = 3;
// 0x10000 checks every table, including existing indexes with no query history; 0x2 runs the recommended bounded analysis.
const SQLITE_OPTIMIZE_ALL = "PRAGMA optimize=0x10002;";

export function optimizeDatabase(db: DatabaseSync, inspectAll = false): void {
  try {
    db.exec(inspectAll ? SQLITE_OPTIMIZE_ALL : "PRAGMA optimize;");
  } catch {
    // Planner statistics are optional derived data; contention must not fail an otherwise committed refresh.
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY, root TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE,
      head TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', indexed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS repository_states (
      repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      path TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
      UNIQUE(repo_id, path)
    );
    CREATE INDEX IF NOT EXISTS files_repo_path ON files(repo_id, path);
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_no INTEGER NOT NULL, signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY, root TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE,
      head TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', indexed_at INTEGER,
      membership_state TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS workspace_repositories (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      prefix TEXT NOT NULL,
      PRIMARY KEY(workspace_id, prefix)
    );
    CREATE INDEX IF NOT EXISTS workspace_repositories_repo ON workspace_repositories(repo_id);
  `);
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(content, tokenize='trigram');",
    );
  } catch {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(content);");
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version > SCHEMA_VERSION)
      throw new Error(
        `pi-discover index schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
      );
    if (version < SCHEMA_VERSION) {
      db.exec(`
        DROP TABLE IF EXISTS workspace_repositories;
        DROP TABLE IF EXISTS workspaces;
        DROP TABLE IF EXISTS code_fts;
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS repository_states;
        DROP TABLE IF EXISTS repositories;
      `);
    }
    createSchema(db);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Open the index database, applying pragmas and the schema; never leaves a half-open handle. */
export function openIndexDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    initializeSchema(db);
    optimizeDatabase(db, true);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

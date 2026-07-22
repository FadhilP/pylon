import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bounded, boundedError, SEARCH_TIMEOUT_MS, workspacePath } from "./search-common.ts";

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_RESULTS = 30;
const MAX_RESULTS = 100;

type SymbolRow = { name: string; kind: string; line: number; column: number; signature: string };
type PreparedFile = {
  path: string;
  language: string;
  content: string;
  hash: string;
  size: number;
  dirty: boolean;
  symbols: SymbolRow[];
};
type ExecResult = { code: number; stdout: string; stderr: string };
type IndexExecutor = (command: string, args: string[], options: { timeout: number }) => Promise<ExecResult>;
type RepositoryIdentity = { root: string; rootKey: string; head: string; branch: string };
type IndexedRepository = RepositoryIdentity & { prefix: string };

const languages: Record<string, string> = {
  ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".go": "go", ".java": "java", ".js": "javascript", ".jsx": "javascript",
  ".kt": "kotlin", ".kts": "kotlin", ".php": "php", ".py": "python", ".rb": "ruby",
  ".rs": "rust", ".sh": "shell", ".swift": "swift", ".ts": "typescript", ".tsx": "typescript",
  ".vue": "vue", ".svelte": "svelte",
};

export function indexDatabasePath(agentDir = typeof getAgentDir === "function" ? getAgentDir() : join(homedir(), ".pi", "agent")): string {
  if (process.env.PI_DISCOVER_INDEX_PATH) return process.env.PI_DISCOVER_INDEX_PATH;
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

function languageFor(path: string): string | undefined {
  return languages[extname(path).toLowerCase()];
}

function signature(value: string): string {
  return value.trim().slice(0, 300);
}

/** Lightweight language-aware symbol extraction. Results are intentionally marked heuristic by the tool. */
export function extractSymbols(content: string, language: string): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const add = (name: string, kind: string, line: number, column: number, source: string) => {
    if (name) rows.push({ name, kind, line, column, signature: signature(source) });
  };
  for (const [index, source] of content.split(/\r?\n/).entries()) {
    let match: RegExpExecArray | null;
    if (language === "python") {
      match = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(source);
      if (match) add(match[2], match[1] === "def" ? "function" : "class", index + 1, source.indexOf(match[2]) + 1, source);
      continue;
    }
    if (language === "go") {
      match = /^\s*(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*)\s+(struct|interface))/.exec(source);
      if (match) add(match[1] ?? match[2], match[1] ? "function" : match[3], index + 1, source.indexOf(match[1] ?? match[2]) + 1, source);
      continue;
    }
    if (language === "rust") {
      match = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/.exec(source);
      if (match) add(match[2], match[1] === "fn" ? "function" : match[1], index + 1, source.indexOf(match[2]) + 1, source);
      continue;
    }
    if (language === "ruby") {
      match = /^\s*(def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/.exec(source);
      if (match) add(match[2], match[1] === "def" ? "function" : match[1], index + 1, source.indexOf(match[2]) + 1, source);
      continue;
    }
    if (language === "shell") {
      match = /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*\{/.exec(source);
      if (match) add(match[1], "function", index + 1, source.indexOf(match[1]) + 1, source);
      continue;
    }
    match = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+)*(?:async\s+)?(class|interface|enum|function|type|namespace|module|struct|trait)\s+([A-Za-z_$][\w$]*)/.exec(source);
    if (match) {
      add(match[2], match[1] === "function" ? "function" : match[1], index + 1, source.indexOf(match[2]) + 1, source);
      continue;
    }
    if (["javascript", "typescript", "vue", "svelte"].includes(language)) {
      match = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(source);
      if (match) add(match[1], "function", index + 1, source.indexOf(match[1]) + 1, source);
    }
  }
  return rows;
}

function parseNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function canonicalPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function statusPaths(value: string): Set<string> {
  const tokens = parseNul(value);
  const paths = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    paths.add(token.slice(3));
    if (/[RC]/.test(status)) {
      const original = tokens[++index];
      if (original) paths.add(original);
    }
  }
  return paths;
}

function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (content.charCodeAt(index) === 10) line++;
  return line;
}

function excerpt(content: string, query: string): { line: number; text: string } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, content.lastIndexOf("\n", Math.max(0, found - 160)) + 1);
  const endAt = content.indexOf("\n", found + 240);
  const end = endAt < 0 ? Math.min(content.length, found + 240) : endAt;
  return { line: lineAt(content, found), text: content.slice(start, end).trim().slice(0, 500) };
}

const SCHEMA_VERSION = 2;

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
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(path, content, tokenize='trigram');");
  } catch {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(path, content);");
  }
}

function initializeSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) throw new Error(`pi-discover index schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
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

export class WorkspaceIndex {
  private db?: DatabaseSync;
  private workspaceId?: number;
  private root?: string;
  private pending: Promise<void> = Promise.resolve();
  private readonly cwd: string;
  private readonly exec: IndexExecutor;
  private readonly path: string;

  constructor(cwd: string, exec: IndexExecutor, path = indexDatabasePath()) {
    this.cwd = cwd;
    this.exec = exec;
    this.path = path;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      initializeSchema(this.db);
      return this.db;
    } catch (error) {
      this.db.close();
      this.db = undefined;
      throw error;
    }
  }

  private async gitAt(cwd: string, args: string[]): Promise<ExecResult> {
    const result = await this.exec("git", ["-C", cwd, ...args], { timeout: SEARCH_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${boundedError(result.stderr || result.stdout)}`);
    return result;
  }

  private async git(args: string[]): Promise<ExecResult> {
    return this.gitAt(this.cwd, args);
  }

  private async identityAt(root: string): Promise<RepositoryIdentity> {
    const [headResult, branchResult] = await Promise.all([
      this.gitAt(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ({ code: 0, stdout: "unborn\n", stderr: "" })),
      this.gitAt(root, ["branch", "--show-current"]).catch(() => ({ code: 0, stdout: "", stderr: "" })),
    ]);
    return {
      root,
      rootKey: canonicalPath(root),
      head: headResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
    };
  }

  private async identity(): Promise<RepositoryIdentity> {
    if (!this.root) this.root = await realpath((await this.git(["rev-parse", "--show-toplevel"])).stdout.trim());
    return this.identityAt(this.root);
  }

  private ensureWorkspace(identity: RepositoryIdentity): void {
    if (this.workspaceId) return;
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO repositories(root,root_key) VALUES (?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
      `).run(identity.root, identity.rootKey);
      const repoId = Number((db.prepare("SELECT id FROM repositories WHERE root_key=?").get(identity.rootKey) as { id: number }).id);
      db.prepare(`
        INSERT INTO workspaces(root,root_key,head,branch) VALUES (?,?,?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
      `).run(identity.root, identity.rootKey, identity.head, identity.branch);
      this.workspaceId = Number((db.prepare("SELECT id FROM workspaces WHERE root_key=?").get(identity.rootKey) as { id: number }).id);
      db.prepare("INSERT OR IGNORE INTO workspace_repositories(workspace_id,repo_id,prefix) VALUES (?,?,?)")
        .run(this.workspaceId, repoId, "");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async indexedRepositories(root: RepositoryIdentity): Promise<IndexedRepository[]> {
    const repositories: IndexedRepository[] = [{ ...root, prefix: "" }];
    const queue = [{ repository: repositories[0], ancestors: new Set([root.rootKey]) }];
    const physicalRoots = new Set([root.rootKey]);
    const childrenByRoot = new Map<string, Array<{ path: string; identity: RepositoryIdentity }>>();
    const prefixes = new Set([""]);
    for (let index = 0; index < queue.length; index++) {
      const { repository, ancestors } = queue[index];
      let children = childrenByRoot.get(repository.rootKey);
      if (!children) {
        children = [];
        const staged = parseNul((await this.gitAt(repository.root, ["ls-files", "--stage", "-z"])).stdout);
        for (const entry of staged) {
          const match = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
          if (!match) continue;
          const gitlinkPath = match[1].replaceAll("\\", "/");
          let childRoot: string;
          try {
            childRoot = await realpath(resolve(repository.root, gitlinkPath));
          } catch (error: any) {
            if (error?.code === "ENOENT") continue;
            throw error;
          }
          const within = relative(this.root!, childRoot);
          if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) continue;
          const rootKey = canonicalPath(childRoot);
          let topLevel: string;
          try {
            topLevel = await realpath((await this.gitAt(childRoot, ["rev-parse", "--show-toplevel"])).stdout.trim());
          } catch (error) {
            if (!existsSync(join(childRoot, ".git"))) continue;
            throw error;
          }
          if (canonicalPath(topLevel) !== rootKey) continue;
          if (!physicalRoots.has(rootKey) && physicalRoots.size >= 100) throw new Error("pi-discover nested repository limit exceeded");
          physicalRoots.add(rootKey);
          children.push({ path: gitlinkPath, identity: await this.identityAt(childRoot) });
        }
        childrenByRoot.set(repository.rootKey, children);
      }
      for (const child of children) {
        if (ancestors.has(child.identity.rootKey)) continue;
        const prefix = repository.prefix ? `${repository.prefix}/${child.path}` : child.path;
        if (prefixes.has(prefix)) continue;
        prefixes.add(prefix);
        const member = { ...child.identity, prefix };
        repositories.push(member);
        queue.push({ repository: member, ancestors: new Set([...ancestors, child.identity.rootKey]) });
      }
    }
    return repositories;
  }

  private async prepare(root: string, path: string, dirty: boolean): Promise<PreparedFile | undefined> {
    const language = languageFor(path);
    if (!language) return undefined;
    const absolute = resolve(root, path);
    const within = relative(root, absolute);
    if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) return undefined;
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined;
      const data = await readFile(absolute);
      if (data.includes(0)) return undefined;
      const content = data.toString("utf8");
      return {
        path: path.replaceAll("\\", "/"), language, content, size: stat.size, dirty,
        hash: createHash("sha256").update(data).digest("hex"),
        symbols: extractSymbols(content, language),
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private repositoryIds(repositories: IndexedRepository[]): Map<string, number> {
    const db = this.database();
    const ids = new Map<string, number>();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const repository of repositories) {
        if (ids.has(repository.rootKey)) continue;
        db.prepare(`
          INSERT INTO repositories(root,root_key) VALUES (?,?)
          ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
        `).run(repository.root, repository.rootKey);
        const id = Number((db.prepare("SELECT id FROM repositories WHERE root_key=?").get(repository.rootKey) as { id: number }).id);
        db.prepare("INSERT OR IGNORE INTO repository_states(repo_id) VALUES (?)").run(id);
        ids.set(repository.rootKey, id);
      }
      db.exec("COMMIT");
      return ids;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private apply(repoId: number, files: PreparedFile[], removals: string[], identity: RepositoryIdentity, generation: number): boolean {
    const db = this.database();
    const removeFts = db.prepare("DELETE FROM code_fts WHERE rowid = ?");
    const removeFile = db.prepare("DELETE FROM files WHERE id = ?");
    const findFile = db.prepare("SELECT id, hash, dirty FROM files WHERE repo_id = ? AND path = ?");
    const insertFile = db.prepare("INSERT INTO files(repo_id,path,language,content,hash,size,dirty) VALUES (?,?,?,?,?,?,?)");
    const updateFile = db.prepare("UPDATE files SET language=?,content=?,hash=?,size=?,dirty=? WHERE id=?");
    const removeSymbols = db.prepare("DELETE FROM symbols WHERE file_id = ?");
    const insertSymbol = db.prepare("INSERT INTO symbols(file_id,name,kind,line,column_no,signature) VALUES (?,?,?,?,?,?)");
    const insertFts = db.prepare("INSERT INTO code_fts(rowid,path,content) VALUES (?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentGeneration = Number((db.prepare("SELECT generation FROM repository_states WHERE repo_id=?").get(repoId) as { generation: number }).generation);
      if (currentGeneration !== generation) {
        db.exec("ROLLBACK");
        return false;
      }
      for (const path of removals) {
        const row = findFile.get(repoId, path) as { id: number } | undefined;
        if (!row) continue;
        removeFts.run(row.id);
        removeFile.run(row.id);
      }
      for (const file of files) {
        const current = findFile.get(repoId, file.path) as { id: number; hash: string; dirty: number } | undefined;
        if (current?.hash === file.hash && current.dirty === Number(file.dirty)) continue;
        let fileId: number;
        if (current) {
          fileId = current.id;
          removeFts.run(fileId);
          removeSymbols.run(fileId);
          updateFile.run(file.language, file.content, file.hash, file.size, Number(file.dirty), fileId);
        } else {
          fileId = Number(insertFile.run(repoId, file.path, file.language, file.content, file.hash, file.size, Number(file.dirty)).lastInsertRowid);
        }
        insertFts.run(fileId, file.path, file.content);
        for (const symbol of file.symbols) insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.line, symbol.column, symbol.signature);
      }
      db.prepare("UPDATE repositories SET root=?,head=?,branch=?,indexed_at=? WHERE id=?")
        .run(identity.root, identity.head, identity.branch, Date.now(), repoId);
      db.prepare("UPDATE repository_states SET generation=generation+1 WHERE repo_id=?").run(repoId);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async refreshRepository(repoId: number, repository: RepositoryIdentity, forceFull: boolean): Promise<void> {
    const db = this.database();
    for (let attempt = 0; attempt < 3; attempt++) {
      const identity = await this.identityAt(repository.root);
      const state = db.prepare(`
        SELECT r.head,r.indexed_at,s.generation
        FROM repositories r JOIN repository_states s ON s.repo_id=r.id WHERE r.id=?
      `).get(repoId) as { head: string; indexed_at?: number; generation: number };
      const full = forceFull || !state.indexed_at || state.head !== identity.head;
      let current: Set<string>;
      let candidates: Set<string>;
      if (full) {
        current = new Set(parseNul((await this.gitAt(identity.root, ["ls-files", "--full-name", "-co", "--exclude-standard", "-z"])).stdout));
        candidates = current;
      } else {
        current = statusPaths((await this.gitAt(identity.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout);
        const prior = db.prepare("SELECT path FROM files WHERE repo_id=? AND dirty=1").all(repoId) as Array<{ path: string }>;
        candidates = new Set([...current, ...prior.map((row) => row.path)]);
      }
      const prepared: PreparedFile[] = [];
      const removals: string[] = [];
      for (const path of candidates) {
        const file = await this.prepare(identity.root, path, !full && current.has(path));
        if (file) prepared.push(file);
        else removals.push(path.replaceAll("\\", "/"));
      }
      if (full) {
        const existing = db.prepare("SELECT path FROM files WHERE repo_id=?").all(repoId) as Array<{ path: string }>;
        for (const { path } of existing) if (!current.has(path)) removals.push(path);
      }
      if ((await this.identityAt(identity.root)).head !== identity.head) continue;
      if (this.apply(repoId, prepared, [...new Set(removals)], identity, state.generation)) return;
    }
    throw new Error(`pi-discover repository changed repeatedly while indexing: ${repository.root}`);
  }

  private publishWorkspace(identity: RepositoryIdentity, repositories: IndexedRepository[], ids: Map<string, number>): void {
    const db = this.database();
    const membershipState = createHash("sha256")
      .update(JSON.stringify(repositories.map(({ prefix, rootKey }) => [prefix, rootKey]).sort((a, b) => a[0].localeCompare(b[0]))))
      .digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO workspaces(root,root_key,head,branch,indexed_at,membership_state) VALUES (?,?,?,?,?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root,head=excluded.head,branch=excluded.branch,indexed_at=excluded.indexed_at,membership_state=excluded.membership_state
      `).run(identity.root, identity.rootKey, identity.head, identity.branch, Date.now(), membershipState);
      this.workspaceId = Number((db.prepare("SELECT id FROM workspaces WHERE root_key=?").get(identity.rootKey) as { id: number }).id);
      db.prepare("DELETE FROM workspace_repositories WHERE workspace_id=?").run(this.workspaceId);
      const insert = db.prepare("INSERT INTO workspace_repositories(workspace_id,repo_id,prefix) VALUES (?,?,?)");
      for (const repository of repositories) insert.run(this.workspaceId, ids.get(repository.rootKey)!, repository.prefix);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async refreshNow(forceFull = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const identity = await this.identity();
      this.ensureWorkspace(identity);
      const repositories = await this.indexedRepositories(identity);
      const ids = this.repositoryIds(repositories);
      const physical = new Map(repositories.map((repository) => [repository.rootKey, repository]));
      for (const repository of physical.values()) await this.refreshRepository(ids.get(repository.rootKey)!, repository, forceFull);
      const latestIdentity = await this.identityAt(identity.root);
      if (latestIdentity.head !== identity.head) continue;
      this.publishWorkspace(latestIdentity, repositories, ids);
      return;
    }
    throw new Error(`pi-discover workspace changed repeatedly while indexing: ${this.root}`);
  }

  refresh(): Promise<void> {
    const next = this.pending.then(() => this.refreshNow());
    this.pending = next.catch(() => undefined);
    return next;
  }

  rebuild(): Promise<void> {
    const next = this.pending.then(() => this.refreshNow(true));
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async ready(): Promise<void> {
    await this.pending;
    if (!this.workspaceId) this.ensureWorkspace(await this.identity());
  }

  private scopedPath(cwd: string, input?: string): string {
    const local = workspacePath(cwd, input);
    const path = relative(this.root!, resolve(cwd, local)).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error("Search path must stay within workspace");
    return path === "." ? "" : path;
  }

  async searchSymbols(cwd: string, options: { query: string; path?: string; language?: string; kind?: string; limit?: number }) {
    await this.ready();
    const limit = options.limit ?? DEFAULT_RESULTS;
    const scope = this.scopedPath(cwd, options.path);
    const projectedPath = "CASE WHEN wr.prefix='' THEN f.path ELSE wr.prefix||'/'||f.path END";
    const clauses = ["wr.workspace_id=?", "instr(lower(s.name),lower(?))>0"];
    const args: Array<string | number> = [this.workspaceId!, options.query];
    if (scope) {
      clauses.push(`(${projectedPath}=? OR substr(${projectedPath},1,length(?)+1)=?||'/')`);
      args.push(scope, scope, scope);
    }
    if (options.language) { clauses.push("f.language=?"); args.push(options.language); }
    if (options.kind) { clauses.push("s.kind=?"); args.push(options.kind); }
    args.push(options.query, options.query, options.query, limit);
    return this.database().prepare(`
      SELECT s.name,s.kind,${projectedPath} AS path,f.language,s.line,s.column_no AS column,s.signature
      FROM symbols s JOIN files f ON f.id=s.file_id JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY lower(s.name)=lower(?) DESC, substr(lower(s.name),1,length(?))=lower(?) DESC, s.name COLLATE NOCASE, path, s.line LIMIT ?
    `).all(...args);
  }

  async searchCode(cwd: string, options: { query: string; path?: string; language?: string; limit?: number }) {
    await this.ready();
    const limit = options.limit ?? DEFAULT_RESULTS;
    const scope = this.scopedPath(cwd, options.path);
    const query = ftsQuery(options.query);
    const projectedPath = "CASE WHEN wr.prefix='' THEN f.path ELSE wr.prefix||'/'||f.path END";
    const clauses = ["wr.workspace_id=?"];
    const args: Array<string | number> = [this.workspaceId!];
    if (scope) {
      clauses.push(`(${projectedPath}=? OR substr(${projectedPath},1,length(?)+1)=?||'/')`);
      args.push(scope, scope, scope);
    }
    if (options.language) { clauses.push("f.language=?"); args.push(options.language); }
    let statement: StatementSync;
    if (query) {
      clauses.push("code_fts MATCH ?"); args.push(query, limit);
      statement = this.database().prepare(`
        SELECT ${projectedPath} AS path,f.language,f.content,bm25(code_fts) AS rank
        FROM code_fts JOIN files f ON f.id=code_fts.rowid JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
        WHERE ${clauses.join(" AND ")} ORDER BY rank,path LIMIT ?
      `);
    } else {
      clauses.push("instr(lower(f.content),lower(?))>0"); args.push(options.query, limit);
      statement = this.database().prepare(`
        SELECT ${projectedPath} AS path,f.language,f.content,0 AS rank
        FROM files f JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
        WHERE ${clauses.join(" AND ")} ORDER BY path LIMIT ?
      `);
    }
    return (statement.all(...args) as Array<{ path: string; language: string; content: string; rank: number }>).map(({ content, ...row }) => ({ ...row, ...excerpt(content, options.query) }));
  }

  async status() {
    await this.ready();
    return this.database().prepare(`
      SELECT w.root,w.head,w.branch,w.indexed_at,count(DISTINCT f.id) AS files,count(DISTINCT s.id) AS symbols
      FROM workspaces w
      LEFT JOIN workspace_repositories wr ON wr.workspace_id=w.id
      LEFT JOIN files f ON f.repo_id=wr.repo_id
      LEFT JOIN symbols s ON s.file_id=f.id
      WHERE w.id=? GROUP BY w.id
    `).get(this.workspaceId!);
  }

  async close(): Promise<void> {
    await this.pending;
    this.db?.close();
    this.db = undefined;
  }
}

export type IndexProvider = (cwd: string) => WorkspaceIndex;

export function registerIndexTools(pi: ExtensionAPI, indexFor: IndexProvider, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "symbol_search",
    label: "Symbol search",
    description: `Search the local SQLite symbol index. Extraction is language-aware but heuristic. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Search indexed repository symbols by name, kind, language, or path",
    promptGuidelines: ["Use symbol_search for fast symbol discovery; confirm heuristic matches from source before editing."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      path: Type.Optional(Type.String()), language: Type.Optional(Type.String()), kind: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await indexFor(ctx.cwd).searchSymbols(ctx.cwd, params);
      return { content: [{ type: "text" as const, text: bounded(JSON.stringify({ heuristic: true, results }), maxBytes) }], details: { count: results.length, heuristic: true } };
    },
  });
  pi.registerTool({
    name: "code_search",
    label: "Indexed code search",
    description: `Search indexed source using SQLite FTS5 lexical ranking. This is not embedding-based semantic search. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Search the local lexical code index with ranked snippets",
    promptGuidelines: ["Use code_search for fast lexical discovery across indexed source; use rg when regex or current fallback search is needed."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }), path: Type.Optional(Type.String()), language: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await indexFor(ctx.cwd).searchCode(ctx.cwd, params);
      return { content: [{ type: "text" as const, text: bounded(JSON.stringify({ semantic: false, results }), maxBytes) }], details: { count: results.length, semantic: false } };
    },
  });
  pi.registerTool({
    name: "index_status",
    label: "Index status",
    description: "Report local pi-discover SQLite index status for the current repository.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _update, ctx) {
      const status = await indexFor(ctx.cwd).status();
      return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status as Record<string, unknown> };
    },
  });
}

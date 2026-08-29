import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { escapesRoot, fitJson, workspacePath } from "./search-common.ts";
import { indexDatabasePath, openIndexDatabase, optimizeDatabase } from "./index-schema.ts";
import {
  RepositoryScanner,
  sameSnapshot,
  type IndexedRepository,
  type IndexExecutor,
  type PreparedFile,
  type RepositoryIdentity,
  type RepositorySnapshot,
} from "./repository-scanner.ts";

export { extractSymbols } from "./symbols.ts";
export { indexDatabasePath } from "./index-schema.ts";

const DEFAULT_SYMBOL_RESULTS = 30;
const DEFAULT_CODE_RESULTS = 10;
const MAX_RESULTS = 100;
const MAX_EXCERPT_CHARS = 240;

function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function excerpt(content: string, query: string): { line: number; text: string } {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const lines = content.split(/\r?\n/);
  let bestLine = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index].toLowerCase();
    const score = terms.filter(term => lower.includes(term)).length;
    if (score > bestScore) {
      bestLine = index;
      bestScore = score;
    }
  }
  const source = lines[bestLine].trim();
  if (source.length <= MAX_EXCERPT_CHARS) return { line: bestLine + 1, text: source };
  const lower = source.toLowerCase();
  const found =
    terms
      .map(term => lower.indexOf(term))
      .filter(offset => offset >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(found - 80, source.length - MAX_EXCERPT_CHARS));
  const prefix = start ? "…" : "";
  const suffix = start + MAX_EXCERPT_CHARS < source.length ? "…" : "";
  const text = source.slice(start, start + MAX_EXCERPT_CHARS - prefix.length - suffix.length);
  return { line: bestLine + 1, text: `${prefix}${text}${suffix}` };
}

type RankedRows<T> = T[] & { moreAvailable?: boolean };

function structuredResults(
  base: Record<string, unknown>,
  results: Record<string, unknown>[],
  maxBytes: number,
  moreAvailable = false,
): string {
  const observed = results.length;
  return fitJson(
    returned => ({
      ...base,
      results: results.slice(0, returned),
      observed,
      returned,
      truncated: returned < observed || moreAvailable,
      ...(moreAvailable ? { moreAvailable: true } : {}),
    }),
    observed,
    maxBytes,
    [{ results: [] }],
  ).text;
}

const PROJECTED_PATH = "CASE WHEN wr.prefix='' THEN f.path ELSE wr.prefix||'/'||f.path END";

/** Clauses and bound arguments restricting a files join to one workspace, path scope, and language. */
function workspaceScope(workspaceId: number, scope: string, language?: string) {
  const clauses = ["wr.workspace_id=?"];
  const args: Array<string | number> = [workspaceId];
  if (scope) {
    clauses.push(`(${PROJECTED_PATH}=? OR substr(${PROJECTED_PATH},1,length(?)+1)=?||'/')`);
    args.push(scope, scope, scope);
  }
  if (language) {
    clauses.push("f.language=?");
    args.push(language);
  }
  return { clauses, args };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/** Owns the SQLite index for one workspace: refresh scheduling, storage, and queries. */
export class WorkspaceIndex {
  private db?: DatabaseSync;
  private workspaceId?: number;
  private pending: Promise<void> = Promise.resolve();
  private freshening?: Promise<void>;
  private readonly scanner: RepositoryScanner;
  private readonly path: string;

  constructor(cwd: string, exec: IndexExecutor, path = indexDatabasePath()) {
    this.scanner = new RepositoryScanner(cwd, exec);
    this.path = path;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    try {
      this.db = openIndexDatabase(this.path);
      return this.db;
    } catch (error) {
      this.db = undefined;
      throw error;
    }
  }

  private ensureWorkspace(identity: RepositoryIdentity): void {
    if (this.workspaceId) return;
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `
        INSERT INTO repositories(root,root_key) VALUES (?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
      `,
      ).run(identity.root, identity.rootKey);
      const repoId = Number(
        (db.prepare("SELECT id FROM repositories WHERE root_key=?").get(identity.rootKey) as { id: number }).id,
      );
      db.prepare(
        `
        INSERT INTO workspaces(root,root_key,head,branch) VALUES (?,?,?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
      `,
      ).run(identity.root, identity.rootKey, identity.head, identity.branch);
      this.workspaceId = Number(
        (db.prepare("SELECT id FROM workspaces WHERE root_key=?").get(identity.rootKey) as { id: number }).id,
      );
      db.prepare("INSERT OR IGNORE INTO workspace_repositories(workspace_id,repo_id,prefix) VALUES (?,?,?)").run(
        this.workspaceId,
        repoId,
        "",
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
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
        db.prepare(
          `
          INSERT INTO repositories(root,root_key) VALUES (?,?)
          ON CONFLICT(root_key) DO UPDATE SET root=excluded.root
        `,
        ).run(repository.root, repository.rootKey);
        const id = Number(
          (db.prepare("SELECT id FROM repositories WHERE root_key=?").get(repository.rootKey) as { id: number }).id,
        );
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

  private apply(
    repoId: number,
    files: PreparedFile[],
    removals: string[],
    identity: RepositoryIdentity,
    generation: number,
  ): boolean {
    const db = this.database();
    const removeFts = db.prepare("DELETE FROM code_fts WHERE rowid = ?");
    const removeFile = db.prepare("DELETE FROM files WHERE id = ?");
    const findFile = db.prepare("SELECT id, hash, dirty FROM files WHERE repo_id = ? AND path = ?");
    const insertFile = db.prepare(
      "INSERT INTO files(repo_id,path,language,content,hash,size,dirty) VALUES (?,?,?,?,?,?,?)",
    );
    const updateFile = db.prepare("UPDATE files SET language=?,content=?,hash=?,size=?,dirty=? WHERE id=?");
    const removeSymbols = db.prepare("DELETE FROM symbols WHERE file_id = ?");
    const insertSymbol = db.prepare(
      "INSERT INTO symbols(file_id,name,kind,line,column_no,signature) VALUES (?,?,?,?,?,?)",
    );
    const insertFts = db.prepare("INSERT INTO code_fts(rowid,content) VALUES (?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentGeneration = Number(
        (db.prepare("SELECT generation FROM repository_states WHERE repo_id=?").get(repoId) as { generation: number })
          .generation,
      );
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
          fileId = Number(
            insertFile.run(repoId, file.path, file.language, file.content, file.hash, file.size, Number(file.dirty))
              .lastInsertRowid,
          );
        }
        insertFts.run(fileId, file.content);
        for (const symbol of file.symbols)
          insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.line, symbol.column, symbol.signature);
      }
      db.prepare("UPDATE repositories SET root=?,head=?,branch=?,indexed_at=? WHERE id=?").run(
        identity.root,
        identity.head,
        identity.branch,
        Date.now(),
        repoId,
      );
      db.prepare("UPDATE repository_states SET generation=generation+1 WHERE repo_id=?").run(repoId);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Bring one repository's rows up to date, retrying if the working tree moves mid-scan.
   * A full pass rebuilds from the git inventory; an incremental pass revisits dirty files only.
   */
  private async refreshRepository(
    repoId: number,
    repository: IndexedRepository,
    forceFull: boolean,
  ): Promise<RepositorySnapshot> {
    const db = this.database();
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = attempt === 0 ? repository : await this.scanner.snapshotAt(repository.root);
      const state = db
        .prepare(
          `
        SELECT r.head,r.indexed_at,s.generation
        FROM repositories r JOIN repository_states s ON s.repo_id=r.id WHERE r.id=?
      `,
        )
        .get(repoId) as { head: string; indexed_at?: number; generation: number };
      const full = forceFull || !state.indexed_at || state.head !== snapshot.head;
      const inventory = full ? await this.scanner.inventory(snapshot.root) : undefined;
      const candidates =
        inventory ??
        new Set([
          ...snapshot.dirty,
          ...(
            db.prepare("SELECT path FROM files WHERE repo_id=? AND dirty=1").all(repoId) as Array<{ path: string }>
          ).map(row => row.path),
        ]);
      const { prepared, removals } = await this.scanner.prepareAll(snapshot.root, [...candidates], snapshot.dirty);
      if (inventory) {
        const existing = db.prepare("SELECT path FROM files WHERE repo_id=?").all(repoId) as Array<{ path: string }>;
        for (const { path } of existing) if (!inventory.has(path)) removals.push(path);
      }
      const verified = await this.scanner.snapshotAt(snapshot.root);
      if (!sameSnapshot(snapshot, verified)) continue;
      if (this.apply(repoId, prepared, [...new Set(removals)], verified, state.generation)) return verified;
    }
    throw new Error(`pi-discover repository changed repeatedly while indexing: ${repository.root}`);
  }

  private publishWorkspace(
    identity: RepositoryIdentity,
    repositories: IndexedRepository[],
    ids: Map<string, number>,
  ): void {
    const db = this.database();
    const membershipState = createHash("sha256")
      .update(
        JSON.stringify(
          repositories.map(({ prefix, rootKey }) => [prefix, rootKey]).sort((a, b) => a[0].localeCompare(b[0])),
        ),
      )
      .digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `
        INSERT INTO workspaces(root,root_key,head,branch,indexed_at,membership_state) VALUES (?,?,?,?,?,?)
        ON CONFLICT(root_key) DO UPDATE SET root=excluded.root,head=excluded.head,branch=excluded.branch,indexed_at=excluded.indexed_at,membership_state=excluded.membership_state
      `,
      ).run(identity.root, identity.rootKey, identity.head, identity.branch, Date.now(), membershipState);
      this.workspaceId = Number(
        (db.prepare("SELECT id FROM workspaces WHERE root_key=?").get(identity.rootKey) as { id: number }).id,
      );
      db.prepare("DELETE FROM workspace_repositories WHERE workspace_id=?").run(this.workspaceId);
      const insert = db.prepare("INSERT INTO workspace_repositories(workspace_id,repo_id,prefix) VALUES (?,?,?)");
      for (const repository of repositories)
        insert.run(this.workspaceId, ids.get(repository.rootKey)!, repository.prefix);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async refreshNow(forceFull = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.scanner.snapshot();
      this.ensureWorkspace(snapshot);
      const repositories = await this.scanner.indexedRepositories(snapshot);
      const ids = this.repositoryIds(repositories);
      const physical = new Map(repositories.map(repository => [repository.rootKey, repository]));
      const rootRepository = physical.get(snapshot.rootKey)!;
      // Refresh the root last so its verified snapshot is also the final workspace race check.
      for (const repository of physical.values()) {
        if (repository.rootKey !== snapshot.rootKey)
          await this.refreshRepository(ids.get(repository.rootKey)!, repository, forceFull);
      }
      const latestSnapshot = await this.refreshRepository(ids.get(snapshot.rootKey)!, rootRepository, forceFull);
      if (!sameSnapshot(snapshot, latestSnapshot)) continue;
      this.publishWorkspace(latestSnapshot, repositories, ids);
      optimizeDatabase(this.database());
      return;
    }
    throw new Error(`pi-discover workspace changed repeatedly while indexing: ${this.scanner.root}`);
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

  prune(): Promise<{ removedWorkspaces: number; removedRepositories: number; removedFiles: number }> {
    const next = this.pending.then(async () => {
      const db = this.database();
      const workspaces = db.prepare("SELECT id,root FROM workspaces").all() as Array<{ id: number; root: string }>;
      const repositories = db.prepare("SELECT id,root FROM repositories").all() as Array<{ id: number; root: string }>;
      const missingWorkspaces = (
        await Promise.all(workspaces.map(async row => ((await directoryExists(row.root)) ? undefined : row.id)))
      ).filter((id): id is number => id !== undefined);
      const missingRepositories = (
        await Promise.all(repositories.map(async row => ((await directoryExists(row.root)) ? undefined : row.id)))
      ).filter((id): id is number => id !== undefined);
      db.exec("BEGIN IMMEDIATE");
      try {
        let removedWorkspaces = 0;
        let removedRepositories = 0;
        let removedFiles = 0;
        const removeWorkspace = db.prepare("DELETE FROM workspaces WHERE id=?");
        for (const id of missingWorkspaces) removedWorkspaces += Number(removeWorkspace.run(id).changes);
        const countFiles = db.prepare("SELECT count(*) AS count FROM files WHERE repo_id=?");
        const removeFts = db.prepare("DELETE FROM code_fts WHERE rowid IN (SELECT id FROM files WHERE repo_id=?)");
        const removeRepository = db.prepare("DELETE FROM repositories WHERE id=?");
        for (const id of missingRepositories) {
          const files = Number((countFiles.get(id) as { count: number }).count);
          removeFts.run(id);
          const removed = Number(removeRepository.run(id).changes);
          removedRepositories += removed;
          if (removed) removedFiles += files;
        }
        db.exec("COMMIT");
        if (this.workspaceId && missingWorkspaces.includes(this.workspaceId)) this.workspaceId = undefined;
        return { removedWorkspaces, removedRepositories, removedFiles };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async ensureFresh(): Promise<void> {
    if (this.freshening) return this.freshening;
    let current!: Promise<void>;
    current = (async () => {
      try {
        await this.refresh();
      } finally {
        if (this.freshening === current) this.freshening = undefined;
      }
    })();
    this.freshening = current;
    return current;
  }

  private async ready(): Promise<void> {
    await this.pending;
    if (!this.workspaceId) this.ensureWorkspace(await this.scanner.snapshot());
  }

  private scopedPath(cwd: string, input?: string): string {
    const absolute = resolve(cwd, workspacePath(cwd, input));
    if (escapesRoot(this.scanner.root, absolute)) throw new Error("Search path must stay within workspace");
    const path = relative(this.scanner.root, absolute).replaceAll("\\", "/");
    return path === "." ? "" : path;
  }

  async searchSymbols(
    cwd: string,
    options: { query: string; path?: string; language?: string; kind?: string; limit?: number },
  ) {
    await this.ensureFresh();
    const query = options.query.trim();
    if (!query) throw new Error("Symbol query must contain a non-whitespace token");
    const limit = options.limit ?? DEFAULT_SYMBOL_RESULTS;
    const target = limit + 1;
    const scope = this.scopedPath(cwd, options.path);
    const { clauses: commonClauses, args: commonArgs } = workspaceScope(this.workspaceId!, scope, options.language);
    if (options.kind) {
      commonClauses.push("s.kind=?");
      commonArgs.push(options.kind);
    }
    const stages = [
      { clause: "s.name=? COLLATE NOCASE", args: [query] },
      {
        clause: "s.name LIKE ? ESCAPE '\\' COLLATE NOCASE AND s.name<>? COLLATE NOCASE",
        args: [`${escapeLike(query)}%`, query],
      },
      {
        clause: "instr(lower(s.name),lower(?))>0 AND s.name NOT LIKE ? ESCAPE '\\' COLLATE NOCASE",
        args: [query, `${escapeLike(query)}%`],
      },
    ];
    const rows: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const stage of stages) {
      if (rows.length >= target) break;
      const found = this.database()
        .prepare(
          `
        SELECT s.id,s.name,s.kind,${PROJECTED_PATH} AS path,f.language,s.line,s.column_no AS column,s.signature
        FROM symbols s JOIN files f ON f.id=s.file_id JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
        WHERE ${[...commonClauses, stage.clause].join(" AND ")}
        ORDER BY s.name COLLATE NOCASE,path,s.line LIMIT ?
      `,
        )
        .all(...commonArgs, ...stage.args, target - rows.length) as Array<Record<string, unknown>>;
      for (const row of found) {
        const key = `${row.id}\0${row.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          const { id: _id, ...displayed } = row;
          rows.push(displayed);
        }
      }
    }
    const selected = rows.slice(0, limit) as RankedRows<Record<string, unknown>>;
    if (rows.length > limit) selected.moreAvailable = true;
    return selected;
  }

  async searchCode(cwd: string, options: { query: string; path?: string; language?: string; limit?: number }) {
    await this.ensureFresh();
    const sourceQuery = options.query.trim();
    if (!sourceQuery) throw new Error("Code query must contain a non-whitespace token");
    const limit = options.limit ?? DEFAULT_CODE_RESULTS;
    const scope = this.scopedPath(cwd, options.path);
    const query = ftsQuery(sourceQuery);
    const { clauses, args } = workspaceScope(this.workspaceId!, scope, options.language);
    let statement: StatementSync;
    if (query) {
      clauses.push("code_fts MATCH ?");
      args.push(query, limit + 1);
      statement = this.database().prepare(`
        SELECT ${PROJECTED_PATH} AS path,f.language,f.content,bm25(code_fts) AS rank
        FROM code_fts JOIN files f ON f.id=code_fts.rowid JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
        WHERE ${clauses.join(" AND ")} ORDER BY rank,path LIMIT ?
      `);
    } else {
      clauses.push("instr(lower(f.content),lower(?))>0");
      args.push(sourceQuery, limit + 1);
      statement = this.database().prepare(`
        SELECT ${PROJECTED_PATH} AS path,f.language,f.content,0 AS rank
        FROM files f JOIN workspace_repositories wr ON wr.repo_id=f.repo_id
        WHERE ${clauses.join(" AND ")} ORDER BY path LIMIT ?
      `);
    }
    const rows = (
      statement.all(...args) as Array<{ path: string; language: string; content: string; rank: number }>
    ).map(({ content, ...row }) => ({ ...row, ...excerpt(content, sourceQuery) }));
    const selected = rows.slice(0, limit) as RankedRows<(typeof rows)[number]>;
    if (rows.length > limit) selected.moreAvailable = true;
    return selected;
  }

  async status() {
    await this.ready();
    return this.database()
      .prepare(
        `
      SELECT w.root,w.head,w.branch,w.indexed_at,count(DISTINCT f.id) AS files,count(DISTINCT s.id) AS symbols
      FROM workspaces w
      LEFT JOIN workspace_repositories wr ON wr.workspace_id=w.id
      LEFT JOIN files f ON f.repo_id=wr.repo_id
      LEFT JOIN symbols s ON s.file_id=f.id
      WHERE w.id=? GROUP BY w.id
    `,
      )
      .get(this.workspaceId!);
  }

  async close(): Promise<void> {
    await this.pending;
    this.db?.close();
    this.db = undefined;
  }
}

export type IndexProvider = (cwd: string) => WorkspaceIndex;
export type IndexRegistry = { indexFor: IndexProvider; closeAll(): Promise<void> };

/** One WorkspaceIndex per cwd, sharing the extension's exec adapter. */
export function createIndexRegistry(pi: ExtensionAPI): IndexRegistry {
  const indexes = new Map<string, WorkspaceIndex>();
  const indexFor = (cwd: string) => {
    let index = indexes.get(cwd);
    if (!index) {
      index = new WorkspaceIndex(cwd, async (command, args, options) => {
        const result = await pi.exec(command, args, options);
        return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      });
      indexes.set(cwd, index);
    }
    return index;
  };
  return {
    indexFor,
    async closeAll() {
      await Promise.all([...indexes.values()].map(index => index.close()));
      indexes.clear();
    },
  };
}

export function registerIndexTools(pi: ExtensionAPI, indexFor: IndexProvider, maxBytes = DEFAULT_MAX_BYTES) {
  pi.registerTool({
    name: "symbol_search",
    label: "Symbol search",
    description: `Search the local SQLite symbol index. Extraction is language-aware but heuristic. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Search indexed repository symbols by name, kind, language, or path",
    promptGuidelines: [
      "Use symbol_search for fast symbol discovery; confirm heuristic matches from source before editing.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
        path: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await indexFor(ctx.cwd).searchSymbols(ctx.cwd, params);
      const displayed = results.map(({ name, kind, path, line }) => ({ name, kind, path, line }));
      const text = structuredResults({ heuristic: true }, displayed, maxBytes, results.moreAvailable === true);
      return {
        content: [{ type: "text" as const, text }],
        details: { observed: results.length, returned: JSON.parse(text).returned ?? 0, heuristic: true },
      };
    },
  });
  pi.registerTool({
    name: "code_search",
    label: "Indexed code search",
    description: `Search indexed source using SQLite FTS5 lexical ranking. This is not embedding-based semantic search. Output capped at ${formatSize(maxBytes)}.`,
    promptSnippet: "Search the local lexical code index with ranked snippets",
    promptGuidelines: [
      "Use code_search for fast lexical discovery across indexed source; use rg when regex or current fallback search is needed.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" }),
        path: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await indexFor(ctx.cwd).searchCode(ctx.cwd, params);
      const displayed = results.map(({ path, line, text }) => ({ path, line, text }));
      const text = structuredResults({ semantic: false }, displayed, maxBytes, results.moreAvailable === true);
      return {
        content: [{ type: "text" as const, text }],
        details: { observed: results.length, returned: JSON.parse(text).returned ?? 0, semantic: false },
      };
    },
  });
  pi.registerTool({
    name: "index_status",
    label: "Index status",
    description: "Report local pi-discover SQLite index status for the current repository.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _update, ctx) {
      const status = await indexFor(ctx.cwd).status();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status) }],
        details: status as Record<string, unknown>,
      };
    },
  });
}

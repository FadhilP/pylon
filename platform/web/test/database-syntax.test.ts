import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { databaseSyntaxDiagnostics } from "../src/client/database/database-syntax.ts";
import { loadEditorLanguage, type SqlDialect } from "../src/client/rendering/editor-language.ts";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type CompletionSource } from "@codemirror/autocomplete";

const queries: Record<SqlDialect, string[]> = {
  sqlite: [
    'SELECT * FROM "users" WHERE id = ?1 AND name = :name;',
    'PRAGMA table_info("users"); SELECT 1;',
    "SELECT json_extract(value, '$.a') FROM users;",
    'WITH u AS (SELECT 1 AS id) SELECT * FROM u;',
    'INSERT INTO users(id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = excluded.id;',
    'INSERT INTO users(id) VALUES (1) RETURNING id;',
    'SELECT row_number() OVER (ORDER BY id) FROM users;',
  ],
  postgres: [
    'SELECT * FROM "users" WHERE id = $1;',
    'SELECT $tag$hello$tag$, 1::int;',
    "SELECT '{}'::jsonb ->> 'a';",
    'WITH u AS (SELECT 1 AS id) SELECT * FROM u;',
  ],
  mysql: [
    'SELECT `id` FROM `users` WHERE id = ?;',
    'SELECT 1 # comment\n;',
    'SELECT 1; SELECT 2;',
  ],
};

test("SQL diagnostics accept dialect quoting, placeholders and SQLite PRAGMA/UPSERT, but locate malformed SQL", async () => {
  for (const dialect of Object.keys(queries) as SqlDialect[]) {
    for (const query of queries[dialect]) assert.deepEqual(await databaseSyntaxDiagnostics(query, dialect), [], `${dialect}: ${query}`);
    for (const query of ["SELECT FROM", "SELECT 'unfinished", "SELECT '😀', FROM"]) {
      const diagnostics = await databaseSyntaxDiagnostics(query, dialect);
      assert.equal(diagnostics.length, 1, `${dialect}: ${query}`);
      assert.equal(diagnostics[0].severity, "warning", "advisory parsing must not imply a database execution error");
      assert.ok(diagnostics[0].from >= 0 && diagnostics[0].to <= query.length && diagnostics[0].from < diagnostics[0].to);
    }
    const language = await loadEditorLanguage("query.sql", dialect);
    const state = EditorState.create({ doc: "sel", extensions: language! });
    const results = await Promise.all(state.languageDataAt<CompletionSource>("autocomplete", 3)
      .map(source => source(new CompletionContext(state, 3, true))));
    assert.ok(results.some(result => result?.options.some(option => option.label.toLowerCase() === "select")), dialect);
  }
});

test("database worker handles SQL/JSON, bounds analysis and recovers without a database connection", { timeout: 15000 }, async () => {
  const url = new URL("../src/client/database/database-syntax.worker.ts", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    globalThis.self = globalThis;
    self.postMessage = result => parentPort.postMessage(result);
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on("message", data => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    });
  `, { eval: true });
  try {
    await once(worker, "message");
    let id = 0;
    const send = async (text: string, sqlDialect?: SqlDialect) => {
      const result = once(worker, "message");
      worker.postMessage({ id: ++id, text, sqlDialect, path: sqlDialect ? "query.sql" : "query.json", theme: "github-light", ranges: [] });
      return (await result)[0];
    };
    assert.equal((await send("SELECT FROM", "postgres")).diagnostics.length, 1);
    assert.deepEqual((await send('PRAGMA table_info("users");', "sqlite")).diagnostics, []);
    assert.equal((await send('{"query": }')).diagnostics.length, 1);
    assert.deepEqual((await send('{"query": "valid"}')).diagnostics, []);
    assert.equal((await send("x".repeat(65537), "mysql")).error, true);
    assert.deepEqual((await send("SELECT 1;", "mysql")).diagnostics, []);
  } finally { await worker.terminate(); }
});

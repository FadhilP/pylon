import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("editor assistance loads no grammar on import, and SQL lint loads only the requested dialect", () => {
  const language = new URL("../src/client/rendering/editor-language.ts", import.meta.url).href;
  const database = new URL("../src/client/database/database-syntax.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) {
      if (/^@codemirror\\/lang-|^node-sql-parser|^@appland\\/sql-parser/.test(specifier)) loaded.push(specifier);
      return next(specifier, context);
    } });
    const language = await import(${JSON.stringify(language)});
    const database = await import(${JSON.stringify(database)});
    const initial = [...loaded];
    await language.loadEditorLanguage("test.py");
    const python = [...loaded];
    await database.databaseSyntaxDiagnostics("SELECT 1;", "mysql");
    console.log(JSON.stringify({ initial, python, sql: loaded.filter(name => name.startsWith("node-sql-parser") || name.startsWith("@appland")) }));
  `], { encoding: "utf8", timeout: 15000 });
  const result = JSON.parse(output);
  assert.deepEqual(result.initial, []);
  assert.deepEqual(result.python, ["@codemirror/lang-python"]);
  assert.deepEqual(result.sql, ["node-sql-parser/build/mysql.js"]);
});

/// <reference path="./sqlite-parser.d.ts" />
import type { Diagnostic } from "@codemirror/lint";
import type { SqlDialect } from "../rendering/editor-language.ts";

type Parse = (text: string) => unknown;
// Import individual dialect builds, never the all-dialects entry point. Used only in a worker.
// The SQLite-specific parser handles PRAGMA and ?NNN parameters rejected by node-sql-parser.
const loaders: Record<SqlDialect, () => Promise<Parse>> = {
  sqlite: () => import("@appland/sql-parser").then(module => module.default),
  postgres: () => import("node-sql-parser/build/postgresql.js").then(module => {
    const parser = new module.default.Parser(); return text => parser.astify(text);
  }),
  mysql: () => import("node-sql-parser/build/mysql.js").then(module => {
    const parser = new module.default.Parser(); return text => parser.astify(text);
  }),
};
const parsers = new Map<SqlDialect, Promise<Parse>>();

export async function databaseSyntaxDiagnostics(text: string, dialect: SqlDialect): Promise<Diagnostic[]> {
  if (!text.trim()) return [];
  let loading = parsers.get(dialect);
  if (!loading) {
    loading = loaders[dialect]();
    parsers.set(dialect, loading);
    void loading.catch(() => parsers.delete(dialect));
  }
  const parser = await loading;
  try {
    parser(text);
    return [];
  } catch (error) {
    const failure = error as { message?: string; location?: { start?: { offset?: number }; end?: { offset?: number } } };
    const start = failure.location?.start?.offset;
    const end = failure.location?.end?.offset;
    if (typeof start !== "number" || !Number.isFinite(start)) throw error;
    const from = Math.max(0, Math.min(start, text.length - 1));
    const to = Math.min(text.length, Math.max(from + 1, typeof end === "number" && Number.isFinite(end) ? end : from + 1));
    return [{ from, to, severity: "warning", source: `${dialect} syntax (advisory)`,
      message: `${failure.message?.slice(0, 350) ?? "Unexpected SQL syntax."} Dialect extensions may not be recognized; this does not block execution.` }];
  }
}

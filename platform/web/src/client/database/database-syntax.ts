/// <reference path="./sqlite-parser.d.ts" />
import type { Diagnostic } from "@codemirror/lint";
import type { SqlDialect } from "../rendering/editor-language.ts";

type Parse = (text: string) => unknown;
export type DatabaseStatementMode = "read" | "write";

// Import individual dialect builds, never the all-dialects entry point. Dynamic loading keeps parser cost off startup.
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
const READ_STATEMENTS = new Set(["select", "explain", "show"]);
const WRITE_STATEMENTS = new Set(["insert", "replace", "update", "delete", "create", "alter", "drop", "truncate"]);

async function databaseParser(dialect: SqlDialect): Promise<Parse> {
  let loading = parsers.get(dialect);
  if (!loading) {
    loading = loaders[dialect]();
    parsers.set(dialect, loading);
    void loading.catch(() => parsers.delete(dialect));
  }
  return loading;
}

function statementTypes(parsed: unknown, dialect: SqlDialect): string[] {
  if (dialect === "sqlite") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const root = parsed as { variant?: unknown; statement?: unknown };
    const statements = root.variant === "list" && Array.isArray(root.statement) ? root.statement : [root];
    return statements.map(statement =>
      statement && typeof statement === "object" && typeof (statement as { variant?: unknown }).variant === "string"
        ? (statement as { variant: string }).variant.toLowerCase()
        : "",
    );
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  return statements.map(statement =>
    statement && typeof statement === "object" && typeof (statement as { type?: unknown }).type === "string"
      ? (statement as { type: string }).type.toLowerCase()
      : "",
  );
}

export async function databaseStatementMode(text: string, dialect: SqlDialect): Promise<DatabaseStatementMode> {
  const parse = await databaseParser(dialect);
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    // StateQL runs reads the parser cannot read in a read-only transaction, so it decides.
    if (/^(?:select|with|explain|show|values)\b/i.test(withoutLeadingComments(text))) return "read";
    throw error;
  }
  const types = statementTypes(parsed, dialect);
  if (types.length !== 1) throw new Error("Run exactly one SQL statement at a time.");
  const [type] = types;
  if (READ_STATEMENTS.has(type!)) return "read";
  if (WRITE_STATEMENTS.has(type!)) return "write";
  throw new Error(`Unsupported SQL statement type${type ? ` “${type}”` : ""}.`);
}

function withoutLeadingComments(text: string): string {
  return text.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
}

export async function databaseSyntaxDiagnostics(text: string, dialect: SqlDialect): Promise<Diagnostic[]> {
  if (!text.trim()) return [];
  const parser = await databaseParser(dialect);
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

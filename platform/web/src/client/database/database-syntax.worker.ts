import { treeDiagnostics } from "../rendering/syntax-diagnostics.ts";
import type { EditorAnalysisRequest, EditorAnalysisResult } from "../rendering/editor-analysis.ts";
import { databaseSyntaxDiagnostics } from "./database-syntax.ts";

// No Shiki, schema access, or database execution in the query editor's worker.
self.onmessage = async ({ data: request }: MessageEvent<EditorAnalysisRequest>) => {
  const result: EditorAnalysisResult = { id: request.id, spans: [] };
  try {
    if (request.text.length > 65536) throw new Error("Query exceeds the analysis limit.");
    result.diagnostics = request.sqlDialect
      ? await databaseSyntaxDiagnostics(request.text, request.sqlDialect)
      : treeDiagnostics(request.text, (await import("@lezer/json")).parser.parse(request.text));
  } catch {
    result.error = true;
  }
  self.postMessage(result);
};

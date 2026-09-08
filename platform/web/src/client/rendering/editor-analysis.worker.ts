import { gitGutterChanges } from "../../shared/workspace/code-viewer-model.ts";
import { MAX_EDIT_BYTES } from "../../shared/workspace/workspace-mutations.ts";
import { IncrementalSyntax } from "./incremental-syntax.ts";
import { sourceLanguage } from "./source-language.ts";
import { loadSyntaxLanguage, syntaxThemeTokenCss } from "./syntax-highlighting-runtime.ts";
import type { EditorAnalysisRequest, EditorAnalysisResult } from "./editor-analysis.ts";

let syntax = new IncrementalSyntax();
let path: string | undefined;
let comparison: { text: string; indexText?: string; changes?: ReturnType<typeof gitGutterChanges> } | undefined;
self.onmessage = async (event: MessageEvent<EditorAnalysisRequest>) => {
  const request = event.data;
  let result: EditorAnalysisResult;
  try {
    if (request.text.length > MAX_EDIT_BYTES) throw new Error("Editor analysis exceeds the file limit.");
    if (path !== request.path) { path = request.path; syntax = new IncrementalSyntax(); comparison = undefined; }
    const language = sourceLanguage(request.path);
    await loadSyntaxLanguage(language);
    const tokens = syntax.update(request.text, language, request.theme);
    if (!comparison || comparison.text !== request.text || comparison.indexText !== request.indexText) {
      comparison = { text: request.text, indexText: request.indexText, changes: gitGutterChanges(request.indexText, request.text) };
    }
    result = { id: request.id, spans: syntax.visible(request.ranges), changes: comparison.changes, css: syntaxThemeTokenCss };
  } catch {
    result = { id: request.id, spans: [], error: true };
  }
  self.postMessage(result);
};

import type { GitLineChange } from "../../shared/workspace/code-viewer-model.ts";
import type { SyntaxSpan, VisibleRange } from "./incremental-syntax.ts";
import type { SyntaxTheme } from "./syntax-highlighting.ts";

export interface EditorAnalysisInput {
  text: string;
  path: string;
  theme: SyntaxTheme;
  indexText?: string;
  ranges: readonly VisibleRange[];
}
export interface EditorAnalysisRequest extends EditorAnalysisInput { id: number }
export interface EditorAnalysisResult {
  id: number;
  spans: SyntaxSpan[];
  changes?: Map<number, GitLineChange>;
  css?: string;
  error?: boolean;
}

/** One running job and one latest replacement: no backlog, and no stale results applied. */
export class EditorAnalysisRequests {
  private nextId = 0;
  private running?: EditorAnalysisRequest;
  private pending?: EditorAnalysisRequest;
  private disposed = false;
  constructor(private send: (request: EditorAnalysisRequest) => void,
    private accept: (request: EditorAnalysisRequest, result: EditorAnalysisResult) => void) {}
  request(input: EditorAnalysisInput) {
    if (this.disposed) return;
    const request = { ...input, id: ++this.nextId };
    if (this.running) this.pending = request;
    else { this.running = request; this.send(request); }
  }
  receive(result: EditorAnalysisResult) {
    if (this.disposed || result.id !== this.running?.id) return;
    if (result.id === this.nextId) this.accept(this.running, result);
    this.running = this.pending;
    this.pending = undefined;
    if (this.running) this.send(this.running);
  }
  dispose() { this.disposed = true; this.running = this.pending = undefined; }
}

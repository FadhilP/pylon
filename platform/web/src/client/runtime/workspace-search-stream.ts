import { isWorkspaceSearchResult, type WorkspaceSearchResult } from "../../shared/workspace/workspace-search.ts";

/** Consume a bounded search stream. Leaving early must cancel the server-side process too. */
export async function readSearchStream(
  body: ReadableStream<Uint8Array>,
  generation: number,
  onUpdate?: (result: WorkspaceSearchResult) => void,
): Promise<WorkspaceSearchResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > 12 * 1024 * 1024) throw new Error("Workspace search response exceeded its limit");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as { event?: string; result?: WorkspaceSearchResult | { error?: string } };
        if (frame.event === "error")
          throw new Error((frame.result as { error?: string })?.error ?? "Workspace search failed");
        if (!isWorkspaceSearchResult(frame.result) || frame.result.sessionGeneration !== generation)
          throw new Error("Invalid or stale workspace search response");
        if (frame.event === "update") onUpdate?.(frame.result);
        else if (frame.event === "done") return frame.result;
        else throw new Error("Invalid workspace search response");
      }
    }
    throw new Error("Workspace search ended without a result");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

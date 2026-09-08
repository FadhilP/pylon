import { pathWithin, type WorkspaceEntry } from "./workspace-mutations.ts";

export interface WorkspaceDraft {
  sessionId: string;
  path: string;
  version: string;
  original: string;
  text: string;
  saving?: boolean;
}

/** Page-lifetime, memory-only drafts. Never evict unsaved text or persist it to browser storage. */
export class WorkspaceDraftStore {
  private drafts = new Map<string, WorkspaceDraft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private changed() { this.revision++; this.listeners.forEach(listener => listener()); }
  private key(sessionId: string, path: string) { return JSON.stringify([sessionId, path]); }
  get(sessionId: string, path: string) { return this.drafts.get(this.key(sessionId, path)); }
  open(entry: WorkspaceEntry) {
    if (entry.text === undefined) throw new Error(entry.readOnlyReason ?? "File is not editable.");
    const key = this.key(entry.sessionId, entry.path);
    if (this.drafts.has(key)) return; // A refresh must never rebase an existing draft.
    if (this.drafts.size >= 40) throw new Error("Close an editor before opening another (40 draft limit).");
    this.drafts.set(key, { sessionId: entry.sessionId, path: entry.path, version: entry.version, original: entry.text, text: entry.text });
    this.changed();
  }
  change(sessionId: string, path: string, text: string) {
    const key = this.key(sessionId, path);
    const draft = this.drafts.get(key);
    if (!draft || draft.saving) return;
    this.drafts.set(key, { ...draft, text });
    this.changed();
  }
  remove(sessionId: string, path: string) {
    if (this.get(sessionId, path)?.saving) throw new Error("Wait for the file save to finish.");
    this.drafts.delete(this.key(sessionId, path)); this.changed();
  }
  saving(sessionId: string, path: string, saving: boolean) {
    const draft = this.get(sessionId, path);
    if (draft) { this.drafts.set(this.key(sessionId, path), { ...draft, saving }); this.changed(); }
  }
  dirty(sessionId?: string, path?: string) {
    return [...this.drafts.values()].some(draft => (draft.saving || draft.text !== draft.original) &&
      (sessionId === undefined || draft.sessionId === sessionId) && (path === undefined || pathWithin(draft.path, path)));
  }
  removeUnder(sessionId: string, path: string) {
    if (this.dirty(sessionId, path)) throw new Error("Save or discard affected drafts first.");
    for (const [key, draft] of this.drafts) if (draft.sessionId === sessionId && pathWithin(draft.path, path)) this.drafts.delete(key);
    this.changed();
  }
}

export const workspaceDrafts = new WorkspaceDraftStore();

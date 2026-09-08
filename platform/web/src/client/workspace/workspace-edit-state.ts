import { pathWithin, type WorkspaceEntry } from "../../shared/workspace/workspace-mutations.ts";

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
  private fileListeners = new Map<string, Set<() => void>>();
  private revision = 0;
  private moveLocks = new Map<string, string[]>();
  private key(sessionId: string, path: string) { return JSON.stringify([sessionId, path]); }
  get(sessionId: string, path: string) { return this.drafts.get(this.key(sessionId, path)); }
  locked(sessionId: string, path: string) {
    return this.moveLocks.get(sessionId)?.some(parent => pathWithin(path, parent)) ?? false;
  }
  lockMoves(sessionId: string, paths: string[]): () => void {
    if (this.moveLocks.has(sessionId)) throw new Error("Wait for the current move to finish.");
    this.moveLocks.set(sessionId, paths); this.changed();
    return () => { this.moveLocks.delete(sessionId); this.changed(); };
  }
  // Workspace chrome needs dirty/saving/lock transitions, not every character.
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  subscribeFile(sessionId: string, path: string, listener: () => void) {
    const key = this.key(sessionId, path);
    let listeners = this.fileListeners.get(key);
    if (!listeners) this.fileListeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.fileListeners.delete(key); };
  }
  private changed(key?: string, chrome = true) {
    if (chrome) { this.revision++; this.listeners.forEach(listener => listener()); }
    if (key !== undefined) this.fileListeners.get(key)?.forEach(listener => listener());
    else this.fileListeners.forEach(listeners => listeners.forEach(listener => listener()));
  }
  open(entry: WorkspaceEntry, refreshClean = false) {
    if (this.locked(entry.sessionId, entry.path)) return;
    if (entry.text === undefined) throw new Error(entry.readOnlyReason ?? "File is not editable.");
    const key = this.key(entry.sessionId, entry.path);
    const existing = this.drafts.get(key);
    if (existing && (!refreshClean || existing.saving || existing.text !== existing.original)) return;
    if (existing?.version === entry.version && existing.text === entry.text) return;
    if (!existing && this.drafts.size >= 40) {
      const disposable = [...this.drafts].find(([, draft]) => !draft.saving && draft.text === draft.original);
      if (!disposable) throw new Error("Save or discard a draft before opening another (40 draft limit).");
      this.drafts.delete(disposable[0]);
      this.changed(disposable[0]);
    }
    this.drafts.set(key, { sessionId: entry.sessionId, path: entry.path, version: entry.version, original: entry.text, text: entry.text });
    this.changed(key);
  }
  change(sessionId: string, path: string, text: string) {
    const key = this.key(sessionId, path);
    const draft = this.drafts.get(key);
    if (!draft || draft.saving || this.locked(sessionId, path) || draft.text === text) return;
    this.drafts.set(key, { ...draft, text });
    this.changed(key, (draft.text !== draft.original) !== (text !== draft.original));
  }
  acceptSave(sessionId: string, path: string, savedVersion: string, submitted: WorkspaceDraft) {
    const draft = this.get(sessionId, path);
    if (!savedVersion || !draft?.saving || draft.version !== submitted.version || draft.text !== submitted.text) return;
    // Acknowledgement identifies the bytes we submitted, not a later external writer's contents.
    this.drafts.set(this.key(sessionId, path), { ...draft, version: savedVersion, original: submitted.text, saving: false });
    this.changed(this.key(sessionId, path));
  }
  remove(sessionId: string, path: string) {
    if (this.get(sessionId, path)?.saving) throw new Error("Wait for the file save to finish.");
    const key = this.key(sessionId, path);
    if (this.drafts.delete(key)) this.changed(key);
  }
  saving(sessionId: string, path: string, saving: boolean) {
    const draft = this.get(sessionId, path);
    if (draft && Boolean(draft.saving) !== saving) {
      this.drafts.set(this.key(sessionId, path), { ...draft, saving });
      this.changed(this.key(sessionId, path));
    }
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

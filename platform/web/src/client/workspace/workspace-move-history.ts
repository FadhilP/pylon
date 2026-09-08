import { pathWithin, validWorkspacePath, type WorkspaceEntry, type WorkspaceMutation } from "../../shared/workspace/workspace-mutations.ts";
import { workspaceDrafts, type WorkspaceDraftStore } from "./workspace-edit-state.ts";
import { moveWorkspaceEntry } from "./workspace-move.ts";

export interface MovePlan { path: string; destination: string; expectedVersion?: string; fingerprint?: string }
type RecordedMove = MovePlan & { fingerprint: string };
type Direction = "undo" | "redo";
type Runtime = {
  workspaceEntry(path: string, sessionId: string, generation: number, destination?: string): Promise<WorkspaceEntry>;
  mutateWorkspace(mutation: WorkspaceMutation, sessionId: string, generation: number): Promise<unknown>;
};
type Reconcile = (mutation: WorkspaceMutation, sessionId: string) => void;
export interface MoveResult { completed: number; total: number; error?: string }
const inverse = (move: RecordedMove): RecordedMove => ({ path: move.destination, destination: move.path, fingerprint: move.fingerprint });

/** In-memory, move-only history. Never reconstruct history from a changed filesystem. */
export class WorkspaceMoveHistory {
  private undoStack: RecordedMove[][] = [];
  private redoStack: RecordedMove[][] = [];
  private partial?: { direction: Direction; inverse: RecordedMove[] };
  blocked?: string;
  busy = false;
  constructor(private runtime: Runtime, private drafts: WorkspaceDraftStore = workspaceDrafts) {}
  get canUndo() { return !this.busy && !this.blocked && this.partial?.direction !== "redo" && this.undoStack.length > 0; }
  get canRedo() { return !this.busy && !this.blocked && this.partial?.direction !== "undo" && this.redoStack.length > 0; }
  get hasHistory() { return Boolean(this.undoStack.length || this.redoStack.length || this.blocked); }
  clear() {
    if (this.busy) return;
    this.undoStack = []; this.redoStack = []; this.partial = undefined; this.blocked = undefined;
  }

  private async run(plans: MovePlan[], sessionId: string, generation: number, reconcile: Reconcile) {
    const completed: RecordedMove[] = [];
    let release: (() => void) | undefined;
    let uncertain = false;
    const checkDrafts = (plan: MovePlan) => {
      if (this.drafts.dirty(sessionId, plan.path) || this.drafts.dirty(sessionId, plan.destination))
        throw new Error("Save or discard affected source and destination drafts first.");
    };
    try {
      if (!plans.length || plans.length > 100) throw new Error("Select between 1 and 100 entries per move.");
      const destinations = new Set<string>();
      for (const plan of plans) {
        if (!validWorkspacePath(plan.path) || !validWorkspacePath(plan.destination) || pathWithin(plan.destination.toLowerCase(), plan.path.toLowerCase()))
          throw new Error("Invalid move destination.");
        const destination = plan.destination.toLowerCase();
        if (destinations.has(destination)) throw new Error("Selected entries have conflicting destination names.");
        destinations.add(destination);
        if (plans.some(other => other !== plan && (pathWithin(plan.path, other.path) || pathWithin(plan.destination, other.path))))
          throw new Error("Move sources must not overlap or contain a destination.");
        checkDrafts(plan);
      }
      // Read-only server preflight catches occupied/hidden destinations and unsupported folders before any write.
      const prepared: WorkspaceEntry[] = [];
      for (const plan of plans) {
        const entry = await this.runtime.workspaceEntry(plan.path, sessionId, generation, plan.destination);
        if (entry.moveDestination !== plan.destination || !/^v1:[a-f0-9]{64}$/.test(entry.moveFingerprint ?? ""))
          throw new Error("Safe move history is unavailable; update or reload the server.");
        if ((plan.expectedVersion && entry.version !== plan.expectedVersion) || (plan.fingerprint && entry.moveFingerprint !== plan.fingerprint))
          throw new Error(`Entry changed on disk: ${plan.path}. Move history will not replace or move changed entries.`);
        prepared.push(entry);
      }
      release = this.drafts.lockMoves(sessionId, plans.flatMap(plan => [plan.path, plan.destination]));
      for (const plan of plans) checkDrafts(plan);
      for (const [index, plan] of plans.entries()) {
        const before = prepared[index];
        checkDrafts(plan);
        // A prior batch step or external writer may have changed the next source/destination.
        const current = await this.runtime.workspaceEntry(plan.path, sessionId, generation, plan.destination);
        if (current.version !== before.version || current.moveDestination !== plan.destination)
          throw new Error(`Entry changed during the operation: ${plan.path}.`);
        const mutation = { action: "move" as const, path: plan.path, destination: plan.destination, expectedVersion: current.version };
        uncertain = true;
        await moveWorkspaceEntry({ ...mutation, sessionId, generation }, this.runtime, this.drafts);
        reconcile(mutation, sessionId);
        const after = await this.runtime.workspaceEntry(plan.destination, sessionId, generation);
        if (after.moveFingerprint !== before.moveFingerprint) throw new Error("Moved entry could not be verified.");
        completed.push({ path: plan.path, destination: plan.destination, fingerprint: before.moveFingerprint! });
        uncertain = false;
      }
      return { completed };
    } catch (error) {
      if (uncertain) this.blocked = "A move has an uncertain outcome. Inspect both paths, then clear move history before continuing.";
      return { completed, error: `${completed.length} of ${plans.length} moves verified. ${(error as Error).message}${uncertain ? ` ${this.blocked}` : ""}` };
    } finally { release?.(); }
  }

  async move(plans: MovePlan[], sessionId: string, generation: number, reconcile: Reconcile): Promise<MoveResult> {
    if (this.busy || this.partial || this.blocked) return { completed: 0, total: plans.length, error: this.blocked ?? "Finish the pending history operation or clear move history first." };
    this.busy = true;
    try {
      const result = await this.run(plans, sessionId, generation, reconcile);
      if (result.completed.length || this.blocked) this.redoStack = [];
      if (result.completed.length) {
        this.undoStack.push(result.completed.slice().reverse().map(inverse));
        if (this.undoStack.length > 20) this.undoStack.shift();
      }
      return { completed: result.completed.length, total: plans.length, error: result.error };
    } finally { this.busy = false; }
  }

  async replay(direction: Direction, sessionId: string, generation: number, reconcile: Reconcile): Promise<MoveResult> {
    if (!(direction === "undo" ? this.canUndo : this.canRedo)) return { completed: 0, total: 0, error: this.blocked ?? "This history operation is unavailable." };
    const stack = direction === "undo" ? this.undoStack : this.redoStack;
    const opposite = direction === "undo" ? this.redoStack : this.undoStack;
    const plans = stack.at(-1)!;
    const total = plans.length;
    this.busy = true;
    try {
      const result = await this.run(plans, sessionId, generation, reconcile);
      if (result.completed.length) {
        this.partial ??= { direction, inverse: [] };
        this.partial.inverse.unshift(...result.completed.slice().reverse().map(inverse));
        plans.splice(0, result.completed.length);
        if (!plans.length) {
          stack.pop(); opposite.push(this.partial.inverse); this.partial = undefined;
        }
      }
      return { completed: result.completed.length, total, error: result.error };
    } finally { this.busy = false; }
  }
}

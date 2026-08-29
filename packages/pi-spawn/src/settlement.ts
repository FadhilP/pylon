import type { ChildProcess } from "node:child_process";

const SETTLEMENT_TIMEOUT_MS = 1_000;
const POST_COMPACTION_TIMEOUT_MS = 1_000;

export type SettlementHooks = {
  child: ChildProcess;
  nextCommandId: () => string;
  /** Runs once when the turn is judged complete, before the final probes are written. */
  onBegin: () => void;
  /** Runs once when every final probe has answered, failed, or timed out. */
  onFinish: () => void;
};

/**
 * Decides when a spawned child's turn is over.
 *
 * A turn settles on `agent_settled`, except while a compaction is in flight: Continuity requests a
 * hidden continuation turn immediately after `compact()` resolves, so settlement is deferred until
 * that turn either starts or fails to appear within a short grace period. Once settled, the runner
 * probes the child for its final state and cumulative stats; settlement completes when both answer
 * or the probes time out.
 */
export function createSettlement({
  child,
  nextCommandId,
  onBegin,
  onFinish,
}: SettlementHooks) {
  let settled = false;
  let finished = false;
  let activeCompactions = 0;
  let deferred = false;
  let continuationExpected = false;
  let settlementTimer: NodeJS.Timeout | undefined;
  let continuationTimer: NodeJS.Timeout | undefined;
  let finalStateCommandId: string | undefined;
  let statsCommandId: string | undefined;
  const pendingCommands = new Set<string>();

  const clearContinuationTimer = () => {
    if (continuationTimer) clearTimeout(continuationTimer);
    continuationTimer = undefined;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (settlementTimer) clearTimeout(settlementTimer);
    settlementTimer = undefined;
    clearContinuationTimer();
    onFinish();
  };
  const completeCommand = (id: string) => {
    pendingCommands.delete(id);
    if (!pendingCommands.size) finish();
  };
  const begin = () => {
    if (settled) return;
    settled = true;
    deferred = false;
    continuationExpected = false;
    clearContinuationTimer();
    onBegin();
    finalStateCommandId = nextCommandId();
    statsCommandId = nextCommandId();
    pendingCommands.add(finalStateCommandId);
    pendingCommands.add(statsCommandId);
    settlementTimer = setTimeout(finish, SETTLEMENT_TIMEOUT_MS);
    settlementTimer.unref();
    for (const command of [
      { id: finalStateCommandId, type: "get_state" },
      { id: statsCommandId, type: "get_session_stats" },
    ]) {
      try {
        child.stdin!.write(`${JSON.stringify(command)}\n`, (error) => {
          if (error) completeCommand(command.id);
        });
      } catch {
        completeCommand(command.id);
      }
    }
  };
  const awaitContinuation = () => {
    clearContinuationTimer();
    continuationTimer = setTimeout(() => {
      continuationTimer = undefined;
      if (deferred && !activeCompactions) begin();
    }, POST_COMPACTION_TIMEOUT_MS);
    continuationTimer.unref();
  };

  return {
    get settled() {
      return settled;
    },
    get finalStateCommandId() {
      return finalStateCommandId;
    },
    get statsCommandId() {
      return statsCommandId;
    },

    completeCommand,
    finish,
    clearContinuationTimer,

    compactionStarted() {
      activeCompactions++;
      clearContinuationTimer();
    },
    compactionEnded(continues: boolean) {
      activeCompactions = Math.max(0, activeCompactions - 1);
      if (activeCompactions) return;
      continuationExpected = continues;
      if (!deferred || settled) return;
      if (continuationExpected) awaitContinuation();
      else begin();
    },
    agentStarted() {
      if (settled || !(deferred || continuationExpected)) return;
      deferred = false;
      continuationExpected = false;
      clearContinuationTimer();
    },
    agentSettled() {
      if (settled) return;
      if (!activeCompactions && !continuationExpected) {
        begin();
        return;
      }
      deferred = true;
      if (!activeCompactions) awaitContinuation();
    },
  };
}

export type Settlement = ReturnType<typeof createSettlement>;

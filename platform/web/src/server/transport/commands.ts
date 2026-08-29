import type {
  AcceptedCommand,
  WebCommand,
} from "../../shared/protocol/commands.ts";

const COMMAND_TTL_MS = 15 * 60_000;
const MAX_COMMANDS = 1_000;

interface Entry {
  hash: string;
  expiresAt: number;
  result: Promise<AcceptedCommand>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

/** Generation-local idempotency, including a shared promise for concurrent POSTs. */
export class CommandIdempotency {
  private readonly entries = new Map<string, Entry>();

  execute(
    command: WebCommand,
    action: () => Promise<AcceptedCommand>,
    now = Date.now(),
  ): Promise<AcceptedCommand> {
    this.prune(now);
    // There is only one active generation; old-generation entries must not
    // consume this generation's bounded idempotency budget.
    for (const key of this.entries.keys()) {
      if (!key.startsWith(`${command.expectedGeneration}:`))
        this.entries.delete(key);
    }
    const key = `${command.expectedGeneration}:${command.commandId}`;
    const { commandId: _commandId, ...withoutId } = command;
    const hash = canonical(withoutId);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.hash !== hash) {
        const error = new Error(
          "commandId was already used with a different payload",
        );
        error.name = "IdempotencyConflictError";
        return Promise.reject(error);
      }
      return existing.result;
    }
    const result = Promise.resolve().then(action);
    this.entries.set(key, { hash, expiresAt: now + COMMAND_TTL_MS, result });
    this.trim();
    return result;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
  }

  private trim(): void {
    while (this.entries.size > MAX_COMMANDS) {
      const key = this.entries.keys().next().value as string | undefined;
      if (!key) return;
      this.entries.delete(key);
    }
  }
}

import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type WebEvent } from "../../shared/protocol/envelope.ts";

export const MAX_JOURNAL_EVENTS = 1_000;
export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024;

export interface ReplayResult {
  ok: boolean;
  events: WebEvent[];
}

/** A small, non-durable replay buffer for exactly one session generation. */
export class EventJournal {
  private entries: WebEvent[] = [];
  private readonly sizes = new WeakMap<WebEvent, number>();
  private readonly serializedEvents = new WeakMap<WebEvent, string>();
  private bytes = 0;
  private lastSequence = 0;

  constructor(
    private generation: number,
    private readonly sessionId: string,
    private readonly maxEvents = MAX_JOURNAL_EVENTS,
    private readonly maxBytes = MAX_JOURNAL_BYTES,
  ) {}

  get sessionGeneration(): number { return this.generation; }
  get sequence(): number { return this.lastSequence; }
  get oldestSequence(): number { return this.entries[0]?.sequence ?? this.lastSequence + 1; }

  replaceGeneration(generation: number, sessionId: string): EventJournal {
    return new EventJournal(generation, sessionId, this.maxEvents, this.maxBytes);
  }

  append(type: string, payload: unknown): WebEvent {
    const event: WebEvent = {
      protocolVersion: PROTOCOL_VERSION,
      payloadVersion: 1,
      eventId: randomUUID(),
      sessionId: this.sessionId,
      sessionGeneration: this.generation,
      sequence: ++this.lastSequence,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    };
    let serialized = JSON.stringify(event);
    let size = Buffer.byteLength(serialized);
    if (size > MAX_EVENT_BYTES) {
      event.type = "stream.reset-required";
      event.payload = { reason: `${type} exceeded transport limit` };
      serialized = JSON.stringify(event);
      size = Buffer.byteLength(serialized);
    }
    this.entries.push(event);
    this.sizes.set(event, size);
    this.serializedEvents.set(event, serialized);
    this.bytes += size;
    while (this.entries.length > this.maxEvents || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const removed = this.entries.shift();
      if (removed) this.bytes -= this.sizes.get(removed) ?? 0;
    }
    return event;
  }

  serialized(event: WebEvent): string {
    return this.serializedEvents.get(event) ?? JSON.stringify(event);
  }

  replay(lastEventId: string | undefined): ReplayResult {
    if (lastEventId === undefined || lastEventId === "") return { ok: true, events: [] };
    const cursor = parseCursor(lastEventId);
    if (!cursor || cursor.generation !== this.generation || cursor.sequence > this.lastSequence) {
      return { ok: false, events: [] };
    }
    // Cursor zero is valid for a newly bootstrapped, empty generation.  For a
    // retained journal the predecessor of the oldest entry is also valid.
    if (cursor.sequence < this.oldestSequence - 1) return { ok: false, events: [] };
    return { ok: true, events: this.entries.filter((entry) => entry.sequence > cursor.sequence) };
  }
}

export function eventCursor(event: Pick<WebEvent, "sessionGeneration" | "sequence">): string {
  return `${event.sessionGeneration}:${event.sequence}`;
}

export function parseCursor(value: string): { generation: number; sequence: number } | undefined {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const generation = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(sequence) || sequence < 0) return undefined;
  return { generation, sequence };
}

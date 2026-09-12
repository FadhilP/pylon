import {
  ANDROID_EVENT_MAX_BYTES,
  ANDROID_PROTOCOL_VERSION,
  type AndroidServiceEvent,
} from "../../shared/protocol/android.ts";

const MAX_EVENTS = 512;
const MAX_BYTES = ANDROID_EVENT_MAX_BYTES;

interface RetainedEvent {
  event: AndroidServiceEvent;
  bytes: number;
}

export class AndroidEventJournal {
  private retained: RetainedEvent[] = [];
  private retainedBytes = 0;
  private currentSequence = 0;

  constructor(readonly epoch: string) {}

  get sequence(): number {
    return this.currentSequence;
  }

  cursor(sequence = this.currentSequence): string {
    return `${this.epoch}:${sequence}`;
  }

  append(serviceRevision: number, payload: AndroidServiceEvent["payload"]): AndroidServiceEvent {
    const event: AndroidServiceEvent = {
      protocolVersion: ANDROID_PROTOCOL_VERSION,
      serviceEpoch: this.epoch,
      sequence: this.currentSequence + 1,
      serviceRevision,
      type: "android.snapshot",
      payload,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_BYTES) throw new Error("Android event exceeds the journal byte limit");
    this.currentSequence = event.sequence;
    this.retained.push({ event, bytes });
    this.retainedBytes += bytes;
    while (this.retained.length > MAX_EVENTS || this.retainedBytes > MAX_BYTES) {
      this.retainedBytes -= this.retained.shift()!.bytes;
    }
    return event;
  }

  replay(cursor: string | undefined): { ok: true; events: AndroidServiceEvent[] } | { ok: false } {
    if (!cursor) return { ok: false };
    const separator = cursor.lastIndexOf(":");
    if (separator < 1) return { ok: false };
    const epoch = cursor.slice(0, separator);
    const sequence = Number(cursor.slice(separator + 1));
    if (epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.currentSequence) {
      return { ok: false };
    }
    const oldest = this.retained[0]?.event.sequence ?? this.currentSequence + 1;
    if (sequence < oldest - 1) return { ok: false };
    return { ok: true, events: this.retained.filter(item => item.event.sequence > sequence).map(item => item.event) };
  }
}

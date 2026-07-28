export const PROTOCOL_VERSION = 21 as const;

export interface WebEvent<T = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  payloadVersion: number;
  eventId: string;
  sessionId: string;
  sessionGeneration: number;
  sequence: number;
  occurredAt: string;
  type: string;
  payload: T;
}

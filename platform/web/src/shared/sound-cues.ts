export type WebAudioCueKind = "turn-complete" | "attention";
export interface WebAudioCue { id: string; kind: WebAudioCueKind; }
export interface SoundTone { frequency: number; offset: number; duration: number; }

const MAX_AUDIO_CUES = 20;
const patterns: Record<WebAudioCueKind, readonly SoundTone[]> = {
  "turn-complete": [
    { frequency: 523.25, offset: 0, duration: .09 },
    { frequency: 659.25, offset: .1, duration: .14 },
  ],
  attention: [
    { frequency: 659.25, offset: 0, duration: .08 },
    { frequency: 659.25, offset: .14, duration: .08 },
    { frequency: 523.25, offset: .28, duration: .12 },
  ],
};

export function soundPattern(kind: WebAudioCueKind): readonly SoundTone[] {
  return patterns[kind];
}

export function appendWebAudioCue(
  cues: WebAudioCue[],
  event: { eventId: string; sessionId: string; type: string; payload: unknown },
): WebAudioCue[] {
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const statusCue = event.type === "session.status" ? payload.cue : undefined;
  const attention = event.type === "ui.request" || statusCue === "attention";
  const completed = (event.type === "agent.end" && payload.stopped !== true && payload.willRetry !== true)
    || statusCue === "turn-complete";
  const kind: WebAudioCueKind | undefined = attention
    ? "attention"
    : completed ? "turn-complete" : undefined;
  return kind ? [...cues, { id: event.eventId, kind }].slice(-MAX_AUDIO_CUES) : cues;
}

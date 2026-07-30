import { soundPattern, type WebAudioCueKind } from "../shared/sound-cues";

const pending: WebAudioCueKind[] = [];
let context: AudioContext | undefined;
let resuming = false;
let unavailable = false;
let nextStartAt = 0;

export function unlockWebAudio(): void {
  if (unavailable) return;
  if (!context) {
    const AudioContextConstructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      unavailable = true;
      return;
    }
    try { context = new AudioContextConstructor(); }
    catch { unavailable = true; return; }
  }
  flush();
}

export function enqueueWebAudioCues(cues: readonly WebAudioCueKind[]): void {
  pending.push(...cues);
  if (pending.length > 20) pending.splice(0, pending.length - 20);
  flush();
}

function flush(): void {
  if (!context) return;
  if (context.state !== "running") {
    if (resuming) return;
    resuming = true;
    void context.resume().then(() => {
      resuming = false;
      flush();
    }).catch(() => { resuming = false; });
    return;
  }
  while (pending.length) schedule(context, pending.shift()!);
}

function schedule(audio: AudioContext, kind: WebAudioCueKind): void {
  const pattern = soundPattern(kind);
  const start = Math.max(audio.currentTime + .02, nextStartAt);
  for (const tone of pattern) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const toneStart = start + tone.offset;
    const toneEnd = toneStart + tone.duration;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
    gain.gain.setValueAtTime(.0001, toneStart);
    gain.gain.exponentialRampToValueAtTime(.3, toneStart + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, toneEnd);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(toneStart);
    oscillator.stop(toneEnd + .01);
  }
  nextStartAt = start + Math.max(...pattern.map((tone) => tone.offset + tone.duration)) + .08;
}

import { soundPattern, type WebAudioCueKind } from "../shared/sound-cues";

const pending: WebAudioCueKind[] = [];
let context: AudioContext | undefined;
let resuming = false;
let nextStartAt = 0;

export function unlockWebAudio(): void {
  if (context?.state === "closed") resetContext(context);
  if (!context) {
    const AudioContextConstructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    try { context = new AudioContextConstructor(); }
    catch { return; }
  }
  flush();
}

export function enqueueWebAudioCues(cues: readonly WebAudioCueKind[]): void {
  pending.push(...cues);
  if (pending.length > 20) pending.splice(0, pending.length - 20);
  flush();
}

function flush(): void {
  const audio = context;
  if (!audio) return;
  if (audio.state === "closed") {
    resetContext(audio);
    return;
  }
  if (audio.state !== "running") {
    if (resuming) return;
    resuming = true;
    void audio.resume().then(() => {
      if (context !== audio) return;
      resuming = false;
      if (audio.state === "running") flush();
    }).catch(() => {
      if (context !== audio) return;
      resuming = false;
      if (audio.state === "closed") resetContext(audio);
    });
    return;
  }
  while (pending.length) {
    try { schedule(audio, pending[0]!); }
    catch {
      return;
    }
    pending.shift();
  }
}

function resetContext(audio: AudioContext): void {
  if (context !== audio) return;
  context = undefined;
  resuming = false;
  nextStartAt = 0;
}

function schedule(audio: AudioContext, kind: WebAudioCueKind): void {
  const pattern = soundPattern(kind);
  const start = Math.max(audio.currentTime + .02, nextStartAt);
  const nodes: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  try {
    for (const tone of pattern) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      nodes.push({ oscillator, gain });
      const toneStart = start + tone.offset;
      const toneEnd = toneStart + tone.duration;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      gain.gain.setValueAtTime(.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(.3, toneStart + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, toneEnd);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + .01);
    }
  } catch (error) {
    for (const { oscillator, gain } of nodes) {
      oscillator.disconnect();
      gain.disconnect();
    }
    throw error;
  }
  nextStartAt = start + Math.max(...pattern.map((tone) => tone.offset + tone.duration)) + .08;
}

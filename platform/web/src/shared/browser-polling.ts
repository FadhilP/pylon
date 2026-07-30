export const ACTIVE_FRAME_INTERVAL_MS = 250;
export const IDLE_FRAME_INTERVAL_MS = 1_000;
export const ACTIVE_FRAME_WINDOW_MS = 2_000;
export const METADATA_INTERVAL_MS = 2_000;

export function framePollingDelay(now: number, activeUntil: number): number {
  return now < activeUntil ? ACTIVE_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS;
}

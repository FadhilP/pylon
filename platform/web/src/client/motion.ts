/**
 * How long to keep an element mounted after its exit animation starts.
 * Reduced motion skips the animation, so waiting for it would just be dead
 * time before the element disappears.
 */
export function exitDelay(ms: number): number {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}

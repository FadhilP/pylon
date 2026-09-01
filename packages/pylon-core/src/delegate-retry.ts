import { effectiveConfig, loadConfig } from "./config.ts";

export const DELEGATE_MAX_ATTEMPTS = 3;
export type DelegateRetryPolicy = { maxAttempts: number; baseMs: number };

/** Read once at each delegate operation; the low-level wait loop never reads disk. */
export async function loadDelegateRetryPolicy(): Promise<DelegateRetryPolicy> {
  const config = effectiveConfig(await loadConfig());
  return { maxAttempts: config.delegateMaxAttempts, baseMs: config.delegateRetryBaseMs };
}

// Kept deliberately broad: all delegated callers share Advisor's provider wording.
const TERMINAL_PROVIDER_FAILURE =
  /\b(?:401|403)\b|unauthori[sz]ed|forbidden|credential|api[_ -]?key|authentication|permission denied|usage limit|insufficient quota|billing|aborted|cancelled|timed? ?out|timeout|context|budget/i;
const TRANSIENT_PROVIDER_FAILURE =
  /\b429\b|rate.?limit|capacity|overload|temporar(?:y|ily)|service unavailable|server (?:error|busy)|\b50[0234]\b|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket (?:closed|hang up)|connection (?:closed|reset)|fetch failed|websocket.?error|you can retry your request|try your request again|please retry your request/i;

export function isTransientProviderFailure(value: unknown): boolean {
  const message = String((value as any)?.message ?? value ?? "");
  return !TERMINAL_PROVIDER_FAILURE.test(message) && TRANSIENT_PROVIDER_FAILURE.test(message);
}

export async function waitForDelegateRetry(
  retryNumber: number,
  signal?: AbortSignal,
  baseMs = 1_000,
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise(resolve => {
    const timeout = setTimeout(done, baseMs * 2 ** (retryNumber - 1));
    const abort = () => done();
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(!signal?.aborted);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) done();
  });
}

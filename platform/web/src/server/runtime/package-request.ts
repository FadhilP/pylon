import type { EventBusController } from "@earendil-works/pi-coding-agent";

/**
 * A claim/respond request to whichever package handles `channel`. The first package to respond
 * answers it. Throws `unavailable` when no package responds synchronously. The caller must call
 * `close()` when done; it also aborts the request signal the package received.
 */
export function packageRequest(
  eventBus: EventBusController,
  channel: string,
  payload: Record<string, unknown>,
  { unavailable, signal }: { unavailable: string; signal?: AbortSignal },
) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let response: Promise<unknown> | undefined;
  let claimed = false;
  eventBus.emit(channel, {
    ...payload,
    signal: controller.signal,
    claim: () => (claimed ? false : (claimed = true)),
    respond: (value: unknown) => {
      response ??= Promise.resolve(value);
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timeout);
    controller.abort();
    signal?.removeEventListener("abort", abort);
  };
  if (!response) {
    close();
    throw new Error(unavailable);
  }
  const answer = response;

  return {
    signal: controller.signal,
    close,
    /** The package's answer, with no timeout. */
    answer,
    /** The package's answer; rejects with `timedOut` once `timeoutMs` passes or the caller aborts. */
    result(timeoutMs: number, timedOut: string): Promise<unknown> {
      timeout = setTimeout(abort, timeoutMs);
      timeout.unref?.();
      return Promise.race([
        answer,
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error(timedOut)), { once: true }),
        ),
      ]);
    },
  };
}

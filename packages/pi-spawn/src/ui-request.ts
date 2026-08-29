import type { SpawnUiRequest, SpawnUiResponse } from "./runner.ts";

const MAX_TITLE = 4_000;
const MAX_TEXT = 64 * 1024;
const MAX_OPTIONS = 50;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

export const boundedString = (
  value: unknown,
  maximum: number,
): string | undefined =>
  typeof value === "string" && value.length <= maximum ? value : undefined;

/** Absent is valid; present-but-invalid rejects the whole request. */
const optionalString = (
  value: unknown,
  maximum: number,
): { ok: boolean; value?: string } =>
  value === undefined
    ? { ok: true }
    : {
        ok: boundedString(value, maximum) !== undefined,
        value: value as string,
      };

type Base = { id: string; title: string; timeout?: number };

const parsers: Record<
  string,
  (event: any, base: Base) => SpawnUiRequest | undefined
> = {
  select: (event, base) => {
    if (
      !Array.isArray(event.options) ||
      event.options.length > MAX_OPTIONS ||
      event.options.some(
        (item: unknown) => boundedString(item, MAX_TITLE) === undefined,
      )
    )
      return;
    return { ...base, method: "select", options: event.options };
  },
  confirm: (event, base) => {
    const message = boundedString(event.message, MAX_TITLE);
    return message === undefined
      ? undefined
      : { ...base, method: "confirm", message };
  },
  input: (event, base) => {
    const placeholder = optionalString(event.placeholder, MAX_TEXT);
    if (!placeholder.ok) return;
    return {
      ...base,
      method: "input",
      ...(placeholder.value !== undefined
        ? { placeholder: placeholder.value }
        : {}),
    };
  },
  editor: (event, base) => {
    const prefill = optionalString(event.prefill, MAX_TEXT);
    if (!prefill.ok) return;
    return {
      ...base,
      method: "editor",
      ...(prefill.value !== undefined ? { prefill: prefill.value } : {}),
    };
  },
};

const boundedTimeout = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_TIMEOUT_MS
    ? (value as number)
    : undefined;

/** Parses one `extension_ui_request` line from a spawned child, or returns undefined to deny it. */
export function parseUiRequest(event: any): SpawnUiRequest | undefined {
  const id = boundedString(event?.id, 128);
  const title = boundedString(event?.title, MAX_TITLE);
  const method = String(event?.method ?? "");
  const timeout =
    event?.timeout === undefined ? undefined : boundedTimeout(event.timeout);
  if (!id || !title || !dialogMethods.has(method)) return;
  if (event?.timeout !== undefined && timeout === undefined) return;
  return parsers[method](event, {
    id,
    title,
    ...(timeout !== undefined ? { timeout } : {}),
  });
}

export const deniedUiResponse = (method: string): SpawnUiResponse =>
  method === "confirm" ? { confirmed: false } : { cancelled: true };

/** Coerces a host's dialog answer into a response the child will accept. */
export function validUiResponse(
  request: SpawnUiRequest,
  response: SpawnUiResponse,
): SpawnUiResponse {
  if (request.method === "confirm")
    return {
      confirmed:
        "confirmed" in response && typeof response.confirmed === "boolean"
          ? response.confirmed
          : false,
    };
  const valid =
    "value" in response &&
    typeof response.value === "string" &&
    response.value.length <= MAX_TEXT &&
    (request.method !== "select" || request.options.includes(response.value));
  return valid
    ? { value: (response as { value: string }).value }
    : { cancelled: true };
}

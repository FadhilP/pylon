/**
 * Credential scrubbing for anything a delegated child agent hands back — failure
 * messages, parent context, worker reports. Shared so every package redacts to the
 * same standard; a weaker copy in one package is a leak the others would have caught.
 */

/** Shapes that are credentials by construction. Cheap to match, effectively no false positives. */
const PROVIDER_PATTERNS: RegExp[] = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
  /\b(?:sk-ant-|sk-proj-|sk-|pk-|ghp_|github_pat_|glpat-|AIza|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+|(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+)/gi,
];

/**
 * Any long opaque token. This catches unlabelled secrets no provider rule knows about,
 * but it also matches legitimate long identifiers — commit hashes, base64 blobs, digests.
 * Correct for short diagnostics; destructive for prose a child model has to reason about.
 */
const BROAD_TOKEN_PATTERN = /\b[A-Za-z0-9+/=_-]{40,}\b/g;

export const REDACTION_MARKER = "[possible credential redacted]";
const FAILURE_MESSAGE_MAX_LENGTH = 500;

/**
 * Replaces every credential-shaped run with the marker; `count` is how many were replaced.
 *
 * `broadTokens` (default true) also scrubs any long opaque token. Turn it off for text
 * whose usefulness depends on long identifiers surviving — see BROAD_TOKEN_PATTERN.
 */
export function redact(text: string, options: { broadTokens?: boolean } = {}): { text: string; count: number } {
  const patterns = options.broadTokens === false ? PROVIDER_PATTERNS : [...PROVIDER_PATTERNS, BROAD_TOKEN_PATTERN];
  // A private sentinel keeps the marker itself from being re-matched by a later pattern.
  const sentinel = "\uE000";
  let count = 0;
  let output = text;
  for (const pattern of patterns)
    output = output.replace(pattern, () => {
      count++;
      return sentinel;
    });
  return { text: output.replaceAll(sentinel, REDACTION_MARKER), count };
}

/** Redacts, flattens control characters, and bounds an error for display to a model or user. */
export function sanitizeFailureMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  const clean =
    redact(message)
      .text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .trim() || fallback;
  return clean.length > FAILURE_MESSAGE_MAX_LENGTH ? `${clean.slice(0, FAILURE_MESSAGE_MAX_LENGTH - 3)}...` : clean;
}

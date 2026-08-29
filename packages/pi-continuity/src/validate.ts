/**
 * Structural-validation primitives shared by every persisted Continuity file.
 *
 * Each helper is deliberately narrow so call sites read as a specification of the
 * stored shape rather than a chain of `typeof` checks. Semantics differ subtly
 * between the string helpers; pick the one whose doc comment matches the field.
 */

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/;
export const COMMIT = /^[0-9a-f]{40,64}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
export const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);
export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && COMMIT.test(value);

/** Any parseable date string. */
export const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** A safe integer at or above `minimum` (0 by default). */
export const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;

/** Non-empty once trimmed, and at most `max` characters after trimming. */
export const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= max;

/** A string of at most `max` characters; empty is allowed. */
export const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/** A string of one to `max` characters, counted without trimming. */
export const filledString = (value: unknown, max: number): value is string =>
  boundedString(value, max) && value.length > 0;

/** Relative, traversal-free, and not a Windows drive or POSIX absolute path. */
export const safeRelativePath = (value: unknown): value is string =>
  filledString(value, 240) &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[a-z]:/i.test(value) &&
  !value.split(/[\\/]+/).some((part) => !part || part === "." || part === "..");

/** A plain object carrying no keys outside `allowed`; unknown keys fail closed. */
export const exactKeys = (value: any, allowed: readonly string[]): boolean =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

/** An array of at most `max` items, every one satisfying `item`. */
export const boundedArray = (
  value: unknown,
  max: number,
  item: (entry: any) => boolean,
): boolean => Array.isArray(value) && value.length <= max && value.every(item);

/** An array of at most `maxItems` non-empty strings, each at most `maxLength` characters. */
export const stringList = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): boolean =>
  boundedArray(value, maxItems, (item) => filledString(item, maxLength));

/** Builds a membership predicate over a fixed set of literal values. */
export const oneOf = <T extends string>(...allowed: T[]) => {
  const set = new Set<string>(allowed);
  return (value: unknown): value is T =>
    typeof value === "string" && set.has(value);
};

/** `undefined`, or a value satisfying `check` — the shape every optional field takes. */
export const optional = <T>(
  value: unknown,
  check: (entry: any) => boolean,
): value is T | undefined => value === undefined || check(value);

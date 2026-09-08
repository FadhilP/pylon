import { sourceLines } from "./code-viewer-model.ts";

export const MAX_ANNOTATIONS = 200;
export const MAX_NOTE_BYTES = 4096;
export const MAX_EXCERPT_BYTES = 24 * 1024;
export const MAX_ANNOTATION_PROMPT_BYTES = 64 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export interface AnnotationSource {
  kind: "current" | "historical";
  revision: string;
}
export interface AnnotationAnchor extends AnnotationSource {
  path: string;
  from: number;
  to: number;
  code: string;
  /** Hash of the exact full source supplying the selection, when available. */
  hash?: string;
}
export interface Annotation extends AnnotationAnchor {
  id: string;
  scope: string;
  version: number;
  body: string;
}
export interface AnnotationRequest {
  sessionId: string;
  expectedGeneration: number;
}
export interface AnnotationMutation extends AnnotationRequest {
  id: string;
  expectedVersion?: number;
  note?: Annotation;
}
export interface AnnotationList {
  sessionId: string;
  sessionGeneration: number;
  scope: string;
  notes: Annotation[];
}
export function validAnnotationMutation(value: unknown): value is AnnotationMutation {
  if (!value || typeof value !== "object") return false;
  const item = value as AnnotationMutation;
  return (
    typeof item.sessionId === "string" &&
    item.sessionId.length > 0 &&
    item.sessionId.length <= 200 &&
    Number.isSafeInteger(item.expectedGeneration) &&
    item.expectedGeneration > 0 &&
    typeof item.id === "string" &&
    /^[a-f0-9-]{36}$/.test(item.id) &&
    (item.expectedVersion === undefined || (Number.isSafeInteger(item.expectedVersion) && item.expectedVersion > 0)) &&
    (item.note === undefined
      ? item.expectedVersion !== undefined
      : validAnnotation(item.note) && item.note.id === item.id && item.note.version === (item.expectedVersion ?? 0) + 1)
  );
}
export function annotationPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1000 &&
    !/^[\\/]|^[A-Za-z]:|[\x00-\x1f\x7f]/.test(path) &&
    !path
      .replaceAll("\\", "/")
      .split("/")
      .some(part => !part || part === "." || part === "..")
  );
}
export function validAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  if (
    Object.keys(value).some(
      key =>
        !["id", "scope", "version", "body", "path", "from", "to", "code", "kind", "revision", "hash"].includes(key),
    )
  )
    return false;
  const n = value as Annotation;
  return (
    typeof n.id === "string" &&
    /^[a-f0-9-]{36}$/.test(n.id) &&
    typeof n.scope === "string" &&
    n.scope.length > 0 &&
    n.scope.length <= 5000 &&
    Number.isSafeInteger(n.version) &&
    n.version > 0 &&
    annotationPath(n.path) &&
    (n.kind === "current" || n.kind === "historical") &&
    typeof n.revision === "string" &&
    n.revision.length > 0 &&
    n.revision.length <= 1000 &&
    Number.isSafeInteger(n.from) &&
    Number.isSafeInteger(n.to) &&
    n.from > 0 &&
    n.to >= n.from &&
    n.to <= 1_000_000 &&
    typeof n.body === "string" &&
    Boolean(n.body.trim()) &&
    bytes(n.body) <= MAX_NOTE_BYTES &&
    typeof n.code === "string" &&
    bytes(n.code) <= MAX_EXCERPT_BYTES &&
    n.code.split("\n").length === n.to - n.from + 1 &&
    (n.hash === undefined || /^[a-f0-9]{64}$/.test(n.hash))
  );
}

/** Render indices are transient. Only contiguous new-side source coordinates may be saved. */
export function annotationRange(
  rows: readonly { file: number; kind: string; newLine?: number; text?: string }[],
  start: number,
  end: number,
): { file: number; from: number; to: number; code: string } | undefined {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    Math.min(start, end) < 0 ||
    Math.max(start, end) >= rows.length
  )
    return;
  const selected = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
  if (
    !selected.length ||
    selected.some(row => row.file !== selected[0].file || row.kind === "gap" || row.kind === "header")
  )
    return;
  const lines = selected.filter(row => row.newLine !== undefined && row.kind !== "deletion");
  if (!lines.length || lines.some((line, index) => line.newLine !== lines[0].newLine! + index)) return;
  const code = lines.map(line => line.text ?? "").join("\n");
  if (bytes(code) > MAX_EXCERPT_BYTES) return;
  return { file: selected[0].file, from: lines[0].newLine!, to: lines.at(-1)!.newLine!, code };
}
export async function sourceHash(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function captureAnnotation(
  range: { from: number; to: number; code: string },
  path: string,
  source: AnnotationSource,
  fullText?: string,
): Promise<AnnotationAnchor> {
  if (!annotationPath(path)) throw new Error("This file path cannot be annotated.");
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 1 ||
    range.to < range.from ||
    bytes(range.code) > MAX_EXCERPT_BYTES
  )
    throw new Error("Invalid annotation range.");
  if (fullText !== undefined) {
    const lines = sourceLines(fullText);
    if (range.to > lines.length || lines.slice(range.from - 1, range.to).join("\n") !== range.code)
      throw new Error("Source changed while selecting lines. Reload and select again.");
  }
  if (source.kind === "current" && fullText === undefined)
    throw new Error("Full source is needed to annotate the working copy.");
  return {
    path,
    from: range.from,
    to: range.to,
    code: range.code,
    ...source,
    ...(fullText !== undefined ? { hash: await sourceHash(fullText) } : {}),
  };
}
export type AnnotationReview = "current" | "changed" | "unavailable" | "historical";
export interface ReviewedAnnotation {
  note: Annotation;
  state: AnnotationReview;
}
/** One authorized source read per file; never replace captured code with a later read. */
export async function reviewAnnotations(
  notes: readonly Annotation[],
  read: (path: string) => Promise<string | undefined>,
): Promise<ReviewedAnnotation[]> {
  const hashes = new Map<string, string | undefined>();
  for (const note of notes) {
    if (note.kind !== "current" || hashes.has(note.path)) continue;
    try {
      const text = await read(note.path);
      hashes.set(note.path, text === undefined ? undefined : await sourceHash(text));
    } catch {
      hashes.set(note.path, undefined);
    }
  }
  return notes.map(note => ({
    note,
    state:
      note.kind === "historical"
        ? "historical"
        : !hashes.get(note.path) || !note.hash
          ? "unavailable"
          : hashes.get(note.path) === note.hash
            ? "current"
            : "changed",
  }));
}
function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
}
/** This is ordinary visible user text, not a hidden attachment or executable slash command. */
export function annotationPrompt(message: string, reviewed: readonly ReviewedAnnotation[]): string {
  if (!reviewed.length) return message;
  const sections = reviewed.map(({ note, state }, index) => {
    if (!validAnnotation(note)) throw new Error("Invalid annotation; review your saved notes.");
    return `### Note ${index + 1}\nFile: ${JSON.stringify(note.path)}\nLines: ${note.from}-${note.to}\nSource: ${JSON.stringify(note.revision)} (${note.kind}; ${state})\n\nNote text:\n${fenced(note.body)}\n\nCaptured code:\n${fenced(note.code)}`;
  });
  const prompt = `Code review notes\n\n${message.trim() ? `${message.trim()}\n\n` : ""}These are captured source excerpts, not necessarily the working copy at execution time.\n\n${sections.join("\n\n")}`;
  if (bytes(prompt) > MAX_ANNOTATION_PROMPT_BYTES)
    throw new Error("Message and notes exceed 64 KiB. Send fewer notes or a shorter message.");
  return prompt;
}

/** Only the newest read may update the UI, including reads following out-of-order mutations. */
export class AnnotationReads {
  private sequence = 0;
  invalidate(): void {
    this.sequence++;
  }
  async read(
    load: () => Promise<AnnotationList>,
    apply: (list: AnnotationList) => void,
    fail: (error: unknown) => void,
  ): Promise<AnnotationList | undefined> {
    const sequence = ++this.sequence;
    try {
      const list = await load();
      if (sequence === this.sequence) apply(list);
      return list;
    } catch (error) {
      if (sequence === this.sequence) fail(error);
      return undefined;
    }
  }
}
/** Reconcile an ambiguous save against durable data without duplicating or overwriting a note. */
export async function persistAnnotation(
  note: Annotation | undefined,
  id: string,
  mutate: () => Promise<unknown>,
  reload: () => Promise<AnnotationList | undefined>,
  assertCurrent: () => void,
): Promise<void> {
  let failure: unknown;
  try {
    await mutate();
  } catch (error) {
    failure = error;
  }
  assertCurrent(); // An old session must not invalidate a newer session's pending read.
  const latest = await reload();
  assertCurrent();
  if (!latest) throw failure ?? new Error("Unable to confirm the saved note. Refresh notes before retrying.");
  if (failure) {
    const saved = latest.notes.find(item => item.id === id);
    const identical = note
      ? saved && Object.keys(note).every(key => note[key as keyof Annotation] === saved[key as keyof Annotation])
      : !saved;
    if (!identical) throw failure;
  }
}

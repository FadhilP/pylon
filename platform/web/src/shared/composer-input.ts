export function loginCommandProvider(value: string): string | undefined | null {
  const match = /^\/login(?:\s+(.+?))?\s*$/i.exec(value.trim());
  return match ? match[1]?.trim() || undefined : null;
}

export const WORKSPACE_FILE_DRAG_TYPE = "application/x-pylon-workspace-file";

export interface FileMention {
  start: number;
  end: number;
  query: string;
}

export function fileMentionAtCaret(value: string, caret: number): FileMention | undefined {
  const beforeCaret = value.slice(0, Math.max(0, caret));
  const match = /(^|[^A-Za-z0-9_])@(?:"([^"]*)|([^\s"]*))$/.exec(beforeCaret);
  if (!match) return undefined;
  const token = match[0].slice(match[1]?.length ?? 0);
  return { start: beforeCaret.length - token.length, end: beforeCaret.length, query: match[2] ?? match[3] ?? "" };
}

function fileMention(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export function replaceFileMention(
  value: string,
  mention: FileMention,
  path: string,
): { value: string; caret: number } {
  const replacement = fileMention(path);
  const next = `${value.slice(0, mention.start)}${replacement}${value.slice(mention.end)}`;
  return { value: next, caret: mention.start + replacement.length };
}

export function insertFileMention(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  path: string,
): { value: string; caret: number } {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const replacement = fileMention(path);
  return {
    value: `${before}${prefix}${replacement}${suffix}${after}`,
    caret: before.length + prefix.length + replacement.length,
  };
}

export function isNearTranscriptBottom(
  scroller: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 48,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

export function scrollTopAfterPrepend(
  scroller: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
  previousScrollHeight: number,
): number {
  return scroller.scrollTop + scroller.scrollHeight - previousScrollHeight;
}

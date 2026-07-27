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
  return {
    start: beforeCaret.length - token.length,
    end: beforeCaret.length,
    query: match[2] ?? match[3] ?? "",
  };
}

export function replaceFileMention(
  value: string,
  mention: FileMention,
  path: string,
): { value: string; caret: number } {
  const replacement = path.includes(" ") ? `@"${path}"` : `@${path}`;
  const next = `${value.slice(0, mention.start)}${replacement}${value.slice(mention.end)}`;
  return { value: next, caret: mention.start + replacement.length };
}

export function isNearTranscriptBottom(
  scroller: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 48,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

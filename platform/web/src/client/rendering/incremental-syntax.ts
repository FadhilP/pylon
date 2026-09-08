import { splitLines } from "shiki/core";
import type { GrammarState } from "shiki";
import { syntaxLine } from "./syntax-highlighting-runtime.ts";
import type { SyntaxTheme, SyntaxToken } from "./syntax-highlighting.ts";

/** The only dependency on Shiki internals. Unknown state is never proof of convergence. */
export function sameGrammarState(left?: GrammarState, right?: GrammarState): boolean {
  if (!left || !right || left.lang !== right.lang || left.theme !== right.theme) return false;
  try {
    const a = left.getInternalStack?.(left.theme);
    const b = right.getInternalStack?.(right.theme);
    return Boolean(a && b && typeof a.equals === "function" && a.equals(b));
  } catch { return false; }
}

/** One worker-owned document. Grammar states never cross the structured-clone boundary. */
export class IncrementalSyntax {
  private language = "";
  private theme?: SyntaxTheme;
  private lines: string[] = [];
  private starts: number[] = [];
  private states: (GrammarState | undefined)[] = [];
  private tokens: SyntaxToken[][] = [];
  constructor(private tokenize = syntaxLine, private equal = sameGrammarState) {}

  update(text: string, language: string, theme: SyntaxTheme): SyntaxToken[][] {
    // Viewport requests commonly repeat the same document. Keeping the split
    // offsets alongside its grammar state avoids both splitting and retokenizing.
    if (text === this.text && language === this.language && theme === this.theme) return this.tokens;
    const split = splitLines(text);
    const lines = split.map(([line]) => line);
    const starts = split.map(([, start]) => start);
    const reusable = language === this.language && theme === this.theme;
    const old = reusable ? this.lines : [];
    let prefix = 0;
    while (prefix < Math.min(lines.length, old.length) && lines[prefix] === old[prefix]) prefix++;
    let suffix = 0;
    while (suffix < Math.min(lines.length, old.length) - prefix && lines[lines.length - 1 - suffix] === old[old.length - 1 - suffix]) suffix++;
    let tokens = reusable ? this.tokens.slice(0, prefix) : [];
    let states = reusable ? this.states.slice(0, prefix) : [];
    let state = states.at(-1);
    for (let line = prefix; line < lines.length; line++) {
      const next = this.tokenize(lines[line], language, theme, state);
      tokens.push(next.tokens);
      states.push(state = next.state);
      const previous = line + old.length - lines.length;
      if (suffix && line >= lines.length - suffix - 1 && previous >= 0 && this.equal(state, this.states[previous])) {
        tokens = tokens.concat(this.tokens.slice(previous + 1));
        states = states.concat(this.states.slice(previous + 1));
        break;
      }
    }
    this.text = text;
    this.lines = lines;
    this.starts = starts;
    this.language = language;
    this.theme = theme;
    this.tokens = tokens;
    this.states = states;
    return tokens;
  }

  private text = "\0";

  /** Extract viewport spans without resplitting or scanning unrelated lines. */
  visible(ranges: readonly VisibleRange[]): SyntaxSpan[] {
    return visibleSyntaxLines(this.lines, this.starts, this.tokens, ranges);
  }
}

export interface SyntaxSpan { from: number; to: number; className: string }
export interface VisibleRange { from: number; to: number }

function visibleSyntaxLines(lines: readonly string[], starts: readonly number[], tokens: SyntaxToken[][], ranges: readonly VisibleRange[]): SyntaxSpan[] {
  if (!ranges.length) return [];
  const relevant = new Map<number, VisibleRange[]>();
  const after = (position: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  for (const range of ranges) {
    // Only the line containing the range start can begin before it.
    for (let index = Math.max(0, after(range.from) - 1); index < lines.length && starts[index] < range.to; index++) {
      if (range.from >= starts[index] + lines[index].length) continue;
      const visible = relevant.get(index);
      if (visible) visible.push(range);
      else relevant.set(index, [range]);
    }
  }
  const result: SyntaxSpan[] = [];
  for (const [index, visible] of [...relevant].sort(([left], [right]) => left - right)) {
    let offset = starts[index];
    for (const token of tokens[index] ?? []) {
      const end = offset + token.content.length;
      if (token.className) for (const range of visible) {
        const from = Math.max(range.from, offset);
        const to = Math.min(range.to, end);
        if (from < to) result.push({ from, to, className: token.className });
      }
      offset = end;
    }
  }
  return result;
}

/** Only visible spans cross to the UI, including horizontal windows of very long lines. */
export function visibleSyntax(text: string, tokens: SyntaxToken[][], ranges: readonly VisibleRange[]): SyntaxSpan[] {
  const split = splitLines(text);
  return visibleSyntaxLines(split.map(([line]) => line), split.map(([, start]) => start), tokens, ranges);
}

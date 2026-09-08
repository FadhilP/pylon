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
  private states: (GrammarState | undefined)[] = [];
  private tokens: SyntaxToken[][] = [];
  constructor(private tokenize = syntaxLine, private equal = sameGrammarState) {}

  update(text: string, language: string, theme: SyntaxTheme): SyntaxToken[][] {
    const lines = splitLines(text).map(([line]) => line);
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
    this.lines = lines;
    this.language = language;
    this.theme = theme;
    this.tokens = tokens;
    this.states = states;
    return tokens;
  }
}

export interface SyntaxSpan { from: number; to: number; className: string }
export interface VisibleRange { from: number; to: number }

/** Only visible spans cross to the UI, including horizontal windows of very long lines. */
export function visibleSyntax(text: string, tokens: SyntaxToken[][], ranges: readonly VisibleRange[]): SyntaxSpan[] {
  const result: SyntaxSpan[] = [];
  splitLines(text).forEach(([line, start], index) => {
    const visible = ranges.filter(range => range.from < start + line.length && range.to > start);
    if (!visible.length) return;
    let offset = start;
    for (const token of tokens[index] ?? []) {
      const end = offset + token.content.length;
      if (token.className) for (const range of visible) {
        const from = Math.max(range.from, offset);
        const to = Math.min(range.to, end);
        if (from < to) result.push({ from, to, className: token.className });
      }
      offset = end;
    }
  });
  return result;
}

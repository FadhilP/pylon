import katex from "katex";
import { Marked, Renderer, type MarkedExtension, type Tokens } from "marked";
import { parseFileReference, type FileReference } from "../workspace/file-reference.ts";
import { getSyntaxHighlightingRevision, highlightSyntax } from "./syntax-highlighting.ts";
import { sourceLanguage } from "./source-language.ts";
export { sourceLanguage } from "./source-language.ts";

/** Bound retained UTF-16 input and markup, including many tiny entries. */
export class MarkdownRenderCache {
  private readonly entries = new Map<string, string>();
  private characters = 0;
  constructor(private readonly capacity = 512 * 1024) {}

  render(key: string, produce: () => string): string {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const value = produce();
    const size = key.length + value.length;
    if (size > this.capacity) return value;
    while (this.entries.size && (this.characters + size > this.capacity || this.entries.size >= 128)) {
      const [oldKey, oldValue] = this.entries.entries().next().value!;
      this.characters -= oldKey.length + oldValue.length;
      this.entries.delete(oldKey);
    }
    this.entries.set(key, value);
    this.characters += size;
    return value;
  }
}
const renderCache = new MarkdownRenderCache();

function fileReferenceHref(reference: FileReference): string {
  return `${reference.path}:${reference.line}${reference.column === undefined ? "" : `:${reference.column}`}`;
}

function fileCitationHref(text: string): string | undefined {
  const direct = parseFileReference(text);
  if (direct?.line !== undefined) return fileReferenceHref(direct);

  const range = /^(.*):(\d+)-(\d+)$/.exec(text);
  if (!range) return;
  const start = parseFileReference(`${range[1]}:${range[2]}`);
  const end = parseFileReference(`${range[1]}:${range[3]}`);
  if (start?.line === undefined || end?.line === undefined || start.path !== end.path || end.line < start.line) return;
  return fileReferenceHref(start);
}

function isLocalImageSource(href: string): boolean {
  return href.trim().toLowerCase().startsWith("file:");
}

function localImageMarkup(token: { href: string; text: string; title?: string | null }): string {
  const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
  return `<img data-local-image="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${title}>`;
}
class MarkdownRenderer extends Renderer {
  private linkDepth = 0;

  override link(token: Parameters<Renderer["link"]>[0]): string {
    if (isLocalImageSource(token.href)) return localImageMarkup(token);
    this.linkDepth++;
    try {
      return super.link(token);
    } finally {
      this.linkDepth--;
    }
  }

  override image(token: Parameters<Renderer["image"]>[0]): string {
    return isLocalImageSource(token.href) ? localImageMarkup(token) : super.image(token);
  }

  override codespan(token: Parameters<Renderer["codespan"]>[0]): string {
    const code = super.codespan(token);
    const href = this.linkDepth ? undefined : fileCitationHref(token.text);
    return href ? `<a href="${escapeHtml(href)}">${code}</a>` : code;
  }

  override code({ text, lang }: Parameters<Renderer["code"]>[0]): string {
    const language = lang?.trim().split(/\s+/, 1)[0]?.toLowerCase();
    const code = language ? highlightCode(text, language) : escapeHtml(text);
    const attributes = language
      ? ` class="language-${escapeHtml(language)}" data-language="${escapeHtml(language)}"`
      : "";
    return `<pre><code${attributes}>${code}</code></pre>\n`;
  }
}

interface MathToken extends Tokens.Generic {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
  displayMode: boolean;
}

interface MathMatch {
  raw: string;
  text: string;
  displayMode: boolean;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && text[--index] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

function mathAtStart(source: string): MathMatch | undefined {
  let close: string;
  let displayMode: boolean;
  let multiline: boolean;

  if (source.startsWith("\\(")) {
    close = "\\)";
    displayMode = false;
    multiline = false;
  } else if (source.startsWith("\\[")) {
    close = "\\]";
    displayMode = true;
    multiline = true;
  } else if (source.startsWith("$$") && source[2] !== "$") {
    close = "$$";
    displayMode = true;
    multiline = true;
  } else if (source.startsWith("$") && source[1] !== "$" && source[1] !== undefined && !/\s/.test(source[1])) {
    close = "$";
    displayMode = false;
    multiline = false;
  } else {
    return;
  }

  const openLength = close.length;
  for (let index = openLength; index < source.length; index++) {
    if (!multiline && source[index] === "\n") return;
    if (!source.startsWith(close, index) || isEscaped(source, index)) continue;
    // Require tight single-dollar content and never close immediately before a digit, which avoids common currency prose.
    if (close === "$" && (/\s/.test(source[index - 1]) || /\d/.test(source[index + 1] ?? ""))) continue;
    if (close === "$$" && (source[index - 1] === "$" || source[index + 2] === "$")) continue;

    const text = source.slice(openLength, index).trim();
    if (!text) return;
    return { raw: source.slice(0, index + close.length), text, displayMode };
  }
}

function findMathStart(source: string): number | undefined {
  for (let index = 0; index < source.length; index++) {
    const next = source[index + 1];
    const possibleDelimiter = source[index] === "$" || (source[index] === "\\" && (next === "(" || next === "["));
    if (possibleDelimiter && !isEscaped(source, index) && mathAtStart(source.slice(index))) return index;
  }
}

function renderMath(token: MathToken): string {
  try {
    const math = renderCache.render(`math:${token.displayMode}:${token.text}`, () => katex.renderToString(token.text, {
      displayMode: token.displayMode,
      maxExpand: 1_000,
      maxSize: 20,
      output: "mathml",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    }));
    return token.displayMode ? `<span class="math-display">${math}</span>` : math;
  } catch {
    return escapeHtml(token.raw);
  }
}

const mathExtension: MarkedExtension = {
  extensions: [
    {
      name: "blockMath",
      level: "block",
      tokenizer(source) {
        const match = mathAtStart(source);
        if (!match?.displayMode) return;
        const trailingLine = /^[ \t]*(?:\n|$)/.exec(source.slice(match.raw.length));
        if (!trailingLine) return;
        return { type: "blockMath", raw: match.raw + trailingLine[0], text: match.text, displayMode: true };
      },
      renderer(token) {
        return `${renderMath(token as MathToken)}\n`;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start: findMathStart,
      tokenizer(source) {
        const match = mathAtStart(source);
        return match && { type: "inlineMath", ...match };
      },
      renderer(token) {
        return renderMath(token as MathToken);
      },
    },
  ],
};

const renderer = new MarkdownRenderer();
const markdown = new Marked(mathExtension);

export function renderMarkdown(text: string): string {
  return markdown.parse(text, { async: false, breaks: true, gfm: true, renderer });
}


export function highlightSource(text: string, path: string, diffView = false): string {
  const language = diffView ? "diff" : sourceLanguage(path);
  return language ? highlightCode(text, language) : escapeHtml(text);
}

function highlightCode(text: string, language: string): string {
  return renderCache.render(JSON.stringify(["code", getSyntaxHighlightingRevision(), language, text]),
    () => highlightSyntax(text, language) ?? escapeHtml(text));
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

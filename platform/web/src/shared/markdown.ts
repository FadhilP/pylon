import katex from "katex";
import { Marked, Renderer, type MarkedExtension, type Tokens } from "marked";
import { parseFileReference, type FileReference } from "./file-reference.ts";
import { highlightSyntax } from "./syntax-highlighting.ts";

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

class MarkdownRenderer extends Renderer {
  private linkDepth = 0;

  override link(token: Parameters<Renderer["link"]>[0]): string {
    this.linkDepth++;
    try {
      return super.link(token);
    } finally {
      this.linkDepth--;
    }
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
    const math = katex.renderToString(token.text, {
      displayMode: token.displayMode,
      maxExpand: 1_000,
      maxSize: 20,
      output: "mathml",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    });
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

const sourceLanguages: Record<string, string> = {
  bash: "bash",
  css: "css",
  dart: "dart",
  diff: "diff",
  htm: "html",
  html: "html",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  java: "java",
  md: "markdown",
  mjs: "javascript",
  cjs: "javascript",
  ps1: "powershell",
  py: "python",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function highlightSource(text: string, path: string, diffView = false): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const language = diffView ? "diff" : sourceLanguages[extension];
  return language ? highlightCode(text, language) : escapeHtml(text);
}

function highlightCode(text: string, language: string): string {
  return highlightSyntax(text, language) ?? escapeHtml(text);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

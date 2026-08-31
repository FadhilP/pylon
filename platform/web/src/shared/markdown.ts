import { marked, Renderer } from "marked";
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

const renderer = new MarkdownRenderer();

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false, breaks: true, gfm: true, renderer });
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

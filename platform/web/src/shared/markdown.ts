import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked, Renderer } from "marked";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const renderer = new Renderer();

renderer.code = ({ text, lang }) => {
  const language = lang?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const code = language && hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text);
  const attributes = language
    ? ` class="language-${escapeHtml(language)}" data-language="${escapeHtml(language)}"`
    : "";
  return `<pre><code${attributes}>${code}</code></pre>\n`;
};

export function renderMarkdown(text: string): string {
  return marked.parse(text, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
}

const sourceLanguages: Record<string, string> = {
  bash: "bash",
  css: "css",
  dart: "dart",
  diff: "diff",
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
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
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function highlightSource(text: string, path: string, diffView = false): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const language = diffView ? "diff" : sourceLanguages[extension];
  return language
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

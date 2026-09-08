import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import dart from "@shikijs/langs/dart";
import diff from "@shikijs/langs/diff";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import powershell from "@shikijs/langs/powershell";
import python from "@shikijs/langs/python";
import sql from "@shikijs/langs/sql";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import dracula from "@shikijs/themes/dracula";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import nord from "@shikijs/themes/nord";
import oneDarkPro from "@shikijs/themes/one-dark-pro";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { GrammarState } from "shiki";
import type { SyntaxTheme, SyntaxToken } from "./syntax-highlighting.ts";

const highlighter = createHighlighterCoreSync({
  themes: [oneDarkPro, githubDark, dracula, nord, githubLight],
  langs: [
    bash,
    css,
    dart,
    diff,
    html,
    java,
    javascript,
    json,
    jsonc,
    jsx,
    markdown,
    powershell,
    python,
    sql,
    tsx,
    typescript,
    xml,
    yaml,
  ],
  engine: createJavaScriptRegexEngine(),
});
const loadedLanguages = new Set(highlighter.getLoadedLanguages());
const languageLoads = new Map<string, Promise<boolean>>();

export function loadSyntaxLanguage(language: string): Promise<boolean> {
  if (loadedLanguages.has(language)) return Promise.resolve(false);
  let loading = languageLoads.get(language);
  if (!loading) {
    loading = import("shiki/langs")
      .then(async ({ bundledLanguages }) => {
        const loader = bundledLanguages[language as keyof typeof bundledLanguages];
        if (!loader) return false;
        await highlighter.loadLanguage(await loader());
        for (const name of highlighter.getLoadedLanguages()) loadedLanguages.add(name);
        return true;
      })
      .catch(() => false);
    languageLoads.set(language, loading);
  }
  return loading;
}

export const syntaxThemeTokenCss = createTokenCss();

export function highlightSyntax(text: string, language: string, theme: SyntaxTheme): string | undefined {
  if (!loadedLanguages.has(language)) return;
  return syntaxTokens(text, language, theme)!
    .map(line =>
      line
        .map(token => {
          const classes = token.className;
          const content = escapeHtml(token.content);
          return classes ? `<span class="${classes}">${content}</span>` : content;
        })
        .join(""),
    )
    .join("\n");
}

export function syntaxTokens(text: string, language: string, theme: SyntaxTheme): SyntaxToken[][] | undefined {
  if (!loadedLanguages.has(language)) return;
  return highlighter
    .codeToTokens(text, { lang: language, theme })
    .tokens.map(line =>
      line.map(token => ({ content: token.content, className: tokenClasses(token.color, token.fontStyle) })),
    );
}

/** Stateful single-line tokenization for the editor worker; same engine, themes and classes as previews. */
export function syntaxLine(text: string, language: string, theme: SyntaxTheme, grammarState?: GrammarState): { tokens: SyntaxToken[]; state?: GrammarState } {
  if (!loadedLanguages.has(language)) return { tokens: [{ content: text, className: "" }] };
  const result = highlighter.codeToTokens(text, { lang: language, theme, grammarState });
  return {
    tokens: result.tokens[0].map(token => ({ content: token.content, className: tokenClasses(token.color, token.fontStyle) })),
    state: result.grammarState,
  };
}


function createTokenCss(): string {
  const colors = new Set<string>();
  for (const theme of highlighter.getLoadedThemes()) {
    const resolved = highlighter.getTheme(theme);
    for (const rule of resolved.settings) {
      const color = normalizedColor(rule.settings.foreground);
      if (color) colors.add(color);
    }
  }
  return [...colors]
    .sort()
    .map(color => `.shiki-token-${color.slice(1)}{color:${color}}`)
    .join("\n");
}

function tokenClasses(color: string | undefined, fontStyle: number | undefined): string {
  const classes: string[] = [];
  const normalized = normalizedColor(color);
  if (normalized) classes.push(`shiki-token-${normalized.slice(1)}`);
  if (fontStyle && fontStyle & 1) classes.push("shiki-italic");
  if (fontStyle && fontStyle & 2) classes.push("shiki-bold");
  if (fontStyle && fontStyle & 4) classes.push("shiki-underline");
  if (fontStyle && fontStyle & 8) classes.push("shiki-strikethrough");
  return classes.join(" ");
}

function normalizedColor(color: string | undefined): string | undefined {
  const value = color?.toLowerCase();
  if (!value || !/^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/.test(value)) return;
  if (value.length > 5) return value;
  return `#${[...value.slice(1)].map(character => character.repeat(2)).join("")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

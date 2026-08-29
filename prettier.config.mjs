// Formatting tuned for machine-readable density: fewer lines, stable line numbers,
// no cosmetic reflow. Every option below is a deliberate deviation from defaults.
export default {
  // Fewer wrapped lines. 120 keeps most signatures, imports and JSX props on one
  // line while still fitting a side-by-side diff.
  printWidth: 120,

  // The big one. Prettier's default ("preserve") keeps an object expanded forever
  // just because someone once put a newline after `{`. "collapse" re-joins any
  // object literal that fits within printWidth.
  objectWrap: "collapse",

  // Puts `>` on the last prop line instead of its own line: one line saved per
  // multi-line JSX element.
  bracketSameLine: true,

  // `x => x` instead of `(x) => x`.
  arrowParens: "avoid",

  // 2-space indent, tabs off: indentation is a meaningful fraction of the bytes
  // in deeply nested code, and spaces tokenize more predictably than tabs.
  useTabs: false,
  tabWidth: 2,

  // Kept ON deliberately. A trailing comma means appending an array/object/param
  // entry is a pure line insertion — the preceding line is untouched, so a
  // line-addressed edit never has to rewrite a neighbour it didn't mean to.
  trailingComma: "all",

  // Kept ON deliberately. Cheap insurance against ASI hazards; dropping them saves
  // ~1 token/line but makes any hand-written line edit a potential parse change.
  semi: true,

  singleQuote: false,
  quoteProps: "as-needed",
  bracketSpacing: true,
  endOfLine: "lf",

  overrides: [
    {
      // Never reflow prose. One paragraph = one line means editing a sentence
      // touches exactly one line, and grep finds a whole sentence in one hit.
      files: ["*.md", "*.mdx"],
      options: { proseWrap: "never", printWidth: 120 },
    },
    {
      // JSON has no expression wrapping to save; keep it wide so config arrays and
      // dependency blocks stay on single lines.
      files: ["*.json", "*.jsonc", ".prettierrc"],
      options: { printWidth: 160, trailingComma: "none" },
    },
    {
      // YAML is newline-significant; leave it alone apart from indent width.
      files: ["*.yml", "*.yaml"],
      options: { printWidth: 100, singleQuote: false },
    },
  ],
};

// Formatting tuned for machine-readable density.
export default {
  printWidth: 120,
  objectWrap: "collapse",
  bracketSameLine: true,
  arrowParens: "avoid",
  useTabs: false,
  tabWidth: 2,
  trailingComma: "all",
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  bracketSpacing: true,
  endOfLine: "lf",

  overrides: [
    { files: ["*.md", "*.mdx"], options: { proseWrap: "never", printWidth: 120 } },
    { files: ["*.json", "*.jsonc", ".prettierrc"], options: { printWidth: 160, trailingComma: "none" } },
    { files: ["*.yml", "*.yaml"], options: { printWidth: 100, singleQuote: false } },
  ],
};

const sourceLanguages: Record<string, string> = {
  bash: "bash", css: "css", dart: "dart", diff: "diff", htm: "html", html: "html",
  js: "javascript", jsx: "jsx", json: "json", jsonc: "jsonc", java: "java", md: "markdown",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", rs: "rust",
  h: "c", cc: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", kt: "kotlin", kts: "kotlin",
  vue: "vue", svelte: "svelte", tf: "terraform", proto: "proto", ps1: "powershell",
  py: "python", sh: "bash", sql: "sql", svg: "xml", ts: "typescript", tsx: "tsx",
  xml: "xml", yaml: "yaml", yml: "yaml", zsh: "bash",
};

export function sourceLanguage(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const extension = name.split(".").at(-1) ?? "";
  return sourceLanguages[extension] ?? extension;
}

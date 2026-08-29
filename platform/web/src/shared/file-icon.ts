export type FileIconKind =
  | "archive"
  | "code"
  | "config"
  | "css"
  | "docker"
  | "file"
  | "go"
  | "html"
  | "image"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "npm"
  | "pdf"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "svg"
  | "text"
  | "tsx"
  | "typescript";

const extensionKinds: Record<string, FileIconKind> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  pdf: "pdf",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  bz2: "archive",
  xz: "archive",
  rar: "archive",
  "7z": "archive",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  conf: "config",
  config: "config",
  env: "config",
  lock: "config",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  c: "code",
  cc: "code",
  cpp: "code",
  cxx: "code",
  h: "code",
  hpp: "code",
  cs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  swift: "code",
  rb: "code",
  php: "code",
  vue: "code",
  svelte: "code",
  txt: "text",
  log: "text",
  csv: "text",
  xml: "text",
  rtf: "text",
};

export function fileIconKind(path: string): FileIconKind {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLocaleLowerCase() ?? "";
  if (name === "package.json" || name === "package-lock.json" || name === "npm-shrinkwrap.json") return "npm";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "docker";
  if (name === "readme" || name.startsWith("readme.")) return "markdown";
  if (name === "license" || name.startsWith("license.")) return "text";
  if (name.startsWith(".")) return "config";
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return extensionKinds[extension] ?? "file";
}

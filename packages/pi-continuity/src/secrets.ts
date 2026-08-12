const explicitPatterns = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|AIza|xox[baprs]-)[\w.-]{10,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/,
  /\b(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*\S+/i,
  /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)["']\s*:\s*["'][^"']{6,}/i,
];
const opaqueCredentialPattern = /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]*[0-9+/_=-])[A-Za-z0-9+/_=-]{50,}(?![A-Za-z0-9+/_=-])/;
const patterns = [...explicitPatterns, opaqueCredentialPattern];
const replace = (text: string, selected: RegExp[]) => selected.reduce(
  (safe, pattern) => safe.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[REDACTED CREDENTIAL]"),
  text,
);
const clip = (text: string, max: number) => {
  const safe = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
  if (safe.length <= max) return safe;
  const marker = "\n[truncated by Continuity]";
  return max <= marker.length ? marker.slice(0, max) : `${safe.slice(0, max - marker.length)}${marker}`;
};
const maskPaths = (text: string, paths: string[]) => {
  assertSafePath(...paths);
  let prefix = "\uE000";
  while (text.includes(prefix)) prefix += "\uE000";
  const values = [...new Set(paths.filter((path) => path && redactSecrets(path) !== path))].sort((a, b) => b.length - a.length);
  const tokens = values.map((_, index) => `${prefix}${index}\uE001`);
  return {
    masked: values.reduce((value, path, index) => value.replaceAll(path, tokens[index]), text),
    restore: (value: string) => tokens.reduce((safe, token, index) => safe.replaceAll(token, values[index]), value),
  };
};
export function assertSafe(...texts: (string | undefined)[]) {
  if (texts.some((text) => text && patterns.some((pattern) => pattern.test(text))))
    throw Error("candidate rejected: possible credential");
}
export function assertSafePath(...paths: (string | undefined)[]) {
  if (paths.some((path) => path && (explicitPatterns.some((pattern) => pattern.test(path))
    || path.split(/[\\/]+/).some((part) => opaqueCredentialPattern.test(part)))))
    throw Error("candidate rejected: possible credential");
}
export function assertSafeWithPaths(text: string, paths: string[]) {
  assertSafe(maskPaths(text, paths).masked);
}
export function redactSecrets(text: string) {
  return replace(text, patterns);
}
export function redactPathSecrets(path: string) {
  return replace(path, explicitPatterns).split(/([\\/]+)/).map((part) =>
    /^[\\/]+$/.test(part) ? part : replace(part, [opaqueCredentialPattern])).join("");
}
export function sanitizeAndClip(text: string, max: number) {
  return clip(redactSecrets(text), max);
}
export function sanitizePathAndClip(path: string, max: number) {
  return clip(redactPathSecrets(path), max);
}
export function sanitizeAndClipWithPaths(text: string, paths: string[], max: number) {
  const masked = maskPaths(text, paths);
  return clip(masked.restore(redactSecrets(masked.masked)), max);
}

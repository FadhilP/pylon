const patterns = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|AIza|xox[baprs]-)[\w.-]{10,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/,
  /\b(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*\S+/i,
  /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)["']\s*:\s*["'][^"']{6,}/i,
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]*[0-9+/_=-])[A-Za-z0-9+/_=-]{50,}(?![A-Za-z0-9+/_=-])/,
];
export function assertSafe(...texts: (string | undefined)[]) {
  if (texts.some((t) => t && patterns.some((p) => p.test(t))))
    throw Error("candidate rejected: possible credential");
}
export function redactSecrets(text: string) {
  return patterns.reduce(
    (safe, pattern) => safe.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[REDACTED CREDENTIAL]"),
    text,
  );
}
export function sanitizeAndClip(text: string, max: number) {
  const safe = redactSecrets(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
  if (safe.length <= max) return safe;
  const marker = "\n[truncated by Continuity]";
  return max <= marker.length ? marker.slice(0, max) : `${safe.slice(0, max - marker.length)}${marker}`;
}

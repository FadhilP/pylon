const PATTERNS = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
  /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9._-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:authorization|api[_-]?key|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9+/=_-]{40,}\b/g,
];
export function redact(text: string): { text: string; count: number } {
  let output = text,
    count = 0;
  for (const pattern of PATTERNS)
    output = output.replace(pattern, () => {
      count++;
      return "[possible credential redacted]";
    });
  return { text: output, count };
}

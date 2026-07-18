const patterns = [
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|AIza|xox[baprs]-)[\w.-]{10,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/,
  /\b(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*\S+/i,
  /\b[A-Za-z0-9+/_=-]{50,}\b/,
];
export function assertSafe(...texts: (string | undefined)[]) {
  if (texts.some((t) => t && patterns.some((p) => p.test(t))))
    throw Error("candidate rejected: possible credential");
}

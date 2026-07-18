export const ADVISOR_MAX_CALLS = 3;
export const ADVISOR_MAX_OUTPUT_TOKENS = 8_192;
const ESTIMATED_CHARS_PER_TOKEN = 4;

export function capAdvice(
  text: string,
  maxTokens = ADVISOR_MAX_OUTPUT_TOKENS,
): { text: string; truncated: boolean } {
  const maxBytes = maxTokens * ESTIMATED_CHARS_PER_TOKEN;
  let output = text;
  while (Buffer.byteLength(output, "utf8") > maxBytes)
    output = output.slice(0, -1);
  if (output === text) return { text: output, truncated: false };
  const suffix = `\n\n[Advisor output truncated to estimated ${maxTokens} tokens.]`;
  while (Buffer.byteLength(output + suffix, "utf8") > maxBytes)
    output = output.slice(0, -1);
  return { text: output + suffix, truncated: true };
}

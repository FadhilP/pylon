import { truncateUtf8 } from "pylon-core/utf8";

export const ADVISOR_MAX_CALLS = 3;
export const ADVISOR_MAX_OUTPUT_TOKENS = 8_192;
const ESTIMATED_CHARS_PER_TOKEN = 4;

export function capAdvice(
  text: string,
  maxTokens = ADVISOR_MAX_OUTPUT_TOKENS,
): { text: string; truncated: boolean } {
  const maxBytes = maxTokens * ESTIMATED_CHARS_PER_TOKEN;
  let output = truncateUtf8(text, maxBytes);
  if (output === text) return { text: output, truncated: false };
  const suffix = `\n\n[Advisor output truncated to estimated ${maxTokens} tokens.]`;
  output = truncateUtf8(output, maxBytes - Buffer.byteLength(suffix, "utf8"));
  return { text: output + suffix, truncated: true };
}

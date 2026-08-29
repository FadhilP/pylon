/** Return the largest UTF-8-safe prefix that fits within maxBytes. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes)
      low = middle;
    else high = middle - 1;
  }
  // Do not leave half of a UTF-16 surrogate pair at the truncation boundary.
  if (low > 0 && low < text.length) {
    const previous = text.charCodeAt(low - 1);
    const next = text.charCodeAt(low);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      low--;
  }
  return text.slice(0, low);
}

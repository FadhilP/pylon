export const MAX_BYTES = 16 * 1024;

export function capText(
  text: string,
  maxBytes = MAX_BYTES,
  maxLines?: number,
): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  let output = maxLines === undefined ? lines.join("\n") : lines.slice(0, maxLines).join("\n");
  let truncated = maxLines !== undefined && lines.length > maxLines;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, -1);
    truncated = true;
  }
  const limit = `${maxBytes} bytes${maxLines === undefined ? "" : `/${maxLines} lines`}`;
  return {
    text: truncated ? `${output}\n\n[Truncated to ${limit}.]` : output,
    truncated,
  };
}

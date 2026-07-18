export class TailBuffer {
  private value = "";
  readonly maxBytes: number;
  constructor(maxBytes = 16384) {
    this.maxBytes = maxBytes;
  }
  append(text: string) {
    this.value += text;
    while (Buffer.byteLength(this.value) > this.maxBytes)
      this.value = this.value.slice(
        Math.max(1, this.value.length - Math.floor(this.maxBytes * 0.9)),
      );
  }
  toString() {
    return this.value;
  }
}
export function bounded(text: string, maxBytes = 12288, maxLines = 200) {
  let out = text.split(/\r?\n/).slice(-maxLines).join("\n"),
    truncated = text.split(/\r?\n/).length > maxLines;
  while (Buffer.byteLength(out) > maxBytes) {
    out = out.slice(1);
    truncated = true;
  }
  return { text: out, truncated };
}

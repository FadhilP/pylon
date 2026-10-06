/**
 * Joins the text parts of message content with newlines. Images become `imagePlaceholder`
 * when one is given; every other part is dropped.
 */
export function contentText(content: unknown, imagePlaceholder?: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return [part.text];
      if (part?.type === "image" && imagePlaceholder !== undefined) return [imagePlaceholder];
      return [];
    })
    .join("\n");
}

/** JSON-encodes untrusted values within `max` characters: depth 4, 25 items per level, no cycles. */
export function boundedJson(value: unknown, max: number): string {
  const seen = new WeakSet<object>();
  const visit = (item: any, depth: number): any => {
    if (typeof item === "string") return item.slice(0, max);
    if (item === null || typeof item !== "object") return item;
    if (depth >= 4 || seen.has(item)) return "[truncated]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 25).map(child => visit(child, depth + 1));
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count++ >= 25) {
        output["[truncated]"] = true;
        break;
      }
      output[key.slice(0, 200)] = visit(item[key], depth + 1);
    }
    return output;
  };
  try {
    return (JSON.stringify(visit(value, 0)) ?? "null").slice(0, max);
  } catch {
    return "[unserializable arguments]";
  }
}

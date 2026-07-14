function messageText(message: any) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      part.type === "text" ? part.text : part.type === "image" ? "[image]" : "",
    )
    .join(" ");
}

export function promptText(message: any) {
  return messageText(message).slice(0, 80);
}

export function promptTitle(message: any) {
  const text = messageText(message).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
}

export function normalizeGeneratedTitle(text: string) {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) return undefined;
  const title = lines[0]
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ");
  const words = title.split(" ");
  if (title.length > 60 || words.length < 3 || words.length > 8)
    return undefined;
  return title;
}

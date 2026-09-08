export interface FileReference {
  path: string;
  line?: number;
  column?: number;
}

const MAX_LOCATION = 10_000_000;

export function parseFileReference(href: string): FileReference | undefined {
  let value: string;
  try {
    value = decodeURIComponent(href.trim());
  } catch {
    return;
  }
  if (!value || value.startsWith("#") || value.includes("?") || value.startsWith("//")) return;
  if (/^(?:https?|mailto|ftp|data|javascript|file):/i.test(value) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) return;
  const schemeLike = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);

  let line: number | undefined;
  let column: number | undefined;
  const hash = /#L(\d+)(?:C(\d+))?$/.exec(value);
  const suffix = /:(\d+)(?::(\d+))?$/.exec(value);
  const location = hash ?? suffix;
  if (location) {
    line = Number(location[1]);
    column = location[2] ? Number(location[2]) : undefined;
    value = value.slice(0, location.index);
  } else if (value.includes("#")) return;
  if (schemeLike && (location !== suffix || !/[/.]/.test(value) || value.includes(":"))) return;

  value = value.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > MAX_LOCATION)) return;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > MAX_LOCATION)) return;
  return { path: value, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

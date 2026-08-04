import { createHash } from "node:crypto";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_NODES = 5_000;
const MAX_DEPTH = 80;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_LENGTH = 4_096;
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;
const SECRET_HINT = /(?:pass(?:word|code)?|pin|otp|token|secret|credential|auth)/i;
const CREDENTIAL_VALUE = /(?:\b(?:authorization|api[_-]?key|token|password|secret|cookie)\s*[:=]\s*\S+|\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9._-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

export interface AndroidBounds { left: number; top: number; right: number; bottom: number }
export interface AndroidElementRef {
  xpath: string;
  fingerprint: string;
  bounds: AndroidBounds;
  packageName: string;
  enabled: boolean;
  editable: boolean;
  className: string;
}
export interface AndroidSnapshot {
  text: string;
  refs: Map<string, AndroidElementRef>;
  allRefs: Map<string, AndroidElementRef>;
  packageName: string;
  redactions: number;
  truncated: boolean;
  omittedLines: number;
  omittedBytes: number;
  matches?: number;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent?: XmlNode;
  path: string;
  depth: number;
}

function decodeEntity(value: string): string {
  if (/&(?!#x[0-9a-f]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/i.test(value)) throw new Error("Android source contains an unsupported XML entity");
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const point = entity.toLowerCase().startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isSafeInteger(point) || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff
      || point !== 0x9 && point !== 0xa && point !== 0xd && point < 0x20) throw new Error("Android source contains an invalid XML entity");
    return String.fromCodePoint(point);
  });
}

function parseAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let offset = 0;
  while (offset < value.length) {
    const whitespace = value.slice(offset).match(/^\s+/)?.[0].length ?? 0;
    offset += whitespace;
    if (offset >= value.length) break;
    const match = value.slice(offset).match(/^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/u);
    if (!match) throw new Error("Android source contains malformed XML attributes");
    if (Object.keys(attrs).length >= MAX_ATTRIBUTES) throw new Error("Android source node has too many attributes");
    const decoded = decodeEntity(match[3] ?? match[4] ?? "");
    if (decoded.length > MAX_ATTRIBUTE_LENGTH) throw new Error("Android source attribute is oversized");
    if (Object.hasOwn(attrs, match[1])) throw new Error("Android source contains duplicate XML attributes");
    attrs[match[1]] = decoded;
    offset += match[0].length;
  }
  return attrs;
}

function parseXml(source: string): XmlNode {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new Error("Android source exceeds 1MB limit");
  let xml = source.trim();
  if (xml.startsWith("<?xml")) {
    const declaration = xml.match(/^<\?xml(?:\s+[^?]*)?\?>/u)?.[0];
    if (!declaration || declaration.length > 300) throw new Error("Android source has an invalid XML declaration");
    xml = xml.slice(declaration.length).trim();
  }
  if (xml.includes("<!") || xml.includes("<?")) throw new Error("Android source declarations and DTDs are not supported");

  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let offset = 0;
  let count = 0;
  while (offset < xml.length) {
    const start = xml.indexOf("<", offset);
    if (start < 0 || xml.slice(offset, start).trim()) throw new Error("Android source contains unsupported XML text nodes");
    let end = start + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === "<") throw new Error("Android source contains malformed XML tags");
      if (character === ">") break;
    }
    if (end >= xml.length || quote) throw new Error("Android source contains malformed XML tags");
    let body = xml.slice(start + 1, end).trim();
    offset = end + 1;
    if (!body) throw new Error("Android source contains an empty XML tag");
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error("Android source contains mismatched XML tags");
      continue;
    }
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1).trimEnd();
    const nameMatch = body.match(/^([A-Za-z_][\w:.-]*)/u);
    if (!nameMatch) throw new Error("Android source contains an invalid XML tag");
    const parent = stack.at(-1);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) throw new Error("Android source exceeds maximum depth");
    if (++count > MAX_NODES) throw new Error("Android source exceeds maximum node count");
    const name = nameMatch[1];
    const siblings = parent?.children.filter((item) => item.name === name).length ?? roots.filter((item) => item.name === name).length;
    const base = parent?.path ?? "";
    const attrs = parseAttributes(body.slice(name.length));
    for (const key of ["enabled", "clickable", "focusable", "checkable", "checked", "selected", "password", "scrollable", "visible-to-user"]) {
      if (attrs[key] !== undefined && attrs[key] !== "true" && attrs[key] !== "false") throw new Error(`Android source contains invalid boolean attribute ${key}`);
    }
    const node: XmlNode = {
      name,
      attrs,
      children: [],
      parent,
      path: `${base}/${name}[${siblings + 1}]`,
      depth,
    };
    if (parent) parent.children.push(node); else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || roots.length !== 1) throw new Error("Android source contains malformed XML");
  return roots[0];
}

function parseBounds(value: string | undefined): AndroidBounds | undefined {
  const match = value?.match(BOUNDS);
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 || right <= left || bottom <= top || right > 16_384 || bottom > 16_384) return undefined;
  return { left, top, right, bottom };
}

function role(node: XmlNode): string {
  const name = node.attrs.class || node.name;
  if (/EditText$/i.test(name)) return "textbox";
  if (/Button$/i.test(name)) return "button";
  if (/CheckBox$/i.test(name)) return "checkbox";
  if (/Switch$/i.test(name)) return "switch";
  if (/ImageView$/i.test(name)) return "image";
  if (/TextView$/i.test(name)) return "text";
  return node.attrs.clickable === "true" ? "button" : "node";
}

function compact(value: string): string {
  const clean = value.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().replaceAll("[", "［").replaceAll("]", "］");
  return Array.from(clean).slice(0, 500).join("");
}

function fingerprint(node: XmlNode, bounds: AndroidBounds): string {
  const attrs = node.attrs;
  return createHash("sha256").update(JSON.stringify([
    node.name, attrs.class ?? "", attrs["resource-id"] ?? "", attrs["content-desc"] ?? "", attrs.text ?? "",
    attrs.package ?? "", attrs.enabled ?? "", attrs.clickable ?? "", attrs.focusable ?? "", attrs.checked ?? "",
    attrs.selected ?? "", attrs["visible-to-user"] ?? "", attrs.password ?? "", bounds,
  ])).digest("hex").slice(0, 24);
}

function allNodes(root: XmlNode): XmlNode[] {
  const output: XmlNode[] = [];
  const visit = (node: XmlNode) => { output.push(node); for (const child of node.children) visit(child); };
  visit(root);
  return output;
}

function queryMatcher(text?: string): (value: string) => boolean {
  if (text === undefined) return () => true;
  const expected = text.normalize("NFC").toLowerCase();
  return (value) => value.normalize("NFC").toLowerCase().includes(expected);
}

function relevant(node: XmlNode): boolean {
  const attrs = node.attrs;
  return Boolean(attrs.text || attrs["content-desc"] || attrs["resource-id"] || attrs.clickable === "true" || attrs.focusable === "true"
    || /EditText|AutoCompleteTextView|Button|CheckBox|Switch$/i.test(attrs.class || node.name));
}

function foreignAncestor(node: XmlNode, expectedPackage: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.attrs.package && parent.attrs.package !== expectedPackage) return true;
  }
  return false;
}

function boundLines(lines: string[], maxLines: number, maxBytes: number): { text: string; truncated: boolean; omittedLines: number; omittedBytes: number; keptLines: number } {
  const kept: string[] = [];
  let bytes = 0;
  let index = 0;
  for (; index < lines.length && kept.length < maxLines; index++) {
    const lineBytes = Buffer.byteLength(lines[index]) + (kept.length ? 1 : 0);
    if (bytes + lineBytes > maxBytes) break;
    kept.push(lines[index]);
    bytes += lineBytes;
  }
  return {
    text: kept.join("\n"),
    truncated: index < lines.length,
    omittedLines: lines.length - index,
    omittedBytes: Buffer.byteLength(lines.slice(index).join("\n")),
    keptLines: kept.length,
  };
}

export function androidSnapshot(source: string, expectedPackage: string, query?: { text: string }): AndroidSnapshot {
  const root = parseXml(source);
  const nodes = allNodes(root);
  const packages = new Set(nodes.map((node) => node.attrs.package).filter(Boolean));
  if (!packages.has(expectedPackage)) {
    const current = [...packages].slice(0, 3).join(", ") || "unknown";
    throw new Error(`Android UI left expected package ${expectedPackage}; current package: ${current}`);
  }
  const matcher = queryMatcher(query?.text);
  const foreign = nodes.find((node) => parseBounds(node.attrs.bounds) && relevant(node) && node.attrs.package && node.attrs.package !== expectedPackage);
  if (foreign) throw new Error(`Android source contains unsupported UI from package ${foreign.attrs.package}`);
  const candidates = nodes.filter((node) => {
    const attrs = node.attrs;
    const bounds = parseBounds(attrs.bounds);
    if (!bounds || attrs.package !== expectedPackage || foreignAncestor(node, expectedPackage)) return false;
    const searchable = [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class, node.name].filter(Boolean).join(" ");
    return relevant(node) && matcher(searchable);
  });

  let redactions = 0;
  const allRefs = new Map<string, AndroidElementRef>();
  const lines = candidates.map((node, index) => {
    const attrs = node.attrs;
    const bounds = parseBounds(attrs.bounds)!;
    const ref = `a${index + 1}`;
    const className = attrs.class || node.name;
    const editable = /(?:EditText|AutoCompleteTextView)$/i.test(className);
    const editableValue = editable && Boolean(attrs.text);
    let label = compact(attrs["content-desc"] || attrs.text || "");
    const secret = attrs.password === "true" || SECRET_HINT.test(`${attrs["resource-id"] ?? ""} ${attrs["content-desc"] ?? ""}`) || CREDENTIAL_VALUE.test(label);
    if (editableValue) { redactions++; if (!attrs["content-desc"]) label = "[value redacted]"; }
    if (secret && label !== "[value redacted]") { label = "[value redacted]"; redactions++; }
    allRefs.set(ref, {
      xpath: node.path,
      fingerprint: fingerprint(node, bounds),
      bounds,
      packageName: attrs.package,
      enabled: attrs.enabled !== "false",
      editable,
      className,
    });
    const details = [
      `[ref=${ref}]`,
      attrs["resource-id"] ? `[id=${compact(attrs["resource-id"])}]` : "",
      `[bounds=${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}]`,
      attrs.enabled === "false" ? "[disabled]" : "",
    ].filter(Boolean).join(" ");
    return `${"  ".repeat(Math.min(node.depth, 20))}- ${role(node)}${label ? ` "${label.replaceAll('"', "'")}"` : ""} ${details}`;
  });
  const bounded = boundLines(lines, query ? 120 : 200, query ? 12 * 1024 : 20 * 1024);
  const refs = new Map([...allRefs].slice(0, bounded.keptLines));
  const { keptLines: _keptLines, ...output } = bounded;
  return {
    ...output,
    refs,
    allRefs,
    packageName: expectedPackage,
    redactions,
    matches: query ? candidates.length : undefined,
  };
}

export function sameAndroidElement(current: AndroidSnapshot, target: AndroidElementRef): AndroidElementRef | undefined {
  return [...current.allRefs.values()].find((ref) => ref.xpath === target.xpath && ref.fingerprint === target.fingerprint);
}

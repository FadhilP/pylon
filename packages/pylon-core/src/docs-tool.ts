import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolPolicy, unregisterToolPolicy } from "./tools.ts";

const MAX_DOC_BYTES = 256 * 1024;

interface DocsLayout {
  root: string;
  fullBundle: boolean;
  mainReadme: string;
}

export interface PylonDocEntry {
  path: string;
  category: "main" | "web" | "package";
  absolutePath: string;
}

function packageName(root: string): string | undefined {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))?.name;
  } catch {
    return undefined;
  }
}

function docsLayout(extensionUrl: string): DocsLayout {
  const coreRoot = resolve(dirname(fileURLToPath(extensionUrl)), "..");
  const bundleRoot = resolve(coreRoot, "..", "..");
  const fullBundle =
    packageName(bundleRoot) === "@fadhilp/pylon" &&
    existsSync(resolve(bundleRoot, "README.md")) &&
    existsSync(resolve(bundleRoot, "packages", "pylon-core", "README.md"));
  return {
    root: fullBundle ? bundleRoot : coreRoot,
    fullBundle,
    mainReadme: resolve(fullBundle ? bundleRoot : coreRoot, "README.md"),
  };
}

async function confinedFile(root: string, candidate: string): Promise<string | undefined> {
  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(root),
    realpath(candidate).catch(() => undefined),
  ]);
  if (!canonicalFile) return undefined;
  const path = relative(canonicalRoot, canonicalFile);
  if (path.startsWith("..") || isAbsolute(path)) return undefined;
  const info = await stat(canonicalFile);
  return info.isFile() && info.size <= MAX_DOC_BYTES ? canonicalFile : undefined;
}

export async function listPylonDocs(extensionUrl: string): Promise<PylonDocEntry[]> {
  const layout = docsLayout(extensionUrl);
  const entries: PylonDocEntry[] = [];
  const add = async (path: string, category: PylonDocEntry["category"], candidate: string) => {
    const absolutePath = await confinedFile(layout.root, candidate);
    if (absolutePath) entries.push({ path, category, absolutePath });
  };

  await add("README.md", "main", layout.mainReadme);
  if (layout.fullBundle) {
    const webRoot = resolve(layout.root, "docs", "web");
    const webFiles = await readdir(webRoot, { withFileTypes: true }).catch(() => []);
    for (const file of webFiles.sort((left, right) => left.name.localeCompare(right.name))) {
      if (file.isFile() && file.name.endsWith(".md")) {
        await add(`docs/web/${file.name}`, "web", resolve(webRoot, file.name));
      }
    }

    const packagesRoot = resolve(layout.root, "packages");
    const packages = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
    for (const item of packages.sort((left, right) => left.name.localeCompare(right.name))) {
      if (item.isDirectory()) {
        await add(`packages/${item.name}/README.md`, "package", resolve(packagesRoot, item.name, "README.md"));
      }
    }
  }
  return entries;
}

async function searchPylonDocs(entries: PylonDocEntry[], query: string) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/))];
  const matches: Array<{ path: string; heading: string; line: number; excerpt: string; score: number }> = [];
  for (const entry of entries) {
    const lines = (await readFile(entry.absolutePath, "utf8")).split(/\r?\n/);
    const sections = [{ heading: "", line: 1, text: "" }];
    let fence = "";
    for (const [index, line] of lines.entries()) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      }
      const heading = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) sections.push({ heading: heading[1], line: index + 1, text: "" });
      else sections[sections.length - 1].text += `${line} `;
    }
    for (const section of sections) {
      if (!section.heading && !section.text.trim()) continue;
      const path = entry.path.toLowerCase();
      const heading = section.heading.toLowerCase();
      const body = section.text.replace(/\s+/g, " ").trim();
      const lowerBody = body.toLowerCase();
      const searchable = `${path}\n${heading}\n${lowerBody}`;
      if (!terms.every(term => searchable.includes(term))) continue;
      const positions = terms.map(term => lowerBody.indexOf(term)).filter(index => index >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
      matches.push({
        path: entry.path,
        heading: section.heading.slice(0, 160),
        line: section.line,
        excerpt: `${start ? "…" : ""}${body.slice(start, start + 480)}${body.length > start + 480 ? "…" : ""}`,
        score: terms.reduce(
          (score, term) => score + (heading.includes(term) ? 2 : 0) + (path.includes(term) ? 1 : 0),
          0,
        ),
      });
    }
  }
  matches.sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);
  return {
    matches: matches.slice(0, 8).map(({ score: _score, ...match }) => match),
    truncated: matches.length > 8,
  };
}
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

type PylonDocsHost = "web" | "tui" | "rpc" | "json" | "print" | "unknown";

function hostGuidance(host: PylonDocsHost): string {
  if (host === "web") {
    return "Current host: Pylon Web. Prefer supported Web panels, Inspector references, and Settings actions; describe slash commands only as terminal alternatives. Consult relevant docs/web sections when package docs do not cover Web-specific behavior.";
  }
  if (host === "tui") {
    return "Current host: Pi TUI. Prefer documented tools and slash commands; mention Pylon Web panels only as alternatives.";
  }
  return `Current host: Pi ${host}. Do not assume Pylon Web panels are available; prefer host-neutral tools and documented commands.`;
}

export function createPylonDocsTool(pi: ExtensionAPI, extensionUrl: string) {
  const deferred = docsLayout(extensionUrl).fullBundle;
  let webHost = false;
  const disposeHostContext = pi.events.on("pylon:host-context", (value: any) => {
    if (value?.version === 1 && value.host === "web") webHost = true;
  });
  pi.registerTool({
    name: "pylon_docs",
    label: "Pylon documentation",
    description:
      "Search, list, or read documentation shipped with Pylon and report whether the current host is Pylon Web or Pi TUI/RPC. Search uses case-insensitive literal keywords (all whitespace-separated terms must match a section's path, heading, or body), returning up to eight ranked sections with excerpts. Use it for questions about Pylon, bundled packages, settings, workflows, safety, storage, or troubleshooting.",
    promptSnippet: "Search host-aware Pylon and Pylon Web documentation on demand",
    promptGuidelines: [
      "For Pylon-specific questions, search for the relevant topic or list available docs, follow host guidance, and read matched documents when excerpts are insufficient. Follow cross-references only when needed to resolve the question; do not read every linked guide by default.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "list", "read"] },
        path: { type: "string", maxLength: 240 },
        query: { type: "string", minLength: 1, maxLength: 240 },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      if (params?.action !== "list" && params?.action !== "read" && params?.action !== "search") {
        return textResult("Pylon documentation request failed: action must be search, list, or read.");
      }
      const mode = typeof ctx?.mode === "string" ? ctx.mode : "unknown";
      const host = (webHost ? "web" : mode) as PylonDocsHost;
      const guidance = hostGuidance(host);
      if (params.action === "search" &&
        (typeof params.query !== "string" || !params.query.trim() || params.query.length > 240)) {
        return textResult(
          "Pylon documentation request failed: query must contain 1–240 characters, including a non-whitespace character.",
        );
      }
      const entries = await listPylonDocs(extensionUrl);
      if (params.action === "search") {
        const query = params.query.trim();
        const result = await searchPylonDocs(entries, query);
        return textResult(JSON.stringify({ host, guidance, query, ...result }, null, 2));
      }
      if (params.action === "list") {
        return textResult(
          JSON.stringify(
            {
              host,
              guidance,
              recommendedStart: host === "web" ? "docs/web/README.md" : "README.md",
              documents: entries.map(({ path, category }) => ({ path, category })),
            },
            null,
            2,
          ),
        );
      }
      if (typeof params.path !== "string") {
        return textResult("Pylon documentation request failed: path must come from a fresh list or search result.");
      }
      const entry = entries.find(item => item.path === params.path);
      if (!entry) return textResult("Pylon documentation request failed: path is unavailable; list docs again.");
      const related =
        host === "web" && entry.category === "package"
          ? "Consult relevant docs/web sections if Web-specific controls or surfaces are needed to answer the question."
          : undefined;
      return textResult(
        `${guidance}${related ? `\n${related}` : ""}\n\n---\n\n${await readFile(entry.absolutePath, "utf8")}`,
      );
    },
  } as any);

  return {
    sessionStart() {
      if (!deferred) return;
      registerToolPolicy(pi, {
        owner: "pylon-core",
        managedTools: ["pylon_docs"],
        enabledTools: ["pylon_docs"],
        deferredTools: ["pylon_docs"],
        toolUsage: { pylon_docs: "read shipped Pylon and Pylon Web documentation for product-specific questions" },
      });
    },
    shutdown() {
      disposeHostContext();
      if (deferred) unregisterToolPolicy(pi, "pylon-core");
    },
  };
}

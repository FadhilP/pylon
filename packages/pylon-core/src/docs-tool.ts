import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

type PylonDocsHost = "web" | "tui" | "rpc" | "json" | "print" | "unknown";

function hostGuidance(host: PylonDocsHost): string {
  if (host === "web") {
    return "Current host: Pylon Web. Prefer supported Web panels, Inspector references, and Settings actions; describe slash commands only as terminal alternatives. Read the relevant docs/web guide as well as any package README.";
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
      "List or read documentation shipped with Pylon and report whether the current host is Pylon Web or Pi TUI/RPC. Use it for questions about Pylon, bundled packages, settings, workflows, safety, storage, or troubleshooting.",
    promptSnippet: "Read host-aware Pylon and Pylon Web documentation on demand",
    promptGuidelines: [
      "For Pylon-specific questions, list Pylon docs, follow its host guidance, read the relevant Markdown files completely, and follow local cross-references before answering or implementing.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"] },
        path: { type: "string", maxLength: 240 },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      if (params?.action !== "list" && params?.action !== "read") {
        return textResult("Pylon documentation request failed: action must be list or read.");
      }
      const mode = typeof ctx?.mode === "string" ? ctx.mode : "unknown";
      const host = (webHost ? "web" : mode) as PylonDocsHost;
      const guidance = hostGuidance(host);
      const entries = await listPylonDocs(extensionUrl);
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
        return textResult("Pylon documentation request failed: path must come from a fresh list result.");
      }
      const entry = entries.find(item => item.path === params.path);
      if (!entry) return textResult("Pylon documentation request failed: path is unavailable; list docs again.");
      const related =
        host === "web" && entry.category === "package"
          ? "Before answering, also read the relevant docs/web guide for Web-specific controls and surfaces."
          : undefined;
      return textResult(`${guidance}${related ? `\n${related}` : ""}\n\n---\n\n${await readFile(entry.absolutePath, "utf8")}`);
    },
  } as any);

  return {
    sessionStart() {
      if (!deferred) return;
      pi.events.emit("pylon:tool-policy", {
        version: 1,
        kind: "register",
        owner: "pylon-core",
        managedTools: ["pylon_docs"],
        enabledTools: ["pylon_docs"],
        deferredTools: ["pylon_docs"],
        toolUsage: {
          pylon_docs: "read shipped Pylon and Pylon Web documentation for product-specific questions",
        },
        acknowledge() {},
      });
    },
    shutdown() {
      disposeHostContext();
      if (deferred) pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pylon-core" });
    },
  };
}

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BrowserSessionManager, type BrowserOperationResult } from "../src/browser-session.ts";
import { elementReferences, ELEMENT_REF_PATTERN } from "../src/element-ref.ts";
import { HeliosCliError, PlaywrightCli, type BrowserAction } from "../src/playwright-cli.ts";
import { PublicNetworkProxy, resolvePublicHost, validatePublicWebUrl } from "../src/public-proxy.ts";
import { consumeWebScoutGrant } from "../src/web-scout-grant.ts";

const parameters = Type.Object(
  {
    action: StringEnum(["navigate", "snapshot", "continue", "follow", "back"] as const),
    url: Type.Optional(Type.String({ maxLength: 2048, description: "Required only for navigate." })),
    target: Type.Optional(
      Type.String({
        pattern: ELEMENT_REF_PATTERN,
        maxLength: 32,
        description: "Required only for follow; use a link reference from the latest snapshot chunk.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        pattern: "^hc_[a-f0-9]{32}$",
        maxLength: 35,
        description: "Required only for continue; consume the latest continuation cursor immediately.",
      }),
    ),
  },
  { additionalProperties: false },
);

type BrowserParams = {
  action: "navigate" | "snapshot" | "continue" | "follow" | "back";
  url?: string;
  target?: string;
  cursor?: string;
};

function prepareArguments(args: unknown): BrowserParams {
  const input = args as BrowserParams;
  if (
    input?.action === "snapshot" &&
    typeof input.cursor === "string" &&
    input.url === undefined &&
    input.target === undefined
  ) {
    return { action: "continue", cursor: input.cursor };
  }
  return input;
}

function describe(
  result: BrowserOperationResult,
  pages: number,
  maxPages: number,
  actions: number,
  maxActions: number,
): string {
  const lines = [`Pages: ${pages}/${maxPages}. Actions: ${actions}/${maxActions}.`];
  if (result.page) lines.push(`Page: ${result.page.title} (${result.page.url})`);
  if (result.textContentType)
    lines.push(
      `Bounded text fallback: ${result.textContentType}${result.textContentTruncated ? " (source truncated)" : ""}.`,
    );
  if (result.snapshot) lines.push(`Snapshot:\n${result.snapshot}`);
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Snapshot truncated; ${result.snapshotOmittedLines ?? 0} lines remain.`);
  if (result.snapshotContinuation) lines.push(`Continuation: ${result.snapshotContinuation}`);
  if (result.metadataStale) lines.push("Page metadata cached.");
  else if (result.metadataAvailable === false) lines.push("Page metadata unavailable.");
  return lines.join("\n");
}

function snapshotArtifactFailure(error: unknown): boolean {
  return (
    error instanceof HeliosCliError && error.category === "invalid-output" && /snapshot artifact/i.test(error.message)
  );
}

const MAX_CURSOR_CONTEXTS = 20;

function capturedLinks(links: Record<string, string> | undefined, baseUrl: string | undefined): Map<string, string> {
  const captured = new Map<string, string>();
  if (!links || !baseUrl) return captured;
  for (const [ref, href] of Object.entries(links)) {
    try {
      captured.set(ref, new URL(href, baseUrl).href);
    } catch {}
  }
  return captured;
}

export default async function webScoutBrowserExtension(pi: ExtensionAPI, options: { persistentClient?: boolean } = {}) {
  const grant = await consumeWebScoutGrant();
  const proxy = await PublicNetworkProxy.start({
    maxRequests: Math.min(1_000, grant.maxActions * 20),
    maxBytes: 100 * 1024 * 1024,
  });
  const manager = new BrowserSessionManager(
    (command, args, options) => pi.exec(command, args, options),
    exec =>
      PlaywrightCli.create(exec, {
        maxSnapshotLines: 160,
        maxSnapshotBytes: 14 * 1024,
        maxActionSnapshotLines: 60,
        maxActionSnapshotBytes: 6 * 1024,
        persistentClient: options.persistentClient ?? true,
        preserveContinuationsAcrossActions: true,
      }),
  );
  const sessionId = `web-scout-${randomUUID()}`;
  let started = false;
  let pages = 0;
  let actions = 0;
  let linkRefs = new Set<string>();
  let capturedLinkUrls = new Map<string, string>();
  let canResolveLiveLinks = false;
  const cursorBaseUrls = new Map<string, string>();

  const ensureStarted = async (signal?: AbortSignal) => {
    if (started) return;
    await manager.start(sessionId, "about:blank", signal, grant.headed, { proxy: { server: proxy.serverUrl } });
    started = true;
  };
  const consumeAction = () => {
    actions++;
    if (actions > grant.maxActions) throw new Error("Web Scout action limit reached");
  };
  const ensurePageAvailable = () => {
    if (pages >= grant.maxPages) throw new Error("Web Scout page limit reached");
  };
  const publicUrl = async (value: string) => {
    const url = validatePublicWebUrl(value);
    await resolvePublicHost(url.hostname);
    return url.href;
  };
  const rememberCursor = (cursor: string, baseUrl: string) => {
    cursorBaseUrls.delete(cursor);
    cursorBaseUrls.set(cursor, baseUrl);
    while (cursorBaseUrls.size > MAX_CURSOR_CONTEXTS) cursorBaseUrls.delete(cursorBaseUrls.keys().next().value!);
  };
  const acceptSnapshot = async (
    result: BrowserOperationResult,
    signal?: AbortSignal,
    inheritedBaseUrl?: string,
  ): Promise<BrowserOperationResult> => {
    let baseUrl = inheritedBaseUrl;
    if (!baseUrl && (result.snapshotContinuation || result.snapshotLinks)) {
      try {
        baseUrl = (await manager.operate(sessionId, { kind: "base-url" }, signal)).baseUrl;
      } catch {
        baseUrl = result.page?.url;
      }
    }
    linkRefs = new Set(
      result.snapshot
        ?.split(/\r?\n/)
        .filter(line => /^\s*- link\b/i.test(line))
        .flatMap(elementReferences) ?? [],
    );
    capturedLinkUrls = capturedLinks(result.snapshotLinks, baseUrl);
    canResolveLiveLinks = inheritedBaseUrl === undefined;
    if (result.snapshotContinuation && baseUrl) rememberCursor(result.snapshotContinuation, baseUrl);
    return result;
  };
  const snapshot = async (signal?: AbortSignal) =>
    acceptSnapshot(await manager.operate(sessionId, { kind: "snapshot", depth: 6 }, signal), signal);
  const observePage = async (action: BrowserAction, signal?: AbortSignal): Promise<BrowserOperationResult> => {
    try {
      const changed = await manager.operate(sessionId, action, signal);
      return changed.snapshot === undefined ? await snapshot(signal) : await acceptSnapshot(changed, signal);
    } catch (error) {
      if (!snapshotArtifactFailure(error)) throw error;
      try {
        return await acceptSnapshot(await manager.operate(sessionId, { kind: "page-text" }, signal), signal);
      } catch (fallbackError) {
        if (fallbackError instanceof HeliosCliError && fallbackError.category === "invalid-output") throw error;
        throw fallbackError;
      }
    }
  };
  const response = (action: string, result: BrowserOperationResult) => ({
    content: [{ type: "text" as const, text: describe(result, pages, grant.maxPages, actions, grant.maxActions) }],
    details: {
      action,
      pages,
      actions,
      page: result.page,
      truncated: result.snapshotTruncated,
      continuation: result.snapshotContinuation,
      redactions: result.snapshotRedactions,
      textContentType: result.textContentType,
      textContentTruncated: result.textContentTruncated,
    },
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
    await proxy.close();
  });

  pi.registerTool({
    name: "scout_browser",
    label: "Web Scout Browser",
    description:
      "Navigate an isolated public-web browser, read bounded snapshots, follow current link references, or go back. Public HTTP(S) only; no private networks, user browser attachment, arbitrary clicks, forms, scripts, storage, uploads, downloads, or screenshots.",
    promptSnippet: "Read public web pages through isolated bounded browser navigation",
    promptGuidelines: [
      "Use scout_browser only for the supplied Web Scout research task. Prefer direct authoritative URLs and rendered HTML pages. When a snapshot is truncated, immediately call continue with its cursor before any navigation or new snapshot; never pass a cursor to snapshot. Follow only link refs from the latest chunk. Never attempt login, account, purchase, messaging, publishing, permissions, or destructive workflows.",
    ],
    parameters,
    prepareArguments,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = params as BrowserParams;
      consumeAction();
      await ensureStarted(signal);
      if (input.action === "navigate") {
        if (!input.url) throw new Error("navigate requires url");
        if (input.target !== undefined || input.cursor !== undefined) throw new Error("navigate accepts only url");
        ensurePageAvailable();
        const url = await publicUrl(input.url);
        const result = await observePage({ kind: "navigate", url }, signal);
        pages++;
        return response(input.action, result);
      }
      if (input.url !== undefined) throw new Error(`${input.action} does not accept url`);
      if (input.action === "continue") {
        if (!input.cursor) throw new Error("continue requires cursor");
        if (input.target !== undefined) throw new Error("continue does not accept target");
        const baseUrl = cursorBaseUrls.get(input.cursor);
        cursorBaseUrls.delete(input.cursor);
        if (!baseUrl) throw new Error("Snapshot continuation cursor is stale; request one new snapshot");
        const result = await manager.operate(sessionId, { kind: "continue", cursor: input.cursor }, signal);
        return response(input.action, await acceptSnapshot(result, signal, baseUrl));
      }
      if (input.cursor !== undefined) throw new Error(`${input.action} does not accept cursor`);
      if (input.action === "follow") {
        if (!input.target) throw new Error("follow requires target");
        if (!linkRefs.has(input.target)) throw new Error("follow target must be a link reference from latest snapshot");
        let capturedUrl = capturedLinkUrls.get(input.target);
        if (!capturedUrl && canResolveLiveLinks) {
          capturedUrl = (await manager.operate(sessionId, { kind: "link-url", target: input.target }, signal))
            .resolvedUrl;
        }
        if (!capturedUrl) throw new Error("Link has no public navigation URL");
        ensurePageAvailable();
        const url = await publicUrl(capturedUrl);
        const result = await observePage({ kind: "navigate", url }, signal);
        pages++;
        return response(input.action, result);
      }
      if (input.action === "back") {
        if (input.target !== undefined) throw new Error("back does not accept target");
        ensurePageAvailable();
        const result = await observePage({ kind: "back" }, signal);
        pages++;
        return response(input.action, result);
      }
      if (input.action !== "snapshot") throw new Error("Unsupported Web Scout browser action");
      if (input.target !== undefined) throw new Error("snapshot does not accept target");
      return response(input.action, await snapshot(signal));
    },
  });
}

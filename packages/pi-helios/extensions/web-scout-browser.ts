import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BrowserSessionManager, type BrowserOperationResult } from "../src/browser-session.ts";
import { PlaywrightCli } from "../src/playwright-cli.ts";
import { PublicNetworkProxy, resolvePublicHost, validatePublicWebUrl } from "../src/public-proxy.ts";
import { consumeWebScoutGrant } from "../src/web-scout-grant.ts";

function describe(result: BrowserOperationResult, pages: number, maxPages: number, actions: number, maxActions: number): string {
  const lines = [`Pages: ${pages}/${maxPages}. Actions: ${actions}/${maxActions}.`];
  if (result.page) lines.push(`Page: ${result.page.title} (${result.page.url})`);
  if (result.snapshot) lines.push(`Snapshot:\n${result.snapshot}`);
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Snapshot truncated; omitted ${result.snapshotOmittedLines ?? 0} lines.`);
  if (result.metadataStale) lines.push("Page metadata cached.");
  else if (result.metadataAvailable === false) lines.push("Page metadata unavailable.");
  return lines.join("\n");
}

export default async function webScoutBrowserExtension(pi: ExtensionAPI) {
  const grant = await consumeWebScoutGrant();
  const proxy = await PublicNetworkProxy.start({ maxRequests: Math.min(1_000, grant.maxActions * 20), maxBytes: 100 * 1024 * 1024 });
  const manager = new BrowserSessionManager(
    (command, args, options) => pi.exec(command, args, options),
    (exec) => PlaywrightCli.create(exec, { maxSnapshotLines: 250, maxSnapshotBytes: 20 * 1024 }),
  );
  const sessionId = `web-scout-${randomUUID()}`;
  let started = false;
  let pages = 0;
  let actions = 0;
  let linkRefs = new Set<string>();

  const ensureStarted = async (signal?: AbortSignal) => {
    if (started) return;
    await manager.start(sessionId, "about:blank", signal, grant.headed, {
      proxy: { server: proxy.serverUrl, username: proxy.username, password: proxy.password },
    });
    started = true;
  };
  const consumeAction = () => {
    actions++;
    if (actions > grant.maxActions) throw new Error("Web Scout action limit reached");
  };
  const consumePage = () => {
    pages++;
    if (pages > grant.maxPages) throw new Error("Web Scout page limit reached");
  };
  const publicUrl = async (value: string) => {
    const url = validatePublicWebUrl(value);
    await resolvePublicHost(url.hostname);
    return url.href;
  };
  const acceptSnapshot = (result: BrowserOperationResult) => {
    linkRefs = new Set(result.snapshot?.split(/\r?\n/)
      .filter((line) => /\blink\b/i.test(line))
      .flatMap((line) => line.match(/\bref=(e\d+)\b/g)?.map((item) => item.slice(4)) ?? []) ?? []);
    return result;
  };
  const snapshot = async (signal?: AbortSignal) => acceptSnapshot(await manager.operate(sessionId, { kind: "snapshot", depth: 6 }, signal));
  const actionSnapshot = async (result: BrowserOperationResult, signal?: AbortSignal) => result.snapshot === undefined ? snapshot(signal) : acceptSnapshot(result);
  const response = (action: string, result: BrowserOperationResult) => ({
    content: [{ type: "text" as const, text: describe(result, pages, grant.maxPages, actions, grant.maxActions) }],
    details: { action, pages, actions, page: result.page, truncated: result.snapshotTruncated, redactions: result.snapshotRedactions },
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
    await proxy.close();
  });

  pi.registerTool({
    name: "scout_browser",
    label: "Web Scout Browser",
    description: "Navigate an isolated public-web browser, read bounded snapshots, follow current link references, or go back. Public HTTP(S) only; no private networks, user browser attachment, arbitrary clicks, forms, scripts, storage, uploads, downloads, or screenshots.",
    promptSnippet: "Read public web pages through isolated bounded browser navigation",
    promptGuidelines: [
      "Use scout_browser only for supplied Web Scout research task. Prefer direct public URLs, snapshot before following links, follow only link refs from latest snapshot, never attempt login, account, purchase, messaging, publishing, permissions, or destructive workflows.",
    ],
    parameters: Type.Object({
      action: StringEnum(["navigate", "snapshot", "follow", "back"] as const),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
      target: Type.Optional(Type.String({ pattern: "^e[0-9]+$", maxLength: 32 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      consumeAction();
      await ensureStarted(signal);
      if (params.action === "navigate") {
        if (!params.url) throw new Error("navigate requires url");
        if (params.target !== undefined) throw new Error("navigate does not accept target");
        const url = await publicUrl(params.url);
        consumePage();
        const navigated = await manager.operate(sessionId, { kind: "navigate", url }, signal);
        const result = await actionSnapshot(navigated, signal);
        return response(params.action, result);
      }
      if (params.url !== undefined) throw new Error(`${params.action} does not accept url`);
      let actionResult: BrowserOperationResult | undefined;
      if (params.action === "follow") {
        if (!params.target) throw new Error("follow requires target");
        if (!linkRefs.has(params.target)) throw new Error("follow target must be a link reference from latest snapshot");
        const href = await manager.operate(sessionId, { kind: "link-url", target: params.target }, signal);
        if (!href.resolvedUrl) throw new Error("Link has no public navigation URL");
        const url = await publicUrl(href.resolvedUrl);
        consumePage();
        actionResult = await manager.operate(sessionId, { kind: "navigate", url }, signal);
      } else if (params.action === "back") {
        if (params.target !== undefined) throw new Error("back does not accept target");
        consumePage();
        actionResult = await manager.operate(sessionId, { kind: "back" }, signal);
      } else {
        if (params.target !== undefined) throw new Error("snapshot does not accept target");
      }
      const result = actionResult ? await actionSnapshot(actionResult, signal) : await snapshot(signal);
      return response(params.action, result);
    },
  });
}

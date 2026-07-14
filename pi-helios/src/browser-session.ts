import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./capture.ts";
import { loopbackUrl } from "./capture.ts";
import { PlaywrightCli, type BrowserAction, type BrowserOwnership, type CliResult } from "./playwright-cli.ts";

export type BrowserState = "starting" | "ready" | "cleanup-required" | "closing" | "closed";

export interface BrowserSessionRecord {
  piSessionId: string;
  cliSessionName: string;
  ownership: BrowserOwnership;
  state: BrowserState;
  activeTab?: number;
  endpoint?: string;
  profileDirectory?: string;
  capabilities: { observe: true; interact: true };
  createdAt: number;
}

export interface PageIdentity {
  index: number;
  title: string;
  url: string;
}

export interface BrowserOperationResult {
  action: string;
  ownership: BrowserOwnership;
  outcome: "completed";
  durationMs?: number;
  metadataAvailable?: boolean;
  page?: PageIdentity;
  tabs?: PageIdentity[];
  snapshot?: string;
  snapshotRedactions?: number;
  snapshotTruncated?: boolean;
  snapshotOmittedLines?: number;
  snapshotOmittedBytes?: number;
  resolvedUrl?: string;
  artifactPath?: string;
  cleanupWarnings?: string[];
}

export interface BrowserShutdownResult {
  failures: Array<{ ownership: BrowserOwnership; action: "close" | "detach" }>;
  cleanupWarnings: string[];
}

type CliFactory = (exec: Exec) => Promise<PlaywrightCli>;
interface Managed { record: BrowserSessionRecord; cli: PlaywrightCli; tail: Promise<void>; references: Set<string>; closingRequested: boolean }

export function cliSessionName(piSessionId: string): string {
  const hash = createHash("sha256").update(piSessionId).digest("hex").slice(0, 12);
  return `helios-${hash}-${randomBytes(6).toString("hex")}`;
}

export function validateCdpEndpoint(value: string): string {
  const url = loopbackUrl(value, ["http:"]);
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("CDP endpoint must be a loopback HTTP origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function resultText(value: Record<string, unknown>): string | undefined {
  if (typeof value.result === "string") return value.result;
  return undefined;
}

export function parseTabs(text: string | undefined): PageIdentity[] {
  if (!text) return [];
  const tabs: PageIdentity[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- (\d+): (?:\(current\) )?\[(.*)\]\((.*)\)$/);
    if (match) tabs.push({ index: Number(match[1]), title: match[2] || "Untitled tab", url: match[3] });
  }
  return tabs;
}

function currentTab(text: string | undefined): PageIdentity | undefined {
  if (!text) return undefined;
  const line = text.split(/\r?\n/).find((item) => item.includes("(current)"));
  return parseTabs(line)[0];
}

function listedBrowsers(value: Record<string, unknown>): Array<{ name: string; status: string }> | undefined {
  if (!Array.isArray(value.browsers)) return undefined;
  const browsers: Array<{ name: string; status: string }> = [];
  for (const item of value.browsers) {
    if (!item || typeof item !== "object") return undefined;
    const browser = item as Record<string, unknown>;
    if (typeof browser.name !== "string" || typeof browser.status !== "string") return undefined;
    browsers.push({ name: browser.name, status: browser.status });
  }
  return browsers;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, Managed>();
  private readonly exec: Exec;
  private readonly createCli: CliFactory;

  constructor(exec: Exec, createCli: CliFactory = PlaywrightCli.create) {
    this.exec = exec;
    this.createCli = createCli;
  }

  get(piSessionId: string): BrowserSessionRecord | undefined {
    const record = this.sessions.get(piSessionId)?.record;
    return record ? { ...record, capabilities: { ...record.capabilities } } : undefined;
  }

  summary(): { total: number; owned: number; attached: number; cleanupRequired: number } {
    const records = [...this.sessions.values()].map((item) => item.record);
    return {
      total: records.length,
      owned: records.filter((item) => item.ownership === "owned").length,
      attached: records.filter((item) => item.ownership !== "owned").length,
      cleanupRequired: records.filter((item) => item.state === "cleanup-required").length,
    };
  }

  async start(piSessionId: string, url?: string, signal?: AbortSignal, headed = true, webIsolation?: { proxy: { server: string; username: string; password: string } }): Promise<BrowserOperationResult> {
    if (this.sessions.has(piSessionId)) throw new Error("Pi session already has an active Helios browser session");
    const cli = await this.createCli(this.exec);
    const record: BrowserSessionRecord = {
      piSessionId,
      cliSessionName: cliSessionName(piSessionId),
      ownership: "owned",
      state: "starting",
      profileDirectory: join(cli.directory, "profile"),
      capabilities: { observe: true, interact: true },
      createdAt: Date.now(),
    };
    const managed: Managed = { record, cli, tail: Promise.resolve(), references: new Set(), closingRequested: false };
    this.sessions.set(piSessionId, managed);
    const startedAt = Date.now();
    try {
      await cli.configureOwned(record.profileDirectory!, headed, webIsolation);
      const result = await cli.run(record.cliSessionName, { kind: "open", url, profileDirectory: record.profileDirectory!, headed }, signal);
      record.state = "ready";
      return await this.envelope(managed, "start", result, signal, false, startedAt);
    } catch (error) {
      const cleaned = await this.cleanupUncertainStart(managed, "close");
      if (!cleaned && error instanceof Error) error.message += "; browser cleanup is uncertain, retry close";
      throw error;
    }
  }

  async attachCdp(piSessionId: string, endpoint: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    return this.attach(piSessionId, "cdp-attached", { kind: "attach-cdp", endpoint: validateCdpEndpoint(endpoint) }, signal);
  }

  async attachExtension(piSessionId: string, browser: "chrome" | "msedge", signal?: AbortSignal): Promise<BrowserOperationResult> {
    return this.attach(piSessionId, "extension-attached", { kind: "attach-extension", browser }, signal);
  }

  private async attach(piSessionId: string, ownership: Exclude<BrowserOwnership, "owned">, action: BrowserAction, signal?: AbortSignal): Promise<BrowserOperationResult> {
    if (this.sessions.has(piSessionId)) throw new Error("Pi session already has an active Helios browser session");
    const cli = await this.createCli(this.exec);
    const record: BrowserSessionRecord = {
      piSessionId,
      cliSessionName: cliSessionName(piSessionId),
      ownership,
      state: "starting",
      endpoint: action.kind === "attach-cdp" ? action.endpoint : undefined,
      capabilities: { observe: true, interact: true },
      createdAt: Date.now(),
    };
    const managed: Managed = { record, cli, tail: Promise.resolve(), references: new Set(), closingRequested: false };
    this.sessions.set(piSessionId, managed);
    const startedAt = Date.now();
    try {
      const result = await cli.run(record.cliSessionName, action, signal);
      record.state = "ready";
      return await this.envelope(managed, "attach", result, signal, false, startedAt);
    } catch (error) {
      const cleaned = await this.cleanupUncertainStart(managed, "detach");
      if (!cleaned && error instanceof Error) error.message += "; browser cleanup is uncertain, retry detach";
      throw error;
    }
  }

  async operate(piSessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session; use start or attach first");
    if (managed.record.state !== "ready" || managed.closingRequested) throw new Error(`Browser session is ${managed.closingRequested ? "closing" : managed.record.state}`);
    if (action.kind === "open" || action.kind.startsWith("attach-") || action.kind === "close" || action.kind === "detach" || action.kind === "list") {
      throw new Error("Unsupported browser operation for active session");
    }
    return this.serialized(managed, async () => {
      const startedAt = Date.now();
      if (this.sessions.get(piSessionId) !== managed || managed.record.state !== "ready") throw new Error(`Browser session is ${managed.record.state}`);
      await this.ensureLive(managed, signal);
      this.validateReference(managed, action);
      let result: CliResult;
      try {
        result = await managed.cli.run(managed.record.cliSessionName, action, signal);
      } catch (error) {
        if (this.invalidatesReferences(action)) managed.references.clear();
        throw error;
      }
      this.updateReferences(managed, action, result.snapshot);
      try {
        return await this.envelope(managed, action.kind, result, signal, action.kind === "tab-list", startedAt);
      } catch (error) {
        if (result.artifactPath) await rm(result.artifactPath, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async close(piSessionId: string, requested: "close" | "detach", signal?: AbortSignal): Promise<BrowserOperationResult> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session");
    if (requested === "close" && managed.record.ownership !== "owned") throw new Error("Attached browsers may only be detached");
    if (requested === "detach" && managed.record.ownership === "owned") throw new Error("Owned browsers must be closed");
    if (managed.closingRequested) throw new Error("Browser session is closing");
    managed.closingRequested = true;
    return this.serialized(managed, async () => {
      const startedAt = Date.now();
      managed.record.state = "closing";
      const cleanup = await this.runCleanup(managed, requested, signal);
      if (!cleanup.cleaned) {
        managed.record.state = "cleanup-required";
        managed.closingRequested = false;
        throw cleanup.error;
      }
      managed.record.state = "closed";
      this.sessions.delete(piSessionId);
      const cleanupWarnings: string[] = [];
      await managed.cli.dispose().catch(() => cleanupWarnings.push("Could not delete private browser directory"));
      return {
        action: requested,
        ownership: managed.record.ownership,
        outcome: "completed",
        durationMs: Date.now() - startedAt,
        cleanupWarnings: cleanupWarnings.length ? cleanupWarnings : undefined,
      };
    });
  }

  async shutdown(): Promise<BrowserShutdownResult> {
    const summary: BrowserShutdownResult = { failures: [], cleanupWarnings: [] };
    const sessions = [...this.sessions.values()];
    for (const managed of sessions) managed.closingRequested = true;
    await Promise.all(sessions.map(async (managed) => {
      await this.serialized(managed, async () => {
        if (managed.record.state === "closed") return;
        const action = managed.record.ownership === "owned" ? "close" : "detach";
        managed.record.state = "closing";
        const cleanup = await this.runCleanup(managed, action);
        if (!cleanup.cleaned) {
          managed.record.state = "cleanup-required";
          managed.closingRequested = false;
          summary.failures.push({ ownership: managed.record.ownership, action });
          return;
        }
        managed.record.state = "closed";
        this.sessions.delete(managed.record.piSessionId);
        await managed.cli.dispose().catch(() => summary.cleanupWarnings.push("Could not delete private browser directory"));
      });
    }));
    return summary;
  }

  private validateReference(managed: Managed, action: BrowserAction): void {
    if (!("target" in action) || !action.target) return;
    if (!managed.references.has(action.target)) throw new Error(`Element reference ${action.target} is stale or was not returned by latest snapshot`);
  }

  private invalidatesReferences(action: BrowserAction): boolean {
    return ["navigate", "click", "fill", "press", "hover", "select", "check", "uncheck", "back", "forward", "reload", "tab-new", "tab-select", "tab-close"].includes(action.kind);
  }

  private updateReferences(managed: Managed, action: BrowserAction, snapshot?: string): void {
    if (action.kind === "snapshot") {
      managed.references = new Set(snapshot?.match(/\bref=(e\d+)\b/g)?.map((item) => item.slice(4)) ?? []);
      return;
    }
    if (this.invalidatesReferences(action)) managed.references.clear();
  }

  private async ensureLive(managed: Managed, signal?: AbortSignal): Promise<void> {
    const listed = await managed.cli.run(managed.record.cliSessionName, { kind: "list" }, signal);
    const browsers = listedBrowsers(listed.value);
    if (!browsers) {
      managed.record.state = "cleanup-required";
      throw new Error("Playwright CLI returned an invalid browser session list");
    }
    const live = browsers.some((item) => item.name === managed.record.cliSessionName && item.status === "open");
    if (!live) {
      managed.record.state = "cleanup-required";
      throw new Error("Helios browser session is stale; close or detach, then start again");
    }
  }

  private async runCleanup(managed: Managed, action: "close" | "detach", signal?: AbortSignal): Promise<{ cleaned: boolean; error?: unknown }> {
    try {
      await managed.cli.run(managed.record.cliSessionName, { kind: action }, signal);
      return { cleaned: true };
    } catch (error) {
      try {
        const listed = await managed.cli.run(managed.record.cliSessionName, { kind: "list" });
        const browsers = listedBrowsers(listed.value);
        if (browsers && !browsers.some((item) => item.name === managed.record.cliSessionName)) return { cleaned: true };
      } catch {}
      return { cleaned: false, error };
    }
  }

  private async cleanupUncertainStart(managed: Managed, action: "close" | "detach"): Promise<boolean> {
    const cleanup = await this.runCleanup(managed, action);
    if (!cleanup.cleaned) {
      managed.record.state = "cleanup-required";
      return false;
    }
    managed.record.state = "closed";
    this.sessions.delete(managed.record.piSessionId);
    await managed.cli.dispose().catch(() => {});
    return true;
  }

  private async envelope(managed: Managed, action: string, result: CliResult, signal?: AbortSignal, includeTabs = false, startedAt = Date.now()): Promise<BrowserOperationResult> {
    let tabResult: CliResult | undefined;
    let metadataAvailable = true;
    if (action === "tab-list") tabResult = result;
    else {
      try { tabResult = await managed.cli.run(managed.record.cliSessionName, { kind: "tab-list" }, signal); }
      catch { metadataAvailable = false; }
    }
    const text = resultText(tabResult?.value ?? {});
    const parsedTabs = parseTabs(text);
    const page = currentTab(text);
    if (!text || !page || parsedTabs.length === 0) metadataAvailable = false;
    if (page) managed.record.activeTab = page.index;
    return {
      action,
      ownership: managed.record.ownership,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
      metadataAvailable,
      page,
      tabs: includeTabs ? parsedTabs : undefined,
      snapshot: result.snapshot,
      snapshotRedactions: result.snapshotRedactions,
      snapshotTruncated: result.snapshotTruncated,
      snapshotOmittedLines: result.snapshotOmittedLines,
      snapshotOmittedBytes: result.snapshotOmittedBytes,
      resolvedUrl: action === "link-url" ? resultText(result.value) : undefined,
      artifactPath: result.artifactPath,
    };
  }

  private serialized<T>(managed: Managed, operation: () => Promise<T>): Promise<T> {
    const result = managed.tail.then(operation, operation);
    managed.tail = result.then(() => {}, () => {});
    return result;
  }
}

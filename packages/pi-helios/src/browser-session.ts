import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./capture.ts";
import { loopbackUrl } from "./capture.ts";
import { elementReferences } from "./element-ref.ts";
import { HeliosCliError, PlaywrightCli, type BrowserAction, type BrowserOwnership, type CliResult } from "./playwright-cli.ts";

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
  metadataStale?: boolean;
  page?: PageIdentity;
  tabs?: PageIdentity[];
  snapshot?: string;
  snapshotRedactions?: number;
  snapshotTruncated?: boolean;
  snapshotOmittedLines?: number;
  snapshotOmittedBytes?: number;
  findMatches?: number;
  snapshotContinuation?: string;
  resolvedUrl?: string;
  artifactPath?: string;
  cleanupWarnings?: string[];
}

export interface BrowserShutdownResult {
  failures: Array<{ ownership: BrowserOwnership; action: "close" | "detach" }>;
  cleanupWarnings: string[];
}

type CliFactory = (exec: Exec) => Promise<PlaywrightCli>;
interface Managed {
  record: BrowserSessionRecord;
  cli: PlaywrightCli;
  tail: Promise<void>;
  references: Set<string>;
  closingRequested: boolean;
  interactiveOwner?: string;
  interactiveTimer?: NodeJS.Timeout;
  interactiveEpoch: number;
  heldButtons: Set<"left" | "middle" | "right">;
  heldKeys: Set<string>;
  pendingOperations: number;
  page?: PageIdentity;
  tabs?: PageIdentity[];
}

export interface InteractiveBrowserState {
  active: boolean;
  ownership?: BrowserOwnership;
  state?: BrowserState;
  controlled: boolean;
  page?: PageIdentity;
  tabs?: PageIdentity[];
}

const INTERACTIVE_LEASE_IDLE_MS = 5_000;
const METADATA_ACTIONS = new Set(["start", "attach", "navigate", "click", "press", "back", "forward", "reload", "tab-list", "tab-new", "tab-select", "tab-close"]);

function sessionMissing(error: unknown): boolean {
  return error instanceof HeliosCliError && error.category === "session-missing";
}

function staleSessionError(): Error {
  return new Error("Helios browser session is stale; close or detach, then start again");
}

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
  private readonly interactiveLeaseIdleMs: number;

  constructor(exec: Exec, createCli: CliFactory = PlaywrightCli.create, interactiveLeaseIdleMs = INTERACTIVE_LEASE_IDLE_MS) {
    this.exec = exec;
    this.createCli = createCli;
    this.interactiveLeaseIdleMs = interactiveLeaseIdleMs;
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

  async start(piSessionId: string, url?: string, signal?: AbortSignal, headed = false, webIsolation?: { proxy: { server: string; username: string; password: string } }): Promise<BrowserOperationResult> {
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
    const managed: Managed = { record, cli, tail: Promise.resolve(), references: new Set(), closingRequested: false, interactiveEpoch: 0, heldButtons: new Set(), heldKeys: new Set(), pendingOperations: 0 };
    this.sessions.set(piSessionId, managed);
    const startedAt = Date.now();
    try {
      await cli.configureOwned(record.profileDirectory!, headed, webIsolation);
      const action = { kind: "open", url, profileDirectory: record.profileDirectory!, headed } as const;
      const result = await cli.run(record.cliSessionName, action, signal);
      record.state = "ready";
      this.updateReferences(managed, action, result.snapshot);
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
    const managed: Managed = { record, cli, tail: Promise.resolve(), references: new Set(), closingRequested: false, interactiveEpoch: 0, heldButtons: new Set(), heldKeys: new Set(), pendingOperations: 0 };
    this.sessions.set(piSessionId, managed);
    const startedAt = Date.now();
    try {
      const result = await cli.run(record.cliSessionName, action, signal);
      record.state = "ready";
      this.updateReferences(managed, action, result.snapshot);
      return await this.envelope(managed, "attach", result, signal, false, startedAt);
    } catch (error) {
      const cleaned = await this.cleanupUncertainStart(managed, "detach");
      if (!cleaned && error instanceof Error) error.message += "; browser cleanup is uncertain, retry detach";
      throw error;
    }
  }

  async readArtifact(piSessionId: string, path: string, maximumBytes: number): Promise<Buffer> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session");
    return managed.cli.readArtifact(path, maximumBytes);
  }

  state(piSessionId: string, owner?: string): InteractiveBrowserState {
    const managed = this.sessions.get(piSessionId);
    if (!managed) return { active: false, controlled: false };
    return {
      active: true,
      ownership: managed.record.ownership,
      state: managed.record.state,
      controlled: Boolean(owner && managed.interactiveOwner === owner),
      page: managed.page && { ...managed.page },
      tabs: managed.tabs?.map((tab) => ({ ...tab })),
    };
  }

  async acquireInteractive(piSessionId: string, owner: string): Promise<InteractiveBrowserState> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session");
    return this.serialized(managed, async () => {
      if (managed.record.ownership !== "owned") throw new Error("Embedded control is available only for Helios-owned browsers");
      if (managed.record.state !== "ready" || managed.closingRequested) throw new Error(`Browser session is ${managed.record.state}`);
      if (managed.interactiveOwner && managed.interactiveOwner !== owner) throw new Error("Helios browser is controlled by another Pylon tab");
      if (!managed.interactiveOwner && !await this.releaseHeldInput(managed)) throw new Error("Helios could not reset prior browser input; close the browser session");
      managed.interactiveOwner = owner;
      this.renewInteractive(managed, owner);
      return this.state(piSessionId, owner);
    });
  }

  async releaseInteractive(piSessionId: string, owner: string): Promise<InteractiveBrowserState> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) return { active: false, controlled: false };
    return this.serialized(managed, async () => {
      if (managed.interactiveOwner !== owner) return this.state(piSessionId, owner);
      if (!await this.releaseHeldInput(managed)) {
        this.renewInteractive(managed, owner);
        throw new Error("Helios could not release browser input; retry release or close the browser");
      }
      this.clearInteractive(managed);
      return this.state(piSessionId, owner);
    });
  }

  async operate(piSessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const managed = this.requireManaged(piSessionId, action);
    return this.serialized(managed, async () => {
      if (managed.interactiveOwner) throw new Error("Helios browser is under direct user control in Pylon");
      if (!await this.releaseHeldInput(managed)) throw new Error("Helios could not reset prior browser input; close the browser session");
      return this.performOperation(managed, action, signal);
    });
  }

  async observeFrame(piSessionId: string, signal?: AbortSignal): Promise<BrowserOperationResult | undefined> {
    const managed = this.requireManaged(piSessionId, { kind: "screenshot" });
    if (managed.record.ownership !== "owned") throw new Error("Embedded mirroring is available only for Helios-owned browsers");
    if (managed.interactiveOwner || managed.pendingOperations) return undefined;
    return this.serialized(managed, () => this.performOperation(managed, { kind: "screenshot" }, signal));
  }

  async operateInteractive(piSessionId: string, actions: BrowserAction[], owner: string, signal?: AbortSignal): Promise<BrowserOperationResult[]> {
    if (!actions.length || actions.length > 4) throw new Error("Interactive browser request must contain 1 to 4 actions");
    const managed = this.requireManaged(piSessionId, actions[0]);
    return this.serialized(managed, async () => {
      if (managed.record.ownership !== "owned" || managed.interactiveOwner !== owner) throw new Error("Embedded browser control lease is not active");
      this.renewInteractive(managed, owner);
      try {
        const results: BrowserOperationResult[] = [];
        for (const action of actions) results.push(await this.performOperation(managed, action, signal));
        return results;
      } finally {
        if (managed.interactiveOwner === owner) this.renewInteractive(managed, owner);
      }
    });
  }

  async close(piSessionId: string, requested: "close" | "detach", signal?: AbortSignal, owner?: string): Promise<BrowserOperationResult> {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session");
    if (requested === "close" && managed.record.ownership !== "owned") throw new Error("Attached browsers may only be detached");
    if (requested === "detach" && managed.record.ownership === "owned") throw new Error("Owned browsers must be closed");
    if (managed.interactiveOwner && managed.interactiveOwner !== owner) throw new Error("Helios browser is under direct user control in Pylon");
    if (managed.closingRequested) throw new Error("Browser session is closing");
    managed.closingRequested = true;
    return this.serialized(managed, async () => {
      const startedAt = Date.now();
      await this.releaseHeldInput(managed);
      this.clearInteractive(managed);
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
        await this.releaseHeldInput(managed);
        this.clearInteractive(managed);
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

  private requireManaged(piSessionId: string, action: BrowserAction): Managed {
    const managed = this.sessions.get(piSessionId);
    if (!managed) throw new Error("No active Helios browser session; use start or attach first");
    if (managed.record.state !== "ready" || managed.closingRequested) throw new Error(`Browser session is ${managed.closingRequested ? "closing" : managed.record.state}`);
    if (action.kind === "open" || action.kind.startsWith("attach-") || action.kind === "close" || action.kind === "detach" || action.kind === "list") {
      throw new Error("Unsupported browser operation for active session");
    }
    return managed;
  }

  private async performOperation(managed: Managed, action: BrowserAction, signal?: AbortSignal): Promise<BrowserOperationResult> {
    if (this.sessions.get(managed.record.piSessionId) !== managed || managed.record.state !== "ready") throw new Error(`Browser session is ${managed.record.state}`);
    if (action.kind === "open" || action.kind.startsWith("attach-") || action.kind === "close" || action.kind === "detach" || action.kind === "list") {
      throw new Error("Unsupported browser operation for active session");
    }
    const startedAt = Date.now();
    this.validateReference(managed, action);
    if (action.kind === "mouse-down") managed.heldButtons.add(action.button);
    if (action.kind === "key-down") managed.heldKeys.add(action.key);
    let result: CliResult;
    try {
      result = await managed.cli.run(managed.record.cliSessionName, action, signal);
    } catch (error) {
      if (sessionMissing(error)) {
        managed.record.state = "cleanup-required";
        managed.references.clear();
        throw staleSessionError();
      }
      if (this.invalidatesReferences(action)) managed.references.clear();
      throw error;
    }
    this.updateReferences(managed, action, result.snapshot);
    if (action.kind === "mouse-up") managed.heldButtons.delete(action.button);
    if (action.kind === "key-up") managed.heldKeys.delete(action.key);
    try {
      return await this.envelope(managed, action.kind, result, signal, action.kind === "tab-list", startedAt);
    } catch (error) {
      if (result.artifactPath) await rm(result.artifactPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private renewInteractive(managed: Managed, owner: string): void {
    if (managed.interactiveTimer) clearTimeout(managed.interactiveTimer);
    const epoch = ++managed.interactiveEpoch;
    managed.interactiveTimer = setTimeout(() => {
      void this.expireInteractive(managed, owner, epoch);
    }, this.interactiveLeaseIdleMs);
    managed.interactiveTimer.unref?.();
  }

  private async expireInteractive(managed: Managed, owner: string, epoch: number): Promise<void> {
    await this.serialized(managed, async () => {
      if (managed.interactiveOwner !== owner || managed.interactiveEpoch !== epoch) return;
      if (!await this.releaseHeldInput(managed)) {
        this.renewInteractive(managed, owner);
        return;
      }
      this.clearInteractive(managed);
    });
  }

  private clearInteractive(managed: Managed): void {
    if (managed.interactiveTimer) clearTimeout(managed.interactiveTimer);
    managed.interactiveTimer = undefined;
    managed.interactiveOwner = undefined;
  }

  private async releaseHeldInput(managed: Managed): Promise<boolean> {
    for (const button of [...managed.heldButtons]) {
      try {
        await managed.cli.run(managed.record.cliSessionName, { kind: "mouse-up", button });
        managed.heldButtons.delete(button);
      } catch {}
    }
    for (const key of [...managed.heldKeys]) {
      try {
        await managed.cli.run(managed.record.cliSessionName, { kind: "key-up", key });
        managed.heldKeys.delete(key);
      } catch {}
    }
    return managed.heldButtons.size === 0 && managed.heldKeys.size === 0;
  }

  private validateReference(managed: Managed, action: BrowserAction): void {
    if (!("target" in action) || !action.target) return;
    if (!managed.references.has(action.target)) throw new Error(`Element reference ${action.target} is stale or was not returned by latest snapshot`);
  }

  private invalidatesReferences(action: BrowserAction): boolean {
    return ["navigate", "click", "fill", "press", "hover", "select", "check", "uncheck", "back", "forward", "reload", "tab-new", "tab-select", "tab-close"].includes(action.kind);
  }

  private updateReferences(managed: Managed, action: BrowserAction, snapshot?: string): void {
    if (snapshot !== undefined) {
      managed.references = new Set(elementReferences(snapshot));
      return;
    }
    if (this.invalidatesReferences(action)) managed.references.clear();
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
    this.clearInteractive(managed);
    this.sessions.delete(managed.record.piSessionId);
    await managed.cli.dispose().catch(() => {});
    return true;
  }

  private async envelope(managed: Managed, action: string, result: CliResult, signal?: AbortSignal, includeTabs = false, startedAt = Date.now()): Promise<BrowserOperationResult> {
    const refreshMetadata = METADATA_ACTIONS.has(action);
    let tabResult: CliResult | undefined;
    let metadataAvailable = false;
    let metadataStale = !refreshMetadata && managed.page !== undefined;
    if (action === "tab-list") tabResult = result;
    else if (refreshMetadata) {
      try { tabResult = await managed.cli.run(managed.record.cliSessionName, { kind: "tab-list" }, signal); }
      catch (error) {
        metadataStale = managed.page !== undefined;
        if (sessionMissing(error)) {
          managed.record.state = "cleanup-required";
          managed.references.clear();
          if (action === "start" || action === "attach") throw staleSessionError();
        }
      }
    }
    if (tabResult) {
      const text = resultText(tabResult.value);
      const tabs = parseTabs(text);
      const page = currentTab(text);
      metadataAvailable = Boolean(text && page && tabs.length);
      if (tabs.length) managed.tabs = tabs;
      if (page) {
        managed.page = page;
        managed.record.activeTab = page.index;
      }
      if (metadataAvailable) metadataStale = false;
      else metadataStale = managed.page !== undefined;
    }
    return {
      action,
      ownership: managed.record.ownership,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
      metadataAvailable,
      metadataStale,
      page: managed.page,
      tabs: includeTabs ? managed.tabs : undefined,
      snapshot: result.snapshot,
      snapshotRedactions: result.snapshotRedactions,
      snapshotTruncated: result.snapshotTruncated,
      snapshotOmittedLines: result.snapshotOmittedLines,
      snapshotOmittedBytes: result.snapshotOmittedBytes,
      findMatches: result.findMatches,
      snapshotContinuation: result.snapshotContinuation,
      resolvedUrl: action === "link-url" ? resultText(result.value) : undefined,
      artifactPath: result.artifactPath,
    };
  }

  private serialized<T>(managed: Managed, operation: () => Promise<T>): Promise<T> {
    managed.pendingOperations++;
    const result = managed.tail.then(operation, operation);
    managed.tail = result.then(
      () => { managed.pendingOperations--; },
      () => { managed.pendingOperations--; },
    );
    return result;
  }
}

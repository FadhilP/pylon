import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { AndroidSdk, diagnoseAndroid, validateEmulatorSerial } from "../src/android-sdk.ts";
import { AndroidSessionManager, type AndroidAction, type AndroidOperationResult } from "../src/android-session.ts";
import { AndroidToolingManager } from "../src/android-tooling.ts";
import { resolveAppium } from "../src/appium.ts";
import { BrowserSessionManager, validateCdpEndpoint, type BrowserOperationResult } from "../src/browser-session.ts";
import { captureWindow, findWindow, validatePngFile } from "../src/capture.ts";
import { configPath, loadConfig, saveConfig } from "../src/config.ts";
import { elementReferences, ELEMENT_REF_PATTERN } from "../src/element-ref.ts";
import { diagnosePlaywrightCli, PlaywrightCli, type BrowserAction } from "../src/playwright-cli.ts";
import { issueWebScoutGrant } from "../src/web-scout-grant.ts";

const captureSchema = Type.Object({
  target: StringEnum(["window"] as const, { description: "Capture one named Windows window" }),
  title: Type.String({ description: "Required Windows window-title substring", maxLength: 500 }),
});

const BROWSER_ACTIONS = ["start", "attach", "navigate", "snapshot", "continue", "find", "screenshot", "click", "fill", "press", "hover", "select", "check", "uncheck", "back", "forward", "reload", "tabs", "detach", "close"] as const;
const PAGE_CONTEXT_ACTIONS = new Set(["start", "attach", "navigate", "snapshot", "find", "click", "press", "back", "forward", "reload", "tab-list", "tab-new", "tab-select", "tab-close"]);
const PAGE_CHANGE_ACTIONS = new Set(["start", "attach", "navigate", "click", "press", "back", "forward", "reload", "tab-list", "tab-new", "tab-select", "tab-close"]);
const OWNERSHIP_ACTIONS = new Set(["start", "attach", "close", "detach"]);
const MAX_EMBEDDED_FRAME_BYTES = 5 * 1024 * 1024;
const PLAN_ACTIONS = ["click", "fill", "hover", "select", "check", "uncheck"] as const;

type EmbeddedRequest = {
  version: 1;
  sessionId: string;
  owner: string;
  action: string;
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  phase?: "move" | "down" | "up";
  button?: "left" | "middle" | "right";
  deltaX?: number;
  deltaY?: number;
  key?: string;
  tabIndex?: number;
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
};

type AndroidToolingRequest = {
  version: 1;
  action: "status" | "install" | "remove";
  signal?: AbortSignal;
  claim(): boolean;
  respond(value: Promise<unknown>): void;
};

function embeddedState(manager: BrowserSessionManager, sessionId: string, owner: string) {
  return { version: 1 as const, ...manager.state(sessionId, owner) };
}

async function embeddedBrowserRequest(manager: BrowserSessionManager, request: EmbeddedRequest): Promise<unknown> {
  const { sessionId: id, owner, signal } = request;
  if (!id || id.length > 200 || !/^web:[A-Za-z0-9-]{1,128}$/.test(owner)) throw new Error("Invalid embedded browser identity");
  if (request.action === "status") return embeddedState(manager, id, owner);
  if (request.action === "start") {
    await manager.start(id, request.url, signal, false);
    await manager.acquireInteractive(id, owner);
    if (request.width !== undefined && request.height !== undefined) {
      await manager.operateInteractive(id, [{ kind: "resize", width: request.width, height: request.height }], owner, signal);
    }
    return embeddedState(manager, id, owner);
  }
  if (request.action === "acquire") {
    await manager.acquireInteractive(id, owner);
    return embeddedState(manager, id, owner);
  }
  if (request.action === "release") {
    await manager.releaseInteractive(id, owner);
    return embeddedState(manager, id, owner);
  }
  if (request.action === "close") {
    await manager.close(id, "close", signal, owner);
    return embeddedState(manager, id, owner);
  }
  if (request.action === "resize" && !manager.state(id, owner).controlled) {
    await manager.operate(id, { kind: "resize", width: request.width!, height: request.height! }, signal);
    return embeddedState(manager, id, owner);
  }

  if (request.action === "frame" && !manager.state(id, owner).controlled) {
    const result = await manager.observeFrame(id, signal);
    if (!result?.artifactPath) return embeddedState(manager, id, owner);
    try {
      const data = await manager.readArtifact(id, result.artifactPath, MAX_EMBEDDED_FRAME_BYTES);
      return { ...embeddedState(manager, id, owner), frame: { mimeType: "image/png" as const, data: data.toString("base64") } };
    } finally {
      await rm(result.artifactPath, { force: true }).catch(() => {});
    }
  }

  let actions: BrowserAction[];
  switch (request.action) {
    case "frame": actions = [{ kind: "screenshot" }]; break;
    case "navigate": actions = [{ kind: "navigate", url: request.url! }]; break;
    case "back": case "forward": case "reload": actions = [{ kind: request.action }]; break;
    case "resize": actions = [{ kind: "resize", width: request.width!, height: request.height! }]; break;
    case "pointer": actions = [
      { kind: "mouse-move", x: request.x!, y: request.y! },
      ...(request.phase === "down" ? [{ kind: "mouse-down", button: request.button! } as const]
        : request.phase === "up" ? [{ kind: "mouse-up", button: request.button! } as const] : []),
    ]; break;
    case "wheel": actions = [
      { kind: "mouse-move", x: request.x!, y: request.y! },
      { kind: "mouse-wheel", deltaX: request.deltaX!, deltaY: request.deltaY! },
    ]; break;
    case "key": actions = [{ kind: request.phase === "down" ? "key-down" : "key-up", key: request.key! }]; break;
    case "tab-list": actions = [{ kind: "tab-list" }]; break;
    case "tab-new": actions = [{ kind: "tab-new", url: request.url }]; break;
    case "tab-select": actions = [{ kind: "tab-select", index: request.tabIndex! }]; break;
    case "tab-close": actions = [{ kind: "tab-close", index: request.tabIndex! }]; break;
    default: throw new Error("Unsupported embedded browser action");
  }

  const results = await manager.operateInteractive(id, actions, owner, signal);
  const artifactPath = results.at(-1)?.artifactPath;
  if (!artifactPath) return embeddedState(manager, id, owner);
  try {
    const data = await manager.readArtifact(id, artifactPath, MAX_EMBEDDED_FRAME_BYTES);
    return { ...embeddedState(manager, id, owner), frame: { mimeType: "image/png" as const, data: data.toString("base64") } };
  } finally {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
}
const browserActionFields = {
  url: Type.Optional(Type.String({ description: "HTTP(S), about:blank, or an explicit local file: URL ending in .html or .htm", maxLength: 4096 })),
  attachMode: Type.Optional(StringEnum(["cdp", "extension"] as const)),
  endpoint: Type.Optional(Type.String({ maxLength: 2048 })),
  browser: Type.Optional(StringEnum(["chrome", "msedge"] as const, { description: "Browser for extension attachment; ignored by start" })),
  target: Type.Optional(Type.String({ pattern: ELEMENT_REF_PATTERN, maxLength: 32, description: "Element reference from latest snapshot, such as e12 or f1e12" })),
  text: Type.Optional(Type.String({ maxLength: 10000, description: "Exact text to find; keep narrow to avoid large match sets" })),
  regex: Type.Optional(Type.String({ maxLength: 500, description: "Regular expression to find; keep specific to avoid large match sets" })),
  key: Type.Optional(Type.String({ maxLength: 64 })),
  value: Type.Optional(Type.String({ maxLength: 1000 })),
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Snapshot depth; prefer 4-6 first, then target a returned ref for more detail" })),
  snapshotMode: Type.Optional(StringEnum(["compact", "full"] as const, { description: "Snapshot structure: compact flattens anonymous generic wrappers (default); full preserves them" })),
  cursor: Type.Optional(Type.String({ pattern: "^hc_[a-f0-9]{32}$", maxLength: 35, description: "One-use cursor returned by truncated snapshot, find, or action output" })),
  fullPage: Type.Optional(Type.Boolean()),
  tabAction: Type.Optional(StringEnum(["list", "select", "create", "close"] as const)),
  tabIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
};
const browserActionSchema = Type.Object({ action: StringEnum(BROWSER_ACTIONS), ...browserActionFields }, { additionalProperties: false });
const browserPlanStepSchema = Type.Object({
  action: StringEnum(PLAN_ACTIONS),
  match: Type.String({ minLength: 1, maxLength: 500, description: "Exact visible text or accessible name used to resolve one current element" }),
  text: Type.Optional(Type.String({ maxLength: 10_000 })),
  value: Type.Optional(Type.String({ maxLength: 1_000 })),
}, { additionalProperties: false });
const browserSchema = Type.Object({
  action: Type.Optional(StringEnum(BROWSER_ACTIONS)),
  ...browserActionFields,
  actions: Type.Optional(Type.Array(browserActionSchema, { minItems: 1, maxItems: 20, description: "Ordered browser actions with already-known refs" })),
  plan: Type.Optional(Type.Array(browserPlanStepSchema, { minItems: 1, maxItems: 5, description: "Bounded semantic steps; each resolves exactly one element and stops on ambiguity or page change" })),
}, { additionalProperties: false });

type BrowserParams = Static<typeof browserActionSchema>;
type BrowserPlanStep = Static<typeof browserPlanStepSchema>;
type BrowserInput = Static<typeof browserSchema>;

const ANDROID_ACTIONS = ["avds", "packages", "start", "attach", "status", "snapshot", "find", "screenshot", "tap", "fill", "back", "swipe", "close", "detach"] as const;
const androidSchema = Type.Object({
  action: StringEnum(ANDROID_ACTIONS),
  avd: Type.Optional(Type.String({ maxLength: 200 })),
  serial: Type.Optional(Type.String({ pattern: "^emulator-[0-9]{4,5}$", maxLength: 20 })),
  appPackage: Type.Optional(Type.String({ maxLength: 255 })),
  appActivity: Type.Optional(Type.String({ maxLength: 500 })),
  headless: Type.Optional(Type.Boolean()),
  target: Type.Optional(Type.String({ pattern: "^a[1-9][0-9]{0,5}$", maxLength: 7, description: "Element reference from the latest Android snapshot, such as a1" })),
  text: Type.Optional(Type.String({ maxLength: 10000 })),
  direction: Type.Optional(StringEnum(["up", "down", "left", "right"] as const)),
  distance: Type.Optional(Type.Integer({ minimum: 10, maximum: 90, description: "Swipe distance as percentage of the screen dimension" })),
}, { additionalProperties: false });
type AndroidInput = Static<typeof androidSchema>;

function rejectAndroidExtra(params: AndroidInput, allowed: readonly (keyof AndroidInput)[]): void {
  const accepted = new Set<keyof AndroidInput>(["action", ...allowed]);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !accepted.has(key as keyof AndroidInput)) throw new Error(`${params.action} does not accept ${key}`);
  }
}

function androidAction(params: AndroidInput): AndroidAction {
  switch (params.action) {
    case "snapshot": case "screenshot": case "back": rejectAndroidExtra(params, []); return { kind: params.action };
    case "find":
      rejectAndroidExtra(params, ["text"]);
      return { kind: "find", text: requireAndroidField(params, "text") };
    case "tap": rejectAndroidExtra(params, ["target"]); return { kind: "tap", target: requireAndroidField(params, "target") };
    case "fill": rejectAndroidExtra(params, ["target", "text"]); return { kind: "fill", target: requireAndroidField(params, "target"), text: requireAndroidField(params, "text") };
    case "swipe": rejectAndroidExtra(params, ["direction", "distance"]); return { kind: "swipe", direction: requireAndroidField(params, "direction"), distance: params.distance ?? 60 };
    default: throw new Error(`${params.action} is not an active Android-session operation`);
  }
}

function requireAndroidField<K extends keyof AndroidInput>(params: AndroidInput, key: K): NonNullable<AndroidInput[K]> {
  const value = params[key];
  if (value === undefined || value === "") throw new Error(`${params.action} requires ${String(key)}`);
  return value as NonNullable<AndroidInput[K]>;
}

function describeAndroid(result: AndroidOperationResult): string {
  const lines = [`Android ${result.action} ${result.outcome} (${result.ownership}).`, `Emulator: ${result.serial} / ${result.avd}.`, `Package: ${result.packageName}.`];
  if (result.snapshot !== undefined) lines.push(`Snapshot:\n${result.snapshot || "(no matching elements)"}`);
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Remaining: ${result.snapshotOmittedLines ?? 0} lines / ${result.snapshotOmittedBytes ?? 0} bytes.`);
  if (result.findMatches !== undefined) lines.push(`Matches: ${result.findMatches}.`);
  for (const warning of result.cleanupWarnings ?? []) lines.push(`Warning: ${warning}.`);
  return lines.join("\n");
}

function sessionId(ctx: any): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (typeof id !== "string" || !id) throw new Error("Helios requires a stable Pi session identity");
  return id;
}

function requireField<K extends keyof BrowserParams>(params: BrowserParams, key: K): NonNullable<BrowserParams[K]> {
  const value = params[key];
  if (value === undefined || value === "") throw new Error(`${params.action} requires ${String(key)}`);
  return value as NonNullable<BrowserParams[K]>;
}

function rejectExtra(params: BrowserParams, allowed: readonly (keyof BrowserParams)[]): void {
  const accepted = new Set<keyof BrowserParams>(["action", ...allowed]);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !accepted.has(key as keyof BrowserParams)) throw new Error(`${params.action} does not accept ${key}`);
  }
}

function browserAction(params: BrowserParams): BrowserAction {
  switch (params.action) {
    case "navigate": rejectExtra(params, ["url"]); return { kind: "navigate", url: requireField(params, "url") };
    case "snapshot": rejectExtra(params, ["target", "depth", "snapshotMode"]); return { kind: "snapshot", target: params.target, depth: params.depth, snapshotMode: params.snapshotMode };
    case "continue": rejectExtra(params, ["cursor"]); return { kind: "continue", cursor: requireField(params, "cursor") };
    case "find": {
      rejectExtra(params, ["text", "regex"]);
      if (Boolean(params.text) === Boolean(params.regex)) throw new Error("find requires exactly one of text or regex");
      return { kind: "find", text: params.text, regex: params.regex };
    }
    case "screenshot":
      rejectExtra(params, ["target", "fullPage"]);
      if (params.target && params.fullPage) throw new Error("Element screenshot and full-page screenshot cannot be combined");
      return { kind: "screenshot", target: params.target, fullPage: params.fullPage };
    case "click": case "hover": case "check": case "uncheck":
      rejectExtra(params, ["target"]); return { kind: params.action, target: requireField(params, "target") };
    case "fill": rejectExtra(params, ["target", "text"]); return { kind: "fill", target: requireField(params, "target"), text: requireField(params, "text") };
    case "press": rejectExtra(params, ["key"]); return { kind: "press", key: requireField(params, "key") };
    case "select": rejectExtra(params, ["target", "value"]); return { kind: "select", target: requireField(params, "target"), value: requireField(params, "value") };
    case "back": case "forward": case "reload": rejectExtra(params, []); return { kind: params.action };
    case "tabs": {
      rejectExtra(params, ["tabAction", "tabIndex", "url"]);
      const action = requireField(params, "tabAction");
      if (action === "list") { rejectExtra(params, ["tabAction"]); return { kind: "tab-list" }; }
      if (action === "create") return { kind: "tab-new", url: params.url };
      if (params.url !== undefined) throw new Error(`tabs ${action} does not accept url`);
      return { kind: action === "select" ? "tab-select" : "tab-close", index: requireField(params, "tabIndex") };
    }
    default: throw new Error(`${params.action} is a lifecycle action, not an active-session operation`);
  }
}

function planAction(step: BrowserPlanStep, target: string): BrowserAction {
  switch (step.action) {
    case "fill":
      if (step.text === undefined || step.value !== undefined) throw new Error("Plan fill requires text and does not accept value");
      return { kind: "fill", target, text: step.text };
    case "select":
      if (step.value === undefined || step.text !== undefined) throw new Error("Plan select requires value and does not accept text");
      return { kind: "select", target, value: step.value };
    case "click": case "hover": case "check": case "uncheck":
      if (step.text !== undefined || step.value !== undefined) throw new Error(`Plan ${step.action} does not accept text or value`);
      return { kind: step.action, target };
  }
}

function semanticReference(result: BrowserOperationResult, match: string): string | undefined {
  if (result.findMatches !== 1 || !result.snapshot) return undefined;
  const query = match.toLowerCase();
  // Pinned Playwright find counts matching snapshot lines and returns those lines with context.
  const matched = result.snapshot.split(/\r?\n/).slice(1)
    .filter((line) => line.toLowerCase().includes(query));
  if (matched.length !== 1) return undefined;
  const refs = elementReferences(matched[0]);
  return refs.length === 1 ? refs[0] : undefined;
}

function pageKey(page: BrowserOperationResult["page"]): string | undefined {
  return page ? `${page.index}\n${page.title}\n${page.url}` : undefined;
}

function describe(result: BrowserOperationResult): string {
  const ownership = OWNERSHIP_ACTIONS.has(result.action) ? ` (${result.ownership})` : "";
  const lines = [`Browser ${result.action} ${result.outcome}${ownership}.`];
  if (PAGE_CONTEXT_ACTIONS.has(result.action)) {
    if (result.metadataAvailable === false && !result.page) lines.push("Page metadata unavailable.");
    else if (result.metadataStale && PAGE_CHANGE_ACTIONS.has(result.action)) lines.push("Page metadata may be stale.");
    if (result.page) lines.push(`Page: ${result.page.title} (${result.page.url})`);
  }
  if (result.tabs) lines.push(`Tabs: ${result.tabs.map((tab) => `${tab.index}: ${tab.title} (${tab.url})`).join(" | ")}${result.tabsOmitted ? ` | ${result.tabsOmitted} more omitted.` : ""}`);
  if (result.snapshot) lines.push(`Snapshot:\n${result.snapshot}`);
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Remaining: ${result.snapshotOmittedLines ?? 0} lines / ${result.snapshotOmittedBytes ?? 0} bytes.`);
  if (result.snapshotContinuation) lines.push(`Continuation: ${result.snapshotContinuation}`);
  if (result.action === "find" && ((result.findMatches ?? 0) > 20 || result.snapshotTruncated)) lines.push("Refine find query or continue with returned cursor.");
  for (const warning of result.cleanupWarnings ?? []) lines.push(`Warning: ${warning}.`);
  return lines.join("\n");
}

function compactBrowserDetails(result: BrowserOperationResult): BrowserOperationResult {
  const details = { ...result };
  delete details.snapshot;
  delete details.artifactPath;
  return details;
}

function describeCompactBatchStep(index: number, action: string, result: BrowserOperationResult, pageChanged: boolean): string {
  const ownership = OWNERSHIP_ACTIONS.has(action) ? ` (${result.ownership})` : "";
  const lines = [`Step ${index} (${action}): ${result.outcome}${ownership}.`];
  if (PAGE_CONTEXT_ACTIONS.has(action)) {
    if (result.metadataAvailable === false && !result.page) lines.push("Page metadata unavailable.");
    else if (result.metadataStale && PAGE_CHANGE_ACTIONS.has(action)) lines.push("Page metadata may be stale.");
    else if (pageChanged && result.page) lines.push(`Page: ${result.page.title} (${result.page.url})`);
  }
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Intermediate snapshot omitted and truncated; ${result.snapshotOmittedLines ?? 0} lines / ${result.snapshotOmittedBytes ?? 0} bytes remain. Request a new snapshot if needed.`);
  for (const warning of result.cleanupWarnings ?? []) lines.push(`Warning: ${warning}.`);
  return lines.join("\n");
}

async function withBrowserStatus<T>(ctx: any, action: string, operation: () => Promise<T>): Promise<T> {
  if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", `browser: ${action}`);
  try { return await operation(); }
  finally { if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", undefined); }
}

export default function heliosExtension(pi: ExtensionAPI, options: { configPath?: string; persistentClient?: boolean } = {}) {
  const settingsPath = options.configPath ?? configPath();
  const exec = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number; cwd?: string }) => pi.exec(command, args, options);
  const manager = new BrowserSessionManager(exec, (value) => PlaywrightCli.create(value, { persistentClient: options.persistentClient ?? true }));
  const androidManager = new AndroidSessionManager(exec);
  const androidTooling = new AndroidToolingManager();
  const disposeEmbeddedBrowser = pi.events.on("pylon:helios-browser-request", (value: unknown) => {
    const request = value && typeof value === "object" ? value as Partial<EmbeddedRequest> : undefined;
    if (request?.version !== 1 || typeof request.claim !== "function" || typeof request.respond !== "function" || !request.claim()) return;
    request.respond(embeddedBrowserRequest(manager, request as EmbeddedRequest));
  });
  const disposeAndroidTooling = pi.events.on("pylon:helios-android-tooling-request", (value: unknown) => {
    const request = value && typeof value === "object" ? value as Partial<AndroidToolingRequest> : undefined;
    if (request?.version !== 1 || !(["status", "install", "remove"] as const).includes(request.action as "status") || typeof request.claim !== "function" || typeof request.respond !== "function" || !request.claim()) return;
    request.respond((async () => {
      if (request.action === "status") return androidTooling.status();
      if (request.action === "install") return androidTooling.install(androidManager.summary().total, request.signal);
      return androidTooling.remove(androidManager.summary().total, request.signal);
    })());
  });
  let healthDiagnostic: Promise<string> | undefined;
  const cachedHealthDiagnostic = () => {
    if (!healthDiagnostic) {
      const pending = diagnosePlaywrightCli(exec);
      healthDiagnostic = pending;
      pending.catch(() => { if (healthDiagnostic === pending) healthDiagnostic = undefined; });
    }
    return healthDiagnostic;
  };
  const webScoutExtensionPath = fileURLToPath(new URL("./web-scout-browser.ts", import.meta.url));
  const disposeWebScoutCapability = pi.events.on("pi-helios:web-scout-capability", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond({
      version: 1,
      owner: "pi-helios",
      childExtensionPath: webScoutExtensionPath,
      issueGrant: issueWebScoutGrant,
    });
  });
  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond((async () => {
      const sessions = manager.summary();
      const androidSessions = androidManager.summary();
      try {
        const version = await cachedHealthDiagnostic();
        return {
          version: 1,
          owner: "pi-helios",
          label: "Helios",
          lines: [`CLI: ${version}`, `Browser sessions: ${sessions.total} (${sessions.owned} owned, ${sessions.attached} attached, ${sessions.cleanupRequired} cleanup-required)`, `Android sessions: ${androidSessions.total} (${androidSessions.owned} owned, ${androidSessions.attached} attached, ${androidSessions.cleanupRequired} cleanup-required)`, "Web Scout browser broker: ready"],
          warning: sessions.cleanupRequired > 0 || androidSessions.cleanupRequired > 0,
        };
      } catch (error) {
        return {
          version: 1,
          owner: "pi-helios",
          label: "Helios",
          lines: [error instanceof Error ? `CLI: ${error.message}` : "CLI: unavailable", `Browser sessions: ${sessions.total}`, `Android sessions: ${androidSessions.total} (${androidSessions.cleanupRequired} cleanup-required)`],
          warning: true,
        };
      }
    })());
  });
  let ownedHeaded = false;
  pi.on("session_start", async () => {
    ownedHeaded = (await loadConfig(settingsPath)).headed ?? false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-helios",
      managedTools: ["helios_browser", "helios_capture", "helios_android"],
      enabledTools: ["helios_browser", "helios_capture", "helios_android"],
      deferredTools: ["helios_browser", "helios_capture", "helios_android"],
      toolUsage: {
        helios_browser: "navigate and interact with browser pages, tabs, and screenshots",
        helios_capture: "capture a consented Windows window for visual debugging",
        helios_android: "list packages on, start, or attach to an Android emulator and navigate one app with constrained Appium actions",
      },
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-helios" });
    disposeWebScoutCapability();
    disposeEmbeddedBrowser();
    disposeAndroidTooling();
    disposeHealth();
    const [summary, androidSummary] = await Promise.all([manager.shutdown(), androidManager.shutdown()]);
    if (!ctx.hasUI) {
      if (summary.failures.length || androidSummary.failures.length || summary.cleanupWarnings.length || androidSummary.cleanupWarnings.length) {
        throw new Error(`Helios shutdown cleanup uncertain: ${summary.failures.length} browser failure(s), ${androidSummary.failures.length} Android failure(s), ${summary.cleanupWarnings.length + androidSummary.cleanupWarnings.length} warning(s)`);
      }
      return;
    }
    if (summary.failures.length) ctx.ui.notify(`Helios could not ${summary.failures.map((item) => item.action).join("/")} ${summary.failures.length} browser session(s). Browser cleanup remains uncertain.`, "error");
    if (androidSummary.failures.length) ctx.ui.notify(`Helios could not clean up ${androidSummary.failures.length} Android session(s). Emulator cleanup remains uncertain.`, "error");
    for (const warning of [...summary.cleanupWarnings, ...androidSummary.cleanupWarnings]) ctx.ui.notify(`Helios cleanup warning: ${warning}`, "warning");
    ctx.ui.setStatus?.("pi-helios", undefined);
  });

  pi.registerCommand("helios-doctor", {
    description: "Check pinned Playwright CLI readiness",
    handler: async (_args, ctx) => {
      try {
        const version = await diagnosePlaywrightCli(exec);
        healthDiagnostic = Promise.resolve(version);
        ctx.ui.notify(`Helios CLI ready: ${version}. CLI compatibility is verified.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Helios CLI diagnostic failed", "error");
      }
    },
  });

  pi.registerCommand("helios-android-doctor", {
    description: "Check Android SDK, AVD, Appium, and UiAutomator2 readiness",
    handler: async (_args, ctx) => {
      try {
        const [android, appium] = await Promise.all([diagnoseAndroid(exec), resolveAppium(exec)]);
        ctx.ui.notify(`Helios Android ready: ${android.adbVersion}; Appium ${appium.version}; ${android.avds.length} AVD(s): ${android.avds.join(", ") || "none"}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Helios Android diagnostic failed", "error");
      }
    },
  });

  pi.registerCommand("helios-visibility", {
    description: "Toggle whether future Helios-owned browsers are shown or headless",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (!(["toggle", "show", "hide", "status"] as const).includes(action as "toggle")) {
        ctx.ui.notify("Usage: /helios-visibility [show|hide|toggle|status]", "warning");
        return;
      }
      if (action === "toggle") ownedHeaded = !ownedHeaded;
      if (action === "show") ownedHeaded = true;
      if (action === "hide") ownedHeaded = false;
      if (action !== "status") await saveConfig({ version: 1, headed: ownedHeaded }, settingsPath);
      const active = manager.get(sessionId(ctx));
      const unchanged = active?.ownership === "owned" ? " Active owned session unchanged." : "";
      ctx.ui.notify(`Future Helios-owned browsers: ${ownedHeaded ? "shown" : "hidden (headless)"}.${unchanged}`, "info");
    },
  });

  pi.registerTool({
    name: "helios_android",
    label: "Helios Android",
    description: "List installed package IDs on one consented running emulator, or start one owned Android AVD or attach to one consented existing Android emulator, then navigate one expected app through constrained Appium actions. Use returned Android element refs; never guess selectors or request raw ADB/Appium commands. Close owned emulators and detach attached emulators when done. Never monitor. Users must supervise permissions, messages, purchases, destructive actions, secret entry, and any unexpected system UI.",
    promptSnippet: "Inspect one consented Android emulator or navigate one app through constrained Appium actions",
    promptGuidelines: [
      "Use only for user-requested Android emulator work. Package inventory, start, and attachment require visible confirmation. Close owned emulators or detach attached emulators when done. Never monitor.",
      "Use only refs returned by the latest Android snapshot or find result. Snapshot again after tap, fill, back, or swipe because those actions invalidate refs.",
      "Stop if the UI leaves the expected app package. User must supervise permissions, messages, purchases, destructive actions, secret entry, and system UI.",
      "Never request raw ADB, Appium commands, selectors, scripts, capabilities, APK installation, file transfer, physical-device access, or AVD creation/deletion."
    ],
    parameters: androidSchema,
    executionMode: "sequential",
    async execute(toolCallId, params: AndroidInput, signal, onUpdate, ctx) {
      const id = sessionId(ctx);
      if (params.action === "avds") {
        rejectAndroidExtra(params, []);
        const avds = await (await AndroidSdk.create(exec)).listAvds(signal);
        return { content: [{ type: "text" as const, text: `Android AVDs (${avds.length}): ${avds.join(", ") || "none"}.` }], details: { avds } };
      }
      if (params.action === "packages") {
        rejectAndroidExtra(params, ["serial"]);
        const serial = requireAndroidField(params, "serial");
        validateEmulatorSerial(serial);
        if (!ctx.hasUI) throw new Error("Helios Android package inventory requires interactive confirmation");
        const approved = await ctx.ui.confirm("List installed Android packages?", `Helios will query system and user-installed package IDs from ${serial}. Package IDs may reveal sensitive apps, and the complete list may enter model/session history.`);
        if (!approved) return { content: [{ type: "text" as const, text: "User declined Android package inventory." }], details: { declined: true } };
        onUpdate?.({ content: [{ type: "text" as const, text: `Listing installed packages on ${serial}...` }], details: {} });
        if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", `android: listing packages on ${serial}`);
        try {
          const inventory = await (await AndroidSdk.create(exec)).listInstalledPackages(serial, signal);
          const heading = `Installed Android packages on ${inventory.serial} / ${inventory.avd} (${inventory.packages.length})`;
          return { content: [{ type: "text" as const, text: `${heading}:${inventory.packages.length ? `\n${inventory.packages.join("\n")}` : " none."}` }], details: { serial: inventory.serial, avd: inventory.avd, packageCount: inventory.packages.length } };
        } finally { if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", undefined); }
      }
      if (params.action === "status") {
        rejectAndroidExtra(params, []);
        const record = androidManager.get(id);
        if (!record) return { content: [{ type: "text" as const, text: "No active Helios Android session." }], details: { active: false } };
        return { content: [{ type: "text" as const, text: `Android session ${record.state} (${record.ownership}): ${record.serial} / ${record.avd}; package ${record.packageName}.` }], details: { active: true, ...record } };
      }
      if (params.action === "start" || params.action === "attach") {
        if (!ctx.hasUI) throw new Error("Helios Android start and attachment require interactive confirmation");
        const packageName = requireAndroidField(params, "appPackage");
        let approved: boolean;
        if (params.action === "start") {
          rejectAndroidExtra(params, ["avd", "appPackage", "appActivity", "headless"]);
          const avd = requireAndroidField(params, "avd");
          approved = await ctx.ui.confirm("Start Android emulator?", `Helios will launch and control AVD “${avd}” for package ${packageName}, start a private loopback Appium server, and stop this emulator when closed. UI source and screenshots may contain secrets and enter model/session history.`);
          if (!approved) return { content: [{ type: "text" as const, text: "User declined Android emulator start." }], details: { declined: true } };
          if (androidTooling.isMutating()) throw new Error("Android tooling setup is in progress");
          onUpdate?.({ content: [{ type: "text" as const, text: `Starting Android AVD ${avd}...` }], details: {} });
          if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", `android: starting ${avd}`);
          try {
            const result = await androidManager.start(id, avd, packageName, params.appActivity, params.headless ?? false, signal);
            return { content: [{ type: "text" as const, text: describeAndroid(result) }], details: result };
          } finally { if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", undefined); }
        }
        rejectAndroidExtra(params, ["serial", "appPackage", "appActivity"]);
        const serial = requireAndroidField(params, "serial");
        approved = await ctx.ui.confirm("Attach to Android emulator?", `Helios will control existing emulator ${serial} for package ${packageName} through a private loopback Appium server. Existing app data and UI may become accessible to the selected model and retained in Pi history. Helios will detach without stopping the emulator.`);
        if (!approved) return { content: [{ type: "text" as const, text: "User declined Android emulator attachment." }], details: { declined: true } };
        if (androidTooling.isMutating()) throw new Error("Android tooling setup is in progress");
        onUpdate?.({ content: [{ type: "text" as const, text: `Attaching to Android emulator ${serial}...` }], details: {} });
        if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", `android: attaching ${serial}`);
        try {
          const result = await androidManager.attach(id, serial, packageName, params.appActivity, signal);
          return { content: [{ type: "text" as const, text: describeAndroid(result) }], details: result };
        } finally { if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", undefined); }
      }
      if (params.action === "close" || params.action === "detach") {
        rejectAndroidExtra(params, []);
        const result = await androidManager.close(id, params.action, signal);
        return { content: [{ type: "text" as const, text: describeAndroid(result) }], details: result };
      }
      if (params.action === "screenshot" && ctx.model && !ctx.model.input.includes("image")) throw new Error("Selected model does not support image input");
      onUpdate?.({ content: [{ type: "text" as const, text: `Running Android ${params.action}...` }], details: {} });
      const result = await androidManager.operate(id, androidAction(params), signal);
      if (!result.artifactPath) return { content: [{ type: "text" as const, text: describeAndroid(result) }], details: result };
      try {
        const image = await createReadToolDefinition(ctx.cwd).execute(toolCallId, { path: result.artifactPath }, signal, onUpdate, ctx);
        return { content: [{ type: "text" as const, text: describeAndroid(result) }, ...image.content], details: { ...result, artifactPath: undefined } };
      } finally {
        await rm(result.artifactPath, { force: true }).catch(() => { if (ctx.hasUI) ctx.ui.notify("Helios could not delete temporary Android screenshot.", "warning"); });
      }
    },
  });

  pi.registerTool({
    name: "helios_capture",
    label: "Helios Capture",
    description: "Capture one named Windows window for visual debugging only when the user asks to inspect it. Every capture requires fresh visible confirmation. Never use for monitoring; it cannot capture the whole desktop, run in the background, or control input.",
    promptSnippet: "Capture one consented Windows window for visual debugging",
    promptGuidelines: [
      "Use helios_capture only when user asks to inspect a named Windows window.",
      "Never use helios_capture for monitoring; every capture requires fresh user confirmation.",
    ],
    parameters: captureSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("Helios capture requires interactive confirmation");
      if (ctx.model && !ctx.model.input.includes("image")) throw new Error("Selected model does not support image input");
      const windowTarget = await findWindow((command, args, options) => pi.exec(command, args, options), params.title, signal);
      const source = `Windows window “${windowTarget.title}” (including obscured content when Windows permits)`;
      const approved = await ctx.ui.confirm("Allow screenshot?", `Helios will capture ${source}. Screenshots may contain secrets. Image and selected window metadata will be sent to selected model provider and retained in Pi session history.`);
      if (!approved) return { content: [{ type: "text" as const, text: "User declined screenshot capture." }], details: { declined: true } };
      onUpdate?.({ content: [{ type: "text" as const, text: `Capturing ${source}...` }], details: {} });
      const directory = await mkdtemp(join(tmpdir(), "pi-helios-"));
      const screenshot = join(directory, "capture.png");
      try {
        await chmod(directory, 0o700).catch(() => {});
        await captureWindow((command, args, options) => pi.exec(command, args, options), windowTarget, screenshot, signal);
        await validatePngFile(screenshot);
        const result = await createReadToolDefinition(ctx.cwd).execute(toolCallId, { path: screenshot }, signal, onUpdate, ctx);
        return { content: [{ type: "text" as const, text: `Captured Windows window: ${windowTarget.title}` }, ...result.content], details: { target: "window", windowTitle: windowTarget.title } };
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => ctx.ui.notify(`Helios could not delete temporary capture directory: ${directory}`, "warning"));
      }
    },
  });

  pi.registerTool({
    name: "helios_browser",
    label: "Helios Browser",
    description: "Use one owned isolated or consented attached browser only for user-requested browser work: start or attach first, then close or detach when done; never monitor, and require user supervision for purchases, messages, publishing, destructive actions, and other consequential clicks. Act through returned element refs rather than guessed selectors, reuse adequate snapshots, and use continuation cursors for truncated output because each chunk replaces prior usable refs. Batch known refs, or use a bounded semantic plan that resolves one unique element per step and stops on ambiguity or page change. No raw Playwright commands, scripts, storage, network interception, uploads, or downloads.",
    promptSnippet: "Use one owned browser with an isolated profile or one consented attached browser through constrained Playwright actions",
    promptGuidelines: [
      "Use only for user-requested browser work; start or attach first, then close or detach when done. Never monitor. User must supervise purchases, messages, publishing, destructive actions, and other consequential clicks.",
      "Act through returned element references; never guess selectors. Prefer find for narrow text, otherwise start snapshots at depth 4–6 or target a returned ref.",
      "Reuse returned snapshots; request another only when absent, truncated, or insufficient. Prefer targeted screenshots; use fullPage only for whole-page context.",
      "Use continuation cursors for remaining output; each chunk replaces prior refs. Refine truncated searches instead of broadening.",
      "Batch only known refs. Use plan only for deterministic, non-consequential steps; each match must resolve uniquely and execution stops on ambiguity or page change.",
      "For local HTML prototypes, use an explicit file: URL ending in .html or .htm; raw filesystem paths are not accepted.",
    ],
    parameters: browserSchema,
    executionMode: "sequential",
    async execute(toolCallId, params: BrowserInput, signal, onUpdate, ctx) {
      const executeAction = async (params: BrowserParams) => {
        const id = sessionId(ctx);
      if (params.action === "start") {
        rejectExtra(params, ["url", "browser"]);
        const result = await withBrowserStatus(ctx, "start", () => manager.start(id, params.url, signal, ownedHeaded));
        return { content: [{ type: "text" as const, text: describe(result) }], details: compactBrowserDetails(result) };
      }
      if (params.action === "attach") {
        rejectExtra(params, ["attachMode", "endpoint", "browser"]);
        if (!ctx.hasUI) throw new Error("Helios browser attachment requires interactive confirmation");
        const mode = requireField(params, "attachMode");
        if (mode === "cdp") {
          if (params.browser !== undefined) throw new Error("CDP attachment does not accept browser");
          const endpoint = validateCdpEndpoint(requireField(params, "endpoint"));
          const approved = await ctx.ui.confirm("Attach to existing browser?", `Helios will connect to ${endpoint}. Existing tabs, logins, and page data exposed by this endpoint may become accessible to selected model provider and retained in Pi session history. Helios will detach without closing browser.`);
          if (!approved) return { content: [{ type: "text" as const, text: "User declined browser attachment." }], details: { declined: true } };
          const result = await withBrowserStatus(ctx, "attach", () => manager.attachCdp(id, endpoint, signal));
          return { content: [{ type: "text" as const, text: describe(result) }], details: compactBrowserDetails(result) };
        }
        if (params.endpoint !== undefined) throw new Error("Extension attachment does not accept endpoint");
        const browser = requireField(params, "browser");
        const approved = await ctx.ui.confirm("Attach through browser extension?", `Helios will connect through enabled Playwright bridge in ${browser}. Tabs, logins, and page data allowed by extension may become accessible to selected model provider and retained in Pi session history. Helios will detach without closing browser.`);
        if (!approved) return { content: [{ type: "text" as const, text: "User declined browser attachment." }], details: { declined: true } };
        const result = await withBrowserStatus(ctx, "attach", () => manager.attachExtension(id, browser, signal));
        return { content: [{ type: "text" as const, text: describe(result) }], details: compactBrowserDetails(result) };
      }
      if (params.action === "close" || params.action === "detach") {
        rejectExtra(params, []);
        const action = params.action;
        const result = await withBrowserStatus(ctx, action, () => manager.close(id, action, signal));
        return { content: [{ type: "text" as const, text: describe(result) }], details: compactBrowserDetails(result) };
      }
      if (params.action === "screenshot" && ctx.model && !ctx.model.input.includes("image")) throw new Error("Selected model does not support image input");
      if (params.action === "tabs" && params.tabAction === "close" && manager.get(id)?.ownership !== "owned") {
        if (!ctx.hasUI || !await ctx.ui.confirm("Close user browser tab?", `Helios will close tab ${params.tabIndex ?? "current"} in attached user browser.`)) {
          return { content: [{ type: "text" as const, text: "User declined tab close." }], details: { declined: true } };
        }
      }
      onUpdate?.({ content: [{ type: "text" as const, text: `Running browser ${params.action}...` }], details: {} });
      const result = await withBrowserStatus(ctx, params.action, () => manager.operate(id, browserAction(params), signal));
      if (!result.artifactPath) return { content: [{ type: "text" as const, text: describe(result) }], details: compactBrowserDetails(result) };
      try {
        const image = await createReadToolDefinition(ctx.cwd).execute(toolCallId, { path: result.artifactPath }, signal, onUpdate, ctx);
        const details = compactBrowserDetails(result);
        return { content: [{ type: "text" as const, text: describe(result) }, ...image.content], details };
      } finally {
        await rm(result.artifactPath, { force: true }).catch(() => {
          if (ctx.hasUI) ctx.ui.notify("Helios could not delete temporary browser screenshot.", "warning");
        });
      }
      };

      const executePlan = async (plan: BrowserPlanStep[]) => {
        const id = sessionId(ctx);
        for (const step of plan) planAction(step, "e1");
        const summaries: string[] = [];
        const steps: Array<{ action: string; match: string; target?: string; details?: BrowserOperationResult }> = [];
        for (const [index, step] of plan.entries()) {
          onUpdate?.({ content: [{ type: "text" as const, text: `Resolving browser plan step ${index + 1}...` }], details: {} });
          const found = await withBrowserStatus(ctx, "plan-find", () => manager.operate(id, { kind: "find", text: step.match }, signal));
          const target = semanticReference(found, step.match);
          if (!target) {
            const reason = found.findMatches === 0 ? "no-match" : "ambiguous";
            const prefix = summaries.length ? `${summaries.join("\n")}\n` : "";
            return {
              content: [{ type: "text" as const, text: `${prefix}Plan stopped at step ${index + 1} (${step.action}): ${reason}.\n${describe(found)}` }],
              details: { steps, completed: steps.length, stoppedAt: index + 1, reason, find: compactBrowserDetails(found) },
            };
          }
          const before = pageKey(manager.state(id).page);
          let result: BrowserOperationResult;
          try {
            result = await withBrowserStatus(ctx, `plan-${step.action}`, () => manager.operate(id, planAction(step, target), signal));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Browser plan step ${index + 1} (${step.action}) failed: ${message}`, { cause: error });
          }
          const details = compactBrowserDetails(result);
          steps.push({ action: step.action, match: step.match, target, details });
          summaries.push(`Step ${index + 1} (${step.action} ${target}): completed.`);
          let observed: BrowserOperationResult | undefined = result;
          if (step.action !== "click") {
            try { observed = await manager.operate(id, { kind: "tab-list" }, signal); }
            catch { observed = undefined; }
          }
          const after = observed && !observed.metadataStale && observed.metadataAvailable !== false ? pageKey(observed.page) : undefined;
          const changed = before !== undefined && after !== undefined && before !== after;
          const uncertain = before === undefined || after === undefined;
          const final = index === plan.length - 1;
          if (changed || uncertain || final) {
            const reason = changed ? "page-changed" : uncertain ? "page-uncertain" : undefined;
            return {
              content: [{ type: "text" as const, text: `${summaries.join("\n")}\n${reason && !final ? `Plan stopped after ${reason === "page-changed" ? "page change" : "uncertain page metadata"}.\n` : ""}${describe(result)}` }],
              details: { steps, completed: steps.length, ...(reason && !final ? { stoppedAt: index + 1, reason } : {}) },
            };
          }
        }
        throw new Error("Browser plan produced no result");
      };

      if (params.plan !== undefined) {
        if (Object.entries(params).some(([key, value]) => key !== "plan" && value !== undefined)) throw new Error("Browser plan must contain only plan");
        return executePlan(params.plan);
      }
      if (params.actions === undefined) {
        if (params.action === undefined) throw new Error("helios_browser requires action, actions, or plan");
        return executeAction(params as BrowserParams);
      }
      if (Object.entries(params).some(([key, value]) => key !== "actions" && value !== undefined)) throw new Error("Browser batch must contain only actions");
      const content: any[] = [];
      const steps: Array<{ action: string; details: unknown }> = [];
      let previousPage: string | undefined;
      for (const [index, action] of params.actions.entries()) {
        let result;
        try {
          result = await executeAction(action);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Browser batch step ${index + 1} (${action.action}) failed: ${message}`, { cause: error });
        }
        steps.push({ action: action.action, details: result.details });
        const details = result.details as BrowserOperationResult & { declined?: boolean };
        const final = index === params.actions.length - 1;
        if (final || details.declined) {
          for (const item of result.content) {
            content.push(item.type === "text" ? { ...item, text: `Step ${index + 1} (${action.action}):\n${item.text}` } : item);
          }
        } else {
          const page = details.metadataStale ? undefined : details.page;
          const pageKey = page ? `${page.title}\n${page.url}` : undefined;
          content.push({ type: "text", text: describeCompactBatchStep(index + 1, action.action, details, pageKey !== undefined && pageKey !== previousPage) });
          for (const item of result.content) if (item.type !== "text") content.push(item);
          if (pageKey !== undefined) previousPage = pageKey;
        }
        if (details.declined) {
          return { content, details: { steps, completed: steps.length, stoppedAt: index + 1, reason: "declined" } };
        }
      }
      return { content, details: { steps, completed: steps.length } };
    },
  });
}

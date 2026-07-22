import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BrowserSessionManager, validateCdpEndpoint } from "../src/browser-session.ts";
import { captureWindow, findWindow, validatePngFile } from "../src/capture.ts";
import { diagnosePlaywrightCli, type BrowserAction } from "../src/playwright-cli.ts";
import { issueWebScoutGrant } from "../src/web-scout-grant.ts";

const captureSchema = Type.Object({
  target: StringEnum(["window"] as const, { description: "Capture one named Windows window" }),
  title: Type.String({ description: "Required Windows window-title substring", maxLength: 500 }),
});

const BROWSER_ACTIONS = ["start", "attach", "navigate", "snapshot", "continue", "find", "screenshot", "click", "fill", "press", "hover", "select", "check", "uncheck", "back", "forward", "reload", "tabs", "detach", "close"] as const;
const PAGE_CONTEXT_ACTIONS = new Set(["start", "attach", "navigate", "snapshot", "find", "click", "press", "back", "forward", "reload", "tab-list", "tab-new", "tab-select", "tab-close"]);
const PAGE_CHANGE_ACTIONS = new Set(["start", "attach", "navigate", "click", "press", "back", "forward", "reload", "tab-list", "tab-new", "tab-select", "tab-close"]);
const OWNERSHIP_ACTIONS = new Set(["start", "attach", "close", "detach"]);
const browserActionFields = {
  url: Type.Optional(Type.String({ maxLength: 4096 })),
  attachMode: Type.Optional(StringEnum(["cdp", "extension"] as const)),
  endpoint: Type.Optional(Type.String({ maxLength: 2048 })),
  browser: Type.Optional(StringEnum(["chrome", "msedge"] as const, { description: "Browser for extension attachment; ignored by start" })),
  target: Type.Optional(Type.String({ maxLength: 32, description: "Element reference from latest snapshot, such as e12" })),
  text: Type.Optional(Type.String({ maxLength: 10000, description: "Exact text to find; keep narrow to avoid large match sets" })),
  regex: Type.Optional(Type.String({ maxLength: 500, description: "Regular expression to find; keep specific to avoid large match sets" })),
  key: Type.Optional(Type.String({ maxLength: 64 })),
  value: Type.Optional(Type.String({ maxLength: 1000 })),
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Snapshot depth; prefer 4-6 first, then target a returned ref for more detail" })),
  cursor: Type.Optional(Type.String({ pattern: "^hc_[a-f0-9]{32}$", maxLength: 35, description: "One-use cursor returned by truncated snapshot, find, or action output" })),
  fullPage: Type.Optional(Type.Boolean()),
  tabAction: Type.Optional(StringEnum(["list", "select", "create", "close"] as const)),
  tabIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
};
const browserActionSchema = Type.Object({ action: StringEnum(BROWSER_ACTIONS), ...browserActionFields }, { additionalProperties: false });
const browserSchema = Type.Object({
  action: Type.Optional(StringEnum(BROWSER_ACTIONS)),
  ...browserActionFields,
  actions: Type.Optional(Type.Array(browserActionSchema, { minItems: 1, maxItems: 20, description: "Ordered browser actions; each step completes before the next starts" })),
}, { additionalProperties: false });

type BrowserParams = Static<typeof browserActionSchema>;
type BrowserInput = Static<typeof browserSchema>;

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
    case "snapshot": rejectExtra(params, ["target", "depth"]); return { kind: "snapshot", target: params.target, depth: params.depth };
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

function describe(result: { action: string; ownership: string; outcome: string; metadataAvailable?: boolean; metadataStale?: boolean; page?: { index: number; title: string; url: string }; tabs?: Array<{ index: number; title: string; url: string }>; snapshot?: string; snapshotRedactions?: number; snapshotTruncated?: boolean; snapshotOmittedLines?: number; snapshotOmittedBytes?: number; findMatches?: number; snapshotContinuation?: string; cleanupWarnings?: string[] }): string {
  const ownership = OWNERSHIP_ACTIONS.has(result.action) ? ` (${result.ownership})` : "";
  const lines = [`Browser ${result.action} ${result.outcome}${ownership}.`];
  if (PAGE_CONTEXT_ACTIONS.has(result.action)) {
    if (result.metadataAvailable === false && !result.page) lines.push("Page metadata unavailable.");
    else if (result.metadataStale && PAGE_CHANGE_ACTIONS.has(result.action)) lines.push("Page metadata may be stale.");
    if (result.page) lines.push(`Page: ${result.page.title} (${result.page.url})`);
  }
  if (result.tabs) lines.push(`Tabs: ${result.tabs.map((tab) => `${tab.index}: ${tab.title} (${tab.url})`).join(" | ")}`);
  if (result.snapshot) lines.push(`Snapshot:\n${result.snapshot}`);
  if (result.snapshotRedactions) lines.push(`Redactions: ${result.snapshotRedactions}.`);
  if (result.snapshotTruncated) lines.push(`Remaining: ${result.snapshotOmittedLines ?? 0} lines / ${result.snapshotOmittedBytes ?? 0} bytes.`);
  if (result.snapshotContinuation) lines.push(`Continuation: ${result.snapshotContinuation}`);
  if (result.action === "find" && ((result.findMatches ?? 0) > 20 || result.snapshotTruncated)) lines.push("Refine find query or continue with returned cursor.");
  for (const warning of result.cleanupWarnings ?? []) lines.push(`Warning: ${warning}.`);
  return lines.join("\n");
}

async function withBrowserStatus<T>(ctx: any, action: string, operation: () => Promise<T>): Promise<T> {
  if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", `browser: ${action}`);
  try { return await operation(); }
  finally { if (ctx.hasUI) ctx.ui.setStatus?.("pi-helios", undefined); }
}

export default function heliosExtension(pi: ExtensionAPI) {
  const exec = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number; cwd?: string }) => pi.exec(command, args, options);
  const manager = new BrowserSessionManager(exec);
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
      try {
        const version = await cachedHealthDiagnostic();
        return {
          version: 1,
          owner: "pi-helios",
          label: "Helios",
          lines: [`CLI: ${version}`, `Browser sessions: ${sessions.total} (${sessions.owned} owned, ${sessions.attached} attached, ${sessions.cleanupRequired} cleanup-required)`, "Web Scout browser broker: ready"],
          warning: sessions.cleanupRequired > 0,
        };
      } catch (error) {
        return {
          version: 1,
          owner: "pi-helios",
          label: "Helios",
          lines: [error instanceof Error ? `CLI: ${error.message}` : "CLI: unavailable", `Browser sessions: ${sessions.total}`],
          warning: true,
        };
      }
    })());
  });
  let ownedHeaded = true;
  pi.on("session_start", () => {
    ownedHeaded = true;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-helios",
      managedTools: ["helios_browser", "helios_capture"],
      enabledTools: ["helios_browser", "helios_capture"],
      deferredTools: ["helios_browser", "helios_capture"],
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-helios" });
    disposeWebScoutCapability();
    disposeHealth();
    const summary = await manager.shutdown();
    if (!ctx.hasUI) return;
    if (summary.failures.length) ctx.ui.notify(`Helios could not ${summary.failures.map((item) => item.action).join("/")} ${summary.failures.length} browser session(s). Browser cleanup remains uncertain.`, "error");
    for (const warning of summary.cleanupWarnings) ctx.ui.notify(`Helios cleanup warning: ${warning}`, "warning");
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
      const active = manager.get(sessionId(ctx));
      const unchanged = active?.ownership === "owned" ? " Active owned session unchanged." : "";
      ctx.ui.notify(`Future Helios-owned browsers: ${ownedHeaded ? "shown" : "hidden (headless)"}.${unchanged}`, "info");
    },
  });

  pi.registerTool({
    name: "helios_capture",
    label: "Helios Capture",
    description: "Capture one named Windows window after visible user confirmation, then attach it for visual debugging. Never captures whole desktop, runs in background, or controls input.",
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
    description: "Use one owned browser session with an isolated profile, or one consented attached browser session, for constrained navigation, targeted snapshot search, bounded/continued page snapshots, element-reference interaction, screenshots, and tabs. No raw Playwright commands, scripts, storage, network interception, uploads, or downloads.",
    promptSnippet: "Use one owned browser with an isolated profile or one consented attached browser through constrained Playwright actions",
    promptGuidelines: [
      "Use only for user-requested browser work; start or attach first, then close or detach when done. Never monitor. User must supervise purchases, messages, publishing, destructive actions, and other consequential clicks.",
      "Act through returned element references; never guess selectors. Prefer find for narrow text, otherwise start snapshots at depth 4–6 or target a returned ref.",
      "Use continuation cursors to read remaining output; each chunk replaces prior usable refs. Refine truncated searches instead of broadening immediately.",
      "Batch only predetermined, non-consequential actions with known refs; separate calls when an earlier result determines the next action.",
    ],
    parameters: browserSchema,
    executionMode: "sequential",
    async execute(toolCallId, params: BrowserInput, signal, onUpdate, ctx) {
      const executeAction = async (params: BrowserParams) => {
        const id = sessionId(ctx);
      if (params.action === "start") {
        rejectExtra(params, ["url", "browser"]);
        const result = await withBrowserStatus(ctx, "start", () => manager.start(id, params.url, signal, ownedHeaded));
        return { content: [{ type: "text" as const, text: describe(result) }], details: result };
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
          return { content: [{ type: "text" as const, text: describe(result) }], details: result };
        }
        if (params.endpoint !== undefined) throw new Error("Extension attachment does not accept endpoint");
        const browser = requireField(params, "browser");
        const approved = await ctx.ui.confirm("Attach through browser extension?", `Helios will connect through enabled Playwright bridge in ${browser}. Tabs, logins, and page data allowed by extension may become accessible to selected model provider and retained in Pi session history. Helios will detach without closing browser.`);
        if (!approved) return { content: [{ type: "text" as const, text: "User declined browser attachment." }], details: { declined: true } };
        const result = await withBrowserStatus(ctx, "attach", () => manager.attachExtension(id, browser, signal));
        return { content: [{ type: "text" as const, text: describe(result) }], details: result };
      }
      if (params.action === "close" || params.action === "detach") {
        rejectExtra(params, []);
        const action = params.action;
        const result = await withBrowserStatus(ctx, action, () => manager.close(id, action, signal));
        return { content: [{ type: "text" as const, text: describe(result) }], details: result };
      }
      if (params.action === "screenshot" && ctx.model && !ctx.model.input.includes("image")) throw new Error("Selected model does not support image input");
      if (params.action === "tabs" && params.tabAction === "close" && manager.get(id)?.ownership !== "owned") {
        if (!ctx.hasUI || !await ctx.ui.confirm("Close user browser tab?", `Helios will close tab ${params.tabIndex ?? "current"} in attached user browser.`)) {
          return { content: [{ type: "text" as const, text: "User declined tab close." }], details: { declined: true } };
        }
      }
      onUpdate?.({ content: [{ type: "text" as const, text: `Running browser ${params.action}...` }], details: {} });
      const result = await withBrowserStatus(ctx, params.action, () => manager.operate(id, browserAction(params), signal));
      if (!result.artifactPath) return { content: [{ type: "text" as const, text: describe(result) }], details: result };
      try {
        const image = await createReadToolDefinition(ctx.cwd).execute(toolCallId, { path: result.artifactPath }, signal, onUpdate, ctx);
        const details = { ...result, artifactPath: undefined };
        return { content: [{ type: "text" as const, text: describe(result) }, ...image.content], details };
      } finally {
        await rm(result.artifactPath, { force: true }).catch(() => {
          if (ctx.hasUI) ctx.ui.notify("Helios could not delete temporary browser screenshot.", "warning");
        });
      }
      };

      if (params.actions === undefined) {
        if (params.action === undefined) throw new Error("helios_browser requires action or actions");
        return executeAction(params as BrowserParams);
      }
      if (Object.entries(params).some(([key, value]) => key !== "actions" && value !== undefined)) {
        throw new Error("Browser batch must contain only actions");
      }
      const content: any[] = [];
      const steps: Array<{ action: string; details: unknown }> = [];
      for (const [index, action] of params.actions.entries()) {
        let result;
        try {
          result = await executeAction(action);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Browser batch step ${index + 1} (${action.action}) failed: ${message}`, { cause: error });
        }
        steps.push({ action: action.action, details: result.details });
        for (const item of result.content) {
          content.push(item.type === "text" ? { ...item, text: `Step ${index + 1} (${action.action}):\n${item.text}` } : item);
        }
        if ((result.details as { declined?: boolean }).declined) {
          return { content, details: { steps, completed: steps.length, stoppedAt: index + 1, reason: "declined" } };
        }
      }
      return { content, details: { steps, completed: steps.length } };
    },
  });
}

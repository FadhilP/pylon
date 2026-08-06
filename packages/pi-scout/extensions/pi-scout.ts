import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  configPath,
  loadConfig,
  parseModelRef,
  repoTimeoutMs,
  scoutMaxCostUsd,
  isScoutEnabled,
  saveConfig,
  thinkingLevels,
  type ThinkingLevel,
} from "../src/config.ts";
import { repoResult } from "../src/result.ts";
import { buildParentContext } from "../src/parent-context.ts";
import { REPO_SCOUT_PROMPT, WEB_SCOUT_PROMPT } from "../src/prompts.ts";
import { capReport, capText, mergeEvidenceAnchors, SCOUT_REPORT_MAX_BYTES, structuredClaims } from "../src/result.ts";
import { scoutChildEnv } from "../src/child-env.ts";
import { runPi, type ScoutActivity, type ScoutRun } from "../src/runner.ts";
import { sanitizeFailureMessage } from "../src/redact.ts";
import { DELEGATE_MAX_ATTEMPTS, isTransientProviderFailure, waitForDelegateRetry } from "../src/retry.ts";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const scoutChildToolsExtension = join(packageDir, "src", "scout-child-tools.ts");
const HEARTBEAT_MS = 1_000;
const WEB_SCOUT_TIMEOUT_MS = 5 * 60 * 1000;
const WEB_SCOUT_GRANT_ENV = "PI_HELIOS_WEB_SCOUT_GRANT";

type DiscoverChildToolsCapability = {
  version: 2;
  owner: "pi-discover";
  childExtensionPath: string;
  toolNames: readonly ["rg", "fd", "relationship_graph", "symbol_search", "code_search", "index_status"];
};

function regularFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function discoverChildToolsCapability(pi: ExtensionAPI): DiscoverChildToolsCapability | undefined {
  const responses: unknown[] = [];
  pi.events.emit("pi-discover:child-tools-capability", { version: 2, respond: (value: unknown) => responses.push(value) });
  if (responses.length !== 1) return undefined;
  const value = responses[0] as Partial<DiscoverChildToolsCapability>;
  if (
    value?.version !== 2 ||
    value.owner !== "pi-discover" ||
    typeof value.childExtensionPath !== "string" ||
    !isAbsolute(value.childExtensionPath) ||
    basename(value.childExtensionPath) !== "discover-child-tools.ts" ||
    !regularFile(value.childExtensionPath) ||
    !Array.isArray(value.toolNames) ||
    value.toolNames.length !== 6 ||
    value.toolNames[0] !== "rg" ||
    value.toolNames[1] !== "fd" ||
    value.toolNames[2] !== "relationship_graph" ||
    value.toolNames[3] !== "symbol_search" ||
    value.toolNames[4] !== "code_search" ||
    value.toolNames[5] !== "index_status"
  ) return undefined;
  return value as DiscoverChildToolsCapability;
}

type WebScoutCapability = {
  version: 1;
  owner: "pi-helios";
  childExtensionPath: string;
  issueGrant(options: { maxPages: number; maxActions: number; headed: boolean }): Promise<{ value: string; revoke: () => Promise<void> }>;
};

function webScoutCapability(pi: ExtensionAPI): WebScoutCapability | undefined {
  const responses: unknown[] = [];
  pi.events.emit("pi-helios:web-scout-capability", { version: 1, requestId: randomUUID(), respond: (value: unknown) => responses.push(value) });
  if (responses.length !== 1) return undefined;
  const value = responses[0] as Partial<WebScoutCapability>;
  if (value.version !== 1 || value.owner !== "pi-helios" || typeof value.childExtensionPath !== "string" || !value.childExtensionPath.endsWith("web-scout-browser.ts") || typeof value.issueGrant !== "function") return undefined;
  return value as WebScoutCapability;
}

function webStartUrl(value: string): string {
  if (value.length > 2048) throw new Error("Web Scout URL exceeds 2048 character limit");
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("Web Scout start URLs must be public HTTP(S) URLs without credentials");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") throw new Error("Web Scout start URLs permit only ports 80 and 443");
  return url.href;
}

function modelName(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}
function delegatedName(pi: ExtensionAPI, kind: "repo_scout" | "web_scout", callId: string): string {
  let assigned: string | undefined;
  pi.events.emit("pylon:delegate-name", {
    version: 1,
    kind,
    callId,
    respond: (name: unknown) => {
      if (typeof name === "string" && /^S\d+$/.test(name)) assigned = name;
    },
  });
  return assigned ?? `S-${callId.replace(/[^a-z0-9]/gi, "").slice(-4) || "run"}`;
}
export function startsNewRepoSequence(event: { source: string; streamingBehavior?: string }): boolean {
  return event.source !== "extension" && event.streamingBehavior !== "steer";
}
export function usageText(run: ScoutRun): string {
  const u = run.usage;
  return `${run.turns.length} turn${run.turns.length === 1 ? "" : "s"} · ${u.input} input · ${u.output} output · R${u.cacheRead} · W${u.cacheWrite} · $${u.cost.toFixed(4)} · ${(run.durationMs / 1000).toFixed(1)}s`;
}
const addUsage = (left: ScoutRun["usage"], right: ScoutRun["usage"]): ScoutRun["usage"] => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  cost: left.cost + right.cost,
});
function activityText(items: readonly ScoutActivity[]): string {
  return items
    .map(
      (item) =>
        `${item.kind === "call" ? ">" : item.isError ? "!" : "<"} ${item.tool} ${item.text}`,
    )
    .join("\n");
}

const searchTools = new Set(["search_excerpt", "rg", "grep", "fd", "find"]);
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.trim() : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
}
export function searchTelemetry(activity: readonly ScoutActivity[], seen: Set<string>) {
  let searches = 0;
  let repeatedSearches = 0;
  for (const item of activity) {
    if (item.kind !== "call" || !searchTools.has(item.tool)) continue;
    searches++;
    let args: unknown = item.text;
    try { args = JSON.parse(item.text); } catch { /* Hash bounded raw activity text. */ }
    const key = createHash("sha256").update(`${item.tool}\0${JSON.stringify(stableValue(args))}`).digest("hex");
    if (seen.has(key)) repeatedSearches++;
    else seen.add(key);
  }
  return { searches, repeatedSearches };
}

export function repoScoutOrientationGuidance(selectedTools?: readonly string[]): string | undefined {
  const selected = new Set(selectedTools ?? []);
  if (!selected.has("repo_scout")) return undefined;
  const uses = [
    selected.has("symbol_search") && "`symbol_search` for identifiers",
    selected.has("code_search") && "`code_search` for concepts",
    selected.has("relationship_graph") && "`relationship_graph` for known tokens",
    selected.has("fd") && "`fd` for live paths",
    selected.has("rg") && "`rg` for live content, regex, config, or index misses",
    selected.has("find") && "`find` for paths",
    selected.has("grep") && "`grep` for live content or regex",
    selected.has("read") && "`read` for narrow source ranges",
  ].filter((value): value is string => Boolean(value));
  if (!uses.length) return undefined;
  return `Repo Scout orientation tools currently visible: ${uses.join("; ")}. Unless exact anchors already exist, use 1–3 targeted searches, then prompt repo_scout with concrete anchors; leave non-local tracing to Scout.`;
}

export default function scoutExtension(pi: ExtensionAPI, runChild = runPi, retryWait = waitForDelegateRetry) {
  let repoRuns = 0;
  let activeRepoCalls = 0;
  const repoCallNumbers = new Map<string, number>();
  const seenRepoSearches = new Set<string>();
  const repoSessionDirs = new Set<string>();

  const repoCallNumber = (id: string) => {
    const current = repoCallNumbers.get(id);
    if (current) return current;
    const next = ++repoRuns;
    repoCallNumbers.set(id, next);
    return next;
  };
  const repoSessionDir = () =>
    mkdtemp(join(tmpdir(), "pi-scout-agent-")).then((dir) => {
      repoSessionDirs.add(dir);
      return dir;
    });

  const resolveModel = async (ctx: any) => {
    const config = await loadConfig();
    if (!config.model) return ctx.model;
    const ref = parseModelRef(config.model);
    return ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
  };
  const resolveThinking = async () =>
    (await loadConfig()).thinking ?? pi.getThinkingLevel();
  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond((async () => {
      const config = await loadConfig();
      const webReady = Boolean(webScoutCapability(pi));
      return {
        version: 1,
        owner: "pi-scout",
        label: "Scout",
        lines: [
          `State: ${config.disabled ? "disabled" : isScoutEnabled(config) ? "active" : "inactive"}`,
          `Model: ${config.model ?? "current main model"}`,
          `Web Scout: ${webReady ? "Helios broker ready" : "Helios broker unavailable"}`,
        ],
        warning: !webReady,
      };
    })());
  });
  const refreshTool = async (agentDir?: string) => {
    const enabled = isScoutEnabled(await loadConfig(agentDir ? configPath(agentDir) : undefined));
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-scout",
      managedTools: ["repo_scout", "web_scout"],
      enabledTools: enabled ? ["repo_scout", "web_scout"] : [],
      ...(enabled ? {
        deferredTools: ["web_scout"],
        deferredToolUsage: { web_scout: "research current public web pages with bounded URL-cited evidence" },
      } : {}),
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter((name) => name !== "repo_scout" && name !== "web_scout");
    if (enabled) active.push("repo_scout", "web_scout");
    pi.setActiveTools(active);
  };

  const disposeSettingsRefresh = pi.events.on("pylon:package-settings-changed", (request: any) => {
    if (request?.version !== 1 || request.packageId !== "pi-scout" || typeof request.agentDir !== "string"
      || typeof request.acknowledge !== "function") return;
    request.acknowledge(() => refreshTool(request.agentDir));
  });
  pi.on("session_start", () => refreshTool());
  pi.on("session_shutdown", async () => {
    disposeHealth();
    disposeSettingsRefresh();
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-scout",
    });
    await Promise.all(
      [...repoSessionDirs].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    if (startsNewRepoSequence(event)) {
      repoRuns = 0;
      seenRepoSearches.clear();
    }
  });

  pi.on("before_agent_start", (event) => {
    const orientationGuidance = repoScoutOrientationGuidance(event.systemPromptOptions?.selectedTools);
    if (!orientationGuidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${orientationGuidance}` };
  });

  pi.registerTool({
    name: "repo_scout",
    label: "Repo Scout",
    description:
      "Read-only isolated repository reconnaissance with exact line-range citations. It gathers observable evidence; the main model owns evaluation, recommendations, decisions, and conclusions. Transient provider failures retry in fresh child sessions up to three total attempts.",
    promptSnippet:
      "Gather cited repository evidence about paths, symbols, boundaries, data flow, cross-file impact, exact line ranges, and uncertainty without making decisions",
    promptGuidelines: [
      "Default to repo_scout for non-local, architecture-mapping, data-flow, cross-file, or unfamiliar-code work. Before calling, use 1–3 visible orientation searches to find exact anchors and sharpen the task. Skip orientation with exact anchors. Leave non-local tracing to repo_scout; skip it only for known-file self-contained work.",
      "Ask repo_scout only to search, map, or trace observable evidence. Convert normative or mixed questions into factual tasks covering contracts, callers, transformations, divergences, constraints, and tests; never ask repo_scout to design, recommend, prioritize, choose architecture, or decide whether something should be canonical. Include an observable action, concrete scope anchors, required evidence, and a finite stopping boundary. Main model evaluates and decides.",
      "Treat repo_scout citations as working set. Reread only for exact edit, evidence gap/conflict, or changed state. Follow-ups include prior facts and unresolved gap; each repo_scout child starts fresh.",
    ],
    parameters: Type.Object(
      {
        task: Type.String({
          minLength: 1,
          maxLength: 1500,
          description:
            "Evidence-only repository search, mapping, or tracing task with observable scope, paths, symbols, boundaries, inputs, sinks, or flows; exclude design, recommendation, prioritization, and architecture-choice requests",
        }),
        retryReason: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 500,
            description: "Factual evidence gap or follow-up context for a later Scout call; not a decision or recommendation request",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      if (!isScoutEnabled(await loadConfig()))
        return {
          content: [{ type: "text" as const, text: "Repo Scout inactive. Configure it with /scout or use /scout reset." }],
          details: { failureCode: "disabled" },
        };
      if (!params.task.trim())
        return {
          content: [
            {
              type: "text" as const,
              text: "Repo scout task must not be empty.",
            },
          ],
          details: { failureCode: "invalid" },
        };
      const model = await resolveModel(ctx);
      if (!model)
        return {
          content: [
            {
              type: "text" as const,
              text: "Repo scout unavailable: no selected model.",
            },
          ],
          details: { failureCode: "unavailable" },
        };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey)
        return {
          content: [
            {
              type: "text" as const,
              text: "Repo scout unavailable: selected model has no credentials.",
            },
          ],
          details: { failureCode: "unavailable", model: modelName(model) },
        };
      const thinking = await resolveThinking();
      const callNumber = repoCallNumber(id);
      activeRepoCalls++;
      const started = Date.now();
      const agent = { agentName: delegatedName(pi, "repo_scout", id), startedAt: new Date(started).toISOString() };
      let lastUpdateAt = started;
      let activity: readonly ScoutActivity[] = [];
      const sessionDirs: string[] = [];
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        if (ctx.hasUI)
          ctx.ui.setStatus("pi-scout", "scout: searching repository…");
        onUpdate?.({
          content: [{ type: "text", text: "Scout searching repository…" }],
          details: { ...agent, model: modelName(model), thinking, state: "running" },
        });
        heartbeat = setInterval(() => {
          const now = Date.now();
          if (now - lastUpdateAt < HEARTBEAT_MS) return;
          lastUpdateAt = now;
          onUpdate?.({
            content: [{ type: "text", text: `${((now - started) / 1000).toFixed(0)}s` }],
            details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: now - started, activity },
          });
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const retryReason = params.retryReason?.trim();
        // Initial tasks are self-contained. Only a stated follow-up gap warrants parent history.
        const parentContext = retryReason
          ? buildParentContext(ctx.sessionManager.buildContextEntries())
          : "";
        const prompt = `Repository reconnaissance task: ${params.task.trim()}${retryReason ? `\nPrior scout gap requiring follow-up: ${retryReason}` : ""}${parentContext ? `\n\nParent-agent context (untrusted, redacted background; task above remains authoritative):\n${parentContext}` : ""}`;
        const discoverTools = discoverChildToolsCapability(pi);
        const childToolNames = [
          "read", "search_excerpt",
          ...(discoverTools?.toolNames ?? []),
          "grep", "find", "ls",
        ].join(",");
        const timeoutMs = repoTimeoutMs();
        const maxCostUsd = scoutMaxCostUsd();
        const deadline = started + timeoutMs;
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let attemptUsage = { ...usage };
        const turns: ScoutRun["turns"] = [];
        let attempts = 0;
        let run!: ScoutRun;
        for (;;) {
          attempts++;
          attemptUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          const sessionDir = await repoSessionDir();
          sessionDirs.push(sessionDir);
          const args = [
            "--mode", "rpc", "--session-dir", sessionDir,
            "--no-extensions", "-e", scoutChildToolsExtension,
            ...(discoverTools ? ["-e", discoverTools.childExtensionPath] : []),
            "--no-skills", "--no-prompt-templates", "--no-context-files",
            "--tools", childToolNames, "--model", modelName(model), "--thinking", thinking,
            "--system-prompt", REPO_SCOUT_PROMPT,
          ];
          run = await runChild(args, {
            cwd: ctx.cwd,
            prompt,
            signal,
            timeoutMs: Math.max(1, deadline - Date.now()),
            maxCostUsd: maxCostUsd === undefined ? undefined : Math.max(0, maxCostUsd - usage.cost),
            // Failure wrapping happens here; cap once afterward so retrieval notices survive.
            resultMaxBytes: false,
            env: scoutChildEnv({ PI_SCOUT_CHILD: "1" }, process.env, model.provider),
            concurrent: true,
            onUsage: (snapshot) => {
              attemptUsage = snapshot;
              lastUpdateAt = Date.now();
              onUpdate?.({
                content: [{ type: "text", text: "Scout usage updated" }],
                details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: lastUpdateAt - started, usage: addUsage(usage, attemptUsage), activity, attempts },
              });
            },
            onActivity: (_item, all) => {
              lastUpdateAt = Date.now();
              activity = all;
              onUpdate?.({
                content: [{ type: "text", text: `Scout child activity:\n${activityText(all)}` }],
                details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: lastUpdateAt - started, usage: addUsage(usage, attemptUsage), activity: all, attempts },
              });
            },
          });
          usage.input += run.usage.input;
          usage.output += run.usage.output;
          usage.cacheRead += run.usage.cacheRead;
          usage.cacheWrite += run.usage.cacheWrite;
          usage.cost += run.usage.cost;
          attemptUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          turns.push(...run.turns);
          const canRetry = attempts < DELEGATE_MAX_ATTEMPTS
            && Date.now() < deadline
            && (maxCostUsd === undefined || usage.cost < maxCostUsd)
            && run.failure !== "budget_exceeded"
            && isTransientProviderFailure(run.error);
          if (!canRetry || !await retryWait(attempts, signal)) break;
          if (signal?.aborted || Date.now() >= deadline || (maxCostUsd !== undefined && usage.cost >= maxCostUsd)) break;
          onUpdate?.({
            content: [{ type: "text", text: `Scout provider unavailable; retrying (${attempts + 1}/${DELEGATE_MAX_ATTEMPTS})…` }],
            details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: Date.now() - started, usage: { ...usage }, attempts },
          });
        }
        // Include any failure wrapper in the same hard report budget as child output.
        const failureMessage = run.error
          ? sanitizeFailureMessage(run.error, "Repo Scout child failed.")
          : undefined;
        const report = capReport(repoResult(run.text, failureMessage), SCOUT_REPORT_MAX_BYTES);
        const omittedEvidence = mergeEvidenceAnchors([...(run.omittedEvidence ?? []), ...report.omittedEvidence]);
        const claims = structuredClaims(report.text);
        const searches = searchTelemetry(run.activity, seenRepoSearches);
        return {
          content: [{ type: "text" as const, text: `[${agent.agentName} · Repo Scout] ${report.text}` }],
          details: {
            ...agent,
            task: params.task.trim(),
            retryReason: params.retryReason?.trim(),
            callNumber,
            contextTokens: run.contextTokens,
            cacheReadTokens: run.cacheReadTokens,
            model: modelName(model),
            thinking,
            durationMs: Date.now() - started,
            usage,
            turns,
            attempts,
            activity: run.activity,
            stopReason: run.stopReason,
            truncated: run.truncated || report.truncated,
            omittedEvidence,
            structuredClaims: claims,
            duplicateTelemetry: {
              reportBlocks: report.deduplicatedBlocks,
              reportBytes: report.deduplicatedBytes,
            },
            searchTelemetry: searches,
            stderr: run.stderr,
            budgetExceeded: run.budgetExceeded,
            finalizationAttempted: run.finalizationAttempted,
            finalizationSucceeded: run.finalizationSucceeded,
            failureCode: run.failure === "budget_exceeded" ? "budget_exceeded" : run.error ? "child_error" : undefined,
            ...(failureMessage ? { failureMessage } : {}),
          },
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        for (const sessionDir of sessionDirs) repoSessionDirs.delete(sessionDir);
        await Promise.allSettled(sessionDirs.map((sessionDir) => rm(sessionDir, { recursive: true, force: true })));
        repoCallNumbers.delete(id);
        activeRepoCalls = Math.max(0, activeRepoCalls - 1);
        if (ctx.hasUI && activeRepoCalls === 0) {
          try { ctx.ui.setStatus("pi-scout", undefined); }
          catch { /* UI cleanup must not replace the Scout result. */ }
        }
      }
    },
    renderCall(args, theme, context) {
      const callNumber = (context.state.callNumber as number | undefined) ?? repoCallNumber(context.toolCallId);
      context.state.callNumber = callNumber;
      const prompt = args.task.trim().replace(/\s+/g, " ");
      const truncatedPrompt = prompt.length > 512 ? `${prompt.slice(0, 509)}...` : prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("Scout")) +
          theme.fg("muted", ` · ${callNumber}/∞`) +
          `\n${theme.fg("dim", truncatedPrompt)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      const body = result.content.find((c: any) => c.type === "text") as any;
      let text = theme.fg(
        details?.failureCode ? "error" : "success",
        `Scout${details?.failureCode ? " failed" : ""} · ${details?.model ?? "Unavailable"}`,
      );
      if (details?.usage)
        text += ` · ${usageText({ usage: details.usage, turns: details.turns ?? [], durationMs: details.durationMs, text: "", stderr: "", truncated: false, exitCode: 0, activity: details.activity ?? [], budgetExceeded: false, finalizationAttempted: false, finalizationSucceeded: false } as ScoutRun)}`;
      else if (details?.durationMs)
        text += ` · ${(details.durationMs / 1000).toFixed(0)}s`;
      if (expanded && details?.activity?.length)
        text += `\n\nChild activity:\n${activityText(details.activity)}`;
      if (details?.failureCode && body?.text) text += `\n${body.text}`;
      else if (expanded && body?.text) text += `\n\nScout report:\n${body.text}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_scout",
    label: "Web Scout",
    description: "Research current browser-rendered public HTTP(S) pages only when the user requests it, using a fresh temporary Helios browser and separate Scout model without per-call confirmation. Give a concrete evidence task and useful starting URLs when known. Private/reserved networks and user browser state are unavailable. Never use for login, accounts, purchases, messages, publishing, permissions, forms, downloads, uploads, or monitoring. Returns bounded URL-cited evidence for the main model to evaluate and use in any consequential decision.",
    promptSnippet: "Research public web pages in a fresh isolated browser and return bounded URL-cited evidence",
    promptGuidelines: [
      "Use web_scout only when user asks for current public-web research needing browser-rendered pages. It launches a fresh isolated browser without per-call confirmation. Give a concrete research task and useful starting URLs when known. Keep evaluation and consequential decisions in main model. Never use web_scout for login, accounts, purchases, messages, publishing, permissions, forms, downloads, uploads, private networks, or monitoring.",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 1000, description: "Concrete public-web research question and evidence needed" }),
      startUrls: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 8, uniqueItems: true })),
      maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 8 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!isScoutEnabled(await loadConfig())) return { content: [{ type: "text" as const, text: "Web Scout inactive. Configure it with /scout or use /scout reset." }], details: { failureCode: "disabled" } };
      const task = params.task.trim();
      if (!task) return { content: [{ type: "text" as const, text: "Web scout task must not be empty." }], details: { failureCode: "invalid" } };
      let startUrls: string[];
      try { startUrls = (params.startUrls ?? []).map(webStartUrl); }
      catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Invalid Web Scout start URL." }], details: { failureCode: "invalid" } }; }
      const capability = webScoutCapability(pi);
      if (!capability) return { content: [{ type: "text" as const, text: "Web scout unavailable: exactly one compatible pi-helios capability is required." }], details: { failureCode: "unavailable" } };
      const model = await resolveModel(ctx);
      if (!model) return { content: [{ type: "text" as const, text: "Web scout unavailable: no selected model." }], details: { failureCode: "unavailable" } };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return { content: [{ type: "text" as const, text: "Web scout unavailable: selected model has no credentials." }], details: { failureCode: "unavailable", model: modelName(model) } };
      const thinking = await resolveThinking();
      const maxPages = params.maxPages ?? 8;
      const maxActions = Math.min(80, maxPages * 6 + 8);
      const grant = await capability.issueGrant({ maxPages, maxActions, headed: false });
      const started = Date.now();
      const agent = { agentName: delegatedName(pi, "web_scout", id), startedAt: new Date(started).toISOString() };
      if (ctx.hasUI) ctx.ui.setStatus("pi-scout", "scout: researching public web…");
      onUpdate?.({ content: [{ type: "text", text: "Web Scout launching isolated browser…" }], details: { ...agent, model: modelName(model), thinking, state: "running" } });
      let lastUpdateAt = started;
      let activity: readonly ScoutActivity[] = [];
      const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastUpdateAt < HEARTBEAT_MS) return;
        lastUpdateAt = now;
        onUpdate?.({ content: [{ type: "text", text: `${((now - started) / 1000).toFixed(0)}s` }], details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: now - started } });
      }, HEARTBEAT_MS);
      heartbeat.unref();
      try {
        const prompt = `Public web research task: ${task}\nAccess date: ${new Date().toISOString().slice(0, 10)}.${startUrls.length ? `\nSuggested starting URLs:\n${startUrls.map((value) => `- ${value}`).join("\n")}` : "\nNo starting URL supplied; choose relevant public authoritative sources."}`;
        const args = [
          "--mode", "rpc", "--no-session", "--no-extensions", "-e", capability.childExtensionPath,
          "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
          "--no-builtin-tools", "--tools", "scout_browser", "--model", modelName(model),
          "--thinking", thinking, "--system-prompt", WEB_SCOUT_PROMPT,
        ];
        const run = await runChild(args, {
          cwd: ctx.cwd,
          prompt,
          signal,
          timeoutMs: WEB_SCOUT_TIMEOUT_MS,
          maxCostUsd: scoutMaxCostUsd(),
          env: scoutChildEnv({ [WEB_SCOUT_GRANT_ENV]: grant.value }, process.env, model.provider),
          inheritEnv: false,
          onUsage: (usage) => {
            lastUpdateAt = Date.now();
            onUpdate?.({ content: [{ type: "text", text: "Web Scout usage updated" }], details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: lastUpdateAt - started, usage, activity } });
          },
          onActivity: (_item, all) => {
            lastUpdateAt = Date.now();
            activity = all;
            onUpdate?.({ content: [{ type: "text", text: `Web Scout child activity:\n${activityText(all)}` }], details: { ...agent, model: modelName(model), thinking, state: "running", durationMs: lastUpdateAt - started, activity: all } });
          },
        });
        const failureMessage = run.error
          ? sanitizeFailureMessage(run.error, "Web Scout child failed.")
          : undefined;
        const text = failureMessage ? `Web scout failed nonfatally: ${failureMessage}` : run.text;
        return {
          content: [{ type: "text" as const, text: `[${agent.agentName} · Web Scout] ${text}` }],
          details: {
            ...agent,
            task,
            startUrls,
            maxPages,
            model: modelName(model),
            thinking,
            durationMs: run.durationMs,
            usage: run.usage,
            turns: run.turns,
            stopReason: run.stopReason,
            truncated: run.truncated,
            budgetExceeded: run.budgetExceeded,
            finalizationAttempted: run.finalizationAttempted,
            finalizationSucceeded: run.finalizationSucceeded,
            failureCode: run.failure === "budget_exceeded" ? "budget_exceeded" : run.error ? "child_error" : undefined,
            ...(failureMessage ? { failureMessage } : {}),
            activity: run.activity,
          },
        };
      } finally {
        clearInterval(heartbeat);
        await grant.revoke();
        if (ctx.hasUI) ctx.ui.setStatus("pi-scout", undefined);
      }
    },
    renderCall(args, theme) {
      const prompt = args.task.trim().replace(/\s+/g, " ");
      return new Text(theme.fg("toolTitle", theme.bold("Web Scout")) + `\n${theme.fg("dim", prompt.length > 512 ? `${prompt.slice(0, 509)}...` : prompt)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as any;
      let text = theme.fg(details?.failureCode ? "warning" : "success", `Web Scout · ${details?.model ?? "Unavailable"}`);
      if (details?.durationMs) text += ` · ${(details.durationMs / 1000).toFixed(1)}s`;
      if (details?.maxPages) text += ` · ≤${details.maxPages} pages`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("scout", {
    description: "Select model and thinking, reset, or show status",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "disable") {
        const config = await loadConfig();
        await saveConfig({ ...config, disabled: true });
        await refreshTool();
        ctx.ui.notify("Scout disabled.", "info");
        return;
      }
      if (value === "reset") {
        await saveConfig({ version: 1, disabled: false });
        await refreshTool();
        ctx.ui.notify("Scout enabled; uses current main model.", "info");
        return;
      }
      if (value === "status") {
        const config = await loadConfig();
        const resolved = await resolveModel(ctx);
        ctx.ui.notify(
          `State: ${config.disabled ? "disabled" : isScoutEnabled(config) ? "active" : "inactive"}\nConfigured: ${config.model ?? "current main model"}\nThinking: ${config.thinking ?? "current main level"}\nResolved: ${resolved ? modelName(resolved) : "unavailable"}`,
          "info",
        );
        return;
      }
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Usage: /scout <provider/model-id[:thinking]>|disable|reset|status",
            "info",
          );
          return;
        }
        selected =
          (await ctx.ui.select(
            "Scout model",
            (ctx.scopedModels.length
              ? ctx.scopedModels.map(({ model }) => model)
              : ctx.modelRegistry.getAvailable()
            ).map(modelName),
          )) ?? "";
        if (!selected) return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`Unavailable model: ${selected}`, "error");
        return;
      }
      let thinking: ThinkingLevel | undefined = ref.thinking;
      if (!value && ctx.mode === "tui") {
        thinking = (await ctx.ui.select("Scout thinking level", [...thinkingLevels])) as
          | ThinkingLevel
          | undefined;
        if (!thinking) return;
      }
      await saveConfig({
        version: 1,
        model: modelName(model),
        ...(thinking ? { thinking } : {}),
      });
      await refreshTool();
      ctx.ui.notify(
        `Scout enabled.\nModel: ${modelName(model)}\nThinking: ${thinking ?? "current main level"}`,
        "info",
      );
    },
  });
}

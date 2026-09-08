import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PackageSettingsReadModel } from "../../shared/protocol/snapshots.ts";
import { validPackageSettings } from "../../shared/protocol/validation.ts";

const MAX_RESULT_BYTES = 32 * 1024;
const MAX_UPDATE_BYTES = 64 * 1024;
const PACKAGE_ID = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const CUSTOM_SETTING_KEYS: Record<string, readonly string[]> = {
  advisor: [
    "mode",
    "model",
    "thinking",
    "maxCalls",
    "timeoutMs",
    "maxCostUsd",
    "maxOutputTokens",
    "inputTokenBudget",
    "prompt",
  ],
  scout: ["mode", "model", "thinking", "webSearch", "repoTimeoutMs", "maxCostUsd", "webSearchResults", "prompt"],
  grunt: [
    "mode",
    "model",
    "executionMode",
    "thinkingLevels",
    "timeoutMs",
    "maxTurns",
    "maxCostUsd",
    "parentContextChars",
    "prompt",
  ],
  continuity: [
    "memoryEnabled",
    "reserveTokens",
    "keepRecentTokens",
    "planner",
    "executor",
    "memoryReviewer",
    "compactionReviewer",
    "compactionReviewTimeoutMs",
    "compactionReviewerMaxOutputTokens",
    "prompt",
  ],
  sieve: ["activePruning", "threshold", "projectionMode", "rolloverHighMultiplier", "rolloverLowMultiplier"],
  timeline: [
    "editRollbackDefault",
    "checkpointTitleMode",
    "checkpointTitleModel",
    "gitTimeoutMs",
    "titleTimeoutMs",
    "titleMaxTokens",
    "titleChangedFiles",
    "prompt",
  ],
  spawn: [
    "agentAvailability",
    "sessionAvailability",
    "models",
    "agentThinkingLevels",
    "spawnTimeoutMs",
    "recentThreadLimit",
    "recentThreadMaxChars",
    "recentThreadTotalChars",
    "privateAgentSystemPrompt",
  ],
};

export interface PylonSettingsPackageSummary {
  packageId: string;
  description: string;
  kind: PackageSettingsReadModel["kind"];
  keys: string[];
  revision: string;
}

export interface PylonSettingsReadResult {
  packageId: string;
  revision: string;
  settings: PackageSettingsReadModel;
}

export interface PylonSettingsChange {
  key: string;
  previous: unknown;
  next: unknown;
  apply: "immediate" | "next-operation" | "next-session" | "reload" | "package-defined";
  highImpact: boolean;
}

export interface PylonSettingsPreview extends PylonSettingsReadResult {
  changes: PylonSettingsChange[];
}

export type PylonSettingsToolRequest =
  | { type: "list" }
  | { type: "get"; packageId: string }
  | { type: "preview" | "update"; packageId: string; revision: string; changes: Record<string, unknown> };

export type PylonSettingsToolResponse =
  { packages: PylonSettingsPackageSummary[] } | PylonSettingsReadResult | PylonSettingsPreview;

type Handler = (request: PylonSettingsToolRequest) => Promise<PylonSettingsToolResponse>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function packageSettingsRevision(settings: PackageSettingsReadModel): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
}

export function packageSettingsKeys(settings: PackageSettingsReadModel): string[] {
  return settings.kind === "generic"
    ? settings.fields.map(field => field.key)
    : [...(CUSTOM_SETTING_KEYS[settings.kind] ?? [])];
}

export function patchPackageSettings(
  settings: PackageSettingsReadModel,
  changes: unknown,
): { settings: PackageSettingsReadModel; changes: PylonSettingsChange[] } {
  if (!plainRecord(changes)) throw new Error("changes must be an object");
  const entries = Object.entries(changes);
  if (entries.length === 0 || entries.length > 20) throw new Error("changes must contain between 1 and 20 fields");
  if (Buffer.byteLength(JSON.stringify(changes), "utf8") > MAX_UPDATE_BYTES)
    throw new Error("settings update is too large");

  let next: PackageSettingsReadModel;
  const applied: PylonSettingsChange[] = [];
  if (settings.kind === "generic") {
    const fields = new Map(settings.fields.map(field => [field.key, field]));
    for (const [key, value] of entries) {
      const field = fields.get(key);
      if (!field) throw new Error(`${key} is not a configurable ${settings.packageId} setting`);
      if (same(field.value, value)) continue;
      applied.push({
        key,
        previous: clone(field.value),
        next: clone(value),
        apply: field.apply,
        highImpact: field.type === "prompt",
      });
    }
    next = {
      ...settings,
      fields: settings.fields.map(field =>
        Object.hasOwn(changes, field.key) ? ({ ...field, value: clone(changes[field.key]) } as typeof field) : field,
      ),
    };
  } else {
    const allowed = new Set(packageSettingsKeys(settings));
    for (const [key, value] of entries) {
      if (!allowed.has(key)) throw new Error(`${key} is not a configurable ${settings.kind} setting`);
      const previous = (settings as unknown as Record<string, unknown>)[key];
      if (same(previous, value)) continue;
      applied.push({
        key,
        previous: clone(previous),
        next: clone(value),
        apply: "package-defined",
        highImpact: key.toLowerCase().includes("prompt"),
      });
    }
    next = { ...(settings as any), ...clone(changes) } as PackageSettingsReadModel;
  }
  if (!validPackageSettings(next)) throw new Error("the proposed package settings are invalid");
  return { settings: next, changes: applied };
}

function truncate(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_RESULT_BYTES) return text;
  return `${bytes.subarray(0, MAX_RESULT_BYTES - 80).toString("utf8")}\n… result truncated; inspect a narrower package.`;
}

function result(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: truncate(text) }] };
}

function displayValue(value: unknown): string {
  const serialized = JSON.stringify(value) ?? String(value);
  if (serialized.length <= 180) return serialized;
  return `${serialized.slice(0, 160)}… (${Buffer.byteLength(serialized, "utf8")} bytes)`;
}

function confirmation(preview: PylonSettingsPreview): string {
  const lines = preview.changes.map(
    change => `• ${change.key}: ${displayValue(change.previous)} → ${displayValue(change.next)} [${change.apply}]`,
  );
  if (preview.changes.some(change => change.highImpact)) {
    lines.push("Prompt changes can alter future agent behavior and do not modify the current system prompt.");
  }
  return [`Package: ${preview.packageId}`, ...lines].join("\n");
}

function parseParams(params: unknown): {
  action: "list" | "get" | "update";
  packageId?: string;
  revision?: string;
  changes?: Record<string, unknown>;
} {
  if (!plainRecord(params) || !["list", "get", "update"].includes(String(params.action))) {
    throw new Error("action must be list, get, or update");
  }
  const action = params.action as "list" | "get" | "update";
  if (action === "list") return { action };
  if (typeof params.packageId !== "string" || params.packageId.length > 128 || !PACKAGE_ID.test(params.packageId)) {
    throw new Error("packageId is invalid");
  }
  if (action === "get") return { action, packageId: params.packageId };
  if (typeof params.revision !== "string" || !/^[a-f0-9]{16}$/.test(params.revision)) {
    throw new Error("revision must come from a fresh get result");
  }
  if (!plainRecord(params.changes)) throw new Error("changes must be an object");
  return { action, packageId: params.packageId, revision: params.revision, changes: params.changes };
}

export class PylonSettingsTool {
  private handler?: Handler;

  readonly extension: InlineExtension = {
    name: "pylon-web-settings-tool",
    hidden: true,
    factory: pi => {
      const bridge = this;
      pi.registerTool({
        name: "pylon_settings",
        label: "Pylon settings",
        description:
          "List, inspect, or update validated Pylon package settings. Updates require a revision from get and explicit user confirmation. This tool cannot modify hooks, project policy, trust, extensions, Guard controls, credentials, or arbitrary files.",
        promptSnippet: "Inspect or update validated Pylon package settings after explicit confirmation",
        promptGuidelines: [
          "Use pylon_settings update only when the user explicitly asks to change Pylon package settings. Call get first, preserve unrelated values, and never edit Pylon settings JSON directly.",
        ],
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "get", "update"] },
            packageId: { type: "string", maxLength: 128 },
            revision: { type: "string", pattern: "^[a-f0-9]{16}$" },
            changes: { type: "object", additionalProperties: true, maxProperties: 20 },
          },
          required: ["action"],
          additionalProperties: false,
        } as any,
        async execute(
          _toolCallId: string,
          params: unknown,
          _signal: AbortSignal | undefined,
          _onUpdate: unknown,
          ctx: any,
        ) {
          try {
            if (!bridge.handler) throw new Error("the Pylon settings host is unavailable");
            const parsed = parseParams(params);
            if (parsed.action === "list") return result(await bridge.handler({ type: "list" }));
            if (parsed.action === "get")
              return result(await bridge.handler({ type: "get", packageId: parsed.packageId! }));

            const request = { packageId: parsed.packageId!, revision: parsed.revision!, changes: parsed.changes! };
            const preview = (await bridge.handler({ type: "preview", ...request })) as PylonSettingsPreview;
            if (preview.changes.length === 0) return result("No Pylon package settings would change.");
            if (!ctx.hasUI) return result("Pylon settings were not changed because confirmation UI is unavailable.");
            const approved = await ctx.ui.confirm(
              preview.changes.some(change => change.highImpact)
                ? "Change Pylon prompt settings?"
                : "Change Pylon settings?",
              confirmation(preview),
            );
            if (!approved) return result("The user declined the Pylon settings change.");
            return result(await bridge.handler({ type: "update", ...request }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return result(`Pylon settings request failed: ${message.slice(0, 1_000)}`);
          }
        },
      } as any);
    },
  };

  setHandler(handler: Handler): void {
    this.handler = handler;
  }
}

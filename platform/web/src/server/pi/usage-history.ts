import { createHash } from "node:crypto";
import { parseTelemetryEvent } from "pylon-core/token-meter";
import type { UsageAgent } from "../../shared/protocol/snapshots.ts";

export interface PersistedUsageAtom {
  identity: string;
  signature: string;
  sessionId: string;
  timestamp: string;
  provider: string;
  model: string;
  agent: UsageAgent;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  source: "assistant" | "compaction" | "branch-summary" | "delegated" | "telemetry";
}

type NormalizedUsage = Pick<
  PersistedUsageAtom,
  "calls" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "costKnown"
>;

const MODEL_TOOLS: Record<string, UsageAgent> = {
  advisor: "advisor",
  grunt: "grunt",
  repo_scout: "scout",
  web_scout: "scout",
  spawn_agent: "private",
};
const MAX_USAGE_ATOMS = 100_000;

const finiteTokens = (value: unknown): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

const calls = (value: unknown): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 10_000 ? number : 1;
};

const dimension = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : "unknown";
};

function modelReference(value: unknown): { provider: string; model: string } | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  const slash = normalized.indexOf("/");
  if (slash < 1 || slash === normalized.length - 1) return;
  const provider = dimension(normalized.slice(0, slash));
  const model = dimension(normalized.slice(slash + 1));
  return provider === "unknown" || model === "unknown" ? undefined : { provider, model };
}

function delegatedAttribution(details: any): { provider: string; model: string } {
  const provider = dimension(details?.provider);
  const modelId = dimension(details?.modelId);
  if (provider !== "unknown" && modelId !== "unknown") return { provider, model: modelId };
  if (provider !== "unknown") {
    const model = dimension(details?.model);
    if (model !== "unknown") return { provider, model };
  }
  return (
    modelReference(details?.advisorModel) ??
    modelReference(details?.model) ?? { provider, model: dimension(details?.model) }
  );
}

const timestamp = (entry: any, message?: any): string | undefined => {
  const raw = typeof message?.timestamp === "number" ? message.timestamp : Date.parse(entry?.timestamp);
  if (!Number.isFinite(raw)) return;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizeUsage(value: any, turnCount: unknown = 1): NormalizedUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rawCost = value.cost?.total ?? value.cost;
  const costKnown = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 && rawCost <= 1_000_000;
  return {
    calls: calls(turnCount),
    input: finiteTokens(value.input),
    output: finiteTokens(value.output),
    cacheRead: finiteTokens(value.cacheRead),
    cacheWrite: finiteTokens(value.cacheWrite),
    cost: costKnown ? rawCost : 0,
    costKnown,
  };
}

function atom(
  sessionId: string,
  source: PersistedUsageAtom["source"],
  rawIdentity: string,
  occurredAt: string | undefined,
  provider: unknown,
  model: unknown,
  agent: UsageAgent,
  usage: NormalizedUsage | undefined,
): PersistedUsageAtom | undefined {
  if (!occurredAt || !usage) return;
  const normalized = {
    timestamp: occurredAt,
    provider: dimension(provider),
    model: dimension(model),
    agent,
    ...usage,
    source,
  };
  return { identity: digest([source, rawIdentity]), signature: digest(normalized), sessionId, ...normalized };
}

export class UsageHistoryAccumulator {
  private readonly callsById = new Map<string, { name: string }>();
  private readonly atoms: PersistedUsageAtom[] = [];

  constructor(private readonly sessionId: string) {}

  accept(entry: any): void {
    if (this.atoms.length >= MAX_USAGE_ATOMS) return;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;

    if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.id === "string") {
      const item = atom(
        this.sessionId,
        entry.type === "compaction" ? "compaction" : "branch-summary",
        entry.id,
        timestamp(entry),
        undefined,
        undefined,
        "main",
        normalizeUsage(entry.usage),
      );
      if (item) this.atoms.push(item);
      return;
    }

    if (entry.type === "custom" && entry.customType === "pylon-telemetry") {
      const event = parseTelemetryEvent(entry.data);
      const item = event
        ? atom(
            this.sessionId,
            "telemetry",
            event.eventId,
            timestamp(entry),
            event.provider,
            event.model,
            "other",
            normalizeUsage(event.usage, event.usage.turns),
          )
        : undefined;
      if (item) this.atoms.push(item);
      return;
    }

    if (entry.type !== "message") return;
    const message = entry.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;

    if (message.role === "assistant") {
      const item =
        typeof entry.id === "string"
          ? atom(
              this.sessionId,
              "assistant",
              entry.id,
              timestamp(entry, message),
              message.provider,
              message.responseModel ?? message.model,
              "main",
              normalizeUsage(message.usage),
            )
          : undefined;
      if (item) this.atoms.push(item);
      if (Array.isArray(message.content))
        for (const part of message.content)
          if (
            this.callsById.size < MAX_USAGE_ATOMS &&
            part?.type === "toolCall" &&
            typeof part.id === "string" &&
            typeof part.name === "string"
          )
            this.callsById.set(part.id, { name: part.name });
      return;
    }

    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return;
    const name = typeof message.toolName === "string" ? message.toolName : this.callsById.get(message.toolCallId)?.name;
    const agent = name ? MODEL_TOOLS[name] : undefined;
    const details = message.details;
    if (!agent || !details?.usage) return;
    const attribution = delegatedAttribution(details);
    const item = atom(
      this.sessionId,
      "delegated",
      message.toolCallId,
      timestamp(entry, message),
      attribution.provider,
      attribution.model,
      agent,
      normalizeUsage(details.usage, Array.isArray(details.turns) ? details.turns.length : details.turns),
    );
    if (item) this.atoms.push(item);
  }

  result(): PersistedUsageAtom[] {
    return this.atoms;
  }
}

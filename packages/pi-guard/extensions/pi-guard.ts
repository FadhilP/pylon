import { getAgentDir, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import {
  BLOCK_GUARD_RULES,
  commandRisk,
  GUARD_RISK_CATEGORIES,
  mergeGuardRules,
  pathRisk,
  POLICY_VERSION,
  validateGuardRules,
  type GuardRisk,
  type GuardRiskCategory,
} from "../src/policy.ts";

const APPROVAL_RECORD_VERSION = 1;
const choices = ["Allow once", "Always allow this session", "Always allow on this project", "Deny"] as const;

type ApprovalIdentity = {
  policyVersion: number;
  cwd: string;
  category: GuardRiskCategory;
  operation: "command" | "path" | "path-tree";
  value: string;
};

type ApprovalRecord = { version: number; approval: ApprovalIdentity };

type StoredApproval = "allowed" | "missing" | "invalid" | "error";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identityKey = (approval: ApprovalIdentity) => JSON.stringify(approval);

type SpawnedPolicy = { enabled: boolean; rules: ReturnType<typeof mergeGuardRules>; timeout?: number | null };

const failClosed = (): SpawnedPolicy => ({ enabled: true, rules: BLOCK_GUARD_RULES });
const validTimeout = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Number.isInteger(value) && (value as number) >= 15 && (value as number) <= 86_400);

function spawnedPolicy(): SpawnedPolicy | undefined {
  const serialized = process.env.PI_SPAWN_GUARD_POLICY;
  if (serialized === undefined) return;
  if (Buffer.byteLength(serialized) > 16 * 1024) return failClosed();
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const rules = validateGuardRules(value.rules);
    const timeout = value.timeoutSeconds;
    if (value.version !== 1 || typeof value.enabled !== "boolean" || !rules || !validTimeout(timeout))
      return failClosed();
    return {
      enabled: value.enabled,
      rules: mergeGuardRules(rules),
      ...(timeout !== undefined ? { timeout: timeout as number | null } : {}),
    };
  } catch {
    return failClosed();
  }
}

function approvalScope(approval: ApprovalIdentity): {
  remembered: ApprovalIdentity;
  candidates: ApprovalIdentity[];
  directory?: string;
} {
  if (approval.operation !== "path" || approval.category !== GUARD_RISK_CATEGORIES.PATH_OUTSIDE_WORKSPACE)
    return { remembered: approval, candidates: [approval] };

  const root = parse(approval.value).root;
  const parent = dirname(approval.value);
  // Never turn one root-level file into approval for an entire drive/filesystem.
  if (parent === root) return { remembered: approval, candidates: [approval] };

  const candidates: ApprovalIdentity[] = [];
  for (let directory = parent; directory !== root; directory = dirname(directory))
    candidates.push({ ...approval, operation: "path-tree", value: directory });
  return { remembered: { ...approval, operation: "path-tree", value: parent }, candidates, directory: parent };
}

function recordPath(approval: ApprovalIdentity) {
  // Both project and approval names are hashes so no command or path text becomes a filename.
  return join(getAgentDir(), "pi-guard", "approvals", hash(approval.cwd), `${hash(identityKey(approval))}.json`);
}

function sameApproval(value: unknown, approval: ApprovalIdentity): value is ApprovalIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApprovalIdentity>;
  return (
    candidate.policyVersion === approval.policyVersion &&
    candidate.cwd === approval.cwd &&
    candidate.category === approval.category &&
    candidate.operation === approval.operation &&
    candidate.value === approval.value
  );
}

async function readProjectApproval(approval: ApprovalIdentity): Promise<StoredApproval> {
  let file: string;
  try {
    file = recordPath(approval);
  } catch {
    return "error";
  }
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as Partial<ApprovalRecord> | null;
    if (!record || typeof record !== "object") return "invalid";
    return record.version === APPROVAL_RECORD_VERSION && sameApproval(record.approval, approval)
      ? "allowed"
      : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    if (error instanceof SyntaxError) return "invalid";
    return "error";
  }
}

async function saveProjectApproval(approval: ApprovalIdentity): Promise<boolean> {
  let file: string;
  try {
    file = recordPath(approval);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: APPROVAL_RECORD_VERSION, approval }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    // A concurrent writer may have completed the same idempotent approval.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readProjectApproval(approval)) === "allowed";
    return false;
  }
}

export default function guardExtension(pi: ExtensionAPI) {
  const bootstrap = spawnedPolicy();
  let blocked = 0;
  let confirmed = 0;
  let enabled = bootstrap?.enabled ?? true;
  let lastCtx: any;
  let approvalTimeoutSeconds: number | null | undefined = bootstrap?.timeout;
  let guardRules = bootstrap?.rules ?? mergeGuardRules();
  // This closure is per extension instance; Pi replaces it when a session is replaced.
  const sessionApprovals = new Set<string>();
  const disposePolicy = pi.events.on?.("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2) return;
    if (typeof event.guardEnabled === "boolean") {
      enabled = event.guardEnabled;
      if (!enabled) lastCtx?.ui.setStatus("pi-guard", undefined);
    }
    const value = event.dialogTimeouts?.guard;
    if (value === null || (Number.isInteger(value) && value >= 15 && value <= 86_400)) {
      approvalTimeoutSeconds = value;
    }
    if (Object.prototype.hasOwnProperty.call(event, "guardRules")) {
      const overrides = validateGuardRules(event.guardRules);
      // Invalid runtime policy must never weaken a detected risk.
      guardRules = overrides ? mergeGuardRules(overrides) : BLOCK_GUARD_RULES;
    }
  });
  const dialogOptions = () =>
    approvalTimeoutSeconds === undefined
      ? undefined
      : { timeout: approvalTimeoutSeconds === null ? 0 : approvalTimeoutSeconds * 1_000 };

  const publish = (ctx: any, decision: string, reason: string, toolCallId?: string) => {
    pi.events.emit("pi-guard:decision", { version: 1, cwd: ctx.cwd, decision, reason, blocked, confirmed, toolCallId });
    if (ctx.hasUI) ctx.ui.setStatus("pi-guard", `guard: ${decision}`);
  };
  const deny = (ctx: any, reason: string, toolCallId?: string) => {
    blocked++;
    publish(ctx, "blocked", reason, toolCallId);
  };
  const blockedMessage = (reason: string, suffix = "") => `Pi Guard blocked ${reason}${suffix}.`;

  /** true = already approved, false = the store is unusable, undefined = ask the user. */
  const rememberedApproval = async (candidates: ApprovalIdentity[]): Promise<boolean | undefined> => {
    if (candidates.some(approval => sessionApprovals.has(identityKey(approval)))) return true;
    for (const approval of candidates) {
      const stored = await readProjectApproval(approval);
      if (stored === "allowed") return true;
      // An unreadable approval store is not a reason to permit a risky operation.
      if (stored === "error") return false;
    }
    return undefined;
  };

  const requestCheckpoint = async (ctx: any, reason: string) => {
    // A checkpoint belongs to an actual prompt, not an already remembered decision.
    let checkpoint: Promise<unknown> | undefined;
    pi.events.emit("pi-timeline:checkpoint-request", {
      version: 1,
      cwd: ctx.cwd,
      reason,
      respond: (value: Promise<unknown>) => {
        checkpoint = value;
      },
    });
    if (checkpoint) await checkpoint.catch(() => undefined);
  };

  const approve = async (
    ctx: any,
    category: GuardRiskCategory,
    reason: string,
    detail: string,
    operation: ApprovalIdentity["operation"],
    value: string,
  ): Promise<boolean> => {
    // Remembered consent is never usable without an interactive UI.
    if (!ctx.hasUI) return false;

    let cwd: string;
    try {
      cwd = await realpath(ctx.cwd);
    } catch {
      return false;
    }
    const scope = approvalScope({ policyVersion: POLICY_VERSION, cwd, category, operation, value });
    const remembered = await rememberedApproval(scope.candidates);
    if (remembered !== undefined) return remembered;

    await requestCheckpoint(ctx, reason);

    let selected: string | undefined;
    try {
      const scopeNote = scope.directory ? `\n\nSession/project approval remembers directory:\n${scope.directory}` : "";
      selected = await ctx.ui.select(
        `Pi-guard ${reason}\n\`${detail.slice(0, 2000)}\`${scopeNote}`,
        choices,
        dialogOptions(),
      );
    } catch {
      return false;
    }
    if (selected === "Allow once") return true;
    const key = identityKey(scope.remembered);
    if (selected === "Always allow this session") {
      sessionApprovals.add(key);
      return true;
    }
    if (selected === "Always allow on this project") {
      if (!(await saveProjectApproval(scope.remembered))) return false;
      sessionApprovals.add(key);
      return true;
    }
    // Cancellation, an unknown result, and Deny are all denials.
    return false;
  };

  type Verdict = { allowed: true } | { allowed: false; message: string };
  /** Applies the configured action for one detected risk and records the decision. */
  const decide = async (
    ctx: any,
    risk: GuardRisk,
    detail: string,
    operation: ApprovalIdentity["operation"],
    value: string,
    toolCallId?: string,
  ): Promise<Verdict> => {
    const action = guardRules[risk.category];
    if (action === "allow") return { allowed: true };
    if (action === "block") {
      deny(ctx, risk.reason, toolCallId);
      return { allowed: false, message: blockedMessage(risk.reason) };
    }
    if (await approve(ctx, risk.category, risk.reason, detail, operation, value)) {
      confirmed++;
      publish(ctx, "confirmed", risk.reason, toolCallId);
      return { allowed: true };
    }
    deny(ctx, risk.reason, toolCallId);
    return {
      allowed: false,
      message: blockedMessage(
        risk.reason,
        ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available",
      ),
    };
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    const block = (message: string) => ({ block: true as const, reason: message });

    if (isToolCallEventType("bash", event) || event.toolName === "heartbeat_start") {
      const command = isToolCallEventType("bash", event)
        ? event.input.command
        : (event.input as { command?: unknown })?.command;
      if (typeof command !== "string") {
        const reason = "invalid background command";
        deny(ctx, reason, event.toolCallId);
        return block(blockedMessage(reason));
      }
      const risk = commandRisk(command);
      if (!risk) return;
      const verdict = await decide(ctx, risk, command, "command", command, event.toolCallId);
      return verdict.allowed ? undefined : block(verdict.message);
    }

    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
    let risk;
    try {
      risk = await pathRisk(ctx.cwd, event.input.path);
    } catch {
      const reason = "write target could not be resolved safely";
      deny(ctx, reason, event.toolCallId);
      return block(blockedMessage(reason));
    }
    if (!risk) return;
    const detail = `${event.input.path}\nResolved target: ${risk.target}`;
    const verdict = await decide(ctx, risk, detail, "path", risk.target!, event.toolCallId);
    return verdict.allowed ? undefined : block(verdict.message);
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!enabled) return;
    const risk = commandRisk(event.command);
    if (!risk) return;
    const verdict = await decide(ctx, risk, event.command, "command", event.command);
    if (verdict.allowed) return;
    return { result: { output: verdict.message, exitCode: 126, cancelled: true, truncated: false } };
  });

  pi.registerCommand("guard", {
    description: "Show Pi Guard status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Pi Guard ${enabled ? "active" : "disabled by policy"}. Blocked: ${blocked}. Approved: ${confirmed}.`,
        "info",
      );
    },
  });
  pi.on("session_shutdown", () => {
    lastCtx?.ui.setStatus("pi-guard", undefined);
    lastCtx = undefined;
    disposePolicy?.();
  });
}

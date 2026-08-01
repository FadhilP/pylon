import {
  getAgentDir,
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { commandRisk, pathRisk, POLICY_VERSION } from "../src/policy.ts";

const APPROVAL_RECORD_VERSION = 1;
const choices = [
  "Allow once",
  "Always allow this session",
  "Always allow on this project",
  "Deny",
] as const;

type ApprovalIdentity = {
  policyVersion: number;
  cwd: string;
  reason: string;
  operation: "command" | "path" | "path-tree";
  value: string;
};

type ApprovalRecord = {
  version: number;
  approval: ApprovalIdentity;
};

type StoredApproval = "allowed" | "missing" | "invalid" | "error";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identityKey = (approval: ApprovalIdentity) => JSON.stringify(approval);

function approvalScope(
  approval: ApprovalIdentity,
): { remembered: ApprovalIdentity; candidates: ApprovalIdentity[]; directory?: string } {
  if (approval.operation !== "path" || approval.reason !== "write target is outside workspace")
    return { remembered: approval, candidates: [approval] };

  const root = parse(approval.value).root;
  const parent = dirname(approval.value);
  // Never turn one root-level file into approval for an entire drive/filesystem.
  if (parent === root) return { remembered: approval, candidates: [approval] };

  const candidates: ApprovalIdentity[] = [];
  for (let directory = parent; directory !== root; directory = dirname(directory))
    candidates.push({ ...approval, operation: "path-tree", value: directory });
  return {
    remembered: { ...approval, operation: "path-tree", value: parent },
    candidates,
    directory: parent,
  };
}

function recordPath(approval: ApprovalIdentity) {
  // Both project and approval names are hashes so no command or path text becomes a filename.
  return join(
    getAgentDir(),
    "pi-guard",
    "approvals",
    hash(approval.cwd),
    `${hash(identityKey(approval))}.json`,
  );
}

function sameApproval(value: unknown, approval: ApprovalIdentity): value is ApprovalIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApprovalIdentity>;
  return candidate.policyVersion === approval.policyVersion &&
    candidate.cwd === approval.cwd &&
    candidate.reason === approval.reason &&
    candidate.operation === approval.operation &&
    candidate.value === approval.value;
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
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    return true;
  } catch (error) {
    // A concurrent writer may have completed the same idempotent approval.
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return await readProjectApproval(approval) === "allowed";
    return false;
  }
}

export default function guardExtension(pi: ExtensionAPI) {
  let blocked = 0;
  let confirmed = 0;
  let enabled = true;
  let lastCtx: any;
  let approvalTimeoutSeconds: number | null | undefined;
  // This closure is per extension instance; Pi replaces it when a session is replaced.
  const sessionApprovals = new Set<string>();
  const disposePolicy = pi.events.on?.("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2) return;
    if (typeof event.guardEnabled === "boolean") {
      enabled = event.guardEnabled;
      if (!enabled) lastCtx?.ui.setStatus("pi-guard", undefined);
    }
    const value = event.dialogTimeouts?.guard;
    if (value === null || Number.isInteger(value) && value >= 15 && value <= 86_400) {
      approvalTimeoutSeconds = value;
    }
  });
  const dialogOptions = (signal?: AbortSignal) => approvalTimeoutSeconds === undefined
    ? signal ? { signal } : undefined
    : {
        ...(signal ? { signal } : {}),
        timeout: approvalTimeoutSeconds === null ? 0 : approvalTimeoutSeconds * 1_000,
      };

  const publish = (ctx: any, decision: string, reason: string, toolCallId?: string) => {
    pi.events.emit("pi-guard:decision", {
      version: 1, cwd: ctx.cwd, decision, reason, blocked, confirmed, toolCallId,
    });
    if (ctx.hasUI) ctx.ui.setStatus("pi-guard", `guard: ${decision}`);
  };

  const approve = async (
    ctx: any,
    reason: string,
    detail: string,
    operation: ApprovalIdentity["operation"],
    value: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    // Remembered consent is never usable without an interactive UI.
    if (!ctx.hasUI || signal?.aborted) return false;

    let cwd: string;
    try {
      cwd = await realpath(ctx.cwd);
    } catch {
      return false;
    }
    const scope = approvalScope({
      policyVersion: POLICY_VERSION, cwd, reason, operation, value,
    });
    if (scope.candidates.some((approval) => sessionApprovals.has(identityKey(approval))))
      return true;

    for (const approval of scope.candidates) {
      const stored = await readProjectApproval(approval);
      if (stored === "allowed") return true;
      // An unreadable approval store is not a reason to permit a risky operation.
      if (stored === "error") return false;
    }

    // A checkpoint belongs to an actual prompt, not an already remembered decision.
    let checkpoint: Promise<unknown> | undefined;
    pi.events.emit("pi-timeline:checkpoint-request", {
      version: 1,
      cwd: ctx.cwd,
      reason,
      respond: (value: Promise<unknown>) => { checkpoint = value; },
    });
    if (checkpoint) await checkpoint.catch(() => undefined);

    let selected: string | undefined;
    try {
      const remembered = scope.directory
        ? `\n\nSession/project approval remembers directory:\n${scope.directory}`
        : "";
      selected = await ctx.ui.select(
        `Pi-guard ${reason}\n\`${detail.slice(0, 2000)}\`${remembered}`,
        choices,
        dialogOptions(signal),
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
      if (!await saveProjectApproval(scope.remembered)) return false;
      sessionApprovals.add(key);
      return true;
    }
    // Cancellation, an unknown result, and Deny are all denials.
    return false;
  };

  const allowOrBlock = async (
    ctx: any,
    reason: string,
    detail: string,
    operation: ApprovalIdentity["operation"],
    value: string,
    signal?: AbortSignal,
    toolCallId?: string,
  ) => {
    if (await approve(ctx, reason, detail, operation, value, signal)) {
      confirmed++;
      publish(ctx, "confirmed", reason, toolCallId);
      return true;
    }
    blocked++;
    publish(ctx, "blocked", reason, toolCallId);
    return false;
  };

  pi.on("session_start", (_event, ctx) => { lastCtx = ctx; });
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    if (isToolCallEventType("bash", event) || event.toolName === "heartbeat_start") {
      const command = isToolCallEventType("bash", event)
        ? event.input.command
        : (event.input as { command?: unknown })?.command;
      if (typeof command !== "string") {
        const reason = "invalid background command";
        blocked++;
        publish(ctx, "blocked", reason, event.toolCallId);
        return { block: true, reason: `Pi Guard blocked ${reason}.` };
      }
      const risk = commandRisk(command);
      if (!risk) return;
      if (await allowOrBlock(ctx, risk, String(command ?? ""), "command", String(command ?? ""), undefined, event.toolCallId)) return;
      return {
        block: true,
        reason: `Pi Guard blocked ${risk}${ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available"}.`,
      };
    }

    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
    let risk;
    try {
      risk = await pathRisk(ctx.cwd, event.input.path);
    } catch {
      const reason = "write target could not be resolved safely";
      blocked++;
      publish(ctx, "blocked", reason, event.toolCallId);
      return { block: true, reason: `Pi Guard blocked ${reason}.` };
    }
    if (!risk) return;
    if (risk.action === "block") {
      blocked++;
      publish(ctx, "blocked", risk.reason, event.toolCallId);
      return { block: true, reason: `Pi Guard blocked ${risk.reason}.` };
    }
    const detail = `${event.input.path}\nResolved target: ${risk.target}`;
    if (await allowOrBlock(ctx, risk.reason, detail, "path", risk.target, undefined, event.toolCallId)) return;
    return {
      block: true,
      reason: `Pi Guard blocked ${risk.reason}${ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available"}.`,
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!enabled) return;
    const risk = commandRisk(event.command);
    if (!risk) return;
    if (await allowOrBlock(ctx, risk, event.command, "command", event.command)) return;
    return {
      result: {
        output: `Pi Guard blocked ${risk}${ctx.hasUI ? " after confirmation was declined" : " because no confirmation UI is available"}.`,
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    };
  });

  pi.registerCommand("guard", {
    description: "Show Pi Guard status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Pi Guard ${enabled ? "active" : "disabled by policy"}. Blocked: ${blocked}. Approved: ${confirmed}.`, "info");
    },
  });
  pi.on("session_shutdown", () => {
    lastCtx?.ui.setStatus("pi-guard", undefined);
    lastCtx = undefined;
    disposePolicy?.();
  });
}

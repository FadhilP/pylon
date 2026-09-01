import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isActive, JobManager, pruneStaleSessionDirs, type Job } from "../src/jobs.ts";
import { jobContext } from "../src/context.ts";
import { checkWaitMs } from "../src/polling.ts";
import { effectiveConfig, loadConfig } from "../src/config.ts";

const TOOL_USAGE: Record<string, string> = {
  heartbeat_start: "start a long shell command while independent work remains",
  heartbeat_status: "inspect running or recently completed background jobs",
  heartbeat_cancel: "cancel a running background job",
};
const tooSoonText = (waitMs: number) => `Check too soon. Continue other work; retry in ${Math.ceil(waitMs / 1000)}s.`;

export default function heartbeatExtension(pi: ExtensionAPI) {
  let manager: JobManager | undefined,
    lastCtx: any,
    lastToolPolicy = "";
  const announced = new Map<string, string>();
  const jobMeta = new Map<string, { todoId?: string; purpose?: string }>();
  const refresh = () => {
    if (!manager || !lastCtx) return;
    const running = manager.running();
    const statusNeeded = running.length > 0 || [...manager.jobs.values()].some(job => !job.completionAnnounced);
    const enabledTools = [
      "heartbeat_start",
      ...(statusNeeded ? ["heartbeat_status"] : []),
      ...(running.length ? ["heartbeat_cancel"] : []),
    ];
    const toolPolicy = enabledTools.join(",");
    if (toolPolicy !== lastToolPolicy) {
      lastToolPolicy = toolPolicy;
      pi.events.emit("pylon:tool-policy", {
        version: 1,
        kind: "register",
        owner: "pi-heartbeat",
        managedTools: ["heartbeat_start", "heartbeat_status", "heartbeat_cancel"],
        enabledTools,
        toolUsage: Object.fromEntries(enabledTools.map(tool => [tool, TOOL_USAGE[tool]])),
      });
    }
    for (const job of manager.jobs.values()) {
      if (announced.get(job.id) === job.state) continue;
      announced.set(job.id, job.state);
      pi.events.emit("pi-heartbeat:job", {
        version: 1,
        id: job.id,
        sessionId: job.sessionId,
        cwd: job.cwd,
        label: job.label,
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        ...jobMeta.get(job.id),
      });
    }
    if (lastCtx.hasUI)
      lastCtx.ui.setStatus("pi-heartbeat", running.length ? `jobs: ${running.length} running` : undefined);
    if (lastCtx.mode === "tui")
      lastCtx.ui.setWidget(
        "pi-heartbeat",
        running.length ? ["Background jobs", ...running.slice(0, 3).map(j => `${j.id} ${j.label}`)] : undefined,
      );
  };
  /** Shared by heartbeat_status and /heartbeat status: enforces the polling gate, then formats. */
  const inspectJob = (job: Job) => {
    const waitMs = checkWaitMs(job);
    if (waitMs) return { waitMs, text: tooSoonText(waitMs) };
    job.lastCheckedAt = Date.now();
    if (!isActive(job)) {
      job.completionAnnounced = true;
      refresh();
    }
    return { waitMs: 0, text: manager!.format(job).text };
  };
  const summaryLine = (job: Job) => `${job.id} ${job.state} ${job.label}`;
  const textResult = (text: string, details: object = {}) => ({ content: [{ type: "text", text }], details });

  const statusForJob = (jobManager: JobManager, id: string) => {
    const job = jobManager.jobs.get(id);
    if (!job) return textResult("Unknown or evicted job ID.");
    const inspection = inspectJob(job);
    if (inspection.waitMs)
      return textResult(inspection.text, { id: job.id, state: job.state, retryAfterMs: inspection.waitMs });
    return textResult(inspection.text, {
      id: job.id,
      state: job.state,
      exitCode: job.exitCode,
      logPath: job.logPath,
      outputTruncated: job.outputTruncated,
    });
  };

  const statusList = (jobManager: JobManager) => {
    const running = jobManager.running();
    const wait = Math.max(0, ...running.map(job => checkWaitMs(job)));
    if (wait) return textResult(tooSoonText(wait), { state: "running", retryAfterMs: wait });
    const checkedAt = Date.now();
    for (const job of running) job.lastCheckedAt = checkedAt;
    const recent = [...jobManager.jobs.values()]
      .filter(job => !isActive(job))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
      .slice(0, 3);
    const jobs = [...running.slice(0, 4), ...recent];
    return textResult(jobs.length ? jobs.map(summaryLine).join("\n") : "No jobs.");
  };

  pi.on("session_start", async (_e, ctx) => {
    try {
      await manager?.shutdown();
    } catch {
      // A failed old-directory removal must not prevent a new session.
    }
    manager = undefined;
    announced.clear();
    jobMeta.clear();
    lastCtx = ctx;
    lastToolPolicy = "";
    const root = join(getAgentDir(), "pi-heartbeat", "tmp");
    const dir = join(root, ctx.sessionManager.getSessionId());
    await pruneStaleSessionDirs(root, dir);
    const shellPath = SettingsManager.create(ctx.cwd, getAgentDir()).getShellPath();
    const settings = effectiveConfig(await loadConfig());
    manager = new JobManager(
      dir,
      refresh,
      5_000,
      shellPath,
      settings.defaultJobTimeoutMs,
      settings.completedJobRetention,
    );
    await manager.init();
    refresh();
  });
  pi.on("session_shutdown", async () => {
    try {
      await manager?.shutdown();
    } finally {
      manager = undefined;
      announced.clear();
      jobMeta.clear();
      lastToolPolicy = "";
      pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-heartbeat" });
    }
  });
  pi.on("context", event => {
    if (!manager) return;
    const text = jobContext([...manager.jobs.values()]);
    if (text)
      return {
        messages: [
          ...event.messages,
          { role: "custom", customType: "pi-heartbeat", content: text, display: false, timestamp: Date.now() },
        ],
      };
  });
  pi.registerTool({
    name: "heartbeat_start",
    label: "Heartbeat Start",
    description: "Start a long shell command only while other independent work remains; returns job ID immediately.",
    promptGuidelines: [
      "Call heartbeat_start only when command is long-running and you can name concrete independent work to do while it runs. If no independent work remains, use bash and wait instead. After heartbeat_start, do that work before checking. heartbeat_status rejects running-job checks until more than 30 seconds after start or prior check.",
    ],
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 8000 }),
        otherWork: Type.String({
          minLength: 1,
          maxLength: 240,
          description: "Concrete independent work you will do before checking this job",
        }),
        label: Type.Optional(Type.String({ maxLength: 120 })),
        timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 7200000 })),
        todoId: Type.Optional(Type.String({ maxLength: 120 })),
        purpose: Type.Optional(StringEnum(["verification", "build", "other"] as const)),
      },
      { additionalProperties: false },
    ),
    async execute(_i, p, signal, _u, ctx) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled before start." }], details: {} };
      if (!manager) throw Error("Heartbeat unavailable.");
      const j = await manager.start(p.command, ctx.cwd, p.label, p.timeoutMs, ctx.sessionManager.getSessionId());
      jobMeta.set(j.id, { todoId: p.todoId, purpose: p.purpose });
      announced.delete(j.id);
      refresh();
      return {
        content: [
          {
            type: "text",
            text: `Started job ${j.id} (${j.label}). Continue: ${p.otherWork}. Do not check for at least 30 seconds.`,
          },
        ],
        details: {
          id: j.id,
          label: j.label,
          state: j.state,
          startedAt: j.startedAt,
          timeoutMs: j.timeoutMs,
          pid: j.pid,
          otherWork: p.otherWork,
        },
      };
    },
  });
  pi.registerTool({
    name: "heartbeat_status",
    label: "Heartbeat Status",
    description: "Inspect one job, or list running and recent jobs.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_i, p): Promise<any> {
      if (!manager) throw Error("Heartbeat unavailable.");
      return p.id ? statusForJob(manager, p.id) : statusList(manager);
    },
  });
  pi.registerTool({
    name: "heartbeat_cancel",
    label: "Heartbeat Cancel",
    description: "Cancel background job.",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    async execute(_i, p): Promise<any> {
      const j = manager?.jobs.get(p.id);
      if (!j) return { content: [{ type: "text", text: "Unknown or evicted job ID." }], details: {} };
      await manager!.stop(j);
      return {
        content: [{ type: "text", text: `Cancellation requested for ${j.id}.` }],
        details: { id: j.id, state: j.state },
      };
    },
  });
  pi.registerCommand("heartbeat", {
    description: "List, inspect, or cancel background jobs",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const usage = "Usage: /heartbeat [list [running|all]|status <id>|cancel <id>|help]";
      const valid =
        (parts.length === 0 && action === "list") ||
        (action === "help" && parts.length === 1) ||
        (action === "list" && (parts.length === 1 || (parts.length === 2 && ["running", "all"].includes(id!.toLowerCase())))) ||
        (["status", "cancel"].includes(action) && parts.length === 2);
      if (!valid) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (action === "help") {
        ctx.ui.notify(usage, "info");
        return;
      }
      if (!manager) {
        ctx.ui.notify("Heartbeat is unavailable for this session.", "warning");
        return;
      }
      if (action === "cancel") {
        const job = manager.jobs.get(id!);
        if (!job) {
          ctx.ui.notify("Unknown job.", "warning");
          return;
        }
        await manager.stop(job);
        ctx.ui.notify(`Cancellation requested for ${job.id}.`, "info");
        return;
      }
      if (action === "status") {
        const job = manager.jobs.get(id!);
        if (!job) {
          ctx.ui.notify("Unknown job.", "warning");
          return;
        }
        ctx.ui.notify(inspectJob(job).text, "info");
        return;
      }
      const all = id?.toLowerCase() === "all";
      const jobs = (all ? [...manager.jobs.values()] : manager.running()).slice(0, 20);
      ctx.ui.notify(jobs.length ? jobs.map(summaryLine).join("\n") : "No jobs.", "info");
    },
  });
}

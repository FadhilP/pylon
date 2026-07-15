import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { JobManager } from "../src/jobs.ts";
import { jobContext } from "../src/context.ts";
import { checkWaitMs } from "../src/polling.ts";
export default function heartbeatExtension(pi: ExtensionAPI) {
  let manager: JobManager | undefined, lastCtx: any;
  const announced = new Map<string, string>();
  const jobMeta = new Map<string, { todoId?: string; purpose?: string }>();
  const refresh = () => {
    if (!manager || !lastCtx) return;
    const running = manager.running();
    for (const job of manager.jobs.values()) {
      if (announced.get(job.id) === job.state) continue;
      announced.set(job.id, job.state);
      pi.events.emit("pi-heartbeat:job", {
        version: 1,
        id: job.id,
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
      lastCtx.ui.setStatus(
        "pi-heartbeat",
        running.length ? `jobs: ${running.length} running` : undefined,
      );
    if (lastCtx.mode === "tui")
      lastCtx.ui.setWidget(
        "pi-heartbeat",
        running.length
          ? [
              "Background jobs",
              ...running.slice(0, 3).map((j) => `${j.id} ${j.label}`),
            ]
          : undefined,
      );
  };
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx;
    manager = new JobManager(
      join(
        getAgentDir(),
        "pi-heartbeat",
        "tmp",
        ctx.sessionManager.getSessionId(),
      ),
      refresh,
    );
    await manager.init();
    refresh();
  });
  pi.on("session_shutdown", async () => {
    await manager?.shutdown();
    manager = undefined;
  });
  pi.on("context", (event) => {
    if (!manager) return;
    const text = jobContext([...manager.jobs.values()]);
    if (text)
      return {
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: "pi-heartbeat",
            content: text,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
  });
  pi.registerTool({
    name: "heartbeat_start",
    label: "Heartbeat Start",
    description:
      "Start a long shell command only while other independent work remains; returns job ID immediately.",
    promptGuidelines: [
      "Call heartbeat_start only when command is long-running and you can name concrete independent work to do while it runs. If no independent work remains, use bash and wait instead. After heartbeat_start, do that work before checking. heartbeat_status rejects running-job checks until more than 30 seconds after start or prior check.",
    ],
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 8000 }),
        otherWork: Type.String({
          minLength: 1,
          maxLength: 240,
          description:
            "Concrete independent work you will do before checking this job",
        }),
        label: Type.Optional(Type.String({ maxLength: 120 })),
        timeoutMs: Type.Optional(
          Type.Number({ minimum: 1000, maximum: 7200000 }),
        ),
        todoId: Type.Optional(Type.String({ maxLength: 120 })),
        purpose: Type.Optional(StringEnum(["verification", "build", "other"] as const)),
      },
      { additionalProperties: false },
    ),
    async execute(_i, p, signal, _u, ctx) {
      if (signal?.aborted)
        return {
          content: [{ type: "text", text: "Cancelled before start." }],
          details: {},
        };
      if (!manager) throw Error("Heartbeat unavailable.");
      const j = await manager.start(p.command, ctx.cwd, p.label, p.timeoutMs);
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
    parameters: Type.Object(
      { id: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    async execute(_i, p): Promise<any> {
      if (!manager) throw Error("Heartbeat unavailable.");
      if (p.id) {
        const j = manager.jobs.get(p.id);
        if (!j)
          return {
            content: [{ type: "text", text: "Unknown or evicted job ID." }],
            details: {},
          };
        const wait = checkWaitMs(j);
        if (wait)
          return {
            content: [
              {
                type: "text",
                text: `Check too soon. Continue other work; retry in ${Math.ceil(wait / 1000)}s.`,
              },
            ],
            details: { id: j.id, state: j.state, retryAfterMs: wait },
          };
        j.lastCheckedAt = Date.now();
        if (!["running", "cancelling"].includes(j.state))
          j.completionAnnounced = true;
        return {
          content: [{ type: "text", text: manager.format(j).text }],
          details: {
            id: j.id,
            state: j.state,
            exitCode: j.exitCode,
            logPath: j.logPath,
            outputTruncated: j.outputTruncated,
          },
        };
      }
      const running = manager.running();
      const wait = Math.max(0, ...running.map((j) => checkWaitMs(j)));
      if (wait)
        return {
          content: [
            {
              type: "text",
              text: `Check too soon. Continue other work; retry in ${Math.ceil(wait / 1000)}s.`,
            },
          ],
          details: { state: "running", retryAfterMs: wait },
        };
      const checkedAt = Date.now();
      for (const j of running) j.lastCheckedAt = checkedAt;
      const jobs = [
        ...running.slice(0, 4),
        ...[...manager.jobs.values()]
          .filter((j) => !["running", "cancelling"].includes(j.state))
          .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
          .slice(0, 3),
      ];
      return {
        content: [
          {
            type: "text",
            text: jobs.length
              ? jobs.map((j) => `${j.id} ${j.state} ${j.label}`).join("\n")
              : "No jobs.",
          },
        ],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "heartbeat_cancel",
    label: "Heartbeat Cancel",
    description: "Cancel background job.",
    parameters: Type.Object(
      { id: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_i, p): Promise<any> {
      const j = manager?.jobs.get(p.id);
      if (!j)
        return {
          content: [{ type: "text", text: "Unknown or evicted job ID." }],
          details: {},
        };
      await manager!.stop(j);
      return {
        content: [
          { type: "text", text: `Cancellation requested for ${j.id}.` },
        ],
        details: { id: j.id, state: j.state },
      };
    },
  });
  pi.registerCommand("heartbeat", {
    description: "List, inspect, or cancel background jobs",
    handler: async (args, ctx) => {
      const [action = "list", id] = args.trim().split(/\s+/);
      if (!manager) return;
      let text = "";
      if (action === "cancel" && id) {
        const j = manager.jobs.get(id);
        if (j) await manager.stop(j);
        text = j ? `Cancellation requested for ${id}.` : "Unknown job.";
      } else if (action === "status" && id) {
        const j = manager.jobs.get(id),
          wait = j ? checkWaitMs(j) : 0;
        text = !j
          ? "Unknown job."
          : wait
            ? `Check too soon. Retry in ${Math.ceil(wait / 1000)}s.`
            : manager.format(j).text;
        if (j && !wait) {
          j.lastCheckedAt = Date.now();
          if (!["running", "cancelling"].includes(j.state))
            j.completionAnnounced = true;
        }
      } else
        text =
          [...manager.jobs.values()]
            .map((j) => `${j.id} ${j.state} ${j.label}`)
            .join("\n") || "No jobs.";
      ctx.ui.notify(text, "info");
    },
  });
}

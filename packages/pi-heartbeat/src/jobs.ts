import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { TailBuffer, bounded } from "./output.ts";
import { killTree, shellInvocation } from "./process-tree.ts";
export const STALE_SESSION_DIR_MS = 7 * 24 * 60 * 60 * 1000;

/** Best-effort removal of abandoned heartbeat session directories. */
export async function pruneStaleSessionDirs(root: string, currentDir: string, now = Date.now()): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async entry => {
      if (!entry.isDirectory()) return;
      const dir = join(root, entry.name);
      if (resolve(dir) === resolve(currentDir)) return;
      try {
        let lastActivity = (await stat(dir)).mtimeMs;
        // Job logs are written after their containing directory is created.
        for (const child of await readdir(dir, { withFileTypes: true })) {
          if (!child.isFile()) continue;
          lastActivity = Math.max(lastActivity, (await stat(join(dir, child.name))).mtimeMs);
        }
        if (now - lastActivity >= STALE_SESSION_DIR_MS) await rm(dir, { recursive: true, force: true });
      } catch {
        // A concurrent session or filesystem error must not disrupt startup.
      }
    }),
  );
}

export type State = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out";
/** A job still doing work: not yet finished, failed, cancelled, or timed out. */
export const isActive = (job: Pick<Job, "state">) => job.state === "running" || job.state === "cancelling";

function formatFinished(job: Job, heading: string) {
  const successful = job.state === "completed" && job.exitCode === 0;
  const tails = bounded(
    `stdout tail:\n${job.stdoutTail}\nstderr tail:\n${job.stderrTail}`,
    successful ? 2048 : 12288,
    successful ? 40 : 200,
  );
  let text = `${heading}\n${tails.text}${tails.truncated ? "\n[tail truncated]" : ""}\nFull captured log: ${job.logPath}`;
  if (job.outputTruncated) text += `\nOutput exceeded 10 MiB; final tails retained.`;
  return { text, truncated: tails.truncated || job.outputTruncated };
}

function formatRunning(job: Job, heading: string) {
  const snapshot = (kind: "stdout" | "stderr", tail: TailBuffer) => {
    const current = bounded(tail.toString(), 1536, 20);
    const truncated = tail.truncated || current.truncated;
    return {
      text: `${kind} tail:\n${current.text || `[no ${kind} captured yet]`}${truncated ? `\n[earlier ${kind} omitted]` : ""}`,
      truncated,
    };
  };
  const stdout = snapshot("stdout", job.stdoutTail);
  const stderr = snapshot("stderr", job.stderrTail);
  return {
    text: `${heading}\nCurrent output snapshot (streams shown separately; may repeat):\n${stdout.text}\n${stderr.text}`,
    truncated: stdout.truncated || stderr.truncated,
  };
}

export type Job = {
  id: string;
  label: string;
  command: string;
  cwd: string;
  sessionId?: string;
  state: State;
  startedAt: number;
  lastCheckedAt: number;
  finishedAt?: number;
  timeoutMs: number;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  stdoutTail: TailBuffer;
  stderrTail: TailBuffer;
  outputBytes: number;
  outputTruncated: boolean;
  logPath: string;
  child: ChildProcess;
  timeout?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  completionAnnounced: boolean;
  stopReason?: "cancelled" | "timed_out";
  file: WriteStream;
  finalizing?: Promise<void>;
};
export class JobManager {
  jobs = new Map<string, Job>();
  readonly dir: string;
  readonly onChange: () => void;
  private readonly shutdownGraceMs: number;
  private readonly defaultJobTimeoutMs: number;
  private readonly completedJobRetention: number;
  private readonly shellPath?: string;
  constructor(
    dir: string,
    onChange: () => void = () => {},
    shutdownGraceMs = 5_000,
    shellPath?: string,
    defaultJobTimeoutMs = 1_800_000,
    completedJobRetention = 20,
  ) {
    this.dir = dir;
    this.onChange = onChange;
    this.shutdownGraceMs = shutdownGraceMs;
    this.shellPath = shellPath;
    this.defaultJobTimeoutMs = defaultJobTimeoutMs;
    this.completedJobRetention = completedJobRetention;
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
  }
  running() {
    return [...this.jobs.values()].filter(isActive);
  }
  private newJobId() {
    let id: string;
    do id = `job_${randomBytes(3).toString("hex")}`;
    while (this.jobs.has(id));
    return id;
  }
  /** Pipes both streams into the job's tails and its capped log file. */
  private attachStreams(j: Job, child: ChildProcess) {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const consumeText = (kind: "stdout" | "stderr", text: string) => {
      if (!text) return;
      (kind === "stdout" ? j.stdoutTail : j.stderrTail).append(text);
      const line = Buffer.from(`[${kind}] ${text}`);
      j.outputBytes += line.length;
      if (j.outputBytes <= 10 * 1024 * 1024) j.file.write(line);
      else j.outputTruncated = true;
    };
    child.stdout!.on("data", (data: Buffer) => consumeText("stdout", decoders.stdout.write(data)));
    child.stderr!.on("data", (data: Buffer) => consumeText("stderr", decoders.stderr.write(data)));
    j.file.on("error", () => {
      j.outputTruncated = true;
    });
    return {
      flush: () => {
        consumeText("stdout", decoders.stdout.end());
        consumeText("stderr", decoders.stderr.end());
      },
    };
  }
  private attachLifecycle(j: Job, child: ChildProcess, flush: () => void) {
    child.on("close", (code, signal) => {
      clearTimeout(j.timeout);
      clearTimeout(j.killTimer);
      j.exitCode = code;
      j.exitSignal = signal;
      j.finishedAt = Date.now();
      j.state = j.stopReason || (code === 0 ? "completed" : "failed");
      flush();
      j.file.end();
      j.finalizing = new Promise<void>(resolve => {
        if (j.file.closed) resolve();
        else {
          j.file.once("close", resolve);
          j.file.once("error", () => resolve());
        }
      }).then(() => {
        this.prune();
        this.onChange();
      });
    });
    child.on("error", () => {
      j.state = "failed";
      j.finishedAt ??= Date.now();
      this.onChange();
    });
  }
  async start(command: string, cwd: string, label?: string, timeoutMs = this.defaultJobTimeoutMs, sessionId?: string) {
    if (!command.trim() || command.length > 8000) throw Error("Invalid command.");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7200000) throw Error("Invalid timeout.");
    if (this.running().length >= 4) throw Error("Maximum 4 simultaneous jobs.");
    const id = this.newJobId();
    const logPath = join(this.dir, `${id}.log`),
      inv = shellInvocation(command, this.shellPath),
      file = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    const child = spawn(inv.command, inv.args, {
      cwd,
      env: process.env,
      stdio: [inv.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: inv.shell,
    });
    if (inv.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(inv.stdin);
    }
    const startedAt = Date.now();
    const j: Job = {
      id,
      label: (label?.trim() || command.slice(0, 60)).replace(/[\r\n\t]/g, " "),
      command,
      cwd,
      sessionId,
      state: "running",
      startedAt,
      lastCheckedAt: startedAt,
      timeoutMs,
      pid: child.pid,
      stdoutTail: new TailBuffer(),
      stderrTail: new TailBuffer(),
      outputBytes: 0,
      outputTruncated: false,
      logPath,
      child,
      completionAnnounced: false,
      file,
    };
    this.jobs.set(id, j);
    const { flush } = this.attachStreams(j, child);
    this.attachLifecycle(j, child, flush);
    j.timeout = setTimeout(() => void this.stop(j, "timed_out"), timeoutMs);
    j.timeout.unref();
    this.onChange();
    return j;
  }
  async stop(job: Job, reason: "cancelled" | "timed_out" = "cancelled") {
    if (!isActive(job)) return;
    job.state = "cancelling";
    job.stopReason = reason;
    killTree(job.child);
    job.killTimer = setTimeout(() => killTree(job.child, true), 1000);
    job.killTimer.unref();
    this.onChange();
  }
  prune() {
    const done = [...this.jobs.values()]
      .filter(j => !isActive(j))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    for (const j of done.slice(this.completedJobRetention)) this.jobs.delete(j.id);
  }
  format(job: Job) {
    const elapsed = ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
    const heading = `Job ${job.id}: ${job.state}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}, ${elapsed.toFixed(1)}s.`;
    return isActive(job) ? formatRunning(job, heading) : formatFinished(job, heading);
  }
  async shutdown() {
    const deadline = Date.now() + this.shutdownGraceMs;
    for (const j of this.running()) await this.stop(j);
    const withinDeadline = (promise: Promise<unknown>) => {
      const remaining = Math.max(0, deadline - Date.now());
      return remaining ? Promise.race([promise, delay(remaining)]) : Promise.resolve();
    };
    await Promise.all(
      this.running().map(job =>
        job.child.exitCode !== null
          ? Promise.resolve()
          : withinDeadline(new Promise<void>(resolve => job.child.once("close", resolve))),
      ),
    );
    await withinDeadline(Promise.all([...this.jobs.values()].map(job => job.finalizing ?? Promise.resolve())));
    for (const job of this.jobs.values()) if (!job.file.closed) job.file.destroy();
    await rm(this.dir, { recursive: true, force: true });
  }
}

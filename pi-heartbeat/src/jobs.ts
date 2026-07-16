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
export async function pruneStaleSessionDirs(
  root: string,
  currentDir: string,
  now = Date.now(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const dir = join(root, entry.name);
    if (resolve(dir) === resolve(currentDir)) return;
    try {
      let lastActivity = (await stat(dir)).mtimeMs;
      // Job logs are written after their containing directory is created.
      for (const child of await readdir(dir, { withFileTypes: true })) {
        if (!child.isFile()) continue;
        lastActivity = Math.max(
          lastActivity,
          (await stat(join(dir, child.name))).mtimeMs,
        );
      }
      if (now - lastActivity >= STALE_SESSION_DIR_MS)
        await rm(dir, { recursive: true, force: true });
    } catch {
      // A concurrent session or filesystem error must not disrupt startup.
    }
  }));
}

export type State =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type Job = {
  id: string;
  label: string;
  command: string;
  cwd: string;
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
  constructor(dir: string, onChange: () => void = () => {}) {
    this.dir = dir;
    this.onChange = onChange;
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
  }
  running() {
    return [...this.jobs.values()].filter(
      (j) => j.state === "running" || j.state === "cancelling",
    );
  }
  async start(
    command: string,
    cwd: string,
    label?: string,
    timeoutMs = 1800000,
  ) {
    if (!command.trim() || command.length > 8000)
      throw Error("Invalid command.");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7200000)
      throw Error("Invalid timeout.");
    if (this.running().length >= 4) throw Error("Maximum 4 simultaneous jobs.");
    let id: string;
    do id = `job_${randomBytes(3).toString("hex")}`;
    while (this.jobs.has(id));
    const logPath = join(this.dir, `${id}.log`),
      inv = shellInvocation(command),
      file = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    const child = spawn(inv.command, inv.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: inv.shell,
    });
    const j: Job = {
      id,
      label: (label?.trim() || command.slice(0, 60)).replace(/[\r\n\t]/g, " "),
      command,
      cwd,
      state: "running",
      startedAt: Date.now(),
      lastCheckedAt: Date.now(),
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
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const consumeText = (kind: "stdout" | "stderr", text: string) => {
      if (!text) return;
      (kind === "stdout" ? j.stdoutTail : j.stderrTail).append(text);
      const line = Buffer.from(`[${kind}] ${text}`);
      j.outputBytes += line.length;
      if (j.outputBytes <= 10 * 1024 * 1024) file.write(line);
      else j.outputTruncated = true;
    };
    const consume = (kind: "stdout" | "stderr", data: Buffer) =>
      consumeText(kind, decoders[kind].write(data));
    child.stdout!.on("data", (data) => consume("stdout", data));
    child.stderr!.on("data", (data) => consume("stderr", data));
    child.on("close", (code, signal) => {
      clearTimeout(j.timeout);
      clearTimeout(j.killTimer);
      j.exitCode = code;
      j.exitSignal = signal;
      j.finishedAt = Date.now();
      j.state = j.stopReason || (code === 0 ? "completed" : "failed");
      consumeText("stdout", decoders.stdout.end());
      consumeText("stderr", decoders.stderr.end());
      file.end();
      j.finalizing = new Promise<void>((resolve) => {
        if (file.closed) resolve();
        else {
          file.once("close", resolve);
          file.once("error", resolve);
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
    file.on("error", () => {
      j.outputTruncated = true;
    });
    j.timeout = setTimeout(() => void this.stop(j, "timed_out"), timeoutMs);
    j.timeout.unref();
    this.onChange();
    return j;
  }
  async stop(job: Job, reason: "cancelled" | "timed_out" = "cancelled") {
    if (!["running", "cancelling"].includes(job.state)) return;
    job.state = "cancelling";
    job.stopReason = reason;
    killTree(job.child);
    job.killTimer = setTimeout(() => killTree(job.child, true), 1000);
    job.killTimer.unref();
    this.onChange();
  }
  prune() {
    const done = [...this.jobs.values()]
      .filter((j) => !["running", "cancelling"].includes(j.state))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    for (const j of done.slice(20)) this.jobs.delete(j.id);
  }
  format(job: Job) {
    const elapsed = ((job.finishedAt || Date.now()) - job.startedAt) / 1000;
    let text = `Job ${job.id}: ${job.state}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}, ${elapsed.toFixed(1)}s.`;
    if (!["running", "cancelling"].includes(job.state)) {
      const successful = job.state === "completed" && job.exitCode === 0;
      const tails = bounded(
        `stdout tail:\n${job.stdoutTail}\nstderr tail:\n${job.stderrTail}`,
        successful ? 2048 : 12288,
        successful ? 40 : 200,
      );
      text += `\n${tails.text}${tails.truncated ? "\n[tail truncated]" : ""}\nFull captured log: ${job.logPath}`;
      if (job.outputTruncated)
        text += `\nOutput exceeded 10 MiB; final tails retained.`;
      return { text, truncated: tails.truncated || job.outputTruncated };
    }
    return bounded(text);
  }
  async shutdown() {
    for (const j of this.running()) await this.stop(j);
    await Promise.all(
      this.running().map((j) =>
        j.child.exitCode !== null
          ? Promise.resolve()
          : Promise.race([
              new Promise<void>((resolve) =>
                j.child.once("close", () => resolve()),
              ),
              delay(5000).then(() => undefined),
            ]),
      ),
    );
    await Promise.all(
      [...this.jobs.values()].map((job) => job.finalizing ?? Promise.resolve()),
    );
    for (const job of this.jobs.values())
      if (!job.file.closed) job.file.destroy();
    await rm(this.dir, { recursive: true, force: true });
  }
}

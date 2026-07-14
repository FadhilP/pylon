import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TailBuffer, bounded } from "../src/output.ts";
import { JobManager, type Job } from "../src/jobs.ts";
import { jobContext } from "../src/context.ts";
import { checkWaitMs, MIN_CHECK_INTERVAL_MS } from "../src/polling.ts";

const closed = (job: Job) =>
  job.child.exitCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => job.child.once("close", () => resolve()));
const logClosed = (job: Job) =>
  job.file.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => job.file.once("close", () => resolve()));

test("tails bounded", () => {
  const tail = new TailBuffer(10);
  tail.append("abcdefghijklmnop");
  assert.ok(Buffer.byteLength(tail.toString()) <= 10);
  assert.equal(bounded("a\nb\nc", 100, 2).truncated, true);
});

test("running status checks stay over 30 seconds apart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-"));
  const manager = new JobManager(dir);
  await manager.init();
  const job = await manager.start(
    `node -e "setTimeout(()=>{},1000)"`,
    process.cwd(),
  );
  assert.equal(checkWaitMs(job, job.startedAt), MIN_CHECK_INTERVAL_MS + 1);
  assert.equal(checkWaitMs(job, job.startedAt + MIN_CHECK_INTERVAL_MS), 1);
  assert.equal(checkWaitMs(job, job.startedAt + MIN_CHECK_INTERVAL_MS + 1), 0);
  assert.match(jobContext([job], job.startedAt), /Do not call heartbeat_status yet/);
  assert.match(
    jobContext([job], job.startedAt + MIN_CHECK_INTERVAL_MS + 1),
    /status available now/,
  );
  await manager.stop(job);
  await closed(job);
  await manager.shutdown();
});

test("start returns, captures UTF-8 output, and completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-"));
  const manager = new JobManager(dir);
  await manager.init();
  const script = join(dir, "job.js");
  await writeFile(script, "setTimeout(function(){console.log('ok 世界')},100)");
  const started = Date.now();
  const job = await manager.start(`node "${script}"`, process.cwd());
  assert.ok(Date.now() - started < 100);
  await closed(job);
  await logClosed(job);
  assert.equal(job.state, "completed");
  assert.match(job.stdoutTail.toString(), /ok 世界/);
  assert.match(await readFile(job.logPath, "utf8"), /ok 世界/);
  assert.match(jobContext([job]), new RegExp(job.id));
  assert.equal(job.completionAnnounced, false);
  assert.match(jobContext([job]), /status available now/);
  assert.equal(job.completionAnnounced, false);
  await manager.shutdown();
});

test("successful status keeps only a small output tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-"));
  const manager = new JobManager(dir);
  await manager.init();
  const script = join(dir, "large-success.js");
  await writeFile(script, `console.log("x".repeat(6000) + "END")`);
  const job = await manager.start(`node "${script}"`, process.cwd());
  await closed(job);
  await logClosed(job);
  const formatted = manager.format(job);
  assert.match(formatted.text, /END/);
  assert.match(formatted.text, /\[tail truncated\]/);
  assert.match(formatted.text, /Full captured log:/);
  assert.ok(Buffer.byteLength(formatted.text) < 3000);
  await manager.shutdown();
});

test("timeout terminates process and shutdown is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-"));
  const manager = new JobManager(dir);
  await manager.init();
  const job = await manager.start(
    `node -e "setTimeout(()=>{},10000)"`,
    process.cwd(),
    "timeout",
    1000,
  );
  await closed(job);
  assert.equal(job.state, "timed_out");
  await manager.shutdown();
  await manager.shutdown();
});

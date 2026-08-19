import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GRUNT_CONTEXT_LIMIT, contextTokensFromUsage, getPiInvocation, runPi } from "../src/runner.ts";

test("child invocation does not mistake an embedding web host for the Pi CLI", async () => {
  const originalScript = process.argv[1];
  const originalMarker = process.env.PI_CODING_AGENT;
  const dir = await mkdtemp(join(tmpdir(), "grunt-host-"));
  const host = join(dir, "web-server.mjs");
  await writeFile(host, "");
  try {
    process.argv[1] = host;
    delete process.env.PI_CODING_AGENT;
    const embedded = getPiInvocation(["--mode", "json"]);
    assert.equal(embedded.command, process.execPath);
    assert.notEqual(embedded.args[0], host);
    assert.match(embedded.args[0]!, /[\\/]dist[\\/]cli\.js$/);

    process.env.PI_CODING_AGENT = "true";
    assert.notEqual(getPiInvocation(["--mode", "json"]).args[0], host);
    process.argv[1] = embedded.args[0]!;
    assert.deepEqual(getPiInvocation(["--mode", "json"]).args, [embedded.args[0], "--mode", "json"]);
  } finally {
    process.argv[1] = originalScript;
    if (originalMarker === undefined) delete process.env.PI_CODING_AGENT;
    else process.env.PI_CODING_AGENT = originalMarker;
  }
});

test("runner selects final assistant, sums usage, and exposes activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-runner-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'edit-1',toolName:'edit',args:{path:'a.ts'}})); console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'edit-1',toolName:'edit',result:{content:[{type:'text',text:'updated'}]}})); for(let i=1;i<=2;i++) console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'turn '+i}],model:'worker',stopReason:'stop',usage:{input:i,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}}));`);
  const usage: any[] = [];
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] }, onUsage: item => usage.push(item) });
  assert.equal(run.text, "turn 2");
  assert.equal(run.cwd, dir);
  assert.equal(run.turns, 2);
  assert.deepEqual(usage.map((item) => item.input), [1, 3]);
  assert.deepEqual(run.usage, usage.at(-1));
  assert.equal(run.activity[0]?.id, "edit-1");
  assert.ok(!Number.isNaN(Date.parse(run.activity[0]?.startedAt ?? "")));
  assert.equal(run.activity[1]?.id, "edit-1");
  assert.equal(run.activity[1]?.text, "updated");
  assert.ok((run.activity[1]?.durationMs ?? -1) >= 0);
});

test("usage observer failures do not control the worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-usage-observer-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1}}}))`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] }, onUsage: () => { throw new Error("render failed"); } });
  assert.equal(run.text, "done");
  assert.equal(run.usage.input, 1);
});

test("runner fails closed on incomplete model stop reasons", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-incomplete-"));
  for (const stopReason of ["length", "aborted"]) {
    const script = join(dir, `${stopReason}.mjs`);
    await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'unfinished'}],stopReason:'${stopReason}',usage:{}}}))`);
    const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
    assert.equal(run.failure, "child_error");
    assert.match(run.error ?? "", /incomplete stop reason/);
  }
});

test("runner fails closed on malformed protocol despite a later normal stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-malformed-"));
  const script = join(dir, "malformed.mjs");
  await writeFile(script, `console.log('not-json'); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{}}}))`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.failure, "child_error");
  assert.match(run.error ?? "", /malformed JSON/);
});

test("runner stops before another turn when budget is exhausted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-budget-"));
  const script = join(dir, "budget.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'continue'}],stopReason:'toolUse',usage:{cost:{total:0.5}}}}))`);
  const run = await runPi([], { cwd: dir, maxTurns: 1, maxCostUsd: 2, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.failure, "budget_exceeded");
  assert.match(run.error ?? "", /turn limit/);
});

test("runner terminates when reported non-cache context exceeds 262144 tokens", async () => {
  assert.equal(contextTokensFromUsage({ totalTokens: GRUNT_CONTEXT_LIMIT + 50, cacheRead: 50 }), GRUNT_CONTEXT_LIMIT);
  assert.equal(contextTokensFromUsage({ input: 200_000, output: 62_145, cacheRead: 500_000, cacheWrite: 0 }), GRUNT_CONTEXT_LIMIT + 1);

  const dir = await mkdtemp(join(tmpdir(), "grunt-context-"));
  const script = join(dir, "context.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'too large'}],stopReason:'toolUse',usage:{input:262145,output:0,cacheRead:500000,cacheWrite:0}}})); setInterval(() => {}, 1000);`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.failure, "context_exceeded");
  assert.match(run.error ?? "", /262145 > 262144 tokens/);
});

test("runner marks child failures as potentially partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-fail-"));
  const script = join(dir, "fail.mjs");
  await writeFile(script, "process.exit(2)");
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.failure, "child_error");
  assert.match(run.error ?? "", /edits may remain/);
});

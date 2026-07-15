import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPi } from "../src/runner.ts";

test("runner selects final assistant, sums usage, and exposes activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-runner-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'tool_execution_start',toolName:'edit',args:{path:'a.ts'}})); for(let i=1;i<=2;i++) console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'turn '+i}],model:'worker',stopReason:'stop',usage:{input:i,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}}));`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.text, "turn 2");
  assert.equal(run.cwd, dir);
  assert.equal(run.turns, 2);
  assert.equal(run.usage.input, 3);
  assert.equal(run.activity[0]?.tool, "edit");
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

test("runner marks child failures as potentially partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-fail-"));
  const script = join(dir, "fail.mjs");
  await writeFile(script, "process.exit(2)");
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.failure, "child_error");
  assert.match(run.error ?? "", /edits may remain/);
});

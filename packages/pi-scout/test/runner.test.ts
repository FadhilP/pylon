import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheReadTokensFromUsage, contextTokensFromUsage, runPi } from "../src/runner.ts";
import { scoutChildEnv } from "../src/child-env.ts";

test("runner selects final assistant and sums per-turn usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-runner-")); const script = join(dir, "fake.mjs");
  await writeFile(script, `for (let i=1;i<=2;i++) console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'turn '+i}],model:'fake',stopReason:'stop',usage:{input:i,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}}));`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] } });
  assert.equal(run.text, "turn 2"); assert.equal(run.turns.length, 2); assert.equal(run.usage.input, 3); assert.equal(run.usage.cacheRead, 6);
  assert.equal(run.contextTokens, 8);
  assert.equal(run.cacheReadTokens, 3);
});

test("context and cache-read sizes remain independent", () => {
  assert.equal(contextTokensFromUsage({ totalTokens: 210_000, cacheRead: 80_000 }), 130_000);
  assert.equal(cacheReadTokensFromUsage({ totalTokens: 210_000, cacheRead: 80_000 }), 80_000);
  assert.equal(contextTokensFromUsage({ input: 100_000, output: 10_000, cacheRead: 90_000, cacheWrite: 1 }), 110_001);
  assert.equal(contextTokensFromUsage({ input: -1, output: 2, cacheRead: 3, cacheWrite: 4 }), 0);
  assert.equal(contextTokensFromUsage({ totalTokens: Number.NaN, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 7);
});

test("runner serializes parallel Scout child processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-serial-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `import {mkdir,rm} from 'node:fs/promises'; const lock=process.argv[2]; let held=false; let text='ok'; try { await mkdir(lock); held=true; await new Promise(r=>setTimeout(r,100)); } catch { text='overlap'; } finally { if(held) await rm(lock,{recursive:true}); } console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop',usage:{}}}));`);
  const invocation = { command: process.execPath, args: [script, join(dir, "active")] };
  const runs = await Promise.all([
    runPi([], { cwd: dir, invocation }),
    runPi([], { cwd: dir, invocation }),
  ]);
  assert.deepEqual(runs.map((run) => run.text), ["ok", "ok"]);
});

test("runner passes extension-controlled child environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-env-")); const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.PI_SCOUT_CHECKPOINT_PATH}],stopReason:'stop',usage:{}}}));`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] }, env: { PI_SCOUT_CHECKPOINT_PATH: "controlled" } });
  assert.equal(run.text, "controlled");
});

test("Web Scout child environment is allowlisted and can replace parent environment", async () => {
  const filtered = scoutChildEnv({ PI_HELIOS_WEB_SCOUT_GRANT: "grant" }, {
    PATH: "safe-path", OPENAI_API_KEY: "provider-key", NODE_OPTIONS: "--require=evil", SECRET_DATABASE_URL: "secret",
  });
  assert.deepEqual(filtered, { PATH: "safe-path", OPENAI_API_KEY: "provider-key", PI_HELIOS_WEB_SCOUT_GRANT: "grant" });
  assert.deepEqual(scoutChildEnv({}, { PATH: "safe", OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" }, "openai"), { PATH: "safe", OPENAI_API_KEY: "openai" });
  const dir = await mkdtemp(join(tmpdir(), "scout-env-replace-")); const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:String(process.env.SECRET_DATABASE_URL)+'|'+process.env.PI_HELIOS_WEB_SCOUT_GRANT}],stopReason:'stop',usage:{}}}));`);
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] }, env: { PI_HELIOS_WEB_SCOUT_GRANT: "grant" }, inheritEnv: false });
  assert.equal(run.text, "undefined|grant");
});

test("runner exposes child tool activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-activity-")); const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'1',toolName:'read',args:{path:'a.ts'}})); console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'1',toolName:'read',result:{content:[{type:'text',text:'source'}]},isError:false})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{}}}));`);
  const seen: string[] = [];
  const run = await runPi([], { cwd: dir, invocation: { command: process.execPath, args: [script] }, onActivity: item => seen.push(`${item.kind}:${item.tool}`) });
  assert.deepEqual(seen, ["call:read", "result:read"]);
  assert.equal(run.activity[1]?.text, "source");
});

test("runner bounds activity history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-activity-cap-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `for(let i=0;i<120;i++) console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',args:{path:String(i)}})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{}}}));`);
  const run = await runPi([], {
    cwd: dir,
    invocation: { command: process.execPath, args: [script] },
  });
  assert.equal(run.activity.length, 100);
});

test("runner aborts oversized protocol lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-overflow-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `process.stdout.write('x'.repeat(1024*1024+1)); setTimeout(()=>{},10000);`);
  const run = await runPi([], {
    cwd: dir,
    invocation: { command: process.execPath, args: [script] },
    timeoutMs: 5000,
  });
  assert.equal(run.error, "Scout protocol output exceeded 1 MiB.");
});

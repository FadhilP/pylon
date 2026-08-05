import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSpawn, spawnTimeoutMs } from "../src/runner.ts";

const rpc = (body: string) => `import readline from 'node:readline';
const emit=(value)=>console.log(JSON.stringify(value));
const rl=readline.createInterface({input:process.stdin});
rl.on('line', async line=>{const command=JSON.parse(line); ${body}});`;

async function fake(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-spawn-runner-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, rpc(body));
  return { dir, invocation: { command: process.execPath, args: [script] } };
}

test("runner sends an RPC prompt and streams cumulative usage", async () => {
  const child = await fake(`if(command.type==='prompt'){
    emit({id:command.id,type:'response',command:'prompt',success:true});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'working'}],model:'fake',stopReason:'toolUse',usage:{input:1,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}});
    emit({type:'tool_execution_start',toolName:'read',args:{path:'a.ts'}});
    emit({type:'tool_execution_end',toolName:'read',result:{content:[{type:'text',text:'source'}]}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'reply:'+command.message}],model:'fake',stopReason:'stop',usage:{input:2,output:3,cacheRead:4,cacheWrite:5,cost:{total:.2}}}});
    emit({type:'agent_settled'}); setInterval(()=>{},1000);
  }`);
  const activity: string[] = [];
  const usage: any[] = [];
  const run = await runSpawn([], {
    cwd: child.dir, prompt: "hello", invocation: child.invocation,
    onActivity: item => activity.push(`${item.kind}:${item.tool}`),
    onUsage: item => usage.push(item),
  });
  assert.equal(run.text, "reply:hello");
  assert.deepEqual(usage, [
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: .1 },
    { input: 3, output: 5, cacheRead: 7, cacheWrite: 9, cost: 0.30000000000000004 },
  ]);
  assert.deepEqual(run.usage, usage.at(-1));
  assert.deepEqual(activity, ["call:read", "result:read"]);
  assert.equal(run.error, undefined);
});

test("usage observer failures do not control the spawned child", async () => {
  const child = await fake(`if(command.type==='prompt'){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1}}});emit({type:'agent_settled'});setInterval(()=>{},1000);}`);
  const run = await runSpawn([], { cwd: child.dir, prompt: "x", invocation: child.invocation, onUsage: () => { throw new Error("render failed"); } });
  assert.equal(run.text, "done");
  assert.equal(run.usage.input, 1);
});

test("runner reports rejected commands and accepts protocol lines larger than 1 MiB", async () => {
  const rejected = await fake(`emit({id:command.id,type:'response',command:'prompt',success:false,error:'denied'});setInterval(()=>{},1000);`);
  assert.match((await runSpawn([], { cwd: rejected.dir, prompt: "x", invocation: rejected.invocation })).error ?? "", /denied/);

  const large = await fake(`if(command.type==='prompt'){
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(1024*1024+1)}],stopReason:'stop',usage:{}}});
    emit({type:'agent_settled'});setInterval(()=>{},1000);
  }`);
  const run = await runSpawn([], { cwd: large.dir, prompt: "x", invocation: large.invocation, timeoutMs: 5000 });
  assert.equal(run.error, undefined);
  assert.equal(run.truncated, true);
  assert.ok(Buffer.byteLength(run.text) <= 50 * 1024);
});

test("timeout configuration is bounded", () => {
  assert.equal(spawnTimeoutMs(undefined), 15 * 60 * 1000);
  assert.equal(spawnTimeoutMs("250"), 250);
  assert.throws(() => spawnTimeoutMs("0"), /between 1 and 7200000/);
});

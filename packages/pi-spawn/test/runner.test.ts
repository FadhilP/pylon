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

test("runner sends an RPC prompt, collects bounded activity, usage, and settlement", async () => {
  const child = await fake(`if(command.type==='prompt'){
    emit({id:command.id,type:'response',command:'prompt',success:true});
    emit({type:'tool_execution_start',toolName:'read',args:{path:'a.ts'}});
    emit({type:'tool_execution_end',toolName:'read',result:{content:[{type:'text',text:'source'}]}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'reply:'+command.message}],model:'fake',stopReason:'stop',usage:{input:2,output:3,cacheRead:4,cacheWrite:5,cost:{total:.2}}}});
    emit({type:'agent_settled'}); setInterval(()=>{},1000);
  }`);
  const activity: string[] = [];
  const run = await runSpawn([], { cwd: child.dir, prompt: "hello", invocation: child.invocation, onActivity: item => activity.push(`${item.kind}:${item.tool}`) });
  assert.equal(run.text, "reply:hello");
  assert.deepEqual(run.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: .2 });
  assert.deepEqual(activity, ["call:read", "result:read"]);
  assert.equal(run.error, undefined);
});

test("runner reports rejected commands and aborts oversized protocol output", async () => {
  const rejected = await fake(`emit({id:command.id,type:'response',command:'prompt',success:false,error:'denied'});setInterval(()=>{},1000);`);
  assert.match((await runSpawn([], { cwd: rejected.dir, prompt: "x", invocation: rejected.invocation })).error ?? "", /denied/);

  const dir = await mkdtemp(join(tmpdir(), "pi-spawn-overflow-"));
  const script = join(dir, "overflow.mjs");
  await writeFile(script, `process.stdout.write('x'.repeat(1024*1024+1));setInterval(()=>{},1000);`);
  const overflow = await runSpawn([], { cwd: dir, prompt: "x", invocation: { command: process.execPath, args: [script] }, timeoutMs: 5000 });
  assert.match(overflow.error ?? "", /exceeded 1 MiB/);
});

test("timeout configuration is bounded", () => {
  assert.equal(spawnTimeoutMs(undefined), 15 * 60 * 1000);
  assert.equal(spawnTimeoutMs("250"), 250);
  assert.throws(() => spawnTimeoutMs("0"), /between 1 and 7200000/);
});

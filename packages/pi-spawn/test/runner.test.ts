import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSpawn, spawnTimeoutMs } from "../src/runner.ts";

const defaultStats = {
  userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: .1,
};
const defaultState = { model: { provider: "fake", id: "model" }, thinkingLevel: "high" };
const rpc = (body: string, stats: typeof defaultStats | null, state: typeof defaultState | null) => `import readline from 'node:readline';
const emit=(value)=>console.log(JSON.stringify(value));
const rl=readline.createInterface({input:process.stdin});
rl.on('line', async line=>{const command=JSON.parse(line);
if(command.type==='get_session_stats'){emit({id:command.id,type:'response',command:'get_session_stats',success:${stats !== null},${stats ? `data:${JSON.stringify(stats)}` : "error:'unsupported'"}});return;}
if(command.type==='get_state'){emit({id:command.id,type:'response',command:'get_state',success:${state !== null},${state ? `data:${JSON.stringify(state)}` : "error:'unsupported'"}});return;}
${body}});`;

async function fake(body: string, stats: typeof defaultStats | null = defaultStats, state: typeof defaultState | null = defaultState) {
  const dir = await mkdtemp(join(tmpdir(), "pi-spawn-runner-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, rpc(body, stats, state));
  return { dir, invocation: { command: process.execPath, args: [script] } };
}

test("runner sends an RPC prompt and returns invocation and session usage", async () => {
  const child = await fake(`if(command.type==='prompt'){
    emit({id:command.id,type:'response',command:'prompt',success:true});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'working'}],model:'fake',stopReason:'toolUse',usage:{input:1,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}});
    emit({type:'tool_execution_start',toolCallId:'call-read',toolName:'read',args:{path:'a.ts'}});
    emit({type:'tool_execution_end',toolCallId:'call-read',toolName:'read',result:{content:[{type:'text',text:'source'}]}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'reply:'+command.message}],model:'fake',stopReason:'stop',usage:{input:2,output:3,cacheRead:4,cacheWrite:5,cost:{total:.2}}}});
    emit({type:'agent_settled'}); emit({type:'agent_settled'}); setInterval(()=>{},1000);
  }`, {
    ...defaultStats,
    userMessages: 3,
    tokens: { input: 30, output: 12, cacheRead: 20, cacheWrite: 1, total: 63 },
    cost: .9,
  });
  const activity: string[] = [];
  const usage: any[] = [];
  const states: any[] = [];
  const run = await runSpawn([], {
    cwd: child.dir, prompt: "hello", invocation: child.invocation,
    onActivity: item => activity.push(`${item.id}:${item.kind}:${item.tool}`),
    onUsage: item => usage.push(item),
    onState: state => states.push(state),
  });
  assert.equal(run.text, "reply:hello");
  assert.deepEqual(usage, [
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: .1 },
    { input: 3, output: 5, cacheRead: 7, cacheWrite: 9, cost: 0.30000000000000004 },
  ]);
  assert.deepEqual(run.usage, usage.at(-1));
  assert.deepEqual(run.sessionUsage, { input: 30, output: 12, cacheRead: 20, cacheWrite: 1, cost: .9 });
  assert.deepEqual(activity, ["call-read:call:read", "call-read:result:read"]);
  assert.deepEqual(states.at(-1), { model: "fake/model", thinking: "high" });
  assert.equal(run.model, "fake/model");
  assert.equal(run.thinking, "high");
  assert.equal(run.error, undefined);
});

test("runner preserves every correlated tool event in one invocation", async () => {
  const child = await fake(`if(command.type==='prompt'){
    for(let index=0;index<125;index++){
      const id='call-'+index;
      emit({type:'tool_execution_start',toolCallId:id,toolName:'read',args:{path:'x'.repeat(3000)+index}});
      emit({type:'tool_execution_end',toolCallId:id,toolName:'read',result:{content:[{type:'text',text:'result-'+index}]}});
    }
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{}}});
    emit({type:'agent_settled'});setInterval(()=>{},1000);
  }`);
  const run = await runSpawn([], { cwd: child.dir, prompt: "x", invocation: child.invocation });
  assert.equal(run.activity.length, 250);
  assert.equal(run.activity[0]?.id, "call-0");
  assert.equal(run.activity.at(-1)?.id, "call-124");
  assert.ok(Buffer.byteLength(run.activity[0]?.text ?? "") <= 2_000);
  assert.deepEqual(run.activity.slice(-2).map(({ id, kind }) => ({ id, kind })), [
    { id: "call-124", kind: "call" },
    { id: "call-124", kind: "result" },
  ]);
});

test("usage observer failures do not control the spawned child", async () => {
  const child = await fake(`if(command.type==='prompt'){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1}}});emit({type:'agent_settled'});setInterval(()=>{},1000);}`);
  const run = await runSpawn([], { cwd: child.dir, prompt: "x", invocation: child.invocation, onUsage: () => { throw new Error("render failed"); } });
  assert.equal(run.text, "done");
  assert.equal(run.usage.input, 1);
});

test("runner keeps a completed turn when cumulative session stats are unavailable or malformed", async () => {
  const body = `if(command.type==='prompt'){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:2}}});emit({type:'agent_settled'});setInterval(()=>{},1000);}`;
  for (const stats of [null, { ...defaultStats, cost: -1 }]) {
    const child = await fake(body, stats);
    const run = await runSpawn([], { cwd: child.dir, prompt: "x", invocation: child.invocation });
    assert.equal(run.error, undefined);
    assert.equal(run.sessionUsage, undefined);
    assert.equal(run.usage.input, 2);
  }
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

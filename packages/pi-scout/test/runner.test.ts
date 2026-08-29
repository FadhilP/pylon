import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheReadTokensFromUsage, contextTokensFromUsage, getPiInvocation, runPi } from "../src/runner.ts";
import { scoutChildEnv } from "../src/child-env.ts";

const rpc = (body: string) => `import readline from 'node:readline';
const emit=(value)=>console.log(JSON.stringify(value));
const settled=()=>emit({type:'agent_settled'});
const rl=readline.createInterface({input:process.stdin});
rl.on('line', async line=>{const command=JSON.parse(line); ${body}});`;
const assistant = (text: string, stopReason = "stop", usage = "{}") =>
  `{type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(text)}}],model:'fake',stopReason:${JSON.stringify(stopReason)},usage:${usage}}}`;
async function fake(prefix: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const script = join(dir, "fake.mjs");
  await writeFile(script, rpc(body));
  return { dir, invocation: { command: process.execPath, args: [script] } };
}

test("child invocation does not mistake an embedding web host for the Pi CLI", async () => {
  const originalScript = process.argv[1];
  const originalMarker = process.env.PI_CODING_AGENT;
  const dir = await mkdtemp(join(tmpdir(), "scout-host-"));
  const host = join(dir, "web-server.mjs");
  await writeFile(host, "");
  try {
    process.argv[1] = host;
    delete process.env.PI_CODING_AGENT;
    const embedded = getPiInvocation(["--mode", "rpc"]);
    assert.equal(embedded.command, process.execPath);
    assert.notEqual(embedded.args[0], host);
    assert.match(embedded.args[0]!, /[\\/]dist[\\/]cli\.js$/);

    process.env.PI_CODING_AGENT = "true";
    assert.notEqual(getPiInvocation(["--mode", "rpc"]).args[0], host);
    process.argv[1] = embedded.args[0]!;
    assert.deepEqual(getPiInvocation(["--mode", "rpc"]).args, [embedded.args[0], "--mode", "rpc"]);
  } finally {
    process.argv[1] = originalScript;
    if (originalMarker === undefined) delete process.env.PI_CODING_AGENT;
    else process.env.PI_CODING_AGENT = originalMarker;
  }
});

// Tiny RPC children acknowledge commands and stay alive until the runner terminates them.
test("runner submits its prompt and selects final assistant usage", async () => {
  const child = await fake(
    "scout-runner-",
    `if(command.type==='prompt'){emit({id:command.id,type:'response',command:'prompt',success:true}); emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'prompt:'+command.message}],model:'fake',stopReason:'stop',usage:{input:2,output:2,cacheRead:3,cacheWrite:4,cost:{total:.1}}}}); settled(); setInterval(()=>{},1000);}`,
  );
  const contexts: Array<number | null> = [];
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "find it",
    invocation: child.invocation,
    onContext: tokens => contexts.push(tokens),
  });
  assert.equal(run.text, "prompt:find it");
  assert.equal(run.turns.length, 1);
  assert.equal(run.usage.cacheRead, 3);
  assert.equal(run.contextTokens, 8);
  assert.equal(run.contextWindowTokens, 11);
  assert.deepEqual(contexts, [11]);
  assert.equal(run.cacheReadTokens, 3);
});

test("runner honors a caller-local final report cap", async () => {
  const child = await fake(
    "scout-report-cap-",
    `if(command.type==='prompt'){emit(${assistant("x".repeat(30_000))});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", resultMaxBytes: 12 * 1024, invocation: child.invocation });
  assert.equal(run.truncated, true);
  assert.ok(Buffer.byteLength(run.text) <= 12 * 1024);
  assert.match(run.text, /omitted content/i);
});

test("runner can leave final report uncapped for caller-side wrapping", async () => {
  const text = "x".repeat(30_000);
  const child = await fake(
    "scout-report-uncapped-",
    `if(command.type==='prompt'){emit(${assistant("x".repeat(30_000))});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", resultMaxBytes: false, invocation: child.invocation });
  assert.equal(run.text, text);
  assert.equal(run.truncated, false);
});

test("context and cache-read sizes remain independent", () => {
  assert.equal(contextTokensFromUsage({ totalTokens: 210_000, cacheRead: 80_000 }), 130_000);
  assert.equal(cacheReadTokensFromUsage({ totalTokens: 210_000, cacheRead: 80_000 }), 80_000);
  assert.equal(contextTokensFromUsage({ input: 100_000, output: 10_000, cacheRead: 90_000, cacheWrite: 1 }), 110_001);
  assert.equal(contextTokensFromUsage({ input: -1, output: 2, cacheRead: 3, cacheWrite: 4 }), 0);
});

test("queued runner does not spawn after cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-cancelled-"));
  const marker = join(dir, "spawned");
  const script = join(dir, "should-not-run.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPi([], {
      cwd: dir,
      prompt: "cancelled",
      signal: controller.signal,
      invocation: { command: process.execPath, args: [script] },
    }),
    /aborted/i,
  );
  await assert.rejects(access(marker));
});

test("runner serializes parallel Scout child processes by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-serial-"));
  const script = join(dir, "fake.mjs");
  await writeFile(
    script,
    rpc(
      `if(command.type==='prompt'){const {mkdir,rm}=await import('node:fs/promises'); const lock=process.argv[2]; let held=false,text='ok'; try{await mkdir(lock);held=true;await new Promise(r=>setTimeout(r,100));}catch{text='overlap';}finally{if(held)await rm(lock,{recursive:true});} emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model:'fake',stopReason:'stop',usage:{}}}); settled(); setInterval(()=>{},1000);}`,
    ),
  );
  const invocation = { command: process.execPath, args: [script, join(dir, "active")] };
  const runs = await Promise.all([
    runPi([], { cwd: dir, prompt: "one", invocation }),
    runPi([], { cwd: dir, prompt: "two", invocation }),
  ]);
  assert.deepEqual(
    runs.map(run => run.text),
    ["ok", "ok"],
  );
});

test("runner permits explicit concurrent Scout child processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-concurrent-"));
  const script = join(dir, "fake.mjs");
  await writeFile(
    script,
    rpc(
      `if(command.type==='prompt'){const {mkdir,rm}=await import('node:fs/promises'); const lock=process.argv[2]; let held=false,text='ok'; try{await mkdir(lock);held=true;await new Promise(r=>setTimeout(r,100));}catch{text='overlap';}finally{if(held)await rm(lock,{recursive:true});} emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model:'fake',stopReason:'stop',usage:{}}}); settled(); setInterval(()=>{},1000);}`,
    ),
  );
  const invocation = { command: process.execPath, args: [script, join(dir, "active")] };
  const runs = await Promise.all([
    runPi([], { cwd: dir, prompt: "one", invocation, concurrent: true }),
    runPi([], { cwd: dir, prompt: "two", invocation, concurrent: true }),
  ]);
  assert.deepEqual(runs.map(run => run.text).sort(), ["ok", "overlap"]);
});

test("runner passes extension-controlled child environment", async () => {
  const child = await fake(
    "scout-env-",
    `if(command.type==='prompt'){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.PI_SCOUT_CHECKPOINT_PATH}],model:'fake',stopReason:'stop',usage:{}}});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    invocation: child.invocation,
    env: { PI_SCOUT_CHECKPOINT_PATH: "controlled" },
  });
  assert.equal(run.text, "controlled");
});

test("Web Scout child environment is allowlisted and can replace parent environment", async () => {
  assert.deepEqual(
    scoutChildEnv(
      { PI_HELIOS_WEB_SCOUT_GRANT: "grant" },
      {
        PATH: "safe-path",
        OPENAI_API_KEY: "provider-key",
        NODE_OPTIONS: "--require=evil",
        SECRET_DATABASE_URL: "secret",
      },
    ),
    { PATH: "safe-path", OPENAI_API_KEY: "provider-key", PI_HELIOS_WEB_SCOUT_GRANT: "grant" },
  );
  assert.deepEqual(
    scoutChildEnv({}, { PATH: "safe", OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" }, "openai"),
    { PATH: "safe", OPENAI_API_KEY: "openai" },
  );
  assert.deepEqual(
    scoutChildEnv(
      {},
      { PATH: "safe", OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic", GEMINI_API_KEY: "gemini" },
      "anthropic",
      ["openai"],
    ),
    { PATH: "safe", OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" },
  );
  const child = await fake(
    "scout-env-replace-",
    `if(command.type==='prompt'){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:String(process.env.SECRET_DATABASE_URL)+'|'+process.env.PI_HELIOS_WEB_SCOUT_GRANT}],model:'fake',stopReason:'stop',usage:{}}});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    invocation: child.invocation,
    env: { PI_HELIOS_WEB_SCOUT_GRANT: "grant" },
    inheritEnv: false,
  });
  assert.equal(run.text, "undefined|grant");
});

test("runner exposes and bounds child tool activity", async () => {
  const child = await fake(
    "scout-activity-",
    `if(command.type==='prompt'){emit({type:'tool_execution_start',toolCallId:'read-1',toolName:'read',args:{path:'a.ts'}});emit({type:'tool_execution_end',toolCallId:'read-1',toolName:'read',result:{content:[{type:'text',text:'source'}]}});for(let i=0;i<120;i++)emit({type:'tool_execution_start',toolCallId:'read-'+(i+2),toolName:'read',args:{path:String(i)}});emit(${assistant("done")});settled();setInterval(()=>{},1000);}`,
  );
  const seen: any[] = [];
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    invocation: child.invocation,
    onActivity: item => seen.push(item),
  });
  assert.equal(
    seen
      .slice(0, 2)
      .map(item => `${item.kind}:${item.tool}`)
      .join(","),
    "call:read,result:read",
  );
  assert.equal(seen[0]?.id, "read-1");
  assert.ok(!Number.isNaN(Date.parse(seen[0]?.startedAt ?? "")));
  assert.equal(seen[1]?.id, "read-1");
  assert.ok((seen[1]?.durationMs ?? -1) >= 0);
  assert.equal(run.activity.length, 100);
});

test("exact discovery ceiling sends one steer and accepts one final response", async () => {
  const child = await fake(
    "scout-cost-limit-",
    `if(command.type==='prompt'){emit({id:command.id,type:'response',command:'prompt',success:true});emit(${assistant("first", "toolUse", "{cost:{total:.5}}")});}else if(command.type==='steer'){emit({id:command.id,type:'response',command:'steer',success:true});emit(${assistant("final findings", "stop", "{cost:{total:.2}}")});settled();setInterval(()=>{},1000);}`,
  );
  const usage: any[] = [];
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    maxCostUsd: 0.5,
    invocation: child.invocation,
    onUsage: item => usage.push(item),
  });
  assert.equal(run.text, "final findings");
  assert.equal(run.usage.cost, 0.7);
  assert.deepEqual(
    usage.map(item => item.cost),
    [0.5, 0.7],
  );
  assert.deepEqual(run.usage, usage.at(-1));
  assert.equal(run.budgetExceeded, true);
  assert.equal(run.finalizationAttempted, true);
  assert.equal(run.finalizationSucceeded, true);
  assert.equal(run.failure, undefined);
  assert.equal(run.error, undefined);
});

test("runner reserves deadline headroom for a final report", async () => {
  const child = await fake(
    "scout-deadline-",
    `if(command.type==='prompt'){emit({id:command.id,type:'response',command:'prompt',success:true});}else if(command.type==='steer'){emit({id:command.id,type:'response',command:'steer',success:true});emit(${assistant("in-flight turn", "toolUse")});emit(${assistant("deadline findings")});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    timeoutMs: 1_000,
    finalizeAfterMs: 20,
    invocation: child.invocation,
  });
  assert.equal(run.text, "deadline findings");
  assert.equal(run.budgetExceeded, false);
  assert.equal(run.finalizationAttempted, true);
  assert.equal(run.finalizationSucceeded, true);
  assert.equal(run.failure, undefined);
  assert.equal(run.error, undefined);
});

test("usage observer failures do not control Scout", async () => {
  const child = await fake(
    "scout-usage-observer-",
    `if(command.type==='prompt'){emit(${assistant("done", "stop", "{input:1}")});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], {
    cwd: child.dir,
    prompt: "x",
    invocation: child.invocation,
    onUsage: () => {
      throw new Error("render failed");
    },
  });
  assert.equal(run.text, "done");
  assert.equal(run.usage.input, 1);
});

test("a normal final stop above the ceiling succeeds without steering", async () => {
  const child = await fake(
    "scout-cost-final-",
    `if(command.type==='prompt'){emit(${assistant("done", "stop", "{cost:{total:.6}}")});settled();setInterval(()=>{},1000);}else if(command.type==='steer'){throw new Error('unexpected steer');}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", maxCostUsd: 0.5, invocation: child.invocation });
  assert.equal(run.text, "done");
  assert.equal(run.budgetExceeded, false);
  assert.equal(run.finalizationAttempted, false);
  assert.equal(run.error, undefined);
});

test("a finalization tool request fails distinctly and terminates", async () => {
  const child = await fake(
    "scout-final-tools-",
    `if(command.type==='prompt')emit(${assistant("first", "toolUse", "{cost:{total:.5}}")});else if(command.type==='steer')emit(${assistant("more tools", "toolUse", "{cost:{total:.1}}")});`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", maxCostUsd: 0.5, invocation: child.invocation });
  assert.equal(run.failure, "budget_exceeded");
  assert.equal(run.finalizationSucceeded, false);
  assert.match(run.error ?? "", /requested more tools during finalization/);
});

test("settlement before the steered report fails as incomplete finalization", async () => {
  const child = await fake(
    "scout-final-missing-",
    `if(command.type==='prompt')emit(${assistant("first", "toolUse", "{cost:{total:.5}}")});else if(command.type==='steer'){emit({id:command.id,type:'response',command:'steer',success:true});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", maxCostUsd: 0.5, invocation: child.invocation });
  assert.equal(run.failure, "budget_exceeded");
  assert.match(run.error ?? "", /settled before returning/);
});

test("rejected RPC commands fail clearly", async () => {
  const child = await fake(
    "scout-rpc-reject-",
    `if(command.type==='prompt'){emit({id:command.id,type:'response',command:'prompt',success:false,error:'denied'});setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", invocation: child.invocation });
  assert.equal(run.error, "Scout RPC prompt command failed: denied");
});

test("runner sanitizes reported costs before aggregating usage", async () => {
  const child = await fake(
    "scout-cost-sanitize-",
    `if(command.type==='prompt'){for(const cost of [-1,'0.9',.2,undefined])emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'valid'}],stopReason:'stop',usage:cost===undefined?{}:{cost:{total:cost}}}});settled();setInterval(()=>{},1000);}`,
  );
  const run = await runPi([], { cwd: child.dir, prompt: "x", invocation: child.invocation });
  assert.deepEqual(
    run.turns.map(turn => turn.cost),
    [0, 0, 0.2, 0],
  );
  assert.equal(run.usage.cost, 0.2);
});

test("runner aborts oversized protocol buffers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-overflow-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `process.stdout.write('x'.repeat(1024*1024*5+1));setTimeout(()=>{},10000);`);
  const run = await runPi([], {
    cwd: dir,
    prompt: "x",
    invocation: { command: process.execPath, args: [script] },
    timeoutMs: 5000,
  });
  assert.equal(run.error, "Scout protocol buffer exceeded 5 MiB.");
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpSettingsManager, nativeMcpStates } from "../src/server/runtime/mcp-settings.ts";
import { RuntimeCoordinator } from "../src/server/runtime/runtime-coordinator.ts";
import type { McpSettingsAction } from "../src/shared/settings/mcp.ts";

async function fixture(trusted = true) {
  const root = await mkdtemp(join(tmpdir(), "pylon-mcp-settings-"));
  const cwd = join(root,"project"), agentDir = join(root,"agent");
  await Promise.all([mkdir(cwd),mkdir(agentDir)]);
  const config = await import(new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const path = join(agentDir,"mcp.json");
  const initial = {extra:{keep:true},mcpServers:{fixture:{command:process.execPath,args:["private-fixture-argument"],env:{PRIVATE_SETTING:"fixture-sensitive-value"},enabled:false}}};
  await writeFile(path,JSON.stringify(initial));
  const ctx = {cwd,isProjectTrusted:()=>trusted,sessionManager:{getSessionId:()=>"selected"},ui:{notify(){}},mode:"rpc"} as unknown as ExtensionContext;
  const manager = new McpSettingsManager(agentDir,config,()=>[]);
  const bind = () => manager.bind(ctx,config.loadMcpConfig({agentDir,cwd,projectTrusted:trusted}));
  bind();
  return {manager,bind,cwd,agentDir,path,initial,async close(){manager.stop();await rm(root,{recursive:true,force:true});}};
}
const request = async (manager: McpSettingsManager, input: Record<string,unknown>) => {
  const snapshot = await manager.snapshot();
  return {...input,sessionId:snapshot.sessionId,expectedGeneration:1,expectedRevision:snapshot.revision,confirmed:true} as McpSettingsAction;
};

test("MCP settings preserve unrelated configuration and secrets, reject stale writes, and require reload after external edits", {timeout:30_000}, async () => {
  const value = await fixture();
  try {
    value.manager.setCommand(async (_args,ctx)=>{ctx.ui.notify("fixture: disabled (codemode)\n    private-fixture-argument", "info");});
    const initial = await value.manager.snapshot();
    const browser = JSON.stringify(initial);
    assert.doesNotMatch(browser,/private-fixture-argument|fixture-sensitive-value|PRIVATE_SETTING/);
    const action = await request(value.manager,{action:"enabled",name:"fixture",enabled:true});
    await value.manager.action(action);
    const saved = JSON.parse(await readFile(value.path,"utf8"));
    assert.deepEqual(saved.extra,value.initial.extra);
    assert.deepEqual(saved.mcpServers.fixture.args,value.initial.mcpServers.fixture.args);
    assert.deepEqual(saved.mcpServers.fixture.env,value.initial.mcpServers.fixture.env);
    assert.equal(saved.mcpServers.fixture.enabled,undefined);
    await assert.rejects(value.manager.action(action),/configuration changed/);
    value.bind();
    await value.manager.action(await request(value.manager,{action:"exposure",name:"fixture",exposure:"hidden"}));
    assert.equal(JSON.parse(await readFile(value.path,"utf8")).mcpServers.fixture.exposure,"hidden");
    value.bind();
    const before = await request(value.manager,{action:"enabled",name:"fixture",enabled:false});
    saved.extra.external = "new value";
    await writeFile(value.path,JSON.stringify(saved));
    assert.equal((await value.manager.snapshot()).needsReload,true);
    await assert.rejects(value.manager.action(before),/configuration changed/);
    const fresh = await request(value.manager,{action:"enabled",name:"fixture",enabled:false});
    await assert.rejects(value.manager.action(fresh),/Reload MCP configuration/);
    assert.equal(JSON.parse(await readFile(value.path,"utf8")).extra.external,"new value");
  } finally {await value.close();}
});

test("MCP project overrides persist only to their trusted source; untrusted projects cannot supply editable servers", {timeout:30_000}, async () => {
  for (const trusted of [true,false]) {
    const value = await fixture(trusted);
    try {
      await mkdir(join(value.cwd,".pi"));
      const project = join(value.cwd,".pi","mcp.json");
      await writeFile(project,JSON.stringify({extra:"keep",mcpServers:{fixture:{enabled:false},projectOnly:{command:process.execPath,enabled:false}}}));
      value.bind();
      const snapshot = await value.manager.snapshot();
      if (!trusted) {
        assert.equal(snapshot.servers.some(server=>server.name === "projectOnly"),false);
        await assert.rejects(value.manager.action(await request(value.manager,{action:"enabled",name:"projectOnly",enabled:true})),/unavailable/);
      } else {
        const original = await readFile(value.path,"utf8");
        await value.manager.action(await request(value.manager,{action:"enabled",name:"fixture",enabled:true}));
        assert.equal(await readFile(value.path,"utf8"),original);
        const changed = JSON.parse(await readFile(project,"utf8"));
        assert.equal(changed.mcpServers.fixture.enabled,true,"override defaults must not revert to inherited disabled value");
        assert.equal(changed.extra,"keep");
      }
    } finally {await value.close();}
  }
});

test("MCP status probes do not wait for startup and do not expose or trust error lines; reconnect failure is sanitized", async () => {
  const value = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve=>{release=resolve;});
  try {
    value.manager.setCommand(async (args,ctx)=>{
      if (!args) {await pending;ctx.ui.notify("fixture: connected, 2 tools (codemode)\n    remote-private-error", "info");}
      else ctx.ui.notify("remote-private-error", "error");
    });
    const first = await value.manager.snapshot();
    assert.equal(first.servers[0]?.state,"unknown");
    release();
    await new Promise(resolve=>setImmediate(resolve));
    const connected = await value.manager.snapshot();
    assert.equal(connected.servers[0]?.state,"connected");
    assert.equal(connected.servers[0]?.toolCount,2);
    assert.doesNotMatch(JSON.stringify(connected),/remote-private-error/);
    const states = nativeMcpStates("fixture: failed (direct)\n    other: connected, 900 tools (direct)\nconfig error: sensitive",["fixture","other"]);
    assert.equal(states.get("fixture")?.state,"failed");
    assert.equal(states.has("other"),false);
    assert.equal(nativeMcpStates("fixture: connected (direct)\nfixture: failed (direct)",["fixture"]).size,0,"ambiguous status must stay unknown");
    await value.manager.action(await request(value.manager,{action:"enabled",name:"fixture",enabled:true}));
    value.bind();
    await assert.rejects(value.manager.action(await request(value.manager,{action:"reconnect",name:"fixture"})), error=>error instanceof Error && !error.message.includes("remote-private-error") && /reconnect failed/.test(error.message));
    value.manager.stop();
    await assert.rejects(value.manager.snapshot(),/unavailable/);
  } finally {release();await value.close();}
});

test("MCP mutations reject unsafe names, unexpected credential fields, malformed files and unsupported editors without overwriting", async () => {
  const value = await fixture();
  try {
    const original = await readFile(value.path,"utf8");
    const action = await request(value.manager,{action:"enabled",name:"fixture",enabled:true});
    for (const extra of [{name:"fixture\nlogout other"},{name:"__proto__"},{headers:{Authorization:"fixture"}},{confirmed:false}])
      await assert.rejects(value.manager.action({...action,...extra} as McpSettingsAction),/Invalid MCP action/);
    assert.equal(await readFile(value.path,"utf8"),original);
    const mixed = JSON.stringify(value.initial,null,2).replace("\n","\r\n");
    await writeFile(value.path,mixed);
    assert.equal((await value.manager.snapshot()).servers[0]?.writable,false);
    await assert.rejects(value.manager.action(await request(value.manager,{action:"enabled",name:"fixture",enabled:true})),/cannot be edited safely/);
    assert.equal(await readFile(value.path,"utf8"),mixed);
    await writeFile(value.path,'{"private": "sensitive malformed');
    const malformed = await value.manager.snapshot();
    assert.equal(malformed.configurationError,true);
    assert.doesNotMatch(JSON.stringify(malformed),/sensitive malformed/);
    await assert.rejects(value.manager.action(await request(value.manager,{action:"enabled",name:"fixture",enabled:true})),/Reload MCP configuration/);
    assert.equal(await readFile(value.path,"utf8"),'{"private": "sensitive malformed');
  } finally {await value.close();}
});

test("MCP coordinator actions bind selection/generation, wait for idle slots, reload every live runtime and report partial application", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const effects: string[] = [];
  let running = true, failReload = false;
  const selected = {id:"selected",innerGeneration:7,driver:{canSleep:()=>true,
    mcpAction:async (input: McpSettingsAction)=>{assert.equal(input.expectedGeneration,7);effects.push("save");},
    mcpSettings:async()=>({sessionId:"selected",sessionGeneration:7,available:true,revision:"a".repeat(64),servers:[],needsReload:false,configurationError:false}),
    reloadExtensions:async()=>{effects.push("selected reload");},
  }};
  internal.selectedId = "selected"; internal.generation = 3;
  internal.slots.set("selected",selected);
  internal.slots.set("other",{id:"other",driver:{canSleep:()=>!running,reloadExtensions:async()=>{effects.push("other reload");if(failReload)throw new Error("private error");}}});
  const action: McpSettingsAction = {action:"enabled",name:"fixture",enabled:false,confirmed:true,sessionId:"selected",expectedGeneration:3,expectedRevision:"a".repeat(64)};
  await assert.rejects(coordinator.mcpAction(action),/idle/);
  assert.deepEqual(effects,[]);
  running = false;
  await assert.rejects(coordinator.mcpAction({...action,expectedGeneration:2}),/generation/);
  await assert.rejects(coordinator.mcpAction({...action,sessionId:"other"}),/Session changed/);
  assert.deepEqual(effects,[]);
  assert.equal((await coordinator.mcpAction(action)).sessionGeneration,3);
  assert.deepEqual(effects,["save","selected reload","other reload"]);
  effects.length=0; failReload=true;
  await assert.rejects(coordinator.mcpAction(action),/configuration is saved, but not all sessions could reload/);
  assert.deepEqual(effects,["save","selected reload","other reload"],"partial reload must not trigger blind rollback");
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPylonRuntimeFactory } from "../src/server/pi/runtime-factory.ts";

async function fixture() {
  const root = await mkdtemp(join(os.tmpdir(), "pylon-prompt-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await Promise.all([
    writeFile(join(agentDir, "SYSTEM.md"), "global system"),
    writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global append"),
  ]);
  return { root, cwd, agentDir };
}

test("main prompt append preserves Pi-discovered prompt resources", async () => {
  const value = await fixture();
  try {
    const factory = await createPylonRuntimeFactory({
      agentDir: value.agentDir,
      mainPrompt: { mode: "append", text: "operator append" },
    });
    const runtime = await factory({
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    assert.equal(runtime.services.resourceLoader.getSystemPrompt(), "global system");
    assert.deepEqual(runtime.services.resourceLoader.getAppendSystemPrompt(), ["global append", "operator append"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("main prompt replace overrides SYSTEM.md but keeps Pi append resources", async () => {
  const value = await fixture();
  try {
    const factory = await createPylonRuntimeFactory({
      agentDir: value.agentDir,
      mainPrompt: { mode: "replace", text: "operator replacement" },
    });
    const runtime = await factory({
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    assert.equal(runtime.services.resourceLoader.getSystemPrompt(), "operator replacement");
    assert.deepEqual(runtime.services.resourceLoader.getAppendSystemPrompt(), ["global append"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

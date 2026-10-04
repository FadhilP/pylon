import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSessionRuntime,
  createEventBus,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createPylonRuntimeFactory } from "../src/server/runtime/runtime-factory.ts";
import { captureExtensionLoadTimings } from "../src/server/runtime/pi-startup-timings.ts";
import { saveConfig } from "pylon-core/src/config.ts";

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

test("extension timing capture extracts Pi checkpoints and always restores logging", () => {
  const original = console.error;
  const extensionPath = join(os.tmpdir(), "sample-extension.ts");
  const timings = captureExtensionLoadTimings(() => {
    console.error("\n--- Startup Timings: extensions ---");
    console.error(`  ${extensionPath} module import: 42ms`);
    console.error("  <inline:web> factory: 3ms");
    console.error("  TOTAL: 45ms");
    console.error("----------------------------------\n");
  });

  assert.deepEqual(timings, [
    { extension: "sample-extension.ts", operation: "module import", durationMs: 42 },
    { extension: "<inline:web>", operation: "factory", durationMs: 3 },
  ]);
  assert.equal(console.error, original);
  assert.throws(
    () =>
      captureExtensionLoadTimings(() => {
        throw new Error("expected printer failure");
      }),
    /expected printer failure/,
  );
  assert.equal(console.error, original);
});
test("main prompt append preserves Pi-discovered prompt resources", async () => {
  const value = await fixture();
  let timingObserved = false;
  try {
    const factory = await createPylonRuntimeFactory({
      agentDir: value.agentDir,
      mainPrompt: { mode: "append", text: "operator append" },
      onExtensionLoadTimings: () => {
        timingObserved = true;
        throw new Error("diagnostic observer failed");
      },
    });
    const runtime = await factory({
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    assert.equal(runtime.services.resourceLoader.getSystemPrompt(), "global system");
    assert.deepEqual(runtime.services.resourceLoader.getAppendSystemPrompt(), ["global append", "operator append"]);
    assert.equal(timingObserved, true);
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

test("main agent default selects new sessions without overriding a resumed model", async () => {
  const value = await fixture();
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(value.agentDir, "auth.json"),
      modelsPath: join(value.agentDir, "models.json"),
    });
    await modelRuntime.setRuntimeApiKey("openai", "test-key");
    await saveConfig(
      { version: 1, lineEditEnabled: true, mainAgentModel: "openai/gpt-4o-mini" },
      join(value.agentDir, "pylon-core", "config.json"),
    );
    const factory = await createPylonRuntimeFactory({ agentDir: value.agentDir, modelRuntime });
    const fresh = await factory({
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    assert.equal(fresh.session.model?.id, "gpt-4o-mini");
    assert.equal(fresh.services.settingsManager.getDefaultModel(), "gpt-4o-mini");
    await saveConfig(
      { version: 1, lineEditEnabled: true, mainAgentModel: "openai/gpt-4o" },
      join(value.agentDir, "pylon-core", "config.json"),
    );
    const next = await factory({
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    assert.equal(next.session.model?.id, "gpt-4o");

    const history = SessionManager.inMemory(value.cwd);
    history.appendModelChange("openai", "gpt-4o-mini");
    history.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
    const resumed = await factory({ cwd: value.cwd, agentDir: value.agentDir, sessionManager: history });
    assert.equal(resumed.session.model?.id, "gpt-4o-mini");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test("automatic indexing waits for all native startup hooks and timing observers preserve hook errors", async () => {
  const value = await fixture();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousIndexPath = process.env.PI_DISCOVER_INDEX_PATH;
  process.env.PI_CODING_AGENT_DIR = value.agentDir;
  process.env.PI_DISCOVER_INDEX_PATH = join(value.agentDir, "index.sqlite");
  const entered = deferred(),
    release = deferred(),
    indexed = deferred();
  const eventBus = createEventBus();
  let indexing = false,
    resources = 0,
    observed = 0;
  eventBus.on("pi-discover:index-state", (event: any) => {
    if (event.state === "indexing") {
      indexing = true;
      indexed.resolve();
    }
  });
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  let binding: Promise<void> | undefined;
  try {
    const factory = await createPylonRuntimeFactory({
      agentDir: value.agentDir,
      eventBus,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../../../packages/pi-discover/extensions/pi-discover.ts", import.meta.url)),
      ],
      onStartupHook: () => {
        observed++;
        throw new Error("diagnostic observer failed");
      },
      extensionFactories: [
        pi => {
          pi.on("session_start", async () => {
            entered.resolve();
            await release.promise;
            throw new Error("expected startup failure");
          });
          pi.on("resources_discover", () => {
            resources++;
          });
        },
      ],
    });
    runtime = await createAgentSessionRuntime(factory, {
      cwd: value.cwd,
      agentDir: value.agentDir,
      sessionManager: SessionManager.inMemory(value.cwd),
    });
    const errors: unknown[] = [];
    binding = runtime.session.bindExtensions({ onError: error => errors.push(error) });
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(indexing, false, "Discover must not compete with a later extension's startup work");
    release.resolve();
    await binding;
    await indexed.promise;
    assert.equal(resources, 1, "later lifecycle handlers still run after hook and observer failures");
    assert.equal(errors.length, 1);
    assert.match(JSON.stringify(errors), /expected startup failure/);
    assert.ok(observed >= 2, "diagnostic observers were exercised on the real dispatch path");
  } finally {
    release.resolve();
    await binding?.catch(() => {});
    await runtime?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousIndexPath === undefined) delete process.env.PI_DISCOVER_INDEX_PATH;
    else process.env.PI_DISCOVER_INDEX_PATH = previousIndexPath;
    await rm(value.root, { recursive: true, force: true });
  }
});

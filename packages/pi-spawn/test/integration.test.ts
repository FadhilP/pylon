import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runSpawn } from "../src/runner.ts";
import { createSpawnedSession } from "../src/sessions.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function persistParent(parent: SessionManager) {
  parent.appendMessage({
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

test("actual Pi RPC reopens and continues a materialized spawned session", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-spawn-rpc-"));
  const providerDir = await mkdtemp(join(tmpdir(), "pi-spawn-provider-"));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const extension = join(providerDir, "fake-provider.ts");
  await writeFile(
    extension,
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("pi-spawn-test", {
    baseUrl: "http://127.0.0.1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [{ id: "model", name: "Spawn Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const text = "users:" + context.messages.filter(message => message.role === "user").length;
        const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ${JSON.stringify(usage)}, stopReason: "pending", timestamp: Date.now() };
        stream.push({ type: "start", partial: output });
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
`,
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const parent = SessionManager.create(cwd);
    persistParent(parent);
    const child = createSpawnedSession(
      cwd,
      { id: parent.getSessionId(), file: parent.getSessionFile()! },
      "RPC child",
      {
        hooks: {
          sessionStart: { customType: "pylon-session-start-hook", content: "SESSION HOOK" },
          beforeAgentStart: "BEFORE HOOK",
        },
      },
    );
    const args = [
      "--mode",
      "rpc",
      "--session",
      child.info.path,
      "--no-extensions",
      "-e",
      extension,
      "-e",
      join(import.meta.dirname, "../extensions/pi-spawn.ts"),
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-tools",
      "--model",
      "pi-spawn-test/model",
    ];
    const env = { PI_CODING_AGENT_DIR: agentDir, PI_SPAWN_CHILD: "session" };
    const first = await runSpawn(args, { cwd, prompt: "first", env, timeoutMs: 30_000 });
    assert.equal(first.error, undefined);
    assert.equal(first.text, "users:2");
    assert.equal(first.model, "pi-spawn-test/model");
    assert.equal(first.thinking, "off");
    assert.doesNotThrow(() => SessionManager.open(child.info.path));

    const second = await runSpawn(args, { cwd, prompt: "second", env, timeoutMs: 30_000 });
    assert.equal(second.error, undefined);
    assert.equal(second.text, "users:3");
    const entries = SessionManager.open(child.info.path).getEntries();
    assert.equal(entries.filter(entry => entry.type === "message" && entry.message.role === "user").length, 2);
    assert.equal(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant").length, 2);
    assert.equal(entries.filter(entry => entry.type === "model_change").length, 1);
    assert.equal(
      entries.filter(entry => entry.type === "custom_message" && entry.customType === "pylon-session-start-hook")
        .length,
      1,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(providerDir, { recursive: true, force: true })]);
  }
});

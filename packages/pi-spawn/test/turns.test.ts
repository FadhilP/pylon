import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { childArgs } from "../src/turns.ts";
import { invalidInput } from "../src/validate.ts";
import type { AgentPolicy } from "../src/sessions.ts";

const mcpTools = [
  "mcp__allowed__echo",
  "mcp__other__echo",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

test(
  "private-agent allowlists restrict native MCP calls, including late registration and codemode",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-spawn-tools-"));
    const cwd = join(root, "project"),
      agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    try {
      for (const tools of [
        ["read", "codemode"],
        ["codemode", "read_mcp_resource"],
        ["codemode", "mcp__allowed__echo"],
        [],
        undefined,
      ]) {
        const calls: string[] = [];
        const args = childArgs("agent", join(root, "session.jsonl"), { tools } as AgentPolicy);
        const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1].split(",") : undefined);
        const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [
            createCodemodeExtension({ models: false }),
            pi => {
              pi.on("session_start", () => {
                for (const name of mcpTools)
                  pi.registerTool({
                    name,
                    label: name,
                    description: "Fixture MCP tool",
                    exposure: "codemode",
                    parameters: Type.Object({}),
                    async execute() {
                      calls.push(name);
                      return { content: [{ type: "text", text: name }], details: {} };
                    },
                  });
              });
            },
          ],
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime,
          model: faux.getModel(),
          settingsManager,
          resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
          tools: option("--tools"),
          excludeTools: option("--exclude-tools"),
          ...(args.includes("--no-tools") ? { noTools: "all" as const } : {}),
        });
        try {
          await session.bindExtensions({});
          const code = `const names = ${JSON.stringify(mcpTools)};
          return await Promise.allSettled(names.map(name => Promise.resolve().then(() => tools[name]({}))));`;
          faux.setResponses([
            fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
            fauxAssistantMessage([fauxText("done")]),
          ]);
          await session.prompt("Try the MCP tools");
          assert.deepEqual(calls.sort(), mcpTools.filter(name => tools === undefined || tools.includes(name)).sort());
          const result = session.messages.find(
            message => message.role === "toolResult" && message.toolName === "codemode",
          );
          assert.ok(result?.role === "toolResult");
          assert.equal(result.isError, tools?.length === 0);
        } finally {
          session.dispose();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("private-agent policies reject CLI patterns and list expansion on creation and continuation", () => {
  for (const name of ["*", "mcp__allowed__*", "read,bash"]) {
    assert.match(invalidInput("agent", { action: "create", prompt: "work", tools: [name] }) ?? "", /exact names/);
    assert.throws(() => childArgs("agent", "session.jsonl", { tools: [name] } as AgentPolicy), /exact names/);
  }
});

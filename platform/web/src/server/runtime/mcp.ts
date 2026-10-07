import { join } from "node:path";
import {
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionHandler,
  type InlineExtension,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { allowsIndirectTool, isMcpTool } from "pylon-core/src/tools.ts";
import { boundedSource } from "./codemode.ts";
import { McpSettingsManager } from "./mcp-settings.ts";

/** Pi 1.0.4 has no public exports for its file config/credential helpers.
 * Keep this pinned-layout bridge here rather than copy validation or mutate process.env.
 */
export async function createPylonMcpExtensions(agentDir: string): Promise<InlineExtension[]> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const [config, oauth, auth] = await Promise.all([
    import(new URL("./extensions/mcp/config.js", entry).href),
    import(new URL("./extensions/mcp/oauth.js", entry).href),
    import(new URL("./core/auth-storage.js", entry).href),
  ]);
  if (
    typeof config.loadMcpConfig !== "function" ||
    typeof oauth.McpOAuthCredentialStore !== "function" ||
    typeof auth.FileAuthStorageBackend !== "function" || typeof config.updateMcpServerConfig !== "function"
  ) {
    throw new Error("Installed Pi does not provide the MCP storage helpers required by Pylon Web");
  }
  return [
    {
      name: "pylon-mcp",
      replaceable: true,
      factory: pi => {
        const manager = new McpSettingsManager(agentDir, config, () => pi.getMcpServers());
        let sessionId: string | undefined;
        const unsubscribe = pi.events.on("pylon:mcp-management", (request: any) => {
          if (request?.version === 1 && request.sessionId === sessionId && typeof request.respond === "function")
            request.respond(manager);
        });
        pi.on("session_shutdown", () => { sessionId = undefined; manager.stop(); unsubscribe(); });
        const nativeApi: ExtensionAPI = Object.create(pi, {
          registerCommand: {
            value: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
              if (name === "mcp") manager.setCommand(async (args, ctx) => { await command.handler(args, ctx); });
              pi.registerCommand(name, command);
            },
          },
          registerTool: {
            value: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) =>
              pi.registerTool({
                ...tool,
                async execute(id, params, signal, onUpdate, ctx) {
                  signal?.throwIfAborted();
                  // Recheck after asynchronous tool_call approvals, not just during discovery.
                  const current = pi.getAllTools().find(candidate => candidate.name === tool.name);
                  const exposure = current?.exposure ?? "direct";
                  if (
                    !current ||
                    !["direct", "codemode", "deferred"].includes(exposure) ||
                    (exposure === "direct" && !pi.getActiveTools().includes(tool.name))
                  )
                    throw new Error("MCP tool is no longer callable");
                  if (!allowsIndirectTool(pi, tool.name)) throw new Error("Tool is disabled by Pylon policy");
                  return tool.execute(id, params, signal, onUpdate, ctx);
                },
              }),
          },
          on: {
            value: (...args: unknown[]) => {
              if (args[0] !== "tool_call") return Reflect.apply(pi.on, pi, args);
              const handler = args[1] as ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
              return pi.on("tool_call", async (event, ctx) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const source = (event.input as { code?: unknown }).code;
                  const timeoutMs =
                    event.toolName === "codemode" && typeof source === "string"
                      ? boundedSource(source).timeoutMs
                      : 60_000;
                  const deadline = new AbortController();
                  timer = setTimeout(() => deadline.abort(new Error("MCP connection wait timed out")), timeoutMs);
                  timer.unref();
                  const signal = AbortSignal.any([deadline.signal, ...(ctx.signal ? [ctx.signal] : [])]);
                  const result = await handler(event, Object.create(ctx, { signal: { value: signal } }));
                  signal.throwIfAborted();
                  return result;
                } catch (error) {
                  // Exceptions in extension hooks are diagnostics, not permission denials.
                  return { block: true, reason: error instanceof Error ? error.message : "MCP connection wait failed" };
                } finally {
                  clearTimeout(timer);
                }
              });
            },
          },
        });
        return createMcpExtension({
          loadConfig: ctx => {
            const loaded = config.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
            sessionId = ctx.sessionManager.getSessionId();
            manager.bind(ctx, loaded);
            return loaded;
          },
          credentials: new oauth.McpOAuthCredentialStore(
            new auth.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
            agentDir,
          ),
          logPath: join(agentDir, "mcp.log"),
        })(nativeApi);
      },
    },
    {
      name: "pylon-mcp-search",
      replaceable: true,
      factory: pi =>
        createToolSearchExtension()(
          Object.create(pi, {
            getAllTools: {
              value: () => pi.getAllTools().filter(tool => isMcpTool(tool.name) && allowsIndirectTool(pi, tool.name)),
            },
          }),
        ),
    },
  ];
}

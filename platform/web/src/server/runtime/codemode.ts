import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { allowsIndirectTool, isMcpTool } from "pylon-core/src/tools.ts";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_CALLS = 32;
// Workflow controls, tool activation and delegates stay outside scripts.
const SCRIPT_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
  "code_search",
  "symbol_search",
  "relationship_graph",
  "index_status",
]);

/** Clamp the two native first-line options; leave JavaScript parsing to Pi. */
export function boundedSource(source: string): { code: string; timeoutMs: number } {
  let options: Record<string, unknown> = {};
  const newline = source.indexOf("\n");
  const firstLine = (newline < 0 ? source : source.slice(0, newline)).trimStart();
  if (firstLine.startsWith("// @options:")) {
    const value: unknown = JSON.parse(firstLine.slice("// @options:".length));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("@options must be an object");
    options = value as Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) {
      if (!["timeout_ms", "max_output_tokens"].includes(key)) throw new Error(`Unsupported @options field: ${key}`);
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < (key === "timeout_ms" ? 1 : 0) ||
        (key === "timeout_ms" && (value as number) > 2_147_483_647)
      ) {
        throw new Error(`Invalid @options field: ${key}`);
      }
    }
    source = newline < 0 ? "" : source.slice(newline + 1);
  }
  if (!source.trim()) throw new Error("Expected non-empty JavaScript source");
  const timeoutMs = Math.min(TIMEOUT_MS, (options.timeout_ms as number | undefined) ?? TIMEOUT_MS);
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_TOKENS,
    (options.max_output_tokens as number | undefined) ?? MAX_OUTPUT_TOKENS,
  );
  return {
    code: `// @options: ${JSON.stringify({ timeout_ms: timeoutMs, max_output_tokens: maxOutputTokens })}\n${source}`,
    timeoutMs,
  };
}

export function createPylonCodemodeExtension(): ExtensionFactory {
  return pi => {
    const permitted = (name: string, exposure: string): boolean => {
      if (isMcpTool(name)) {
        return ["direct", "codemode", "deferred"].includes(exposure) && allowsIndirectTool(pi, name);
      }
      return SCRIPT_TOOLS.has(name) && exposure === "direct";
    };
    const eligible = (name: string): boolean => {
      const tool = pi.getAllTools().find(tool => tool.name === name);
      if (!tool) return false;
      const exposure = tool.exposure ?? "direct";
      return permitted(name, exposure) && (exposure !== "direct" || pi.getActiveTools().includes(name));
    };
    const nativeApi: ExtensionAPI = Object.create(pi, {
      registerTool: {
        value: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (tool.name !== "codemode") throw new Error("Unexpected native codemode registration");
          pi.registerTool({
            ...tool,
            prepareLoadout: loadout => {
              const changes = tool.prepareLoadout?.({
                ...loadout,
                callable: loadout.callable.filter(candidate =>
                  permitted(candidate.name, loadout.getExposure(candidate.name)),
                ),
              });
              if (changes?.descriptions?.codemode)
                changes.descriptions = {
                  ...changes.descriptions,
                  codemode: `${changes.descriptions.codemode}\n\nPylon Web: active direct coding/search tools and permitted MCP tools; no workflow controls or models. At most ${MAX_CALLS} calls, ${TIMEOUT_MS / 1_000}s execution, ${MAX_OUTPUT_TOKENS} output tokens. Lower first-line limits are respected. Completed side effects are not rolled back.`,
                };
              return changes;
            },
            execute: async (id, params, signal, onUpdate, ctx) => {
              const input = params as { code: string };
              const { code, timeoutMs } = boundedSource(input.code);
              const deadline = new AbortController();
              const timer = setTimeout(() => deadline.abort(new Error("Codemode deadline exceeded")), timeoutMs);
              timer.unref();
              const lifecycle = new AbortController();
              const boundedSignal = AbortSignal.any([deadline.signal, lifecycle.signal, ...(signal ? [signal] : [])]);
              let calls = 0,
                pending = 0,
                finished = false;
              // Native tool_call hooks see the turn signal, not the nested call's signal.
              // Keep the association until dispatches settle, so delayed Guard hooks cannot outlive the script.
              const publishScope = (active: boolean) =>
                pi.events.emit("pylon:codemode-scope", { version: 1, toolCallId: id, active, signal: boundedSignal });
              const context = Object.create(ctx, {
                tools: { value: ctx.tools.filter(candidate => eligible(candidate.name)) },
                signal: { value: boundedSignal },
                executeTool: {
                  value: async (name: string, args: unknown, options: Parameters<typeof ctx.executeTool>[2]) => {
                    boundedSignal.throwIfAborted();
                    if (++calls > MAX_CALLS) {
                      const error = new Error(`Codemode allows at most ${MAX_CALLS} nested calls per script`);
                      deadline.abort(error); // Stop caught-error retry loops as well as excess fan-out.
                      throw error;
                    }
                    if (!eligible(name)) throw new Error(`Tool "${name}" is not a permitted coding/search or MCP tool`);
                    pending++;
                    // The native sandbox also cancels unawaited calls on successful exit.
                    const cancelScope = () => lifecycle.abort(new Error("Codemode nested work cancelled"));
                    options?.signal?.addEventListener("abort", cancelScope, { once: true });
                    if (options?.signal?.aborted) cancelScope();
                    try {
                      return await ctx.executeTool(name, args, {
                        ...options,
                        signal: AbortSignal.any([boundedSignal, ...(options?.signal ? [options.signal] : [])]),
                      });
                    } finally {
                      options?.signal?.removeEventListener("abort", cancelScope);
                      pending--;
                      if (finished && pending === 0) publishScope(false);
                    }
                  },
                },
              });
              try {
                publishScope(true);
                return await tool.execute(id, { ...input, code }, boundedSignal, onUpdate, context);
              } finally {
                finished = true;
                lifecycle.abort(new Error("Codemode script ended"));
                if (pending === 0) publishScope(false);
                clearTimeout(timer);
              }
            },
          });
        },
      },
    });
    createCodemodeExtension({ mode: "on", models: false })(nativeApi);
  };
}

import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEventBus,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  type AgentSessionRuntimeDiagnostic,
  type EventBus,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { PromptPackageSettingValue } from "pylon-core/package-settings";
import { configPath, effectiveConfig, loadConfig } from "pylon-core/src/config.ts";
import { collectExtensionLoadTimings, type ExtensionLoadTiming } from "./pi-startup-timings.ts";
import { createPylonCodemodeExtension } from "./codemode.ts";
import { createPylonMcpExtensions } from "./mcp.ts";

export function createPylonModelRuntime(agentDir: string): Promise<ModelRuntime> {
  const fixedAgentDir = resolve(agentDir);
  return ModelRuntime.create({
    authPath: resolve(fixedAgentDir, "auth.json"),
    modelsPath: resolve(fixedAgentDir, "models.json"),
  });
}

export type StartupHookTiming = {
  extension: string;
  event: "session_start" | "resources_discover";
  durationMs: number;
};

export async function createPylonRuntimeFactory(options: {
  agentDir: string;
  additionalExtensionPaths?: string[];
  extensionFactories?: InlineExtension[];
  eventBus?: EventBus;
  modelRuntime?: ModelRuntime;
  mainPrompt?: PromptPackageSettingValue;
  onStartupPhase?: (phase: "extension-loading" | "session-create", durationMs: number) => void;
  onStartupHook?: (timing: StartupHookTiming) => void;
  onExtensionLoadTimings?: (timings: ExtensionLoadTiming[]) => void;
}): Promise<CreateAgentSessionRuntimeFactory> {
  const eventBus = options.eventBus ?? createEventBus();
  const fixedAgentDir = resolve(options.agentDir);
  const modelRuntime = options.modelRuntime ?? (await createPylonModelRuntime(fixedAgentDir));
  const timedHandlers = new WeakSet<Function>();
  const mcpExtensions = await createPylonMcpExtensions(fixedAgentDir);

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    if (resolve(agentDir) !== fixedAgentDir) {
      throw new Error("runtime replacement cannot change the configured agent directory");
    }
    // Do not let Pi infer trust from its default agent directory. Pylon owns
    // the configured trust store and deliberately starts untrusted projects
    // with project resources disabled; user resources still remain available.
    const trustStore = new ProjectTrustStore(fixedAgentDir);
    const projectTrusted = !hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
    const settingsManager = SettingsManager.create(cwd, fixedAgentDir, { projectTrusted });
    const coreConfig = effectiveConfig(await loadConfig(configPath(fixedAgentDir)));
    const extensionLoadingStartedAt = performance.now();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
        eventBus,
        extensionFactories: [
          ...(coreConfig.codemodeEnabled ? [{ name: "pylon-codemode", factory: createPylonCodemodeExtension() }] : []),
          ...mcpExtensions,
          ...(options.extensionFactories ?? []),
        ],
        extensionsOverride: loaded => {
          // The Web opt-in and policy must not be bypassed by a resource-loaded copy.
          for (const extension of loaded.extensions) {
            if (extension.tools.has("codemode") && extension.path !== "<inline:pylon-codemode>") {
              extension.tools.delete("codemode");
              loaded.errors.push({
                path: extension.path,
                error: "Pylon Web reserves codemode; enable Web codemode in pylon-core settings instead.",
              });
            }
          }
          if (!options.onStartupHook) return loaded;
          for (const extension of loaded.extensions) {
            for (const event of ["session_start", "resources_discover"] as const) {
              const handlers = extension.handlers.get(event);
              if (!handlers) continue;
              extension.handlers.set(
                event,
                handlers.map(handler => {
                  if (timedHandlers.has(handler)) return handler;
                  const timed: typeof handler = async (value, ctx) => {
                    const startedAt = performance.now();
                    try {
                      return await handler(value, ctx);
                    } finally {
                      try {
                        options.onStartupHook?.({
                          extension: basename(extension.path),
                          event,
                          durationMs: performance.now() - startedAt,
                        });
                      } catch {
                        // Diagnostic observers must not change extension results or error handling.
                      }
                    }
                  };
                  timedHandlers.add(timed);
                  return timed;
                }),
              );
            }
          }
          return loaded;
        },
        ...(options.mainPrompt?.mode === "replace" ? { systemPromptOverride: () => options.mainPrompt!.text } : {}),
        ...(options.mainPrompt?.mode === "append" && options.mainPrompt.text
          ? { appendSystemPromptOverride: (base: string[]) => [...base, options.mainPrompt!.text] }
          : {}),
      },
    });
    // Resource discovery reloads Pi settings, so apply the opt-in afterward.
    if (coreConfig.codemodeEnabled) {
      services.settingsManager.applyOverrides({
        defaultTools: [...(services.settingsManager.getSettings().defaultTools ?? []), "+codemode"],
      });
    }
    options.onStartupPhase?.("extension-loading", performance.now() - extensionLoadingStartedAt);
    if (options.onExtensionLoadTimings) {
      const timings = await collectExtensionLoadTimings();
      try {
        options.onExtensionLoadTimings(timings);
      } catch {
        // Diagnostic observers must not change startup behavior.
      }
    }
    const mainAgentModel = coreConfig.mainAgentModel;
    if (mainAgentModel) {
      const slash = mainAgentModel.indexOf("/");
      if (slash > 0 && slash < mainAgentModel.length - 1) {
        services.settingsManager.applyOverrides({
          defaultProvider: mainAgentModel.slice(0, slash),
          defaultModel: mainAgentModel.slice(slash + 1),
        });
      }
    }
    const sessionCreateStartedAt = performance.now();
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    options.onStartupPhase?.("session-create", performance.now() - sessionCreateStartedAt);
    const extensionDiagnostics: AgentSessionRuntimeDiagnostic[] = services.resourceLoader
      .getExtensions()
      .errors.map(({ path }) => ({ type: "error" as const, message: `Extension ${basename(path)} failed to load` }));
    return { ...created, services, diagnostics: [...services.diagnostics, ...extensionDiagnostics] };
  };
}

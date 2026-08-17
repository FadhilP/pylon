import { basename, resolve } from "node:path";
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

export function createPylonModelRuntime(agentDir: string): Promise<ModelRuntime> {
  const fixedAgentDir = resolve(agentDir);
  return ModelRuntime.create({
    authPath: resolve(fixedAgentDir, "auth.json"),
    modelsPath: resolve(fixedAgentDir, "models.json"),
  });
}

export async function createPylonRuntimeFactory(options: {
  agentDir: string;
  additionalExtensionPaths?: string[];
  extensionFactories?: InlineExtension[];
  eventBus?: EventBus;
  modelRuntime?: ModelRuntime;
}): Promise<CreateAgentSessionRuntimeFactory> {
  const eventBus = options.eventBus ?? createEventBus();
  const fixedAgentDir = resolve(options.agentDir);
  const modelRuntime = options.modelRuntime ?? await createPylonModelRuntime(fixedAgentDir);

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
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
        eventBus,
        extensionFactories: options.extensionFactories,
      },
    });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    const extensionDiagnostics: AgentSessionRuntimeDiagnostic[] = services.resourceLoader
      .getExtensions()
      .errors
      .map(({ path }) => ({
        type: "error" as const,
        message: `Extension ${basename(path)} failed to load`,
      }));
    return {
      ...created,
      services,
      diagnostics: [...services.diagnostics, ...extensionDiagnostics],
    };
  };
}

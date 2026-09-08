import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  type LoadExtensionsResult,
  type LoadSkillsResult,
  type PackageSource,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type {
  ExtensionListSnapshot,
  NativeExtensionReadModel,
  SkillListSnapshot,
  SkillReadModel,
} from "../../shared/protocol/snapshots.ts";

type ExtensionScope = "user" | "project";

const NPM_SOURCE = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s]+)?$/i;
const GIT_SOURCE = /^(?:git:(?:[^\s]+)|(?:https?|ssh|git):\/\/[^\s]+)$/i;

export function validPiPackageSource(source: string): boolean {
  return source.length > 0 && source.length <= 500 && (NPM_SOURCE.test(source) || GIT_SOURCE.test(source));
}

export function isPylonPackageSource(source: string): boolean {
  const value = source.toLowerCase();
  return (
    /^npm:@fadhilp\/pylon(?:@|$)/.test(value) ||
    /^(?:git:)?(?:https?:\/\/|ssh:\/\/git@|git@)?github\.com[/:]fadhilp\/pylon(?:\.git)?(?:@|#|$)/.test(value)
  );
}

function opaqueId(scope: string, path: string): string {
  return createHash("sha256")
    .update(`${scope}\0${resolve(path)}`)
    .digest("hex")
    .slice(0, 32);
}

function scopeSettings(
  settings: SettingsManager,
  scope: ExtensionScope,
): { extensions: string[]; packages: PackageSource[] } {
  const value = scope === "user" ? settings.getGlobalSettings() : settings.getProjectSettings();
  return { extensions: [...(value.extensions ?? [])], packages: structuredClone(value.packages ?? []) };
}

function relativeDisplayPath(path: string, baseDir?: string): string {
  if (!baseDir) return basename(path);
  const value = relative(baseDir, path).replaceAll("\\", "/");
  return value && !value.startsWith("../") && !isAbsolute(value) ? value : basename(path);
}

function displayPath(resource: ResolvedResource): string {
  return relativeDisplayPath(resource.path, resource.metadata.baseDir);
}

function exactResourcePath(resource: ResolvedResource): string {
  const base = resource.metadata.baseDir;
  if (!base) throw new Error("extension cannot be configured because Pi did not report its base directory");
  const value = relative(base, resource.path).replaceAll("\\", "/");
  if (!value || value.startsWith("../") || isAbsolute(value))
    throw new Error("extension path is outside its configured scope");
  return value;
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function displaySource(source: string): string {
  return isAbsolute(source) || source.startsWith("./") || source.startsWith("../") ? "local" : source.slice(0, 500);
}

function withExactOverride(entries: string[] | undefined, path: string, enabled: boolean): string[] {
  const retained = [...(entries ?? [])].filter(entry => entry !== `+${path}` && entry !== `-${path}`);
  retained.push(`${enabled ? "+" : "-"}${path}`);
  return retained;
}

export class PiExtensionManager {
  readonly settings: SettingsManager;
  readonly excludedPaths: ReadonlySet<string>;
  private readonly packages: DefaultPackageManager;
  private readonly trustStore: ProjectTrustStore;

  constructor(
    readonly cwd: string,
    readonly agentDir: string,
    settings?: SettingsManager,
    excludedPaths: string[] = [],
  ) {
    this.trustStore = new ProjectTrustStore(agentDir);
    this.settings = settings ?? SettingsManager.create(cwd, agentDir, { projectTrusted: this.projectTrusted() });
    this.packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: this.settings });
    this.excludedPaths = new Set(excludedPaths.map(path => resolve(path)));
  }

  projectTrustRequired(): boolean {
    return hasTrustRequiringProjectResources(this.cwd);
  }

  projectTrusted(): boolean {
    return !this.projectTrustRequired() || this.trustStore.get(this.cwd) === true;
  }

  setProjectTrusted(trusted: boolean): void {
    this.trustStore.set(this.cwd, trusted);
  }

  async list(runtime: LoadExtensionsResult | undefined, generation: number): Promise<ExtensionListSnapshot> {
    const resolved = await this.packages.resolve(async () => "skip");
    const active = new Set((runtime?.extensions ?? []).map(extension => resolve(extension.resolvedPath)));
    const errors = new Map((runtime?.errors ?? []).map(error => [resolve(error.path), error.error.slice(0, 500)]));
    const visibleResources = resolved.extensions.filter(resource => !this.excluded(resource));
    const extensions: NativeExtensionReadModel[] = visibleResources.map(resource => {
      const scope = resource.metadata.scope === "project" ? "project" : "user";
      const path = resolve(resource.path);
      return {
        id: opaqueId(scope, path),
        scope,
        path: displayPath(resource).slice(0, 500),
        source: displaySource(resource.metadata.source),
        origin: resource.metadata.origin,
        enabled: resource.enabled,
        active: active.has(path),
        ...(errors.get(path) ? { loadError: errors.get(path) } : {}),
      };
    });
    extensions.sort((left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: generation,
      projectTrustRequired: this.projectTrustRequired(),
      projectTrusted: this.projectTrusted(),
      packages: this.packages
        .listConfiguredPackages()
        .filter(({ source }) => validPiPackageSource(source) && !isPylonPackageSource(source))
        .map(({ source, scope }) => ({ source, scope })),
      extensions,
    };
  }

  listSkills(runtime: LoadSkillsResult, generation: number): SkillListSnapshot {
    const skills: SkillReadModel[] = runtime.skills.map(skill => ({
      id: opaqueId(skill.sourceInfo.scope, skill.filePath),
      name: skill.name.slice(0, 200),
      description: skill.description.slice(0, 2_000),
      scope: skill.sourceInfo.scope,
      path: relativeDisplayPath(skill.filePath, skill.sourceInfo.baseDir).slice(0, 500),
      source: (displaySource(skill.sourceInfo.source) || "local").slice(0, 500),
      origin: skill.sourceInfo.origin,
      manualOnly: skill.disableModelInvocation,
    }));
    skills.sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionGeneration: generation,
      projectTrustRequired: this.projectTrustRequired(),
      projectTrusted: this.projectTrusted(),
      skills,
      diagnostics: runtime.diagnostics.slice(0, 200).map(diagnostic => {
        let message = diagnostic.message;
        for (const path of [diagnostic.path, diagnostic.collision?.winnerPath, diagnostic.collision?.loserPath]) {
          if (path) message = message.replaceAll(path, basename(path));
        }
        return {
          type: diagnostic.type,
          message: message.slice(0, 1_000),
          ...(diagnostic.path ? { path: basename(diagnostic.path).slice(0, 500) } : {}),
        };
      }),
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const resolved = await this.packages.resolve(async () => "skip");
    const resource = resolved.extensions
      .filter(entry => !this.excluded(entry))
      .find(entry => {
        const scope = entry.metadata.scope === "project" ? "project" : "user";
        return opaqueId(scope, entry.path) === id;
      });
    if (!resource) throw new Error("extension is unavailable");
    const scope: ExtensionScope = resource.metadata.scope === "project" ? "project" : "user";
    this.assertTrusted(scope);
    const exact = exactResourcePath(resource);
    if (resource.metadata.origin === "package") {
      const current = scopeSettings(this.settings, scope).packages;
      const index = current.findIndex(entry => packageSource(entry) === resource.metadata.source);
      if (index < 0) throw new Error("extension package is unavailable");
      const entry = current[index]!;
      current[index] = {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: withExactOverride(typeof entry === "string" ? undefined : entry.extensions, exact, enabled),
      };
      if (scope === "user") this.settings.setPackages(current);
      else this.settings.setProjectPackages(current);
    } else {
      const current = scopeSettings(this.settings, scope).extensions;
      const next = withExactOverride(current, exact, enabled);
      if (scope === "user") this.settings.setExtensionPaths(next);
      else this.settings.setProjectExtensionPaths(next);
    }
    await this.settings.flush();
  }

  async install(source: string, scope: ExtensionScope): Promise<void> {
    this.assertPackageMutation(source, scope);
    await this.packages.installAndPersist(source, { local: scope === "project" });
    await this.settings.flush();
  }

  async remove(source: string, scope: ExtensionScope): Promise<void> {
    this.assertPackageMutation(source, scope);
    const removed = await this.packages.removeAndPersist(source, { local: scope === "project" });
    await this.settings.flush();
    if (!removed) throw new Error("extension package is not configured in that scope");
  }

  private excluded(resource: ResolvedResource): boolean {
    return this.excludedPaths.has(resolve(resource.path)) || isPylonPackageSource(resource.metadata.source);
  }

  private assertPackageMutation(source: string, scope: ExtensionScope): void {
    this.assertTrusted(scope);
    if (!validPiPackageSource(source)) throw new Error("unsupported extension package source");
  }

  private assertTrusted(scope: ExtensionScope): void {
    if (scope === "project" && !this.projectTrusted()) throw new Error("project extensions require a trusted project");
  }
}

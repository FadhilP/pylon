import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PackageSettingsReadModel } from "../../shared/protocol/snapshots.ts";
import { validPackageSettings } from "../../shared/protocol/validation.ts";

interface PiManifest {
  name?: unknown;
  description?: unknown;
  pi?: { extensions?: unknown };
  pylon?: { settings?: unknown };
}

interface PackageConfig {
  version: 1;
  enabled: string[];
}

export interface PackageDefinition {
  id: string;
  name: string;
  description: string;
  extensionPaths: string[];
  settingsPath?: string;
}

export interface PackageCatalogState {
  packages: PackageDefinition[];
  enabledIds: Set<string>;
  extensionPaths: string[];
}

const PACKAGE_ID = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const MAX_ID_LENGTH = 128;

interface PackageSettingsAdapter {
  readSettings(context: { agentDir: string }): Promise<unknown>;
  updateSettings(value: unknown, context: { agentDir: string }): Promise<void>;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function extensionPaths(base: string, value: unknown, confined: boolean): Promise<string[] | undefined> {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 500)) {
    return undefined;
  }
  const realBase = await realpath(base);
  const paths: string[] = [];
  for (const item of value as string[]) {
    const candidate = await realpath(isAbsolute(item) ? item : resolve(base, item)).catch(() => undefined);
    if (!candidate || confined && !inside(realBase, candidate)) return undefined;
    if (!(await stat(candidate)).isFile()) return undefined;
    paths.push(candidate);
  }
  return paths;
}

async function confinedFile(base: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !value || value.length > 500) return undefined;
  const [realBase, candidate] = await Promise.all([
    realpath(base),
    realpath(isAbsolute(value) ? value : resolve(base, value)).catch(() => undefined),
  ]);
  if (!candidate || !inside(realBase, candidate) || !(await stat(candidate)).isFile()) return undefined;
  return candidate;
}

async function readManifest(path: string): Promise<PiManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as PiManifest : undefined;
  } catch {
    return undefined;
  }
}

export class PackageCatalog {
  private readonly packagesRoot: string;
  private readonly configPath: string;
  private readonly adapters = new Map<string, Promise<PackageSettingsAdapter>>();

  constructor(private readonly repositoryRoot: string, private readonly agentDir: string) {
    this.packagesRoot = resolve(repositoryRoot, "packages");
    this.configPath = resolve(agentDir, "pylon-web", "packages.json");
  }

  async scan(): Promise<PackageCatalogState> {
    const packages = await this.discoverPackages();
    const rootPaths = await this.rootExtensionPaths();
    const packagePaths = new Set(packages.flatMap((item) => item.extensionPaths));
    const defaultIds = packages
      .filter((item) => item.extensionPaths.some((path) => rootPaths.includes(path)))
      .map((item) => item.id);
    const enabledIds = await this.readEnabled(defaultIds);
    return {
      packages,
      enabledIds,
      extensionPaths: [
        ...rootPaths.filter((path) => !packagePaths.has(path)),
        ...packages.filter((item) => enabledIds.has(item.id)).flatMap((item) => item.extensionPaths),
      ],
    };
  }

  async setEnabled(packageId: string, enabled: boolean): Promise<PackageCatalogState> {
    const current = await this.scan();
    if (!current.packages.some((item) => item.id === packageId)) throw new Error("package is unavailable");
    const enabledIds = new Set(current.enabledIds);
    if (enabled) enabledIds.add(packageId);
    else enabledIds.delete(packageId);
    await this.writeEnabled(enabledIds);
    return this.scan();
  }

  async restoreEnabled(enabledIds: Set<string>): Promise<void> {
    await this.writeEnabled(enabledIds);
  }

  async readSettings(packageId: string, state?: PackageCatalogState): Promise<PackageSettingsReadModel | undefined> {
    const definition = (state ?? await this.scan()).packages.find((item) => item.id === packageId);
    if (!definition?.settingsPath) return undefined;
    const value = await (await this.adapter(definition.settingsPath)).readSettings({ agentDir: this.agentDir });
    if (!validPackageSettings(value)) throw new Error(`${packageId} returned invalid settings`);
    return value;
  }

  async updateSettings(packageId: string, value: PackageSettingsReadModel): Promise<PackageSettingsReadModel> {
    const definition = (await this.scan()).packages.find((item) => item.id === packageId);
    if (!definition?.settingsPath) throw new Error("package has no configurable settings");
    const adapter = await this.adapter(definition.settingsPath);
    const context = { agentDir: this.agentDir };
    const previous = await adapter.readSettings(context);
    if (!validPackageSettings(previous)) throw new Error(`${packageId} returned invalid settings`);
    await adapter.updateSettings(value, context);
    const updated = await adapter.readSettings(context);
    if (!validPackageSettings(updated)) {
      await adapter.updateSettings(previous, context).catch(() => undefined);
      throw new Error(`${packageId} saved invalid settings`);
    }
    return previous;
  }

  private async discoverPackages(): Promise<PackageDefinition[]> {
    const entries = await readdir(this.packagesRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const packages: PackageDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageRoot = resolve(this.packagesRoot, entry.name);
      const manifest = await readManifest(resolve(packageRoot, "package.json"));
      if (!manifest) continue;
      const id = manifest?.name;
      if (typeof id !== "string" || id.length > MAX_ID_LENGTH || !PACKAGE_ID.test(id)) continue;
      const paths = await extensionPaths(packageRoot, manifest.pi?.extensions, true).catch(() => undefined);
      if (!paths) continue;
      packages.push({
        id,
        name: id,
        description: typeof manifest.description === "string" ? manifest.description.slice(0, 500) : "",
        extensionPaths: paths,
        settingsPath: await confinedFile(packageRoot, manifest.pylon?.settings).catch(() => undefined),
      });
    }
    return packages.sort((left, right) => left.name.localeCompare(right.name));
  }

  private adapter(path: string): Promise<PackageSettingsAdapter> {
    let adapter = this.adapters.get(path);
    if (adapter) return adapter;
    adapter = import(pathToFileURL(path).href).then((module: Record<string, unknown>) => {
      if (typeof module.readSettings !== "function" || typeof module.updateSettings !== "function") {
        throw new Error("package settings adapter is invalid");
      }
      return module as unknown as PackageSettingsAdapter;
    });
    this.adapters.set(path, adapter);
    return adapter;
  }

  private async rootExtensionPaths(): Promise<string[]> {
    const manifest = await readManifest(resolve(this.repositoryRoot, "package.json"));
    return await extensionPaths(this.repositoryRoot, manifest?.pi?.extensions, false).catch(() => undefined) ?? [];
  }

  private async readEnabled(defaultIds: string[]): Promise<Set<string>> {
    try {
      const value = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<PackageConfig>;
      if (value.version !== 1 || !Array.isArray(value.enabled)) return new Set();
      return new Set(value.enabled.filter((item): item is string =>
        typeof item === "string" && item.length <= MAX_ID_LENGTH && PACKAGE_ID.test(item)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(defaultIds);
      return new Set();
    }
  }

  private async writeEnabled(enabledIds: Set<string>): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, enabled: [...enabledIds].sort() } satisfies PackageConfig, null, 2)}\n`;
    await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tempPath, this.configPath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

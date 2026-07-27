import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const VERSION = 2;
const MAX_PROJECTS = 100;
const MAX_ARCHIVED_SESSIONS = 10_000;

export interface RegisteredProject {
  id: string;
  cwd: string;
  label: string;
  archivedAt?: string;
}

export interface ArchivedSessionRecord {
  id: string;
  archivedAt: string;
}

export function projectIdForCwd(cwd: string): string {
  if (!cwd) return "project-legacy";
  let canonical = resolve(cwd);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // Deleted session workspaces keep a stable fallback identity.
  }
  const normalized = canonical.replaceAll("\\", "/");
  const identity = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `project-${createHash("sha256").update(identity).digest("base64url").slice(0, 22)}`;
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) throw new Error("selected project is not a directory");
  return canonical;
}

export class ProjectRegistry {
  private projects: RegisteredProject[] = [];
  private archivedSessions: ArchivedSessionRecord[] = [];
  private loaded = false;

  constructor(private readonly configPath: string) {}

  static forAgentDir(agentDir: string): ProjectRegistry {
    return new ProjectRegistry(resolve(agentDir, "pylon-web", "projects.json"));
  }

  async load(seedDirectories: string[] | (() => Promise<string[]>) = []): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("invalid project registry");
      const value = parsed as { version?: unknown; directories?: unknown; projects?: unknown; archivedSessions?: unknown };
      if (value.version === 1 && Array.isArray(value.directories)) {
        const directories = value.directories.filter((item): item is string =>
          typeof item === "string" && item.length > 0 && item.length <= 4_096);
        this.projects = await this.resolveProjects(directories.map((directory) => ({ directory })));
        this.loaded = true;
        await this.save();
        return;
      }
      if (value.version !== VERSION || !Array.isArray(value.projects) || !Array.isArray(value.archivedSessions)) {
        throw new Error("invalid project registry");
      }
      const projects = value.projects.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as { directory?: unknown; archivedAt?: unknown };
        if (typeof record.directory !== "string" || !record.directory || record.directory.length > 4_096) return [];
        if (record.archivedAt !== undefined && (typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt)))) return [];
        return [{ directory: record.directory, ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}) }];
      });
      this.projects = await this.resolveProjects(projects);
      this.archivedSessions = value.archivedSessions.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as { id?: unknown; archivedAt?: unknown };
        if (typeof record.id !== "string" || !record.id || record.id.length > 128
          || typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt))) return [];
        return [{ id: record.id, archivedAt: record.archivedAt }];
      }).slice(0, MAX_ARCHIVED_SESSIONS);
      this.loaded = true;
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    const seeds = typeof seedDirectories === "function" ? await seedDirectories() : seedDirectories;
    this.projects = await this.resolveProjects(seeds.map((directory) => ({ directory })));
    this.loaded = true;
    await this.save();
  }

  list(): RegisteredProject[] {
    this.assertLoaded();
    return this.projects.filter((project) => !project.archivedAt).map((project) => ({ ...project }));
  }

  listArchived(): RegisteredProject[] {
    this.assertLoaded();
    return this.projects.filter((project) => project.archivedAt).map((project) => ({ ...project }));
  }

  get(projectId: string): RegisteredProject | undefined {
    this.assertLoaded();
    const project = this.projects.find((item) => item.id === projectId);
    return project ? { ...project } : undefined;
  }

  async add(path: string): Promise<RegisteredProject> {
    this.assertLoaded();
    const cwd = await canonicalDirectory(path);
    const id = projectIdForCwd(cwd);
    const existing = this.projects.find((project) => project.id === id);
    if (existing?.archivedAt) throw new Error("project is archived; restore it from Archived");
    if (existing) return { ...existing };
    if (this.projects.length >= MAX_PROJECTS) throw new Error("project registry is full");
    const project = { id, cwd, label: basename(cwd) || cwd };
    this.projects.push(project);
    await this.save();
    return { ...project };
  }

  async remove(projectId: string, sessionIds: string[] = []): Promise<void> {
    this.assertLoaded();
    if (!this.projects.some((project) => project.id === projectId)) throw new Error("project is unavailable");
    this.projects = this.projects.filter((project) => project.id !== projectId);
    const removedSessions = new Set(sessionIds);
    this.archivedSessions = this.archivedSessions.filter((session) => !removedSessions.has(session.id));
    await this.save();
  }

  async archiveProject(projectId: string): Promise<void> {
    const project = this.requireProject(projectId);
    if (project.archivedAt) return;
    project.archivedAt = new Date().toISOString();
    await this.save();
  }

  async restoreProject(projectId: string): Promise<void> {
    const project = this.requireProject(projectId);
    if (!project.archivedAt) return;
    delete project.archivedAt;
    await this.save();
  }

  isSessionArchived(sessionId: string): boolean {
    this.assertLoaded();
    return this.archivedSessions.some((session) => session.id === sessionId);
  }

  listArchivedSessions(): ArchivedSessionRecord[] {
    this.assertLoaded();
    return this.archivedSessions.map((session) => ({ ...session }));
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.assertLoaded();
    if (this.isSessionArchived(sessionId)) return;
    if (this.archivedSessions.length >= MAX_ARCHIVED_SESSIONS) throw new Error("session archive is full");
    this.archivedSessions.push({ id: sessionId, archivedAt: new Date().toISOString() });
    await this.save();
  }

  async restoreSession(sessionId: string): Promise<void> {
    this.assertLoaded();
    if (!this.isSessionArchived(sessionId)) return;
    this.archivedSessions = this.archivedSessions.filter((session) => session.id !== sessionId);
    await this.save();
  }

  private async resolveProjects(records: Array<{ directory: string; archivedAt?: string }>): Promise<RegisteredProject[]> {
    const projects: RegisteredProject[] = [];
    for (const record of records.slice(0, MAX_PROJECTS)) {
      try {
        const cwd = await canonicalDirectory(record.directory);
        const id = projectIdForCwd(cwd);
        if (!projects.some((project) => project.id === id)) {
          projects.push({ id, cwd, label: basename(cwd) || cwd, ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}) });
        }
      } catch {
        // Missing directories remain absent until explicitly added again.
      }
    }
    return projects;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      version: VERSION,
      projects: this.projects.map((project) => ({
        directory: project.cwd,
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
      })),
      archivedSessions: this.archivedSessions,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.configPath);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("project registry is not loaded");
  }

  private requireProject(projectId: string): RegisteredProject {
    this.assertLoaded();
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("project is unavailable");
    return project;
  }
}

export interface ProjectPickerCommand {
  command: string;
  args: string[];
}

function runPicker(command: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5 * 60_000, windowsHide: true, maxBuffer: 16 * 1024, signal }, (error, stdout, stderr) => {
      const selected = String(stdout).trim();
      if (!error) {
        resolve(selected || undefined);
        return;
      }
      if (signal?.aborted || error.name === "AbortError") {
        reject(new Error("directory picker was closed"));
        return;
      }
      const code = (error as { code?: unknown }).code;
      if (!selected && (code === 1 || code === "ENOENT")) {
        if (code === "ENOENT") reject(new Error("native directory picker is unavailable"));
        else resolve(undefined);
        return;
      }
      reject(new Error(String(stderr || error.message).trim().slice(0, 500) || "directory picker failed"));
    });
  });
}

export function projectPickerCommand(platform = process.platform): ProjectPickerCommand {
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.ShowInTaskbar = $false",
      "$owner.TopMost = $true",
      "$owner.Opacity = 0",
      "$owner.StartPosition = 'CenterScreen'",
      "$owner.Show()",
      "$owner.Activate()",
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      "$dialog.Title = 'Choose a project folder'",
      "$dialog.AutoUpgradeEnabled = $true",
      "$dialog.CheckFileExists = $false",
      "$dialog.CheckPathExists = $true",
      "$dialog.ValidateNames = $false",
      "$dialog.FileName = 'Select this folder'",
      "$result = $dialog.ShowDialog($owner)",
      "$owner.Close()",
      "$owner.Dispose()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([System.IO.Path]::GetDirectoryName($dialog.FileName)) }",
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-Sta", "-Command", script] };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", "POSIX path of (choose folder with prompt \"Choose a project folder\")"] };
  }
  if (platform === "linux") {
    return { command: "zenity", args: ["--file-selection", "--directory", "--title=Choose a project folder"] };
  }
  throw new Error("native directory picker is unavailable on this platform");
}

export function pickProjectDirectory(platform = process.platform, signal?: AbortSignal): Promise<string | undefined> {
  const picker = projectPickerCommand(platform);
  return runPicker(picker.command, picker.args, signal);
}

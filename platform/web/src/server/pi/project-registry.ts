import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const VERSION = 4;
const MAX_PROJECTS = 100;
const MAX_ARCHIVED_SESSIONS = 10_000;

export interface RegisteredProject {
  id: string;
  cwd: string;
  label: string;
  archivedAt?: string;
  setupCommand?: string;
}

export interface SessionWorkspaceRecord {
  sessionId: string;
  projectId: string;
  mode: "checkout" | "worktree";
  worktreePath?: string;
  commonDir?: string;
  branch?: string;
  baseline?: string;
  baselineTree?: string;
  parkedRoot?: string;
  parkedCommonDir?: string;
  parkedHead?: string;
  parkedHeadRef?: string;
  parkedIndexTree?: string;
  parkedWorktreeTree?: string;
}

export interface HandoffJournal {
  version: 1;
  sessionId: string;
  projectId: string;
  workspace: SessionWorkspaceRecord;
  projectState: {
    root: string;
    commonDir: string;
    head?: string;
    headRef?: string;
    indexTree: string;
    worktreeTree: string;
  };
  sessionState: HandoffJournal["projectState"];
}

export interface ProvisionJournal {
  version: 1;
  projectId: string;
  worktreePath: string;
  commonDir: string;
  branch: string;
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
  private sessionWorkspaces: SessionWorkspaceRecord[] = [];
  private activeSessionOrder: string[] = [];
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
      const value = parsed as { version?: unknown; directories?: unknown; projects?: unknown; archivedSessions?: unknown; sessionWorkspaces?: unknown; activeSessionOrder?: unknown };
      if (value.version === 1 && Array.isArray(value.directories)) {
        const directories = value.directories.filter((item): item is string =>
          typeof item === "string" && item.length > 0 && item.length <= 4_096);
        this.projects = await this.resolveProjects(directories.map((directory) => ({ directory })));
        this.loaded = true;
        await this.save();
        return;
      }
      if (![2, 3, VERSION].includes(Number(value.version)) || !Array.isArray(value.projects) || !Array.isArray(value.archivedSessions)) {
        throw new Error("invalid project registry");
      }
      const projects = value.projects.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as { directory?: unknown; archivedAt?: unknown; setupCommand?: unknown };
        if (typeof record.directory !== "string" || !record.directory || record.directory.length > 4_096) return [];
        if (record.archivedAt !== undefined && (typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt)))) return [];
        if (record.setupCommand !== undefined && (typeof record.setupCommand !== "string" || record.setupCommand.length > 2_000)) return [];
        return [{
          directory: record.directory,
          ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
          ...(record.setupCommand ? { setupCommand: record.setupCommand } : {}),
        }];
      });
      this.projects = await this.resolveProjects(projects);
      this.archivedSessions = value.archivedSessions.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as { id?: unknown; archivedAt?: unknown };
        if (typeof record.id !== "string" || !record.id || record.id.length > 128
          || typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt))) return [];
        return [{ id: record.id, archivedAt: record.archivedAt }];
      }).slice(0, MAX_ARCHIVED_SESSIONS);
      this.sessionWorkspaces = Array.isArray(value.sessionWorkspaces)
        ? value.sessionWorkspaces.flatMap((item) => this.parseSessionWorkspace(item)).slice(0, MAX_ARCHIVED_SESSIONS)
        : [];
      this.activeSessionOrder = Array.isArray(value.activeSessionOrder)
        ? value.activeSessionOrder.filter((item): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 128)
            .slice(0, MAX_ARCHIVED_SESSIONS)
        : [];
      this.loaded = true;
      if (value.version !== VERSION) await this.save();
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
    this.sessionWorkspaces = this.sessionWorkspaces.filter((workspace) => workspace.projectId !== projectId);
    const removedSessions = new Set(sessionIds);
    this.archivedSessions = this.archivedSessions.filter((session) => !removedSessions.has(session.id));
    this.activeSessionOrder = this.activeSessionOrder.filter((sessionId) => !removedSessions.has(sessionId));
    await this.save();
  }

  async reorderProject(projectId: string, beforeProjectId?: string): Promise<void> {
    this.assertLoaded();
    const visible = this.projects.filter((project) => !project.archivedAt);
    const index = visible.findIndex((project) => project.id === projectId);
    if (index < 0) throw new Error("project is unavailable");
    if (beforeProjectId === projectId) return;
    const [project] = visible.splice(index, 1);
    const before = beforeProjectId
      ? visible.findIndex((candidate) => candidate.id === beforeProjectId)
      : -1;
    if (beforeProjectId && before < 0) {
      throw new Error("project reorder target is unavailable");
    }
    if (before >= 0) visible.splice(before, 0, project);
    else visible.push(project);
    let visibleIndex = 0;
    this.projects = this.projects.map((candidate) =>
      candidate.archivedAt ? candidate : visible[visibleIndex++]!);
    await this.save();
  }

  listActiveSessionOrder(): string[] {
    this.assertLoaded();
    return [...this.activeSessionOrder];
  }

  async activateSession(sessionId: string): Promise<void> {
    this.assertLoaded();
    this.activeSessionOrder = [sessionId, ...this.activeSessionOrder.filter((id) => id !== sessionId)]
      .slice(0, MAX_ARCHIVED_SESSIONS);
    await this.save();
  }

  async deactivateSession(sessionId: string): Promise<void> {
    await this.deactivateSessions([sessionId]);
  }

  async deactivateSessions(sessionIds: string[]): Promise<void> {
    this.assertLoaded();
    const removed = new Set(sessionIds);
    const next = this.activeSessionOrder.filter((id) => !removed.has(id));
    if (next.length === this.activeSessionOrder.length) return;
    this.activeSessionOrder = next;
    await this.save();
  }

  async reorderActiveSession(sessionId: string, beforeSessionId?: string): Promise<void> {
    this.assertLoaded();
    const index = this.activeSessionOrder.indexOf(sessionId);
    if (index < 0) throw new Error("active session is unavailable");
    if (beforeSessionId === sessionId) return;
    const next = this.activeSessionOrder.filter((id) => id !== sessionId);
    const before = beforeSessionId ? next.indexOf(beforeSessionId) : -1;
    if (beforeSessionId && before < 0) throw new Error("active session reorder target is unavailable");
    if (before >= 0) next.splice(before, 0, sessionId);
    else next.push(sessionId);
    this.activeSessionOrder = next;
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

  projectForSession(sessionId: string, cwd: string): RegisteredProject | undefined {
    this.assertLoaded();
    const mapped = this.sessionWorkspaces.find((item) => item.sessionId === sessionId);
    return mapped ? this.get(mapped.projectId) : this.get(projectIdForCwd(cwd));
  }

  effectiveCwd(sessionId: string, fallback: string): string {
    this.assertLoaded();
    const workspace = this.sessionWorkspaces.find((item) => item.sessionId === sessionId);
    if (!workspace) return fallback;
    if (workspace.mode === "worktree" && workspace.worktreePath) return workspace.worktreePath;
    return this.get(workspace.projectId)?.cwd ?? fallback;
  }

  workspaceForSession(sessionId: string): SessionWorkspaceRecord | undefined {
    this.assertLoaded();
    const value = this.sessionWorkspaces.find((item) => item.sessionId === sessionId);
    return value ? { ...value } : undefined;
  }

  listSessionWorkspaces(): SessionWorkspaceRecord[] {
    this.assertLoaded();
    return this.sessionWorkspaces.map((item) => ({ ...item }));
  }

  worktreeRoot(projectId: string): string {
    this.assertLoaded();
    if (!this.get(projectId)) throw new Error("project is unavailable");
    return resolve(dirname(this.configPath), "worktrees", projectId);
  }

  async setSessionWorkspace(record: SessionWorkspaceRecord): Promise<void> {
    this.assertLoaded();
    if (!this.get(record.projectId)) throw new Error("project is unavailable");
    if (!record.sessionId || record.sessionId.length > 128) throw new Error("invalid session workspace");
    this.sessionWorkspaces = this.sessionWorkspaces.filter((item) => item.sessionId !== record.sessionId);
    this.sessionWorkspaces.push({ ...record });
    await this.save();
  }

  async removeSessionWorkspace(sessionId: string): Promise<SessionWorkspaceRecord | undefined> {
    this.assertLoaded();
    const record = this.workspaceForSession(sessionId);
    if (!record) return undefined;
    this.sessionWorkspaces = this.sessionWorkspaces.filter((item) => item.sessionId !== sessionId);
    await this.save();
    return record;
  }

  async updateWorktreeSettings(projectId: string, setupCommand: string): Promise<void> {
    const project = this.requireProject(projectId);
    if (setupCommand.length > 2_000) throw new Error("setup command is too long");
    if (setupCommand.trim()) project.setupCommand = setupCommand.trim();
    else delete project.setupCommand;
    await this.save();
  }

  async writeHandoffJournal(value: HandoffJournal): Promise<void> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "handoff.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async readHandoffJournal(): Promise<HandoffJournal | undefined> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "handoff.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as HandoffJournal;
      if (value?.version !== 1 || typeof value.sessionId !== "string" || typeof value.projectId !== "string"
        || !value.workspace || !value.projectState || !value.sessionState) {
        throw new Error("invalid handoff recovery journal");
      }
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async clearHandoffJournal(): Promise<void> {
    this.assertLoaded();
    await rm(resolve(dirname(this.configPath), "handoff.json"), { force: true });
  }

  async writeProvisionJournal(value: ProvisionJournal): Promise<void> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "provision.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async readProvisionJournal(): Promise<ProvisionJournal | undefined> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "provision.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as ProvisionJournal;
      if (value?.version !== 1 || typeof value.projectId !== "string"
        || typeof value.worktreePath !== "string" || typeof value.commonDir !== "string"
        || typeof value.branch !== "string") throw new Error("invalid worktree recovery journal");
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async clearProvisionJournal(): Promise<void> {
    this.assertLoaded();
    await rm(resolve(dirname(this.configPath), "provision.json"), { force: true });
  }

  private async resolveProjects(records: Array<{ directory: string; archivedAt?: string; setupCommand?: string }>): Promise<RegisteredProject[]> {
    const projects: RegisteredProject[] = [];
    for (const record of records.slice(0, MAX_PROJECTS)) {
      try {
        const cwd = await canonicalDirectory(record.directory);
        const id = projectIdForCwd(cwd);
        if (!projects.some((project) => project.id === id)) {
          projects.push({
            id,
            cwd,
            label: basename(cwd) || cwd,
            ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
            ...(record.setupCommand ? { setupCommand: record.setupCommand } : {}),
          });
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
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
      })),
      archivedSessions: this.archivedSessions,
      sessionWorkspaces: this.sessionWorkspaces,
      activeSessionOrder: this.activeSessionOrder,
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

  private parseSessionWorkspace(value: unknown): SessionWorkspaceRecord[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 128
      || typeof record.projectId !== "string" || !record.projectId || record.projectId.length > 128
      || !["checkout", "worktree"].includes(String(record.mode))) return [];
    const optional = [
      "worktreePath", "commonDir", "branch", "baseline", "baselineTree",
      "parkedRoot", "parkedCommonDir", "parkedHead", "parkedHeadRef",
      "parkedIndexTree", "parkedWorktreeTree",
    ] as const;
    if (optional.some((key) => record[key] !== undefined
      && (typeof record[key] !== "string" || !record[key] || record[key]!.length > 4_096))) return [];
    return [{
      sessionId: record.sessionId,
      projectId: record.projectId,
      mode: record.mode as "checkout" | "worktree",
      ...Object.fromEntries(optional.flatMap((key) => record[key] ? [[key, record[key]]] : [])),
    } as SessionWorkspaceRecord];
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

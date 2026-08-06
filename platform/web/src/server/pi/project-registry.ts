import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { DialogTimeoutSeconds, RuntimePolicyReadModel, ToolExposureMode, ToolOverrideReadModel, VerifyPolicyReadModel, WorkspacePolicyMode } from "../../shared/protocol/snapshots.ts";

const VERSION = 12;
const MAX_PROJECTS = 100;
const MAX_ARCHIVED_SESSIONS = 10_000;
const MAX_PINNED_SESSIONS = 10_000;
const DEFAULT_DIALOG_TIMEOUT_SECONDS = 60;
const MAX_TOOL_OVERRIDES = 256;

export interface RegisteredProject {
  id: string;
  cwd: string;
  label: string;
  archivedAt?: string;
  setupCommand?: string;
  verifyPolicy?: VerifyPolicyReadModel;
  timelineEnabled?: boolean;
  guardEnabled?: boolean;
  workspacePolicy?: WorkspacePolicyMode;
  guardTimeoutSeconds?: DialogTimeoutSeconds;
  clarifyTimeoutSeconds?: DialogTimeoutSeconds;
  toolOverrides?: ToolOverrideReadModel;
}

interface SessionPolicyRecord {
  sessionId: string;
  projectId: string;
  verify?: VerifyPolicyReadModel;
  timelineEnabled?: boolean;
  guardEnabled?: boolean;
  workspace?: WorkspacePolicyMode;
  guardTimeoutSeconds?: DialogTimeoutSeconds;
  clarifyTimeoutSeconds?: DialogTimeoutSeconds;
  toolOverrides?: ToolOverrideReadModel;
}

export interface ToolPolicyUpdate {
  scope: "global" | "project" | "session";
  projectId: string;
  sessionId: string;
  tool: string;
  mode: ToolExposureMode | "inherit";
  expectedRevision: number;
}

export interface RuntimePolicyUpdate {
  scope: "global" | "project" | "session";
  projectId: string;
  sessionId: string;
  verify: VerifyPolicyReadModel | { mode: "inherit" };
  timeline: "inherit" | "enabled" | "disabled";
  guard: "inherit" | "enabled" | "disabled";
  workspace: WorkspacePolicyMode | "inherit";
  guardTimeoutSeconds: DialogTimeoutSeconds | "inherit";
  clarifyTimeoutSeconds: DialogTimeoutSeconds | "inherit";
  expectedRevision: number;
}

export interface SessionWorkspaceRecord {
  sessionId: string;
  projectId: string;
  mode: "checkout" | "worktree" | "local";
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

export interface ApplyJournal {
  version: 1;
  sessionId: string;
  projectId: string;
  mode: "checkout" | "worktree";
  workspace: SessionWorkspaceRecord;
  targetState: HandoffJournal["projectState"];
  sourceState: HandoffJournal["projectState"];
  mergedState: HandoffJournal["projectState"];
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
  private pinnedSessionIds: string[] = [];
  private sessionPolicies: SessionPolicyRecord[] = [];
  private globalPolicy = {
    timelineEnabled: true,
    guardEnabled: true,
    workspace: "local" as WorkspacePolicyMode,
    guardTimeoutSeconds: DEFAULT_DIALOG_TIMEOUT_SECONDS as DialogTimeoutSeconds,
    clarifyTimeoutSeconds: DEFAULT_DIALOG_TIMEOUT_SECONDS as DialogTimeoutSeconds,
    toolOverrides: {} as ToolOverrideReadModel,
  };
  private policyRevision = 0;
  private loaded = false;
  private saveQueue = Promise.resolve();

  constructor(private readonly configPath: string) {}

  static forAgentDir(agentDir: string): ProjectRegistry {
    return new ProjectRegistry(resolve(agentDir, "pylon-web", "projects.json"));
  }

  async load(seedDirectories: string[] | (() => Promise<string[]>) = []): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("invalid project registry");
      const value = parsed as { version?: unknown; directories?: unknown; projects?: unknown; archivedSessions?: unknown; sessionWorkspaces?: unknown; activeSessionOrder?: unknown; pinnedSessionIds?: unknown; sessionPolicies?: unknown; policyRevision?: unknown; globalPolicy?: unknown };
      if (value.version === 1 && Array.isArray(value.directories)) {
        const directories = value.directories.filter((item): item is string =>
          typeof item === "string" && item.length > 0 && item.length <= 4_096);
        this.projects = await this.resolveProjects(directories.map((directory) => ({ directory })));
        this.loaded = true;
        await this.save();
        return;
      }
      if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, VERSION].includes(Number(value.version)) || !Array.isArray(value.projects) || !Array.isArray(value.archivedSessions)) {
        throw new Error("invalid project registry");
      }
      const persistedGlobal = value.globalPolicy && typeof value.globalPolicy === "object" && !Array.isArray(value.globalPolicy)
        ? value.globalPolicy as Record<string, unknown>
        : {};
      if (Number(value.version) >= 9) {
        if (typeof persistedGlobal.timelineEnabled !== "boolean"
          || Number(value.version) >= VERSION && typeof persistedGlobal.guardEnabled !== "boolean"
          || !validWorkspacePolicy(persistedGlobal.workspace)
          || !validDialogTimeout(persistedGlobal.guardTimeoutSeconds)
          || !validDialogTimeout(persistedGlobal.clarifyTimeoutSeconds)
          || Number(value.version) >= VERSION && !validToolOverrides(persistedGlobal.toolOverrides)) {
          throw new Error("invalid global runtime policy");
        }
        this.globalPolicy = {
          timelineEnabled: persistedGlobal.timelineEnabled,
          guardEnabled: typeof persistedGlobal.guardEnabled === "boolean" ? persistedGlobal.guardEnabled : true,
          workspace: persistedGlobal.workspace,
          guardTimeoutSeconds: persistedGlobal.guardTimeoutSeconds,
          clarifyTimeoutSeconds: persistedGlobal.clarifyTimeoutSeconds,
          toolOverrides: Number(value.version) >= VERSION ? cloneToolOverrides(persistedGlobal.toolOverrides as ToolOverrideReadModel) : {},
        };
      }
      const legacyPolicy = Number(value.version) < 9;
      const projects = value.projects.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as { directory?: unknown; label?: unknown; archivedAt?: unknown; setupCommand?: unknown; verifyPolicy?: unknown; timelineEnabled?: unknown; guardEnabled?: unknown; workspacePolicy?: unknown; guardTimeoutSeconds?: unknown; clarifyTimeoutSeconds?: unknown; toolOverrides?: unknown };
        const workspacePolicy = record.workspacePolicy === undefined
          ? undefined
          : migrateWorkspacePolicy(record.workspacePolicy);
        if (typeof record.directory !== "string" || !record.directory || record.directory.length > 4_096) return [];
        if (record.label !== undefined && (typeof record.label !== "string" || !record.label.trim() || record.label.length > 200 || /[\u0000-\u001f\u007f]/.test(record.label))) return [];
        if (record.archivedAt !== undefined && (typeof record.archivedAt !== "string" || Number.isNaN(Date.parse(record.archivedAt)))) return [];
        if (record.setupCommand !== undefined && (typeof record.setupCommand !== "string" || record.setupCommand.length > 2_000)) return [];
        if (record.verifyPolicy !== undefined && !validVerifyPolicy(record.verifyPolicy)) return [];
        if (record.timelineEnabled !== undefined && typeof record.timelineEnabled !== "boolean") return [];
        if (record.guardEnabled !== undefined && typeof record.guardEnabled !== "boolean") return [];
        if (record.workspacePolicy !== undefined && workspacePolicy === undefined) return [];
        if (record.guardTimeoutSeconds !== undefined && !validDialogTimeout(record.guardTimeoutSeconds)) return [];
        if (record.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(record.clarifyTimeoutSeconds)) return [];
        if (record.toolOverrides !== undefined && !validToolOverrides(record.toolOverrides)) return [];
        return [{
          directory: record.directory,
          ...(typeof record.label === "string" ? { label: record.label.trim() } : {}),
          ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
          ...(record.setupCommand ? { setupCommand: record.setupCommand } : {}),
          ...(record.verifyPolicy ? { verifyPolicy: cloneVerifyPolicy(record.verifyPolicy) } : {}),
          ...(record.timelineEnabled !== undefined && (!legacyPolicy || record.timelineEnabled !== true) ? { timelineEnabled: record.timelineEnabled } : {}),
          ...(record.guardEnabled !== undefined ? { guardEnabled: record.guardEnabled } : {}),
          ...(workspacePolicy && (!legacyPolicy || workspacePolicy !== "local") ? { workspacePolicy } : {}),
          ...(record.guardTimeoutSeconds !== undefined && (!legacyPolicy || record.guardTimeoutSeconds !== DEFAULT_DIALOG_TIMEOUT_SECONDS) ? { guardTimeoutSeconds: record.guardTimeoutSeconds } : {}),
          ...(record.clarifyTimeoutSeconds !== undefined && (!legacyPolicy || record.clarifyTimeoutSeconds !== DEFAULT_DIALOG_TIMEOUT_SECONDS) ? { clarifyTimeoutSeconds: record.clarifyTimeoutSeconds } : {}),
          ...(record.toolOverrides && Object.keys(record.toolOverrides as ToolOverrideReadModel).length ? { toolOverrides: cloneToolOverrides(record.toolOverrides as ToolOverrideReadModel) } : {}),
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
      // v9 active order did not encode pin intent; do not infer pins during migration.
      this.pinnedSessionIds = Number(value.version) >= VERSION && Array.isArray(value.pinnedSessionIds)
        ? [...new Set(value.pinnedSessionIds.filter((item): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 128))]
            .slice(0, MAX_PINNED_SESSIONS)
        : [];
      this.sessionPolicies = Array.isArray(value.sessionPolicies)
        ? value.sessionPolicies.flatMap((item) => this.parseSessionPolicy(item)).slice(0, MAX_ARCHIVED_SESSIONS)
        : [];
      this.policyRevision = Number.isSafeInteger(value.policyRevision) && (value.policyRevision as number) >= 0
        ? value.policyRevision as number
        : 0;
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
    const project = {
      id,
      cwd,
      label: basename(cwd) || cwd,
    };
    this.projects.push(project);
    await this.save();
    return { ...project };
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    const project = this.requireProject(projectId);
    const label = name.trim();
    if (!label || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("invalid project name");
    if (project.label === label) return;
    project.label = label;
    await this.save();
  }

  async remove(projectId: string, sessionIds: string[] = []): Promise<void> {
    this.assertLoaded();
    if (!this.projects.some((project) => project.id === projectId)) throw new Error("project is unavailable");
    this.projects = this.projects.filter((project) => project.id !== projectId);
    this.sessionWorkspaces = this.sessionWorkspaces.filter((workspace) => workspace.projectId !== projectId);
    this.sessionPolicies = this.sessionPolicies.filter((policy) => policy.projectId !== projectId);
    const removedSessions = new Set(sessionIds);
    this.archivedSessions = this.archivedSessions.filter((session) => !removedSessions.has(session.id));
    this.activeSessionOrder = this.activeSessionOrder.filter((sessionId) => !removedSessions.has(sessionId));
    this.pinnedSessionIds = this.pinnedSessionIds.filter((sessionId) => !removedSessions.has(sessionId));
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

  listPinnedSessionIds(): string[] {
    this.assertLoaded();
    return [...this.pinnedSessionIds];
  }

  isSessionPinned(sessionId: string): boolean {
    this.assertLoaded();
    return this.pinnedSessionIds.includes(sessionId);
  }

  async pinSession(sessionId: string): Promise<void> {
    this.assertLoaded();
    if (!sessionId || sessionId.length > 128) throw new Error("invalid pinned session");
    if (this.isSessionPinned(sessionId)) return;
    if (this.pinnedSessionIds.length >= MAX_PINNED_SESSIONS) throw new Error("pinned session limit reached");
    this.pinnedSessionIds.push(sessionId);
    await this.save();
  }

  async unpinSession(sessionId: string): Promise<void> {
    this.assertLoaded();
    const next = this.pinnedSessionIds.filter((id) => id !== sessionId);
    if (next.length === this.pinnedSessionIds.length) return;
    this.pinnedSessionIds = next;
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

  async archiveProject(projectId: string, sessionIds: string[] = []): Promise<void> {
    const project = this.requireProject(projectId);
    if (project.archivedAt) return;
    project.archivedAt = new Date().toISOString();
    const removed = new Set(sessionIds);
    this.pinnedSessionIds = this.pinnedSessionIds.filter((sessionId) => !removed.has(sessionId));
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
    this.pinnedSessionIds = this.pinnedSessionIds.filter((id) => id !== sessionId);
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

  async rekeySession(previousId: string, sessionId: string, reason: "replace" | "fork" = "replace"): Promise<void> {
    this.assertLoaded();
    if (previousId === sessionId) return;
    const workspace = this.sessionWorkspaces.find((item) => item.sessionId === previousId);
    if (workspace) {
      if (reason === "fork" && workspace.mode === "local") {
        this.sessionWorkspaces = this.sessionWorkspaces.filter((item) => item.sessionId !== sessionId);
        this.sessionWorkspaces.push({ ...workspace, sessionId });
      } else workspace.sessionId = sessionId;
    }
    const policy = this.sessionPolicies.find((item) => item.sessionId === previousId);
    if (policy) {
      if (reason === "fork") {
        this.sessionPolicies = this.sessionPolicies.filter((item) => item.sessionId !== sessionId);
        this.sessionPolicies.push({
          ...policy,
          sessionId,
          ...(policy.verify ? { verify: cloneVerifyPolicy(policy.verify) } : {}),
          ...(policy.toolOverrides ? { toolOverrides: cloneToolOverrides(policy.toolOverrides) } : {}),
        });
      } else policy.sessionId = sessionId;
    }
    const archived = this.archivedSessions.find((item) => item.id === previousId);
    if (archived) archived.id = sessionId;
    this.activeSessionOrder = this.activeSessionOrder.map((id) => id === previousId ? sessionId : id);
    this.pinnedSessionIds = [...new Set(this.pinnedSessionIds.map((id) => id === previousId ? sessionId : id))];
    await this.save();
  }

  async updateWorktreeSettings(projectId: string, setupCommand: string): Promise<void> {
    const project = this.requireProject(projectId);
    if (setupCommand.length > 2_000) throw new Error("setup command is too long");
    if (setupCommand.trim()) project.setupCommand = setupCommand.trim();
    else delete project.setupCommand;
    await this.save();
  }

  runtimePolicy(projectId: string, sessionId: string): RuntimePolicyReadModel {
    const project = this.requireProject(projectId);
    const session = this.sessionPolicies.find((item) => item.sessionId === sessionId && item.projectId === projectId);
    const projectVerify = cloneVerifyPolicy(project.verifyPolicy ?? { mode: "auto" });
    const projectTimeline = project.timelineEnabled ?? this.globalPolicy.timelineEnabled;
    const projectGuard = project.guardEnabled ?? this.globalPolicy.guardEnabled;
    const projectWorkspace = project.workspacePolicy ?? this.globalPolicy.workspace;
    const projectGuardTimeout = project.guardTimeoutSeconds === undefined ? this.globalPolicy.guardTimeoutSeconds : project.guardTimeoutSeconds;
    const projectClarifyTimeout = project.clarifyTimeoutSeconds === undefined ? this.globalPolicy.clarifyTimeoutSeconds : project.clarifyTimeoutSeconds;
    const globalTools = cloneToolOverrides(this.globalPolicy.toolOverrides);
    const projectTools = cloneToolOverrides(project.toolOverrides ?? {});
    const sessionTools = cloneToolOverrides(session?.toolOverrides ?? {});
    return {
      revision: this.policyRevision,
      global: { ...this.globalPolicy, toolOverrides: globalTools },
      project: {
        verify: projectVerify,
        toolOverrides: projectTools,
        ...(project.timelineEnabled !== undefined ? { timelineEnabled: project.timelineEnabled } : {}),
        ...(project.guardEnabled !== undefined ? { guardEnabled: project.guardEnabled } : {}),
        ...(project.workspacePolicy !== undefined ? { workspace: project.workspacePolicy } : {}),
        ...(project.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: project.guardTimeoutSeconds } : {}),
        ...(project.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: project.clarifyTimeoutSeconds } : {}),
      },
      session: {
        toolOverrides: sessionTools,
        ...(session?.verify ? { verify: cloneVerifyPolicy(session.verify) } : {}),
        ...(session?.timelineEnabled !== undefined ? { timelineEnabled: session.timelineEnabled } : {}),
        ...(session?.guardEnabled !== undefined ? { guardEnabled: session.guardEnabled } : {}),
        ...(session?.workspace ? { workspace: session.workspace } : {}),
        ...(session?.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: session.guardTimeoutSeconds } : {}),
        ...(session?.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: session.clarifyTimeoutSeconds } : {}),
      },
      effective: {
        verify: cloneVerifyPolicy(session?.verify ?? projectVerify),
        toolOverrides: { ...globalTools, ...projectTools, ...sessionTools },
        timelineEnabled: session?.timelineEnabled ?? projectTimeline,
        guardEnabled: session?.guardEnabled ?? projectGuard,
        workspace: session?.workspace ?? projectWorkspace,
        guardTimeoutSeconds: session?.guardTimeoutSeconds === undefined ? projectGuardTimeout : session.guardTimeoutSeconds,
        clarifyTimeoutSeconds: session?.clarifyTimeoutSeconds === undefined ? projectClarifyTimeout : session.clarifyTimeoutSeconds,
      },
      availableVerifyChecks: [],
    };
  }

  async updateRuntimePolicy(input: RuntimePolicyUpdate): Promise<RuntimePolicyReadModel> {
    if (input.expectedRevision !== this.policyRevision) throw new Error("runtime policy changed; refresh and try again");
    if ((input.guardTimeoutSeconds !== "inherit" && !validDialogTimeout(input.guardTimeoutSeconds))
      || (input.clarifyTimeoutSeconds !== "inherit" && !validDialogTimeout(input.clarifyTimeoutSeconds))) {
      throw new Error("invalid dialog timeout policy");
    }
    const project = this.requireProject(input.projectId);
    if (input.scope === "global") {
      if (input.verify.mode !== "inherit" || input.timeline === "inherit" || input.guard === "inherit" || input.workspace === "inherit"
        || input.guardTimeoutSeconds === "inherit" || input.clarifyTimeoutSeconds === "inherit"
        || !validDialogTimeout(input.guardTimeoutSeconds) || !validDialogTimeout(input.clarifyTimeoutSeconds)) {
        throw new Error("invalid global runtime policy");
      }
      this.globalPolicy = {
        timelineEnabled: input.timeline === "enabled",
        guardEnabled: input.guard === "enabled",
        workspace: input.workspace,
        guardTimeoutSeconds: input.guardTimeoutSeconds,
        clarifyTimeoutSeconds: input.clarifyTimeoutSeconds,
        toolOverrides: this.globalPolicy.toolOverrides,
      };
    } else if (input.scope === "project") {
      if (input.verify.mode === "inherit") throw new Error("project Verify policy cannot inherit");
      project.verifyPolicy = cloneVerifyPolicy(input.verify);
      if (input.timeline === "inherit") delete project.timelineEnabled;
      else project.timelineEnabled = input.timeline === "enabled";
      if (input.guard === "inherit") delete project.guardEnabled;
      else project.guardEnabled = input.guard === "enabled";
      if (input.workspace === "inherit") delete project.workspacePolicy;
      else project.workspacePolicy = input.workspace;
      if (input.guardTimeoutSeconds === "inherit") delete project.guardTimeoutSeconds;
      else project.guardTimeoutSeconds = input.guardTimeoutSeconds;
      if (input.clarifyTimeoutSeconds === "inherit") delete project.clarifyTimeoutSeconds;
      else project.clarifyTimeoutSeconds = input.clarifyTimeoutSeconds;
    } else {
      let session = this.sessionPolicies.find((item) => item.sessionId === input.sessionId);
      if (!session) {
        session = { sessionId: input.sessionId, projectId: input.projectId };
        this.sessionPolicies.push(session);
      }
      if (session.projectId !== input.projectId) throw new Error("session policy project mismatch");
      if (input.verify.mode === "inherit") delete session.verify;
      else session.verify = cloneVerifyPolicy(input.verify);
      if (input.timeline === "inherit") delete session.timelineEnabled;
      else session.timelineEnabled = input.timeline === "enabled";
      if (input.guard === "inherit") delete session.guardEnabled;
      else session.guardEnabled = input.guard === "enabled";
      if (input.workspace === "inherit") delete session.workspace;
      else session.workspace = input.workspace;
      if (input.guardTimeoutSeconds === "inherit") delete session.guardTimeoutSeconds;
      else session.guardTimeoutSeconds = input.guardTimeoutSeconds;
      if (input.clarifyTimeoutSeconds === "inherit") delete session.clarifyTimeoutSeconds;
      else session.clarifyTimeoutSeconds = input.clarifyTimeoutSeconds;
      if (!session.verify && session.timelineEnabled === undefined && session.guardEnabled === undefined && !session.workspace
        && session.guardTimeoutSeconds === undefined && session.clarifyTimeoutSeconds === undefined && !session.toolOverrides) {
        this.sessionPolicies = this.sessionPolicies.filter((item) => item !== session);
      }
    }
    this.policyRevision++;
    await this.save();
    return this.runtimePolicy(input.projectId, input.sessionId);
  }

  async updateToolPolicy(input: ToolPolicyUpdate): Promise<RuntimePolicyReadModel> {
    if (input.expectedRevision !== this.policyRevision) throw new Error("runtime policy changed; refresh and try again");
    if (!validToolName(input.tool) || !["inherit", "active", "deferred", "disabled"].includes(input.mode)) {
      throw new Error("invalid tool policy");
    }
    const project = this.requireProject(input.projectId);
    const previousRevision = this.policyRevision;
    const previousGlobal = cloneToolOverrides(this.globalPolicy.toolOverrides);
    const previousProject = project.toolOverrides ? cloneToolOverrides(project.toolOverrides) : undefined;
    const previousSessions = input.scope === "session" ? this.sessionPolicies.map((item) => ({
      ...item,
      ...(item.toolOverrides ? { toolOverrides: cloneToolOverrides(item.toolOverrides) } : {}),
    })) : undefined;
    let overrides: ToolOverrideReadModel;
    if (input.scope === "global") {
      overrides = this.globalPolicy.toolOverrides;
    } else if (input.scope === "project") {
      overrides = project.toolOverrides ??= {};
    } else {
      let session = this.sessionPolicies.find((item) => item.sessionId === input.sessionId);
      if (!session) {
        session = { sessionId: input.sessionId, projectId: input.projectId };
        this.sessionPolicies.push(session);
      }
      if (session.projectId !== input.projectId) throw new Error("session policy project mismatch");
      overrides = session.toolOverrides ??= {};
    }
    if (input.mode !== "inherit" && !(input.tool in overrides) && Object.keys(overrides).length >= MAX_TOOL_OVERRIDES) {
      throw new Error("too many tool policy overrides");
    }
    if (input.mode === "inherit") delete overrides[input.tool];
    else overrides[input.tool] = input.mode;
    if (input.scope === "project" && !Object.keys(overrides).length) delete project.toolOverrides;
    if (input.scope === "session") {
      const session = this.sessionPolicies.find((item) => item.sessionId === input.sessionId)!;
      if (!Object.keys(overrides).length) delete session.toolOverrides;
      if (!session.verify && session.timelineEnabled === undefined && session.guardEnabled === undefined && !session.workspace
        && session.guardTimeoutSeconds === undefined && session.clarifyTimeoutSeconds === undefined && !session.toolOverrides) {
        this.sessionPolicies = this.sessionPolicies.filter((item) => item !== session);
      }
    }
    this.policyRevision++;
    try {
      await this.save();
    } catch (error) {
      this.policyRevision = previousRevision;
      if (input.scope === "global") this.globalPolicy.toolOverrides = previousGlobal;
      else if (input.scope === "project") {
        if (previousProject) project.toolOverrides = previousProject;
        else delete project.toolOverrides;
      } else if (previousSessions) this.sessionPolicies = previousSessions;
      throw error;
    }
    return this.runtimePolicy(input.projectId, input.sessionId);
  }

  async removeSessionPolicy(sessionId: string): Promise<void> {
    const next = this.sessionPolicies.filter((item) => item.sessionId !== sessionId);
    if (next.length === this.sessionPolicies.length) return;
    this.sessionPolicies = next;
    this.policyRevision++;
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

  async writeApplyJournal(value: ApplyJournal): Promise<void> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "apply.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  async readApplyJournal(): Promise<ApplyJournal | undefined> {
    this.assertLoaded();
    const path = resolve(dirname(this.configPath), "apply.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as ApplyJournal;
      if (value?.version !== 1 || !["checkout", "worktree"].includes(value.mode)
        || typeof value.sessionId !== "string" || typeof value.projectId !== "string"
        || !value.workspace || !value.targetState || !value.sourceState || !value.mergedState) {
        throw new Error("invalid workspace apply recovery journal");
      }
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async clearApplyJournal(): Promise<void> {
    this.assertLoaded();
    await rm(resolve(dirname(this.configPath), "apply.json"), { force: true });
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

  private async resolveProjects(records: Array<{ directory: string; label?: string; archivedAt?: string; setupCommand?: string; verifyPolicy?: VerifyPolicyReadModel; timelineEnabled?: boolean; guardEnabled?: boolean; workspacePolicy?: WorkspacePolicyMode; guardTimeoutSeconds?: DialogTimeoutSeconds; clarifyTimeoutSeconds?: DialogTimeoutSeconds; toolOverrides?: ToolOverrideReadModel }>): Promise<RegisteredProject[]> {
    const projects: RegisteredProject[] = [];
    for (const record of records.slice(0, MAX_PROJECTS)) {
      try {
        const cwd = await canonicalDirectory(record.directory);
        const id = projectIdForCwd(cwd);
        if (!projects.some((project) => project.id === id)) {
          projects.push({
            id,
            cwd,
            label: record.label?.trim() || basename(cwd) || cwd,
            ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
            ...(record.setupCommand ? { setupCommand: record.setupCommand } : {}),
            ...(record.verifyPolicy ? { verifyPolicy: cloneVerifyPolicy(record.verifyPolicy) } : {}),
            ...(record.timelineEnabled !== undefined ? { timelineEnabled: record.timelineEnabled } : {}),
            ...(record.guardEnabled !== undefined ? { guardEnabled: record.guardEnabled } : {}),
            ...(record.workspacePolicy ? { workspacePolicy: record.workspacePolicy } : {}),
            ...(record.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: record.guardTimeoutSeconds } : {}),
            ...(record.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: record.clarifyTimeoutSeconds } : {}),
            ...(record.toolOverrides ? { toolOverrides: cloneToolOverrides(record.toolOverrides) } : {}),
          });
        }
      } catch {
        // Missing directories remain absent until explicitly added again.
      }
    }
    return projects;
  }

  private save(): Promise<void> {
    const pending = this.saveQueue.then(() => this.write());
    this.saveQueue = pending.catch(() => undefined);
    return pending;
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      version: VERSION,
      globalPolicy: this.globalPolicy,
      projects: this.projects.map((project) => ({
        directory: project.cwd,
        ...(project.label !== (basename(project.cwd) || project.cwd) ? { label: project.label } : {}),
        ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.verifyPolicy ? { verifyPolicy: project.verifyPolicy } : {}),
        ...(project.timelineEnabled !== undefined ? { timelineEnabled: project.timelineEnabled } : {}),
        ...(project.guardEnabled !== undefined ? { guardEnabled: project.guardEnabled } : {}),
        ...(project.workspacePolicy ? { workspacePolicy: project.workspacePolicy } : {}),
        ...(project.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: project.guardTimeoutSeconds } : {}),
        ...(project.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: project.clarifyTimeoutSeconds } : {}),
        ...(project.toolOverrides ? { toolOverrides: project.toolOverrides } : {}),
      })),
      archivedSessions: this.archivedSessions,
      sessionWorkspaces: this.sessionWorkspaces,
      activeSessionOrder: this.activeSessionOrder,
      pinnedSessionIds: this.pinnedSessionIds,
      sessionPolicies: this.sessionPolicies,
      policyRevision: this.policyRevision,
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
      || !["checkout", "worktree", "local"].includes(String(record.mode))) return [];
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
      mode: record.mode as "checkout" | "worktree" | "local",
      ...Object.fromEntries(optional.flatMap((key) => record[key] ? [[key, record[key]]] : [])),
    } as SessionWorkspaceRecord];
  }

  private parseSessionPolicy(value: unknown): SessionPolicyRecord[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const workspace = record.workspace === undefined
      ? undefined
      : migrateWorkspacePolicy(record.workspace);
    if (typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 128
      || typeof record.projectId !== "string" || !record.projectId || record.projectId.length > 128
      || (record.verify !== undefined && !validVerifyPolicy(record.verify))
      || (record.timelineEnabled !== undefined && typeof record.timelineEnabled !== "boolean")
      || (record.guardEnabled !== undefined && typeof record.guardEnabled !== "boolean")
      || (record.workspace !== undefined && workspace === undefined)
      || (record.guardTimeoutSeconds !== undefined && !validDialogTimeout(record.guardTimeoutSeconds))
      || (record.clarifyTimeoutSeconds !== undefined && !validDialogTimeout(record.clarifyTimeoutSeconds))
      || (record.toolOverrides !== undefined && !validToolOverrides(record.toolOverrides))) return [];
    return [{
      sessionId: record.sessionId,
      projectId: record.projectId,
      ...(record.verify ? { verify: cloneVerifyPolicy(record.verify) } : {}),
      ...(record.timelineEnabled !== undefined ? { timelineEnabled: record.timelineEnabled } : {}),
            ...(record.guardEnabled !== undefined ? { guardEnabled: record.guardEnabled } : {}),
      ...(workspace ? { workspace } : {}),
      ...(record.guardTimeoutSeconds !== undefined ? { guardTimeoutSeconds: record.guardTimeoutSeconds } : {}),
      ...(record.clarifyTimeoutSeconds !== undefined ? { clarifyTimeoutSeconds: record.clarifyTimeoutSeconds } : {}),
      ...(record.toolOverrides && Object.keys(record.toolOverrides as ToolOverrideReadModel).length ? { toolOverrides: cloneToolOverrides(record.toolOverrides as ToolOverrideReadModel) } : {}),
    }];
  }
}

function validVerifyPolicy(value: unknown): value is VerifyPolicyReadModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return policy.mode === "auto"
    || policy.mode === "selected"
      && Array.isArray(policy.checks)
      && policy.checks.length <= 6
      && policy.checks.every((check) => typeof check === "string" && check.length > 0 && check.length <= 100)
      && new Set(policy.checks).size === policy.checks.length;
}

function cloneVerifyPolicy(value: VerifyPolicyReadModel): VerifyPolicyReadModel {
  return value.mode === "auto" ? { mode: "auto" } : { mode: "selected", checks: [...value.checks] };
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validToolOverrides(value: unknown): value is ToolOverrideReadModel {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length <= MAX_TOOL_OVERRIDES
    && Object.entries(value as Record<string, unknown>).every(([tool, mode]) => validToolName(tool)
      && (mode === "active" || mode === "deferred" || mode === "disabled"));
}

function cloneToolOverrides(value: ToolOverrideReadModel): ToolOverrideReadModel {
  return { ...value };
}

function validWorkspacePolicy(value: unknown): value is WorkspacePolicyMode {
  return value === "checkout" || value === "worktree" || value === "local";
}

function migrateWorkspacePolicy(value: unknown): WorkspacePolicyMode | undefined {
  if (value === "automatic") return "local";
  return validWorkspacePolicy(value) ? value : undefined;
}

function validDialogTimeout(value: unknown): value is DialogTimeoutSeconds {
  return value === null
    || Number.isSafeInteger(value) && (value as number) >= 15 && (value as number) <= 86_400;
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

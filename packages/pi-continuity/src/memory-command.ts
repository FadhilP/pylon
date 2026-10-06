import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  directDelete,
  directEdit,
  emptyMemoryState,
  enforceMemoryLimits,
  isMemoryState,
  notesForOwners,
  sha256,
  type MemoryScope,
  type MemoryStateFile,
  type NotebookNote,
} from "./memory.ts";
import { hasPendingV4Migration, isMigrationJournal, type MigrationJournal } from "./memory-migration.ts";
import { readJson, withFileLock, withStateLock, writeJsonAtomic } from "./storage.ts";
import type { ProjectContext } from "./worktree.ts";

export type V5MigrationJournal = {
  version: 1;
  status: "prepared" | "activated" | "rolled_back";
  sourceSha256: string;
  stateSha256: string;
  activatedRevision: number;
  backupPath: string;
  preparedAt: string;
  migratedAt?: string;
  rolledBackAt?: string;
};
export const isV5MigrationJournal = (value: any): value is V5MigrationJournal =>
  value?.version === 1 &&
  ["prepared", "activated", "rolled_back"].includes(value.status) &&
  [value.sourceSha256, value.stateSha256].every(item => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) &&
  Number.isSafeInteger(value.activatedRevision) &&
  value.activatedRevision >= 0 &&
  typeof value.backupPath === "string" &&
  value.backupPath.length > 0 &&
  value.backupPath.length <= 500 &&
  typeof value.preparedAt === "string" &&
  !Number.isNaN(Date.parse(value.preparedAt)) &&
  (value.migratedAt === undefined ||
    (typeof value.migratedAt === "string" && !Number.isNaN(Date.parse(value.migratedAt)))) &&
  (value.rolledBackAt === undefined ||
    (typeof value.rolledBackAt === "string" && !Number.isNaN(Date.parse(value.rolledBackAt))));

/** Session state and operations the /memory command shares with the rest of the extension. */
export type MemoryCommandDeps = {
  memory: {
    state: MemoryStateFile;
    notes: NotebookNote[];
    enabled: boolean;
    activationEnabled: boolean;
    legacyMigrationAvailable: boolean;
  };
  root: () => string;
  sessionId: () => string;
  paths: () => { migration: string; v6Migration: string };
  memoryDirectory: () => string;
  readMemory: () => Promise<MemoryStateFile>;
  writeMemory: (state: MemoryStateFile) => Promise<void>;
  readV5MigrationJournal: () => Promise<V5MigrationJournal | undefined>;
  resolveProject: (cwd: string) => Promise<ProjectContext>;
  runV4Migration: (ctx: any, expectedSession: string) => Promise<{ migrated: boolean; rejected: number }>;
  withMemoryLifecycle: <T>(task: () => Promise<T>) => Promise<T>;
  publishState: () => void;
  emitMemoryOutcome: (outcome: "migration_committed" | "migration_failed") => void;
};

export function registerMemoryCommand(pi: ExtensionAPI, deps: MemoryCommandDeps) {
  const {
    memory,
    paths,
    memoryDirectory,
    readMemory,
    writeMemory,
    readV5MigrationJournal,
    resolveProject,
    runV4Migration,
    withMemoryLifecycle,
    publishState,
    emitMemoryOutcome,
  } = deps;
  let project: ProjectContext | undefined;

  /** Rollback may only restore from inside the protected backup directory; anything else is refused. */
  const assertInsideBackupRoot = (backup: string, label: string) => {
    const backupRoot = resolve(memoryDirectory(), "backups"),
      backupPath = resolve(backup);
    const rel = relative(backupRoot, backupPath);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
      throw Error(`${label} backup path is outside the protected backup directory.`);
    return backupPath;
  };

  const runMigrateV4 = async (ctx: any) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for V4 memory migration.", "error");
    if (
      !(await ctx.ui.confirm(
        "Migrate Memory V4 to V6?",
        "A configured Memory Reviewer will normalize preserved V4 facts as archival V6 notes. Backups are retained and /memory rollback remains available until the next V6 write.",
      ))
    )
      return;
    try {
      const migration = await withMemoryLifecycle(() => runV4Migration(ctx, deps.sessionId()));
      memory.legacyMigrationAvailable = await hasPendingV4Migration(deps.root());
      publishState();
      if (!migration.migrated)
        return void ctx.ui.notify(
          "No V4 migration was performed; the source is absent, already migrated, or the migration was previously rolled back.",
          "info",
        );
      emitMemoryOutcome("migration_committed");
      return void ctx.ui.notify(
        `Memory V4 migrated to V6. ${migration.rejected} record(s) were rejected; use /memory rollback before another V6 write to restore the prior notebook.`,
        "info",
      );
    } catch (error: any) {
      emitMemoryOutcome("migration_failed");
      memory.legacyMigrationAvailable = await hasPendingV4Migration(deps.root());
      publishState();
      return void ctx.ui.notify(`Memory V4 migration failed: ${error?.message ?? error}`, "error");
    }
  };

  const listMemoryBackups = async (ctx: any) => {
    const directories = [memoryDirectory(), join(deps.root(), "memory-v4")],
      backups: string[] = [];
    for (const directory of directories)
      for (const name of await readdir(directory, { recursive: true }).catch(() => [] as string[]))
        if (
          name.includes("backup") ||
          name.includes("reset-unsupported") ||
          name.includes("corrupt") ||
          name.includes("pre-migration") ||
          name.startsWith("state-v5-") ||
          name.startsWith("memory-v4") ||
          name.startsWith("candidates-v4")
        )
          backups.push(join(directory, name));
    return void ctx.ui.notify(backups.join("\n") || "No memory backups.", "info");
  };

  /** Discards the generated V6 notebook; the byte-exact V5 source and its backup stay on disk. */
  const rollbackV5Migration = async (ctx: any, v5Journal: V5MigrationJournal) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
    if (
      !(await ctx.ui.confirm(
        "Rollback Memory V5 migration?",
        "This removes the generated V6 notebook while preserving the byte-exact V5 source and backup.",
      ))
    )
      return;
    await withMemoryLifecycle(() =>
      withStateLock(memoryDirectory(), async () => {
        const latest = await readMemory();
        if (latest.revision !== v5Journal.activatedRevision)
          throw Error("Memory changed after V5 migration; rollback requires manual reconciliation.");
        const raw = await readFile(assertInsideBackupRoot(v5Journal.backupPath, "V5 migration"), "utf8");
        if (sha256(raw) !== v5Journal.sourceSha256)
          throw Error("V5 migration backup is stale or corrupt; rollback aborted.");
        const next = { ...emptyMemoryState(), revision: latest.revision + 1, updatedAt: new Date().toISOString() };
        await writeMemory(next);
        memory.state = next;
        memory.notes = [];
        await writeJsonAtomic(paths().v6Migration, {
          ...v5Journal,
          status: "rolled_back",
          rolledBackAt: new Date().toISOString(),
        } satisfies V5MigrationJournal);
      }),
    );
    publishState();
    return void ctx.ui.notify("Memory V5 migration rolled back; the original V5 state remains recoverable.", "info");
  };

  /** Restores the notebook captured immediately before the V6 migration ran. */
  const rollbackV6Migration = async (ctx: any, journal: MigrationJournal & { preMigrationBackup: string }) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
    if (
      !(await ctx.ui.confirm(
        "Rollback Memory V6 migration?",
        "This restores the notebook from immediately before migration.",
      ))
    )
      return;
    const backup = journal.preMigrationBackup;
    await withMemoryLifecycle(() =>
      withFileLock(join(memoryDirectory(), "migration-operation"), async () => {
        await withStateLock(memoryDirectory(), async () => {
          const latest = await readMemory();
          if (latest.revision !== journal.activatedStateRevision)
            throw Error("Memory changed after migration; rollback requires manual reconciliation.");
          let restored: MemoryStateFile;
          if (backup === "empty") restored = emptyMemoryState();
          else {
            const parsed = JSON.parse(await readFile(assertInsideBackupRoot(backup, "Migration"), "utf8"));
            if (!isMemoryState(parsed)) throw Error("Migration backup is missing or invalid; rollback aborted.");
            restored = parsed;
          }
          const next = { ...restored, revision: latest.revision + 1, updatedAt: new Date().toISOString() };
          enforceMemoryLimits(next);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        });
        await writeJsonAtomic(paths().migration, {
          ...journal,
          status: "rolled_back",
          activatedStateRevision: undefined,
        });
      }),
    );
    publishState();
    return void ctx.ui.notify("Memory migration rolled back.", "info");
  };

  const rollbackMigration = async (ctx: any) => {
    const journal = await readJson<MigrationJournal | undefined>(
      paths().migration,
      undefined,
      value => value === undefined || isMigrationJournal(value),
    );
    const v6Restorable = Boolean(
      journal &&
      journal.status === "activated" &&
      journal.activatedStateRevision === memory.state.revision &&
      journal.preMigrationBackup,
    );
    const v5Journal = await readV5MigrationJournal();
    if (!v6Restorable && v5Journal?.status === "activated" && v5Journal.activatedRevision === memory.state.revision)
      return rollbackV5Migration(ctx, v5Journal);
    if (!v6Restorable)
      return void ctx.ui.notify(
        "Migration rollback is unavailable after new V6 writes or without an activated migration.",
        "error",
      );
    return rollbackV6Migration(ctx, journal as MigrationJournal & { preMigrationBackup: string });
  };

  const showMemoryOwners = async (ctx: any) => {
    const counts = new Map<string, number>();
    for (const note of memory.notes) counts.set(note.owner, (counts.get(note.owner) ?? 0) + 1);
    return void ctx.ui.notify(
      [...counts]
        .map(
          ([owner, count]) =>
            `${owner}${owner === project!.owner || owner === "default" ? " (current)" : ""}: ${count}`,
        )
        .join("\n") || "No owners.",
      "info",
    );
  };

  const showMemoryNotes = async (ctx: any, scope?: MemoryScope) => {
    const all = notesForOwners(memory.notes, project!.owner).filter(note => !scope || note.scope === scope);
    const shown = all.slice(0, 20);
    return void ctx.ui.notify(
      shown.length
        ? `${shown
            .map(
              note =>
                `${note.scope}/${note.id} r${note.revision} [${note.authority}/${note.origin}]\nWhen ${note.trigger}\n${note.guidance}`,
            )
            .join("\n\n")}${shown.length < all.length ? `\n\n… ${all.length - shown.length} more notes` : ""}`
        : "No notes.",
      "info",
    );
  };

  const forgetProjectMemory = async (ctx: any) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
    if (!(await ctx.ui.confirm("Forget all project memory?", "These rules will be removed from this project."))) return;
    await withMemoryLifecycle(() =>
      withStateLock(memoryDirectory(), async () => {
        let latest = await readMemory();
        for (const note of latest.notes.filter(item => item.scope === "project" && item.owner === project!.owner))
          latest = directDelete(latest, "project", project!.owner, note.id, note.revision);
        await writeMemory(latest);
        memory.state = latest;
        memory.notes = latest.notes;
      }),
    );
    publishState();
    return void ctx.ui.notify("Project memory removed.", "info");
  };

  /** Resolves the note a scoped `edit`/`forget <id>` subcommand names, or notifies and returns undefined. */
  const scopedNote = (ctx: any, scope: MemoryScope, id: string) => {
    const owner = scope === "user" ? "default" : project!.owner;
    const note = memory.notes.find(item => item.id === id && item.scope === scope && item.owner === owner);
    if (!note) ctx.ui.notify("Memory note not found.", "error");
    return note && { note, owner };
  };

  const editMemoryNote = async (ctx: any, scope: MemoryScope, id: string) => {
    if (!ctx.hasUI || ctx.mode !== "tui")
      return void ctx.ui.notify("Interactive UI required for memory edit.", "error");
    const found = scopedNote(ctx, scope, id);
    if (!found) return;
    const { note, owner } = found;
    const value = await ctx.ui.editor(
      `Edit ${scope} memory`,
      `Trigger:\n${note.trigger}\n\nGuidance:\n${note.guidance}`,
    );
    const parsed = /^Trigger:\s*\n([\s\S]*?)\n\s*Guidance:\s*\n([\s\S]+)$/i.exec(value ?? "");
    if (!parsed) return void ctx.ui.notify("Keep Trigger and Guidance headings.", "error");
    if (
      !(await ctx.ui.confirm(
        `Save ${scope} memory?`,
        scope === "user" ? "This rule applies across every project." : "This rule applies to this project.",
      ))
    )
      return;
    try {
      await withMemoryLifecycle(() =>
        withStateLock(memoryDirectory(), async () => {
          const next = directEdit(await readMemory(), scope, owner, note.id, note.revision, parsed[1]!, parsed[2]!);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        }),
      );
      publishState();
      ctx.ui.notify("Memory note updated.", "info");
    } catch (error: any) {
      ctx.ui.notify(error?.message ?? "Memory update failed.", "error");
    }
  };

  const forgetMemoryNote = async (ctx: any, scope: MemoryScope, id: string) => {
    const found = scopedNote(ctx, scope, id);
    if (!found) return;
    const { note, owner } = found;
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
    if (
      !(await ctx.ui.confirm(
        `Forget ${scope} memory?`,
        scope === "user"
          ? "This rule will be removed from every project."
          : "This rule will be removed from this project.",
      ))
    )
      return;
    try {
      await withMemoryLifecycle(() =>
        withStateLock(memoryDirectory(), async () => {
          const next = directDelete(await readMemory(), scope, owner, note.id, note.revision);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        }),
      );
      publishState();
      ctx.ui.notify("Memory note removed.", "info");
    } catch (error: any) {
      ctx.ui.notify(error?.message ?? "Memory delete failed.", "error");
    }
  };

  pi.registerCommand("memory", {
    description: "Show and manage user or project notebook notes",
    handler: async (args, ctx) => {
      if (!memory.enabled) return void ctx.ui.notify("Continuity memory is disabled in package settings.", "info");
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const usage =
        "Usage: /memory [status|list [user|project]|edit <user|project> <id>|forget <user|project> [id]|owners|backups|migrate|rollback|activation <on|off>|help]";
      if (action === "help" && parts.length === 1) {
        ctx.ui.notify(usage, "info");
        return;
      }
      if (action === "activation" && parts.length === 2 && ["on", "off"].includes(parts[1]!)) {
        memory.activationEnabled = parts[1] === "on";
        ctx.ui.notify(`Prospective memory activation ${parts[1]} for this session.`, "info");
        return;
      }
      project = await resolveProject(ctx.cwd);
      memory.state = await readMemory();
      memory.notes = memory.state.notes;
      if ((action === "status" && parts.length === 1) || parts.length === 0) {
        const owned = notesForOwners(memory.notes, project.owner);
        ctx.ui.notify(
          `Memory: enabled\nActivation: ${memory.activationEnabled ? "on" : "off"}\nNotes: ${owned.length} (${owned.filter(note => note.scope === "user").length} user · ${owned.filter(note => note.scope === "project").length} project)`,
          "info",
        );
        return;
      }
      if (action === "list" && parts.length <= 2) {
        const scope = parts[1];
        if (scope && scope !== "user" && scope !== "project") {
          ctx.ui.notify(usage, "warning");
          return;
        }
        return showMemoryNotes(ctx, scope as MemoryScope | undefined);
      }
      if (action === "owners" && parts.length === 1) return showMemoryOwners(ctx);
      if (action === "backups" && parts.length === 1) return listMemoryBackups(ctx);
      if (action === "migrate" && parts.length === 1) return runMigrateV4(ctx);
      if (action === "rollback" && parts.length === 1) return rollbackMigration(ctx);
      if (action === "forget" && parts.length === 2 && parts[1] === "project") return forgetProjectMemory(ctx);
      if ((action === "edit" || action === "forget") && parts.length === 3) {
        const scope = parts[1];
        const id = parts[2]!;
        if ((scope === "user" || scope === "project") && /^[0-9a-f-]+$/i.test(id))
          return action === "edit" ? editMemoryNote(ctx, scope, id) : forgetMemoryNote(ctx, scope, id);
      }
      ctx.ui.notify(usage, "warning");
    },
  });
}

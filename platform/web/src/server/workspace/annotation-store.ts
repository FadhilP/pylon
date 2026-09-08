import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_ANNOTATIONS,
  validAnnotation,
  validAnnotationMutation,
  type Annotation,
  type AnnotationMutation,
} from "../../shared/workspace/annotations.ts";

/** Private UI drafts. Never loaded by Pi, StateQL, projections or prompt hooks. */
export class AnnotationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;");
      this.db.exec("BEGIN IMMEDIATE");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        this.db.exec(`CREATE TABLE notes (
          project TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL,
          version INTEGER NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (project, session, id)
        ); CREATE INDEX notes_session ON notes(session); PRAGMA user_version=1;`);
      } else if (version !== 1) throw new Error("Unsupported annotation database version; no data was changed.");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  scope(project: string, session: string): string {
    return JSON.stringify([project, session]);
  }
  list(project: string, session: string): Annotation[] {
    const rows = this.db
      .prepare("SELECT data FROM notes WHERE project=? AND session=? ORDER BY rowid LIMIT ?")
      .all(project, session, MAX_ANNOTATIONS + 1);
    const notes: unknown[] = rows.map(row => JSON.parse(String(row.data)));
    if (
      notes.length > MAX_ANNOTATIONS ||
      !notes.every(note => validAnnotation(note) && note.scope === this.scope(project, session))
    )
      throw new Error("Invalid stored annotations; existing data was not overwritten.");
    return notes as Annotation[];
  }
  mutate(project: string, session: string, input: AnnotationMutation): void {
    if (
      !validAnnotationMutation(input) ||
      input.sessionId !== session ||
      (input.note && input.note.scope !== this.scope(project, session))
    )
      throw Object.assign(new Error("Invalid annotation or session scope."), { statusCode: 400 });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT version FROM notes WHERE project=? AND session=? AND id=?")
        .get(project, session, input.id);
      if (existing?.version !== input.expectedVersion)
        throw Object.assign(
          new Error(
            "This note changed or was deleted elsewhere. Your edit was not saved; reload notes before trying again.",
          ),
          { statusCode: 409 },
        );
      if (!input.note)
        this.db.prepare("DELETE FROM notes WHERE project=? AND session=? AND id=?").run(project, session, input.id);
      else {
        const count = this.db
          .prepare("SELECT count(*) AS n FROM notes WHERE project=? AND session=?")
          .get(project, session)!.n as number;
        if (!existing && count >= MAX_ANNOTATIONS)
          throw Object.assign(
            new Error(`Keep at most ${MAX_ANNOTATIONS} notes per session. Delete a note before adding another.`),
            { statusCode: 409 },
          );
        this.db
          .prepare(
            "INSERT INTO notes(project,session,id,version,data) VALUES(?,?,?,?,?) ON CONFLICT(project,session,id) DO UPDATE SET version=excluded.version,data=excluded.data",
          )
          .run(project, session, input.id, input.note.version, JSON.stringify(input.note));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  deleteSession(session: string): void {
    this.db.prepare("DELETE FROM notes WHERE session=?").run(session);
  }
  deleteProject(project: string): void {
    this.db.prepare("DELETE FROM notes WHERE project=?").run(project);
  }
  close(): void {
    this.db.close();
  }
}

import { DatabaseSync } from "node:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { validAndroidModulePath, validAndroidVariant } from "pylon-android/project-discovery";

const MAX_PATH = 4096;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface StoredAndroidConfiguration {
  candidateId: string;
  modulePath: string;
  variant: string;
  revision: number;
  updatedAt: string;
}

export interface StoredAndroidTrust {
  trusted: boolean;
  revision: number;
  configRevision: number;
  registeredRoot: string;
  workspaceRoot: string;
  wrapperRelativePath: "gradlew" | "gradlew.bat";
  wrapperFingerprint: string;
  updatedAt: string;
}

export interface StoredAndroidProject {
  configRevision: number;
  configuration?: StoredAndroidConfiguration;
  trustRevision: number;
  trust?: StoredAndroidTrust;
}

export class AndroidSettingsConflict extends Error {}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

export class AndroidSettingsStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 2) throw new Error("Android settings were created by a newer Pylon version");
      if (version === 0) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(`
            CREATE TABLE android_configuration (
              project_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              candidate_id TEXT NOT NULL,
              module_path TEXT NOT NULL,
              variant TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE android_trust (
              project_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              trusted INTEGER NOT NULL CHECK(trusted IN (0,1)),
              config_revision INTEGER NOT NULL,
              registered_root TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              wrapper_relative_path TEXT NOT NULL,
              wrapper_fingerprint TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            PRAGMA user_version=2;
            COMMIT;
          `);
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      if (version === 1) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(
            "ALTER TABLE android_configuration ADD COLUMN candidate_id TEXT NOT NULL DEFAULT 'root'; PRAGMA user_version=2; COMMIT;",
          );
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  read(projectId: string): StoredAndroidProject {
    this.requireOpen();
    if (!validId(projectId)) throw new Error("Android project identity is invalid");
    const config = this.db
      .prepare(
        "SELECT revision,candidate_id,module_path,variant,updated_at FROM android_configuration WHERE project_id=?",
      )
      .get(projectId);
    const trust = this.db
      .prepare(
        "SELECT revision,trusted,config_revision,registered_root,workspace_root,wrapper_relative_path,wrapper_fingerprint,updated_at FROM android_trust WHERE project_id=?",
      )
      .get(projectId);
    const configuration = config
      ? {
          revision: Number(config.revision),
          candidateId: String(config.candidate_id),
          modulePath: String(config.module_path),
          variant: String(config.variant),
          updatedAt: String(config.updated_at),
        }
      : undefined;
    const trustRecord = trust
      ? {
          revision: Number(trust.revision),
          trusted: Number(trust.trusted) === 1,
          configRevision: Number(trust.config_revision),
          registeredRoot: String(trust.registered_root),
          workspaceRoot: String(trust.workspace_root),
          wrapperRelativePath: String(trust.wrapper_relative_path),
          wrapperFingerprint: String(trust.wrapper_fingerprint),
          updatedAt: String(trust.updated_at),
        }
      : undefined;
    if (
      (configuration &&
        (!Number.isSafeInteger(configuration.revision) ||
          configuration.revision < 1 ||
          !OPAQUE_ID.test(configuration.candidateId) ||
          !validAndroidModulePath(configuration.modulePath) ||
          !validAndroidVariant(configuration.variant) ||
          !validTimestamp(configuration.updatedAt))) ||
      (trustRecord &&
        (!Number.isSafeInteger(trustRecord.revision) ||
          trustRecord.revision < 1 ||
          !Number.isSafeInteger(trustRecord.configRevision) ||
          trustRecord.configRevision < 1 ||
          !validId(trustRecord.registeredRoot) ||
          trustRecord.registeredRoot.length > MAX_PATH ||
          !validId(trustRecord.workspaceRoot) ||
          trustRecord.workspaceRoot.length > MAX_PATH ||
          !["gradlew", "gradlew.bat"].includes(trustRecord.wrapperRelativePath) ||
          !SHA256.test(trustRecord.wrapperFingerprint) ||
          !validTimestamp(trustRecord.updatedAt)))
    ) {
      throw new Error("Stored Android settings are invalid; no settings were reset");
    }
    return {
      configRevision: configuration?.revision ?? 0,
      ...(configuration ? { configuration } : {}),
      trustRevision: trustRecord?.revision ?? 0,
      ...(trustRecord ? { trust: trustRecord as StoredAndroidTrust } : {}),
    };
  }

  saveConfiguration(
    projectId: string,
    expectedRevision: number,
    modulePath: string,
    variant: string,
    candidateId = "root",
  ): StoredAndroidProject {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Android config revision is invalid");
    if (!OPAQUE_ID.test(candidateId) || !validAndroidModulePath(modulePath) || !validAndroidVariant(variant)) {
      throw new Error("Android run configuration is invalid");
    }
    return this.transaction(projectId, current => {
      if (current.configRevision !== expectedRevision)
        throw new AndroidSettingsConflict("Android configuration changed");
      const revision = expectedRevision + 1;
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO android_configuration(project_id,revision,candidate_id,module_path,variant,updated_at) VALUES(?,?,?,?,?,?)
           ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,candidate_id=excluded.candidate_id,module_path=excluded.module_path,variant=excluded.variant,updated_at=excluded.updated_at`,
        )
        .run(projectId, revision, candidateId, modulePath, variant, updatedAt);
    });
  }

  setTrust(
    projectId: string,
    expectedRevision: number,
    value: Omit<StoredAndroidTrust, "revision" | "updatedAt">,
  ): StoredAndroidProject {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Android trust revision is invalid");
    if (
      !Number.isSafeInteger(value.configRevision) ||
      value.configRevision < 1 ||
      !validId(value.registeredRoot) ||
      value.registeredRoot.length > MAX_PATH ||
      !validId(value.workspaceRoot) ||
      value.workspaceRoot.length > MAX_PATH ||
      !["gradlew", "gradlew.bat"].includes(value.wrapperRelativePath) ||
      !SHA256.test(value.wrapperFingerprint)
    ) {
      throw new Error("Android trust record is invalid");
    }
    return this.transaction(projectId, current => {
      if (current.trustRevision !== expectedRevision) throw new AndroidSettingsConflict("Android trust changed");
      const revision = expectedRevision + 1;
      this.db
        .prepare(
          `INSERT INTO android_trust(project_id,revision,trusted,config_revision,registered_root,workspace_root,wrapper_relative_path,wrapper_fingerprint,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,trusted=excluded.trusted,config_revision=excluded.config_revision,
             registered_root=excluded.registered_root,workspace_root=excluded.workspace_root,wrapper_relative_path=excluded.wrapper_relative_path,
             wrapper_fingerprint=excluded.wrapper_fingerprint,updated_at=excluded.updated_at`,
        )
        .run(
          projectId,
          revision,
          value.trusted ? 1 : 0,
          value.configRevision,
          value.registeredRoot,
          value.workspaceRoot,
          value.wrapperRelativePath,
          value.wrapperFingerprint,
          new Date().toISOString(),
        );
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private transaction(projectId: string, mutation: (current: StoredAndroidProject) => void): StoredAndroidProject {
    this.requireOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read(projectId);
      mutation(current);
      const saved = this.read(projectId);
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Android settings store is closed");
  }
}

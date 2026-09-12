import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidSettingsConflict, AndroidSettingsStore } from "../src/server/android/android-settings-store.ts";

const fingerprint = "a".repeat(64);

test("Android settings persist revisioned configuration and exact workspace trust", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pylon-android-settings-"));
  const path = join(directory, "android.sqlite");
  try {
    const store = new AndroidSettingsStore(path);
    assert.deepEqual(store.read("project-1"), { configRevision: 0, trustRevision: 0 });
    const configured = store.saveConfiguration("project-1", 0, ":app", "debug", "flutter-candidate");
    assert.equal(configured.configuration?.revision, 1);
    assert.throws(() => store.saveConfiguration("project-1", 0, ":other", "release"), AndroidSettingsConflict);
    const trusted = store.setTrust("project-1", 0, {
      trusted: true,
      configRevision: 1,
      registeredRoot: "C:\\repo",
      workspaceRoot: "C:\\repo-worktree",
      wrapperRelativePath: "gradlew.bat",
      wrapperFingerprint: fingerprint,
    });
    assert.equal(trusted.trust?.trusted, true);
    assert.equal(trusted.trustRevision, 1);
    store.close();

    const reopened = new AndroidSettingsStore(path);
    assert.equal(reopened.read("project-1").configuration?.modulePath, ":app");
    assert.equal(reopened.read("project-1").configuration?.candidateId, "flutter-candidate");
    assert.equal(reopened.read("project-1").trust?.wrapperFingerprint, fingerprint);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android settings migrate legacy root configurations without losing authorization revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pylon-android-settings-v1-"));
  const path = join(directory, "android.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE android_configuration (
        project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, module_path TEXT NOT NULL,
        variant TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE android_trust (
        project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, trusted INTEGER NOT NULL,
        config_revision INTEGER NOT NULL, registered_root TEXT NOT NULL, workspace_root TEXT NOT NULL,
        wrapper_relative_path TEXT NOT NULL, wrapper_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO android_configuration VALUES ('project-1', 2, ':app', 'debug', '2025-01-01T00:00:00.000Z');
      PRAGMA user_version=1;
    `);
    db.close();
    const store = new AndroidSettingsStore(path);
    assert.deepEqual(store.read("project-1").configuration, {
      candidateId: "root",
      modulePath: ":app",
      variant: "debug",
      revision: 2,
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    store.close();
    const check = new DatabaseSync(path);
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), 2);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android settings reject newer schemas without resetting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pylon-android-settings-newer-"));
  const path = join(directory, "android.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => new AndroidSettingsStore(path), /newer Pylon version/);
    const check = new DatabaseSync(path);
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), 99);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

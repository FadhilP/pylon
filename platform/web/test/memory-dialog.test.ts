import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("memory deletion uses the Pylon action dialog with scoped impact", async () => {
  const source = await readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ ActionDialog \} from "\.\/action-dialog"/);
  assert.match(source, /This rule will be removed from every project\./);
  assert.match(source, /This rule will be removed from this project\./);
  assert.match(source, /onConfirm=\{\(\) => void remove\(deleting\)\}/);
  assert.doesNotMatch(source, /window\.confirm/);
});

test("legacy migration is conditional, confirmed, and routes missing reviewers to Continuity settings", async () => {
  const [inspector, app, settings, styles] = await Promise.all([
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/settings-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(inspector, /continuity\?\.v4MigrationAvailable[\s\S]*?Previous memory found[\s\S]*?Select Memory Reviewer/);
  assert.match(inspector, /reviewerConfigured === false \? onOpenReviewerSettings\(\) : setConfirmingMigration\(true\)/);
  assert.match(inspector, /title="Migrate previous memory\?"[\s\S]*?onConfirm=\{\(\) => void migrate\(\)\}/);
  assert.match(app, /onOpenMemoryReviewerSettings[\s\S]*?setSettingsTab\("packages"\)[\s\S]*?setSettingsPackageQuery\("continuity"\)/);
  assert.match(settings, /initialPackageQuery = ""[\s\S]*?useState\(initialPackageQuery\)/);
  assert.match(styles, /\.memory-migration-banner/);
});

test("memory uses the grouped searchable ledger", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /className="memory-page memory-ledger"/);
  assert.match(source, /reviewerConfigured === false[\s\S]*?Memory Reviewer is not configured\.[\s\S]*?will not be stored/);
  assert.match(styles, /\.memory-reviewer-warning/);
  assert.match(source, /className="memory-ledger-search"[\s\S]*?rows\(visibleGlobalMemory\)[\s\S]*?rows\(visibleMemory\)/);
  assert.match(source, /Global<\/strong><span>Global · editable across projects<\/span>/);
  assert.match(source, /Project<\/strong><span>Project · editable<\/span>/);
  assert.match(source, /note\.trigger, note\.guidance, note\.authority, note\.origin/);
  assert.match(styles, /\.memory-ledger-row > summary/);
  assert.match(source, /stale\|changed\|revision/);
  assert.doesNotMatch(source, /className="memory-fact"/);
});

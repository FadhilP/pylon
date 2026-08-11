import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Database is a package-gated peer panel, not an Inspector tab", async () => {
  const [app, database, inspector] = await Promise.all([
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/database-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /type RightPanel = [^;]*"database"/);
  assert.match(app, /databaseAvailable=\{stateqlEnabled\}/);
  assert.match(app, /aria-controls="database-panel"/);
  assert.match(app, /rightPanel === "database" && <DatabasePanel/);
  assert.match(app, /DATABASE_PANEL_WIDTH_KEY = "pylon-database-panel-width"/);
  assert.match(app, /rightPanel === "database" \? databasePanelWidth : rightPanelWidth/);
  assert.match(database, /id="database-panel"/);
  assert.match(database, /<StateQLWorkspace live=\{live\} onClose=\{onClose\} \/>/);
  assert.match(inspector, /snapshotState\?\.scope === snapshotScope \? snapshotState\.value : undefined/);
  assert.match(inspector, /if \(live\.connection !== "connected" \|\| !live\.runtime\?\.ready\) \{\s*setLoading\(false\);\s*return;/);
  assert.match(inspector, /\[live\.connection, live\.runtime\?\.ready, live\.runtime\?\.sessionId, live\.runtime\?\.sessionGeneration, refresh, toolRevision\]/);
  assert.match(inspector, /aria-label="Filter database activity"/);
  assert.match(inspector, /aria-pressed=\{activityFilter === filter\}/);
  assert.match(inspector, /allVisibleExpanded \? "Collapse all" : "Expand all"/);
  assert.match(inspector, /<table className="stateql-ledger-table">/);
  assert.match(inspector, /<caption className="sr-only">Bounded StateQL session history and retained metadata<\/caption>/);
  assert.match(inspector, /<th scope="row"><span className="stateql-ledger-command">/);
  assert.match(inspector, /<tr className=\{`stateql-ledger-row[^>]+onClick=\{\(\) => onExpandedChange\(!expanded\)\}/);
  assert.match(inspector, /aria-controls=\{detailId\}/);
  assert.match(inspector, /event\.stopPropagation\(\); onExpandedChange\(!expanded\);/);
  assert.match(inspector, /<td colSpan=\{6\}><StateQLLedgerDetail/);
  assert.match(inspector, /<StateQLMaterializedRows active handle=\{item\.result\.handle\}/);
  assert.doesNotMatch(inspector, /<StateQLActivityCard/);
  assert.match(inspector, /key=\{`\$\{rowsScope\}:\$\{item\.result\.handle\}`\}/);
  assert.match(inspector, /if \(!active \|\| !open\) return;/);
  assert.match(inspector, /runtimeStore\.stateqlRows\(handle, offset, STATEQL_ROWS_PAGE_SIZE, controller\.signal\)/);
  assert.match(inspector, /<details className="stateql-rows"/);
  assert.match(inspector, /Rows can contain sensitive database content/);
  assert.match(inspector, /Previous<\/button>/);
  assert.match(inspector, /Next<\/button>/);
  assert.doesNotMatch(inspector, /title="Recent results"/);
  assert.doesNotMatch(inspector, /title="Command history"/);
  assert.doesNotMatch(inspector, /id: "stateql"/);
  assert.doesNotMatch(inspector, /current === "stateql"/);
});

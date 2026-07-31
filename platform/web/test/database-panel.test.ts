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
  assert.match(database, /id="database-panel"/);
  assert.match(database, /<StateQLWorkspace live=\{live\} \/>/);
  assert.match(inspector, /if \(live\.connection !== "connected" \|\| !live\.runtime\?\.ready\) return/);
  assert.match(inspector, /\[live\.connection, live\.runtime\?\.ready, live\.runtime\?\.sessionId, live\.runtime\?\.sessionGeneration, refresh, toolRevision\]/);
  assert.doesNotMatch(inspector, /id: "stateql"/);
  assert.doesNotMatch(inspector, /current === "stateql"/);
});

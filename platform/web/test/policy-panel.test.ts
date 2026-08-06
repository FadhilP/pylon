import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Inspector exposes inherited project and session Guard category controls", async () => {
  const [inspector, eventStore] = await Promise.all([
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(inspector, /GUARD_RISK_CATEGORIES\.map[\s\S]*?value=\{guardRules\[category\] \?\? "inherit"\}/);
  assert.match(inspector, /if \(value === "inherit"\) delete next\[category\]/);
  assert.match(inspector, /Effective this session · \$\{guardActionLabel\(effective\.value\)\} · \$\{effective\.source\}/);
  assert.match(inspector, /disabled=\{!idle \|\| !draftGuardEnabled\}/);
  assert.match(inspector, /aria-describedby=\{`\$\{descriptionId\} \$\{stateId\}`\}/);
  assert.match(eventStore, /await this\.waitForRuntimePolicyRevision\(runtime\.sessionId, expectedRevision\)/);
});

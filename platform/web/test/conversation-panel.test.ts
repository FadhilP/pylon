import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("earlier history preserves a stable transcript anchor", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /!element\.classList\.contains\("history-loader"\)[\s\S]*?element\.getBoundingClientRect\(\)\.bottom > viewportTop/);
  assert.match(source, /if \(preserveAnchor\) \{[\s\S]*?anchor\?\.isConnected[\s\S]*?return;\s*\}\s*stream\.scrollTop = 0/);
});

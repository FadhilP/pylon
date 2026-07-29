import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("expected session replacement stays loading instead of reporting disconnected", async () => {
  const source = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

  assert.match(source, /event\.type === "session\.replaced"[\s\S]*?this\.reset\("loading"\)/);
  assert.match(source, /const connection = this\.snapshot\.connection === "loading" \? "loading" : "disconnected"/);
  assert.match(source, /event\.type === "session\.unavailable"[\s\S]*?this\.reset\(\)/);
  assert.match(source, /source\.onerror = \(\) => \{[\s\S]*?connection: "disconnected"/);
});

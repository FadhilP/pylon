import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project memory deletion uses the Pylon action dialog", async () => {
  const source = await readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ ActionDialog \} from "\.\/action-dialog"/);
  assert.match(source, /title="Delete project memory\?"[\s\S]*?danger[\s\S]*?onConfirm=\{\(\) => void remove\(deleting\)\}/);
  assert.doesNotMatch(source, /window\.confirm\(`Delete project memory/);
});

test("memory uses the grouped searchable ledger", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /className="memory-page memory-ledger"/);
  assert.match(source, /className="memory-ledger-search"[\s\S]*?visibleGlobalMemory\.map[\s\S]*?visibleMemory\.map/);
  assert.match(source, /Global<\/strong><span>\{globalMemory\.length\} · read-only/);
  assert.match(source, /Project<\/strong><span>\{memory\.length\} · editable/);
  assert.match(styles, /\.memory-ledger-row > summary/);
  assert.doesNotMatch(source, /className="memory-fact"/);
});

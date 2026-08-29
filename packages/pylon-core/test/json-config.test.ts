import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonConfig, saveJsonConfig } from "../src/json-config.ts";

type Config = { version: 1; name?: string };
const fallback = (): Config => ({ version: 1 });
const parse = (value: any): Config | undefined =>
  value?.version === 1 &&
  (value.name === undefined || typeof value.name === "string")
    ? { version: 1, ...(value.name ? { name: value.name } : {}) }
    : undefined;

const scratch = () => mkdtemp(join(tmpdir(), "pylon-json-config-"));
const quarantined = async (dir: string) =>
  (await readdir(dir)).filter((name) => name.includes(".corrupt-"));

test("a missing config falls back without quarantining anything", async () => {
  const dir = await scratch();
  assert.deepEqual(
    await loadJsonConfig(join(dir, "config.json"), parse, fallback),
    { version: 1 },
  );
  assert.deepEqual(await quarantined(dir), []);
});

test("a valid config round-trips through save and load", async () => {
  const dir = await scratch();
  const path = join(dir, "nested", "config.json");
  await saveJsonConfig({ version: 1, name: "kept" }, path);
  assert.deepEqual(await loadJsonConfig(path, parse, fallback), {
    version: 1,
    name: "kept",
  });
  assert.deepEqual(
    await quarantined(join(dir, "nested")),
    [],
    "a successful save leaves no temporary file",
  );
});

test("unparseable and structurally invalid configs are quarantined, not deleted", async () => {
  for (const contents of ["{not json", JSON.stringify({ version: 9 })]) {
    const dir = await scratch();
    const path = join(dir, "config.json");
    await writeFile(path, contents);
    assert.deepEqual(await loadJsonConfig(path, parse, fallback), {
      version: 1,
    });
    const aside = await quarantined(dir);
    assert.equal(aside.length, 1, contents);
    assert.equal(
      await readFile(join(dir, aside[0]), "utf8"),
      contents,
      "the original bytes are recoverable",
    );
  }
});

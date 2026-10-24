import { readdir } from "node:fs/promises";
import test, { describe } from "node:test";

const directory = new URL("./", import.meta.url);
// Markdown's cold-start assertions need a fresh process; package.json runs it separately.
const files = (await readdir(directory))
  .filter(file => file.endsWith(".test.ts") && file !== "markdown.test.ts")
  .sort();

test("web test files", async () => {
  // Await each suite so file-level hooks restore state before the next import.
  for (const file of files) {
    await describe(file, { concurrency: false }, async () => {
      await import(new URL(file, directory));
    });
  }
});

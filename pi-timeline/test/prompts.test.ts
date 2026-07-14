import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGeneratedTitle,
  promptText,
  promptTitle,
} from "../src/prompts.ts";

test("prompt preview", () =>
  assert.equal(
    promptText({ content: [{ type: "text", text: "hello" }, { type: "image" }] }),
    "hello [image]",
  ));

test("prompt title is concise and single-line", () =>
  assert.equal(
    promptTitle({ content: "  Update\n\n session   naming with a title that stays readable in the session picker and footer" }),
    "Update session naming with a title that stays readable in t…",
  ));

test("generated title validation enforces one concise line", () => {
  assert.equal(
    normalizeGeneratedTitle('  "Persistent Timeline Session Names"  '),
    "Persistent Timeline Session Names",
  );
  assert.equal(normalizeGeneratedTitle("Too short"), undefined);
  assert.equal(
    normalizeGeneratedTitle("One two three four five six seven eight nine"),
    undefined,
  );
  assert.equal(normalizeGeneratedTitle("First valid title\nExtra prose"), undefined);
  assert.equal(normalizeGeneratedTitle("x".repeat(61)), undefined);
});
